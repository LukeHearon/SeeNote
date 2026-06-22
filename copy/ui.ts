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
};
