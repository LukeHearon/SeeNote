# Debug Instructions — Intel Mac Video Playback

You are running a diagnostic build of SeeNote (branch: `debug`). The goal is to isolate why video freezes in Fast mode and why selection playback fails in Mixed mode. Each test run takes about 2 minutes. You will save the debug log from each run as a `.txt` file in this folder (`debug_video/`).

---

## Before You Start

- Build and run the app from the `debug` branch.
- Use the **same MP4 file** for every run. Pick a file that reliably shows the freeze.
- The debug console is opened with the **Bug icon** (top toolbar). It has a **Copy** button (clipboard icon) in the top-right of the console window.
- **Restart the app between every run** so the log is clean for each test.

---

## Run 1 — Fast Mode Baseline

*No toggles. Establishes what the failure looks like normally.*

1. Open the app fresh (restart if needed).
2. Load your test MP4 file.
3. Open the Debug Console. Confirm it says "No logs yet."
4. In the Video pane (bottom-left corner picker), select **Fast** mode.
5. Press **Space** to play.
6. Wait at least **30 seconds** after the video picture freezes. Do not stop playback. Let audio and the spectrogram continue.
7. Press **Space** to stop.
8. Open the Debug Console. Click **Copy**.
9. Paste into a new text file. Save it as:
   ```
   debug_video/run_01_fast_baseline.txt
   ```

---

## Run 2 — Fast Mode + Blob URL

*Tests whether the Tauri asset protocol is causing the stall.*

1. Restart the app. Load the same MP4.
2. Open the Debug Console.
3. **Enable: Blob URL mode** (checkbox in the Debug Controls section at the top of the console).
4. You should see a log line: `[debug] blob URL created`. Wait for it before proceeding.
5. Select **Fast** mode.
6. Press **Space** to play.
7. Wait **30 seconds** past the point where the freeze normally occurs (or longer if it hasn't frozen yet — wait at least 60 seconds total).
8. Press **Space** to stop.
9. Copy the log. Save as:
   ```
   debug_video/run_02_fast_bloburl.txt
   ```
   **Add a note at the top of the file:** Did the video picture freeze this time? (yes/no, and if no, how long did it play without freezing?)

---

## Run 3 — Fast Mode + Canvas Mirror

*Tests whether WKWebView's native video compositor is the problem.*

1. Restart the app. Load the same MP4.
2. Open the Debug Console.
3. **Enable: Canvas mirror**.
4. Select **Fast** mode.
5. Press **Space** to play.
6. Watch the video pane carefully:
   - Does the **canvas** show moving video frames, or is it also frozen/black?
   - Note at what point (if any) it starts showing frames, and whether it freezes.
7. Wait 30 seconds past the normal freeze point, then stop.
8. Copy the log. Save as:
   ```
   debug_video/run_03_fast_canvasmirror.txt
   ```
   **Add a note at the top of the file:** Did the canvas version show video frames? Did it freeze? When?

---

## Run 4 — Mixed Mode + Selection, Normal Preroll

*Tests selection playback with the default (unmodified) preroll behavior.*

1. Restart the app. Load the same MP4.
2. Open the Debug Console.
3. All toggles **off**, preroll set to **Normal (wait fully)**.
4. Select **Mixed** mode.
5. Click and drag on the spectrogram to draw a selection (any region, at least 5 seconds long).
6. Press **Space** to play the selection.
7. Wait up to **60 seconds**. Note whether audio plays, and whether video plays.
8. If nothing happens after 60 seconds, press **Space** (or Escape) to cancel, then stop.
9. Copy the log. Save as:
   ```
   debug_video/run_04_mixed_selection_normal.txt
   ```
   **Add a note at the top:** Did audio play? Did video play? How long did it take for anything to happen?

---

## Run 5 — Mixed Mode + Selection, Preroll Skipped

*Tests whether the WebCodecs preroll step is blocking playback.*

1. Restart the app. Load the same MP4.
2. Open the Debug Console.
3. **Preroll timeout → Skip**.
4. Select **Mixed** mode.
5. Draw the same selection as Run 4.
6. Press **Space** to play.
7. Wait 10 seconds. Note whether audio plays, and whether video plays.
8. Copy the log. Save as:
   ```
   debug_video/run_05_mixed_selection_skip.txt
   ```
   **Add a note at the top:** Did audio play immediately? Did video show frames?

---

## When You're Done

You should have five files in `debug_video/`:

```
run_01_fast_baseline.txt
run_02_fast_bloburl.txt
run_03_fast_canvasmirror.txt
run_04_mixed_selection_normal.txt
run_05_mixed_selection_skip.txt
```

Share them (or commit the folder). The interpretation instructions and agent prompt are in `debug_video/interpretation.md`.
