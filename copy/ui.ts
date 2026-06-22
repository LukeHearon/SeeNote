import { getOverride } from './overrideStore';

export const launchScreen = {
  get appName() { return getOverride('ui.launchScreen.appName') ?? "SeeNote"; },
  get projectsHeading() { return getOverride('ui.launchScreen.projectsHeading') ?? "Projects"; },
  get setupSyncButton() { return getOverride('ui.launchScreen.setupSyncButton') ?? "Set up syncing"; },
  get openExistingButton() { return getOverride('ui.launchScreen.openExistingButton') ?? "Open Existing Project"; },
  get newProjectButton() { return getOverride('ui.launchScreen.newProjectButton') ?? "New Project"; },
  get loadError() { return getOverride('ui.launchScreen.loadError') ?? "Failed to load projects"; },
  get openError() { return getOverride('ui.launchScreen.openError') ?? "Could not open project"; },
  get loadingProjects() { return getOverride('ui.launchScreen.loadingProjects') ?? "Loading projects…"; },
  get noProjects() { return getOverride('ui.launchScreen.noProjects') ?? "No projects yet."; },
  get createFirstProject() { return getOverride('ui.launchScreen.createFirstProject') ?? "Create your first project"; },
  get projectNotFound() { return getOverride('ui.launchScreen.projectNotFound') ?? "(not found)"; },
  get projectSettingsUnreadable() { return getOverride('ui.launchScreen.projectSettingsUnreadable') ?? "(settings unreadable)"; },
  get showDataFolder() { return getOverride('ui.launchScreen.showDataFolder') ?? "Show data folder"; },
  get relinkTitle() { return getOverride('ui.launchScreen.relinkTitle') ?? "Re-link this project?"; },
  get relinkMessage() { return getOverride('ui.launchScreen.relinkMessage') ?? "Here's what's in the folder you selected:"; },
  get statusFound() { return getOverride('ui.launchScreen.statusFound') ?? "found"; },
  get statusMissing() { return getOverride('ui.launchScreen.statusMissing') ?? "missing"; },
  get nameConflictSelected() { return getOverride('ui.launchScreen.nameConflictSelected') ?? "selected"; },
  get nameConflictDiffers() { return getOverride('ui.launchScreen.nameConflictDiffers') ?? "differs"; },
  get locate() { return getOverride('ui.launchScreen.locate') ?? "Locate"; },
  get relinkButton() { return getOverride('ui.launchScreen.relinkButton') ?? "Re-link"; },
  get nameLabel() { return getOverride('ui.launchScreen.nameLabel') ?? "Name"; },
  lastOpened: (dateStr: string) => `Last opened ${dateStr}`,
  showInFileManager: (label: string) => `Show project in ${label}`,
};

export const createProjectModal = {
  get title() { return getOverride('ui.createProjectModal.title') ?? "Create New Project"; },
  get tabSettings() { return getOverride('ui.createProjectModal.tabSettings') ?? "Settings"; },
  get tabPreferences() { return getOverride('ui.createProjectModal.tabPreferences') ?? "Preferences"; },
  get projectDirLabel() { return getOverride('ui.createProjectModal.projectDirLabel') ?? "Project Directory"; },
  get projectDirPlaceholder() { return getOverride('ui.createProjectModal.projectDirPlaceholder') ?? "/path/to/project"; },
  get githubSyncLabel() { return getOverride('ui.createProjectModal.githubSyncLabel') ?? "GitHub Sync"; },
  get errorDirRequired() { return getOverride('ui.createProjectModal.errorDirRequired') ?? "Project directory is required."; },
  get errorNameRequired() { return getOverride('ui.createProjectModal.errorNameRequired') ?? "Project name is required."; },
  get errorMediaRequired() { return getOverride('ui.createProjectModal.errorMediaRequired') ?? "Media directory is required."; },
  get errorAnnotationsRequired() { return getOverride('ui.createProjectModal.errorAnnotationsRequired') ?? "Annotations directory is required."; },
  get errorDirNotExist() { return getOverride('ui.createProjectModal.errorDirNotExist') ?? "Project directory does not exist."; },
  errorAlreadyExists: (name: string) => `Project "${name}" already exists in this location.`,
  infoAlreadyExists: (name: string) => `Project "${name}" already exists in this location.`,
  get infoDirWillBeCreated() { return getOverride('ui.createProjectModal.infoDirWillBeCreated') ?? "Directory does not exist yet; it will be created when the project is created."; },
  get infoNoRepoConfigured() { return getOverride('ui.createProjectModal.infoNoRepoConfigured') ?? "No repository configured. Set a URL on the Settings tab to enable sync."; },
  get cancelButton() { return getOverride('ui.createProjectModal.cancelButton') ?? "Cancel"; },
  get createButton() { return getOverride('ui.createProjectModal.createButton') ?? "Create Project"; },
  get creatingButton() { return getOverride('ui.createProjectModal.creatingButton') ?? "Creating…"; },
  get openExistingButton() { return getOverride('ui.createProjectModal.openExistingButton') ?? "Open Existing Project"; },
};

