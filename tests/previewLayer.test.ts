import { describe, it, expect } from 'vitest';
import { previewLayerIndex } from '../utils/previewLayer';
import { calculateAnnotationLayers } from '../utils/helpers';
import type { Annotation } from '../types';

const ann = (id: string, start: number, end: number): Annotation => ({ id, start, end, text: '' });

describe('previewLayerIndex', () => {
  it('is 0 with nothing to dodge', () => {
    expect(previewLayerIndex([], 5)).toBe(0);
  });

  it('stacks above an overlapping annotation and reuses a freed layer', () => {
    const layered = calculateAnnotationLayers([ann('a', 0, 10), ann('b', 2, 4)]);
    expect(previewLayerIndex(layered, 3)).toBe(2);
    expect(previewLayerIndex(layered, 5)).toBe(1);
    expect(previewLayerIndex(layered, 12)).toBe(0);
  });

  it('matches re-running the layering with the preview appended (randomised)', () => {
    let seed = 12345;
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let trial = 0; trial < 200; trial++) {
      const n = Math.floor(rand() * 12);
      const anns: Annotation[] = [];
      for (let i = 0; i < n; i++) {
        // Coarse grid so equal starts and abutting edges actually occur.
        const s = Math.floor(rand() * 20);
        anns.push(ann(`a${i}`, s, s + 1 + Math.floor(rand() * 8)));
      }
      const start = Math.floor(rand() * 24);
      const end = start + 1 + Math.floor(rand() * 6);
      const expected = calculateAnnotationLayers([...anns, ann('__preview__', start, end)])
        .find(a => a.id === '__preview__')!.layerIndex;
      expect(previewLayerIndex(calculateAnnotationLayers(anns), start)).toBe(expected);
    }
  });
});
