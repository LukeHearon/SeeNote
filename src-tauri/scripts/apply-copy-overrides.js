#!/usr/bin/env node
// Reads { key: newValue } JSON from stdin.
// For each key, rewrites the ?? "default" in the matching copy/*.ts source file.
// Run by the dev-only Copy Editor's Commit (`apply_copy_overrides` in
// src-tauri/src/commands/filesystem.rs).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const FILE_MAP = {
  ui: path.join(repoRoot, 'copy', 'ui.ts'),
  tooltips: path.join(repoRoot, 'copy', 'tooltips.ts'),
  help: path.join(repoRoot, 'copy', 'help.ts'),
};

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let overrides;
  try {
    overrides = JSON.parse(input);
  } catch (e) {
    process.stderr.write(`Failed to parse input JSON: ${e.message}\n`);
    process.exit(1);
  }

  const contents = {};
  const changed = new Set();
  const skipped = [];

  for (const [key, newValue] of Object.entries(overrides)) {
    const prefix = key.split('.')[0];
    const filePath = FILE_MAP[prefix];
    if (!filePath) {
      skipped.push(`${key}: unknown prefix "${prefix}"`);
      continue;
    }

    if (!(filePath in contents)) {
      contents[filePath] = fs.readFileSync(filePath, 'utf8');
    }

    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The default is a double-quoted literal that may itself hold escapes
    // (\" or \n), so match escape sequences whole rather than stopping at the
    // first quote. JSON.stringify writes a valid literal for any new value, and
    // the replacement is a function so a `$` in the value isn't read as a group.
    const re = new RegExp(
      `(getOverride\\('${escaped}'\\)\\s*\\?\\?\\s*)"(?:[^"\\\\]|\\\\.)*"`,
      'g',
    );
    const literal = JSON.stringify(newValue);
    const next = contents[filePath].replace(re, (_, lead) => lead + literal);

    if (next === contents[filePath]) {
      skipped.push(`${key}: no match found in source`);
    } else {
      contents[filePath] = next;
      changed.add(filePath);
    }
  }

  for (const filePath of changed) {
    fs.writeFileSync(filePath, contents[filePath], 'utf8');
  }

  const lines = [];
  if (changed.size) {
    for (const f of changed) lines.push(`Updated ${path.relative(repoRoot, f)}`);
  }
  if (skipped.length) {
    lines.push('', 'Skipped:', ...skipped.map(s => `  ${s}`));
  }
  if (!lines.length) lines.push('No changes applied.');

  process.stdout.write(lines.join('\n') + '\n');
});
