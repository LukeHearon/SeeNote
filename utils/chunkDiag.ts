// TEMP DIAGNOSTIC — spectrogram chunk integrity. Chasing a bug where a region
// of a very long file (~50h) renders another stretch's spectrogram at one tier:
// it moves with the audio, pops in and out, and clears on a tier switch.
//
// Off by default and costs nothing when off. Toggle from the devtools console
// (`npm run tauri dev`, right-click → Inspect); the setting persists across
// reloads:
//
//   seenoteChunkDiag({ log: true, overlay: true })   // turn on
//   seenoteChunkDiag({ fullRedraw: true })           // also rule out the blit
//   seenoteChunkDiag({})                             // all off
//
//   log        — console line per dispatched request and arriving chunk;
//                console.warn when a chunk's header doesn't match its grid
//                slot or its data is byte-identical to another chunk's
//   overlay    — draws each chunk's boundary on the spectrogram, labelled
//                T<tier> <start time> #<fingerprint>; red when that chunk
//                drew a warning, yellow when it's a fallback tier
//   fullRedraw — rebuild the whole viewport from the cache every frame instead
//                of self-blitting and patching. If the bad patch disappears
//                with this on, the incremental path is at fault, not the data.

export interface ChunkDiagFlags {
  log: boolean;
  overlay: boolean;
  fullRedraw: boolean;
}

const STORAGE_KEY = 'seenote.chunkDiag';

function loadFlags(): ChunkDiagFlags {
  const off = { log: false, overlay: false, fullRedraw: false };
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? { ...off, ...JSON.parse(raw) } : off;
  } catch {
    return off;
  }
}

export const chunkDiag: ChunkDiagFlags = loadFlags();

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).seenoteChunkDiag = (next: Partial<ChunkDiagFlags>) => {
    chunkDiag.log = !!next.log;
    chunkDiag.overlay = !!next.overlay;
    chunkDiag.fullRedraw = !!next.fullRedraw;
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(chunkDiag)); } catch { /* ignore */ }
    return { ...chunkDiag };
  };
}

/** FNV-1a over every value, as 8 hex digits. Identical data ⇒ identical print. */
export function fingerprint(data: Uint16Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface ChunkHeader {
  chunkIndex: number;
  chunkDuration: number;
  expectedFreqBins: number;
  startSec: number;
  nCols: number;
  nFreqBins: number;
  actualDurationSec: number;
  dataLength: number;
}

/** Ways a chunk's own header disagrees with the grid slot it's being stored in. */
export function headerProblems(h: ChunkHeader): string[] {
  const problems: string[] = [];
  const expectedStart = h.chunkIndex * h.chunkDuration;
  if (Math.abs(h.startSec - expectedStart) > 1e-6 * Math.max(1, expectedStart)) {
    problems.push(`startSec ${h.startSec} != index×duration ${expectedStart}`);
  }
  if (h.nFreqBins !== h.expectedFreqBins) {
    problems.push(`nFreqBins ${h.nFreqBins} != ${h.expectedFreqBins}`);
  }
  if (h.dataLength !== h.nCols * h.nFreqBins) {
    problems.push(`data length ${h.dataLength} != nCols×nFreqBins ${h.nCols * h.nFreqBins}`);
  }
  if (h.nCols === 0 || !(h.actualDurationSec > 0)) {
    problems.push(`empty chunk (nCols ${h.nCols}, duration ${h.actualDurationSec})`);
  }
  return problems;
}

export interface ChunkRecord {
  tier: number;
  chunkIndex: number;
  print: string;
  suspect: boolean;
}

/**
 * Remembers every chunk that has arrived, per cache, so a chunk whose data
 * duplicates a different grid slot on the same tier can be flagged. Keyed by
 * the chunk object too, so the overlay can label what it's drawing.
 */
export class ChunkDiagLog {
  private byChunk = new WeakMap<object, ChunkRecord>();
  // tier -> fingerprint -> chunk indices that produced it
  private prints = new Map<number, Map<string, Set<number>>>();

  record(tier: number, chunk: object, data: Uint16Array, header: ChunkHeader): { rec: ChunkRecord; warnings: string[] } {
    const print = fingerprint(data);
    const warnings = headerProblems(header);

    let tierPrints = this.prints.get(tier);
    if (!tierPrints) this.prints.set(tier, tierPrints = new Map());
    let owners = tierPrints.get(print);
    if (!owners) tierPrints.set(print, owners = new Set());
    const others = [...owners].filter(i => i !== header.chunkIndex);
    // All-zero chunks (silence, or a failed decode) legitimately collide.
    if (others.length > 0 && data.some(v => v !== 0)) {
      warnings.push(`data identical to chunk(s) ${others.join(', ')} on this tier`);
    }
    owners.add(header.chunkIndex);

    const rec = { tier, chunkIndex: header.chunkIndex, print, suspect: warnings.length > 0 };
    this.byChunk.set(chunk, rec);
    return { rec, warnings };
  }

  lookup(chunk: object): ChunkRecord | undefined {
    return this.byChunk.get(chunk);
  }
}
