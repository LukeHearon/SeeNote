import type React from 'react';

/** Minimal shape of a sidebar section's persisted layout (see hooks/useSidebarSections.ts). */
export interface SectionLayout {
  weight: number;
  collapsed: boolean;
}

/**
 * Flex style for one section of the sidebar stack.
 *
 * Grow factors are normalised so the expanded sections' factors always sum to
 * 1. Weights are stored as raw ratios (0.6 / 0.4 / 0.4 by default), and CSS
 * only hands out the *whole* free space when the grow factors sum to at least
 * 1 — so without normalising, collapsing a section drops the remaining sum
 * below 1 and the stack leaves dead space at the bottom instead of pushing the
 * collapsed headers down to it.
 *
 * `ids` is the set of sections actually rendered (the neuron palette is absent
 * without buzzdetect data), so the normalisation ignores sections that aren't
 * on screen.
 */
export function sectionFlexStyle(
  states: Record<string, SectionLayout>,
  ids: string[],
  id: string,
): React.CSSProperties {
  const weightOf = (sectionId: string) => {
    const w = states[sectionId]?.weight;
    return typeof w === 'number' && w > 0 ? w : 1;
  };
  const collapsed = states[id]?.collapsed ?? false;
  // Collapsed: the section is its header and nothing else, so let it size to
  // its content.
  if (collapsed) return { flex: 'none' };

  const expanded = ids.filter(sectionId => !(states[sectionId]?.collapsed ?? false));
  const sum = expanded.reduce((acc, sectionId) => acc + weightOf(sectionId), 0);
  const grow = sum > 0 ? weightOf(id) / sum : 1;
  // Grow from a zero basis, which makes the weights a pure ratio regardless of
  // what each body contains.
  return { flexGrow: grow, flexShrink: 1, flexBasis: 0, minHeight: 0 };
}
