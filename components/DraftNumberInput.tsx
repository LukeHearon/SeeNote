import React from 'react';
import { useDraftField } from '../hooks/useDraftField';

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
  /** Hover tooltip text (see components/TooltipLayer.tsx). */
  tooltip?: string;
}

/**
 * Controlled numeric input that lets the user type freely — including
 * clearing the field to retype — and only commits a parsed value on blur or
 * Enter (Escape discards the edit). Validating on every keystroke (e.g. rejecting an empty string as
 * NaN) makes it impossible to backspace and re-enter a value.
 */
export default function DraftNumberInput({ value, onCommit, className, style, min, allowEmpty, placeholder, tooltip }: Props) {
  const asText = (v: number | null) => (v === null ? '' : String(v));
  // An invalid commit just ends the edit, so the field falls back to `value`.
  const draft = useDraftField((_, raw) => {
    if (allowEmpty && raw.trim() === '') { onCommit(null); return; }
    const v = parseFloat(raw);
    if (!isNaN(v) && (min === undefined || v >= min)) onCommit(v);
  }, { stopPropagation: true });
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft.editing ? draft.raw : asText(value)}
      onFocus={() => draft.begin('value', asText(value))}
      {...draft.fieldProps()}
      placeholder={placeholder}
      className={className}
      style={style}
      data-tooltip={tooltip}
    />
  );
}
