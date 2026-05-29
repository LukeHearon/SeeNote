### Handover Summary: Code Review & Refactoring Pass

A structural code review was conducted to identify cruft, dead code paths, and duplication following a recent video stack redesign. Wave 1 of the cleanup has been executed, establishing shared primitives, refactoring the Spectrogram cluster, and streamlining Rust backend utilities.

#### Finished Items (Brief Summary)

* 
**Rust Backend Dedup (Wave 1)**: Created `src-tauri/src/commands/shared.rs`. Consolidated verbatim copies of `AUDIO_EXTS` and `VIDEO_EXTS`. Refactored `write_text_file` to use a single shared atomic temporary-write-and-rename mechanism (`atomic_write`). Cargo check is warning-free and backend tests pass.


* 
**Spectrogram Cluster Cleanup (Wave 1)**: Deactivated the unused `onSelectionCommit` prop entirely from `Spectrogram.tsx` and `BuzzdetectPanel.tsx`. Purged write-only hooks/refs (`interactionRef`) , unused imports (`AnnotationWithLayer`) , and non-read properties (`canGoPrev`/`canGoNext`). Extracted an open-coded max-scroll clamp formula into a module-scoped `computeMaxScroll` utility.



#### Outstanding Tasks (To Be Picked Up)

**1. Consume Frontend Primitives (Wave 2)**
Wave 1 established common frontend types and lightweight primitives (such as a shared `PlaybackTransport` interface, `getExt()`, `stripExt()`, and `shuffleArray()`). Multiple components and utilities still need to be updated to consume these centralized tools:

* 
**Playback Interface Consolidation**: Update `utils/AudioEngine.ts` and `utils/VideoElementEngine.ts` to explicitly implement the newly created `PlaybackTransport` structural interface. Clean up union error checking in `AnnotationWindow.tsx` (~line 591) to target the abstraction interface instead.


* **File Extension String Helpers**: Swap out repetitive `split('.').pop()?.toLowerCase() ?? [cite_start]''` logic for the centralized `getExt()` utility in `constants.ts` (line 30), `AnnotationWindow.tsx` (line 420), `FileTree.tsx` (line 49), and `VideoFrameSource.ts` (line 624).


* 
**Regex Strip Modification**: Replace open-coded filename stem lookups (`replace(/\.[^/.]+$/, '')`) with `stripExt()` across `helpers.ts`, `FileTree.tsx`, and `AnnotationWindow.tsx` (specifically inside `ident`, `getAnnotationPath`, and `refreshAnnotatedSet`).


* 
**Array Shuffling & Drags**: Replace the localized duplicate Fisher-Yates array shufflers inside `AnnotationWindow.tsx` (lines 674 and 981) with the shared utility. Standardize the three open-coded window-drag handler scaffolds found in `AnnotationWindow.tsx` (lines 1472, 1492, and 1515).



**2. Audio Filter Sync Guarding**

* Prevent potential desyncs along the time-axis by deduplicating the `BUTTERWORTH_8_Q` array and cascaded-biquad structure shared between `utils/AudioEngine.ts` (line 514) and its corresponding group-delay calculation (line 628).



**3. Documentation, Filemaps, and Environment Cleanup**

* 
**Stale Docstrings**: Run a localized sweep to replace old mentions of `"high"` with `"accurate"` in docstrings within `AnnotationWindow.tsx` (lines 269 and 538) and `utils/VideoElementEngine.ts` (lines 5 and 20).


* 
**FILEMAP Alignment**: Update `FILEMAP.md` to register `CanvasVideoPlayer.tsx` (the active frame-accurate component for Accurate/Mixed modes) along with missing ancillary structures such as `DebugConsole`, `ToolCell`, and `RepairProjectModal`.


* 
**Miscalibrated Git Worktree**: Remove the locked, stale worktree physical folder matching `.claude/worktrees/agent-a6724670c03d507b9/`. It is currently unregistered or misconfigured inside git paths under a previous folder name (`buzzdetect/SeeNote`), so it requires a forced or careful manual pruning.