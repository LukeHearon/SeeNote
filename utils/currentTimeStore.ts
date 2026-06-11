// Ref-based pub/sub for the playback head's current time (seconds).
//
// Playback emits a time update ~50 times per second (every engine
// onTimeUpdate tick). Routing that through React state in AnnotationWindow
// re-renders the entire window tree per tick (Toolbar, Spectrogram, panels),
// which stutters during playback. Instead the playback orchestrator writes the
// current time here and canvas consumers (the spectrogram playhead/overlay, the
// buzzdetect panel, the toolbar time readout) subscribe and redraw imperatively
// — so a playback tick triggers no React render of the window tree.
//
// The stored value is set ONLY from the media clock (engine onTimeUpdate / seek),
// exactly where the old React state was set — never from a wall clock or timer.
// Consumers read it at draw time, so the playhead position is always the same
// number the media clock produced this frame, preserving the cornerstone
// time-axis-synchrony invariant.

export interface CurrentTimeStore {
  get(): number;
  set(t: number): void;
  subscribe(listener: () => void): () => void;
}

export function createCurrentTimeStore(): CurrentTimeStore {
  let current = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (t: number) => {
      if (t === current) return;
      current = t;
      listeners.forEach(l => l());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
