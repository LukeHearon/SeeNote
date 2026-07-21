// Three-way set-merge of annotation file contents. This is the TypeScript
// mirror of the Rust `set_merge` in
// `src-tauri/src/commands/git_sync/annotate.rs` — the two implementations MUST
// stay in lockstep (see the contract note in `git_sync/mod.rs`). The Rust side
// runs during a git sync/merge; this side runs on the post-pull reload so an
// edit made *while* the sync was in flight is folded back in rather than being
// clobbered by the forced checkout.
//
// Model: each file is an unordered set of records, one per non-empty line.
// Against the common `ancestor`:
//   - a record new on either side (not in ancestor) is kept (union of adds);
//   - a record in ancestor removed on either side is dropped (deletes honored);
//   - a record unchanged on both is kept.
// The result is sorted by leading (tab-delimited) start time, ties broken by
// string compare, with a trailing newline unless the result is empty.
//
// Record identity is a canonical key, not the raw line text: if the first two
// tab fields parse as finite numbers, two lines that differ only in numeric
// precision (`1.234` vs `1.23400`) are the *same* record. This matches the
// canonical-key form the Rust side uses, so a precision-only rewrite never
// reads as a delete-old + add-new.

// Strict finite-number parse of a single field (trimmed). Returns null for
// blank or non-numeric fields, so `"1.2abc"` is not treated as a number (unlike
// parseFloat), mirroring Rust's `str::parse::<f64>()`.
function parseFinite(field: string): number | null {
  const t = field.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Canonical identity key for a record line. When the first two fields are finite
// numbers, the key uses their canonical numeric form (so `1.234` and `1.23400`
// collapse to one record); otherwise the key is the exact line text.
function canonicalKey(line: string): string {
  const fields = line.split('\t');
  const start = fields.length > 0 ? parseFinite(fields[0]) : null;
  const end = fields.length > 1 ? parseFinite(fields[1]) : null;
  if (start !== null && end !== null) {
    const remainder = fields.slice(2).join('\t');
    return `n\t${start}\t${end}\t${remainder}`;
  }
  return `r\t${line}`;
}

// Leading tab field parsed as a start time; non-numeric lines sort last.
function startOf(line: string): number {
  const first = line.split('\t')[0];
  const n = parseFinite(first);
  return n === null ? Infinity : n;
}

// Parse content into a map of canonical key -> representative line text. Blank
// lines (after trimming trailing \r) are skipped; the first occurrence of a key
// wins as that side's representative text.
function recordMap(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r+$/, '');
    if (line.trim() === '') continue;
    const key = canonicalKey(line);
    if (!map.has(key)) map.set(key, line);
  }
  return map;
}

export function setMergeContent(ancestor: string, ours: string, theirs: string): string {
  const a = recordMap(ancestor);
  const o = recordMap(ours);
  const t = recordMap(theirs);

  const kept = new Set<string>();
  for (const key of [...o.keys(), ...t.keys()]) {
    const inA = a.has(key);
    const survives = inA ? (o.has(key) && t.has(key)) : true; // ancestor record: kept only if neither side removed it; new record: an add, keep
    if (survives) kept.add(key);
  }

  // Representation preference: ancestor's text if the key exists there, else
  // theirs, else ours — so a stored `1.23400` is never overwritten by `1.234`.
  const lines: string[] = [];
  for (const key of kept) {
    lines.push(a.get(key) ?? t.get(key) ?? o.get(key)!);
  }
  lines.sort((x, y) => {
    const sx = startOf(x);
    const sy = startOf(y);
    if (sx < sy) return -1;
    if (sx > sy) return 1;
    return x < y ? -1 : x > y ? 1 : 0;
  });

  let out = lines.join('\n');
  if (out.length > 0) out += '\n';
  return out;
}
