use serde::Serialize;
use std::path::Path;

/// Parsed buzzdetect activations for one track.
///
/// `values` is indexed `[neuron][frame]` so the frontend can plot one polyline
/// per neuron without transposing. `neurons` holds display labels (the optional
/// `activation_` column prefix is stripped here so old and new CSVs render the
/// same). Times come from the CSV `start` column.
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
    pub values: Vec<Vec<f32>>,
}

/// Strip one surrounding pair of double quotes from a CSV header cell, then trim.
fn unquote(cell: &str) -> String {
    let t = cell.trim();
    let t = t.strip_prefix('"').unwrap_or(t);
    let t = t.strip_suffix('"').unwrap_or(t);
    t.trim().to_string()
}

/// Read `{buzzdetect_dir}/{ident}_buzzdetect.csv` (or, when a run is still in
/// progress, `{ident}_buzzpart.csv`) and parse it into [`BuzzdetectData`].
/// Returns `Ok(None)` when neither file exists for this ident so the UI can
/// simply show no panel rather than treating it as an error.
///
/// CSV contract (see local/buzzdetect.md): first column `start` is the time
/// axis in seconds; every other column is a neuron, optionally prefixed with
/// `activation_`. Values are raw logits. The frame HOP is inferred from the
/// spacing of the first few `start` values and the parse fails if that spacing
/// is inconsistent — we never silently assume a fixed spacing. `frame_length`,
/// when set (the project's buzzdetect override setting), is the frame's extent;
/// it does not change the hop, and only stands in for it when the CSV is too
/// short or too noisy to infer one.
#[tauri::command]
pub async fn read_buzzdetect(
    buzzdetect_dir: String,
    ident: String,
    frame_length: Option<f32>,
) -> Result<Option<BuzzdetectData>, String> {
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
    // First column is the `start` time axis; the rest are neurons. Strip the
    // optional `activation_` prefix so both current and older CSVs label alike.
    let neurons: Vec<String> = header_cells[1..]
        .iter()
        .map(|c| c.strip_prefix("activation_").unwrap_or(c).to_string())
        .collect();
    let n_neurons = neurons.len();

    let mut starts: Vec<f32> = Vec::new();
    let mut values: Vec<Vec<f32>> = vec![Vec::new(); n_neurons];

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
            let v: f32 = cell.trim().parse().map_err(|_| {
                format!("'{}' row {}: bad value '{}'", csv_path.display(), row_idx + 2, cell)
            })?;
            values[n].push(v);
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
        neurons,
        starts,
        values,
    }))
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
