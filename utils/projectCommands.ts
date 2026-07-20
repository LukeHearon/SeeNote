import { invoke } from '@tauri-apps/api/core';
import { ProjectPreferences, ProjectRegistryEntry, ProjectSettings, RecentFileEntry } from '../types';

// ── Registry (slim per-machine pointer file) ──────────────────────────────────

interface RegistryEntryRecord {
  id: string;
  project_dir: string;
  last_opened: string;
  name?: string | null;
  name_gradient_colors?: [string, string] | null;
}

function toRegistry(r: RegistryEntryRecord): ProjectRegistryEntry {
  return {
    id: r.id,
    projectDir: r.project_dir,
    lastOpened: r.last_opened,
    name: r.name ?? undefined,
    nameGradientColors: r.name_gradient_colors ?? undefined,
  };
}

function toRegistryRecord(e: ProjectRegistryEntry): RegistryEntryRecord {
  return {
    id: e.id,
    project_dir: e.projectDir,
    last_opened: e.lastOpened,
    name: e.name ?? null,
    name_gradient_colors: e.nameGradientColors ?? null,
  };
}

export const getAppDataDir = (): Promise<string> =>
  invoke('get_app_data_dir');

export const loadRegistry = async (projectsFile: string): Promise<ProjectRegistryEntry[]> => {
  const records: RegistryEntryRecord[] = await invoke('load_projects', { projectsFile });
  return records.map(toRegistry);
};

export const saveRegistry = (
  projectsFile: string,
  entries: ProjectRegistryEntry[],
): Promise<void> =>
  invoke('save_projects', { projectsFile, projects: entries.map(toRegistryRecord) });

// ── Recent files (slim per-machine pointer file, single-file mode) ───────────

interface RecentFileRecord {
  id: string;
  path: string;
  last_opened: string;
}

function toRecentFile(r: RecentFileRecord): RecentFileEntry {
  return { id: r.id, path: r.path, lastOpened: r.last_opened };
}

function toRecentFileRecord(e: RecentFileEntry): RecentFileRecord {
  return { id: e.id, path: e.path, last_opened: e.lastOpened };
}

export const loadRecentFiles = async (filesFile: string): Promise<RecentFileEntry[]> => {
  const records: RecentFileRecord[] = await invoke('load_recent_files', { filesFile });
  return records.map(toRecentFile);
};

export const saveRecentFiles = (
  filesFile: string,
  entries: RecentFileEntry[],
): Promise<void> =>
  invoke('save_recent_files', { filesFile, files: entries.map(toRecentFileRecord) });

// ── Per-project settings.json ────────────────────────────────────────────────

/**
 * Fields that lived in the old settings.json but belong in preferences.json.
 * Detected by the presence of 'name' (old) instead of 'projectName' (new).
 */
const OLD_PREF_KEYS = new Set([
  'spectrogramSettings', 'toolHotkeys',
  'fileFilter', 'shuffleMode', 'enteredFolderPath', 'uiSettings', 'bandPassFilter',
]);

/**
 * One-time migration: rewrite settings.json with 'projectName' instead of 'name',
 * strip preference fields into preferences.json (seeded only when the file is
 * absent), and split gitSync into settings (remoteUrl) + preferences (user credentials).
 * No-op on current-format projects.
 */
async function migrateSettingsIfNeeded(
  projectDir: string,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!('name' in raw) || 'projectName' in raw) return raw;

  const newSettings: Record<string, unknown> = { projectName: raw['name'] };
  const newPrefs: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'name' || key === 'customToolColor') continue;
    if (OLD_PREF_KEYS.has(key)) {
      newPrefs[key] = value;
    } else if (key === 'gitSync' && value && typeof value === 'object') {
      const gs = value as Record<string, unknown>;
      if (gs['remoteUrl']) newSettings['gitSync'] = { remoteUrl: gs['remoteUrl'] };
      const gitSyncUser: Record<string, unknown> = {};
      for (const field of ['authorName', 'tokenStorage', 'tokenPlaintext']) {
        if (gs[field] !== undefined) gitSyncUser[field] = gs[field];
      }
      if (Object.keys(gitSyncUser).length > 0) newPrefs['gitSyncUser'] = gitSyncUser;
    } else {
      newSettings[key] = value;
    }
  }

  await invoke('write_project_settings', { projectDir, settings: newSettings });

  if (Object.keys(newPrefs).length > 0) {
    const existing = await invoke<Record<string, unknown>>('read_project_preferences', { projectDir });
    if (Object.keys(existing).length === 0) {
      await invoke('write_project_preferences', { projectDir, preferences: newPrefs });
    }
  }

  return newSettings;
}

/** Read `{projectDir}/.seenote/settings.json`, migrating from the old format if needed. */
export const readProjectSettings = async (projectDir: string): Promise<ProjectSettings> => {
  const raw = await invoke<Record<string, unknown>>('read_project_settings', { projectDir });
  const migrated = await migrateSettingsIfNeeded(projectDir, raw);
  return migrated as unknown as ProjectSettings;
};

/** Write the settings object to `{projectDir}/.seenote/settings.json`. */
export const writeProjectSettings = (
  projectDir: string,
  settings: ProjectSettings,
): Promise<void> =>
  invoke('write_project_settings', { projectDir, settings });

/** Read `{projectDir}/.seenote/preferences.json`. Returns `{}` if the file doesn't exist. */
export const readProjectPreferences = (projectDir: string): Promise<ProjectPreferences> =>
  invoke('read_project_preferences', { projectDir });

/** Write the preferences object to `{projectDir}/.seenote/preferences.json`. */
export const writeProjectPreferences = (
  projectDir: string,
  preferences: ProjectPreferences,
): Promise<void> =>
  invoke('write_project_preferences', { projectDir, preferences });

export const projectDirExists = (projectDir: string): Promise<boolean> =>
  invoke('project_dir_exists', { projectDir });

// ── Misc project-related filesystem helpers (unchanged signatures) ────────────

export const getOrphanedAnnotations = (
  annotationDir: string,
  newAudioDir: string,
): Promise<string[]> =>
  invoke('get_orphaned_annotations', { annotationDir, newAudioDir });

export const deleteFiles = (paths: string[]): Promise<void> =>
  invoke('delete_files', { paths });

export const copyAnnotationFiles = (
  copies: { src: string; dst: string }[],
  conflictResolution: 'overwrite' | 'skip',
): Promise<{ copied: number; skipped: number; errors: string[] }> =>
  invoke('copy_annotation_files', { copies, conflictResolution });

export const revealInFileManager = (path: string): Promise<void> =>
  invoke('reveal_in_file_manager', { path });

export const listAnnotationFiles = (
  annotationDir: string,
  outputFormat: string,
): Promise<string[]> =>
  invoke('list_annotation_files', { annotationDir, outputFormat });
