# SeeNote — Shared Vocabulary

---

# Core Concepts

## Media
Audio and video files, referred to collectively.

## Project
Binds a media source directory to an annotation output directory, along with saved state such as annotation tools and spectrogram display settings.

## Ident
The relative path from a project's source directory to a media file, with no leading slash and no extension. Serves as the key linking a media file to its annotation file. Example: `./audio/foo/bar/recording.mp3` and `./annotations/foo/bar/recording.txt` both have the ident `foo/bar/recording`.

## Track
The media file currently open for annotation.

## Annotation
A time-bounded region on a track with a name. Defined by a start time, end time, and a text name.

## Annotation Tool
A named instrument for creating annotations. Has a hotkey, a default name, and a color. The set of annotation tools is defined per project.

## Active Annotation Tool
The annotation tool currently selected by the user. When no annotation tool is active, dragging on the spectrogram creates a Selection rather than an annotation.

## Selection Mode
When a selection is active. Modifies playback behavior and behavior of annotation tools.

---

# Windows

## Project Window
The opening window of SeeNote that lists projects by recency. Implemented by `LaunchScreen`. A project whose folder can't be found on disk is grayed out and inert; its **Locate** button lets the user re-link it by pointing at the folder's new location. The folder must hold a `.seenote/settings.json`; a differing project name or missing annotation/buzzdetect directory only prompts a confirmation (listing what didn't match) rather than blocking.

## Annotation Window
The window that shows when the user opens a project for creating annotations. Implemented by `AnnotationWindow`. `App.tsx` is the router that switches between Project Window and Annotation Window.

---

# Annotation Window Regions

## Header (top extent)
Shows back button to return to Project Window, project name, project settings, debug, help modal buttons

## File Panel (top left)
The sidebar listing the project's media files in their source directory structure. Implemented by `FileTree` (tree logic) wrapped by a layout div in `AnnotationWindow`.

## Annotation Tools Panel (bottom left)
Shows all defined annotation tools. Implemented by `AnnotationToolsPanel`.
Header is "LABELS" for clarity, even though these are properly called Annotation Tools.

## Timeline Panel (bottom right)
The main content area containing the spectrogram, axes, and toolbar.

### Spectrogram
The time-frequency visualization of the current track. Horizontal axis is time; vertical axis is frequency.

### Axes
- **Time axis** — shows timestamps along the horizontal dimension.
- **Frequency axis** — shows frequency (Hz or mel) along the vertical dimension.

### Toolbar
The control strip above the spectrogram. Contains transport controls, time fields, zoom controls, and access to settings. Implemented by `Toolbar`.

### Spectrogram Settings
Display settings for the spectrogram: frequency range, intensity, FFT size, and frequency scale.

### buzzdetect panel
An optional line graph docked below the spectrogram, plotting per-frame neuron **activations** (raw logits) from buzzdetect output CSVs. It shares the spectrogram's exact time→pixel transform, so it stays in lockstep with the playhead, selection, and annotations. Each **neuron** is one colored polyline; a per-neuron **threshold** controls whether each frame's dot is filled (≥ threshold) or open (below). Clicking a frame (bin) selects that frame's audio interval on the spectrogram; dragging extends the selection across bins. Configured via the buzzdetect directory under **Advanced** in the project create/settings form, toggled from the toolbar. Implemented by `BuzzdetectPanel`.

## Video Panel (top right)
Shows video frames when the current track is a video file. Implemented by `VideoPane`.

---

# Annotation Tools

## Custom Annotation Tool
Bound to hotkey `0`. Creates an annotation with a blank name, auto-focusing the name field for the user to type.
Annotations made with this tool are called "Custom Annotations"

## Defined Annotation Tools
Bound to hotkeys `1`–`9`. Creates an annotation pre-filled with the tool's name and color.
Annotations made with these tools are called "Defined Annotations"

---

# Selections

A `Selection` is a `{ start, end }` interval in seconds on the current track, indicated by two vertical boundary lines and darkening outside the region. A selection may be free-standing (dragged on the spectrogram) or bound to an existing annotation (entered by clicking an annotation's center). The TypeScript type is `Selection` in `types.ts`.

## Bound Selection
A selection entered by clicking the center of an existing annotation. The selection handles and annotation boundaries move together.

---

# Playback

## Playhead
The vertical line on the spectrogram indicating the current playback position, driven by the audio clock.

## Transport
The set of playback controls: play/pause, jump to start/end, previous/next file.

## Selection Playback
Playback bounded to the active selection region.

---

# Export

## Output Format
The file format for annotation files. Options: Audacity `.txt`, `.csv`, or `.json`.

## Annotation File
The file in the annotation output directory corresponding to a track, pathed by ident.
