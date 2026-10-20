import React from 'react';
import { projectBaseFields } from '../copy/ui';
import { formatFilenameTime, isUsableFilenameTimePattern, parseFilenameOffsetSeconds, FILENAME_PREVIEW_DATE } from '../utils/filenameTime';

const PREVIEW_DATE = FILENAME_PREVIEW_DATE;

interface Props {
  format: string;
  offsetSeparator: string;
  onFormatChange: (v: string) => void;
  onOffsetSeparatorChange: (v: string) => void;
}

/**
 * The filename-timestamp pattern and elapsed-offset separator that unlock
 * Date mode — edited for a project in its settings, and for single-file mode
 * in the application settings.
 */
export default function FilenameTimeFields({ format, offsetSeparator, onFormatChange, onOffsetSeparatorChange }: Props) {
  return (
    <>
      <div>
        <label className="text-gray-400 text-sm block mb-1">{projectBaseFields.filenameTimeLabel}</label>
        <input
          type="text"
          value={format}
          onChange={e => onFormatChange(e.target.value)}
          placeholder={projectBaseFields.filenameTimePlaceholder}
          spellCheck={false}
          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
        />
        <p className="text-gray-600 text-xs mt-1">{projectBaseFields.filenameTimeHelp}</p>
        {format.trim() !== '' && (
          isUsableFilenameTimePattern(format) ? (
            <p className="text-gray-500 text-xs mt-1 font-mono">
              {projectBaseFields.examplePrefix} {projectBaseFields.previewDateLabel} → <span className="text-gray-300">{formatFilenameTime(PREVIEW_DATE, format)}.mp3</span>
            </p>
          ) : (
            <p className="text-amber-500/80 text-xs mt-1">{projectBaseFields.filenameTimeIncomplete}</p>
          )
        )}
      </div>

      <div>
        <label className="text-gray-400 text-sm block mb-1">{projectBaseFields.filenameTimeOffsetLabel}</label>
        <input
          type="text"
          value={offsetSeparator}
          onChange={e => onOffsetSeparatorChange(e.target.value)}
          placeholder={projectBaseFields.filenameTimeOffsetPlaceholder}
          spellCheck={false}
          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-blue-500"
        />
        <p className="text-gray-600 text-xs mt-1">{projectBaseFields.filenameTimeOffsetHelp}</p>
        {offsetSeparator.trim() !== '' && isUsableFilenameTimePattern(format) && (
          <p className="text-gray-500 text-xs mt-1 font-mono">
            {projectBaseFields.examplePrefix} <span className="text-gray-300">{formatFilenameTime(PREVIEW_DATE, format)}{offsetSeparator}52860.mp3</span>{' '}
            → {new Date(PREVIEW_DATE.getTime() + (parseFilenameOffsetSeconds(`${offsetSeparator}52860`, offsetSeparator) ?? 0) * 1000).toLocaleString()}
          </p>
        )}
      </div>
    </>
  );
}
