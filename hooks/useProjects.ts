import { useState, useEffect, useRef, useCallback } from 'react';
import { Project } from '../types';
import { getAppDataDir, loadProjects, saveProjects } from '../utils/projectCommands';

function getProjectsFilePath(appDataDir: string): string {
  const base = appDataDir.replace(/[/\\]+$/, '');
  return base + '/.projects/projects.json';
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [projectsFilePath, setProjectsFilePath] = useState<string | null>(null);
  const projectsFileRef = useRef<string | null>(null);

  // Ref that always holds the latest projects array, updated synchronously.
  // This avoids stale-closure bugs where a mutation (e.g. touchLastOpened)
  // runs before React has re-rendered with the latest setProjects() value.
  const projectsRef = useRef<Project[]>([]);

  const setProjectsBoth = useCallback((next: Project[]) => {
    projectsRef.current = next;
    setProjects(next);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const appDataDir = await getAppDataDir();
        const filePath = getProjectsFilePath(appDataDir);
        projectsFileRef.current = filePath;
        setProjectsFilePath(filePath);
        const loaded = await loadProjects(filePath);
        loaded.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
        setProjectsBoth(loaded);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Failed to load projects:', msg);
        setLoadError(msg);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const persist = useCallback(async (updated: Project[]) => {
    if (!projectsFileRef.current) {
      console.error('persist called before projectsFileRef was set');
      return;
    }
    try {
      await saveProjects(projectsFileRef.current, updated);
    } catch (err) {
      console.error('Failed to save projects:', err);
      throw err;
    }
  }, []);

  const createProject = useCallback(async (
    draft: Omit<Project, 'id' | 'createdAt' | 'lastOpened'>
  ): Promise<Project> => {
    const now = new Date().toISOString();
    const project: Project = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: now,
      lastOpened: now,
    };
    const updated = [project, ...projectsRef.current];
    setProjectsBoth(updated);
    await persist(updated);
    return project;
  }, [persist, setProjectsBoth]);

  const updateProject = useCallback(async (updated: Project): Promise<void> => {
    const next = projectsRef.current.map(p => p.id === updated.id ? updated : p);
    setProjectsBoth(next);
    await persist(next);
  }, [persist, setProjectsBoth]);

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    const next = projectsRef.current.filter(p => p.id !== id);
    setProjectsBoth(next);
    await persist(next);
  }, [persist, setProjectsBoth]);

  const touchLastOpened = useCallback(async (id: string): Promise<Project | undefined> => {
    const now = new Date().toISOString();
    const next = projectsRef.current.map(p =>
      p.id === id ? { ...p, lastOpened: now } : p
    );
    next.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
    setProjectsBoth(next);
    await persist(next);
    return next.find(p => p.id === id);
  }, [persist, setProjectsBoth]);

  return {
    projects,
    isLoading,
    loadError,
    projectsFilePath,
    createProject,
    updateProject,
    deleteProject,
    touchLastOpened,
  };
}
