import React from 'react';
import { projectSettingsModal } from '../copy/ui';
import { updateAppSettings, useAppSettings } from '../hooks/useAppSettings';
import { resolveDateTimeFormat } from '../utils/appSettings';
import { DateTimeFormat, previewDateTimeFormat } from '../utils/datetimeDisplay';
import { FILENAME_PREVIEW_DATE } from '../utils/filenameTime';

interface Props {
  /** The style an open project stored before the setting went app-wide,
   *  shown until one is picked here. */
  legacyFormat?: DateTimeFormat;
}

/** The app-wide wall-clock datetime style, saved as soon as it's picked. */
export default function DateTimeFormatField({ legacyFormat }: Props) {
  const app = useAppSettings();
  const value = resolveDateTimeFormat(app, legacyFormat);

  return (
    <div>
      <h3 className="text-gray-300 text-sm font-medium mb-1">{projectSettingsModal.dateTimeFormatHeader}</h3>
      <p className="text-xs text-gray-500 mb-3">{projectSettingsModal.dateTimeFormatHint}</p>
      <div className="space-y-2">
        {(['friendly', 'iso'] as DateTimeFormat[]).map(fmt => (
          <label key={fmt} className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="radio"
              name="dateTimeFormat"
              checked={value === fmt}
              onChange={() => updateAppSettings(s => ({ ...s, dateTimeFormat: fmt }))}
              className="accent-blue-500"
            />
            <span className="text-sm text-gray-200">
              {fmt === 'friendly' ? projectSettingsModal.dateTimeFormatFriendlyLabel : projectSettingsModal.dateTimeFormatIsoLabel}
            </span>
            <span className="text-xs text-gray-500 font-mono">{previewDateTimeFormat(fmt, FILENAME_PREVIEW_DATE)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
