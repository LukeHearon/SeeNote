import React from 'react';

interface ToolCellProps {
  isActive: boolean;
  color: string;
  dotColor: string;
  label: string;
  onClick: () => void;
  /** Mono text shown at the trailing edge. Ignored when `trailing` is given. */
  hotkey?: string;
  /** Arbitrary trailing content (e.g. an editable value plus a toggle). */
  trailing?: React.ReactNode;
  dotted?: boolean;
  tooltip?: string;
  /** Makes the color dot its own click target (e.g. to open a color picker). */
  onDotClick?: () => void;
  dotTooltip?: string;
  /** Draws the dot as an outline rather than a filled disc (e.g. "not plotted"). */
  dotHollow?: boolean;
}

// Compact palette cell, shared by the annotation-tool palette and the neuron
// palette.  Always renders w-full — callers are responsible for constraining
// the container width.
//
// The root is a div with a full-bleed button *behind* the content, rather than
// a button wrapping it: cells carry their own interactive bits (a color swatch
// that opens a picker, an editable threshold field), and those can't legally be
// nested inside a button. The content layer is pointer-transparent, so the
// activate click still lands anywhere on the cell; anything needing its own
// clicks opts back in with `pointer-events-auto`.
function ToolCell({
  isActive, color, dotColor, label, hotkey, onClick, dotted, tooltip, onDotClick, dotTooltip, dotHollow, trailing,
}: ToolCellProps) {
  // Hollow: the color moves from the fill to the ring, so an off dot still says
  // which neuron it belongs to at a glance.
  const dotStyle: React.CSSProperties = dotHollow
    ? { backgroundColor: 'transparent', boxShadow: `inset 0 0 0 1.5px ${dotColor}` }
    : { backgroundColor: dotColor };
  return (
    <div
      className={`relative w-full px-1.5 py-1 rounded text-xs transition-all border
        ${isActive ? 'opacity-100' : 'opacity-60 hover:opacity-100'}
        ${dotted ? 'border-dashed' : 'border-transparent hover:border-slate-600'}`}
      style={{
        backgroundColor: isActive ? color + '40' : color + '18',
        // dotted: brighten border when active instead of adding a ring
        borderColor: dotted
          ? (isActive ? 'rgba(255,255,255,0.6)' : '#6b7280')
          : (isActive ? color : undefined),
      }}
      data-tooltip={tooltip ? `${label}\n${tooltip}` : label}
    >
      <button onClick={onClick} aria-label={label} className="absolute inset-0 w-full h-full rounded" />
      <div className="relative flex items-center gap-1.5 pointer-events-none">
        {onDotClick ? (
          <button
            onClick={onDotClick}
            className="pointer-events-auto w-2.5 h-2.5 rounded-full flex-none ring-1 ring-white/25 hover:ring-white/70 transition-all"
            style={dotStyle}
            data-tooltip={dotTooltip}
          />
        ) : (
          <span className="w-2 h-2 rounded-full flex-none" style={dotStyle} />
        )}
        <span className="flex-1 min-w-0 truncate text-left text-slate-100 leading-tight">{label}</span>
        {trailing ?? <span className="font-mono text-slate-500 text-[10px] flex-none">{hotkey}</span>}
      </div>
    </div>
  );
}

export default ToolCell;
