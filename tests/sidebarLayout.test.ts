import { describe, it, expect } from 'vitest';
import { sectionFlexStyle, SectionLayout } from '../utils/sidebarLayout';

const states = (...entries: Array<[string, number, boolean]>): Record<string, SectionLayout> =>
  Object.fromEntries(entries.map(([id, weight, collapsed]) => [id, { weight, collapsed }]));

const ids = ['files', 'labels', 'neurons'];

const growOf = (s: Record<string, SectionLayout>, id: string) =>
  sectionFlexStyle(s, ids, id).flexGrow as number;

const totalGrow = (s: Record<string, SectionLayout>) =>
  ids.reduce((acc, id) => acc + ((sectionFlexStyle(s, ids, id).flexGrow as number) ?? 0), 0);

describe('sectionFlexStyle', () => {
  it('gives a collapsed section no flex at all', () => {
    const s = states(['files', 0.6, false], ['labels', 0.4, true], ['neurons', 0.4, true]);
    expect(sectionFlexStyle(s, ids, 'labels')).toEqual({ flex: 'none' });
  });

  it('keeps the expanded grow factors summing to 1 so no dead space is left', () => {
    // Raw weights sum to 1.4 with everything open and 0.6 with only the file
    // tree open — either way the sections must claim the whole stack.
    const open = states(['files', 0.6, false], ['labels', 0.4, false], ['neurons', 0.4, false]);
    expect(totalGrow(open)).toBeCloseTo(1);
    const oneOpen = states(['files', 0.6, false], ['labels', 0.4, true], ['neurons', 0.4, true]);
    expect(totalGrow(oneOpen)).toBeCloseTo(1);
    expect(growOf(oneOpen, 'files')).toBeCloseTo(1);
  });

  it('preserves the ratio between the sections that are still open', () => {
    const s = states(['files', 3, false], ['labels', 1, false], ['neurons', 1, true]);
    expect(growOf(s, 'files') / growOf(s, 'labels')).toBeCloseTo(3);
  });

  it('ignores sections that are not rendered', () => {
    const s = states(['files', 1, false], ['labels', 1, false], ['neurons', 2, false]);
    const twoIds = ['files', 'labels'];
    expect(sectionFlexStyle(s, twoIds, 'files').flexGrow).toBeCloseTo(0.5);
  });

  it('falls back to an even split for missing or non-positive weights', () => {
    const s = states(['files', 0, false], ['labels', -1, false]);
    expect(sectionFlexStyle(s, ['files', 'labels'], 'files').flexGrow).toBeCloseTo(0.5);
    expect(sectionFlexStyle({}, ['a', 'b'], 'a').flexGrow).toBeCloseTo(0.5);
  });
});
