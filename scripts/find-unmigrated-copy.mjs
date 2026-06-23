#!/usr/bin/env node
// Scanner for user-facing copy that hasn't been migrated into copy/.
//
// Migrated copy is ALWAYS referenced as `{namespace.key}` — a JSX expression with
// no string literal in it. So the signal for "unmigrated" is structural, not
// value-based: any copy-bearing attribute whose value contains a quoted/backtick
// literal, or any JSX text node that's a literal, is unmigrated. We deliberately
// do NOT check against the strings already in copy/ — a string can be migrated in
// one place and still hardcoded in another (that's exactly how the git-sync button
// tooltip slipped through).
//
// Output is a worklist. Attribute hits are exhaustive (trust them); JSX-text hits
// use a heuristic to filter out code, so eyeball those.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// Scan every .tsx/.jsx in the repo (root-level windows like AnnotationWindow.tsx
// live outside components/). Skip build output, deps, and the copy editor devtool.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'src-tauri', '.git', '.claude', 'tests']);
const SKIP_FILES = new Set(['CopyEditor.tsx']);

// Attributes whose values are user-facing copy.
const COPY_ATTRS = ['data-tooltip', 'title', 'placeholder', 'aria-label', 'alt'];

function walk(path, out = []) {
  const st = statSync(path);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.split('/').pop())) return out;
    for (const e of readdirSync(path)) walk(join(path, e), out);
  } else if (/\.(tsx|jsx)$/.test(path) && !SKIP_FILES.has(path.split('/').pop())) {
    out.push(path);
  }
  return out;
}

// Pull every string literal ("..." / '...' / `...`) out of a snippet of attribute
// value. Returns the human-meaningful ones (containing a letter).
function literalsIn(s) {
  const out = [];
  for (const m of s.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const v = (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, '').replace(/\\(.)/g, '$1').trim();
    if (!/[a-zA-Z]{2,}/.test(v)) continue;
    if (/(\s[?:]\s|&&|\|\||===|=>|\?\s*$|^\s*:)/.test(v)) continue; // code fragment from a ternary
    out.push(v);
  }
  return out;
}

// JSX-text heuristic: filter out code tokens, types, classNames, paths.
const TYPE_TOKENS = new Set(['Promise', 'ReactNode', 'ReactElement', 'Record', 'Partial', 'Array', 'Map', 'Set']);
function looksLikeCopy(s) {
  const t = s.trim();
  if (t.length < 3 || !/[a-zA-Z]/.test(t)) return false;
  if (t.split(/\s*\|\s*/).every((w) => TYPE_TOKENS.has(w))) return false;
  if (/^[a-z0-9_-]+$/.test(t)) return false;
  if (/[/\\]|^\w+\.\w+$|^#|^\.|^https?:/.test(t)) return false;
  if (/^[a-z-]+(\s[a-z0-9-]+)*$/.test(t) && !/[.!?]/.test(t)) return false;
  return /\s/.test(t) || /[.!?]$/.test(t) || /^[A-Z]/.test(t);
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

const attrHits = [];
const textHits = [];
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);

  // a) Attributes. Match `attr=` then capture the value, whether "...", '...',
  //    or a {...} expression (ternaries, templates). Flag any literal inside.
  const attrRe = new RegExp(`\\b(${COPY_ATTRS.join('|')})=("[^"]*"|'[^']*'|\\{[^}]*\\})`, 'g');
  for (const m of src.matchAll(attrRe)) {
    for (const lit of literalsIn(m[2])) {
      attrHits.push({ rel, lineNo: lineOf(src, m.index), attr: m[1], val: lit });
    }
  }

  // b) JSX text children: >Some words<
  const textRe = />\s*([A-Z][^<>{}\n]{2,}?)\s*</g;
  for (const m of src.matchAll(textRe)) {
    if (looksLikeCopy(m[1])) {
      textHits.push({ rel, lineNo: lineOf(src, m.index), val: m[1].trim() });
    }
  }
}

const dedupe = (arr) => {
  const seen = new Set();
  return arr.filter((h) => {
    const k = `${h.rel}:${h.lineNo}:${h.val}`;
    return seen.has(k) ? false : seen.add(k);
  });
};
const sortFn = (a, b) => a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo;
const attrs = dedupe(attrHits).sort(sortFn);
const texts = dedupe(textHits).sort(sortFn);

console.log(`# Attribute copy (${COPY_ATTRS.join(', ')}) — exhaustive\n`);
for (const h of attrs) console.log(`${h.rel}:${h.lineNo}\t[${h.attr}]\t${h.val}`);
console.log(`\n# JSX text children — heuristic, eyeball\n`);
for (const h of texts) console.log(`${h.rel}:${h.lineNo}\t${h.val}`);
console.error(`\n${attrs.length} attribute literal(s), ${texts.length} JSX-text candidate(s).`);
