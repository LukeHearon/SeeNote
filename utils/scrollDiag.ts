// Flip to true to trace everything that can move the view sideways: every
// scroll write (tagged with its source), every ResizeObserver notification with
// the exact widths involved, every wheel event, every zoom-prop change, and a
// 250ms heartbeat of the live geometry. Kept because this file has now grown
// two separate self-sustaining scroll loops (the "violent jitter" oscillation
// and the compounding resize rescale), and the source tags are what identify
// them; the heartbeat separates "something keeps writing scroll" from "scroll
// is still but the render drifts". Each call site is guarded by the constant so
// the trace strings cost nothing when it's off.
export const DIAG_SCROLL = false;
const diagT0 = typeof performance !== 'undefined' ? performance.now() : 0;
// Cap so a long session can't fill the console with megabytes of trace.
let diagCount = 0;
export const diag = (msg: string) => {
  if (!DIAG_SCROLL || diagCount > 3000) return;
  diagCount++;
  // eslint-disable-next-line no-console
  console.log(`[scrolldiag +${((performance.now() - diagT0) / 1000).toFixed(3)}s] ${msg}`);
};
