import { help } from '../../copy/help';

// The help guide's structure. Text lives in copy/help.ts (so the copy editor can
// reach it); this file says what the pages are, what order they come in, and
// which real control each one points at.
//
// Both rails are derived from this tree — HelpNav renders parts → pages, HelpToc
// renders the `h` blocks of the active page — so adding a section is a matter of
// adding copy and slotting a block in here.

/** One renderable piece of a page. */
export type Block =
  /** Body paragraph. */
  | { kind: 'p'; text: string }
  /** Aside — smaller and dimmer than a paragraph. */
  | { kind: 'note'; text: string }
  /** Bulleted list. */
  | { kind: 'ul'; items: string[] }
  /** Subsection heading. Also becomes a table-of-contents entry. */
  | { kind: 'h'; id: string; text: string }
  /** The interactive keyboard-shortcut map (components/KeyboardShortcutsView). */
  | { kind: 'shortcuts' };

export interface Page {
  id: string;
  /** Nav / page title. Read lazily so copy overrides apply live. */
  title: () => string;
  /** `data-help-target` to ghost in the main window when the title is hovered. */
  target?: string;
  /** Drop the prose reading-width cap — for pages built around a wide figure. */
  wide?: boolean;
  blocks: () => Block[];
}

export interface Part {
  id: string;
  title: () => string;
  pages: Page[];
}

