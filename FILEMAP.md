# Codebase map

Quick reference for agents. One phrase per file.

## Entrypoints
- `AnnotationWindow.tsx` — thin app orchestrator; wires together state and the hooks below (persistence, sync, playback, tools, navigation), owns top-level layout
- `App.tsx` — top-level router: launch screen → project selection → AnnotationWindow
- `index.tsx` / `main.tsx` — Vite/React mount point

## Toolbar & panels
- `components/Toolbar.tsx` — composes the shared controls below into the strip above the spectrogram
- `components/FileTree.tsx` — left-side file browser with context menus and shuffle/filter
- `components/HelpHighlightHost.tsx` — draws the ghost highlight over a real control when the guide window asks for it
- `components/AnnotationToolsPanel.tsx` — annotation tool palette (add/edit/reorder tools)
- `components/ToolCell.tsx` — compact tool button used inside the annotation tools panel
- `components/RepairProjectModal.tsx` — modal to re-point a project at a moved media directory
- `components/DebugConsole.tsx` — collapsible overlay listing debug logs (video/decode diagnostics) with copy-all
- `components/BuzzdetectPanel.tsx` — line graph of buzzdetect activations docked below the spectrogram; shares its time→pixel transform
- `components/DirectoryField.tsx` — shared directory picker (label/input/browse/resolve/portability/existence) used by both project modals
- `components/CollapsibleSection.tsx` — small disclosure section (chevron + title) for optional form fields

