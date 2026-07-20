import React, { useState, useEffect } from 'react';

interface Props {
  value: number | null;
  onCommit: (v: number | null) => void;
  className?: string;
  style?: React.CSSProperties;
  /** Reject (and revert) committed values below this. */
  min?: number;
  /**
   * Treat a cleared field as a meaningful value (commits null) rather than as
   * an in-progress edit to revert. Use where "unset" is a real state — e.g. a
   * frame length left blank to fall back on auto-detection.
   */
  allowEmpty?: boolean;
  placeholder?: string;
}

/**
 * Controlled numeric input that lets the user type freely — including
 * clearing the field to retype — and only commits a parsed value on blur or
 * Enter. Validating on every keystroke (e.g. rejecting an empty string as
 * NaN) makes it impossible to backspace and re-enter a value.
 */
export default function DraftNumberInput({ value, onCommit, className, style, min, allowEmpty, placeholder }: Props) {
  const asText = (v: number | null) => (v === null ? '' : String(v));
  const [draft, setDraft] = useState(asText(value));
  useEffect(() => { setDraft(asText(value)); }, [value]);
  const commit = () => {
    if (allowEmpty && draft.trim() === '') { onCommit(null); return; }
    const v = parseFloat(draft);
    if (!isNaN(v) && (min === undefined || v >= min)) onCommit(v);
    else setDraft(asText(value));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      placeholder={placeholder}
      className={className}
      style={style}
    />
  );
}
