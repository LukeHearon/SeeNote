import { openDirectoryDialog, openDirectoryDialogAt } from './tauriCommands';
import { findFirstValidAncestor } from './helpers';

/**
 * Directory picker opened at `path`, or at its nearest ancestor that still
 * exists (the configured folder may be the thing that went missing). Null if
 * the user cancels.
 */
export async function browseDirectoryNear(path: string): Promise<string | null> {
  const startDir = await findFirstValidAncestor(path).catch(() => '');
  return startDir ? openDirectoryDialogAt(startDir) : openDirectoryDialog();
}
