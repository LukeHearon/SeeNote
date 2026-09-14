import React from 'react';

// Custom "unassign hotkey" glyph: a U-turn arch with a filled arrowhead
// dropping off the right leg — the tool lifting up and back off its key. Kept
// compact and centred (rather than a corner-to-corner diagonal) with a solid
// arrowhead so it stays legible at the 10–12px size the toolbars use. Drawn to
// match lucide-react's conventions (24-unit grid, 2px round stroke,
// currentColor).
export default function UnassignHotkeyIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 14v-3a6 6 0 0 1 12 0v1" />
      <path d="M14 11 18 18l4-7Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
