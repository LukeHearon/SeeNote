import type { VideoMode } from '../types';

/**
 * Whether the frame-accurate canvas (backed by a VideoFrameSource) is the
 * renderer the current mode/selection state is asking for — independent of
 * whether a VideoFrameSource actually exists for this file's format.
 *
 * Shared by VideoPane (picks canvas vs. the plain <video> element to render)
 * and usePlaybackTransport (picks AudioEngine vs. VideoElementEngine to drive
 * playback) so the two decisions can never disagree — see CLAUDE.md's
 * no-duplicated-logic rule. Callers combine this with their own frame-source
 * availability check (`wantsCanvasRenderer(...) && hasFrameSource`) since a
 * format like WEBM can request canvas rendering but have no frame source,
 * in which case the <video> element must be both the picture AND the
 * transport.
 */
export function wantsCanvasRenderer(mode: VideoMode, hasSelection: boolean): boolean {
  return mode === 'accurate' || (mode === 'mixed' && hasSelection);
}

/**
 * The mode to *display* in the UI. When `mode` wants the canvas but this
 * file has no VideoFrameSource (e.g. WEBM — see VideoFrameSource's MP4/MOV-only
 * `canUseFrameSource`), playback silently falls back to the plain <video>
 * element — behaviorally identical to Fast. The picker should say so, rather
 * than claim a frame-accurate guarantee that isn't actually happening.
 *
 * Does NOT change the persisted `videoMode` — only what's displayed — so a
 * later, compatible file still resumes at the mode the user actually picked.
 */
export function displayVideoMode(
  mode: VideoMode,
  hasSelection: boolean,
  hasFrameSource: boolean,
): VideoMode {
  if (mode !== 'off' && wantsCanvasRenderer(mode, hasSelection) && !hasFrameSource) return 'fast';
  return mode;
}
