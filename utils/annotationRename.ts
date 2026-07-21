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
// matches `oldText` exactly to `newText`. Returns the total number of lines
// changed. Shared by tool rename (useAnnotationTools) and mass rename.
export async function renameLabelAcrossTracks(
  tracks: string[],
  getAnnotationPath: (trackFilePath: string) => string | null,
  oldText: string,
  newText: string,
): Promise<number> {
  let total = 0;
  await Promise.all(tracks.map(async (t) => {
    const annotPath = getAnnotationPath(t);
    if (!annotPath) return;
    try {
      const content = await readTextFile(annotPath);
      if (!content) return;
      const { updated, changed, count } = renameLabelInContent(content, oldText, newText);
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
