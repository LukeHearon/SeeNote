import { help } from '../../copy/help';
import type { LiveControlId } from './LiveControls';

// The help guide's structure. Text lives in copy/help.ts (so the copy editor can
// reach it); this file says what the pages are, what order they come in, and
// which real control each one points at.
//
// The nav rail is derived from this tree — HelpNav renders parts → pages — so
// adding a section is a matter of adding copy and slotting a block in here.

/** One renderable piece of a page. */
export type Block =
  /** Body paragraph. */
  | { kind: 'p'; text: string }
  /** Aside — smaller and dimmer than a paragraph. */
  | { kind: 'note'; text: string }
  /** Bulleted list. */
  | { kind: 'ul'; items: string[] }
  /** Subsection heading. Its `id` is also the page's in-document anchor. */
  | { kind: 'h'; id: string; text: string }
  /** A working copy of one of the app's controls, wired to the open project. */
  | { kind: 'live'; control: LiveControlId }
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
        id: 'overview',
        title: () => help.pages.overview,
        blocks: () => [
          { kind: 'p', text: help.overview.p1 },
          { kind: 'p', text: help.overview.p2 },
          { kind: 'h', id: 'pieces', text: help.overview.h_pieces },
          { kind: 'ul', items: [
            help.overview.li_project,
            help.overview.li_track,
            help.overview.li_annotation,
            help.overview.li_tool,
            help.overview.li_ident,
          ] },
          { kind: 'note', text: help.overview.note_ml },
        ],
      },
      {
        id: 'launch',
        title: () => help.pages.launch,
        blocks: () => [
          { kind: 'p', text: help.launch.p1 },
          { kind: 'h', id: 'buttons', text: help.launch.h_buttons },
          { kind: 'ul', items: [
            help.launch.li_new,
            help.launch.li_open,
            help.launch.li_file,
            help.launch.li_sync,
            help.launch.li_data,
          ] },
          { kind: 'h', id: 'entries', text: help.launch.h_entries },
          { kind: 'p', text: help.launch.p_entries },
          { kind: 'p', text: help.launch.p_star },
          { kind: 'p', text: help.launch.p_missing },
        ],
      },
      {
        id: 'projects',
        title: () => help.pages.projects,
        blocks: () => [
          { kind: 'p', text: help.projects.p1 },
          { kind: 'p', text: help.projects.p2 },
          { kind: 'h', id: 'dirs', text: help.projects.h_dirs },
          { kind: 'p', text: help.projects.p_dirs },
          { kind: 'p', text: help.projects.p_outside },
          { kind: 'h', id: 'appearance', text: help.projects.h_appearance },
          { kind: 'p', text: help.projects.p_appearance },
        ],
      },
      {
        id: 'single-file',
        title: () => help.pages.singleFile,
        blocks: () => [
          { kind: 'p', text: help.singleFile.p1 },
          { kind: 'p', text: help.singleFile.p2 },
          { kind: 'note', text: help.singleFile.note_assoc },
        ],
      },
      {
        id: 'updates',
        title: () => help.pages.updates,
        blocks: () => [
          { kind: 'p', text: help.updates.p1 },
          { kind: 'note', text: help.updates.note_linux },
          { kind: 'p', text: help.updates.p_manual },
        ],
      },
    ],
  },
  {
    id: 'workspace',
    title: () => help.parts.workspace,
    pages: [
      {
        id: 'layout',
        title: () => help.pages.layout,
        target: 'toolbar',
        blocks: () => [
          { kind: 'p', text: help.layout.p1 },
          { kind: 'p', text: help.layout.p2 },
          { kind: 'p', text: help.layout.p_refresh },
          { kind: 'h', id: 'resize', text: help.layout.h_resize },
          { kind: 'p', text: help.layout.p_resize },
          { kind: 'h', id: 'collapse', text: help.layout.h_collapse },
          { kind: 'p', text: help.layout.p_collapse },
        ],
      },
      {
        id: 'file-panel',
        title: () => help.pages.filePanel,
        target: 'file-panel',
        blocks: () => [
          { kind: 'p', text: help.filePanel.p1 },
          { kind: 'live', control: 'file-panel' },
          { kind: 'h', id: 'header', text: help.filePanel.h_header },
          { kind: 'ul', items: [
            help.filePanel.li_filter,
            help.filePanel.li_shuffle,
            help.filePanel.li_expand,
          ] },
          { kind: 'live', control: 'file-panel-header' },
          { kind: 'h', id: 'folders', text: help.filePanel.h_folders },
          { kind: 'p', text: help.filePanel.p_folders },
          { kind: 'p', text: help.filePanel.p_pinned },
          { kind: 'h', id: 'context', text: help.filePanel.h_context },
          { kind: 'p', text: help.filePanel.p_context },
          { kind: 'h', id: 'collapse', text: help.filePanel.h_collapse },
          { kind: 'p', text: help.filePanel.p_collapse },
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
            help.spectrogram.li6,
          ] },
          { kind: 'h', id: 'axes', text: help.spectrogram.h_axes },
          { kind: 'p', text: help.spectrogram.p_axes },
          { kind: 'p', text: help.spectrogram.p_axisDatetime },
          { kind: 'p', text: help.spectrogram.p_settings },
        ],
      },
      {
        id: 'zoom',
        title: () => help.pages.zoom,
        target: 'spectrogram-canvas',
        blocks: () => [
          { kind: 'p', text: help.zoom.p1 },
          { kind: 'h', id: 'zooming', text: help.zoom.h_zoom },
          { kind: 'ul', items: [help.zoom.li_wheel, help.zoom.li_keys, help.zoom.li_fit] },
          { kind: 'h', id: 'panning', text: help.zoom.h_pan },
          { kind: 'ul', items: [help.zoom.li_drag, help.zoom.li_arrows, help.zoom.li_jump] },
          { kind: 'note', text: help.zoom.note_lock },
        ],
      },
      {
        id: 'spectrogram-settings',
        title: () => help.pages.spectrogramSettings,
        target: 'spectrogram-settings',
        blocks: () => [
          { kind: 'p', text: help.spectrogramSettings.p1 },
          { kind: 'live', control: 'spectrogram-settings-button' },
          { kind: 'live', control: 'spectrogram-settings' },
          { kind: 'h', id: 'range', text: help.spectrogramSettings.h_range },
          { kind: 'p', text: help.spectrogramSettings.p_range },
          { kind: 'h', id: 'freq', text: help.spectrogramSettings.h_freq },
          { kind: 'p', text: help.spectrogramSettings.p_freq },
          { kind: 'h', id: 'fft', text: help.spectrogramSettings.h_fft },
          { kind: 'p', text: help.spectrogramSettings.p_fft },
          { kind: 'p', text: help.spectrogramSettings.p_scale },
          { kind: 'note', text: help.spectrogramSettings.note_cost },
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
        id: 'buzzdetect',
        title: () => help.pages.buzzdetect,
        target: 'buzzdetect-toggle',
        blocks: () => [
          { kind: 'p', text: help.buzzdetect.p1 },
          { kind: 'live', control: 'buzzdetect' },
          { kind: 'live', control: 'buzzdetect-panel' },
          { kind: 'h', id: 'reading', text: help.buzzdetect.h_reading },
          { kind: 'p', text: help.buzzdetect.p_reading },
          { kind: 'live', control: 'isolate' },
          { kind: 'h', id: 'frames', text: help.buzzdetect.h_frames },
          { kind: 'p', text: help.buzzdetect.p_frames },
          { kind: 'h', id: 'interact', text: help.buzzdetect.h_interact },
          { kind: 'p', text: help.buzzdetect.p_interact },
          { kind: 'h', id: 'zoom', text: help.buzzdetect.h_zoom },
          { kind: 'p', text: help.buzzdetect.p_zoom },
          { kind: 'note', text: help.buzzdetect.note_subset },
        ],
      },
      {
        id: 'subset',
        title: () => help.pages.subset,
        target: 'buzzdetect-subset-toggle',
        blocks: () => [
          { kind: 'p', text: help.subset.p1 },
          { kind: 'live', control: 'subset' },
          { kind: 'h', id: 'picking', text: help.subset.h_picking },
          { kind: 'p', text: help.subset.p_picking },
          { kind: 'p', text: help.subset.p_bins },
          { kind: 'note', text: help.subset.note_try },
          { kind: 'live', control: 'buzzdetect-panel' },
          { kind: 'h', id: 'reading', text: help.subset.h_reading },
          { kind: 'p', text: help.subset.p_segments },
          { kind: 'p', text: help.subset.p_ruler },
          { kind: 'h', id: 'times', text: help.subset.h_times },
          { kind: 'p', text: help.subset.p_times },
          { kind: 'p', text: help.subset.p_annotations },
          { kind: 'h', id: 'limits', text: help.subset.h_limits },
          { kind: 'ul', items: [
            help.subset.li_cross,
            help.subset.li_selectall,
            help.subset.li_bins,
            help.subset.li_video,
          ] },
        ],
      },
      {
        id: 'debug',
        title: () => help.pages.debug,
        target: 'toolbar',
        blocks: () => [
          { kind: 'p', text: help.debug.p1 },
          { kind: 'p', text: help.debug.p2 },
          { kind: 'live', control: 'debug' },
          { kind: 'note', text: help.debug.note_copy },
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
          { kind: 'live', control: 'transport' },
          { kind: 'h', id: 'lock', text: help.transport.h_lock },
          { kind: 'p', text: help.transport.p_lock },
          { kind: 'h', id: 'volume', text: help.transport.h_volume },
          { kind: 'p', text: help.transport.p_volume },
          { kind: 'live', control: 'volume' },
        ],
      },
      {
        id: 'time-display',
        title: () => help.pages.timeDisplay,
        target: 'time-display',
        blocks: () => [
          { kind: 'p', text: help.timeDisplay.p1 },
          { kind: 'live', control: 'time' },
          { kind: 'h', id: 'selection', text: help.timeDisplay.h_selection },
          { kind: 'p', text: help.timeDisplay.p_selection },
          { kind: 'live', control: 'selection' },
          { kind: 'h', id: 'datetime', text: help.timeDisplay.h_datetime },
          { kind: 'p', text: help.timeDisplay.p_datetime },
          { kind: 'p', text: help.timeDisplay.p_datetimeSource },
          { kind: 'note', text: help.timeDisplay.note_datetime },
        ],
      },
      {
        id: 'speed',
        title: () => help.pages.speed,
        target: 'playback-speed',
        blocks: () => [
          { kind: 'p', text: help.speed.p1 },
          { kind: 'live', control: 'speed' },
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
          { kind: 'live', control: 'filter' },
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
          { kind: 'ul', items: [help.modes.li1, help.modes.li_shift, help.modes.li_sweep, help.modes.li2] },
          { kind: 'live', control: 'tool-palette' },
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
            help.creating.li_sweep,
            help.creating.li_copy,
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
            help.editing.li6,
          ] },
        ],
      },
      {
        id: 'tools',
        title: () => help.pages.tools,
        target: 'tool-palette',
        blocks: () => [
          { kind: 'p', text: help.tools.p1 },
          { kind: 'live', control: 'tool-palette' },
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
          { kind: 'live', control: 'find-label' },
          { kind: 'h', id: 'find', text: help.bulk.h_find },
          { kind: 'p', text: help.bulk.p_find },
          { kind: 'h', id: 'rename', text: help.bulk.h_rename },
          { kind: 'p', text: help.bulk.p_rename2 },
        ],
      },
      {
        id: 'importing',
        title: () => help.pages.importing,
        target: 'file-panel',
        blocks: () => [
          { kind: 'p', text: help.importing.p1 },
          { kind: 'h', id: 'conflict', text: help.importing.h_conflict },
          { kind: 'p', text: help.importing.p_conflict },
          { kind: 'h', id: 'format', text: help.importing.h_format },
          { kind: 'p', text: help.importing.p_format },
          { kind: 'note', text: help.importing.note_bulk },
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: () => help.parts.settings,
    pages: [
      {
        id: 'project-settings',
        title: () => help.pages.projectSettings,
        target: 'project-settings-btn',
        blocks: () => [
          { kind: 'p', text: help.projectSettings.p1 },
          { kind: 'h', id: 'settings-tab', text: help.projectSettings.h_settings },
          { kind: 'p', text: help.projectSettings.p_settings },
          { kind: 'h', id: 'prefs-tab', text: help.projectSettings.h_prefs },
          { kind: 'p', text: help.projectSettings.p_prefs },
          { kind: 'h', id: 'moving', text: help.projectSettings.h_moving },
          { kind: 'p', text: help.projectSettings.p_moving },
          { kind: 'note', text: help.projectSettings.note_where },
        ],
      },
      {
        id: 'repair',
        title: () => help.pages.repair,
        blocks: () => [
          { kind: 'p', text: help.repair.p1 },
          { kind: 'h', id: 'media', text: help.repair.h_media },
          { kind: 'p', text: help.repair.p_media },
          { kind: 'h', id: 'project', text: help.repair.h_project },
          { kind: 'p', text: help.repair.p_project },
          { kind: 'note', text: help.repair.note_portable },
        ],
      },
    ],
  },
  {
    id: 'saving',
    title: () => help.parts.saving,
    pages: [
      {
        id: 'files',
        title: () => help.pages.files,
        blocks: () => [
          { kind: 'p', text: help.files.p1 },
          { kind: 'h', id: 'layout', text: help.files.h_layout },
          { kind: 'p', text: help.files.p_layout },
          { kind: 'p', text: help.files.p_delete },
          { kind: 'h', id: 'format', text: help.files.h_format },
          { kind: 'p', text: help.files.p_format },
          { kind: 'h', id: 'seenote', text: help.files.h_seenote },
          { kind: 'p', text: help.files.p_seenote },
        ],
      },
      {
        id: 'sync',
        title: () => help.pages.sync,
        blocks: () => [
          { kind: 'p', text: help.sync.p1 },
          { kind: 'h', id: 'merging', text: help.sync.h_merging },
          { kind: 'p', text: help.sync.p_merging },
          { kind: 'h', id: 'clearing', text: help.sync.h_clearing },
          { kind: 'p', text: help.sync.p_clearing },
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
      {
        id: 'troubleshooting',
        title: () => help.pages.troubleshooting,
        blocks: () => [
          { kind: 'h', id: 'video', text: help.troubleshooting.h_video },
          { kind: 'p', text: help.troubleshooting.p_video },
          { kind: 'h', id: 'stutter', text: help.troubleshooting.h_stutter },
          { kind: 'p', text: help.troubleshooting.p_stutter },
          { kind: 'h', id: 'audio', text: help.troubleshooting.h_audio },
          { kind: 'p', text: help.troubleshooting.p_audio },
          { kind: 'h', id: 'keychain', text: help.troubleshooting.h_keychain },
          { kind: 'p', text: help.troubleshooting.p_keychain },
          { kind: 'h', id: 'buzz', text: help.troubleshooting.h_buzz },
          { kind: 'p', text: help.troubleshooting.p_buzz },
          { kind: 'h', id: 'missing', text: help.troubleshooting.h_missing },
          { kind: 'p', text: help.troubleshooting.p_missing },
          { kind: 'h', id: 'logs', text: help.troubleshooting.h_logs },
          { kind: 'p', text: help.troubleshooting.p_logs },
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

/** A page's subsection headings, in document order. */
export function pageHeadings(page: Page): { id: string; text: string }[] {
  return page.blocks()
    .filter((b): b is Extract<Block, { kind: 'h' }> => b.kind === 'h')
    .map(b => ({ id: b.id, text: b.text }));
}

/** Strip inline markdown tokens down to their plain text, for contexts (like a
 * hover preview) that can't render markup. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/_(.+?)_/g, '$1');
}

/**
 * A markup-free blurb for a page's hover preview: its first paragraph, in
 * full. The preview card itself clips this to a few lines with a fade, rather
 * than this function truncating the words.
 */
export function pagePreview(page: Page): string {
  const first = page.blocks().find((b): b is Extract<Block, { kind: 'p' }> => b.kind === 'p');
  return first ? stripMarkdown(first.text) : '';
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
