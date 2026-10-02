import { toAssetUrl, toVideoServerUrl } from './tauriCommands';
import { isLinux } from './platform';

/**
 * URL for the `<video>` element. On Linux, WebKitGTK's GStreamer pipeline can't
 * resolve the `asset://` scheme (see `toVideoServerUrl`), so it is served over a
 * local HTTP loopback there; macOS/Windows use asset:// directly. fetch()-based
 * paths (VideoFrameSource) keep using `toAssetUrl` regardless of platform.
 */
export async function resolveVideoElementUrl(absolutePath: string): Promise<string> {
  return isLinux ? toVideoServerUrl(absolutePath) : toAssetUrl(absolutePath);
}
