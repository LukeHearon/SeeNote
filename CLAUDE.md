# SeeNote — Agent Orientation

SeeNote is a **Tauri v2 + React/TypeScript desktop app** for annotating audio/video files to build machine learning training datasets (originally for insect bioacoustics). Users open a project (audio directory + annotation output directory), navigate files via a sidebar, view spectrograms, and drag to create labeled time-range annotations. Annotations are exported as Audacity-compatible `.txt`, `.csv`, or `.json` files mirroring the audio directory structure.

## Dev commands
```
npm run tauri:dev   # run desktop app in dev mode
npm run tauri:build # build release binary
npm run dev         # run as plain web app (no Tauri backend)
```

## Key files at a glance

| What you want to touch | Where |
|---|---|
| Main app state, hotkeys, play logic, label palette | `App.tsx` |
| Spectrogram rendering, annotation drag/resize, selection | `components/Spectrogram.tsx` |
| File tree sidebar + context menu | `components/FileTree.tsx` |
| Launch screen, project picker | `components/LaunchScreen.tsx` |
| Project creation modal | `components/CreateProjectModal.tsx` |
| Project settings modal | `components/ProjectSettingsModal.tsx` |
| Video/audio `<video>` element | `components/VideoPlayer.tsx` |
| All shared TypeScript types | `types.ts` |
| Color map, zoom limits, tier configs, default labels | `constants.ts` |
| Export helpers (CSV/Audacity/JSON), `calculateLabelLayers` | `utils/helpers.ts` |
| Tauri `invoke()` wrappers (all IPC calls live here) | `utils/tauriCommands.ts` |
| Project file I/O, `revealInFinder`, `countAnnotationEntries` | `utils/projectCommands.ts` |
| Spectrogram image math (`drawSpectrogramChunk`) | `utils/audioProcessing.ts` |
| Project list persistence hook | `hooks/useProjects.ts` |
| Multi-tier LRU spectrogram chunk cache | `MultiTierSpectrogramCache.ts` |
| Rust: all `#[tauri::command]` registrations | `src-tauri/src/lib.rs` |
| Rust: audio info + FFT spectrogram commands | `src-tauri/src/commands/audio.rs` |
| Rust: filesystem commands (list, read, write, dialogs) | `src-tauri/src/commands/filesystem.rs` |
| Rust: project persistence, orphan cleanup | `src-tauri/src/commands/projects.rs` |
| Rust: audio decoding (symphonia) | `src-tauri/src/audio/decoder.rs` |
| Rust: FFT (rustfft) | `src-tauri/src/audio/fft.rs` |

## Architecture in brief

**State lives in `App.tsx`** and flows down as props. There is no global store.

**Spectrogram pipeline:**
1. Rust decodes audio and runs FFT → returns raw magnitude bytes via `get_spectrogram_chunk`
2. `MultiTierSpectrogramCache` (4 tiers by zoom level, LRU per tier) caches chunks and prefetches ahead
3. `drawSpectrogramChunk` in `utils/audioProcessing.ts` maps magnitudes → Magma colormap → ImageData
4. `Spectrogram.tsx` has two stacked canvases: bottom = spectrogram pixels, top (z-30 overlay) = axis, playhead, selection darkening

**Annotation model (`types.ts`):**
- `Label` — `{ id, configId, start, end, text, color, layerIndex }`
- `LabelConfig` — `{ key, text, color }` — named categories with hotkeys 0-9
- `activeLabelKey: string | null` in `App.tsx` — `null` = Selection Mode, string = active config key

**Key "0" is reserved** for "Custom Label" — new annotations get an empty `text` field so the user can type a one-off name. The auto-focus on the annotation text input is triggered by `text === ""`. Do not repurpose key "0".

**Selection Mode** (`activeLabelKey === null`): dragging creates a selection region (not an annotation); playback is bounded to the region. Click bare canvas to seek and clear selection.

**Annotation-bound selection**: clicking the center of an existing annotation enters bound selection mode — resize handles update both the annotation and the selection region.

**Canvas z-order in `Spectrogram.tsx`:**
1. Spectrogram canvas (bottom)
2. Label HTML `<div>`s (z-10/20) + selection handles (z-15)
3. Overlay canvas: axis, playhead, ident, selection darkening (z-30)
4. Nav buttons + settings button (z-50)

**Tauri IPC**: every Rust command is wrapped in `utils/tauriCommands.ts` or `utils/projectCommands.ts`. Never call `invoke()` directly from components — add a wrapper there instead.

**Adding a new Rust command**: implement in the appropriate `src-tauri/src/commands/*.rs` file, register in `src-tauri/src/lib.rs` `invoke_handler!`, then add a TypeScript wrapper in the relevant `utils/` file.

## IMPORTANT: Always commit your changes

**After completing any task that modifies files, you MUST create a git commit.** Do not finish a task without committing. This includes bug fixes, features, refactors, and any other code changes — no exceptions. Write a clear, concise commit message describing what changed and why.

## IMPORTANT: Maintain local/TODO.md

`local/TODO.md` tracks outstanding work items. **After implementing any item from that file, remove it from the file.** Do not leave completed items in the list. If you implement everything in the file, leave only the NOTE header.
