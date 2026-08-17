import { readTextFile, writeTextFile } from './tauriCommands';
import { matchingLinesInContent, renameLabelInContent, exactLabelMatcher, LabelMatcher, LabelLineMatch } from './helpers';

export interface IdentMatchCount {
  ident: string;
  count: number;
}

export type LabelMatch = LabelLineMatch;

export interface IdentMatches {
  ident: string;
  matches: LabelMatch[];
}

// Read one track's on-disk annotation file and return its matches (or null if
// the track has no annotation file / no matches). Shared by the one-shot scan
// below and the streaming find-label search.
export async function searchTrackForMatches(
  trackFilePath: string,
  getAnnotationPath: (trackFilePath: string) => string | null,
  getIdent: (trackFilePath: string) => string | null,
  matcher: LabelMatcher,
): Promise<IdentMatches | null> {
  const annotPath = getAnnotationPath(trackFilePath);
  if (!annotPath) return null;
  try {
    const content = await readTextFile(annotPath);
    if (!content) return null;
    const matches = matchingLinesInContent(content, matcher);
    if (matches.length === 0) return null;
    const ident = getIdent(trackFilePath);
    return ident ? { ident, matches } : null;
  } catch {
    // No annotation file for this track — nothing to find.
    return null;
  }
}

// Scan every track's on-disk annotation file for lines whose label satisfies
// `matcher`, returning each match's start/end per ident (idents with no
// matches are omitted), sorted alphabetically by ident. Used to preview a
// mass rename before it's applied.
export async function findLabelOccurrences(
  tracks: string[],
  getAnnotationPath: (trackFilePath: string) => string | null,
  getIdent: (trackFilePath: string) => string | null,
  matcher: LabelMatcher,
): Promise<IdentMatches[]> {
  const settled = await Promise.all(
    tracks.map(t => searchTrackForMatches(t, getAnnotationPath, getIdent, matcher)),
  );
  const results = settled.filter((r): r is IdentMatches => r !== null);
  results.sort((a, b) => a.ident.localeCompare(b.ident));
  return results;
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
// Keyed by the track list it was built from, and invalidated explicitly
// (see invalidateProjectLabelIndex) whenever a file may have changed on disk.
let labelIndex: { key: string; entries: TrackLabels[] } | null = null;

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
  labelIndex = { key, entries: collected };
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

// Scan every track's on-disk annotation file for lines whose label matches
// `text` exactly, returning per-ident occurrence counts (idents with zero
// matches are omitted). Used to preview a mass rename before it's applied.
export async function scanLabelOccurrences(
  tracks: string[],
  getAnnotationPath: (trackFilePath: string) => string | null,
  getIdent: (trackFilePath: string) => string | null,
  text: string,
): Promise<IdentMatchCount[]> {
  const found = await findLabelOccurrences(tracks, getAnnotationPath, getIdent, exactLabelMatcher(text));
  return found.map(f => ({ ident: f.ident, count: f.matches.length }));
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
  await Promise.all(tracks.map(async (t) => {
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
