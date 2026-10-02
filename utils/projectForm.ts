import type { ProjectSettings } from '../types';
import { DEFAULT_OUTPUT_ROUNDING_DECIMALS, DEFAULT_NAME_GRADIENT } from '../constants';
import { inputToProjectPath, projectPathInput } from './projectPaths';

/**
 * The project fields the create and settings modals both edit (ProjectBaseFields
 * renders them), as typed: directories relative to the project folder where
 * possible, empty strings for "not set".
 */
export interface ProjectFormValues {
  name: string;
  gradientColors: [string, string];
  mediaDir: string;
  annotationDir: string;
  buzzdetectDir: string;
  filenameTimeFormat: string;
  filenameTimeOffsetSeparator: string;
  outputRoundingDecimals: number;
  /** null = auto-detect from each CSV. */
  buzzdetectFrameLength: number | null;
  buzzdetectTrimActivationPrefix: boolean;
  syncRemoteUrl: string;
}

/** The form as it starts for an existing project, or empty for a new one. */
export function projectFormFromSettings(
  settings: ProjectSettings | undefined,
  newGradient: [string, string] = DEFAULT_NAME_GRADIENT,
): ProjectFormValues {
  return {
    name: settings?.projectName ?? '',
    gradientColors: settings?.nameGradientColors ?? newGradient,
    mediaDir: settings ? projectPathInput(settings.mediaDirectory) : '',
    annotationDir: settings ? projectPathInput(settings.annotationDirectory) : '',
    buzzdetectDir: settings?.buzzdetectDirectory ? projectPathInput(settings.buzzdetectDirectory) : '',
    filenameTimeFormat: settings?.filenameTimeFormat ?? '',
    filenameTimeOffsetSeparator: settings?.filenameTimeOffsetSeparator ?? '',
    outputRoundingDecimals: settings?.outputRoundingDecimals ?? DEFAULT_OUTPUT_ROUNDING_DECIMALS,
    buzzdetectFrameLength: settings?.buzzdetectFrameLength ?? null,
    buzzdetectTrimActivationPrefix: settings?.buzzdetectTrimActivationPrefix ?? true,
    syncRemoteUrl: settings?.gitSync?.remoteUrl ?? '',
  };
}

/** Which required field is missing, if any. */
export function missingProjectField(v: ProjectFormValues): 'name' | 'media' | 'annotations' | null {
  if (!v.name.trim()) return 'name';
  if (!v.mediaDir) return 'media';
  if (!v.annotationDir) return 'annotations';
  return null;
}

/**
 * The settings fields the form owns, written over `base` (an existing
 * project's settings, so fields the form doesn't show survive). The remote URL
 * comes in already normalised.
 */
export function settingsFromProjectForm(
  v: ProjectFormValues,
  projectDir: string,
  remoteUrl: string,
  base?: ProjectSettings,
): ProjectSettings {
  return {
    ...base,
    projectName: v.name.trim(),
    mediaDirectory: inputToProjectPath(projectDir, v.mediaDir),
    annotationDirectory: inputToProjectPath(projectDir, v.annotationDir),
    buzzdetectDirectory: v.buzzdetectDir ? inputToProjectPath(projectDir, v.buzzdetectDir) : undefined,
    buzzdetectFrameLength: v.buzzdetectFrameLength ?? undefined,
    buzzdetectTrimActivationPrefix: v.buzzdetectTrimActivationPrefix,
    filenameTimeFormat: v.filenameTimeFormat.trim() || undefined,
    filenameTimeOffsetSeparator: v.filenameTimeOffsetSeparator.trim() || undefined,
    outputFormat: base?.outputFormat ?? 'txt',
    outputRoundingDecimals: v.outputRoundingDecimals,
    nameGradientColors: v.gradientColors,
    gitSync: remoteUrl ? { remoteUrl } : undefined,
  };
}
