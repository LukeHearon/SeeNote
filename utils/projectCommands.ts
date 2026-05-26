import { invoke } from '@tauri-apps/api/core';
import { ProjectRegistryEntry, ProjectSettings } from '../types';

// ── Registry (slim per-machine pointer file) ──────────────────────────────────

interface RegistryEntryRecord {
  id: string;
  project_dir: string;
  last_opened: string;
  name?: string | null;
}

function toRegistry(r: RegistryEntryRecord): ProjectRegistryEntry {
  return { id: r.id, projectDir: r.project_dir, lastOpened: r.last_opened, name: r.name ?? undefined };
}

function toRegistryRecord(e: ProjectRegistryEntry): RegistryEntryRecord {
  return { id: e.id, project_dir: e.projectDir, last_opened: e.lastOpened, name: e.name ?? null };
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

// ── Per-project settings.json ────────────────────────────────────────────────

/** Read `{projectDir}/.seenote/settings.json` and return its raw JSON. */
export const readProjectSettings = (projectDir: string): Promise<ProjectSettings> =>
  invoke('read_project_settings', { projectDir });

/** Write the settings object to `{projectDir}/.seenote/settings.json`. */
export const writeProjectSettings = (
  projectDir: string,
  settings: ProjectSettings,
): Promise<void> =>
  invoke('write_project_settings', { projectDir, settings });

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
