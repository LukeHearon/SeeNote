// Drop-target outline for a hotkey slot: a blue ring laid over the row's
// content, above any ghost there (SlotGhost is z-10) so a swap target still
// reads as targeted while it shows the incoming tool. The row must be
// `relative`; `leftPx` skips past its digit badge.
export default function SlotTargetRing({ leftPx }: { leftPx: number }) {
  return (
    <div
      className="slot-ghost absolute inset-y-0 right-0 z-20 pointer-events-none rounded"
      style={{ left: leftPx, outline: '2px solid #3b82f6' }}
    />
  );
}
