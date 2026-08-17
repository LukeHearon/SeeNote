import { readTextFile, writeTextFile } from './tauriCommands';
import { matchingLinesInContent, renameLabelInContent, LabelMatcher, LabelLineMatch } from './helpers';

export type LabelMatch = LabelLineMatch;

export interface IdentMatches {
  ident: string;
  matches: LabelMatch[];
}

// Every annotation of one track, as read from its file — the unit the project
// label index is built from.
export interface TrackLabels {
  trackFilePath: string;
  ident: string;
  labels: LabelMatch[];
}

// Whole-project label index: every track's annotations held in memory so a
// project-wide find filters locally instead of re-reading the project off disk
// on every keystroke or option toggle. Annotation files are tiny (a large
// project is a few hundred KB in total), so the whole set is cheap to hold.
//
// Disk stays authoritative. This is a read cache and nothing else: it answers
// "which idents are worth looking at", and every write path re-reads the file
// it's about to change. A stale entry can therefore cost a wasted read or show
// a search hit that no longer exists — it can never produce a wrong write.
//
// The currently-open track is never served from here (callers overlay its
// in-memory annotations), so ordinary editing and auto-save don't touch the
// index. That leaves exactly four ways another track's file changes under it,
// and each one invalidates:
//   1. a rename across tracks       — renameLabelAcrossTracks, below
//   2. importing into another track — hooks/useImportAnnotations
//   3. a git sync pull              — the reloadNonce effect in AnnotationWindow
//   4. switching tracks             — handleOpenTrack (flushes the outgoing
//      track, and is also the catch-all for edits made outside the app)
let labelIndex: { key: string; universe: Set<string>; entries: TrackLabels[] } | null = null;

export function invalidateProjectLabelIndex(): void {
  labelIndex = null;
}

const matchAll: LabelMatcher = () => true;

async function readTrackLabels(
  trackFilePath: string,
  getAnnotationPath: (trackFilePath: string) => string | null,
  getIdent: (trackFilePath: string) => string | null,
): Promise<TrackLabels | null> {
  const annotPath = getAnnotationPath(trackFilePath);
  const ident = getIdent(trackFilePath);
  if (!annotPath || !ident) return null;
  try {
    const content = await readTextFile(annotPath);
    if (!content) return null;
    return { trackFilePath, ident, labels: matchingLinesInContent(content, matchAll) };
  } catch {
    // No annotation file for this track — nothing to index.
    return null;
  }
}

// Hand every track's annotations to `onTrack`, in `tracks` order. Served from
// the in-memory index when it covers exactly this track list; otherwise read
// from disk (streaming, so a first build reports as it goes) and cached. A
// cancelled build is not cached — a partial index would read as complete.
export async function loadProjectLabels(
  tracks: string[],
  getAnnotationPath: (trackFilePath: string) => string | null,
  getIdent: (trackFilePath: string) => string | null,
  onTrack: (entry: TrackLabels) => void,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const key = tracks.join('\n');
  if (labelIndex && labelIndex.key === key) {
    for (const entry of labelIndex.entries) {
      if (isCancelled()) return;
      onTrack(entry);
    }
    return;
  }
  const collected: TrackLabels[] = [];
  await streamSearch(
    tracks,
    (t) => readTrackLabels(t, getAnnotationPath, getIdent),
    (entry) => { collected.push(entry); onTrack(entry); },
    isCancelled,
  );
  if (isCancelled()) return;
  labelIndex = { key, universe: new Set(tracks), entries: collected };
}

// Number of tracks searched concurrently per batch in streamSearch. Bounds
// how many annotation files are read in parallel for a large project while
// still streaming results in well before the whole scan finishes.
const SEARCH_CONCURRENCY = 12;

// Search `items` in fixed-size concurrent batches, calling `onFound` with
// each match as its batch resolves. Batches run strictly in order — batch N
// always finishes (and reports) before batch N+1 starts — so as long as
// `items` is pre-sorted, results stream in in that same order and never
// reorder once shown. `isCancelled` is checked between batches so a
// superseded search (e.g. the user typed again) stops without wasting reads.
export async function streamSearch<T>(
  items: string[],
  searchOne: (item: string) => Promise<T | null>,
  onFound: (result: T) => void,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  for (let i = 0; i < items.length; i += SEARCH_CONCURRENCY) {
    if (isCancelled()) return;
    const batch = items.slice(i, i + SEARCH_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(searchOne));
    if (isCancelled()) return;
    for (const r of batchResults) {
      if (r !== null) onFound(r);
    }
  }
}

// Narrow `tracks` to the ones the in-memory index says contain a match, so a
// rename opens only the files it might actually rewrite. Returns `tracks`
// unchanged unless the index has seen every track asked about — a miss must
// fall back to opening everything, never to renaming nothing. (The rename
// callers pass a subset of the indexed project: every track but the open one.)
//
// The index only points at candidates; the rename below still re-reads each
// one from disk and decides what to write from that content. Disk stays
// authoritative, so a stale index can at worst cost a wasted read.
export function candidateTracks(tracks: string[], matcher: LabelMatcher): string[] {
  const index = labelIndex;
  if (!index || !tracks.every(t => index.universe.has(t))) return tracks;
  const hits = new Set(
    index.entries
      .filter(e => e.labels.some(l => matcher(l.label)))
      .map(e => e.trackFilePath),
  );
  return tracks.filter(t => hits.has(t));
}

// Rewrite every track's on-disk annotation file, renaming lines whose label
// satisfies `matcher` to `newText`. Returns the total number of lines
// changed. Shared by tool rename (useAnnotationTools) and the find/rename
// dialog — pass `exactLabelMatcher(oldText)` for an exact rename, or a
// regex/partial matcher to rename every match to one new label.
export async function renameLabelAcrossTracks(
  tracks: string[],
  getAnnotationPath: (trackFilePath: string) => string | null,
  matcher: LabelMatcher,
  newText: string,
): Promise<number> {
  let total = 0;
  // This rewrites annotation files, so whatever the index holds for them is
  // about to be wrong.
  const candidates = candidateTracks(tracks, matcher);
  invalidateProjectLabelIndex();
  await Promise.all(candidates.map(async (t) => {
    const annotPath = getAnnotationPath(t);
    if (!annotPath) return;
    try {
      const content = await readTextFile(annotPath);
      if (!content) return;
      const { updated, changed, count } = renameLabelInContent(content, matcher, newText);
      if (changed) {
        await writeTextFile(annotPath, updated);
        total += count;
      }
    } catch {
      // No annotation file for this track — nothing to update.
    }
  }));
  return total;
}