## Help guide (its own window — `index.html?window=help`)
- `components/help/guide.ts` — the guide's page tree: parts → pages → blocks, plus nav/search derivations (keep in sync with behavior changes)
- `components/help/HelpWindow.tsx` — two-column shell: nav and page body; owns session browsing history (back/forward buttons and `Alt+←`/`Alt+→`) so a cross-reference or nav-rail click can be undone
- `components/help/HelpNav.tsx` — nested collapsible section tree with search filter
- `components/help/HelpContent.tsx` — renders a page's blocks through `renderInlineMarkdown`
- `components/help/LiveControls.tsx` — embeds the real controls in the guide, driving the open project (or local demo state when none is open, or when that control's panel doesn't exist in the host window)
- `components/help/ExamplePanels.tsx` — panels and modals rendered against the example project (too big / too window-bound to mirror)
- `utils/demoProject.ts` — fixture project the guide's example panels render against
- `components/HelpAnchor.tsx` — a term that ghosts a real control on hover (`target`) and/or is a clickable cross-reference to another guide page (`page`): light background + superscript icon, plus a delayed `HelpPreviewCard` of the target page
- `components/HelpPreviewCard.tsx` — the cross-reference hover preview, styled like a shrunken guide page (title + opening blurb) rather than a generic tooltip
- `components/HighlightOverlay.tsx` — shared ghost-overlay renderer; `HelpHighlightHost` drives it from the cross-window broadcast, `HelpWindow` drives it from local hover state (so the guide's own embedded chip highlights too)
- `utils/helpChannel.ts` — BroadcastChannel bridging the guide window and the main window (highlight / navigate)
- `utils/liveBridge.ts` — BroadcastChannel mirroring toolbar state to the guide and control actions back (`useLiveHost` / `useLiveClient`)
- `copy/help.ts` — all guide prose, keyed `help.<page>.<block>`

## Toolbar controls (shared by the toolbar and the guide's live copies)
- `components/controls/TransportButtons.tsx` — start/prev/play/next/end plus the playhead lock
- `components/controls/TimeReadout.tsx` — running playhead time, click-to-type, Seconds/HMS toggle
- `components/controls/SelectionTimeFields.tsx` — the from/to/dur trio
- `components/controls/PlaybackSpeedControl.tsx` — speed readout, wheel-to-nudge, 1× toggle
- `components/controls/FilterControls.tsx` — band-pass tool button and dry/wet strength slider
- `components/controls/ToolbarToggles.tsx` — buzzdetect panel toggle and spectrogram-settings gear
- `components/controls/SpectrogramSettingsPanel.tsx` — the settings popover body (level range, frequency, FFT)
- `components/controls/FilePanelHeaderButtons.tsx` — expand/collapse, refresh, file filter, shuffle
- `components/VolumeControl.tsx` — volume slider with 2× gain boost and mute
- `components/AnnotationToolsPanel.tsx` — the tool palette; already pure, so the guide embeds it directly

## Video
- `components/VideoPane.tsx` — video container; positions VideoPlayer and VideoZoomLayer
- `components/VideoZoomLayer.tsx` — marquee-zoom overlay and pan viewfinder UI
- `components/VideoPlayer.tsx` — presentational `<video>` element (Fast / Mixed-without-selection); transport driven externally by VideoElementEngine
- `components/CanvasVideoPlayer.tsx` — frame-accurate canvas renderer driven by VideoFrameSource (Accurate / Mixed-with-selection); draws the cached frame ≤ current media time
- `utils/VideoElementEngine.ts` — playback transport backed by a `<video>` element playing its own audio (Fast mode); mirrors the AudioEngine interface
- `utils/VideoFrameSource.ts` — decodes individual video frames via canvas for spectrogram alignment
- `utils/videoZoom.ts` — zoom math: marquee → viewport transform, pan clamping

## Audio / spectrogram
- `components/Spectrogram.tsx` — thin spectrogram orchestrator; delegates tile rendering to useChunkRenderer, pointer/selection logic to useSpectrogramInteraction, and overlays to the spectrogram/ leaf components
- `components/spectrogram/SelectionHandles.tsx` — selection rectangle and its drag handles overlay
- `components/spectrogram/FilterHandles.tsx` — band-pass filter band and its drag handles overlay
- `components/spectrogram/AnnotationOverlay.tsx` — annotation boxes, labels, and text-input editing overlay
- `src-tauri/src/audio/decoder.rs` — PCM decoder with seek-margin logic (canonical sample-accuracy contract)
- `src-tauri/src/audio/fft.rs` — FFT / spectrogram chunk computation
- `src-tauri/src/audio/stream_pool.rs` — reuses open decoder streams across chunk requests so repeated seeks into a long file dont rescan the container
- `src-tauri/src/audio/mod.rs` — audio module exports
- `utils/AudioEngine.ts` — thin Web Audio playback engine; delegates time-stretch to TimeStretchEngine, PCM caching to PcmCache, and filtering to BandPassFilterGraph
- `utils/audioProcessing.ts` — band-pass filter construction and group-delay compensation
- `utils/TimeStretchEngine.ts` — pitch-preserving time-stretch for AudioEngine; picks between the two stretch engines by speed
- `utils/PcmCache.ts` — LRU cache of decoded PCM ranges for instant selection replay (bypasses Rust IPC on hit)
- `utils/BandPassFilterGraph.ts` — persistent Butterworth band-pass filter graph plus async group-delay measurement
- `utils/PhaseVocoder.ts` — phase vocoder for time-stretching (slow-down playback)
- `utils/rafTicker.ts` — shared requestAnimationFrame scheduler; owns the rAF handle for the playback engines' tick loops
- `MultiTierSpectrogramCache.ts` — in-memory multi-tier cache of decoded spectrogram chunks, with LRU eviction and a bounded fetch queue

## IPC layer
- `utils/tauriCommands.ts` — typed wrappers for all general Tauri `invoke()` calls
- `utils/projectCommands.ts` — typed wrappers for project/annotation-specific Tauri commands

## Rust commands
- `src-tauri/src/commands/filesystem.rs` — file listing, reveal-in-finder, directory ops
- `src-tauri/src/commands/projects.rs` — project CRUD and annotation read/write
- `src-tauri/src/commands/audio.rs` — spectrogram decode and PCM range commands
- `src-tauri/src/commands/buzzdetect.rs` — parses `{ident}_buzzdetect.csv` activations (CSV only; bin width inferred)
- `src-tauri/src/commands/shared.rs` — cross-module helpers: audio/video extension tables, `atomic_write`, recursive `walk_files`
- `src-tauri/src/commands/git_sync/mod.rs` — annotation sync to a remote git repo via embedded libgit2 (no system git required); module entry/exports
- `src-tauri/src/commands/git_sync/auth.rs` — credentials and auth-error classification for remote git operations
- `src-tauri/src/commands/git_sync/remote.rs` — fetch/push against the remote plus remote-tracking lookups
- `src-tauri/src/commands/git_sync/merge.rs` — three-way merge of the remote tracking branch into HEAD with conflict resolution
- `src-tauri/src/commands/git_sync/annotate.rs` — annotation set-merge (conflict-free model) and tree-diff change summaries
- `src-tauri/src/commands/git_sync/repo.rs` — repo setup (open/init, branch, gitignore), staging/commit, and local/remote status checks
- `src-tauri/src/commands/window.rs` — window bounds and secondary-window (help guide, sync guide, copy editor) commands; also `PendingOpenFile` state for OS "Open With" launches
- `src-tauri/src/lib.rs` — registers all commands in `invoke_handler!`; handles OS file-association launches (single-instance relaunch forwarding, `RunEvent::Opened` on macOS, cold-start argv on Windows/Linux)

## Hooks
- `hooks/useActivationStack.ts` — tracks which overlay/tool is currently "active" (focus stack)
- `hooks/useHotkeys.ts` — global keyboard shortcut dispatcher
- `hooks/useProjects.ts` — project list load/save logic
- `hooks/useExamplePlayer.ts` — plays annotation-tool example clips
- `hooks/useAnnotationHistory.ts` — undo/redo snapshot stack for annotations
- `hooks/usePanelLayout.ts` — split-ratio / panel-width layout state and drag resizing
- `hooks/useCollapsibleSidebar.ts` — width + drag-to-collapse for a left panel (the file panel and the guide's section rail)
- `hooks/useBandPassFilter.ts` — band-pass filter tool state and draw/apply wiring
- `hooks/useBuzzdetect.ts` — buzzdetect panel enable/load state for the active track
- `hooks/useProjectPersistence.ts` — debounced persistence of project settings/preferences
- `hooks/useSyncManagement.ts` — git-sync status polling and sync/commit actions
- `hooks/useChunkRenderer.ts` — draws cached spectrogram tiles to the canvas as the viewport moves
- `hooks/useChunkCacheVersion.ts` — chunk-cache version counter, coalesced to one React update per animation frame
- `hooks/useAnnotationTools.ts` — annotation tool CRUD, hotkey map, and example import
- `hooks/useImportAnnotations.ts` — imports Audacity/annotation files into the current track
- `hooks/useSpectrogramInteraction.ts` — spectrogram pointer logic: selection, annotation drag/create, filter draw
- `hooks/usePlaybackTransport.ts` — selects/owns the active playback transport (audio vs video engine)
- `hooks/useFileNavigation.ts` — next/prev/shuffle track navigation
- `hooks/useVideoFrameSource.ts` — opens and tears down the VideoFrameSource for the active track/mode
- `hooks/useAnnotationLoad.ts` — loads annotations for a track and resets history
- `hooks/useOsOpenFile.ts` — routes an OS "Open With SeeNote" launch (file-association cold start, or a relaunch forwarded from a second instance) into the app

## Shared types & constants
- `types.ts` — all shared TypeScript types (Project, Annotation, AnnotationTool, etc.)
- `constants.ts` — supported file extensions, default values, keybinding constants
