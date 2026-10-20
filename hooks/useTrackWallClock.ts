import { useMemo } from 'react';
import type { DateTimeFormat } from '../utils/datetimeDisplay';
import { parseFilenameTime } from '../utils/filenameTime';
import { basename, effectiveTimeUnit, type ElapsedTimeDisplayUnit, type TimeDisplayUnit } from '../utils/helpers';
import { resolveDateTimeFormat } from '../utils/appSettings';
import { useAppSettings } from './useAppSettings';

interface Params {
  trackPath: string | null;
  /** Timestamp pattern the track's filename is read with (project or single-file setting). */
  filenameTimeFormat: string | undefined;
  filenameTimeOffsetSeparator: string | undefined;
  timeDisplayUnit: TimeDisplayUnit;
  fallbackTimeDisplayUnit: ElapsedTimeDisplayUnit;
  /** Datetime style a project stored before the setting went app-wide. */
  legacyDateTimeFormat?: DateTimeFormat;
}

/**
 * Wall-clock context for the open track, shared by both windows: when the
 * recording started (read out of its filename), the time unit readouts should
 * actually show, and the datetime style to show it in.
 */
export function useTrackWallClock({
  trackPath, filenameTimeFormat, filenameTimeOffsetSeparator,
  timeDisplayUnit, fallbackTimeDisplayUnit, legacyDateTimeFormat,
}: Params) {
  const app = useAppSettings();

  // Null (so time readouts stay elapsed) when there's no pattern or this
  // particular name doesn't match it.
  const trackStartDate = useMemo(() => {
    const pattern = filenameTimeFormat?.trim();
    if (!pattern || !trackPath) return null;
    return parseFilenameTime(basename(trackPath), pattern, filenameTimeOffsetSeparator?.trim() || undefined);
  }, [filenameTimeFormat, filenameTimeOffsetSeparator, trackPath]);

  // 'datetime' only applies where a start time is known; elsewhere readouts
  // fall back to the last elapsed unit the user chose.
  const shownTimeUnit = effectiveTimeUnit(timeDisplayUnit, trackStartDate, fallbackTimeDisplayUnit);

  const dateTimeFormat = resolveDateTimeFormat(app, legacyDateTimeFormat);

  return { trackStartDate, shownTimeUnit, dateTimeFormat };
}
