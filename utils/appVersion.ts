/**
 * The version this build was compiled from, inlined by Vite's `define` (see
 * vite.config.ts) rather than fetched over IPC.
 *
 * The debug console used to get the version from `get_diagnostic_info`, and
 * when that invoke failed the version line silently vanished — which is
 * exactly the situation where knowing the version matters most. A build-time
 * constant can't fail.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown';