export const projectSettingsModal = {
  get title() { return getOverride('ui.projectSettingsModal.title') ?? "Project Settings"; },
  get tabSettings() { return getOverride('ui.projectSettingsModal.tabSettings') ?? "Settings"; },
  get tabPreferences() { return getOverride('ui.projectSettingsModal.tabPreferences') ?? "Preferences"; },
  get cancelButton() { return getOverride('ui.projectSettingsModal.cancelButton') ?? "Cancel"; },
  get saveButton() { return getOverride('ui.projectSettingsModal.saveButton') ?? "Save"; },
  get savingButton() { return getOverride('ui.projectSettingsModal.savingButton') ?? "Checking…"; },
  get orphanedTitle() { return getOverride('ui.projectSettingsModal.orphanedTitle') ?? "Orphaned Annotations"; },
  get orphanedWhatToDo() { return getOverride('ui.projectSettingsModal.orphanedWhatToDo') ?? "What would you like to do with these files?"; },
  get retainButton() { return getOverride('ui.projectSettingsModal.retainButton') ?? "Retain"; },
  get deleteOrphanedButton() { return getOverride('ui.projectSettingsModal.deleteOrphanedButton') ?? "Delete Orphaned"; },
  get deletingButton() { return getOverride('ui.projectSettingsModal.deletingButton') ?? "Deleting…"; },
  get moveAnnotationsTitle() { return getOverride('ui.projectSettingsModal.moveAnnotationsTitle') ?? "Move Annotations"; },
  get moveAnnotationsMessage() { return getOverride('ui.projectSettingsModal.moveAnnotationsMessage') ?? "The annotations directory has changed. Would you like to copy your existing annotation files to the new directory?"; },
  get handleConflictsTitle() { return getOverride('ui.projectSettingsModal.handleConflictsTitle') ?? "Handle Conflicts"; },
  get handleConflictsMessage() { return getOverride('ui.projectSettingsModal.handleConflictsMessage') ?? "If annotation files already exist in the new directory, how should conflicts be resolved?"; },
  get dontCopyButton() { return getOverride('ui.projectSettingsModal.dontCopyButton') ?? "Don't Copy"; },
  get copyAnnotationsButton() { return getOverride('ui.projectSettingsModal.copyAnnotationsButton') ?? "Copy Annotations"; },
  get skipExistingButton() { return getOverride('ui.projectSettingsModal.skipExistingButton') ?? "Skip Existing"; },
  get overwriteButton() { return getOverride('ui.projectSettingsModal.overwriteButton') ?? "Overwrite"; },
  get copyingButton() { return getOverride('ui.projectSettingsModal.copyingButton') ?? "Copying…"; },
  get projectDirLabel() { return getOverride('ui.projectSettingsModal.projectDirLabel') ?? "Project Directory"; },
  get showInFinderTitle() { return getOverride('ui.projectSettingsModal.showInFinderTitle') ?? "Show in Finder"; },
  get orphanedNoMedia() { return getOverride('ui.projectSettingsModal.orphanedNoMedia') ?? "no corresponding media in the new media directory:"; },
};

