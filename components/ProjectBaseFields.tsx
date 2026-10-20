import React, { useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';
import { projectBaseFields } from '../copy/ui';
import type { ProjectFormValues } from '../utils/projectForm';
import { tooltips } from '../copy/tooltips';
import GradientPicker from './GradientPicker';
import DirectoryField from './DirectoryField';
import CollapsibleSection from './CollapsibleSection';
import FilenameTimeFields from './FilenameTimeFields';
import BuzzdetectReadingFields from './BuzzdetectReadingFields';
import { openSyncGuideWindow } from '../utils/tauriCommands';
import { normalizeGitRemoteUrl } from '../utils/gitSync';

interface Props {
  projectDir: string;
  values: ProjectFormValues;
  onChange: (patch: Partial<ProjectFormValues>) => void;
  mediaDirPlaceholder?: string;
  mediaDirNotExistMessage: string;
  annotationDirPlaceholder?: string;
  annotationDirNotExistMessage: string;
  advancedDefaultOpen?: boolean;
  onAddAccessToken?: () => void;
}

export default function ProjectBaseFields({
  projectDir,
  values,
  onChange,
  mediaDirPlaceholder,
  mediaDirNotExistMessage,
  annotationDirPlaceholder,
  annotationDirNotExistMessage,
  advancedDefaultOpen = false,
  onAddAccessToken,
}: Props) {
  const {
    name, gradientColors, mediaDir, annotationDir, buzzdetectDir, filenameTimeFormat,
    filenameTimeOffsetSeparator, outputRoundingDecimals, buzzdetectFrameLength,
    buzzdetectTrimActivationPrefix, syncRemoteUrl,
  } = values;
  const onNameInput = (v: string) => onChange({ name: v });
  const onGradientChange = (v: [string, string]) => onChange({ gradientColors: v });
  const onMediaDirChange = (v: string) => onChange({ mediaDir: v });
  const onAnnotationDirChange = (v: string) => onChange({ annotationDir: v });
  const onFilenameTimeFormatChange = (v: string) => onChange({ filenameTimeFormat: v });
  const onFilenameTimeOffsetSeparatorChange = (v: string) => onChange({ filenameTimeOffsetSeparator: v });
  const onOutputRoundingDecimalsChange = (v: number) => onChange({ outputRoundingDecimals: v });
  const onBuzzdetectDirChange = (v: string) => onChange({ buzzdetectDir: v });
  const onBuzzdetectFrameLengthChange = (v: number | null) => onChange({ buzzdetectFrameLength: v });
  const onBuzzdetectTrimActivationPrefixChange = (v: boolean) => onChange({ buzzdetectTrimActivationPrefix: v });
  const onSyncRemoteUrlChange = (v: string) => onChange({ syncRemoteUrl: v });
  const nameRef = useRef<HTMLDivElement>(null);

  // Sync contentEditable when name changes externally (e.g. auto-fill from projectDir).
  // The guard prevents interfering with the user's cursor while they're typing.
  useEffect(() => {
    const el = nameRef.current;
    if (el && el.textContent !== name) el.textContent = name;
  }, [name]);

  return (
    <>
      <div>
        <label className="text-gray-400 text-sm block mb-1">{projectBaseFields.projectNameLabel}</label>
        <div className="border-b border-gray-600 focus-within:border-blue-500 pb-1">
          <div
            ref={nameRef}
            contentEditable
            suppressContentEditableWarning
            onInput={e => onNameInput((e.target as HTMLDivElement).textContent || '')}
            onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
            onPaste={e => {
              e.preventDefault();
              const text = e.clipboardData.getData('text/plain');
              const sel = window.getSelection();
              if (!sel || !sel.rangeCount) return;
              const range = sel.getRangeAt(0);
              range.deleteContents();
              range.insertNode(document.createTextNode(text));
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }}
            className="text-xl font-bold bg-clip-text text-transparent outline-none cursor-text"
            style={{
              backgroundImage: `linear-gradient(to right, ${gradientColors[0]}, ${gradientColors[1]})`,
              display: 'inline-block',
              minWidth: '2ch',
              caretColor: '#FFFFFF',
            }}
          />
        </div>
        <div className="mt-3">
          <GradientPicker value={gradientColors} onChange={onGradientChange} />
        </div>
      </div>

      <DirectoryField
        label={projectBaseFields.mediaLabel}
        projectDir={projectDir}
        value={mediaDir}
        onChange={onMediaDirChange}
        placeholder={mediaDirPlaceholder}
        notExistMessage={mediaDirNotExistMessage}
      />

      <DirectoryField
        label={projectBaseFields.annotationsLabel}
        projectDir={projectDir}
        value={annotationDir}
        onChange={onAnnotationDirChange}
        placeholder={annotationDirPlaceholder}
        notExistMessage={annotationDirNotExistMessage}
      />

      <FilenameTimeFields
        format={filenameTimeFormat}
        offsetSeparator={filenameTimeOffsetSeparator}
        onFormatChange={onFilenameTimeFormatChange}
        onOffsetSeparatorChange={onFilenameTimeOffsetSeparatorChange}
      />

      <div>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-gray-400 text-sm block">{projectBaseFields.decimalPlacesLabel}</label>
            <p className="text-gray-600 text-xs">{projectBaseFields.decimalPlacesHelp}</p>
          </div>
          <input
            type="number"
            min="0"
            max="9"
            step="1"
            value={outputRoundingDecimals}
            onChange={e => {
              const v = parseInt(e.target.value);
              if (!isNaN(v)) onOutputRoundingDecimalsChange(Math.min(9, Math.max(0, v)));
            }}
            className="w-16 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      <CollapsibleSection title={projectBaseFields.advancedSection} defaultOpen={advancedDefaultOpen}>
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-400 text-xs font-medium uppercase tracking-wider">{projectBaseFields.buzzdetectSectionLabel}</span>
          </div>
          <DirectoryField
            label={projectBaseFields.buzzdetectLabel}
            projectDir={projectDir}
            value={buzzdetectDir}
            onChange={onBuzzdetectDirChange}
            placeholder={projectBaseFields.buzzdetectPlaceholder}
            notExistMessage="Directory does not exist."
          />
          <BuzzdetectReadingFields
            frameLength={buzzdetectFrameLength}
            trimActivationPrefix={buzzdetectTrimActivationPrefix}
            onFrameLengthChange={onBuzzdetectFrameLengthChange}
            onTrimActivationPrefixChange={onBuzzdetectTrimActivationPrefixChange}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-400 text-xs font-medium uppercase tracking-wider">{projectBaseFields.syncLabel}</span>
            <button
              type="button"
              onClick={openSyncGuideWindow}
              className="text-gray-600 hover:text-gray-400 transition-colors"
              data-tooltip={tooltips.setupSyncedProject}
            >
              <HelpCircle size={14} />
            </button>
          </div>
          <div>
            <label className="text-gray-400 text-sm block mb-1">{projectBaseFields.repoUrlLabel}</label>
            <input
              type="text"
              value={syncRemoteUrl}
              onChange={e => onSyncRemoteUrlChange(e.target.value)}
              onBlur={() => {
                const normalized = normalizeGitRemoteUrl(syncRemoteUrl);
                if (normalized !== syncRemoteUrl) onSyncRemoteUrlChange(normalized);
              }}
              placeholder={projectBaseFields.repoUrlPlaceholder}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            />
          </div>
          {onAddAccessToken && (
            <button
              type="button"
              onClick={onAddAccessToken}
              className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
            >
              {projectBaseFields.addTokenLabel}
            </button>
          )}
        </div>
      </CollapsibleSection>
    </>
  );
}
