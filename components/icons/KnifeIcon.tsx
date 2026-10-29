import React from 'react';

// Custom chef's-knife glyph for the Knife (Shift+K): a long blade with a
// straight spine running out to the tip, a tall heel, and a belly that curves
// to meet the spine, plus a separate, slimmer handle. Filled rather than
// stroked — stroked versions (lucide's Slice included) read as a brush at the
// 12–16px it's drawn at. Drawn horizontally, then turned so the handle is up
// on the right and the point is down on the left, cutting edge facing down.
// 24-unit grid and currentColor, like lucide-react.
export default function KnifeIcon({ size = 24, className, style }: { size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {/* Horizontal glyph (centred on y=11.2), flipped so the edge faces up,
          then rotated 135° about its centre: point down-left, edge down. */}
      <g transform="translate(0 0.8) rotate(135 12 11.2) translate(0 22.4) scale(1 -1)">
        <path d="M7.2 8 L23.6 8 L23.6 8.6 C21 12.8 17 14.4 12 14.4 L7.2 14.4 Z" />
        <rect x="0.4" y="8.4" width="5.8" height="3.8" rx="1.4" />
      </g>
    </svg>
  );
}