export const annotationToolEditModal = {
  get labelField() { return getOverride('ui.annotationToolEditModal.labelField') ?? "Label"; },
  get descriptionField() { return getOverride('ui.annotationToolEditModal.descriptionField') ?? "Description"; },
  get descriptionPlaceholder() { return getOverride('ui.annotationToolEditModal.descriptionPlaceholder') ?? "When to use this label…"; },
  get colorField() { return getOverride('ui.annotationToolEditModal.colorField') ?? "Color"; },
  get customColorTitle() { return getOverride('ui.annotationToolEditModal.customColorTitle') ?? "Custom color"; },
  get exampleClipsField() { return getOverride('ui.annotationToolEditModal.exampleClipsField') ?? "Example clips"; },
  get renameWarning() { return getOverride('ui.annotationToolEditModal.renameWarning') ?? "Will rename existing annotations across all tracks"; },
  reassociateWarning: (count: number) => `Will reassociate ${count} Custom annotation(s) to this tool`,
  get filesButton() { return getOverride('ui.annotationToolEditModal.filesButton') ?? "Files…"; },
  get folderButton() { return getOverride('ui.annotationToolEditModal.folderButton') ?? "Folder…"; },
  viewButton: (count: number) => `View (${count})`,
  get cancelButton() { return getOverride('ui.annotationToolEditModal.cancelButton') ?? "Cancel"; },
};

export const annotationToolsSettingsModal = {
  get toolNamePlaceholder() { return getOverride('ui.annotationToolsSettingsModal.toolNamePlaceholder') ?? "Tool name…"; },
  get hotkeysHeading() { return getOverride('ui.annotationToolsSettingsModal.hotkeysHeading') ?? "Hotkeys"; },
  get newTool() { return getOverride('ui.annotationToolsSettingsModal.newTool') ?? "New tool"; },
  get unassignedHeading() { return getOverride('ui.annotationToolsSettingsModal.unassignedHeading') ?? "Unassigned"; },
};

export const deleteToolConfirmDialog = {
  title: (name: string) => `Delete "${name}"?`,
  get unlinkExplanation() { return getOverride('ui.deleteToolConfirmDialog.unlinkExplanation') ?? "Unlink — removes the tool and reassigns its annotations to Custom across all files."; },
  get deleteExplanation() { return getOverride('ui.deleteToolConfirmDialog.deleteExplanation') ?? "Delete — removes the tool and permanently deletes all its annotations across all files."; },
  get cancelButton() { return getOverride('ui.deleteToolConfirmDialog.cancelButton') ?? "Cancel"; },
  get unlinkButton() { return getOverride('ui.deleteToolConfirmDialog.unlinkButton') ?? "Unlink"; },
  get deleteButton() { return getOverride('ui.deleteToolConfirmDialog.deleteButton') ?? "Delete"; },
};