export const GUIDE: Part[] = [
  {
    id: 'start',
    title: () => help.parts.start,
    pages: [
      {
        id: 'projects',
        title: () => help.pages.projects,
        blocks: () => [
          { kind: 'p', text: help.projects.p1 },
          { kind: 'p', text: help.projects.p2 },
        ],
      },
      {
        id: 'single-file',
        title: () => help.pages.singleFile,
        blocks: () => [
          { kind: 'p', text: help.singleFile.p1 },
        ],
      },
    ],
  },
  {
    id: 'workspace',
    title: () => help.parts.workspace,
    pages: [
      {
        id: 'file-panel',
        title: () => help.pages.filePanel,
        target: 'file-panel',
        blocks: () => [
          { kind: 'p', text: help.filePanel.p1 },
          { kind: 'h', id: 'folders', text: help.filePanel.h_folders },
          { kind: 'p', text: help.filePanel.p_folders },
          { kind: 'h', id: 'context', text: help.filePanel.h_context },
          { kind: 'p', text: help.filePanel.p_context },
          { kind: 'h', id: 'collapse', text: help.filePanel.h_collapse },
          { kind: 'p', text: help.filePanel.p_collapse },
        ],
      },
      {
        id: 'video',
        title: () => help.pages.video,
        target: 'video-panel',
        blocks: () => [
          { kind: 'p', text: help.video.intro },
          { kind: 'ul', items: [
            help.video.li_off,
            help.video.li_fast,
            help.video.li_mixed,
            help.video.li_accurate,
          ] },
          { kind: 'note', text: help.video.note_badge },
          { kind: 'h', id: 'pane', text: help.video.h_pane },
          { kind: 'p', text: help.video.p_pane1 },
          { kind: 'p', text: help.video.p_pane2 },
          { kind: 'h', id: 'codecs', text: help.video.h_codecs },
          { kind: 'p', text: help.video.p_codecs },
        ],
      },
      {
        id: 'video-zoom',
        title: () => help.pages.videoZoom,
        target: 'video-panel',
        blocks: () => [
          { kind: 'p', text: help.videoZoom.intro },
          { kind: 'ul', items: [
            help.videoZoom.li1,
            help.videoZoom.li2,
            help.videoZoom.li3,
            help.videoZoom.li4,
            help.videoZoom.li5,
            help.videoZoom.li6,
          ] },
          { kind: 'note', text: help.videoZoom.note1 },
          { kind: 'h', id: 'image', text: help.videoZoom.h_image },
          { kind: 'p', text: help.videoZoom.p_image },
          { kind: 'note', text: help.videoZoom.note_image },
        ],
      },
      {
        id: 'spectrogram',
        title: () => help.pages.spectrogram,
        target: 'spectrogram-canvas',
        blocks: () => [
          { kind: 'ul', items: [
            help.spectrogram.li1,
            help.spectrogram.li2,
            help.spectrogram.li3,
            help.spectrogram.li4,
            help.spectrogram.li5,
          ] },
          { kind: 'h', id: 'settings', text: help.spectrogram.h_settings },
          { kind: 'p', text: help.spectrogram.p_settings },
        ],
      },
      {
        id: 'buzzdetect',
        title: () => help.pages.buzzdetect,
        target: 'buzzdetect-toggle',
        blocks: () => [
          { kind: 'p', text: help.buzzdetect.p1 },
          { kind: 'h', id: 'reading', text: help.buzzdetect.h_reading },
          { kind: 'p', text: help.buzzdetect.p_reading },
          { kind: 'h', id: 'frames', text: help.buzzdetect.h_frames },
          { kind: 'p', text: help.buzzdetect.p_frames },
          { kind: 'h', id: 'interact', text: help.buzzdetect.h_interact },
          { kind: 'p', text: help.buzzdetect.p_interact },
          { kind: 'h', id: 'zoom', text: help.buzzdetect.h_zoom },
          { kind: 'p', text: help.buzzdetect.p_zoom },
        ],
      },
    ],
  },
  {
    id: 'playback',
    title: () => help.parts.playback,
    pages: [
      {
        id: 'transport',
        title: () => help.pages.transport,
        target: 'transport-buttons',
        blocks: () => [
          { kind: 'p', text: help.transport.p1 },
          { kind: 'h', id: 'lock', text: help.transport.h_lock },
          { kind: 'p', text: help.transport.p_lock },
          { kind: 'h', id: 'volume', text: help.transport.h_volume },
          { kind: 'p', text: help.transport.p_volume },
        ],
      },
      {
        id: 'time-display',
        title: () => help.pages.timeDisplay,
        target: 'time-display',
        blocks: () => [
          { kind: 'p', text: help.timeDisplay.p1 },
          { kind: 'h', id: 'selection', text: help.timeDisplay.h_selection },
          { kind: 'p', text: help.timeDisplay.p_selection },
        ],
      },
      {
        id: 'speed',
        title: () => help.pages.speed,
        target: 'playback-speed',
        blocks: () => [
          { kind: 'p', text: help.speed.p1 },
          { kind: 'note', text: help.speed.note1 },
        ],
      },
      {
        id: 'filter',
        title: () => help.pages.filter,
        target: 'filter-tool',
        blocks: () => [
          { kind: 'p', text: help.filter.p1 },
          { kind: 'h', id: 'tuning', text: help.filter.h_tuning },
          { kind: 'p', text: help.filter.p_tuning },
          { kind: 'h', id: 'toggle', text: help.filter.h_toggle },
          { kind: 'p', text: help.filter.p_toggle },
          { kind: 'p', text: help.filter.p_esc },
          { kind: 'note', text: help.filter.note_persist },
        ],
      },
    ],
  },
  {
    id: 'annotating',
    title: () => help.parts.annotating,
    pages: [
      {
        id: 'modes',
        title: () => help.pages.modes,
        target: 'tool-palette',
        blocks: () => [
          { kind: 'ul', items: [help.modes.li1, help.modes.li2] },
          { kind: 'note', text: help.modes.note1 },
          { kind: 'note', text: help.modes.note2 },
        ],
      },
      {
        id: 'creating',
        title: () => help.pages.creating,
        target: 'spectrogram-canvas',
        blocks: () => [
          { kind: 'ul', items: [
            help.creating.li1,
            help.creating.li2,
            help.creating.li3,
            help.creating.li4,
          ] },
        ],
      },
      {
        id: 'editing',
        title: () => help.pages.editing,
        target: 'spectrogram-canvas',
        blocks: () => [
          { kind: 'ul', items: [
            help.editing.li1,
            help.editing.li2,
            help.editing.li3,
            help.editing.li4,
            help.editing.li5,
          ] },
        ],
      },
      {
        id: 'tools',
        title: () => help.pages.tools,
        target: 'tool-palette',
        blocks: () => [
          { kind: 'p', text: help.tools.p1 },
          { kind: 'h', id: 'manage', text: help.tools.h_manage },
          { kind: 'p', text: help.tools.p_manage },
          { kind: 'note', text: help.tools.note_undo },
          { kind: 'h', id: 'examples', text: help.tools.h_examples },
          { kind: 'p', text: help.tools.p_examples1 },
          { kind: 'p', text: help.tools.p_examples2 },
          { kind: 'p', text: help.tools.p_examples3 },
        ],
      },
      {
        id: 'bulk',
        title: () => help.pages.bulk,
        target: 'tool-palette',
        blocks: () => [
          { kind: 'p', text: help.bulk.p_rename },
          { kind: 'h', id: 'find', text: help.bulk.h_find },
          { kind: 'p', text: help.bulk.p_find },
        ],
      },
    ],
  },
  {
    id: 'saving',
    title: () => help.parts.saving,
    pages: [
      {
        id: 'auto-save',
        title: () => help.pages.autoSave,
        blocks: () => [
          { kind: 'p', text: help.autoSave.p1 },
        ],
      },
      {
        id: 'sync',
        title: () => help.pages.sync,
        blocks: () => [
          { kind: 'p', text: help.sync.p1 },
          { kind: 'h', id: 'merging', text: help.sync.h_merging },
          { kind: 'p', text: help.sync.p_merging },
          { kind: 'h', id: 'shared', text: help.sync.h_shared },
          { kind: 'p', text: help.sync.p_shared },
          { kind: 'h', id: 'token', text: help.sync.h_token },
          { kind: 'p', text: help.sync.p_token },
          { kind: 'h', id: 'autopull', text: help.sync.h_autopull },
          { kind: 'p', text: help.sync.p_autopull },
        ],
      },
    ],
  },
  {
    id: 'reference',
    title: () => help.parts.reference,
    pages: [
      {
        id: 'shortcuts',
        title: () => help.pages.shortcuts,
        wide: true,
        blocks: () => [
          { kind: 'shortcuts' },
        ],
      },
    ],
  },
];

