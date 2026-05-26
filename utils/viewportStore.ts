// Ref-based pub/sub for the spectrogram's time→pixel transform.
//
// Panning the spectrogram updates scrollLeft every frame. Routing that through
// React state in AnnotationWindow re-renders the entire window tree per frame,
// which stutters once the buzzdetect panel is mounted. Instead the spectrogram
// writes the viewport here and the panel subscribes, redrawing its canvas
// imperatively — so a pan triggers no React render outside the spectrogram
// itself. The values stay in exact lockstep with the spectrogram (same numbers,
// same frame), preserving time-axis synchrony.

export interface Viewport {
  scrollLeft: number;
  pixelsPerSecond: number;
  containerWidth: number;
}

export interface ViewportStore {
  get(): Viewport;
  set(v: Viewport): void;
  subscribe(listener: () => void): () => void;
}

export function createViewportStore(): ViewportStore {
  let current: Viewport = { scrollLeft: 0, pixelsPerSecond: 100, containerWidth: 0 };
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (v: Viewport) => {
      if (
        v.scrollLeft === current.scrollLeft &&
        v.pixelsPerSecond === current.pixelsPerSecond &&
        v.containerWidth === current.containerWidth
      ) {
        return;
      }
      current = v;
      listeners.forEach(l => l());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
