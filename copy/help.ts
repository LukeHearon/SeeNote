import { getOverride } from './overrideStore';

// Copy for the help guide window. Keys are `help.<area>.<name>`, where the
// `pages` / `parts` areas name the navigation itself and every other area is
// one guide page. The page tree that consumes these lives in
// components/help/guide.ts — add copy here, structure there.
//
// Every string is a getter so copy-editor overrides apply live; buildRegistry()
// in copy/registry.ts flattens this object to discover the keys.

export const help = {
  get windowTitle() { return getOverride('help.windowTitle') ?? "SeeNote Guide"; },
  get navAriaLabel() { return getOverride('help.navAriaLabel') ?? "Guide sections"; },
  get showSections() { return getOverride('help.showSections') ?? "Show sections"; },
  get searchPlaceholder() { return getOverride('help.searchPlaceholder') ?? "Search the guide"; },
  get searchNoResults() { return getOverride('help.searchNoResults') ?? "No matching sections"; },
  get back() { return getOverride('help.back') ?? "Back"; },
  get forward() { return getOverride('help.forward') ?? "Forward"; },

  live: {
    get connected() { return getOverride('help.live.connected') ?? "Live"; },
    get demo() { return getOverride('help.live.demo') ?? "Demo"; },
    get example() { return getOverride('help.live.example') ?? "Example project"; },
    get reopen() { return getOverride('help.live.reopen') ?? "Open it again"; },
  },

  parts: {
    get start() { return getOverride('help.parts.start') ?? "Getting started"; },
    get workspace() { return getOverride('help.parts.workspace') ?? "The workspace"; },
    get playback() { return getOverride('help.parts.playback') ?? "Playback"; },
    get annotating() { return getOverride('help.parts.annotating') ?? "Annotating"; },
    get settings() { return getOverride('help.parts.settings') ?? "Projects & settings"; },
    get saving() { return getOverride('help.parts.saving') ?? "Saving & sharing"; },
    get reference() { return getOverride('help.parts.reference') ?? "Reference"; },
  },

  pages: {
    get overview() { return getOverride('help.pages.overview') ?? "What SeeNote is"; },
    get launch() { return getOverride('help.pages.launch') ?? "The launch screen"; },
    get projects() { return getOverride('help.pages.projects') ?? "Projects"; },
    get singleFile() { return getOverride('help.pages.singleFile') ?? "Single-file mode"; },
    get updates() { return getOverride('help.pages.updates') ?? "Updating SeeNote"; },
    get layout() { return getOverride('help.pages.layout') ?? "Panels & layout"; },
    get filePanel() { return getOverride('help.pages.filePanel') ?? "File panel"; },
    get zoom() { return getOverride('help.pages.zoom') ?? "Zooming & scrolling"; },
    get spectrogramSettings() { return getOverride('help.pages.spectrogramSettings') ?? "Spectrogram settings"; },
    get debug() { return getOverride('help.pages.debug') ?? "Debug console"; },
    get importing() { return getOverride('help.pages.importing') ?? "Importing annotations"; },
    get projectSettings() { return getOverride('help.pages.projectSettings') ?? "Project settings"; },
    get repair() { return getOverride('help.pages.repair') ?? "When files move"; },
    get files() { return getOverride('help.pages.files') ?? "Annotation files & idents"; },
    get troubleshooting() { return getOverride('help.pages.troubleshooting') ?? "Troubleshooting"; },
    get video() { return getOverride('help.pages.video') ?? "Video pane"; },
    get videoZoom() { return getOverride('help.pages.videoZoom') ?? "Video zoom & image"; },
    get spectrogram() { return getOverride('help.pages.spectrogram') ?? "Spectrogram"; },
    get buzzdetect() { return getOverride('help.pages.buzzdetect') ?? "buzzdetect panel"; },
    get subset() { return getOverride('help.pages.subset') ?? "Subset to detections"; },
    get transport() { return getOverride('help.pages.transport') ?? "Transport & playhead"; },
    get timeDisplay() { return getOverride('help.pages.timeDisplay') ?? "Time display"; },
    get speed() { return getOverride('help.pages.speed') ?? "Playback speed"; },
    get filter() { return getOverride('help.pages.filter') ?? "Band-pass filter"; },
    get modes() { return getOverride('help.pages.modes') ?? "Selection vs. Tool mode"; },
    get creating() { return getOverride('help.pages.creating') ?? "Creating annotations"; },
    get editing() { return getOverride('help.pages.editing') ?? "Editing annotations"; },
    get tools() { return getOverride('help.pages.tools') ?? "Annotation tools"; },
    get bulk() { return getOverride('help.pages.bulk') ?? "Renaming & finding labels"; },
    get sync() { return getOverride('help.pages.sync') ?? "Sync (GitHub)"; },
    get shortcuts() { return getOverride('help.pages.shortcuts') ?? "Keyboard shortcuts"; },
  },

  overview: {
    get p1() { return getOverride('help.overview.p1') ?? "SeeNote is a tool for listening to and looking at recordings, and marking what you find in them — building labelled datasets from audio and video."; },
    get p2() { return getOverride('help.overview.p2') ?? "The loop is short: open a project, pick a track from the [file panel](file-panel@file-panel), scrub around the [spectrogram](spectrogram-canvas@spectrogram) while you listen, and drag a box over anything worth labelling. Every change is written to disk immediately — there is no save button."; },
    get h_pieces() { return getOverride('help.overview.h_pieces') ?? "The pieces"; },
    get li_project() { return getOverride('help.overview.li_project') ?? "A **project** points at a folder of recordings and a folder to write annotations into. Everything else — your labels, your display settings, your filter — is remembered per project."; },
    get li_track() { return getOverride('help.overview.li_track') ?? "A **track** is whichever recording is currently open."; },
    get li_annotation() { return getOverride('help.overview.li_annotation') ?? "An **annotation** is a start time, an end time, and a label."; },
    get li_tool() { return getOverride('help.overview.li_tool') ?? "An **annotation tool** is a named label bound to a number key. Pressing `3` and dragging is how a label gets made."; },
    get li_ident() { return getOverride('help.overview.li_ident') ?? "An **ident** is a recording's path relative to the media folder, minus the extension. It's the key that ties `audio/site_a/dawn.wav` to `annotations/site_a/dawn.txt`."; },
    get note_ml() { return getOverride('help.overview.note_ml') ?? "Annotation files are plain tab-delimited text in Audacity's label format, so they read straight into most training pipelines without conversion. See [Annotation files & idents](@files)."; },
  },

  launch: {
    get p1() { return getOverride('help.launch.p1') ?? "The first screen lists everything you've opened, most recent first. Entries are badged **Project** or **File**, so projects and one-off files share a single list."; },
    get h_buttons() { return getOverride('help.launch.h_buttons') ?? "Getting in"; },
    get li_new() { return getOverride('help.launch.li_new') ?? "**New Project** — create a project: pick a folder for it, name it, and point it at your media and annotation directories."; },
    get li_open() { return getOverride('help.launch.li_open') ?? "**Open Project** — adopt a folder that already contains a project (one holding a `.seenote/settings.json`), e.g. after cloning a colleague's setup."; },
    get li_file() { return getOverride('help.launch.li_file') ?? "**Open File** — open one recording on its own, with no project. See [Single-file mode](@single-file)."; },
    get li_sync() { return getOverride('help.launch.li_sync') ?? "**Git Sync Help** — opens the step-by-step guide to setting up a shared repository."; },
    get li_data() { return getOverride('help.launch.li_data') ?? "**App Data** — reveals SeeNote's own data folder, where the list of known projects and recent files is kept."; },
    get h_entries() { return getOverride('help.launch.h_entries') ?? "Working with entries"; },
    get p_entries() { return getOverride('help.launch.p_entries') ?? "Right-click an entry to reveal it in Finder / File Explorer or remove it from the list — removing only forgets the entry, it never deletes anything on disk. The gear on a project entry opens its settings without opening the project."; },
    get p_star() { return getOverride('help.launch.p_star') ?? "Hover an entry to reveal a star. Starred projects and files are pinned above a divider at the top of the list, sorted by recency among themselves."; },
    get p_missing() { return getOverride('help.launch.p_missing') ?? "An entry whose folder can't be found is greyed out and won't open. Its **Locate** button re-links it — see [When files move](@repair)."; },
  },

  projects: {
    get p1() { return getOverride('help.projects.p1') ?? "SeeNote is organized around **projects**. Each project links a **media directory** (audio/video) to an **annotation directory** where annotation files are saved."; },
    get p2() { return getOverride('help.projects.p2') ?? "Configure project-level settings and user preferences by opening the [project settings](project-settings-btn@project-settings)."; },
    get h_dirs() { return getOverride('help.projects.h_dirs') ?? "Directories & portability"; },
    get p_dirs() { return getOverride('help.projects.p_dirs') ?? "A project lives in its own folder, which holds a hidden **.seenote/** directory for its settings, preferences, and annotation tools. The media and annotation directories are usually subfolders of it, stored as relative paths — that keeps the project **portable**, so the whole folder can be moved or handed to a collaborator and still work."; },
    get p_outside() { return getOverride('help.projects.p_outside') ?? "You can point either directory somewhere outside the project folder — at a media drive, say. SeeNote will read it happily, but it warns you that the project is no longer portable, because the absolute path won't mean anything on another machine. Syncing additionally requires the annotation directory to sit inside the project folder."; },
    get h_appearance() { return getOverride('help.projects.h_appearance') ?? "Naming & appearance"; },
    get p_appearance() { return getOverride('help.projects.p_appearance') ?? "A project's name is shown in the header and on the launch screen. You can give it a color gradient in project settings — purely decorative, but it makes several open projects easy to tell apart at a glance."; },
  },

  singleFile: {
    get p1() { return getOverride('help.singleFile.p1') ?? "You can also open a single audio/video file without a project — use **Open File** on the launch screen, pick a recent file, or choose SeeNote from your OS's **Open With** menu on a supported file. This opens a lean viewer (playback, spectrogram, band-pass filter) with no annotation tooling."; },
    get p2() { return getOverride('help.singleFile.p2') ?? "Everything about playback works as it does in a project: [transport](transport-buttons@transport), [speed](playback-speed@speed), [volume](volume-control@transport#volume), the [band-pass filter](filter-tool@filter), [video modes](video-panel@video) and [zoom](video-panel@video-zoom), and the spectrogram's own [pan/zoom](spectrogram-canvas@zoom). What's missing is anything that needs somewhere to write to — [annotation tools](tool-palette@tools), the [file panel](file-panel@file-panel), [saving](@files), and [syncing](@sync)."; },
    get note_assoc() { return getOverride('help.singleFile.note_assoc') ?? "SeeNote registers itself for common audio and video types, so \"Open With → SeeNote\" works from your file manager. Opening a file this way while SeeNote is already running hands it to the running copy rather than starting a second one."; },
  },

  updates: {
    get p1() { return getOverride('help.updates.p1') ?? "SeeNote checks for a new release once, when the launch screen appears. If one is available, a banner offers **Update** — it downloads and installs in place, then restarts the app."; },
    get note_linux() { return getOverride('help.updates.note_linux') ?? "On a Linux `.deb` install the in-place updater can't be used, so the banner offers **View** instead, which opens the releases page for you to download from. AppImage installs update in place normally."; },
    get p_manual() { return getOverride('help.updates.p_manual') ?? "If an update fails, the error is shown on the banner and nothing has changed — the running version is untouched, and you can retry or download the release manually."; },
  },

  layout: {
    get p1() { return getOverride('help.layout.p1') ?? "The annotation window is five regions. Down the left, the [file panel](file-panel@file-panel) over the label palette; down the right, the [video pane](video-panel@video) over the [toolbar](toolbar) and [spectrogram](spectrogram-canvas@spectrogram), with the optional [buzzdetect panel](buzzdetect-toggle@buzzdetect) beneath them."; },
    get p2() { return getOverride('help.layout.p2') ?? "The [header](toolbar) across the top holds the back button, a [refresh button](header-refresh-btn), the project name and its [settings gear](project-settings-btn@project-settings), the sync controls when [syncing](@sync) is configured, and the debug and help buttons."; },
    get p_refresh() { return getOverride('help.layout.p_refresh') ?? "**Refresh** re-scans the file tree (for files added or removed underneath you), reloads the project's annotation tools, re-reads the current track's labels from disk, and re-reads its buzzdetect activations — everything a sync's own automatic refresh covers, on demand."; },
    get h_resize() { return getOverride('help.layout.h_resize') ?? "Resizing"; },
    get p_resize() { return getOverride('help.layout.p_resize') ?? "Every boundary between regions is a drag handle: the vertical divider sets the left column's width, the horizontal one between the file panel and the labels sets their split, and the one under the video sets how much height the picture gets versus the spectrogram. Layout is remembered per project."; },
    get h_collapse() { return getOverride('help.layout.h_collapse') ?? "Collapsing"; },
    get p_collapse() { return getOverride('help.layout.p_collapse') ?? "Drag the video divider all the way up to fold the pane into a bar, and the file panel's sidebar toggle to fold the left column into a narrow strip of colored label swatches. Both free up spectrogram height without interrupting playback.\n\nInside the left column, each section folds to its header: click the chevron beside its name, or throw a divider past the section to squash it. A folded section keeps the buttons in its header, so its dialogs and switches stay one click away; the chevron opens it again."; },
  },

  filePanel: {
    get p1() { return getOverride('help.filePanel.p1') ?? "Lists every track in the project directory. Tracks with existing annotations are highlighted in the list. Click any track to open it, or use `{mod}+↑` / `{mod}+↓` to step through tracks in order. Stepping stays within the tracks currently shown in the panel — it respects the active filter and the folder you've drilled into."; },
    get h_header() { return getOverride('help.filePanel.h_header') ?? "Header buttons"; },
    get li_filter() { return getOverride('help.filePanel.li_filter') ?? "**Filter:** cycles the list between all tracks, only annotated ones, and only unannotated ones — the quickest way to find what's left to do. `{mod}+↑` / `{mod}+↓` then step only through the tracks the filter leaves visible."; },
    get li_shuffle() { return getOverride('help.filePanel.li_shuffle') ?? "**Shuffle:** replaces the folder tree with a randomly-ordered flat queue of every track. `{mod}+↑` / `{mod}+↓` then walk the shuffled order, which is what you want for unbiased sampling. Press it again to return to the sorted tree."; },
    get li_expand() { return getOverride('help.filePanel.li_expand') ?? "**Expand all / collapse all:** open or close every folder at once."; },
    get h_folders() { return getOverride('help.filePanel.h_folders') ?? "Folders"; },
    get p_folders() { return getOverride('help.filePanel.p_folders') ?? "Hover a folder and click the arrow to drill into it as the panel root; once inside, the header shows **step up one folder** and **back to root** buttons."; },
    get p_pinned() { return getOverride('help.filePanel.p_pinned') ?? "Once you scroll into a folder's files, a breadcrumb pins to the top of the list naming the folders you're inside, so you can tell where you are without scrolling back up. It gains a level each time you scroll past an open folder's row and drops one when you leave that folder, so it always describes the top of the list. It hides itself when the panel is too short to show three tracks beneath it."; },
    get h_context() { return getOverride('help.filePanel.h_context') ?? "Right-click menu"; },
    get p_context() { return getOverride('help.filePanel.p_context') ?? "Right-click a track or folder to reveal its media location or annotation file in the system file manager. **Copy ident** copies its ident to the clipboard (a folder's ident is its path relative to the audio root). **Import annotations…** loads annotations from an external file; they are filed under that track's ident. If the track already has annotations, you can **Overwrite** them or **Merge** (append the imported ones)."; },
    get h_collapse() { return getOverride('help.filePanel.h_collapse') ?? "Collapsing the panel"; },
    get p_collapse() { return getOverride('help.filePanel.p_collapse') ?? "Collapse the panel with the sidebar toggle to free up space — the annotation tools reappear as a strip of colored number swatches; hover one for its name, click to activate it."; },
  },

  video: {
    get intro() { return getOverride('help.video.intro') ?? "The picker in the **bottom-left corner of the video pane** chooses how video is rendered. Saved per project:"; },
    get li_off() { return getOverride('help.video.li_off') ?? "**Off:** no video — audio only. Lightest on the CPU."; },
    get li_fast() { return getOverride('help.video.li_fast') ?? "**Fast:** the browser `<video>` element shows the picture and plays its _own_ audio, free-running. Smooth and cheap, but not spectrogram-synced — no band-pass filter, no pitch-preserving slow-down, and the playhead is approximate. For machines that can't run Accurate."; },
    get li_mixed() { return getOverride('help.video.li_mixed') ?? "**Mixed:** `<video>` (as in Fast) until you make a selection, then frame-accurate decoding for that region. Good for older hardware."; },
    get li_accurate() { return getOverride('help.video.li_accurate') ?? "**Accurate:** frame-accurate WebCodecs decoding throughout (MP4/MOV only). Best fidelity, heaviest on the CPU."; },
    get note_badge() { return getOverride('help.video.note_badge') ?? "When the picture isn't sample-accurate with the audio, an inaccuracy badge appears in the video pane's top-left corner. If scrubbing or playback stutters, drop one level."; },
    get h_pane() { return getOverride('help.video.h_pane') ?? "Collapsing the pane"; },
    get p_pane1() { return getOverride('help.video.p_pane1') ?? "Drag the divider below the video all the way up to collapse the pane to a bar; click the bar (or drag it back down) to restore it. Playback keeps running while collapsed."; },
    get p_pane2() { return getOverride('help.video.p_pane2') ?? "The pane only exists for video tracks — audio-only files skip it entirely (a video file keeps its pane even if its frames can't be decoded)."; },
    get h_codecs() { return getOverride('help.video.h_codecs') ?? "When video won't display"; },
    get p_codecs() { return getOverride('help.video.p_codecs') ?? "\"Can't display this video\" in Accurate mode means your system is missing a codec. In Fast/Mixed mode on Linux, it's usually a known platform limitation, not a missing codec — try Accurate mode instead."; },
  },

  videoZoom: {
    get intro() { return getOverride('help.videoZoom.intro') ?? "When the active track has video, controls appear at the **top-right** of the [video panel](video-panel@video)."; },
    get li1() { return getOverride('help.videoZoom.li1') ?? "**`Z`:** toggle zoom state — restores your last zoomed viewport when turning on, saves it when turning off."; },
    get li2() { return getOverride('help.videoZoom.li2') ?? "**`Shift+Z`:** toggle the marquee drawing tool. While armed, drag a box over the video to zoom into that region. Press `Esc` mid-drag to cancel."; },
    get li3() { return getOverride('help.videoZoom.li3') ?? "**`=` / `+` / `-`:** zoom in / out from the current viewport center (while zoomed)."; },
    get li4() { return getOverride('help.videoZoom.li4') ?? "**Pan:** while zoomed, scroll (trackpad two-finger or mouse wheel) over the video panel to pan around."; },
    get li5() { return getOverride('help.videoZoom.li5') ?? "**Zoom in / out / reset:** buttons available whenever zoomed in."; },
    get li6() { return getOverride('help.videoZoom.li6') ?? "**Viewfinder:** while zoomed, a minimap appears bottom-right — drag inside it to pan the view."; },
    get note1() { return getOverride('help.videoZoom.note1') ?? "Zoom is purely visual and never affects the playhead, audio, or annotation timing."; },
    get h_image() { return getOverride('help.videoZoom.h_image') ?? "Brightness & contrast"; },
    get p_image() { return getOverride('help.videoZoom.p_image') ?? "Click either button to pop out a slider, with a reset button alongside it."; },
    get note_image() { return getOverride('help.videoZoom.note_image') ?? "Brightness/contrast are display-only — they don't affect exported annotations or the underlying video file."; },
  },

  spectrogram: {
    get li1() { return getOverride('help.spectrogram.li1') ?? "**Pan:** Right-click & drag, or scroll wheel."; },
    get li2() { return getOverride('help.spectrogram.li2') ?? "**Zoom:** `{mod}` + scroll wheel."; },
    get li3() { return getOverride('help.spectrogram.li3') ?? "**Seek:** Left-click (in Selection Mode) to move the playhead."; },
    get li4() { return getOverride('help.spectrogram.li4') ?? "**Play/Pause:** `Space`."; },
    get li5() { return getOverride('help.spectrogram.li5') ?? "**Toggle playback rate (1× ↔ last defined):** `R`."; },
    get li6() { return getOverride('help.spectrogram.li6') ?? "**Export selection:** `{mod}+Shift+E`, or right-click with a selection made and choose **Export selected audio…**, to save it as its own file. The suggested filename follows the project's filename-timestamp scheme when one is set; retyping the extension in the save dialog picks the output format (formats other than `.wav` need ffmpeg installed)."; },
    get h_axes() { return getOverride('help.spectrogram.h_axes') ?? "Axes"; },
    get p_axes() { return getOverride('help.spectrogram.p_axes') ?? "Time runs along the bottom, frequency up the side. Both axes rescale as you zoom, and the [buzzdetect panel](buzzdetect-toggle@buzzdetect) shares the spectrogram's exact time-to-pixel transform, so anything stacked below stays in lockstep with the playhead and your selections."; },
    get p_axisDatetime() { return getOverride('help.spectrogram.p_axisDatetime') ?? "In [Date mode](@time-display) the time axis reads as wall-clock datetimes. Ticks land on round clock boundaries, and each label spells out only what changed since the one before it — `2026-01-01 23:00`, then `01-02 00:00`, then `01:00` — so a fifty-hour file reads without repeating the date at every tick."; },
    get p_settings() { return getOverride('help.spectrogram.p_settings') ?? "How the image is drawn — FFT size, frequency scale, frequency range, dynamic range — lives behind the [settings gear](spectrogram-settings@spectrogram-settings)."; },
  },

  zoom: {
    get p1() { return getOverride('help.zoom.p1') ?? "The [spectrogram](spectrogram-canvas@spectrogram) shows a window onto the track, not the whole thing. How wide that window is, and where it sits, is yours to drive."; },
    get h_zoom() { return getOverride('help.zoom.h_zoom') ?? "Zooming"; },
    get li_wheel() { return getOverride('help.zoom.li_wheel') ?? "**`{mod}` + scroll wheel** over the spectrogram zooms around the cursor."; },
    get li_keys() { return getOverride('help.zoom.li_keys') ?? "**`{mod}+=` / `{mod}+-`** zoom in and out from the center of the current view."; },
    get li_fit() { return getOverride('help.zoom.li_fit') ?? "**`{mod}+0`** fits the entire track on screen. Press it again to drop back to exactly where you were — it remembers the window you left."; },
    get h_pan() { return getOverride('help.zoom.h_pan') ?? "Panning"; },
    get li_drag() { return getOverride('help.zoom.li_drag') ?? "**Right-click & drag** the spectrogram, or **scroll** without a modifier, to slide the view along."; },
    get li_arrows() { return getOverride('help.zoom.li_arrows') ?? "**`←` / `→`** move the playhead a pixel at a tap, accelerating while held — fine enough to place it exactly. While a selection is active the same keys walk its edge instead. During playback they scrub by a tenth of the visible window."; },
    get li_jump() { return getOverride('help.zoom.li_jump') ?? "**`{mod}+←` / `{mod}+→`** jump to the start / end of the track; **`Alt+←` / `Alt+→`** step between annotations."; },
    get note_lock() { return getOverride('help.zoom.note_lock') ?? "With [playhead lock](recenter-playhead@transport#lock) on (`C`), the view follows the playhead during playback and manual scrolling is disabled. Zoom level itself is saved per project."; },
  },

  spectrogramSettings: {
    get p1() { return getOverride('help.spectrogramSettings.p1') ?? "The [gear at the right of the toolbar](spectrogram-settings) opens the display settings. They change only how the spectrogram is drawn — never the audio, the annotations, or the file on disk — and they're saved per project."; },
    get h_range() { return getOverride('help.spectrogramSettings.h_range') ?? "Dynamic range"; },
    get p_range() { return getOverride('help.spectrogramSettings.p_range') ?? "**Floor** and **Ceil** (in dBFS) set the window of loudness the color ramp spans. Anything at or below Floor is black; anything at or above Ceil is fully saturated. Drag Floor toward −140 to lift faint detail out of the noise floor, or toward 0 to crush it away and leave only the loud events. This is the control worth reaching for first when a recording looks like an undifferentiated wash. A small reset arrow sits inside each field once it's moved off its default (−100 Floor, 0 Ceil)."; },
    get h_freq() { return getOverride('help.spectrogramSettings.h_freq') ?? "Frequency range"; },
    get p_freq() { return getOverride('help.spectrogramSettings.p_freq') ?? "**Min** and **Max** clip the vertical axis to a band of interest, giving the frequencies you care about the full height of the panel. Useful for narrowing onto a species' band, or for cutting off the empty top half of a recording sampled far above its content."; },
    get h_fft() { return getOverride('help.spectrogramSettings.h_fft') ?? "FFT window & scale"; },
    get p_fft() { return getOverride('help.spectrogramSettings.p_fft') ?? "**Window size** (256 to 8192 samples) is the classic time-versus-frequency trade: a small window resolves clicks and onsets sharply but smears tones into broad bands; a large one resolves pitch finely but blurs anything brief. 1024–2048 suits most work; drop it for percussive detail, raise it for tonal detail."; },
    get p_scale() { return getOverride('help.spectrogramSettings.p_scale') ?? "**Scale** sets how frequency is spaced up the axis. **Linear** gives every hertz equal height. **Log** and **Mel** both expand the low end and compress the high end, which matches how hearing works and how most vocalizations are structured — worth trying whenever the interesting content is bunched against the bottom of a linear plot."; },
    get note_cost() { return getOverride('help.spectrogramSettings.note_cost') ?? "Changing FFT size or scale re-computes the image, so there's a brief redraw on large files. Floor, Ceil, and the frequency range are re-colorings of what's already computed and apply instantly."; },
  },

  debug: {
    get p1() { return getOverride('help.debug.p1') ?? "The **bug icon** in the header opens a running log of what SeeNote has been doing under the hood — which video mode a track opened in, decode and codec errors, audio engine restarts, annotation loads and exports."; },
    get p2() { return getOverride('help.debug.p2') ?? "It's the first place to look when a track behaves oddly: a video that won't display, playback that won't start, or a file that opens blank usually leaves a specific error here rather than an on-screen message."; },
    get note_copy() { return getOverride('help.debug.note_copy') ?? "The copy button takes the whole log to the clipboard — paste it into a bug report. The log covers the current session only and isn't written to disk."; },
  },

  buzzdetect: {
    get p1() { return getOverride('help.buzzdetect.p1') ?? "Set a **buzzdetect directory** under **Advanced** when creating or editing a project to plot per-frame neuron activations below the spectrogram, located per track by ident (`{ident}_buzzdetect.csv`). While a run is still in progress, a `{ident}_buzzpart.csv` is read instead, so the panel fills in as detection proceeds. Toggle the panel with the [activity icon](buzzdetect-toggle) in the **Neurons** section header, in the left sidebar — that section, and the panel it opens, appear whenever the project names a buzzdetect directory."; },
    get h_reading() { return getOverride('help.buzzdetect.h_reading') ?? "Reading the plot"; },
    get p_reading() { return getOverride('help.buzzdetect.p_reading') ?? "Each neuron is one colored line; its dots are filled where the value meets that neuron's threshold and open below it (and always open where the neuron has no threshold set). Which neurons are plotted, and how, is the **Neurons** palette in the left sidebar.\n\nEvery neuron in the file gets a row there, and clicking a row's **color dot** starts or stops plotting that neuron — only the dot, so a click on the rest of the row never changes what's drawn. A hollow dot is a neuron that isn't plotted, and those sink to the bottom of the list, keeping their color and thresholds so switching one back on restores what it was. The **All** / **None** links by the header do the same to every neuron at once. Each row shows the neuron's color, its name, and its two thresholds, editable in place: **Subset at** (in red) and **Detection at**. Filling in Subset at is what [subsets](@subset) the track to that neuron; clearing it stops. Leaving **Detection at** blank means the neuron never detects anything — its dots all draw open, and it keeps nothing in a detection-rate subset. Right-clicking a row holds the rest: **Pin** it to the top of the list, **Isolate** it, **Color…** for a swatch row and full hex picker, and plotting on or off.\n\n**Isolate** fades every other line back rather than removing it, so the isolated neurons read alone while the others stay as context. Isolate as many as you like — comparing two or three against the rest is the usual reason to — and **Stop isolating** (same menu) takes one back out. It changes nothing else: the faded neurons come back exactly as they were, and ones you had switched off stay off. Isolating a neuron that isn't plotted plots it. Once anything is isolated, the [isolate button](buzzdetect-isolate-toggle) appears in the **Neurons** section header: one switch for the whole fade, so you can drop back to the full graph and return to your isolated set without rebuilding it. It's a way of looking, not a setting — none of it is saved with the project.\n\nThe **gear** button in the palette header holds what applies to the whole graph: the **activation** or **detection rate** series (the percentage of frames in each bin clearing the threshold), the bin width used to group frames into each plotted point (auto-calculated to keep the line readable at any zoom; type over it to pin a value — never below the file's frame hop — or click the reset arrow to recalculate), and the Y-axis range (same auto/override/reset pattern). The series choice and a pinned bin width are saved with the project and stay put as you switch tracks; the Y range starts fresh on each track, and switching series resets both."; },
    get h_frames() { return getOverride('help.buzzdetect.h_frames') ?? "Frame length"; },
    get p_frames() { return getOverride('help.buzzdetect.p_frames') ?? "Two numbers describe the frames, and only one of them is in the CSV. The **frame hop** — how far apart the rows sit — is always read from the CSV's start times. The **frame length** — how much audio each row actually describes — cannot be, so set it under **Advanced → buzzdetect** in project settings and it is used for every file. Leave it blank to assume frames are as long as they are far apart.\n\nA length shorter than the hop leaves gaps between frames: the plot shows each frame's true extent, and clicking in a gap selects nothing. A length **longer** than the hop means the frames overlap — buzzdetect run with `framelength 3, framehop 0.96` gives rows 0.96s apart that each speak for 3s of audio — and each frame's extent, its selection, and the audio a [subset](@subset) keeps around it all stretch to match. The length never changes how frames are grouped for plotting or judging; that is the bin width's job."; },
    get h_interact() { return getOverride('help.buzzdetect.h_interact') ?? "Clicking & dragging"; },
    get p_interact() { return getOverride('help.buzzdetect.p_interact') ?? "Hovering highlights the unit under the cursor — a single frame while frames are individually visible, otherwise the whole bin — and clicking and dragging work on that same unit. **Click** one to move the playhead to its start and select it (highlighting that audio on the spectrogram); **drag** across the panel to extend the selection, which always snaps to whole units. **Shift+click** extends the current selection to also cover the clicked unit. One exception: where units are drawn only a pixel or two wide — zoomed far out, whether that's tiny frames or bins — a click only moves the playhead, since the unit under the cursor is too small to have been aimed at. Selecting there takes a drag (move a short distance, or hold the button down for a moment and then move). Drag the panel's top edge to resize it. The readout in the top-left corner is headed **Time** for the span shown and either **Activations** for a single frame or **Mean Activations** where it is summarizing a bin, with the per-neuron values under each. Bring the cursor near one neuron's point and the readout narrows to that neuron alone — the nearest line wins where several run together — so a crowded plot can be read one neuron at a time; move away from every line and it lists them all again."; },
    get h_zoom() { return getOverride('help.buzzdetect.h_zoom') ?? "Frames vs. bins"; },
    get note_subset() { return getOverride('help.buzzdetect.note_subset') ?? "The panel can also drive the time axis itself: give a neuron a **Subset at** value and the track collapses to only the stretches where it reached it. See [Subset to detections](@subset)."; },
    get p_zoom() { return getOverride('help.buzzdetect.p_zoom') ?? "Zoom out far enough and individual frames stop being distinguishable: the dots drop away, several frames are grouped into each plotted point, and hovering, clicking and dragging switch from single frames to whole bins — the highlight, readout and selection all cover the bin the frames were grouped into. While frames _are_ individually visible, a detection rate is a per-frame yes/no rather than a percentage — the Y axis is pinned to a single **Detection** label at the top (your Y-range override doesn't apply), and the readout reads **Detection** / **No Detection** per neuron."; },
  },

  subset: {
    get p1() { return getOverride('help.subset.p1') ?? "A subset collapses the track to only the time your chosen neurons fired. The stretches in between are removed from the time axis outright rather than dimmed, so the detections sit end to end and playback runs straight through them — as if you had extracted them into a new file. Toggle it with the [scissors button](buzzdetect-subset-toggle) in the **Neurons** section header, or `Shift+S` — one switch for the whole cut, on or off."; },

    get h_picking() { return getOverride('help.subset.h_picking') ?? "Choosing what to keep"; },
    get p_picking() { return getOverride('help.subset.p_picking') ?? "Type a value in a neuron's **Subset at** box in the **Neurons** palette and the track collapses to where that neuron reached it; the box takes the accent colour while it's cutting. Clear it to stop. Fill in several to keep time where **any** of them reached its own value.\n\nSubset at is deliberately separate from **Detection at** beside it: the detection threshold only says which dots the graph draws filled and where the dashed line sits, so setting Subset at lower keeps the audio around each detection while the graph still marks detections strictly.\n\nEvery picked neuron is listed under **Subset to detections** in the palette's **gear** settings, each with an × to drop it — a neuron can be cutting while not plotted, and a pick can name a neuron this track's results don't contain at all, so that list is where to look when the cut is keyed to something with no row on screen. Picks are saved per project and matched to the CSV by column name, so a track scored by a different model may carry picks it has no column for; those are struck through and ignored for that track rather than cutting it down to nothing, and come back when you return to a track that has them. Your values survive turning the subset off and on, and are saved with the project.\n\nUnder **Subset to detections** in the palette's **gear** settings, a readout says what the cut came to: how much audio it kept out of the file's length, over how many separate regions, holding how many activation frames. That's the number to steer by while dragging a threshold — a cut that leaves four seconds of the night is usually a threshold set too high."; },
    get p_bins() { return getOverride('help.subset.p_bins') ?? "A subset keeps whole **bins**, never single frames: a bin is kept at its own nominal edges or not at all. In **activation** mode a bin is kept when any picked neuron's **mean** activation across it clears that neuron's threshold; in **detection rate** mode there is no second threshold — a neuron's box becomes a plain scissors that only picks it — and a bin is kept when at least the **Min detection rate** fraction of its frames individually clear that neuron's *detection* threshold. A neuron with no detection threshold set never clears one, so a detection-rate cut keyed to it alone keeps nothing. Either way the bin is the **pinned** bin width — the auto width follows the zoom, and subsetting by it would silently redefine the subset every time you moved the view — so pin a width first. With none pinned, the file's own frame hop is used, where a bin is just one frame.\n\nWhen frames are longer than the hop, a kept bin also carries the audio its last frames reach past the bin's edge, so raising the [frame length](@buzzdetect) widens every kept region.\n\n**Buffer**, in the same settings block, adds that many seconds to **each side** of every kept region. It applies in activation mode only, where a kept bin is a single frame; a detection rate is already a summary over a bin you sized yourself, so widening it by some other amount would blur that boundary. It — context around a detection, so what you hear is identifiable as the thing it is rather than a clipped fragment. It changes what the cut keeps, never what counted as a detection. Buffers that run into each other merge, so a run of near-misses stays one stretch."; },
    get note_try() { return getOverride('help.subset.note_try') ?? "The example panel below is the real buzzdetect panel, drawn over synthetic activations — the same drawing, hit-testing and readouts you get on a track."; },

    get h_reading() { return getOverride('help.subset.h_reading') ?? "Reading a subset track"; },
    get p_segments() { return getOverride('help.subset.p_segments') ?? "Contiguous detections merge into one **segment**, so a run of frames reads — and selects — as a single stretch of audio. The seam where one segment is spliced to the next is drawn as a dashed gold line, on the spectrogram and the buzzdetect panel alike, so a cut never passes for continuous audio. Zoomed far enough out that the segments themselves are a pixel or two wide, the seams stop being drawn — they would merge into a solid gold wall that only repeats what the axis already says. The panel also stops connecting its points across a seam: neighbouring segments can be far apart in the file, and a line between them would draw a trend across time that has been removed."; },
    get p_ruler() { return getOverride('help.subset.p_ruler') ?? "The ruler puts one tick at each segment's start, labelled with the time that segment begins at **in the file**. The label is left-aligned to its tick rather than centered on it, so it clearly describes the segment starting there rather than spanning both sides of the cut, and no tick ever lands mid-segment."; },

    get h_times() { return getOverride('help.subset.h_times') ?? "Every time is still a file time"; },
    get p_times() { return getOverride('help.subset.p_times') ?? "Playback runs on the subset's own timeline, but **every time you read is a position in the source file** — the ruler, the [running time](current-time@time-display), the selection [from / to fields](selection-time@time-display), and the panel's readout. Typing a time in works in file time too; if the time you type was cut out of the subset, it goes to the nearest kept moment."; },
    get p_annotations() { return getOverride('help.subset.p_annotations') ?? "Annotations are stored against real positions in the source file throughout, so annotating a subset track and annotating the whole file produce identical annotation files. Existing annotations that fall in cut-out time are simply not drawn, and are left untouched."; },

    get h_limits() { return getOverride('help.subset.h_limits') ?? "What a cut stops"; },
    get li_cross() { return getOverride('help.subset.li_cross') ?? "**Nothing crosses a seam.** Two segments that abut on screen are not adjacent in the file, so a selection or an annotation cannot span both — drags stop at the segment edge, on the spectrogram and on the buzzdetect panel."; },
    get li_selectall() { return getOverride('help.subset.li_selectall') ?? "**`{mod}+A` selects the segment** holding the playhead, rather than the whole track."; },
    get li_bins() { return getOverride('help.subset.li_bins') ?? "**Bins are clipped to their segment.** Where a bin is wider than the segment it lands in, its band, its hover highlight and what a click selects all stop at the edge — the time beyond it is a different part of the file."; },
    get li_video() { return getOverride('help.subset.li_video') ?? "**Video is off while subset.** The picture cannot follow a timeline that jumps between distant parts of the file, so video tracks play their audio through the same path audio tracks do. Your video-mode preference is left as you set it and comes back when the subset goes off."; },
  },

  transport: {
    get p1() { return getOverride('help.transport.p1') ?? "The [transport buttons](transport-buttons) let you skip to the start/end of the file, step between annotations, and play/pause. Press `Space` to play or pause from anywhere. `{mod}+←` / `{mod}+→` jump straight to the start/end of the track; `Alt+←` / `Alt+→` step to the previous/next annotation."; },
    get h_lock() { return getOverride('help.transport.h_lock') ?? "Playhead lock"; },
    get p_lock() { return getOverride('help.transport.p_lock') ?? "The [lock playhead button](recenter-playhead) (or `C`) toggles lock mode: when active, the view stays centered on the playhead during playback and you cannot scroll away. Press `C` again to unlock and scroll freely. Holding `Alt`/`Option` suspends the lock for as long as it's held (the icon pales), so alt-dragging annotations doesn't fight the auto-scroll."; },
    get h_volume() { return getOverride('help.transport.h_volume') ?? "Volume"; },
    get p_volume() { return getOverride('help.transport.p_volume') ?? "The [volume slider](volume-control) supports up to 2× gain boost (past center); scroll over it to nudge the level. Press `M` to mute. Right-click it to access **Restart Audio**, which re-initialises the audio engine (useful after an audio device change on Windows). In a narrow window the slider folds behind the mute icon — hover the icon to bring it back."; },
  },

  timeDisplay: {
    get p1() { return getOverride('help.timeDisplay.p1') ?? "The [running time](current-time) shows the playhead position. Click it to type a timestamp and jump directly to that position — enter it as plain seconds (`83.45`), `mm:ss`/`hh:mm:ss`, or hours/minutes/seconds shorthand (`1h10m`, `0h3m01s`). The [Seconds / HMS / Date toggle](time-unit-toggle) beneath it switches how the readout itself is displayed."; },
    get h_selection() { return getOverride('help.timeDisplay.h_selection') ?? "Selection fields"; },
    get p_selection() { return getOverride('help.timeDisplay.p_selection') ?? "The [selection fields](selection-time) show the active selection's start (`from`), end (`to`), and duration (`dur`). Click any field to edit it and nudge the selection boundaries precisely; all the same formats as the running time are accepted, and `dur` also allows a leading `-`. The bounds follow whichever unit is active, but `dur` is an interval rather than a moment, so it stays an elapsed reading in Date mode."; },
    get h_datetime() { return getOverride('help.timeDisplay.h_datetime') ?? "Wall-clock times"; },
    get p_datetime() { return getOverride('help.timeDisplay.p_datetime') ?? "**Date** shows real wall-clock times instead of elapsed ones — in the running time, the selection fields, along the [spectrogram's time axis](@spectrogram), and in the [buzzdetect readout](@buzzdetect). Typing into a time field then accepts a clock time (`23:00`) or a full datetime (`2026-07-31 04:56:00`), and elapsed formats keep working alongside them."; },
    get p_datetimeSource() { return getOverride('help.timeDisplay.p_datetimeSource') ?? "It needs to know when the recording started, which it reads from the filename: set a **Filename Timestamp** pattern in [project settings](@project-settings) (e.g. `YYMMDD_HHMM` for `260731_0456.mp3`) and the **Date** button lights up on every track whose name matches. On a track whose name doesn't match it stays greyed out, and times fall back to whichever of Seconds or HMS you last used — so the choice isn't lost when you step onto a track that can't honour it. Hovering a matching file in the [file tree](@files) also shows its decoded start time under the filename."; },
    get note_datetime() { return getOverride('help.timeDisplay.note_datetime') ?? "Wall-clock times are read in your machine's local timezone, and the offset in force at the recording's start is assumed to hold for its whole length — a recording spanning a daylight-saving change reads an hour off after the transition."; },
  },

  speed: {
    get p1() { return getOverride('help.speed.p1') ?? "The [speed readout](playback-speed) is a click-to-type entry box; scroll over it to nudge the value. Speed ranges between `0.25x` and `4.0x`. Pitch is preserved, so slowing audio down to inspect a transient won't drop it into a different octave. Click the gauge icon to snap to `1.0x` (or back to your last speed). It's the first control to fold in a narrow window — the gauge stays, and hovering it reveals the entry box."; },
    get note1() { return getOverride('help.speed.note1') ?? "Speed is saved per project. Video tracks follow the audio clock, so frames stay in sync at any speed."; },
  },

  filter: {
    get p1() { return getOverride('help.filter.p1') ?? "Press `Shift+F` (or click the [filter button](filter-tool)) to ready the filter tool — the cursor flips to a horizontal bar. Drag vertically on the spectrogram to draw a band: audio outside the band is attenuated in real time, the out-of-band region darkens, and the filter engages automatically."; },
    get h_tuning() { return getOverride('help.filter.h_tuning') ?? "Tuning the band"; },
    get p_tuning() { return getOverride('help.filter.p_tuning') ?? "Drag the two horizontal cutoff lines to retune the band in place — they're grabbable any time a band is active, even when the filter tool isn't selected. The [strength slider](filter-strength) beside the filter button mixes between dry (0%, source untouched) and fully band-passed (100%). Dragging it up from 0 re-enables filtering at the new strength, restoring the last band you drew. In a narrow window the slider folds behind the filter button — hover the button to bring it back."; },
    get h_toggle() { return getOverride('help.filter.h_toggle') ?? "Toggling filtering"; },
    get p_toggle() { return getOverride('help.filter.p_toggle') ?? "**F toggles filtering on/off**, saving and restoring the last defined band — just like `Z` for [video zoom](@video-zoom). If you've never drawn a band, F engages a default 500 Hz–4 kHz band at 50% so you can hear something immediately and refine from there. Tool readiness (`Shift+F`) is independent: a drawn band keeps filtering even after the tool is unreadied."; },
    get p_esc() { return getOverride('help.filter.p_esc') ?? "`Esc` unwinds the most recent layer: first the band (and filtering), then the filter tool itself, then selection, then the annotation tool — in the order you turned them on."; },
    get note_persist() { return getOverride('help.filter.note_persist') ?? "**Persistence:** the band cutoffs and strength are saved into the project file. The source audio is never modified and the spectrogram is not recomputed."; },
  },

  modes: {
    get li1() { return getOverride('help.modes.li1') ?? "**Selection Mode** (press `S` to enter — [see palette](tool-palette)): left-click & drag creates a _selection region_. Playback is bounded to that region. While a selection is active, pressing a tool key (`0`–`9`) drops an annotation onto it."; },
    get li_shift() { return getOverride('help.modes.li_shift') ?? "**From the playhead:** hold `Shift` and click to select from the playhead to the click, or hold `Shift` and press `←`/`→` to draw a selection out of the playhead — a pixel per tap, accelerating while the key is held (`{mod}+Shift+←`/`→` runs it to the start or end of the track). With a selection already up, the same keys nudge its end and leave the playhead where it is. If the selection is [bound to an annotation](@editing), the annotation is resized with it, and the whole run counts as one undo step."; },
    get li_sweep() { return getOverride('help.modes.li_sweep') ?? "**While listening:** hold `Shift` during playback to mark out what you're hearing. The press drops the start, the playhead carries the end — a dotted line runs down the middle of the span as it grows, as it does for any selection — and letting go commits it: an annotation if a tool is readied (previewed with its name as it grows), a selection otherwise, exactly as the same span drawn with the mouse would be. Playback stops there unless you're also holding `Alt`/`Option`, which keeps it rolling and, for an annotation, drops it quietly. A quick tap of `Shift` does nothing, so the key stays safe to lean on, and the gesture is only offered when nothing is selected yet."; },
    get li2() { return getOverride('help.modes.li2') ?? "**Annotation Tool Mode** (a tool is active): left-click & drag directly creates an annotation. Press a number key to switch tools, or `S` to return to Selection Mode."; },
    get note1() { return getOverride('help.modes.note1') ?? "A selection that overlaps an annotation pops that annotation's name to the selection's start, so the label stays next to where you're looking. If there's no room before the annotation's right edge, the name right-justifies against it instead."; },
    get note2() { return getOverride('help.modes.note2') ?? "`Esc` is the universal undo-layer key: it pops the most recently activated layer (band, filter-tool, selection, annotation tool) in the reverse order you turned them on."; },
  },

  creating: {
    get li1() { return getOverride('help.creating.li1') ?? "**From scratch:** activate a tool, then drag on the spectrogram."; },
    get li2() { return getOverride('help.creating.li2') ?? "**From selection:** make a selection region, then press a tool key (`0`–`9`)."; },
    get li3() { return getOverride('help.creating.li3') ?? "**Whole track:** with a tool active, press `{mod}+A` to annotate the entire track (with no tool active it selects the whole track instead)."; },
    get li4() { return getOverride('help.creating.li4') ?? "**While listening:** hold `Alt`/`Option` and drag to annotate without moving the playhead or changing the selection — playback keeps rolling and playhead lock is suspended, so you can mark sounds as you hear them. With the Custom tool it still opens the name field for you to type into. With no tool active the same Alt-drag lays down a plain selection, again without disturbing playback."; },
    get li_sweep() { return getOverride('help.creating.li_sweep') ?? "**Hands off the mouse:** with a tool readied, hold `Shift` during playback and let go where the sound ends — the annotation is dropped over what you just heard. See [Selection vs. Tool mode](@modes)."; },
    get li_copy() { return getOverride('help.creating.li_copy') ?? "**Copy & paste:** `{mod}+C` copies the selected annotation's label and length; `{mod}+V` drops a fresh copy starting at the playhead, trimmed to the end of the track (or of the current segment under a subset) if it would overrun."; },
  },

  editing: {
    get li1() { return getOverride('help.editing.li1') ?? "**Resize:** drag the left or right edge handle."; },
    get li2() { return getOverride('help.editing.li2') ?? "**Bound selection:** click the center of an annotation to bind the playhead loop to it. Use `Alt+←` / `Alt+→` to jump between annotations."; },
    get li3() { return getOverride('help.editing.li3') ?? "**Rename:** hover an annotation and click the pencil icon to edit inline. Custom tool annotations open for editing automatically. An annotation left with no name stays on screen so a stray click can't destroy it, but it is never saved — leave the track and it's gone. Typing a partial label pops a dropdown of matching tool names — arrow-key down into it (or click) to adopt that tool's label and color, or just press Enter to keep what you typed as a one-off Custom label."; },
    get li4() { return getOverride('help.editing.li4') ?? "**Delete:** select an annotation and press `Delete` / `Backspace`, or middle-click it directly."; },
    get li5() { return getOverride('help.editing.li5') ?? "**Undo/Redo:** `{mod}+Z` / `{mod}+Shift+Z`."; },
    get li6() { return getOverride('help.editing.li6') ?? "**Right-click an annotation** for **Bind to hotkey** (matches its label to an existing tool, or creates one, on the next free hotkey digit — greyed out once all nine are taken or the label already has one; `{mod}+B` does the same for the selected annotation, and also readies the bound tool) and **Copy annotation** (copies `label (start, end)` to the clipboard, times always in seconds). **Listen to example** plays the example clip for the label's tool — the same action as the `E` hotkey, greyed out when the tool has no example clips."; },
  },

  tools: {
    get p1() { return getOverride('help.tools.p1') ?? "Annotation tools are named labels bound to hotkeys `0`–`9`. Key `0` is always the **Custom Tool** — annotations created with it open immediately for you to type a one-off name."; },
    get h_manage() { return getOverride('help.tools.h_manage') ?? "Managing tools"; },
    get p_manage() { return getOverride('help.tools.p_manage') ?? "Open [Annotation Tool Settings](tool-palette) (gear icon) to manage tools: drag tools between hotkey slots and the Unassigned bin, click a tool's gear to edit its label and color, or hover a tool and click the trash icon to delete it (deletes are undoable). Type into an empty hotkey slot's **Add tool** field to assign an existing tool by name (pick it from the dropdown) or, if the name is new, open the editor to create a tool on that key; in the Unassigned bin, click **New tool** to create one directly. In the **Labels** palette itself, middle-click a hotkey chip to free its slot (the tool is kept, just unassigned), and while any of the nine slots is open an **Add tool** field sits below the list — type to pick an existing tool from the dropdown (arrow keys + Enter, or click; assigned to the next free key) or, for a new name, open the editor to create one. Either way the tool is readied for use as soon as it lands on a key. Annotations are linked to a tool by their label, so creating or renaming a tool to match a label instantly adopts every annotation carrying it — across all tracks. Tool configuration is saved per project: each tool is a folder under the project's **.seenote/annotation-tools/** directory, which can also hold example audio clips for that label."; },
    get note_undo() { return getOverride('help.tools.note_undo') ?? "Inside Annotation Tool Settings, `{mod}+Z` / `{mod}+Shift+Z` undo and redo the last tool change."; },
    get h_examples() { return getOverride('help.tools.h_examples') ?? "Example clips"; },
    get p_examples1() { return getOverride('help.tools.p_examples1') ?? "To bulk-import examples: the **Import examples** button in Annotation Tool Settings takes a directory of one folder per label holding audio clips, copying the clips in and creating tools for new labels."; },
    get p_examples2() { return getOverride('help.tools.p_examples2') ?? "To add examples to a single tool, edit it (gear icon) and use the **Files…** or **Folder…** buttons under Example clips. Folders are searched recursively; clips are copied into that tool's examples/ and existing filenames are skipped."; },
    get p_examples3() { return getOverride('help.tools.p_examples3') ?? "Once a tool has example clips, a **play** button appears on its chip (in the palette and in Annotation Tool Settings) — press it to audition the clips, cycling to the next clip on each press. To browse all of a tool's clips with their spectrograms, right-click the tool and choose **Show examples** (or use the **View** button in the tool editor). The library is read-only and its spectrogram settings don't affect the project. Inside it, `Space` plays/pauses the selected clip, the spectrogram has full time/frequency axes, the frequency range defaults to the clip's full band, and right-clicking a clip reveals it in Finder / File Explorer. Example playback is loudness-normalized (with a volume slider) so quiet and loud clips audition at a comparable level. While any example is sounding, the main track's audio is paused so the two never overlap."; },
  },

  bulk: {
    get p_rename() { return getOverride('help.bulk.p_rename') ?? "`{mod}+F`, or the **Find Label** ([magnifying glass](tool-palette)) icon next to the [gear](tool-palette), open the **Find & Rename Label** dialog — searching and bulk-renaming annotations by their text directly, without needing a matching tool. Type a label to search; **Whole project** (the default) scans every file, streaming results in alphabetically by file as it runs, while **Current track** searches only the open track's (unsaved) annotations — this also decides what a rename below applies to. Whole-project results are held in memory once scanned, so refining the query or flipping the toggles below re-filters instantly instead of re-reading the project. Check **Partial** to match the search text anywhere in a label (e.g. `mech_` matches `quiet_mech_auto`), or **Regex** to search with a regular expression (already unanchored, so `buzz\\d` matches `foo_buzz3_bar`); with either on, results show each match's own label since it may differ from what you typed. Both toggles are remembered per project."; },
    get h_find() { return getOverride('help.bulk.h_find') ?? "Finding a match"; },
    get p_find() { return getOverride('help.bulk.p_find') ?? "Expand a file in the results to see each match's start/end time, select one, and click **Go** to open that file, scroll the spectrogram to it, and select the annotation — the same as clicking it directly, with an active selection bound around it, ready to edit, resize, or delete."; },
    get h_rename() { return getOverride('help.bulk.h_rename') ?? "Renaming matches"; },
    get p_rename2() { return getOverride('help.bulk.p_rename2') ?? "Type a replacement label under **Rename matches** and click **Rename All** to rename every annotation the search currently matches — current track only, or across the whole project, per the scope chosen above. A confirmation shows how many annotations were renamed and across how many recordings."; },
  },

  importing: {
    get p1() { return getOverride('help.importing.p1') ?? "Right-click a track in the [file panel](file-panel@file-panel) and choose **Import annotations…** to bring in labels from an external file. They're filed under that track's ident, exactly as if you'd drawn them."; },
    get h_conflict() { return getOverride('help.importing.h_conflict') ?? "If the track already has annotations"; },
    get p_conflict() { return getOverride('help.importing.p_conflict') ?? "You're asked which you want: **Overwrite** replaces the existing set with the imported one, **Merge** keeps both, appending the imported annotations to what's there. Merge is the safe default when you're combining passes from different people or different detectors."; },
    get h_format() { return getOverride('help.importing.h_format') ?? "What can be imported"; },
    get p_format() { return getOverride('help.importing.p_format') ?? "Tab-delimited label files in Audacity's format — one row per annotation, `start`, `end`, `label` — which is the same format SeeNote writes. Rows are matched against your annotation tools by label, so an imported label that matches a tool picks up that tool's color; anything unmatched comes in as a Custom annotation."; },
    get note_bulk() { return getOverride('help.importing.note_bulk') ?? "Import is per-track. To bring a whole detector run into a project, import each track, or drop the label files into the annotation directory yourself — the layout is documented under [Annotation files & idents](@files)."; },
  },

  projectSettings: {
    get p1() { return getOverride('help.projectSettings.p1') ?? "The [gear beside the project name](project-settings-btn) opens project settings. The same form appears when you create a project."; },
    get h_settings() { return getOverride('help.projectSettings.h_settings') ?? "Settings tab"; },
    get p_settings() { return getOverride('help.projectSettings.p_settings') ?? "The project's **name** (and its color gradient), its **Media** and **Annotations** directories, and **Output Decimal Places** — how many decimals timestamps are written with in annotation files. **Filename Timestamp** declares the timestamp pattern your filenames carry (`YYYY`/`YY`, `MM`, `DD`, `HH`, `mm`, `ss`, everything else literal) — that's what unlocks wall-clock [Date mode](@time-display). If your recorder also stamps an elapsed-seconds offset (e.g. `..._s52860.mp3`), set **Offset Separator** to that marker (e.g. `_s`) and the digits up to the extension are added as seconds on top of the parsed time. Under **Advanced** sit the **buzzdetect** directory and frame length; under **Sync**, the repository URL, access token, and your annotator name."; },
    get h_prefs() { return getOverride('help.projectSettings.h_prefs') ?? "Preferences tab"; },
    get p_prefs() { return getOverride('help.projectSettings.p_prefs') ?? "**Automatically pull remote changes** governs background pulls when syncing is set up — see [Sync (GitHub)](@sync). **Datetime Format** picks how wall-clock times are written — `ISO 8601` (`2026-07-31 16:56:04`) or `Friendly` (`July 31, 4:56:04p`) — wherever [Date mode](@time-display) is showing them."; },
    get h_moving() { return getOverride('help.projectSettings.h_moving') ?? "Changing the annotation directory"; },
    get p_moving() { return getOverride('help.projectSettings.p_moving') ?? "Point the project at a different annotation directory and SeeNote offers to **copy** your existing annotation files across, asking how to resolve any that already exist there (**Skip Existing** or **Overwrite**). Annotation files with no matching media in the new directory — **orphaned** ones — are simply left where they are. SeeNote never deletes annotations because their recording is absent: the audio may just have been moved or offloaded to save disk space, and the labels are the part you can't re-record."; },
    get note_where() { return getOverride('help.projectSettings.note_where') ?? "Settings are stored in the project's **.seenote/** folder — `settings.json` for the project itself, `preferences.json` for your local preferences. Neither is ever pushed by a sync."; },
  },

  repair: {
    get p1() { return getOverride('help.repair.p1') ?? "Recordings get moved, drives get remounted somewhere else, projects get copied between machines. SeeNote handles both halves of that without you having to edit anything by hand."; },
    get h_media() { return getOverride('help.repair.h_media') ?? "The media directory is missing"; },
    get p_media() { return getOverride('help.repair.p_media') ?? "Open a project whose media directory no longer exists and SeeNote says so instead of opening empty, and asks for the new path. Choose the folder and **Save & Open** — the project's setting is updated and it opens straight away. Annotations are untouched throughout; they're keyed by ident, not by absolute path, so they re-attach to the same recordings at the new location."; },
    get h_project() { return getOverride('help.repair.h_project') ?? "The project folder itself has moved"; },
    get p_project() { return getOverride('help.repair.p_project') ?? "On the launch screen, a project whose folder can't be found is greyed out with a **Locate** button. Point it at the folder's new home: SeeNote checks what's actually there and shows you what it found and what it didn't before committing. The folder must contain a `.seenote/settings.json`; a missing annotation or buzzdetect directory, or a project name that disagrees with the one on disk, only prompts for confirmation — and where the names differ, you pick which one to keep."; },
    get note_portable() { return getOverride('help.repair.note_portable') ?? "Projects whose directories are stored as relative paths survive a move with no repair at all. That's the payoff for keeping media and annotations inside the project folder — see [Projects](@projects)."; },
  },

  files: {
    get p1() { return getOverride('help.files.p1') ?? "Annotations save automatically every time you make a change. There's no save step and no unsaved state to lose."; },
    get h_layout() { return getOverride('help.files.h_layout') ?? "Where things land"; },
    get p_layout() { return getOverride('help.files.p_layout') ?? "The annotation directory mirrors the media directory's folder structure. A recording at `media/site_a/dawn.wav` gets its annotations at `annotations/site_a/dawn.txt` — same relative path, different extension. That shared path-without-extension is the recording's **ident**, and it's the only link between the two; nothing depends on absolute paths, which is what lets a project be moved or shared."; },
    get p_delete() { return getOverride('help.files.p_delete') ?? "Removing a track's last annotation deletes its annotation file rather than leaving an empty one behind, so the presence of a file always means the track has been labelled."; },
    get h_format() { return getOverride('help.files.h_format') ?? "File format"; },
    get p_format() { return getOverride('help.files.p_format') ?? "Plain UTF-8 text, one annotation per line, three tab-separated fields: **start time**, **end time**, **label**. Lines are ordered by start time. Times are in seconds, written to as many decimals as **Output Decimal Places** in project settings specifies — though an annotation that came from an existing file and hasn't been moved or relabelled keeps whatever precision it was written with, so saving never rewrites rows you didn't touch. This is Audacity's label format — Audacity and most analysis toolchains read it directly, and it needs no conversion to feed a training pipeline."; },
    get h_seenote() { return getOverride('help.files.h_seenote') ?? "The .seenote folder"; },
    get p_seenote() { return getOverride('help.files.p_seenote') ?? "Each project folder holds a hidden **.seenote/** directory: `settings.json` (the project), `preferences.json` (your local preferences, including a plaintext sync token if you chose that), and **annotation-tools/**, one folder per tool holding its definition and any example clips. None of it is shared by a sync — every collaborator keeps their own tools and settings."; },
  },

  sync: {
    get p1() { return getOverride('help.sync.p1') ?? "Add a **repository URL**, **access token**, and **your name** under **Project Settings → Sync** to share annotations with collaborators through a private GitHub repo. A **refresh icon** then appears in the toolbar; click it to sync, or right-click it for **View GitHub repo** to open the repository in your browser. The **chevron** beside it opens a box for a custom **commit message** (otherwise the commit is labeled \"Update annotations\")."; },
    get h_merging() { return getOverride('help.sync.h_merging') ?? "How merging works"; },
    get p_merging() { return getOverride('help.sync.p_merging') ?? "Each sync uploads your annotation edits and pulls in everyone else's. Annotations merge automatically — two people labeling the same recording keep **both** sets; only a deliberate deletion removes a label. A summary shows what changed. Your name is recorded as the author of your edits. The file tree refreshes automatically after a sync pulls changes, so newly-annotated recordings light up."; },
    get h_clearing() { return getOverride('help.sync.h_clearing') ?? "Emptying a track"; },
    get p_clearing() { return getOverride('help.sync.p_clearing') ?? "Removing every annotation from a track deletes those labels for **everyone** on the next sync, so it is the one change SeeNote never makes on your behalf. When a sync finds tracks that are now empty, it lists them and asks before committing — choose **Commit** to clear them for the whole team, or **Not now** to leave them alone and be asked again next time. The background auto-pull never commits a clear at all. Annotation files are only ever emptied, never deleted, so a file that goes missing is treated as unknown and changes nothing for anybody."; },
    get h_shared() { return getOverride('help.sync.h_shared') ?? "What gets shared"; },
    get p_shared() { return getOverride('help.sync.p_shared') ?? "Only your annotation files are shared. Media, your annotation tools, and your local settings (including the token) are **never** uploaded — each labeler keeps their own tools. The annotation directory must live inside the project folder."; },
    get h_token() { return getOverride('help.sync.h_token') ?? "Token storage"; },
    get p_token() { return getOverride('help.sync.p_token') ?? "Your token is stored on this machine only. Under **Token storage** you can keep it in the **OS keychain** (recommended) or switch to **plaintext**, saved unencrypted in the project's settings.json (still never pushed). Plaintext trades local secrecy for avoiding keychain password prompts on unsigned builds."; },
    get h_autopull() { return getOverride('help.sync.h_autopull') ?? "Automatic pulls"; },
    get p_autopull() { return getOverride('help.sync.p_autopull') ?? "Remote changes are **pulled in automatically** — on project open and every couple of minutes — so you're never editing behind teammates' latest annotations. This never pushes your own edits; that stays an explicit sync. Turn it off under **Project Settings → Preferences → Automatically pull remote changes** if you'd rather pull manually."; },
  },

  troubleshooting: {
    get h_video() { return getOverride('help.troubleshooting.h_video') ?? "\"Can't display this video\""; },
    get p_video() { return getOverride('help.troubleshooting.p_video') ?? "In **Accurate** mode this means your system lacks a codec for that file. In **Fast** or **Mixed** mode on Linux it's usually a platform limitation rather than a missing codec — switch to Accurate and it will often play. Either way, the [debug console](toolbar@debug) records the specific decode error."; },
    get h_stutter() { return getOverride('help.troubleshooting.h_stutter') ?? "Playback or scrubbing stutters"; },
    get p_stutter() { return getOverride('help.troubleshooting.p_stutter') ?? "Drop the video mode one level (Accurate → Mixed → Fast → Off); frame-accurate decoding is by far the most expensive thing SeeNote does. Collapsing the video pane, turning off the buzzdetect panel, and zooming out less far all help too. Long files on slow external drives are worst on first pass, since every region has to be decoded once before it's cached."; },
    get h_audio() { return getOverride('help.troubleshooting.h_audio') ?? "Audio stops working after changing devices"; },
    get p_audio() { return getOverride('help.troubleshooting.p_audio') ?? "Right-click the [volume control](volume-control@transport#volume) and choose **Restart Audio**. Switching output device — plugging in headphones, especially on Windows — can leave the audio engine bound to the device that went away; restarting re-binds it without reopening the track."; },
    get h_keychain() { return getOverride('help.troubleshooting.h_keychain') ?? "Repeated keychain password prompts"; },
    get p_keychain() { return getOverride('help.troubleshooting.p_keychain') ?? "Unsigned builds can prompt every time the sync token is read from the OS keychain. Switching **Token storage** to plaintext under [Project Settings → Sync](project-settings-btn@project-settings#settings-tab) stops the prompts, at the cost of the token sitting unencrypted in the project's `preferences.json`. It's still never pushed to the repository — but use a narrowly-scoped token if you take that trade."; },
    get h_buzz() { return getOverride('help.troubleshooting.h_buzz') ?? "The buzzdetect panel is empty"; },
    get p_buzz() { return getOverride('help.troubleshooting.p_buzz') ?? "Activations are looked up by ident: a track with ident `site_a/dawn` needs `site_a/dawn_buzzdetect.csv` in the configured buzzdetect directory. A mismatched folder structure or a missing `_buzzdetect` suffix is the usual cause. If the panel plots but the frames look wrong, set an explicit **frame length** — the CSV can only reveal the hop, and auto-detecting even that needs enough rows."; },
    get h_missing() { return getOverride('help.troubleshooting.h_missing') ?? "A project or its media has gone missing"; },
    get p_missing() { return getOverride('help.troubleshooting.p_missing') ?? "See [When files move](@repair) — both a moved project folder and a moved media directory are recoverable without touching anything by hand, and annotations survive either."; },
    get h_logs() { return getOverride('help.troubleshooting.h_logs') ?? "Reporting a problem"; },
    get p_logs() { return getOverride('help.troubleshooting.p_logs') ?? "Open the [debug console](toolbar@debug), copy the log, and include it. It usually contains the exact failure — which is much more use than a description of the symptom."; },
  },
};
