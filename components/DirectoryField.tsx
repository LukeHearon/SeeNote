import React, { useState, useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { openDirectoryDialog, checkDirExists } from '../utils/tauriCommands';
import { isInsideProjectDir, isAbsolutePath, resolveInputPath, trimProjectPrefix } from '../utils/projectPaths';

export const PORTABILITY_WARNING =
  'This path is outside the project directory; the project will not be portable to other machines unless you also move it.';

interface DirectoryFieldProps {
  /** Base label, e.g. "Media" — rendered as "{label} Directory". */
  label: string;
  /** Project directory used to resolve and trim relative paths. */
  projectDir: string;
  /** Current field value (already project-prefix-trimmed). */
  value: string;
  /** Called with the project-prefix-trimmed value on edit or browse. */
  onChange: (value: string) => void;
  placeholder?: string;
  helperText?: React.ReactNode;
  /** Message shown when the resolved directory does not exist. Omit to suppress. */
  notExistMessage?: React.ReactNode;
  autoFocus?: boolean;
}

/**
 * Shared directory picker used by the Create Project and Project Settings
 * modals: a relative-aware label, a text input, a Browse button, the resolved
 * absolute path, a portability warning when the path escapes the project, and a
 * debounced existence check. Resolution/trimming use the same helpers
 * everywhere so the two modals can't drift.
 */
export default function DirectoryField({
  label, projectDir, value, onChange, placeholder, helperText, notExistMessage, autoFocus,
}: DirectoryFieldProps) {
  const resolved = resolveInputPath(projectDir, value);
  const isRelative = !!value && !isAbsolutePath(value);
  const isOutside = !!resolved && !!projectDir && !isInsideProjectDir(projectDir, resolved);

  // Debounced existence check; reset to null on change so a stale result never
  // flashes against a path the user is mid-way through typing.
  const [exists, setExists] = useState<boolean | null>(null);
  useEffect(() => {
    if (!resolved) { setExists(null); return; }
    setExists(null);
    let cancelled = false;
    const t = setTimeout(() => {
      checkDirExists(resolved).then(e => { if (!cancelled) setExists(e); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [resolved]);

  const handleBrowse = async () => {
    const dir = await openDirectoryDialog();
    if (dir) onChange(trimProjectPrefix(projectDir, dir));
  };

  return (
    <div>
      <label className="text-gray-400 text-sm block mb-1">
        {label} Directory
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={e => onChange(trimProjectPrefix(projectDir, e.target.value))}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 placeholder-gray-600"
        />
        <button
          onClick={handleBrowse}
          className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
        >
          <FolderOpen size={16} />
        </button>
      </div>
      {helperText && <p className="text-gray-600 text-xs mt-1">{helperText}</p>}
      {isRelative && resolved && (
        <p className="text-gray-500 text-xs mt-1">→ {resolved}</p>
      )}
      {isOutside && (
        <p className="text-yellow-400 text-xs mt-1">{PORTABILITY_WARNING}</p>
      )}
      {notExistMessage && value && exists === false && (
        <p className="text-yellow-400 text-xs mt-1">{notExistMessage}</p>
      )}
    </div>
  );
}
