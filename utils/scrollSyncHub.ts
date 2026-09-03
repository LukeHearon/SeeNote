// Per-frame scroll broadcast for the spectrogram's HTML overlay layers.
//
// The canvases redraw from `scrollLeftRef` inside Spectrogram's rAF loop, so
// they track the view at frame rate. Anything drawn in HTML (annotation boxes,
// selection handles) used to take the scroll as a React prop instead, which
// means it only moved when React committed a render of the spectrogram subtree
// — on a slow machine every 2-4 frames, and always after the canvas had already
// moved. The result was a spectrogram that glided under labels that stepped.
//
// So HTML layers move the same way the canvases do: they lay out in content
// pixels (time × pixelsPerSecond) and register a sync here; the rAF loop runs
// the hub once per frame with the live scroll, and each layer translates itself
// with one transform. Same clock, same frame, no React work.

export type ScrollSync = (scrollLeft: number, force?: boolean) => void;

export interface ScrollSyncHub {
  /** Subscribe a layer's sync. Returns the unsubscribe. */
  register(sync: ScrollSync): () => void;
  /** Drive every registered layer. `force` re-applies even if scroll is unchanged. */
  run(scrollLeft: number, force?: boolean): void;
}

export const createScrollSyncHub = (): ScrollSyncHub => {
  const syncs = new Set<ScrollSync>();
  return {
    register: (sync) => {
      syncs.add(sync);
      return () => { syncs.delete(sync); };
    },
    run: (scrollLeft, force) => {
      syncs.forEach(sync => sync(scrollLeft, force));
    },
  };
};
