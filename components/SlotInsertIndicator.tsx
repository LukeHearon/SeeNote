import { ChevronUp, ChevronDown } from 'lucide-react';
import type { InsertDirection } from '../utils/hotkeySlotDrag';

// "Put between" preview for hotkey-slot drags: a blue line centred in the gap
// below (or, for the gap above the first slot, above) the row it's rendered
// in, with a chevron showing which way the neighbouring tools will be bumped.
// The row must be `relative`; `gapPx` is the space between rows.
// z-20 sits above the drag ghosts (SlotGhost, z-10), which can cover the gap's
// neighbouring rows. The rows themselves set no z-index, so these compete directly.
export default function SlotInsertIndicator({ direction, gapPx, above = false }: { direction: InsertDirection; gapPx: number; above?: boolean }) {
  const Chevron = direction === 'up' ? ChevronUp : ChevronDown;
  return (
    <div
      className="slot-ghost absolute inset-x-0 h-0.5 bg-blue-500 rounded-full pointer-events-none z-20 flex items-center justify-center"
      style={above ? { top: -gapPx / 2 - 1 } : { top: `calc(100% + ${gapPx / 2}px - 1px)` }}
    >
      <span className="bg-blue-500 rounded-full text-white flex items-center justify-center w-3.5 h-3.5">
        <Chevron size={10} strokeWidth={3} />
      </span>
    </div>
  );
}
