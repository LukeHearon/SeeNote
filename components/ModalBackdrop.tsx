import React from 'react';
import { Z } from '../constants';
import { useEscapeKey } from '../hooks/useEscapeKey';

interface Props {
  /** Escape (and, with `dismissOnBackdrop`, a click outside) calls this. */
  onDismiss?: () => void;
  /** Close on a press that starts on the backdrop itself. Off for forms, where
   *  a stray click would throw away what was typed. */
  dismissOnBackdrop?: boolean;
  /** Stacking tier (see Z in constants.ts). */
  layer?: keyof typeof Z;
  children: React.ReactNode;
}

/**
 * The dimmed, centred overlay every modal and dialog sits in. One definition
 * of how they stack and how they dismiss.
 */
export default function ModalBackdrop({ onDismiss, dismissOnBackdrop = false, layer = 'modal', children }: Props) {
  useEscapeKey(onDismiss);
  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center p-4"
      style={{ zIndex: Z[layer] }}
      onMouseDown={dismissOnBackdrop && onDismiss ? e => { if (e.target === e.currentTarget) onDismiss(); } : undefined}
    >
      {children}
    </div>
  );
}
