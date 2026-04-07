import { useState, useEffect, useRef, useCallback } from 'react';
import { Project, LabelConfig } from '../types';
import { getAppDataDir, loadProjects, saveProjects } from '../utils/projectCommands';

function getProjectsFilePath(appDataDir: string): string {
  // Use forward slashes; Tauri handles platform path separators on the Rust side
  return appDataDir + '/.projects/projects.json';
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const projectsFileRef = useRef<string | null>(null);

  // On mount: resolve app data dir and load projects.
  // Note: Tauri v2 uses the same app_data_dir (based on the bundle identifier
  // "com.seenote.app") in both `tauri dev` and packaged builds, so projects
  // created in one environment will appear in the other.
  useEffect(() => {
    (async () => {
      try {
        const appDataDir = await getAppDataDir();
        const filePath = getProjectsFilePath(appDataDir);
        projectsFileRef.current = filePath;
        const loaded = await loadProjects(filePath);
        // Sort by lastOpened descending
        loaded.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
        setProjects(loaded);
      } catch (err) {
        console.error('Failed to load projects:', err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const persist = useCallback(async (updated: Project[]) => {
    if (!projectsFileRef.current) return;
    await saveProjects(projectsFileRef.current, updated);
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
    const updated = [project, ...projects];
    setProjects(updated);
    await persist(updated);
    return project;
  }, [projects, persist]);

  const updateProject = useCallback(async (updated: Project): Promise<void> => {
    const next = projects.map(p => p.id === updated.id ? updated : p);
    setProjects(next);
    await persist(next);
  }, [projects, persist]);

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    const next = projects.filter(p => p.id !== id);
    setProjects(next);
    await persist(next);
  }, [projects, persist]);

  const touchLastOpened = useCallback(async (id: string): Promise<void> => {
    const now = new Date().toISOString();
    const next = projects.map(p =>
      p.id === id ? { ...p, lastOpened: now } : p
    );
    // Re-sort
    next.sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
    setProjects(next);
    await persist(next);
  }, [projects, persist]);

  return { projects, isLoading, createProject, updateProject, deleteProject, touchLastOpened };
}
