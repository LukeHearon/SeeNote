import { whenWritesSettled } from './annotationPersist';

// Writes that must land before the window closes or a view unmounts: pending
// debounced saves (annotations, preferences). Each flusher runs its pending
// write now; `flushForExit` waits for all of them and for the annotation write
// queue to drain.
type Flusher = () => Promise<unknown> | void;
const flushers = new Set<Flusher>();

export function registerExitFlusher(flush: Flusher): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushForExit(): Promise<void> {
  await Promise.allSettled([...flushers].map(f => f()));
  await whenWritesSettled();
}
