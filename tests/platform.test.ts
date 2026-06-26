import { describe, it, expect } from 'vitest';
import { formatModKey, MOD_KEY_LABEL } from '../utils/platform';

describe('formatModKey', () => {
  it('replaces a single {mod} token with the platform modifier label', () => {
    expect(formatModKey('{mod}+Z')).toBe(`${MOD_KEY_LABEL}+Z`);
  });

  it('replaces every occurrence', () => {
    expect(formatModKey('{mod}+← / {mod}+→')).toBe(
      `${MOD_KEY_LABEL}+← / ${MOD_KEY_LABEL}+→`
    );
  });

  it('leaves text without the token untouched', () => {
    expect(formatModKey('Shift+F')).toBe('Shift+F');
  });

  it('resolves to ⌘ or Ctrl only', () => {
    expect(['⌘', 'Ctrl']).toContain(MOD_KEY_LABEL);
  });
});
