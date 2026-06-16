import React, { useEffect, useMemo, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Shortcut data
// ---------------------------------------------------------------------------

type ShortcutEntry = {
  codes: string[];   // KeyboardEvent.code values for the primary key
  display: string;   // e.g. "Shift+F"
  label: string;
};

type Group = {
  name: string;
  bg: string;
  ring: string;
  dot: string;
  text: string;
  shortcuts: ShortcutEntry[];
};

const GROUPS: Group[] = [
  {
    name: 'Playback',
    bg: 'bg-amber-600', ring: 'ring-amber-400', dot: 'bg-amber-500', text: 'text-amber-300',
    shortcuts: [
      { codes: ['Space'], display: 'Space', label: 'Play / Pause' },
      { codes: ['KeyR'], display: 'R', label: 'Toggle speed (1× ↔ last)' },
      { codes: ['KeyM'], display: 'M', label: 'Mute / Unmute' },
    ],
  },
  {
    name: 'Navigation',
    bg: 'bg-sky-600', ring: 'ring-sky-400', dot: 'bg-sky-500', text: 'text-sky-300',
    shortcuts: [
      { codes: ['ArrowLeft'], display: '←', label: 'Scrub backward' },
      { codes: ['ArrowRight'], display: '→', label: 'Scrub forward' },
      { codes: ['Comma'], display: ',', label: 'Nudge video forward one frame' },
      { codes: ['Period'], display: '.', label: 'Nudge video backward one frame' },
      { codes: ['KeyC'], display: 'C', label: 'Toggle lock playhead to center' },
      { codes: ['ArrowLeft'], display: 'Cmd+←', label: 'Jump to previous annotation' },
      { codes: ['ArrowRight'], display: 'Cmd+→', label: 'Jump to next annotation' },
      { codes: ['ArrowUp'], display: 'Cmd+↑', label: 'Previous track' },
      { codes: ['ArrowDown'], display: 'Cmd+↓', label: 'Next track' },
    ],
  },
  {
    name: 'Tools',
    bg: 'bg-violet-600', ring: 'ring-violet-400', dot: 'bg-violet-500', text: 'text-violet-300',
    shortcuts: [
      { codes: ['Digit0','Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9'], display: '0–9', label: 'Ready annotation tool' },
      { codes: ['KeyS'], display: 'S', label: 'Selection mode (unready tools)' },
      { codes: ['KeyE'], display: 'E', label: 'Play / stop example clip for active tool' },
      { codes: ['KeyF'], display: 'Shift+F', label: 'Ready audio filter tool' },
      { codes: ['KeyF'], display: 'F', label: 'Toggle audio filtering' },
      { codes: ['KeyZ'], display: 'Shift+Z', label: 'Ready video zoom tool' },
      { codes: ['KeyZ'], display: 'Z', label: 'Toggle video zoom' },
      { codes: ['Equal'], display: '= / +', label: 'Zoom video in' },
      { codes: ['Minus'], display: '-', label: 'Zoom video out' },
      { codes: ['Escape'], display: 'Esc', label: 'Undo activated tool/selection' },
      { codes: ['KeyH'], display: 'H (hold)', label: 'Hide annotation labels' },
    ],
  },
  {
    name: 'Annotations',
    bg: 'bg-emerald-600', ring: 'ring-emerald-400', dot: 'bg-emerald-500', text: 'text-emerald-300',
    shortcuts: [
      { codes: ['KeyA'], display: 'Cmd+A', label: 'Select whole track' },
      { codes: ['Delete','Backspace'], display: 'Del / Bksp', label: 'Remove selected annotation' },
      { codes: ['KeyZ'], display: 'Cmd+Z', label: 'Undo' },
      { codes: ['KeyZ'], display: 'Cmd+Shift+Z', label: 'Redo' },
      { codes: ['KeyY'], display: 'Cmd+Y', label: 'Redo' },
    ],
  },
  {
    name: 'App',
    bg: 'bg-slate-500', ring: 'ring-slate-300', dot: 'bg-slate-400', text: 'text-slate-300',
    shortcuts: [
      { codes: ['F1'], display: 'F1', label: 'Toggle help panel' },
      { codes: ['Slash'], display: '? (hold)', label: 'Quick tooltips on hover' },
    ],
  },
];

const ALL_SHORTCUTS = GROUPS.flatMap(g =>
  g.shortcuts.map(s => ({ ...s, group: g }))
);

// First group to claim each code — used for key color on the keyboard
const CODE_TO_GROUP = new Map<string, Group>();
for (const g of GROUPS) {
  for (const s of g.shortcuts) {
    for (const code of s.codes) {
      if (!CODE_TO_GROUP.has(code)) CODE_TO_GROUP.set(code, g);
    }
  }
}

// All codes to highlight when a specific shortcut is hovered
function codesForShortcut(s: ShortcutEntry): Set<string> {
  const set = new Set(s.codes);
  if (s.display.includes('Shift+'))  { set.add('ShiftLeft');   set.add('ShiftRight'); }
  if (s.display.includes('Cmd+'))    { set.add('MetaLeft');    set.add('MetaRight'); }
  if (s.display.includes('Ctrl'))    { set.add('ControlLeft'); set.add('ControlRight'); }
  return set;
}

// All shortcuts matching a hovered key code
function shortcutsForCode(code: string) {
  if (code === 'ShiftLeft'    || code === 'ShiftRight')
    return ALL_SHORTCUTS.filter(s => s.display.includes('Shift+'));
  if (code === 'MetaLeft'     || code === 'MetaRight')
    return ALL_SHORTCUTS.filter(s => s.display.includes('Cmd+'));
  if (code === 'ControlLeft'  || code === 'ControlRight')
    return ALL_SHORTCUTS.filter(s => s.display.includes('Ctrl'));
  return ALL_SHORTCUTS.filter(s => s.codes.includes(code));
}

// ---------------------------------------------------------------------------
// Keyboard layout
// ---------------------------------------------------------------------------

type KeyDef = { code: string; label: string; flex: number; small?: boolean };

const ROWS: KeyDef[][] = [
  [
    { code: 'Escape',       label: 'Esc',  flex: 1,    small: true },
    { code: 'F1',           label: 'F1',   flex: 1,    small: true },
    { code: 'F2',           label: 'F2',   flex: 1,    small: true },
    { code: 'F3',           label: 'F3',   flex: 1,    small: true },
    { code: 'F4',           label: 'F4',   flex: 1,    small: true },
    { code: 'F5',           label: 'F5',   flex: 1,    small: true },
    { code: 'F6',           label: 'F6',   flex: 1,    small: true },
    { code: 'F7',           label: 'F7',   flex: 1,    small: true },
    { code: 'F8',           label: 'F8',   flex: 1,    small: true },
    { code: 'F9',           label: 'F9',   flex: 1,    small: true },
    { code: 'F10',          label: 'F10',  flex: 1,    small: true },
    { code: 'F11',          label: 'F11',  flex: 1,    small: true },
    { code: 'F12',          label: 'F12',  flex: 1,    small: true },
  ],
  [
    { code: 'Backquote',    label: '`',    flex: 1 },
    { code: 'Digit1',       label: '1',    flex: 1 },
    { code: 'Digit2',       label: '2',    flex: 1 },
    { code: 'Digit3',       label: '3',    flex: 1 },
    { code: 'Digit4',       label: '4',    flex: 1 },
    { code: 'Digit5',       label: '5',    flex: 1 },
    { code: 'Digit6',       label: '6',    flex: 1 },
    { code: 'Digit7',       label: '7',    flex: 1 },
    { code: 'Digit8',       label: '8',    flex: 1 },
    { code: 'Digit9',       label: '9',    flex: 1 },
    { code: 'Digit0',       label: '0',    flex: 1 },
    { code: 'Minus',        label: '-',    flex: 1 },
    { code: 'Equal',        label: '=',    flex: 1 },
    { code: 'Backspace',    label: '⌫',    flex: 2,    small: true },
  ],
  [
    { code: 'Tab',          label: 'Tab',  flex: 1.5,  small: true },
    { code: 'KeyQ',         label: 'Q',    flex: 1 },
    { code: 'KeyW',         label: 'W',    flex: 1 },
    { code: 'KeyE',         label: 'E',    flex: 1 },
    { code: 'KeyR',         label: 'R',    flex: 1 },
    { code: 'KeyT',         label: 'T',    flex: 1 },
    { code: 'KeyY',         label: 'Y',    flex: 1 },
    { code: 'KeyU',         label: 'U',    flex: 1 },
    { code: 'KeyI',         label: 'I',    flex: 1 },
    { code: 'KeyO',         label: 'O',    flex: 1 },
    { code: 'KeyP',         label: 'P',    flex: 1 },
    { code: 'BracketLeft',  label: '[',    flex: 1 },
    { code: 'BracketRight', label: ']',    flex: 1 },
    { code: 'Backslash',    label: '\\',   flex: 1.5,  small: true },
  ],
  [
    { code: 'CapsLock',     label: 'Caps', flex: 1.75, small: true },
    { code: 'KeyA',         label: 'A',    flex: 1 },
    { code: 'KeyS',         label: 'S',    flex: 1 },
    { code: 'KeyD',         label: 'D',    flex: 1 },
    { code: 'KeyF',         label: 'F',    flex: 1 },
    { code: 'KeyG',         label: 'G',    flex: 1 },
    { code: 'KeyH',         label: 'H',    flex: 1 },
    { code: 'KeyJ',         label: 'J',    flex: 1 },
    { code: 'KeyK',         label: 'K',    flex: 1 },
    { code: 'KeyL',         label: 'L',    flex: 1 },
    { code: 'Semicolon',    label: ';',    flex: 1 },
    { code: 'Quote',        label: "'",    flex: 1 },
    { code: 'Enter',        label: '↵',    flex: 2.25, small: true },
  ],
  [
    { code: 'ShiftLeft',    label: 'Shift',flex: 2.25, small: true },
    { code: 'KeyZ',         label: 'Z',    flex: 1 },
    { code: 'KeyX',         label: 'X',    flex: 1 },
    { code: 'KeyC',         label: 'C',    flex: 1 },
    { code: 'KeyV',         label: 'V',    flex: 1 },
    { code: 'KeyB',         label: 'B',    flex: 1 },
    { code: 'KeyN',         label: 'N',    flex: 1 },
    { code: 'KeyM',         label: 'M',    flex: 1 },
    { code: 'Comma',        label: ',',    flex: 1 },
    { code: 'Period',       label: '.',    flex: 1 },
    { code: 'Slash',        label: '/',    flex: 1 },
    { code: 'ShiftRight',   label: 'Shift',flex: 2.75, small: true },
  ],
  [
    { code: 'ControlLeft',  label: 'Ctrl', flex: 1.5,  small: true },
    { code: 'AltLeft',      label: 'Alt',  flex: 1.5,  small: true },
    { code: 'MetaLeft',     label: '⌘',    flex: 1.5,  small: true },
    { code: 'Space',        label: 'Space',flex: 6,    small: true },
    { code: 'MetaRight',    label: '⌘',    flex: 1.5,  small: true },
    { code: 'AltRight',     label: 'Alt',  flex: 1.5,  small: true },
    { code: 'ControlRight', label: 'Ctrl', flex: 1.5,  small: true },
  ],
];

// Arrow keys use a fixed pixel width matching a standard letter key
const ARROW_KEY_PX = 28;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useKeyboardLayoutMap() {
  const [labelMap, setLabelMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const kb = (navigator as any).keyboard;
    if (!kb) return;
    kb.getLayoutMap().then((map: any) => {
      const m = new Map<string, string>();
      map.forEach((value: string, key: string) => m.set(key, value.toUpperCase()));
      setLabelMap(m);
    }).catch(() => {});
  }, []);
  return labelMap;
}