export const gitSyncSetupModal = {
  get title() { return getOverride('ui.gitSyncSetupModal.title') ?? "Set up a synced project"; },
  get gotItButton() { return getOverride('ui.gitSyncSetupModal.gotItButton') ?? "Got it"; },
  get introP() { return getOverride('ui.gitSyncSetupModal.introP') ?? "SeeNote can sync your annotations to a private GitHub repository so collaborators stay in step. Only your annotation files are shared — your media, your annotation tools, and your local settings (including your access token) stay on your machine. Each labeler keeps their own tools. This is a one-time setup per project."; },
  get step1_title() { return getOverride('ui.gitSyncSetupModal.step1_title') ?? "Create a GitHub account"; },
  get step1_p1() { return getOverride('ui.gitSyncSetupModal.step1_p1') ?? "Skip this if you already have one. Otherwise go to `github.com` and sign up — a free account is enough."; },
  get step2_title() { return getOverride('ui.gitSyncSetupModal.step2_title') ?? "Create a private repository"; },
  get step2_p1() { return getOverride('ui.gitSyncSetupModal.step2_p1') ?? "On GitHub, click **New** (or **New repository**). Give it a name such as `lab-annotations`, set it to **Private**, and leave it empty (don't add a README or license). Click **Create repository**."; },
  get step3_title() { return getOverride('ui.gitSyncSetupModal.step3_title') ?? "Generate an access token"; },
  get step3_intro() { return getOverride('ui.gitSyncSetupModal.step3_intro') ?? "On GitHub, go to:"; },
  get step3_path() { return getOverride('ui.gitSyncSetupModal.step3_path') ?? "`Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token`"; },
  get step3_li1() { return getOverride('ui.gitSyncSetupModal.step3_li1') ?? "Give the token a name and an expiration you're comfortable with."; },
  get step3_li2() { return getOverride('ui.gitSyncSetupModal.step3_li2') ?? "Under **Repository access**, choose **Only select repositories** and pick the repo you made in step 2."; },
  get step3_li3() { return getOverride('ui.gitSyncSetupModal.step3_li3') ?? "In the Permissions section, click the **Add Permissions** button, check the **Contents** box, and make sure the Access is set to **Read and write**."; },
  get step3_li4() { return getOverride('ui.gitSyncSetupModal.step3_li4') ?? "Click **Generate token** and copy it now — GitHub only shows it once."; },
  get step4_title() { return getOverride('ui.gitSyncSetupModal.step4_title') ?? "Enter the details in SeeNote"; },
  get step4_intro() { return getOverride('ui.gitSyncSetupModal.step4_intro') ?? "Create or open your project, then open **Project Settings** (the gear icon) and expand the **Sync (GitHub)** section. Paste in:"; },
  get step4_li1() { return getOverride('ui.gitSyncSetupModal.step4_li1') ?? "the **repository URL** from step 2,"; },
  get step4_li2() { return getOverride('ui.gitSyncSetupModal.step4_li2') ?? "the **access token** from step 3,"; },
  get step4_li3() { return getOverride('ui.gitSyncSetupModal.step4_li3') ?? "**your name** — recorded as the author of your edits so collaborators can see who changed what."; },
  get step4_save() { return getOverride('ui.gitSyncSetupModal.step4_save') ?? "Click **Save**."; },
  get step5_title() { return getOverride('ui.gitSyncSetupModal.step5_title') ?? "Sync"; },
  get step5_p1() { return getOverride('ui.gitSyncSetupModal.step5_p1') ?? "A **refresh icon** now appears in the project toolbar. Click it to push your annotations and pull in everyone else's. Sync whenever you want to share your work or catch up on theirs."; },
  get step5_p2() { return getOverride('ui.gitSyncSetupModal.step5_p2') ?? "Annotations merge automatically: if two people label the same recording, both sets are kept — only a deliberate deletion removes a label. A short summary shows what changed after each sync."; },
  get step6_title() { return getOverride('ui.gitSyncSetupModal.step6_title') ?? "Add collaborators"; },
  get step6_p1() { return getOverride('ui.gitSyncSetupModal.step6_p1') ?? "In your repository on GitHub, go to `Settings → Collaborators → Add people` and invite each collaborator by their GitHub username. Once they accept, each person repeats steps 3–5 on their own machine — their own token, their own name, the same repository URL. Everyone's edits merge together."; },
  get securityNote() { return getOverride('ui.gitSyncSetupModal.securityNote') ?? "Your token is stored only on this computer and is never uploaded to the repository — by default in your OS keychain. If an unsigned build keeps prompting for a password, switch **Token storage** to **plaintext** in Project Settings (saved unencrypted on disk, still never pushed). Keep the token private — anyone who has it can write to your annotations. If it ever leaks, delete it on GitHub and generate a new one."; },
};

