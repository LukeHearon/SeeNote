// Platform detection + OS-specific modifier-key display.
//
// The "primary modifier" (what useHotkeys calls 'mod') is ⌘ on macOS and Ctrl
// everywhere else. UI copy should use the `{mod}` token instead of a literal
// "Cmd/Ctrl" and let `formatModKey` resolve it for the current platform.

export const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export const isLinux =
  typeof navigator !== 'undefined' && /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

/** OS-appropriate label for the primary command modifier: ⌘ on macOS, Ctrl elsewhere. */
export const MOD_KEY_LABEL = isMac ? '⌘' : 'Ctrl';

/** Token used in UI copy / shortcut display strings, resolved by `formatModKey`. */
export const MOD_TOKEN = '{mod}';

/** Replace every `{mod}` token with the OS-appropriate modifier label. */
export function formatModKey(text: string): string {
  return text.split(MOD_TOKEN).join(MOD_KEY_LABEL);
}
