import React from 'react';
import { projectBaseFields, projectSettingsModal } from '../copy/ui';
import type { SingleFileSettings } from '../types';
import { updateAppSettings, useAppSettings } from '../hooks/useAppSettings';
import { withSingleFileSettings } from '../utils/appSettings';
import FilenameTimeFields from './FilenameTimeFields';
import BuzzdetectReadingFields from './BuzzdetectReadingFields';

/**
 * Single-file mode's reading settings — the same fields a project carries in
 * Project Settings, kept app-wide here since a lone file has no project.
 * Persisted on every change, like the rest of the application settings.
 */
export default function SingleFileSettingsFields() {
  const app = useAppSettings();
  if (!app) return null;
  const s = app.singleFile ?? {};
  const set = (patch: Partial<SingleFileSettings>) => updateAppSettings(prev => withSingleFileSettings(prev, patch));

  return (
    <>
      <p className="text-xs text-gray-500">{projectSettingsModal.singleFileIntro}</p>

      <FilenameTimeFields
        format={s.filenameTimeFormat ?? ''}
        offsetSeparator={s.filenameTimeOffsetSeparator ?? ''}
        onFormatChange={v => set({ filenameTimeFormat: v.trim() ? v : undefined })}
        onOffsetSeparatorChange={v => set({ filenameTimeOffsetSeparator: v.trim() ? v : undefined })}
      />

      <div>
        <span className="text-gray-400 text-xs font-medium uppercase tracking-wider">{projectBaseFields.buzzdetectSectionLabel}</span>
        <BuzzdetectReadingFields
          frameLength={s.buzzdetectFrameLength ?? null}
          trimActivationPrefix={s.buzzdetectTrimActivationPrefix ?? true}
          onFrameLengthChange={v => set({ buzzdetectFrameLength: v ?? undefined })}
          onTrimActivationPrefixChange={v => set({ buzzdetectTrimActivationPrefix: v })}
        />
      </div>
    </>
  );
}