export const gitSyncUserFields = {
  get tokenLabel() { return getOverride('ui.gitSyncUserFields.tokenLabel') ?? "GitHub access token"; },
  get tokenPlaceholder() { return getOverride('ui.gitSyncUserFields.tokenPlaceholder') ?? "fine-grained PAT (github_pat_…)"; },
  get tokenStorageLabel() { return getOverride('ui.gitSyncUserFields.tokenStorageLabel') ?? "Token storage"; },
  get keychainOption() { return getOverride('ui.gitSyncUserFields.keychainOption') ?? "OS keychain"; },
  get plaintextOption() { return getOverride('ui.gitSyncUserFields.plaintextOption') ?? "Plaintext"; },
  get recommendedHint() { return getOverride('ui.gitSyncUserFields.recommendedHint') ?? "Recommended"; },
  get noPasswordHint() { return getOverride('ui.gitSyncUserFields.noPasswordHint') ?? "No password prompts"; },
  get storedUnencryptedHint() { return getOverride('ui.gitSyncUserFields.storedUnencryptedHint') ?? "Stored unencrypted"; },
  get storedUnencryptedDetail() { return getOverride('ui.gitSyncUserFields.storedUnencryptedDetail') ?? "in this project's preferences.json on this machine. It is never pushed to the repo, but anything that can read your files can read the token. If it leaks, revoke it on GitHub."; },
  get keychainNoteWindows() { return getOverride('ui.gitSyncUserFields.keychainNoteWindows') ?? "Saved in Windows Credential Manager, never in preferences.json."; },
  get keychainNoteMac() { return getOverride('ui.gitSyncUserFields.keychainNoteMac') ?? "Saved in your macOS Keychain, never in preferences.json. Unsigned builds may prompt for your password when the token is read."; },
  get keychainNoteLinux() { return getOverride('ui.gitSyncUserFields.keychainNoteLinux') ?? "Saved in your system keyring (Secret Service), never in preferences.json. The keyring may prompt to unlock."; },
  get patFormatWarning() { return getOverride('ui.gitSyncUserFields.patFormatWarning') ?? "Token doesn't look like a GitHub fine-grained PAT (expected prefix: github_pat_)"; },
  get nameLabel() { return getOverride('ui.gitSyncUserFields.nameLabel') ?? "Your name (optional)"; },
  get namePlaceholder() { return getOverride('ui.gitSyncUserFields.namePlaceholder') ?? "recorded as the author of your annotation edits"; },
};

export const projectBaseFields = {
  get projectNameLabel() { return getOverride('ui.projectBaseFields.projectNameLabel') ?? "Project Name"; },
  get mediaLabel() { return getOverride('ui.projectBaseFields.mediaLabel') ?? "Media"; },
  get annotationsLabel() { return getOverride('ui.projectBaseFields.annotationsLabel') ?? "Annotations"; },
  get decimalPlacesLabel() { return getOverride('ui.projectBaseFields.decimalPlacesLabel') ?? "Output Decimal Places"; },
  get decimalPlacesHelp() { return getOverride('ui.projectBaseFields.decimalPlacesHelp') ?? "for start/end timestamps"; },
  get buzzdetectLabel() { return getOverride('ui.projectBaseFields.buzzdetectLabel') ?? "buzzdetect"; },
  get buzzdetectPlaceholder() { return getOverride('ui.projectBaseFields.buzzdetectPlaceholder') ?? "(optional) directory of {ident}_buzzdetect.csv"; },
  get buzzdetectHelp() { return getOverride('ui.projectBaseFields.buzzdetectHelp') ?? "Activations plotted below the spectrogram, located per track by ident."; },
  get syncLabel() { return getOverride('ui.projectBaseFields.syncLabel') ?? "Sync"; },
  get repoUrlLabel() { return getOverride('ui.projectBaseFields.repoUrlLabel') ?? "Repository URL"; },
  get repoUrlPlaceholder() { return getOverride('ui.projectBaseFields.repoUrlPlaceholder') ?? "https://github.com/your-lab/annotations.git"; },
  get addTokenLabel() { return getOverride('ui.projectBaseFields.addTokenLabel') ?? "Add access token"; },
  get advancedSection() { return getOverride('ui.projectBaseFields.advancedSection') ?? "Advanced"; },
};

export const directoryField = {
  get portabilityWarning() { return getOverride('ui.directoryField.portabilityWarning') ?? "This path is outside the project directory; the project will not be portable to other machines unless you also move it."; },
};

export const repairProjectModal = {
  get title() { return getOverride('ui.repairProjectModal.title') ?? "Media directory not found"; },
  message: (projectName: string) => `The media directory for ${projectName} no longer exists. Please choose a new path.`,
  get mediaDirLabel() { return getOverride('ui.repairProjectModal.mediaDirLabel') ?? "Media Directory (missing)"; },
  get cancelButton() { return getOverride('ui.repairProjectModal.cancelButton') ?? "Cancel"; },
  get saveButton() { return getOverride('ui.repairProjectModal.saveButton') ?? "Save & Open"; },
};

