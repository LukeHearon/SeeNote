import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Project,
  ProjectListEntry,
  ProjectRegistryEntry,
  ProjectSettings,
} from '../types';
import {
  getAppDataDir,
  loadRegistry,
  saveRegistry,
  readProjectSettings,
  writeProjectSettings,
  projectDirExists,
} from '../utils/projectCommands';
import { buildProject } from '../utils/projectPaths';

function getProjectsFilePath(appDataDir: string): string {
  const base = appDataDir.replace(/[/\\]+$/, '');
  return base + '/.projects/projects.json';
}

async function resolveEntry(registry: ProjectRegistryEntry): Promise<ProjectListEntry> {
  const exists = await projectDirExists(registry.projectDir).catch(() => false);
  if (!exists) return { status: 'missing-dir', registry };
  try {
    const settings = await readProjectSettings(registry.projectDir);
    return { status: 'ok', registry, project: buildProject(registry, settings) };
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

  // Initial load: registry → in parallel resolve each entry's settings + existence.
  useEffect(() => {
    (async () => {
      try {
        const appDataDir = await getAppDataDir();
        const filePath = getProjectsFilePath(appDataDir);
        projectsFileRef.current = filePath;
        setProjectsFilePath(filePath);
        const registry = await loadRegistry(filePath);
        registry.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
        const resolved = await Promise.all(registry.map(resolveEntry));
        setBoth(resolved);
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
      ? { ...dup.registry, lastOpened: now }
      : { id: crypto.randomUUID(), projectDir, lastOpened: now };
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
    const project = buildProject(entry.registry, settings);
    const next = entriesRef.current.map(e =>
      e.registry.id === id ? { status: 'ok' as const, registry: e.registry, project } : e
    );
    setBoth(next);
    return project;
  }, [setBoth]);

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

  /** Re-check a non-ok entry. If it resolves cleanly, flips it to `ok`. */
  const reconnectProject = useCallback(async (id: string): Promise<ProjectListEntry | undefined> => {
    const entry = entriesRef.current.find(e => e.registry.id === id);
    if (!entry) return undefined;
    const resolved = await resolveEntry(entry.registry);
    const next = entriesRef.current.map(e => e.registry.id === id ? resolved : e);
    setBoth(next);
    return resolved;
  }, [setBoth]);

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
  };
}
