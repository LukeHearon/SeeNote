import { clamp } from './helpers';

// ---------------------------------------------------------------------------
// Coarse scrub: the plain-arrow jump used when there is no selection to work
// against. A fixed fraction of the visible window, so it means the same thing
// at every zoom level.
// ---------------------------------------------------------------------------

export function scrubStep(zoomSec: number): number {
  return zoomSec * 0.1;
}

export function scrubTarget(current: number, duration: number, zoomSec: number, direction: -1 | 1): number {
  return clamp(current + direction * scrubStep(zoomSec), 0, duration);
}

// ---------------------------------------------------------------------------
// Fine ramp: how a held arrow key moves once a selection is in play, where the
// coarse jump is far too blunt. A tap moves one pixel; holding accelerates,
// the same shape as the drag auto-pan's time ramp (useSpectrogramInteraction) —
// slow enough to place an edge exactly, then quick enough to cross a long file.
// ---------------------------------------------------------------------------

/** Grace period before a held key starts moving, so a tap stays a single pixel. */
const RAMP_DELAY_SEC = 0.25;
/** Opening speed once the ramp engages: 1px per frame at 60fps. */
const RAMP_BASE_PX_PER_SEC = 60;
const RAMP_ACCEL = 3;
const RAMP_MAX_PX_PER_SEC = 700;

/** Pixels per second a key held for `heldSec` should move. Zero during the grace period. */
export function rampVelocityPx(heldSec: number): number {
  if (heldSec < RAMP_DELAY_SEC) return 0;
  const t = heldSec - RAMP_DELAY_SEC;
  return Math.min(RAMP_BASE_PX_PER_SEC * (1 + t * t * RAMP_ACCEL), RAMP_MAX_PX_PER_SEC);
}
