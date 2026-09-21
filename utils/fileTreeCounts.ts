/** How many tracks under a folder there are, and how many of them have each kind of result. */
export interface DirCounts {
  total: number;
  annotated: number;
  buzzdetect: number;
}

/**
 * Per-folder counts derived from a flat track list, keyed by the `/`-joined
 * folder paths the file tree assigns to its nodes. A track counts toward every
 * folder between `rootDir` and itself. Tracks outside `rootDir` are ignored.
 */
export function dirCountsFromFiles(
  rootDir: string,
  files: string[],
  annotatedTracks: Set<string>,
  buzzdetectTracks: Set<string>,
): Map<string, DirCounts> {
  const counts = new Map<string, DirCounts>();
  for (const file of files) {
    if (!file.startsWith(rootDir + '/') && !file.startsWith(rootDir + '\\')) continue;
    const parts = file.substring(rootDir.length + 1).split(/[\\/]/);
    const annotated = annotatedTracks.has(file) ? 1 : 0;
    const buzzdetect = buzzdetectTracks.has(file) ? 1 : 0;
    let path = rootDir;
    for (let i = 0; i < parts.length - 1; i++) {
      path += '/' + parts[i];
      let cur = counts.get(path);
      if (!cur) { cur = { total: 0, annotated: 0, buzzdetect: 0 }; counts.set(path, cur); }
      cur.total += 1;
      cur.annotated += annotated;
      cur.buzzdetect += buzzdetect;
    }
  }
  return counts;
}

/** Counts across the whole list (the header's summary). */
export function totalCounts(files: string[], annotatedTracks: Set<string>, buzzdetectTracks: Set<string>): DirCounts {
  let annotated = 0;
  let buzzdetect = 0;
  for (const f of files) {
    if (annotatedTracks.has(f)) annotated += 1;
    if (buzzdetectTracks.has(f)) buzzdetect += 1;
  }
  return { total: files.length, annotated, buzzdetect };
}
