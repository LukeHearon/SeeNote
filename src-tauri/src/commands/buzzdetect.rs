use serde::Serialize;
use std::path::Path;

/// Parsed buzzdetect activations for one track.
///
/// `values` is indexed `[neuron][frame]` so the frontend can plot one polyline
/// per neuron without transposing. `neurons` holds display labels (the optional
/// `activation_` column prefix is stripped here so old and new CSVs render the
/// same). Times come from the CSV `start` column; `bin_width` is inferred from
/// the spacing between the first few starts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuzzdetectData {
    pub bin_width: f32,
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

/// Read `{buzzdetect_dir}/{ident}_buzzdetect.csv` and parse it into
/// [`BuzzdetectData`]. Returns `Ok(None)` when no file exists for this ident so
/// the UI can simply show no panel rather than treating it as an error.
///
/// CSV contract (see local/buzzdetect.md): first column `start` is the time
/// axis in seconds; every other column is a neuron, optionally prefixed with
/// `activation_`. Values are raw logits. The bin width is inferred from the
/// spacing of the first few `start` values and the parse fails if that spacing
/// is inconsistent — we never assume a fixed bin width.
#[tauri::command]
pub async fn read_buzzdetect(
    buzzdetect_dir: String,
    ident: String,
) -> Result<Option<BuzzdetectData>, String> {
    let dir = buzzdetect_dir.trim_end_matches(['/', '\\']);
    let csv_path = Path::new(dir).join(format!("{}_buzzdetect.csv", ident));
    if !csv_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&csv_path)
        .map_err(|e| format!("failed to read '{}': {}", csv_path.display(), e))?;

    // Non-empty lines only; tolerate both \n and \r\n.
    let mut lines = content.lines().filter(|l| !l.trim().is_empty());

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

    let bin_width = infer_bin_width(&starts)
        .map_err(|e| format!("'{}': {}", csv_path.display(), e))?;

    Ok(Some(BuzzdetectData {
        bin_width,
        neurons,
        starts,
        values,
    }))
}

/// Infer the bin width from the spacing between the first few `start` values,
/// erroring if that spacing is inconsistent. Uses a small relative tolerance so
/// floating-point round-off in the CSV (e.g. 0, 0.96, 1.92 …) is accepted.
fn infer_bin_width(starts: &[f32]) -> Result<f32, String> {
    if starts.len() < 2 {
        return Err("cannot infer bin width from fewer than 2 rows".to_string());
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
                "inconsistent bin spacing: expected {:.6}s but found {:.6}s between rows {} and {}",
                width, delta, i, i + 1
            ));
        }
    }
    Ok(width)
}
