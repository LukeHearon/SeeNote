import React, { useState, useEffect } from 'react';

interface Props {
  value: number;
  onCommit: (v: number) => void;
  className?: string;
  style?: React.CSSProperties;
  /** Reject (and revert) committed values below this. */
  min?: number;
}

/**
 * Controlled numeric input that lets the user type freely — including
 * clearing the field to retype — and only commits a parsed value on blur or
 * Enter. Validating on every keystroke (e.g. rejecting an empty string as
 * NaN) makes it impossible to backspace and re-enter a value.
 */
export default function DraftNumberInput({ value, onCommit, className, style, min }: Props) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const v = parseFloat(draft);
    if (!isNaN(v) && (min === undefined || v >= min)) onCommit(v);
    else setDraft(String(value));
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
      className={className}
      style={style}
    />
  );
}
