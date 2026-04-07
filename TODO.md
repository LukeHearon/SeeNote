# Labels
Projects should default to the following labels
1. ins_buzz_high
2. ins_buzz_medium
3. ins_buzz_low
4. ambient_scraping
5. ambient_rustle
6. ambient_bang
7. ins_trill_cicada
8. ins_trill_cricket

- The labels should be editable

Add qualifiers for buzzes, modified with keys

# Annotations
Opening an audio file should automatically open any corresponding annotations from the annotations dir

# Audio file navigation
When opening a new audio file, reset the playhead to 0s.
Currently if the playhead is at 30s in one file, it will be at 30s when moving to the next file.
Add "Show File in Finder"/"Show File in File Explorer" right click on folders (including the audio dir at top) or audio files in the navigation pane. Also add "Show Annotations" for the same, which opens file browser to the annotations file instead.
Add a note icon with a number inside for each audio file, indicating how many annotations have been made. No icon if no annotations have been made.

# Spectrogram pane
Default to mel bins
Add spectrogram bin window size option, a dropdown of powers of 2 (256, 8192) default to 2048
- remove existing Window Size (Zoom) option; that can just be controlled by the user's mouse
Use decimal seconds on timeline when zoomed in so far that dividers split individual seconds; otherwise use whole numbers


# Projects
Make spectrogram settings persistent within a project. Should be the same as I navigate files, same when re-opening an old project.
- but leave the settings accessible from the gear icon in the spectrogram pane, do not move to project settings

Make custom labels persistent within a project

I can't see recent projects when I `npm run tauri dev`, the splash screen always shows no projects.
Is that an issue or would that change when we package it?

