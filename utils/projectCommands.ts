import { invoke } from '@tauri-apps/api/core';
import { Project, LabelConfig, SpectrogramSettings } from '../types';

// ── Rust-side snake_case shape ────────────────────────────────────────────────

interface LabelConfigRecord {
  key: string;
  text: string;
  color: string;
}

interface ProjectRecord {
  id: string;
  name: string;
  audio_directory: string;
  annotation_directory: string;
  output_format: string;
  created_at: string;
  last_opened: string;
  label_configs: LabelConfigRecord[];
  spectrogram_settings?: SpectrogramSettings; // stored as-is (camelCase) via serde_json::Value
}

interface CopyResultRaw {
  copied: number;
  skipped: number;
  errors: string[];
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function toProject(r: ProjectRecord): Project {
  return {
    id: r.id,
    name: r.name,
    audioDirectory: r.audio_directory,
    annotationDirectory: r.annotation_directory,
    outputFormat: r.output_format as 'json' | 'csv' | 'txt',
    createdAt: r.created_at,
    lastOpened: r.last_opened,
    labelConfigs: r.label_configs,
    spectrogramSettings: r.spectrogram_settings,
  };
}

function toRecord(p: Project): ProjectRecord {
  return {
    id: p.id,
    name: p.name,
    audio_directory: p.audioDirectory,
    annotation_directory: p.annotationDirectory,
    output_format: p.outputFormat,
    created_at: p.createdAt,
    last_opened: p.lastOpened,
    label_configs: p.labelConfigs,
    spectrogram_settings: p.spectrogramSettings,
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

export const getAppDataDir = (): Promise<string> =>
  invoke('get_app_data_dir');

export const loadProjects = async (projectsFile: string): Promise<Project[]> => {
  const records: ProjectRecord[] = await invoke('load_projects', { projectsFile });
  return records.map(toProject);
};

export const saveProjects = (projectsFile: string, projects: Project[]): Promise<void> =>
  invoke('save_projects', { projectsFile, projects: projects.map(toRecord) });

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

export const revealInFinder = (path: string): Promise<void> =>
  invoke('reveal_in_finder', { path });

export interface AnnotationCountEntry {
  rel_path: string; // relative path from annotation dir without extension, forward slashes
  count: number;
}

export const countAnnotationEntries = (
  annotationDir: string,
  outputFormat: string,
): Promise<AnnotationCountEntry[]> =>
  invoke('count_annotation_entries', { annotationDir, outputFormat });
