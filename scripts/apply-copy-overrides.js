#!/usr/bin/env node
// Usage:
//   node scripts/apply-copy-overrides.js --overrides path/to/copy-overrides.json
//   node scripts/apply-copy-overrides.js --stdin   (reads JSON from stdin)
// Each key like "tooltips.skipToStart" patches copy/tooltips.ts, getter for `skipToStart`.
// Nested keys like "ui.launchScreen.appName" patch copy/ui.ts, getter for `appName`.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const copyDir = path.join(__dirname, '..', 'copy');

function loadOverrides() {
  if (args.includes('--stdin')) {
    return JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
  }
  const idx = args.indexOf('--overrides');
  const overridesPath = idx >= 0
    ? args[idx + 1]
    : path.join(process.env.HOME, 'Library', 'Application Support', 'com.seenote.app', 'copy-overrides.json');
  if (!fs.existsSync(overridesPath)) {
    console.error(`No overrides file found at: ${overridesPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
}

const overrides = loadOverrides();
let applied = 0;
let skipped = 0;

for (const [key, newVal] of Object.entries(overrides)) {
  const parts = key.split('.');
  const file = parts[0] === 'helpPanel' ? 'help' : parts[0];
  const filePath = path.join(copyDir, `${file}.ts`);

  if (!fs.existsSync(filePath)) {
    console.warn(`  SKIP ${key}: no file ${file}.ts`);
    skipped++;
    continue;
  }

  let src = fs.readFileSync(filePath, 'utf8');
  const leafKey = parts[parts.length - 1];
  const pattern = new RegExp(`(${leafKey}\\(\\)\\s*\\{[^}]*return\\s+getOverride\\([^)]+\\)\\s*\\?\\?\\s*)"([^"]*)"`, 'g');
  const escaped = String(newVal).replace(/"/g, '\\"');
  const orig = src;
  src = src.replace(pattern, `$1"${escaped}"`);

  if (src !== orig) {
    fs.writeFileSync(filePath, src, 'utf8');
    console.log(`  OK  ${key}`);
    applied++;
  } else {
    console.warn(`  SKIP ${key}: pattern not found in ${file}.ts`);
    skipped++;
  }
}

console.log(`\nDone: ${applied} applied, ${skipped} skipped.`);
