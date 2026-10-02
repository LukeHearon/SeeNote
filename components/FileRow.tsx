import React from 'react';
import { ChevronRight, ChevronDown, ArrowRight, Music, Film, FolderOpen } from 'lucide-react';
import { ColumnLayout } from '../utils/fileTreeColumns';
import type { TreeNode } from '../utils/fileTreeBuild';
import { parseFilenameTime } from '../utils/filenameTime';
import { previewDateTimeFormat, DateTimeFormat } from '../utils/datetimeDisplay';
import { isSupportedMediaFile, SUPPORTED_AUDIO_EXTS, getExt } from '../constants';
import { basename } from '../utils/projectPaths';
import { fileTree as copy } from '../copy/ui';

export interface FilenameTimeInfo {
  pattern: string;
  offsetSeparator?: string;
  dateTimeFormat: DateTimeFormat;
}

/**
 * Filename tooltip, with a "(August 13, 1:00a)" second line when the name
 * matches the project's filename timestamp pattern. `displayText` is what the
 * tooltip shows (a bare name or a full path); the pattern is always matched
 * against just the basename, so a coincidental digit run in a parent
 * directory can't produce a bogus date.
 */
function tooltipWithDate(displayText: string, name: string, info: FilenameTimeInfo): string {
  const date = parseFilenameTime(name, info.pattern, info.offsetSeparator);
  return date ? `${displayText}\n(${previewDateTimeFormat(info.dateTimeFormat, date)})` : displayText;
}

// ── Result columns ──────────────────────────────────────────────────────────
// Two right-aligned columns show, for each folder, how many of its tracks have
// annotations / buzzdetect results, and for each track a pip saying whether it
// does. They're the least important thing on a row, so they only appear when
// the panel is wide enough to leave the name room.
/**
 * The columns' cells for one row: a count on a folder, a pip on a track. Every
 * cell is a fixed-width slot with a faint divider on its left; the divider runs
 * unbroken down the list because rows touch, and the header's filter buttons
 * sit in slots of the same width (FilePanelHeaderButtons).
 */
const ResultCells: React.FC<{
  columns: ColumnLayout;
  annotation: number | boolean;
  buzzdetect: number | boolean;
  total?: number;
}> = ({ columns, annotation, buzzdetect, total }) => {
  const slot = 'flex-none self-stretch flex items-center justify-center text-[10px] tabular-nums border-l border-slate-800';
  const cell = (value: number | boolean, color: string, noun: string) => (
    <span
      className={slot}
      style={{ width: `${columns.widthPx}px` }}
      data-tooltip={typeof value === 'number'
        ? copy.countTooltip(value, total ?? '?', noun)
        : value ? copy.trackTooltip(noun) : undefined}
    >
      {typeof value === 'number'
        ? <span className={value > 0 ? color : 'text-slate-800'}>{value}</span>
        : value && <span className={`w-1.5 h-1.5 rounded-full bg-current ${color}`} />}
    </span>
  );
  return (
    // One container, so a row's own gap doesn't open up between the columns.
    <span className="flex-none self-stretch flex">
      {columns.annotation && cell(annotation, 'text-sky-800', copy.haveAnnotations)}
      {columns.buzzdetect && cell(buzzdetect, 'text-amber-800', copy.haveBuzzdetect)}
      {/* On a track this is an empty slot, so the dividers run on unbroken. */}
      {columns.total && (
        <span
          className={`${slot} text-slate-600`}
          style={{ width: `${columns.widthPx}px` }}
          data-tooltip={total !== undefined ? copy.totalTracksTooltip(total) : undefined}
        >
          {total}
        </span>
      )}
    </span>
  );
};

type MenuHandler = (e: React.MouseEvent, path: string, isDir: boolean) => void;

// Rough px width of a name, tagged on the name span so the panel can find the
// few rows that could be widest and measure only those.
const CHAR_PX = 6.5;
const nameReach = (indentPx: number, name: string) => Math.round(indentPx + name.length * CHAR_PX);

export const FolderRow = React.memo(function FolderRow({
  node, depth, parentPath, expanded, isClosedAncestor, columns, onToggle, onEnter, onContextMenu,
}: {
  node: TreeNode;
  depth: number;
  /** Folder this row sits in — reported to the pinned breadcrumb. */
  parentPath: string;
  expanded: boolean;
  isClosedAncestor: boolean;
  columns: ColumnLayout;
  onToggle: (node: TreeNode) => void;
  onEnter: (path: string) => void;
  onContextMenu: MenuHandler;
}) {
  const indent = depth * 12 + 8;
  return (
    <div
      className={`relative group flex items-center w-full transition-colors ${
        isClosedAncestor
          ? 'bg-[#e65161]/10 hover:bg-[#e65161]/20 text-[#e65161]'
          : 'hover:bg-slate-800 text-slate-400 hover:text-slate-200'
      }`}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, node.path, true); }}
      data-folder-path={node.path}
      // The breadcrumb covers this row when it reaches the top edge, so an
      // expanded folder stands in for itself there — that's what makes the
      // crumb grow a level as you scroll into a folder rather than all at
      // once when its files arrive. A collapsed folder isn't context.
      data-crumb={expanded ? node.path : parentPath}
    >
      <button
        onClick={() => onToggle(node)}
        className="flex items-center gap-1 flex-1 min-w-0 px-2 py-1 text-left"
        style={{ paddingLeft: `${indent}px` }}
      >
        {expanded
          ? <ChevronDown size={12} className="flex-none opacity-60" />
          : <ChevronRight size={12} className="flex-none opacity-60" />
        }
        <FolderOpen size={13} className={`flex-none ${isClosedAncestor ? 'text-[#e65161]/70' : 'text-slate-500 group-hover:text-slate-300'}`} />
        <span className="text-xs truncate"><span data-name-text={nameReach(indent + 30, node.name)}>{node.name}</span></span>
      </button>
      <ResultCells columns={columns} annotation={node.annotatedCount} buzzdetect={node.buzzdetectCount} total={node.fileCount} />
      <button
        onClick={(e) => { e.stopPropagation(); onEnter(node.path); }}
        className="absolute inset-y-0 right-1 flex items-center opacity-0 group-hover:opacity-100 transition-opacity"
        data-tooltip={copy.enterFolder(node.name)}
        tabIndex={-1}
      >
        <span className="flex items-center justify-center w-4 h-4 rounded bg-slate-700 shadow-md text-slate-300 hover:text-white hover:bg-slate-600">
          <ArrowRight size={10} />
        </span>
      </button>
    </div>
  );
});

