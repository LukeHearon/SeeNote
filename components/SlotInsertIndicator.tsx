import { ChevronUp, ChevronDown } from 'lucide-react';
import type { InsertDirection } from '../utils/hotkeySlotDrag';

// "Put between" preview for hotkey-slot drags: a blue line centred in the gap
// below the row it's rendered in, with a chevron showing which way the
// neighbouring tools will be bumped. The row must be `relative`; `gapPx` is the
// space between it and the next row.
export default function SlotInsertIndicator({ direction, gapPx }: { direction: InsertDirection; gapPx: number }) {
  const Chevron = direction === 'up' ? ChevronUp : ChevronDown;
  return (
    <div
      className="absolute inset-x-0 h-0.5 bg-blue-500 rounded-full pointer-events-none z-10 flex items-center justify-center"
      style={{ top: `calc(100% + ${gapPx / 2}px - 1px)` }}
    >
      <span className="bg-blue-500 rounded-full text-white flex items-center justify-center w-3.5 h-3.5">
        <Chevron size={10} strokeWidth={3} />
      </span>
    </div>
  );
}
