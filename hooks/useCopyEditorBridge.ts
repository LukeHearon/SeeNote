import { useState, useEffect, useMemo } from 'react';
import { useHotkeys } from './useHotkeys';
import { useCopyRerenderOnChange, copyChannel, getAccessedKeys } from '../copy/overrideStore';
import { buildRegistry } from '../copy/registry';
import { openCopyEditorWindow } from '../utils/tauriCommands';

const DEV_MODE = import.meta.env.DEV;

function buildValueToKey(registry: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(registry)) {
    const norm = v.toLowerCase().trim();
    if (norm && !map.has(norm)) map.set(norm, k);
  }
  return map;
}

function findKeyForElement(target: Element, valueToKey: Map<string, string>): string | null {
  let node: Element | null = target;
  while (node) {
    const candidates: string[] = [];
    const dataTooltip = node.getAttribute('data-tooltip');
    const title = node.getAttribute('title');
    const placeholder = node.getAttribute('placeholder');
    const ariaLabel = node.getAttribute('aria-label');
    if (dataTooltip) candidates.push(dataTooltip);
    if (title) candidates.push(title);
    if (placeholder) candidates.push(placeholder);
    if (ariaLabel) candidates.push(ariaLabel);
    if (node.children.length === 0 && node.textContent) candidates.push(node.textContent.trim());
    for (const text of candidates) {
      const key = valueToKey.get(text.toLowerCase().trim());
      if (key) return key;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Wires a window into the copy editor: re-renders on override changes, and
 * handles pick mode (click-to-pick a copy key, broadcast over `copyChannel`).
 * Used by every standalone window so copy edits apply live everywhere, not just
 * in the main App window.
 */
export function useCopyEditorBridge() {
  useCopyRerenderOnChange();
  const [pickMode, setPickMode] = useState(false);

  const base = useMemo(() => DEV_MODE ? buildRegistry() : {}, []);
  const valueToKey = useMemo(() => DEV_MODE ? buildValueToKey(base) : new Map<string, string>(), [base]);

  // Receive togglePick from the copy editor window
  useEffect(() => {
    if (!DEV_MODE || !copyChannel) return;
    const handler = (e: MessageEvent) => {
      if ((e.data as Record<string, unknown>)?.type === 'togglePick') setPickMode(p => !p);
    };
    copyChannel.addEventListener('message', handler);
    return () => copyChannel.removeEventListener('message', handler);
  }, []);

  // Manage pick mode: cursor, click capture, broadcast
  useEffect(() => {
    if (!DEV_MODE) return;
    copyChannel?.postMessage({ type: 'pickModeChanged', active: pickMode });
    if (!pickMode) {
      document.body.classList.remove('pick-mode');
      return;
    }
    document.body.classList.add('pick-mode');
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const found = findKeyForElement(e.target as Element, valueToKey);
      if (found) {
        copyChannel?.postMessage({ type: 'pick', key: found });
        setPickMode(false);
      }
    };
    document.addEventListener('click', handler, true);
    return () => {
      document.removeEventListener('click', handler, true);
      document.body.classList.remove('pick-mode');
    };
  }, [pickMode, valueToKey]);

  useHotkeys([
    {
      key: 'e', mods: ['mod', 'shift', 'alt'],
      handler: () => DEV_MODE && copyChannel?.postMessage({ type: 'toggleShowAll' }),
    },
    {
      key: 'e', mods: ['mod', 'shift'],
      handler: () => {
        if (!DEV_MODE) return;
        try { localStorage.setItem('copy:accessedKeys', JSON.stringify([...getAccessedKeys()])); } catch { /* */ }
        openCopyEditorWindow();
        setPickMode(p => !p);
      },
    },
  ]);
}
