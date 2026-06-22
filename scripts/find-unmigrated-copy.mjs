#!/usr/bin/env node
// Heuristic scanner for user-facing copy that hasn't been migrated into copy/.
// Builds the set of already-migrated default strings from copy/*.ts, then scans
// components/ for candidate strings (attributes + JSX text) not in that set.
// Output is a worklist, not a verdict — eyeball each hit.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const COPY_DIR = join(ROOT, 'copy');
const SCAN_DIRS = ['components', 'App.tsx'].map((p) => join(ROOT, p));

// Attributes whose string-literal values are user-facing copy.
const COPY_ATTRS = ['data-tooltip', 'title', 'placeholder', 'aria-label', 'alt', 'label'];

function walk(path, out = []) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const e of readdirSync(path)) walk(join(path, e), out);
  } else if (/\.(tsx?|jsx?)$/.test(path)) {
    out.push(path);
  }
  return out;
}

// 1. Collect migrated defaults: every "..." and `...` literal in copy/*.ts.
const migrated = new Set();
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
for (const f of readdirSync(COPY_DIR).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(COPY_DIR, f), 'utf8');
  for (const m of src.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g)) {
    const v = (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ''); // drop template holes
    if (v.trim()) migrated.add(norm(v));
  }
}

// A string looks like copy if it has a letter and a space or sentence punctuation,
// OR is a multi-word capitalized phrase. Filters out classNames, ids, paths, enums.
// PascalCase identifiers that are TS types, not copy (leak via the JSX-text regex
// matching `>Promise<` inside generics like `Foo<X | Promise>`).
const TYPE_TOKENS = new Set(['Promise', 'ReactNode', 'ReactElement', 'Record', 'Partial', 'Array', 'Map', 'Set']);

function looksLikeCopy(s) {
  const t = s.trim();
  if (t.length < 3) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  if (/^[A-Za-z]+(\s*\|\s*[A-Za-z]+)*$/.test(t) && t.split(/\s*\|\s*/).every((w) => TYPE_TOKENS.has(w))) return false;
  if (/^[a-z0-9_-]+$/.test(t)) return false;                 // single token / kebab / snake
  if (/[/\\]|^\w+\.\w+$|^#|^\.|^https?:/.test(t)) return false; // paths, files, urls, css
  if (/^[a-z-]+(\s[a-z0-9-]+)*$/.test(t) && !/[.!?]/.test(t)) return false; // className lists
  return /\s/.test(t) || /[.!?]$/.test(t) || /^[A-Z]/.test(t);
}

const hits = [];
for (const dir of SCAN_DIRS) {
  let files;
  try { files = walk(dir); } catch { continue; }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const rel = relative(ROOT, file);

    // a) copy-bearing attributes with string-literal values
    const attrRe = new RegExp(`(${COPY_ATTRS.join('|')})=("([^"]+)"|'([^']+)')`, 'g');
    // b) JSX text children: >Some words< (no tags/braces inside)
    const textRe = />\s*([A-Z][^<>{}\n]{2,}?)\s*</g;

    for (const re of [attrRe, textRe]) {
      for (const m of src.matchAll(re)) {
        const val = m[3] ?? m[4] ?? m[1];
        if (!val || !looksLikeCopy(val)) continue;
        if (migrated.has(norm(val))) continue;
        const lineNo = src.slice(0, m.index).split('\n').length;
        hits.push({ rel, lineNo, val: val.trim() });
      }
    }
  }
}

hits.sort((a, b) => a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo);
const seen = new Set();
for (const h of hits) {
  const key = `${h.rel}:${h.lineNo}:${h.val}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`${h.rel}:${h.lineNo}\t${h.val}`);
}
console.error(`\n${seen.size} candidate string(s) not found in copy/ (migrated set: ${migrated.size}).`);
