import { ReactNode, useRef, useState } from 'react';
import { useHoverReveal } from '../../hooks/useHoverReveal';

export interface HoverRevealProps {
  /** The always-visible icon (or similar) that anchors the reveal. */
  trigger: ReactNode;
  /** Content shown in the floating panel below the trigger while hovered. */
  children: ReactNode;
  helpTarget?: string;
  className?: string;
}

/**
 * Wraps an always-visible trigger with a floating panel that appears below
 * it on hover, closing after a short grace delay (see useHoverReveal) so a
 * sloppy mouse path off the trigger — or off the panel — doesn't dismiss it.
 *
 * The panel is `position: fixed`, not `absolute`: the toolbar sets
 * `overflow-hidden` on itself (so its width-collapse logic can measure
 * overflow), which would clip an absolutely positioned popover too.
 */
export function HoverReveal({ trigger, children, helpTarget, className }: HoverRevealProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const { open, onMouseEnter, onMouseLeave } = useHoverReveal();

  const handleEnter = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setPos({ x: rect.left + rect.width / 2, y: rect.bottom + 6 });
    onMouseEnter();
  };

  return (
    <div ref={anchorRef} className={className} onMouseEnter={handleEnter} onMouseLeave={onMouseLeave} data-help-target={helpTarget}>
      {trigger}
      {open && pos && (
        <div
          className="fixed z-50 bg-slate-800/90 border border-slate-600/60 rounded-lg shadow-lg p-2"
          style={{ left: pos.x, top: pos.y, transform: 'translateX(-50%)' }}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          {children}
        </div>
      )}
    </div>
  );
}
