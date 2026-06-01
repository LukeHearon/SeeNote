import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Project,
  ProjectListEntry,
  ProjectRegistryEntry,
  ProjectSettings,
  RelinkDirStatus,
  RelinkInfo,
  RelinkResolution,
} from '../types';
import {
  getAppDataDir,
  loadRegistry,
  saveRegistry,
  readProjectSettings,
  writeProjectSettings,
  projectDirExists,
} from '../utils/projectCommands';
import { buildProject, basename, makeProjectPath } from '../utils/projectPaths';

function getProjectsFilePath(appDataDir: string): string {
  const base = appDataDir.replace(/[/\\]+$/, '');
  return base + '/.projects/projects.json';
}

async function resolveEntry(registry: ProjectRegistryEntry): Promise<ProjectListEntry> {
  const exists = await projectDirExists(registry.projectDir).catch(() => false);
  if (!exists) return { status: 'missing-dir', registry };
  try {
    const settings = await readProjectSettings(registry.projectDir);
    // Mirror name and gradient colors so they survive the project going missing.
    const colors = settings.nameGradientColors;
    const nameChanged = settings.name && settings.name !== registry.name;
    const colorsChanged = JSON.stringify(colors ?? null) !== JSON.stringify(registry.nameGradientColors ?? null);
    const withMirror = (nameChanged || colorsChanged)
      ? { ...registry, name: settings.name, nameGradientColors: colors }
      : registry;
    return { status: 'ok', registry: withMirror, project: buildProject(withMirror, settings) };
  } catch (err) {
    return {
      status: 'bad-settings',
      registry,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function useProjects() {
  const [entries, setEntries] = useState<ProjectListEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectsFilePath, setProjectsFilePath] = useState<string | null>(null);

  const projectsFileRef = useRef<string | null>(null);
  // Mirror of registry array, updated synchronously alongside `entries` so
  // mutations (touchLastOpened, etc.) never see a stale snapshot.
  const registryRef = useRef<ProjectRegistryEntry[]>([]);
  const entriesRef = useRef<ProjectListEntry[]>([]);

  const setBoth = useCallback((next: ProjectListEntry[]) => {
    entriesRef.current = next;
    registryRef.current = next.map(e => e.registry);
    setEntries(next);
  }, []);

  const persistRegistry = useCallback(async (registry: ProjectRegistryEntry[]) => {
    if (!projectsFileRef.current) {
      console.error('persistRegistry called before projectsFileRef was set');
      return;
    }
    try {
      await saveRegistry(projectsFileRef.current, registry);
    } catch (err) {
      console.error('Failed to save project registry:', err);
      throw err;
    }
  }, []);

  // Initial load: read the registry file but do NOT touch any project
  // directories. Each registered project is surfaced as `unchecked` and only
  // gets validated against disk when the user clicks it. This is deliberate:
  // on macOS, every read inside a TCC-protected location (Documents,
  // removable volumes, etc.) costs a consent prompt, and for an
  // unsigned/ad-hoc bundle those grants don't persist across launches.
  // Eagerly stat'ing every registered project on launch turned the launch
  // screen into a prompt avalanche.
  useEffect(() => {
    (async () => {
      try {
        const appDataDir = await getAppDataDir();
        const filePath = getProjectsFilePath(appDataDir);
        projectsFileRef.current = filePath;
        setProjectsFilePath(filePath);
        const registry = await loadRegistry(filePath);
        registry.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
        const initial: ProjectListEntry[] = registry.map(r => ({ status: 'unchecked', registry: r }));
        setBoth(initial);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to load project registry:', msg);
        setLoadError(msg);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [setBoth]);

  /** Create a brand-new project: write settings.json, append to registry. */
  const createProject = useCallback(async (args: {
    projectDir: string;
    settings: ProjectSettings;
  }): Promise<Project> => {
    const now = new Date().toISOString();
    const registry: ProjectRegistryEntry = {
      id: crypto.randomUUID(),
      projectDir: args.projectDir,
      lastOpened: now,
      name: args.settings.name,
      nameGradientColors: args.settings.nameGradientColors,
    };
    await writeProjectSettings(args.projectDir, args.settings);
    const project = buildProject(registry, args.settings);
    const next: ProjectListEntry[] = [
      { status: 'ok', registry, project },
      ...entriesRef.current,
    ];
    setBoth(next);
    await persistRegistry(next.map(e => e.registry));
    return project;
  }, [persistRegistry, setBoth]);

  /** Register an existing project on disk by pointing at its directory. */
  const addExistingProject = useCallback(async (projectDir: string): Promise<Project> => {
    const dup = entriesRef.current.find(e => e.registry.projectDir === projectDir);
    if (dup && dup.status === 'ok') return dup.project;

    const settings = await readProjectSettings(projectDir); // throws if missing
    const now = new Date().toISOString();
    const registry: ProjectRegistryEntry = dup
      ? { ...dup.registry, lastOpened: now, name: settings.name, nameGradientColors: settings.nameGradientColors }
      : { id: crypto.randomUUID(), projectDir, lastOpened: now, name: settings.name, nameGradientColors: settings.nameGradientColors };
    const project = buildProject(registry, settings);

    const without = entriesRef.current.filter(e => e.registry.id !== registry.id);
    const next: ProjectListEntry[] = [
      { status: 'ok', registry, project },
      ...without,
    ];
    setBoth(next);
    await persistRegistry(next.map(e => e.registry));
    return project;
  }, [persistRegistry, setBoth]);

  /** Persist new settings to a project's settings.json (registry untouched). */
  const updateProjectSettings = useCallback(async (
    id: string,
    settings: ProjectSettings,
  ): Promise<Project | undefined> => {
    const entry = entriesRef.current.find(e => e.registry.id === id);
    if (!entry || entry.status !== 'ok') return undefined;
    await writeProjectSettings(entry.registry.projectDir, settings);
    const colorsMatch = JSON.stringify(settings.nameGradientColors ?? null) === JSON.stringify(entry.registry.nameGradientColors ?? null);
    const registry = (entry.registry.name === settings.name && colorsMatch)
      ? entry.registry
      : { ...entry.registry, name: settings.name, nameGradientColors: settings.nameGradientColors };
    const project = buildProject(registry, settings);
    const next = entriesRef.current.map(e =>
      e.registry.id === id ? { status: 'ok' as const, registry, project } : e
    );
    setBoth(next);
    if (registry !== entry.registry) {
      await persistRegistry(next.map(e => e.registry)).catch(err =>
        console.error('Failed to persist updated project registry:', err));
    }
    return project;
  }, [persistRegistry, setBoth]);

  /** Remove a project from the registry only — leaves files on disk untouched. */
  const removeProject = useCallback(async (id: string): Promise<void> => {
    const next = entriesRef.current.filter(e => e.registry.id !== id);
    setBoth(next);
    await persistRegistry(next.map(e => e.registry));
  }, [persistRegistry, setBoth]);

  const touchLastOpened = useCallback(async (id: string): Promise<Project | undefined> => {
    const now = new Date().toISOString();
    const next = entriesRef.current.map(e => {
      if (e.registry.id !== id) return e;
      const registry = { ...e.registry, lastOpened: now };
      if (e.status !== 'ok') return { ...e, registry };
      return {
        status: 'ok' as const,
        registry,
        project: { ...e.project, lastOpened: now },
      };
    });
    next.sort((a, b) => b.registry.lastOpened.localeCompare(a.registry.lastOpened));
    setBoth(next);
    await persistRegistry(next.map(e => e.registry));
    const updated = next.find(e => e.registry.id === id);
    return updated && updated.status === 'ok' ? updated.project : undefined;
  }, [persistRegistry, setBoth]);

  /**
   * Validate a single entry against disk. Used both to flip a non-ok row back
   * to `ok` if its directory reappeared, and (under lazy validation) to
   * resolve an `unchecked` row the moment the user clicks it. If resolution
   * learned a name from settings.json that differs from the registry, the
   * updated registry is persisted so the launch list stays in sync.
   */
  const reconnectProject = useCallback(async (id: string): Promise<ProjectListEntry | undefined> => {
    const entry = entriesRef.current.find(e => e.registry.id === id);
    if (!entry) return undefined;
    const resolved = await resolveEntry(entry.registry);
    const next = entriesRef.current.map(e => e.registry.id === id ? resolved : e);
    setBoth(next);
    const colorsChanged = JSON.stringify(resolved.registry.nameGradientColors ?? null) !== JSON.stringify(entry.registry.nameGradientColors ?? null);
    if (resolved.registry.name !== entry.registry.name || colorsChanged) {
      await persistRegistry(next.map(e => e.registry)).catch(err =>
        console.error('Failed to persist learned project registry:', err));
    }
    return resolved;
  }, [persistRegistry, setBoth]);

  /**
   * Re-link a not-found (or unreadable) project to a directory the user has
   * located on disk — typically because the project folder was moved.
   *
   * The chosen directory must contain a readable `.seenote/settings.json`;
   * without one there is no project to bind to, so that case throws. Otherwise
   * the directory health (media / annotations / buzzdetect existence) and any
   * name conflict between SeeNote's listing and the on-disk settings are
   * gathered into a `RelinkInfo` and handed to `resolve` so the caller can
   * confirm and, when the names disagree, choose which one to keep. If `resolve`
   * cancels (or is absent) the re-link is aborted and `undefined` is returned.
   *
   * When the kept name differs from what's on disk, settings.json is rewritten
   * so the folder and the launch list agree. On success the entry flips to
   * `ok`, the new path + name are persisted, and the rebuilt `Project` returns.
   */
  const relinkProject = useCallback(async (
    id: string,
    newProjectDir: string,
    resolve?: (info: RelinkInfo) => RelinkResolution | Promise<RelinkResolution>,
  ): Promise<Project | undefined> => {
    const entry = entriesRef.current.find(e => e.registry.id === id);
    if (!entry) throw new Error('Project is no longer in the list.');

    let settings: ProjectSettings;
    try {
      settings = await readProjectSettings(newProjectDir);
    } catch {
      throw new Error(
        'The selected folder is not a SeeNote project — it has no .seenote/settings.json inside it.',
      );
    }

    const candidate: ProjectRegistryEntry = {
      ...entry.registry,
      projectDir: newProjectDir,
      name: settings.name,
      nameGradientColors: settings.nameGradientColors,
    };
    const project = buildProject(candidate, settings);

    // Report directory health so the caller can reassure the user the re-link
    // will land cleanly (or flag what's still missing). buzzdetect is only
    // listed when the project configures it.
    const dirSpecs: { label: string; path: string | null }[] = [
      { label: 'Media', path: project.mediaDirectoryAbs },
      { label: 'Annotations', path: project.annotationDirectoryAbs },
      { label: 'buzzdetect', path: project.buzzdetectDirectoryAbs },
    ];
    const dirs: RelinkDirStatus[] = [];
    for (const spec of dirSpecs) {
      if (!spec.path) continue;
      const exists = await projectDirExists(spec.path).catch(() => false);
      dirs.push({ label: spec.label, path: spec.path, exists });
    }

    const internalName = entry.registry.name ?? basename(entry.registry.projectDir);
    const info: RelinkInfo = {
      internalName,
      settingsName: settings.name,
      nameConflict: internalName !== settings.name,
      dirs,
    };

    const resolution: RelinkResolution = resolve
      ? await resolve(info)
      : { action: 'relink', name: settings.name };
    if (resolution.action === 'cancel') return undefined;

    // Apply any dir overrides the user browsed (missing dirs relocated via "Locate").
    // Label→settings key mapping mirrors the dirSpecs order above.
    const labelToKey: Record<string, 'mediaDirectory' | 'annotationDirectory' | 'buzzdetectDirectory'> = {
      Media: 'mediaDirectory',
      Annotations: 'annotationDirectory',
      buzzdetect: 'buzzdetectDirectory',
    };
    let finalSettings = settings;
    const overrides = resolution.action === 'relink' ? (resolution.dirOverrides ?? {}) : {};
    for (const [label, absPath] of Object.entries(overrides)) {
      const key = labelToKey[label];
      if (key) finalSettings = { ...finalSettings, [key]: makeProjectPath(newProjectDir, absPath) };
    }

    // If the user kept SeeNote's name over the one on disk, apply that too.
    if (resolution.name !== settings.name) {
      finalSettings = { ...finalSettings, name: resolution.name };
    }

    // Write settings.json if anything changed.
    if (finalSettings !== settings) {
      await writeProjectSettings(newProjectDir, finalSettings);
    }
    const finalRegistry: ProjectRegistryEntry = { ...candidate, name: resolution.name };
    const finalProject = buildProject(finalRegistry, finalSettings);

    const next = entriesRef.current.map(e =>
      e.registry.id === id ? { status: 'ok' as const, registry: finalRegistry, project: finalProject } : e,
    );
    setBoth(next);
    await persistRegistry(next.map(e => e.registry));
    return finalProject;
  }, [persistRegistry, setBoth]);

  return {
    entries,
    isLoading,
    loadError,
    projectsFilePath,
    createProject,
    addExistingProject,
    updateProjectSettings,
    removeProject,
    touchLastOpened,
    reconnectProject,
    relinkProject,
  };
}
