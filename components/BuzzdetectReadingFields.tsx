import React from 'react';
import { projectBaseFields } from '../copy/ui';
import DraftNumberInput from './DraftNumberInput';

interface Props {
  /** null = auto-detect from each CSV. */
  frameLength: number | null;
  trimActivationPrefix: boolean;
  onFrameLengthChange: (v: number | null) => void;
  onTrimActivationPrefixChange: (v: boolean) => void;
}

/**
 * How a buzzdetect CSV is read — fallback frame length and whether
 * `activation_` is trimmed from column names. Edited for a project in its
 * settings, and for single-file mode in the application settings.
 */
export default function BuzzdetectReadingFields({
  frameLength, trimActivationPrefix, onFrameLengthChange, onTrimActivationPrefixChange,
}: Props) {
  return (
    <>
      <div className="flex items-center justify-between mt-2">
        <div>
          <label className="text-gray-400 text-sm block">{projectBaseFields.buzzdetectFrameLengthLabel}</label>
          <p className="text-gray-600 text-xs">
            {frameLength === null ? projectBaseFields.buzzdetectFrameLengthAutoHelp : projectBaseFields.buzzdetectFrameLengthOverrideHelp}
          </p>
        </div>
        {/* Always editable — a value here always wins. Clearing the field
            is the "unset" state, which falls back to auto-detection. */}
        <DraftNumberInput
          value={frameLength}
          onCommit={onFrameLengthChange}
          min={0.001}
          allowEmpty
          placeholder={projectBaseFields.buzzdetectFrameLengthPlaceholder}
          className="w-20 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        />
      </div>
      <label className="flex items-start gap-2 cursor-pointer select-none mt-3">
        <input
          type="checkbox"
          checked={trimActivationPrefix}
          onChange={e => onTrimActivationPrefixChange(e.target.checked)}
          className="mt-0.5 accent-blue-500"
        />
        <span>
          <span className="block text-sm text-gray-200">{projectBaseFields.buzzdetectTrimPrefixLabel}</span>
          <span className="block text-xs text-gray-500 mt-0.5">{projectBaseFields.buzzdetectTrimPrefixHint}</span>
        </span>
      </label>
    </>
  );
}
