import { invoke } from '@tauri-apps/api/core';
import { Project, AnnotationTool, SpectrogramSettings } from '../types';

// ── Rust-side snake_case shape ────────────────────────────────────────────────

// Wire format matching the Rust ProjectRecord struct (uses snake_case and the
// legacy `label_configs` field name for backward compatibility with saved files).
interface AnnotationToolRecord {
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
  label_configs: AnnotationToolRecord[];
  spectrogram_settings?: SpectrogramSettings; // stored as-is (camelCase) via serde_json::Value
  name_gradient_colors?: [string, string];
  output_rounding_decimals?: number;
  file_filter?: string;
  hide_annotated?: boolean;
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
    annotationTools: r.label_configs,
    spectrogramSettings: r.spectrogram_settings,
    nameGradientColors: r.name_gradient_colors,
    outputRoundingDecimals: r.output_rounding_decimals,
    fileFilter: r.file_filter as 'all' | 'annotated' | 'unannotated' | undefined,
    hideAnnotated: r.hide_annotated,
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
    label_configs: p.annotationTools,
    spectrogram_settings: p.spectrogramSettings,
    name_gradient_colors: p.nameGradientColors,
    output_rounding_decimals: p.outputRoundingDecimals,
    file_filter: p.fileFilter,
    hide_annotated: p.hideAnnotated,
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

export const revealInFileManager = (path: string): Promise<void> =>
  invoke('reveal_in_file_manager', { path });

export const listAnnotationFiles = (
  annotationDir: string,
  outputFormat: string,
): Promise<string[]> =>
  invoke('list_annotation_files', { annotationDir, outputFormat });
