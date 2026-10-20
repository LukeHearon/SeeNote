import React, { useEffect, useState } from 'react';
import { gitSyncUserFields } from '../copy/ui';
import { updateAppSettings, useAppSettings } from '../hooks/useAppSettings';
import { resolveAnnotatorName } from '../utils/appSettings';

interface Props {
  /** The name an open project stored before the setting went app-wide, shown
   *  until one is set here. */
  legacyName?: string;
}

/**
 * The app-wide annotator name (commit author for synced projects). Bound
 * straight to the application settings: saved when the field loses focus,
 * independent of any surrounding modal's save/cancel.
 */
export default function AnnotatorNameField({ legacyName }: Props) {
  const app = useAppSettings();
  const saved = resolveAnnotatorName(app, legacyName);
  const [draft, setDraft] = useState(saved);
  useEffect(() => { setDraft(saved); }, [saved]);

  const commit = () => {
    const name = draft.trim();
    if (name === (app?.annotatorName ?? '')) return;
    updateAppSettings(s => ({ ...s, annotatorName: name || undefined }));
  };

  return (
    <div>
      <label className="text-gray-400 text-sm block mb-1">{gitSyncUserFields.nameLabel}</label>
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
      />
      <p className="text-gray-500 text-xs mt-1">{gitSyncUserFields.nameHint}</p>
    </div>
  );
}
