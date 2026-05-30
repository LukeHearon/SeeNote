# Codebase map

Quick reference for agents. One phrase per file.

## Entrypoints
- `AnnotationWindow.tsx` — main app orchestrator; owns all major state (project, tracks, annotations, playback)
- `App.tsx` — top-level router: launch screen → project selection → AnnotationWindow
- `index.tsx` / `main.tsx` — Vite/React mount point

## Toolbar & panels
- `components/Toolbar.tsx` — top toolbar: playback controls, export, zoom, tool selection
- `components/FileTree.tsx` — left-side file browser with context menus and shuffle/filter
- `components/HelpPanel.tsx` — keyboard shortcut reference panel (keep in sync with behavior changes)
- `components/AnnotationToolsPanel.tsx` — annotation tool palette (add/edit/reorder tools)
- `components/ToolCell.tsx` — compact tool button used inside the annotation tools panel
- `components/RepairProjectModal.tsx` — modal to re-point a project at a moved media directory
- `components/DebugConsole.tsx` — collapsible overlay listing debug logs (video/decode diagnostics) with copy-all
- `components/BuzzdetectPanel.tsx` — line graph of buzzdetect activations docked below the spectrogram; shares its time→pixel transform
- `components/DirectoryField.tsx` — shared directory picker (label/input/browse/resolve/portability/existence) used by both project modals
- `components/CollapsibleSection.tsx` — small disclosure section (chevron + title) for optional form fields

## Video
- `components/VideoPane.tsx` — video container; positions VideoPlayer and VideoZoomLayer
- `components/VideoZoomLayer.tsx` — marquee-zoom overlay and pan viewfinder UI
- `components/VideoPlayer.tsx` — presentational `<video>` element (Fast / Mixed-without-selection); transport driven externally by VideoElementEngine
- `components/CanvasVideoPlayer.tsx` — frame-accurate canvas renderer driven by VideoFrameSource (Accurate / Mixed-with-selection); draws the cached frame ≤ current media time
- `utils/VideoElementEngine.ts` — playback transport backed by a `<video>` element playing its own audio (Fast mode); mirrors the AudioEngine interface
- `utils/VideoFrameSource.ts` — decodes individual video frames via canvas for spectrogram alignment
- `utils/videoZoom.ts` — zoom math: marquee → viewport transform, pan clamping

## Audio / spectrogram
- `components/Spectrogram.tsx` — renders spectrogram chunks; drives playhead and annotation overlays
- `src-tauri/src/audio/decoder.rs` — PCM decoder with seek-margin logic (canonical sample-accuracy contract)
- `src-tauri/src/audio/fft.rs` — FFT / spectrogram chunk computation
- `src-tauri/src/audio/mod.rs` — audio module exports
- `utils/AudioEngine.ts` — Web Audio playback engine; handles selection play and filter chain
- `utils/audioProcessing.ts` — band-pass filter construction and group-delay compensation
- `utils/PhaseVocoder.ts` — phase vocoder for time-stretching (slow-down playback)
- `utils/rafTicker.ts` — shared requestAnimationFrame scheduler; owns the rAF handle for the playback engines' tick loops
- `MultiTierSpectrogramCache.ts` — in-memory + IndexedDB cache for rendered spectrogram tiles

## IPC layer
- `utils/tauriCommands.ts` — typed wrappers for all general Tauri `invoke()` calls
- `utils/projectCommands.ts` — typed wrappers for project/annotation-specific Tauri commands

## Rust commands
- `src-tauri/src/commands/filesystem.rs` — file listing, reveal-in-finder, directory ops
- `src-tauri/src/commands/projects.rs` — project CRUD and annotation read/write
- `src-tauri/src/commands/audio.rs` — spectrogram decode and PCM range commands
- `src-tauri/src/commands/buzzdetect.rs` — parses `{ident}_buzzdetect.csv` activations (CSV only; bin width inferred)
- `src-tauri/src/commands/shared.rs` — cross-module helpers: audio/video extension tables, `atomic_write`, recursive `walk_files`
- `src-tauri/src/lib.rs` — registers all commands in `invoke_handler!`

## Hooks
- `hooks/useActivationStack.ts` — tracks which overlay/tool is currently "active" (focus stack)
- `hooks/useHotkeys.ts` — global keyboard shortcut dispatcher
- `hooks/useProjects.ts` — project list load/save logic

## Shared types & constants
- `types.ts` — all shared TypeScript types (Project, Annotation, AnnotationTool, etc.)
- `constants.ts` — supported file extensions, default values, keybinding constants
