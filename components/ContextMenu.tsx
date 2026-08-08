import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  /** Leading icon, sized by the caller (12–14px reads right at this scale). */
  icon?: React.ReactNode;
  /** Red label, for destructive actions. */
  danger?: boolean;
  /** Draw a hairline divider above this item. Ignored on the first item. */
  separatorBefore?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  minWidth?: number;
}

/**
 * The app's right-click menu: a fixed-position list of actions that closes on
 * outside click, Escape, or a selection. Shared by every panel with a context
 * menu (file tree, annotation tools, neurons) so they stay identical.
 *
 * The menu is kept inside the viewport after mount, by measuring it and
 * flipping it back over the cursor if it would overflow — panels near the
 * bottom-left of the window (the palettes) otherwise open menus that run off
 * the bottom edge.
 */
export default function ContextMenu({ x, y, items, onClose, minWidth = 160 }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: x + width > window.innerWidth ? Math.max(4, x - width) : x,
      top: y + height > window.innerHeight ? Math.max(4, y - height) : y,
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[100] bg-slate-800 border border-slate-600 rounded-lg shadow-2xl py-1"
      style={{ left: pos.left, top: pos.top, minWidth }}
    >
      {items.map((item, i) => (
        <React.Fragment key={`${item.label}-${i}`}>
          {item.separatorBefore && i > 0 && <div className="my-1 border-t border-slate-700" />}
          <button
            disabled={item.disabled}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors
              ${item.disabled ? 'text-slate-600 cursor-default' : item.danger ? 'text-red-400 hover:bg-slate-700' : 'text-slate-200 hover:bg-slate-700'}`}
            onClick={() => { if (item.disabled) return; item.onSelect(); onClose(); }}
          >
            {item.icon && <span className="flex-none text-slate-500">{item.icon}</span>}
            <span className="flex-1 min-w-0 truncate">{item.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
