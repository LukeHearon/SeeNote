import { useCallback, useRef, useState } from 'react';
import type React from 'react';

/**
 * Click-to-edit / focus-to-edit text drafts. While a field is being edited it
 * holds free text; Enter or blur commits it, Escape discards it. `K` names
 * which of several fields is being edited (a single-field consumer can use the
 * default). Pure state in, callbacks out — safe for the shared toolbar controls.
 */
export function useDraftField<K extends string = 'value'>(
  onCommit: (key: K, raw: string) => void,
  opts: { /** Keep keystrokes from reaching app hotkeys. */ stopPropagation?: boolean } = {},
) {
  const [editing, setEditing] = useState<K | null>(null);
  const [raw, setRaw] = useState('');
  // Mirrors of the state, for handlers that fire between a set and its render.
  const editingRef = useRef<K | null>(null);
  const rawRef = useRef('');
  const stopPropagation = opts.stopPropagation ?? false;

  const begin = useCallback((key: K, initial: string) => {
    editingRef.current = key;
    rawRef.current = initial;
    setEditing(key);
    setRaw(initial);
  }, []);

  const end = useCallback(() => {
    editingRef.current = null;
    setEditing(null);
    setRaw('');
  }, []);

  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const commit = useCallback(() => {
    const key = editingRef.current;
    if (key === null) return;
    const text = rawRef.current;
    end();
    onCommitRef.current(key, text);
  }, [end]);

  const cancel = useCallback(() => end(), [end]);

  /** Handlers for the editing input; the caller supplies `value` (`raw` while editing) and, for always-mounted inputs, `onFocus={() => begin(...)}`. */
  const fieldProps = () => ({
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      rawRef.current = e.target.value;
      setRaw(e.target.value);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (stopPropagation) e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); e.currentTarget.blur(); }
    },
    // A blur after Enter/Escape finds nothing being edited and does nothing.
    onBlur: () => commit(),
  });

  return { editing, raw, begin, commit, cancel, fieldProps };
}
