import React, { useCallback, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import ContextMenu, { ContextMenuItem } from '../components/ContextMenu';

/** A "Refresh …" context-menu item, shared so every panel builds it the same way. */
export function refreshMenuItem(label: string, onRefresh: () => void, separatorBefore = false): ContextMenuItem {
  return { label, icon: <RefreshCw size={12} />, onSelect: onRefresh, separatorBefore };
}

/**
 * A right-click menu with a single refresh action, for a sidebar section's
 * header. Spread `onContextMenu` onto the header and render `menu` somewhere in
 * the section. With no `onRefresh` (the guide's live copies have nothing to
 * refresh) the header keeps the browser's default behavior.
 */
export function useRefreshMenu(label: string, onRefresh: (() => void) | undefined) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onRefresh) return;
    e.preventDefault();
    setPos({ x: e.clientX, y: e.clientY });
  }, [onRefresh]);
  const menu = pos && onRefresh
    ? <ContextMenu x={pos.x} y={pos.y} items={[refreshMenuItem(label, onRefresh)]} onClose={() => setPos(null)} minWidth={150} />
    : null;
  return { onContextMenu, menu };
}
