use serde::Serialize;
use std::path::Path;

/// Parsed buzzdetect activations for one track.
///
/// `values` is indexed `[neuron][frame]` so the frontend can plot one polyline
/// per neuron without transposing. `neurons` holds display labels (the optional
/// `activation_` column prefix is stripped here so old and new CSVs render the
/// same, unless the project turns that off — see `trim_activation_prefix`).
/// Times come from the CSV `start` column.
///
/// A cell can be missing (empty, "NA", "N/A", "NaN", "null", "none" — see
/// [`is_missing_token`]) without failing the read: it comes back as `None` so
/// the frontend can skip it rather than plot a bogus value. `None` rather than
/// `f32::NAN` because JSON has no NaN literal — this serializes to `null`.
/// A column that contains real non-numeric content (not just missing tokens)
/// is dropped from `neurons`/`values` entirely rather than failing the read,
/// so one ill-formed extra column doesn't take the whole file down.
///
/// Two separate numbers describe the frame grid, because the model's two
/// parameters are separate and a CSV only reveals one of them:
///
///   `frame_hop`     the spacing between consecutive `starts`, inferred from
///                    the data. This is the grid the rows sit on.
///   `frame_length`  how much audio one row DESCRIBES. Not derivable from the
///                    CSV at all — it equals the hop only when the model ran
///                    without overlap — so it comes from the project's
///                    `frame_length` setting, defaulting to the hop.
///
/// A model run with `framelength 3, framehop 0.96` produces rows 0.96s apart
/// that each speak for 3s of audio, overlapping their neighbours by 2/3. Only
/// keeping the two apart lets the UI say where a detection's audio actually is.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuzzdetectData {
    pub frame_length: f32,
    pub frame_hop: f32,
    pub neurons: Vec<String>,
    pub starts: Vec<f32>,
    pub values: Vec<Vec<Option<f32>>>,
}

/// Strip one surrounding pair of double quotes from a CSV header cell, then trim.
fn unquote(cell: &str) -> String {
    let t = cell.trim();
    let t = t.strip_prefix('"').unwrap_or(t);
    let t = t.strip_suffix('"').unwrap_or(t);
    t.trim().to_string()
}

/// Common tokens meaning "no value" in a CSV cell, checked case-insensitively
/// after trimming. Covers plain-empty, R's `NA`, and the handful of spellings
/// pandas/numpy and hand-written CSVs use for a missing float.
fn is_missing_token(cell: &str) -> bool {
    matches!(
        cell.trim().to_ascii_lowercase().as_str(),
        "" | "na" | "n/a" | "nan" | "null" | "none"
    )
}

