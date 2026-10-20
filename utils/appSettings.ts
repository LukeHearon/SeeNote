import type { AppSettings, SingleFileSettings } from '../types';
import type { DateTimeFormat } from './datetimeDisplay';
import { DEFAULT_DATE_TIME_FORMAT } from '../constants';

/**
 * Datetime style in force: the app-wide setting, else the value a project
 * stored before the setting moved to the app level, else the default.
 */
export function resolveDateTimeFormat(app: AppSettings | null, legacy?: DateTimeFormat): DateTimeFormat {
  return app?.dateTimeFormat ?? legacy ?? DEFAULT_DATE_TIME_FORMAT;
}

/**
 * Commit author name in force: the app-wide setting, else the name a project
 * stored before the setting moved to the app level, else empty (the backend
 * falls back to its own default).
 */
export function resolveAnnotatorName(app: AppSettings | null, legacy?: string): string {
  return app?.annotatorName?.trim() || legacy?.trim() || '';
}

/** `settings` with `patch` merged into its single-file block. */
export function withSingleFileSettings(settings: AppSettings, patch: Partial<SingleFileSettings>): AppSettings {
  return { ...settings, singleFile: { ...settings.singleFile, ...patch } };
}