export const annotationToolsPanel = {
  get header() { return getOverride('ui.annotationToolsPanel.header') ?? "Labels"; },
  get selectLabel() { return getOverride('ui.annotationToolsPanel.selectLabel') ?? "Select"; },
  get customLabel() { return getOverride('ui.annotationToolsPanel.customLabel') ?? "Custom"; },
  get showExamples() { return getOverride('ui.annotationToolsPanel.showExamples') ?? "Show examples"; },
  get contextEdit() { return getOverride('ui.annotationToolsPanel.contextEdit') ?? "Edit"; },
  get contextDelete() { return getOverride('ui.annotationToolsPanel.contextDelete') ?? "Delete"; },
};

export const annotationToolLibrary = {
  get exampleClipsSubtitle() { return getOverride('ui.annotationToolLibrary.exampleClipsSubtitle') ?? "— example clips"; },
  get noExampleClips() { return getOverride('ui.annotationToolLibrary.noExampleClips') ?? "No example clips."; },
  get frequencyLabel() { return getOverride('ui.annotationToolLibrary.frequencyLabel') ?? "Frequency (Hz)"; },
};

export const annotationOverlay = {
  get namePlaceholder() { return getOverride('ui.annotationOverlay.namePlaceholder') ?? "Name..."; },
};

export const spectrogramView = {
  get generating() { return getOverride('ui.spectrogramView.generating') ?? "Generating spectrogram…"; },
};

export const videoPane = {
  get videoDisabled() { return getOverride('ui.videoPane.videoDisabled') ?? "Video Disabled"; },
  get switchModesHint() { return getOverride('ui.videoPane.switchModesHint') ?? "Switch modes with the picker in the bottom-left"; },
  get loadingFile() { return getOverride('ui.videoPane.loadingFile') ?? "Loading file..."; },
  get modeLabel() { return getOverride('ui.videoPane.modeLabel') ?? "MODE"; },
  get processingMedia() { return getOverride('ui.videoPane.processingMedia') ?? "Processing Media..."; },
};

export const videoPlayer = {
  get audioTrackActive() { return getOverride('ui.videoPlayer.audioTrackActive') ?? "Audio Track Active"; },
  get noMediaLoaded() { return getOverride('ui.videoPlayer.noMediaLoaded') ?? "No Media Loaded"; },
};

export const buzzdetectPanel = {
  get neuronHeader() { return getOverride('ui.buzzdetectPanel.neuronHeader') ?? "Neuron"; },
  get thresholdHeader() { return getOverride('ui.buzzdetectPanel.thresholdHeader') ?? "Threshold"; },
  get noDataLoaded() { return getOverride('ui.buzzdetectPanel.noDataLoaded') ?? "No data loaded."; },
  get allNeuronsHidden() { return getOverride('ui.buzzdetectPanel.allNeuronsHidden') ?? "All neurons hidden."; },
  get noActivations() { return getOverride('ui.buzzdetectPanel.noActivations') ?? "No buzzdetect activations for this track"; },
};

export const debugConsole = {
  get title() { return getOverride('ui.debugConsole.title') ?? "Debug Console"; },
  get noLogs() { return getOverride('ui.debugConsole.noLogs') ?? "No logs yet..."; },
};

export const fileTree = {
  get unsupported() { return getOverride('ui.fileTree.unsupported') ?? "(unsupported)"; },
  get emptyHint() { return getOverride('ui.fileTree.emptyHint') ?? "Open a file or folder to browse"; },
  get copyIdent() { return getOverride('ui.fileTree.copyIdent') ?? "Copy ident"; },
  get importAnnotations() { return getOverride('ui.fileTree.importAnnotations') ?? "Import annotations…"; },
};

export const keyboardShortcutsView = {
  get noShortcuts() { return getOverride('ui.keyboardShortcutsView.noShortcuts') ?? "No shortcuts for this key"; },
};
