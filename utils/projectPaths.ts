import { ProjectPath, ProjectSettings, Project, ProjectRegistryEntry } from '../types';

function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

function joinPath(base: string, rest: string): string {
  const baseClean = stripTrailingSep(base);
  const restClean = rest.replace(/^(?:\.[/\\]+)+/, '').replace(/^[/\\]+/, '');
  return restClean ? baseClean + '/' + restClean : baseClean;
}

/** True for paths that are already absolute (unix `/`, home `~/`, Windows drive `C:\`). */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~/') || /^[A-Za-z]:[/\\]/.test(p);
}

/**
 * Given a user-typed directory value (possibly relative) and the project
 * directory, return the fully-resolved absolute path.
 */
export function resolveInputPath(projectDir: string, input: string): string {
  if (!input) return '';
  if (isAbsolutePath(input)) return input;
  return stripTrailingSep(projectDir) + '/' + input;
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

/** Resolve a `ProjectPath` against the project directory to an absolute path. */
export function resolveProjectPath(projectDir: string, p: ProjectPath): string {
  if (p.kind === 'absolute') return p.path;
  // Relative — interpret './foo' or 'foo' as a child of projectDir.
  return joinPath(projectDir, p.path);
}

/**
 * Returns true if `absPath` is the same as `projectDir` or strictly inside it.
 * Path equality is loose (string-level) — matches what the rest of the app
 * already does for path comparisons.
 */
export function isInsideProjectDir(projectDir: string, absPath: string): boolean {
  const root = stripTrailingSep(projectDir);
  if (absPath === root) return true;
  return absPath.startsWith(root + '/') || absPath.startsWith(root + '\\');
}

/**
 * Convert an absolute path picked by the user into a `ProjectPath`. Paths
 * inside the project directory are stored relative (with a leading `./`) so
 * the project remains portable when the directory is moved between machines.
 */
export function makeProjectPath(projectDir: string, absPath: string): ProjectPath {
  const root = stripTrailingSep(projectDir);
  if (absPath === root) {
    return { kind: 'relative', path: './' };
  }
  if (isInsideProjectDir(projectDir, absPath)) {
    const rel = absPath.slice(root.length).replace(/^[/\\]+/, '');
    return { kind: 'relative', path: './' + rel };
  }
  return { kind: 'absolute', path: absPath };
}

/** Build the full in-memory `Project` from a registry entry + loaded settings. */
export function buildProject(
  registry: ProjectRegistryEntry,
  settings: ProjectSettings,
): Project {
  return {
    id: registry.id,
    projectDir: registry.projectDir,
    lastOpened: registry.lastOpened,
    settings,
    mediaDirectoryAbs: resolveProjectPath(registry.projectDir, settings.mediaDirectory),
    annotationDirectoryAbs: resolveProjectPath(registry.projectDir, settings.annotationDirectory),
  };
}
