import { describe, it, expect } from 'vitest';
import {
  sidebarSectionsFromUiSettings,
  DEFAULT_SIDEBAR_SECTIONS,
  SIDEBAR_SECTION_FILES,
  SIDEBAR_SECTION_LABELS,
  SIDEBAR_SECTION_NEURONS,
} from '../constants';

describe('sidebarSectionsFromUiSettings', () => {
  it('falls back to the defaults when nothing is persisted', () => {
    expect(sidebarSectionsFromUiSettings(undefined, undefined)).toEqual(DEFAULT_SIDEBAR_SECTIONS);
  });

  it('seeds the two legacy sections from leftPanelRatio', () => {
    const out = sidebarSectionsFromUiSettings(undefined, 0.75);
    expect(out[SIDEBAR_SECTION_FILES].weight).toBeCloseTo(0.75);
    expect(out[SIDEBAR_SECTION_LABELS].weight).toBeCloseTo(0.25);
    // The neuron palette has no legacy counterpart, so it keeps its default.
    expect(out[SIDEBAR_SECTION_NEURONS]).toEqual(DEFAULT_SIDEBAR_SECTIONS[SIDEBAR_SECTION_NEURONS]);
  });

  it('prefers saved sections over the legacy ratio', () => {
    const saved = { [SIDEBAR_SECTION_FILES]: { weight: 2, collapsed: true } };
    const out = sidebarSectionsFromUiSettings(saved, 0.75);
    expect(out[SIDEBAR_SECTION_FILES]).toEqual({ weight: 2, collapsed: true });
  });

  it('backfills sections missing from a saved layout', () => {
    const saved = { [SIDEBAR_SECTION_FILES]: { weight: 2, collapsed: false } };
    const out = sidebarSectionsFromUiSettings(saved, undefined);
    expect(out[SIDEBAR_SECTION_NEURONS]).toEqual(DEFAULT_SIDEBAR_SECTIONS[SIDEBAR_SECTION_NEURONS]);
    expect(out[SIDEBAR_SECTION_LABELS]).toEqual(DEFAULT_SIDEBAR_SECTIONS[SIDEBAR_SECTION_LABELS]);
  });
});