/** Every page, flattened, in nav order. */
export function allPages(): Page[] {
  return GUIDE.flatMap(part => part.pages);
}

export function findPage(id: string | null | undefined): Page | undefined {
  if (!id) return undefined;
  return allPages().find(p => p.id === id);
}

/** The part a page belongs to — used to auto-expand the nav on deep links. */
export function partOfPage(pageId: string): Part | undefined {
  return GUIDE.find(part => part.pages.some(p => p.id === pageId));
}

export const DEFAULT_PAGE_ID = GUIDE[0].pages[0].id;

/** Table-of-contents entries for a page: its `h` blocks, in document order. */
export function tocEntries(page: Page): { id: string; text: string }[] {
  return page.blocks()
    .filter((b): b is Extract<Block, { kind: 'h' }> => b.kind === 'h')
    .map(b => ({ id: b.id, text: b.text }));
}

/**
 * Plain-text haystack for a page, for nav filtering. Markdown tokens are left
 * in — they're rare enough in search terms not to matter, and stripping them
 * would mean duplicating renderInlineMarkdown's tokenizer.
 */
export function pageSearchText(page: Page): string {
  const parts = [page.title()];
  for (const b of page.blocks()) {
    if (b.kind === 'p' || b.kind === 'note') parts.push(b.text);
    else if (b.kind === 'h') parts.push(b.text);
    else if (b.kind === 'ul') parts.push(...b.items);
  }
  return parts.join(' ').toLowerCase();
}
