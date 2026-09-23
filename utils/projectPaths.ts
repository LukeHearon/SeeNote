import { ProjectPath, ProjectPreferences, ProjectSettings, Project, ProjectRegistryEntry } from '../types';

function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

/** Last path segment of a file or directory path (trailing separators ignored). */
export function basename(p: string): string {
  const stripped = stripTrailingSep(p);
  const idx = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return idx >= 0 ? stripped.slice(idx + 1) : stripped;
}

/** Join a base directory with a relative segment, always with `/` (this
 * codebase displays resolved paths with forward slashes regardless of
 * platform — see `resolveInputPath`). Leading `./`/`/` on `rest` is stripped. */
export function joinPath(base: string, rest: string): string {
  const baseClean = stripTrailingSep(base);
  const restClean = rest.replace(/^(?:\.[/\\]+)+/, '').replace(/^[/\\]+/, '');
  return restClean ? baseClean + '/' + restClean : baseClean;
}

/** True for paths that are already absolute (unix `/`, home `~/`, Windows drive `C:\`). */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~/') || /^[A-Za-z]:[/\\]/.test(p);
}

/**
 * Lexically collapse `.` and `..` segments. Keeps the root (`/`, `~/`, `C:\`)
 * and the separator the path first uses; never climbs above the root. Paths
 * without dot segments come back unchanged.
 *
 * Needed because the Rust side canonicalizes before listing, so a root like
 * `/proj/../audio` would never prefix-match the file paths it returns.
 */
export function normalizePath(p: string): string {
  const segs = p.split(/[/\\]/);
  if (!segs.some(s => s === '.' || s === '..')) return p;
  const sep = p.match(/[/\\]/)?.[0] ?? '/';
  const head = segs[0];
  const root = head === '' || head === '~' || /^[A-Za-z]:$/.test(head) ? head : null;
  const out: string[] = [];
  for (const s of root === null ? segs : segs.slice(1)) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (root === null) out.push('..');
      continue;
    }
    out.push(s);
  }
  if (root !== null) return root + sep + out.join(sep);
  return out.join(sep) || '.';
}

/**
 * Given a user-typed directory value (possibly relative) and the project
 * directory, return the fully-resolved absolute path.
 */
export function resolveInputPath(projectDir: string, input: string): string {
  if (!input) return '';
  if (isAbsolutePath(input)) return normalizePath(input);
  return normalizePath(stripTrailingSep(projectDir) + '/' + input);
}

/**
 * If `absPath` lives inside `projectDir`, strip the project prefix and return
 * just the subdirectory name(s). Otherwise returns `absPath` unchanged.
 * Safe to call on every keystroke — only activates when the exact prefix is present.
 */
export function trimProjectPrefix(projectDir: string, absPath: string): string {
  if (!projectDir || !absPath) return absPath;
  const root = stripTrailingSep(projectDir);
  if (absPath.startsWith(root + '/') || absPath.startsWith(root + '\\')) {
    return absPath.slice(root.length + 1);
  }
  return absPath;
}

/** True if `absPath` sits strictly inside directory `dir` (accepts either separator). */
export function isInsideDir(dir: string, absPath: string): boolean {
  const root = stripTrailingSep(dir);
  return absPath.startsWith(root + '/') || absPath.startsWith(root + '\\');
}

/** Resolve a `ProjectPath` against the project directory to an absolute path. */
export function resolveProjectPath(projectDir: string, p: ProjectPath): string {
  if (p.kind === 'absolute') return normalizePath(p.path);
  // Relative — './foo' or 'foo' is a child of projectDir, '../foo' a neighbour.
  return normalizePath(joinPath(projectDir, p.path));
}

/**
 * Returns true if `absPath` is the same as `projectDir` or strictly inside it.
 * Path equality is loose (string-level) — matches what the rest of the app
 * already does for path comparisons.
 */
export function isInsideProjectDir(projectDir: string, absPath: string): boolean {
  return absPath === stripTrailingSep(projectDir) || isInsideDir(projectDir, absPath);
}