/**
 * A track row. `tree` rows are indented by depth and show the bare name;
 * `flat` rows (shuffle mode) show the path relative to the root, and fade.
 */
export const FileRow = React.memo(function FileRow({
  variant, path, label, depth = 0, parentPath, isActive, hasAnnotation, hasBuzzdetect, columns, opacity, filenameTimeInfo, onSelect, onContextMenu,
}: {
  variant: 'tree' | 'flat';
  path: string;
  /** What the row shows: the name (tree) or the extension-less relative path (flat). */
  label: string;
  depth?: number;
  /** Tree only: folder this row sits in, for the pinned breadcrumb. */
  parentPath?: string;
  isActive: boolean;
  hasAnnotation: boolean;
  hasBuzzdetect: boolean;
  columns: ColumnLayout;
  opacity?: number;
  filenameTimeInfo: FilenameTimeInfo;
  onSelect: (path: string) => void;
  onContextMenu: MenuHandler;
}) {
  const flat = variant === 'flat';
  const name = basename(path);
  const isAudio = SUPPORTED_AUDIO_EXTS.has(getExt(name));
  const icon = (cls: string) => isAudio ? <Music size={12} className={cls} /> : <Film size={12} className={cls} />;
  const indent = flat ? 12 : depth * 12 + 22;
  const spacing = flat ? 'px-3 py-1.5' : 'py-1';
  const style: React.CSSProperties = flat ? { opacity } : { paddingLeft: `${indent}px` };

  if (!isSupportedMediaFile(path)) {
    return (
      <div
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, path, false); }}
        className={`flex items-center gap-2 w-full ${spacing} text-left text-slate-600 cursor-not-allowed`}
        style={flat ? style : { ...style, paddingRight: '8px' }}
        data-tooltip={copy.unsupportedFileTooltip(flat ? path : name)}
        data-crumb={flat ? undefined : parentPath}
      >
        {icon('flex-none opacity-40')}
        <span className="text-xs truncate flex-1 italic">{label}</span>
        <span className="text-[10px] flex-none opacity-70">{copy.unsupported}</span>
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(path)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, path, false); }}
      className={`flex items-center gap-2 w-full ${spacing} text-left transition-colors ${
        isActive
          ? 'bg-[#e65161]/20 text-[#e65161]'
          : 'hover:bg-slate-800 text-slate-500 hover:text-slate-300'
      }`}
      style={flat ? { ...style, paddingRight: columns.annotation ? 0 : undefined } : { ...style, paddingRight: columns.annotation ? 0 : '8px' }}
      data-tooltip={tooltipWithDate(flat ? path : name, name, filenameTimeInfo)}
      data-active-file={isActive ? '' : undefined}
      data-crumb={flat ? undefined : parentPath}
    >
      {icon('flex-none opacity-70')}
      <span className="text-xs truncate flex-1"><span data-name-text={nameReach(indent + 20, label)}>{label}</span></span>
      <ResultCells columns={columns} annotation={hasAnnotation} buzzdetect={hasBuzzdetect} />
    </button>
  );
});

/** "N unsupported" disclosure under a folder. */
export const NonMediaToggle = React.memo(function NonMediaToggle({
  path, count, depth, expanded, onToggle,
}: {
  path: string;
  count: number;
  depth: number;
  expanded: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <button
      className="flex items-center gap-1 w-full text-left text-slate-600 hover:text-slate-500 py-0.5"
      style={{ paddingLeft: `${(depth + 1) * 12 + 8}px`, paddingRight: '8px' }}
      onClick={() => onToggle(path)}
      data-crumb={depth < 0 ? undefined : path}
    >
      <span className="text-[9px] uppercase tracking-wider opacity-50 select-none">
        {expanded ? '▾' : '▸'} {copy.unsupportedCount(count)}
      </span>
    </button>
  );
});

export const NonMediaItem = React.memo(function NonMediaItem({
  filePath, depth, crumb,
}: {
  filePath: string;
  depth: number;
  crumb: string;
}) {
  const fname = basename(filePath);
  return (
    <div
      className="flex items-center w-full py-px text-slate-600 opacity-40 select-none"
      style={{ paddingLeft: `${(depth + 1) * 12 + 22}px`, paddingRight: '8px' }}
      data-tooltip={fname}
      data-crumb={crumb}
    >
      <span className="text-[10px] truncate flex-1 italic">{fname}</span>
    </div>
  );
});
