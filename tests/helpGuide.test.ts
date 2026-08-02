import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { GUIDE, allPages, findPage, partOfPage, tocEntries, pageSearchText, DEFAULT_PAGE_ID } from '../components/help/guide';

// ---------------------------------------------------------------------------
// Help-target inventory
//
// The guide's hover highlight works by asking the main window to find an
// element carrying `data-help-target="<id>"`. A typo in a target is invisible
// at runtime — the highlight just silently doesn't appear — so the inventory of
// real targets is scraped out of the source and every reference is checked
// against it.
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', 'src-tauri', 'local', 'tests']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function helpTargetInventory(): Set<string> {
  const found = new Set<string>();
  // Literal `data-help-target="x"`, plus `helpTarget="x"` for the components
  // (VolumeControl) that take the target as a prop and apply it internally.
  const re = /(?:data-help-target|helpTarget)="([a-z0-9-]+)"/g;
  for (const file of sourceFiles(ROOT)) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) found.add(m[1]);
  }
  return found;
}

/** `[text](target)` links in a copy string are highlight anchors, not URLs. */
function anchorTargets(text: string): string[] {
  const out: string[] = [];
  const re = /\[(?:.+?)\]\((.+?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

describe('help guide structure', () => {
  it('has unique page ids across all parts', () => {
    const ids = allPages().map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique part ids', () => {
    const ids = GUIDE.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every part at least one page', () => {
    for (const part of GUIDE) expect(part.pages.length).toBeGreaterThan(0);
  });

  it('gives every page a non-empty title and body', () => {
    for (const page of allPages()) {
      expect(page.title().trim()).not.toBe('');
      expect(page.blocks().length).toBeGreaterThan(0);
    }
  });

  it('resolves the default page', () => {
    expect(findPage(DEFAULT_PAGE_ID)).toBeDefined();
  });

  it('resolves nothing for unknown or empty ids', () => {
    expect(findPage('no-such-page')).toBeUndefined();
    expect(findPage(null)).toBeUndefined();
    expect(findPage(undefined)).toBeUndefined();
  });

  it('finds the owning part for every page', () => {
    for (const page of allPages()) {
      const part = partOfPage(page.id);
      expect(part, `page ${page.id} belongs to no part`).toBeDefined();
      expect(part!.pages).toContain(page);
    }
  });

  it('gives every page unique heading ids', () => {
    for (const page of allPages()) {
      const ids = tocEntries(page).map(e => e.id);
      expect(new Set(ids).size, `duplicate heading id on page ${page.id}`).toBe(ids.length);
    }
  });

  it('builds searchable text containing the page title', () => {
    for (const page of allPages()) {
      expect(pageSearchText(page)).toContain(page.title().toLowerCase());
    }
  });
});

describe('help copy', () => {
  it('renders every string in copy/help.ts somewhere in the guide', () => {
    const copySrc = readFileSync(join(ROOT, 'copy/help.ts'), 'utf8');
    // Page prose is referenced from the guide tree; window chrome and the live
    // controls' labels are referenced from the components themselves.
    const consumers = sourceFiles(join(ROOT, 'components/help'))
      .map(f => readFileSync(f, 'utf8'))
      .join('\n');
    const keys = [...copySrc.matchAll(/getOverride\('(help\.[\w.]+)'\)/g)].map(m => m[1]);
    expect(keys.length).toBeGreaterThan(50);
    const orphans = keys.filter(k => !consumers.includes(k));
    // Copy nobody renders is dead weight and shows up as a phantom entry in the
    // dev copy editor — usually the leftover of a page that got restructured.
    expect(orphans, `unreferenced help copy: ${orphans.join(', ')}`).toEqual([]);
  });
});

describe('help targets', () => {
  const inventory = helpTargetInventory();

  it('scrapes a plausible inventory from the source', () => {
    // Guard against the scraper silently matching nothing (e.g. after a rename).
    expect(inventory.size).toBeGreaterThan(5);
    expect(inventory.has('spectrogram-canvas')).toBe(true);
    expect(inventory.has('volume-control')).toBe(true);
  });

  it('points every page target at a real element', () => {
    for (const page of allPages()) {
      if (!page.target) continue;
      expect(inventory.has(page.target), `page "${page.id}" targets missing "${page.target}"`).toBe(true);
    }
  });

  it('points every inline copy anchor at a real element', () => {
    for (const page of allPages()) {
      for (const block of page.blocks()) {
        const texts = block.kind === 'ul' ? block.items
          : block.kind === 'p' || block.kind === 'note' || block.kind === 'h' ? [block.text]
          : [];
        for (const text of texts) {
          for (const target of anchorTargets(text)) {
            expect(inventory.has(target), `page "${page.id}" links to missing target "${target}"`).toBe(true);
          }
        }
      }
    }
  });
});
