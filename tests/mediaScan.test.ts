import { describe, it, expect } from 'vitest';
import { partialUpdateDelayMs } from '../utils/mediaScan';

describe('partialUpdateDelayMs', () => {
  it('starts at one second and grows with the list', () => {
    expect(partialUpdateDelayMs(0)).toBe(1000);
    expect(partialUpdateDelayMs(200_000)).toBe(3000);
  });
});