// ---------------------------------------------------------------------------
// KeyCap
// ---------------------------------------------------------------------------

function KeyCap({
  code, label, flex, fixedPx, small, group, active, dimmed, onEnter, onLeave,
}: {
  code: string; label: string; flex?: number; fixedPx?: number;
  small?: boolean; group: Group | undefined; active: boolean; dimmed: boolean;
  onEnter: () => void; onLeave: () => void;
}) {
  const style: React.CSSProperties = fixedPx
    ? { width: fixedPx, flexShrink: 0 }
    : { flex };

  let appearance: string;
  if (dimmed) {
    appearance = 'bg-slate-700 text-slate-500';
  } else if (active && group) {
    appearance = `${group.bg} text-white ring-2 ${group.ring} ring-offset-1 ring-offset-slate-800`;
  } else if (active) {
    appearance = 'bg-slate-600 text-white ring-2 ring-slate-400 ring-offset-1 ring-offset-slate-800';
  } else if (group) {
    appearance = `${group.bg} text-white/80`;
  } else {
    appearance = 'bg-slate-700 text-slate-500';
  }

  return (
    <div
      style={style}
      className={`flex items-center justify-center rounded h-7 mx-[2px] cursor-default select-none transition-all duration-100 ${appearance}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <span className={`leading-none ${small ? 'text-[8px]' : 'text-[10px] font-medium'}`}>
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KeyboardDisplay
// ---------------------------------------------------------------------------

function KeyboardDisplay({
  activeCodes,
  anyHovered,
  onHoverKey,
}: {
  activeCodes: Set<string>;
  anyHovered: boolean;
  onHoverKey: (code: string | null) => void;
}) {
  const layoutMap = useKeyboardLayoutMap();
  const keyLabel = (k: KeyDef) => layoutMap.get(k.code) ?? k.label;

  const gap = 3; // px between keys, matches space-y-[3px]

  const arrowKeys: { code: string; label: string; gridArea: string }[] = [
    { code: 'ArrowUp',    label: '↑', gridArea: '1 / 2' },
    { code: 'ArrowLeft',  label: '←', gridArea: '2 / 1' },
    { code: 'ArrowDown',  label: '↓', gridArea: '2 / 2' },
    { code: 'ArrowRight', label: '→', gridArea: '2 / 3' },
  ];

  return (
    <div className="flex items-end gap-2 select-none">
      {/* Main keyboard */}
      <div className="flex-1 min-w-0 space-y-[3px]">
        {ROWS.map((row, ri) => (
          <div key={ri} className="flex">
            {row.map(k => (
              <KeyCap
                key={k.code}
                code={k.code}
                label={keyLabel(k)}
                flex={k.flex}
                small={k.small}
                group={CODE_TO_GROUP.get(k.code)}
                active={activeCodes.has(k.code)}
                dimmed={anyHovered && !activeCodes.has(k.code)}
                onEnter={() => onHoverKey(k.code)}
                onLeave={() => onHoverKey(null)}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Arrow cluster — aligned to bottom of main keyboard */}
      <div
        className="flex-none"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(3, ${ARROW_KEY_PX}px)`,
          gridTemplateRows: `repeat(2, 28px)`,
          gap,
          marginBottom: 0,
        }}
      >
        {arrowKeys.map(ak => (
          <div key={ak.code} style={{ gridArea: ak.gridArea }}>
            <KeyCap
              code={ak.code}
              label={ak.label}
              fixedPx={ARROW_KEY_PX}
              group={CODE_TO_GROUP.get(ak.code)}
              active={activeCodes.has(ak.code)}
              dimmed={anyHovered && !activeCodes.has(ak.code)}
              onEnter={() => onHoverKey(ak.code)}
              onLeave={() => onHoverKey(null)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShortcutList
// ---------------------------------------------------------------------------

function ShortcutList({
  filteredIndices,
  highlightedIndex,
  onHoverShortcut,
}: {
  filteredIndices: number[] | null;
  highlightedIndex: number | null;
  onHoverShortcut: (index: number | null) => void;
}) {
  const showAll = filteredIndices === null;

  // Group ALL_SHORTCUTS by group for the "show all" view
  const grouped = GROUPS.map(g => ({
    group: g,
    entries: ALL_SHORTCUTS
      .map((s, i) => ({ ...s, index: i }))
      .filter(s => s.group === g),
  }));

  return (
    <div className="overflow-y-auto flex-1 min-h-0 space-y-3 pr-1">
      {showAll ? (
        grouped.map(({ group: g, entries }) => (
          <div key={g.name}>
            <p className={`text-[9px] uppercase tracking-wider font-semibold mb-1.5 ${g.text}`}>{g.name}</p>
            <div className="space-y-1">
              {entries.map(s => (
                <ShortcutRow
                  key={s.index}
                  display={s.display}
                  label={s.label}
                  highlighted={highlightedIndex === s.index}
                  onEnter={() => onHoverShortcut(s.index)}
                  onLeave={() => onHoverShortcut(null)}
                />
              ))}
            </div>
          </div>
        ))
      ) : filteredIndices.length === 0 ? (
        <p className="text-slate-500 text-xs italic">No shortcuts for this key</p>
      ) : (
        <div className="space-y-1">
          {filteredIndices.map(i => {
            const s = ALL_SHORTCUTS[i];
            return (
              <ShortcutRow
                key={i}
                display={s.display}
                label={s.label}
                highlighted={highlightedIndex === i}
                onEnter={() => onHoverShortcut(i)}
                onLeave={() => onHoverShortcut(null)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ShortcutRow({ display, label, highlighted, onEnter, onLeave }: {
  display: string; label: string;
  highlighted: boolean; onEnter: () => void; onLeave: () => void;
}) {
  return (
    <div
      className={`grid grid-cols-[1fr_auto] items-center gap-3 rounded px-1 py-0.5 cursor-default transition-colors ${highlighted ? 'bg-slate-700' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <span className="text-[11px] text-slate-400 truncate">{label}</span>
      <span className="font-mono text-[10px] text-slate-300 bg-slate-600 px-1 rounded whitespace-nowrap">{display}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
      {GROUPS.map(g => (
        <div key={g.name} className="flex items-center gap-1">
          <span className={`w-2 h-2 rounded-sm ${g.bg}`} />
          <span className="text-[9px] text-slate-400">{g.name}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function KeyboardShortcutsView() {
  const [keyHover, setKeyHover] = useState<string | null>(null);
  const [shortcutHover, setShortcutHover] = useState<number | null>(null);

  const activeCodes = useMemo<Set<string>>(() => {
    if (shortcutHover !== null) return codesForShortcut(ALL_SHORTCUTS[shortcutHover]);
    if (keyHover) return new Set([keyHover]);
    return new Set();
  }, [keyHover, shortcutHover]);

  // When hovering a key: filter list to matching shortcuts
  // When hovering a shortcut row: show all, just highlight the hovered row
  const filteredIndices = useMemo<number[] | null>(() => {
    if (shortcutHover !== null) return null; // show all
    if (!keyHover) return null;
    const matches = shortcutsForCode(keyHover);
    return matches.map(s => ALL_SHORTCUTS.indexOf(s));
  }, [keyHover, shortcutHover]);

  const highlightedIndex = shortcutHover;

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex-none">
        <KeyboardDisplay activeCodes={activeCodes} anyHovered={activeCodes.size > 0} onHoverKey={setKeyHover} />
        <Legend />
      </div>
      <div className="flex-none h-px bg-slate-700" />
      <ShortcutList
        filteredIndices={filteredIndices}
        highlightedIndex={highlightedIndex}
        onHoverShortcut={setShortcutHover}
      />
    </div>
  );
}
