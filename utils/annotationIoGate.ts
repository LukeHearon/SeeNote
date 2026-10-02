/**
 * Tracks work that may rewrite the open track's annotation file behind the
 * user's back (a git sync/pull, and the annotation reload that follows it) so a
 * track switch can wait for it to finish instead of racing it.
 *
 * Without this, switching tracks mid-sync flushed the old track to disk while
 * the sync's forced checkout was about to revert it, and then the switch aborted
 * the post-pull merge that would have folded the edit back in.
 *
 * Operations are counted: `begin()` returns an `end` function (idempotent).
 * `settle()` resolves once nothing is running — including operations that began
 * while it was waiting.
 */
export class AnnotationIoGate {
  private active = 0;
  private waiters: Array<() => void> = [];
  private pendingReloads: Array<() => void> = [];

  begin(): () => void {
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.active === 0) {
        const w = this.waiters;
        this.waiters = [];
        for (const r of w) r();
      }
    };
  }

  get busy(): boolean {
    return this.active > 0;
  }

  async settle(): Promise<void> {
    while (this.active > 0) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }

  /**
   * A reload has been requested but the React effect that performs it hasn't
   * run yet. Counts as busy until `claimReloads()` (the effect starting) or
   * `expireMs` passes, so a request the effect never services (no open track)
   * cannot hang a waiter.
   */
  requestReload(expireMs = 3000): void {
    const end = this.begin();
    const release = () => {
      clearTimeout(timer);
      this.pendingReloads = this.pendingReloads.filter(r => r !== release);
      end();
    };
    const timer = setTimeout(release, expireMs);
    this.pendingReloads.push(release);
  }

  /** The reload effect has started (and has begun its own operation). */
  claimReloads(): void {
    for (const release of [...this.pendingReloads]) release();
  }
}
