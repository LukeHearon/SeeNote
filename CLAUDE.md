# SeeNote — Agent Orientation

SeeNote is a **Tauri v2 + React/TypeScript desktop app** for annotating audio/video files to build machine learning training datasets. Users open a project (audio directory + annotation output directory), navigate files via a sidebar, view spectrograms, and drag to create labeled time-range annotations. Annotations are automatically saved as Audacity-compatible `.txt`, `.csv`, or `.json` files mirroring the audio directory structure.

## CRITICAL: Sample-level synchrony is the cornerstone invariant

**Every visual element that lives on the time axis must be in exact 1:1 correspondence with the underlying audio samples, and with each other.** This is essential to SeeNote's functionality. Users are determining ML label boundaries by eye and ear against the spectrogram; any drift between what they see and what they hear corrupts the ground truth.

The time-axis elements that MUST stay in lockstep:
- **Spectrogram pixels** — each column represents a precise sample window; chunk boundaries must be seamless (see `decoder.rs` sample-accuracy contract) 
- **Playhead** — the position must correspond to the sample currently being emitted by the audio hardware, never ahead, never behind
- **Audio playback** — when a selected region is played, playback must be sample-identical with no codec-frame snap, 
- **Label / annotation boundaries** — rendered rectangles map to exact PCM samples and round-trip through export unchanged
- **Selection region** — the shaded band represents the exact half-open sample interval that will play

**Rules that follow from this invariant:**
1. **The playhead is slave to the audio clock.** If audio is buffering or stalled, the playhead waits. Never advance the playhead from a wall clock, a timer, or a stale media-element event when the audio hasn't actually produced that sample yet.
2. **Compressed-format quirks (MP3/AAC/m4a/ogg/opus) must be absorbed by the Rust decoder and never surface to the frontend.** The `PcmStream::open` 500ms seek margin + first-packet timestamp tracking in `src-tauri/src/audio/decoder.rs` is the canonical pattern. Both `PcmStream` and `decode_audio_range` share this logic; any new decode path must reuse `PcmStream`.
3. **If a change touches playback, decode, selection math, spectrogram chunking, or annotation export, think explicitly about whether it can drift relative to any of the other four.** If yes, it's broken, regardless of whether tests pass.

## Key files at a glance

| What you want to touch | Where |
|---|---|
| Main app state, hotkeys, play logic, label palette | `App.tsx` |
| Sample-accurate audio/video playback engine | `utils/AudioEngine.ts` |
| Spectrogram rendering, annotation drag/resize, selection | `components/Spectrogram.tsx` |
| File tree sidebar + context menu | `components/FileTree.tsx` |
| Launch screen, project picker | `components/LaunchScreen.tsx` |
| Project creation modal | `components/CreateProjectModal.tsx` |
| Project settings modal | `components/ProjectSettingsModal.tsx` |
| `<video>` element (video frames only — audio via engine) | `components/VideoPlayer.tsx` |
| All shared TypeScript types | `types.ts` |
| Color map, zoom limits, tier configs, default labels | `constants.ts` |
| Export helpers (CSV/Audacity/JSON), `calculateLabelLayers` | `utils/helpers.ts` |
| Tauri `invoke()` wrappers (all IPC calls live here) | `utils/tauriCommands.ts` |
| Project file I/O, `revealInFinder`, `countAnnotationEntries` | `utils/projectCommands.ts` |
| Spectrogram image math (`drawSpectrogramChunk`) | `utils/audioProcessing.ts` |
| Project list persistence hook | `hooks/useProjects.ts` |
| Multi-tier LRU spectrogram chunk cache | `MultiTierSpectrogramCache.ts` |
| Rust: all `#[tauri::command]` registrations | `src-tauri/src/lib.rs` |
| Rust: audio info, FFT spectrogram, PCM stream commands | `src-tauri/src/commands/audio.rs` |
| Rust: filesystem commands (list, read, write, dialogs) | `src-tauri/src/commands/filesystem.rs` |
| Rust: project persistence, orphan cleanup | `src-tauri/src/commands/projects.rs` |
| Rust: `PcmStream` + `decode_audio_range` (symphonia) | `src-tauri/src/audio/decoder.rs` |
| Rust: FFT (rustfft) | `src-tauri/src/audio/fft.rs` |

## Architecture in brief

**State lives in `App.tsx`** and flows down as props. There is no global store.

**Playback pipeline (`utils/AudioEngine.ts`):**
1. `AudioEngine.play(startSec, endSec?)` opens a Rust `PcmStream` via `start_pcm_stream`
2. An async prefetch loop fetches 1s PCM chunks via `read_pcm_chunk` and schedules them as `AudioBufferSourceNode`s
3. Web Audio's scheduler fires `source.start(when)` / `source.stop(when)` at sample-accurate context times
4. `source.stop(ctxTime)` at exactly `endSec` provides sample-accurate selection stop
5. `onTimeUpdate` fires on each rAF tick: `mediaTime = playStartMedia + (ctxNow - playStartCtx)`
6. For video files, the `<video>` element shows frames only (muted); the engine syncs `video.currentTime` to the audio clock every 50ms

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

**Tauri IPC**: every Rust command is wrapped in `utils/tauriCommands.ts` or `utils/projectCommands.ts`. Never call `invoke()` directly from components — add a wrapper there instead.

**Adding a new Rust command**: implement in the appropriate `src-tauri/src/commands/*.rs` file, register in `src-tauri/src/lib.rs` `invoke_handler!`, then add a TypeScript wrapper in the relevant `utils/` file.

## IMPORTANT: Always commit your changes

**After completing any task that modifies files, you MUST create a git commit.** Do not finish a task without committing. This includes bug fixes, features, refactors, and any other code changes — no exceptions. Write a clear, concise commit message describing what changed and why. **If the change requires user verification (e.g. visual/behavioral changes, bug fixes that need manual testing), prompt the user to verify first and wait for their confirmation before committing.**

The `local/` directory is gitignored — do not attempt to stage or commit files from that directory. 

## Maintain local/TODO.md

`local/TODO.md` tracks outstanding work items. **After implementing any item from that file, remove it from the file.** Do not leave completed items in the list. If you implement everything in the file, leave only the NOTE header.
