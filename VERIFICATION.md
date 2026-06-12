# Verification — three new features

Quick manual checks for the features merged onto `main`. Run `npm run tauri dev`, open a project with at least one annotated track.

## 1. Import annotations
- Right-click a track in the file panel → **Import annotations…**.
- Pick an Audacity `.txt` label file. Annotations are filed under the right-clicked track's ident (matching tool key/color by label text).
- If that track already has annotations, a modal offers **Cancel / Overwrite / Merge**:
  - **Overwrite** replaces the existing set.
  - **Merge** appends the imported annotations and re-sorts by start time (imported ones get fresh ids — no collisions).
- Import a track that is *not* the currently-open one → it's written to disk and shows as annotated; open it to confirm.
- Empty / unparseable file → no-op, no crash.

## 2. Pop labels
- Open a track, make an annotation spanning e.g. ~10s–30s.
- Drag a selection that overlaps it starting at ~15s → the annotation's name label jumps to the selection start (15s).
- Start the selection close to the annotation's right edge so the text doesn't fit → label **right-justifies** against the right edge instead.
- Scroll the annotation's start off the left of the viewport → label stays pinned a small inset from the left edge (existing behavior, still works).
- Rule: label left = rightmost of {inset past annotation start, viewport-left pin, selection start}, with right-justify fallback when text won't fit before the annotation's right edge.

## 3. Recenter playhead
- Move the playhead, then pan so it's off-screen.
- Press **C** (or click the recenter button — LocateFixed icon, end of the transport group) → the view scrolls so the playhead is centered. Zoom is unchanged.
- Near the file start/end the view clamps (doesn't scroll before t=0 or past the existing end overrun).
- Button is disabled when no track is loaded.
- (Minimap track was deferred — not implemented.)

## Automated
- `npm test` → 194 pass
- `npx tsc --noEmit` → clean
- `cargo test --manifest-path src-tauri/Cargo.toml` → 23 pass (1 pre-existing ignored)
