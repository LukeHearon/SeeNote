import { describe, it, expect, vi } from 'vitest';
import {
  annotationMatchingTool,
  canBindAnnotationToHotkey,
  bindAnnotationToHotkey,
} from '../utils/bindAnnotationHotkey';
import type { AnnotationTool } from '../types';

const tool = (key: string | null, text: string): AnnotationTool => ({ id: `id-${text}`, key, text, color: '#111' });
const baseTools = [tool('0', 'Custom'), tool('1', 'bird')];

describe('canBindAnnotationToHotkey', () => {
  it('is false for an empty label', () => {
    expect(canBindAnnotationToHotkey({ text: '' }, baseTools)).toBe(false);
  });

  it('is false when the label already has a tool on a key', () => {
    expect(canBindAnnotationToHotkey({ text: 'Bird' }, baseTools)).toBe(false);
  });

  it('is true for a new label with a free key', () => {
    expect(canBindAnnotationToHotkey({ text: 'frog' }, baseTools)).toBe(true);
  });

  it('is true for a label whose tool is unassigned', () => {
    expect(canBindAnnotationToHotkey({ text: 'wind' }, [...baseTools, tool(null, 'wind')])).toBe(true);
  });

  it('is false when all nine hotkeys are taken', () => {
    const full = [tool('0', 'Custom'), ...Array.from({ length: 9 }, (_, i) => tool(String(i + 1), `t${i}`))];
    expect(canBindAnnotationToHotkey({ text: 'frog' }, full)).toBe(false);
  });
});

describe('bindAnnotationToHotkey', () => {
  it('assigns an existing unassigned tool to the next free key', () => {
    const onBindHotkey = vi.fn();
    const onCreateTool = vi.fn();
    const boundKey = bindAnnotationToHotkey({ text: 'wind' }, [...baseTools, tool(null, 'wind')], { onBindHotkey, onCreateTool });
    expect(boundKey).toBe('2');
    expect(onBindHotkey).toHaveBeenCalledWith('id-wind', '2');
    expect(onCreateTool).not.toHaveBeenCalled();
  });

  it('creates a tool for an unmatched label on the next free key', () => {
    const onBindHotkey = vi.fn();
    const onCreateTool = vi.fn();
    bindAnnotationToHotkey({ text: 'frog' }, baseTools, { onBindHotkey, onCreateTool });
    expect(onCreateTool).toHaveBeenCalledWith('frog', expect.any(String), '2');
  });

  it('does nothing and returns null when it cannot act', () => {
    const onBindHotkey = vi.fn();
    const onCreateTool = vi.fn();
    expect(bindAnnotationToHotkey({ text: 'Bird' }, baseTools, { onBindHotkey, onCreateTool })).toBe(null);
    expect(onBindHotkey).not.toHaveBeenCalled();
    expect(onCreateTool).not.toHaveBeenCalled();
  });
});

describe('annotationMatchingTool', () => {
  it('matches case-insensitively and never the Custom tool', () => {
    expect(annotationMatchingTool({ text: 'BIRD' }, baseTools)?.id).toBe('id-bird');
    expect(annotationMatchingTool({ text: 'Custom' }, baseTools)).toBeUndefined();
  });
});
