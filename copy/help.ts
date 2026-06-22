import { getOverride } from './overrideStore';

export const helpPanel = {
  get panelTitle() { return getOverride('helpPanel.panelTitle') ?? "SeeNote Help"; },
  tabs: {
    get guide() { return getOverride('helpPanel.tabs.guide') ?? "Guide"; },
    get annotations() { return getOverride('helpPanel.tabs.annotations') ?? "Annotations"; },
    get shortcuts() { return getOverride('helpPanel.tabs.shortcuts') ?? "Shortcuts"; },
  },
  guideSections: {
    get projects() { return getOverride('helpPanel.guideSections.projects') ?? "Projects"; },
    get filePanel() { return getOverride('helpPanel.guideSections.filePanel') ?? "File Panel"; },
    get videoMode() { return getOverride('helpPanel.guideSections.videoMode') ?? "Video Mode"; },
    get videoZoom() { return getOverride('helpPanel.guideSections.videoZoom') ?? "Video Zoom"; },
    get spectrogram() { return getOverride('helpPanel.guideSections.spectrogram') ?? "Spectrogram"; },
    get twoModes() { return getOverride('helpPanel.guideSections.twoModes') ?? "Two Modes: Selection vs. Tool"; },
    get transport() { return getOverride('helpPanel.guideSections.transport') ?? "Transport Controls"; },
    get playbackSpeed() { return getOverride('helpPanel.guideSections.playbackSpeed') ?? "Playback Speed"; },
    get bandPassFilter() { return getOverride('helpPanel.guideSections.bandPassFilter') ?? "Band-Pass Filter"; },
    get timeDisplay() { return getOverride('helpPanel.guideSections.timeDisplay') ?? "Time Display"; },
    get autoSave() { return getOverride('helpPanel.guideSections.autoSave') ?? "Auto-save"; },
    get sync() { return getOverride('helpPanel.guideSections.sync') ?? "Sync (GitHub)"; },
    get buzzdetect() { return getOverride('helpPanel.guideSections.buzzdetect') ?? "buzzdetect panel"; },
  },
  annotationSections: {
    get tools() { return getOverride('helpPanel.annotationSections.tools') ?? "Annotation Tools"; },
    get creating() { return getOverride('helpPanel.annotationSections.creating') ?? "Creating Annotations"; },
    get editing() { return getOverride('helpPanel.annotationSections.editing') ?? "Editing Annotations"; },
  },
};