/** Most `..` steps a path outside the project may take and still be stored relative. */
export const MAX_RELATIVE_UPS = 2;

/**
 * True when a shared ancestor is too broad to mean the two folders belong
 * together: the filesystem or drive root, a top-level dir (`/Users`,
 * `/Volumes`, `~`), or a home / per-user mount dir.
 */
function isGrabBagAncestor(segs: string[]): boolean {
  const s = segs.filter(Boolean);
  if (s.length <= 1) return true;
  const drive = /^[A-Za-z]:$/.test(s[0]);
  if (s.length === 2) return drive || ['Users', 'home', 'media', 'run'].includes(s[0]);
  if (s.length === 3) {
    return (drive && s[1].toLowerCase() === 'users') || (s[0] === 'run' && s[1] === 'media');
  }
  return false;
}

/**
 * `../`-relative form of `absPath` from `projectDir`, or null when it would take
 * more than MAX_RELATIVE_UPS steps up or the shared ancestor is a grab bag
 * (a far-off absolute path is more legible, and would never move with the project).
 */
function relativeOutside(projectDir: string, absPath: string): string | null {
  const a = projectDir.split(/[/\\]/);
  const b = absPath.split(/[/\\]/);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ups = a.length - i;
  if (ups < 1 || ups > MAX_RELATIVE_UPS || isGrabBagAncestor(a.slice(0, i))) return null;
  return [...Array(ups).fill('..'), ...b.slice(i)].join('/');
}

/**
 * Convert an absolute path picked by the user into a `ProjectPath`. Paths
 * inside the project directory are stored relative (with a leading `./`) so
 * the project remains portable when the directory is moved between machines.
 * Nearby paths outside it (at most MAX_RELATIVE_UPS levels up) are stored as
 * `../` paths, so a project and its sibling data folder can move together.
 */
export function makeProjectPath(projectDir: string, absPath: string): ProjectPath {
  const root = stripTrailingSep(normalizePath(projectDir));
  const abs = stripTrailingSep(normalizePath(absPath));
  if (abs === root) {
    return { kind: 'relative', path: './' };
  }
  if (isInsideProjectDir(root, abs)) {
    const rel = abs.slice(root.length).replace(/^[/\\]+/, '');
    return { kind: 'relative', path: './' + rel };
  }
  const rel = relativeOutside(root, abs);
  return rel ? { kind: 'relative', path: rel } : { kind: 'absolute', path: abs };
}

/**
 * Convert a directory field's value into a `ProjectPath`. A typed relative path
 * is kept relative however far up it goes — the MAX_RELATIVE_UPS cap only
 * applies when converting an absolute path.
 */
export function inputToProjectPath(projectDir: string, input: string): ProjectPath {
  if (isAbsolutePath(input)) return makeProjectPath(projectDir, input);
  const rel = normalizePath(input);
  if (rel === '.') return { kind: 'relative', path: './' };
  return { kind: 'relative', path: rel.startsWith('..') ? rel : './' + rel };
}

/** The directory-field value for a stored `ProjectPath` (inverse of `inputToProjectPath`). */
export function projectPathInput(p: ProjectPath): string {
  if (p.kind === 'absolute') return p.path;
  return p.path.replace(/^(?:\.[/\\]+)+/, '') || '.';
}

/** Build the full in-memory `Project` from a registry entry + loaded settings + preferences. */
export function buildProject(
  registry: ProjectRegistryEntry,
  settings: ProjectSettings,
  preferences: ProjectPreferences = {},
): Project {
  return {
    id: registry.id,
    projectDir: registry.projectDir,
    lastOpened: registry.lastOpened,
    settings,
    preferences,
    mediaDirectoryAbs: resolveProjectPath(registry.projectDir, settings.mediaDirectory),
    annotationDirectoryAbs: resolveProjectPath(registry.projectDir, settings.annotationDirectory),
    buzzdetectDirectoryAbs: settings.buzzdetectDirectory
      ? resolveProjectPath(registry.projectDir, settings.buzzdetectDirectory)
      : null,
  };
}
