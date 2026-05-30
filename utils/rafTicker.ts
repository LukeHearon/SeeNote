/**
 * Tiny shared requestAnimationFrame scheduler. Owns the rAF handle so playback
 * engines don't each hand-roll the same start/stop/cancel bookkeeping.
 *
 * The next frame is scheduled *before* the tick callback runs, so a tick that
 * decides to terminate (end-of-selection, EOF, stale play id) can cancel the
 * already-queued next frame simply by calling stop() from inside the callback.
 */
export class RafTicker {
  private handle: number | null = null;

  /** Begin (or restart) the loop, invoking `tick` once per animation frame. */
  start(tick: () => void): void {
    this.stop();
    const loop = () => {
      // Schedule the next frame first so the tick can cancel it via stop().
      this.handle = requestAnimationFrame(loop);
      tick();
    };
    this.handle = requestAnimationFrame(loop);
  }

  /** Cancel the loop. Safe to call when already stopped. */
  stop(): void {
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle);
      this.handle = null;
    }
  }

  get running(): boolean {
    return this.handle !== null;
  }
}