/// Read `{buzzdetect_dir}/{ident}_buzzdetect.csv` (or, when a run is still in
/// progress, `{ident}_buzzpart.csv`) and parse it into [`BuzzdetectData`].
/// Returns `Ok(None)` when neither file exists for this ident so the UI can
/// simply show no panel rather than treating it as an error.
///
/// CSV contract (see local/buzzdetect.md): first column `start` is the time
/// axis in seconds; every other column with numeric content is a neuron,
/// optionally prefixed with `activation_` — arbitrary per-frame values (SPL,
/// loss, ...) work the same as a model's activations, prefixed or not. Values
/// are raw logits or whatever the column represents. The frame HOP is inferred
/// from the spacing of the first few `start` values and the parse fails if
/// that spacing is inconsistent — we never silently assume a fixed spacing.
/// `frame_length`, when set (the project's buzzdetect override setting), is
/// the frame's extent; it does not change the hop, and only stands in for it
/// when the CSV is too short or too noisy to infer one.
///
/// `trim_activation_prefix` (defaults to `true`) controls whether a leading
/// `activation_` is stripped from a neuron's display name; the project-level
/// setting exists for the arbitrary-column case, where a literal `activation_`
/// prefix might be a real part of the name a user wants to keep.
#[tauri::command]
pub async fn read_buzzdetect(
    buzzdetect_dir: String,
    ident: String,
    frame_length: Option<f32>,
    trim_activation_prefix: Option<bool>,
) -> Result<Option<BuzzdetectData>, String> {
    let trim_activation_prefix = trim_activation_prefix.unwrap_or(true);
    let dir = buzzdetect_dir.trim_end_matches(['/', '\\']);
    let finished_path = Path::new(dir).join(format!("{}_buzzdetect.csv", ident));
    let partial_path = Path::new(dir).join(format!("{}_buzzpart.csv", ident));
    let (csv_path, is_partial) = if finished_path.exists() {
        (finished_path, false)
    } else if partial_path.exists() {
        (partial_path, true)
    } else {
        return Ok(None);
    };

    let content = std::fs::read_to_string(&csv_path)
        .map_err(|e| format!("failed to read '{}': {}", csv_path.display(), e))?;

    // Non-empty lines only; tolerate both \n and \r\n.
    let mut lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
    // A `_buzzpart.csv` is actively being appended to, so its final line may
    // have been read mid-write and be truncated; drop it rather than failing
    // the whole read.
    if is_partial && lines.len() > 1 {
        let cols = lines[0].split(',').count();
        if lines[lines.len() - 1].split(',').count() != cols {
            lines.pop();
        }
    }
    let mut lines = lines.into_iter();

    let header = lines
        .next()
        .ok_or_else(|| format!("'{}' is empty", csv_path.display()))?;
    let header_cells: Vec<String> = header.split(',').map(unquote).collect();
    if header_cells.len() < 2 {
        return Err(format!(
            "'{}' has no neuron columns (header: {})",
            csv_path.display(),
            header
        ));
    }
    // First column is the `start` time axis; the rest are candidate neurons.
    // Strip the optional `activation_` prefix so both current and older CSVs
    // label alike, unless the project has turned that off.
    let neurons: Vec<String> = header_cells[1..]
        .iter()
        .map(|c| {
            if trim_activation_prefix {
                c.strip_prefix("activation_").unwrap_or(c).to_string()
            } else {
                c.to_string()
            }
        })
        .collect();
    let n_neurons = neurons.len();

    let mut starts: Vec<f32> = Vec::new();
    let mut values: Vec<Vec<Option<f32>>> = vec![Vec::new(); n_neurons];
    // A column stays numeric until a cell in it fails to parse as a float AND
    // isn't a recognized missing-value token — one genuinely non-numeric
    // column (e.g. a text label column someone appended) shouldn't take the
    // whole file down, so it's dropped from the output instead of erroring.
    let mut column_numeric: Vec<bool> = vec![true; n_neurons];

    for (row_idx, line) in lines.enumerate() {
        let cells: Vec<&str> = line.split(',').collect();
        if cells.len() != header_cells.len() {
            return Err(format!(
                "'{}' row {} has {} columns, expected {}",
                csv_path.display(),
                row_idx + 2, // +1 for header, +1 for 1-based
                cells.len(),
                header_cells.len()
            ));
        }
        let start: f32 = cells[0]
            .trim()
            .parse()
            .map_err(|_| format!("'{}' row {}: bad start '{}'", csv_path.display(), row_idx + 2, cells[0]))?;
        starts.push(start);
        for (n, cell) in cells[1..].iter().enumerate() {
            let trimmed = cell.trim();
            if is_missing_token(trimmed) {
                values[n].push(None);
            } else {
                match trimmed.parse::<f32>() {
                    Ok(v) => values[n].push(Some(v)),
                    Err(_) => {
                        values[n].push(None);
                        column_numeric[n] = false;
                    }
                }
            }
        }
    }

    // Drop any column that turned out not to be numeric, rather than
    // returning it full of holes.
    let mut kept_neurons: Vec<String> = Vec::new();
    let mut kept_values: Vec<Vec<Option<f32>>> = Vec::new();
    for (n, is_numeric) in column_numeric.into_iter().enumerate() {
        if is_numeric {
            kept_neurons.push(neurons[n].clone());
            kept_values.push(std::mem::take(&mut values[n]));
        }
    }

    // The hop is always what the rows say it is. A configured frame length is
    // the user asserting how much audio a row covers, which the CSV cannot
    // show — so it never overrides the hop, and only stands in for it when
    // inference is impossible (too few rows, or noisy spacing).
    let hop = match (infer_frame_hop(&starts), frame_length) {
        (Ok(h), _) => h,
        (Err(_), Some(w)) => w,
        (Err(e), None) => return Err(format!("'{}': {}", csv_path.display(), e)),
    };

    Ok(Some(BuzzdetectData {
        frame_length: frame_length.unwrap_or(hop),
        frame_hop: hop,
        neurons: kept_neurons,
        starts,
        values: kept_values,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Writes `contents` as `{ident}_buzzdetect.csv` under a fresh temp dir and
    /// returns the dir, so `read_buzzdetect` can be pointed at it. The dir is
    /// unique per call (PID + a counter) so parallel tests don't collide.
    fn write_csv(ident: &str, contents: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "seenote_buzzdetect_test_{}_{}",
            std::process::id(),
            n
        ));
        let file_dir = dir.join(Path::new(ident).parent().unwrap_or(Path::new("")));
        fs::create_dir_all(&file_dir).unwrap();
        fs::write(dir.join(format!("{}_buzzdetect.csv", ident)), contents).unwrap();
        dir
    }

    #[tokio::test]
    async fn missing_cells_become_none_and_dont_fail_the_read() {
        let dir = write_csv(
            "t",
            "start,activation_a,activation_b\n0,1.0,2.0\n0.96,,4.0\n1.92,NA,6.0\n",
        );
        let data = read_buzzdetect(dir.to_string_lossy().to_string(), "t".to_string(), None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(data.neurons, vec!["a", "b"]);
        assert_eq!(data.values[0], vec![Some(1.0), None, None]);
        assert_eq!(data.values[1], vec![Some(2.0), Some(4.0), Some(6.0)]);
    }

    #[tokio::test]
    async fn a_non_numeric_column_is_dropped_not_fatal() {
        let dir = write_csv(
            "t",
            "start,activation_a,label\n0,1.0,quiet\n0.96,2.0,loud\n",
        );
        let data = read_buzzdetect(dir.to_string_lossy().to_string(), "t".to_string(), None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(data.neurons, vec!["a"]);
        assert_eq!(data.values.len(), 1);
    }

    #[tokio::test]
    async fn arbitrary_column_names_are_read_like_activation_columns() {
        let dir = write_csv("t", "start,spl,loss\n0,55.2,0.3\n0.96,56.1,0.25\n");
        let data = read_buzzdetect(dir.to_string_lossy().to_string(), "t".to_string(), None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(data.neurons, vec!["spl", "loss"]);
    }

    #[tokio::test]
    async fn trim_activation_prefix_can_be_turned_off() {
        let dir = write_csv("t", "start,activation_a\n0,1.0\n0.96,2.0\n");
        let trimmed = read_buzzdetect(dir.to_string_lossy().to_string(), "t".to_string(), None, Some(true))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(trimmed.neurons, vec!["a"]);
        let untrimmed = read_buzzdetect(dir.to_string_lossy().to_string(), "t".to_string(), None, Some(false))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(untrimmed.neurons, vec!["activation_a"]);
    }

    #[test]
    fn is_missing_token_covers_common_spellings() {
        for tok in ["", "NA", "na", "N/A", "NaN", "nan", "NULL", "None", "  na  "] {
            assert!(is_missing_token(tok), "expected {:?} to be missing", tok);
        }
        for tok in ["0", "1.5", "-2.3e1", "not-a-number-either"] {
            assert!(!is_missing_token(tok), "expected {:?} to not be missing", tok);
        }
    }
}

/// Infer the frame hop from the spacing between the first few `start` values,
/// erroring if that spacing is inconsistent. Uses a small relative tolerance so
/// floating-point round-off in the CSV (e.g. 0, 0.96, 1.92 …) is accepted.
fn infer_frame_hop(starts: &[f32]) -> Result<f32, String> {
    if starts.len() < 2 {
        return Err("cannot infer frame hop from fewer than 2 rows".to_string());
    }
    let width = starts[1] - starts[0];
    if width <= 0.0 {
        return Err(format!("non-increasing start times (width {})", width));
    }
    // Check up to the first 5 deltas for consistency.
    let checks = starts.len().min(6);
    let tol = width.abs() * 1e-3;
    for i in 1..checks {
        let delta = starts[i] - starts[i - 1];
        if (delta - width).abs() > tol {
            return Err(format!(
                "inconsistent frame spacing: expected {:.6}s but found {:.6}s between rows {} and {}",
                width, delta, i, i + 1
            ));
        }
    }
    Ok(width)
}
