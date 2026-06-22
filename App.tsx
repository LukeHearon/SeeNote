import React, { useState, useCallback, useEffect, useMemo } from 'react';
import LaunchScreen from './components/LaunchScreen';
import AnnotationWindow from './AnnotationWindow';
import RepairProjectModal, { RepairProjectState } from './components/RepairProjectModal';
import TooltipLayer from './components/TooltipLayer';
import { Project, ProjectPreferences, ProjectSettings } from './types';
import { useProjects } from './hooks/useProjects';
import { useHotkeys } from './hooks/useHotkeys';
import { useCopyRerenderOnChange, copyChannel, getAccessedKeys } from './copy/overrideStore';
import { buildRegistry } from './copy/registry';
import { listDirectory, openCopyEditorWindow } from './utils/tauriCommands';

const DEV_MODE = import.meta.env.DEV;

function buildValueToKey(registry: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(registry)) {
    const norm = v.toLowerCase().trim();
    if (norm && !map.has(norm)) map.set(norm, k);
  }
  return map;
}

function findKeyForElement(target: Element, valueToKey: Map<string, string>): string | null {
  let node: Element | null = target;
  while (node) {
    const candidates: string[] = [];
    const dataTooltip = node.getAttribute('data-tooltip');
    const title = node.getAttribute('title');
    const placeholder = node.getAttribute('placeholder');
    const ariaLabel = node.getAttribute('aria-label');
    if (dataTooltip) candidates.push(dataTooltip);
    if (title) candidates.push(title);
    if (placeholder) candidates.push(placeholder);
    if (ariaLabel) candidates.push(ariaLabel);
    if (node.children.length === 0 && node.textContent) candidates.push(node.textContent.trim());
    for (const text of candidates) {
      const key = valueToKey.get(text.toLowerCase().trim());
      if (key) return key;
    }
    node = node.parentElement;
  }
  return null;
}

export default function App() {
  useCopyRerenderOnChange();
  const {
    entries, isLoading, loadError, projectsFilePath,
    createProject, addExistingProject, updateProjectSettings, updateProjectPreferences,
    removeProject, touchLastOpened, reconnectProject, relinkProject,
  } = useProjects();
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [repairProject, setRepairProject] = useState<RepairProjectState | null>(null);
  const [pickMode, setPickMode] = useState(false);

  const base = useMemo(() => DEV_MODE ? buildRegistry() : {}, []);
  const valueToKey = useMemo(() => DEV_MODE ? buildValueToKey(base) : new Map<string, string>(), [base]);

  // Receive togglePick from the copy editor window
  useEffect(() => {
    if (!DEV_MODE || !copyChannel) return;
    const handler = (e: MessageEvent) => {
      if ((e.data as Record<string, unknown>)?.type === 'togglePick') setPickMode(p => !p);
    };
    copyChannel.addEventListener('message', handler);
    return () => copyChannel.removeEventListener('message', handler);
  }, []);

  // Manage pick mode: cursor, click capture, broadcast
  useEffect(() => {
    if (!DEV_MODE) return;
    copyChannel?.postMessage({ type: 'pickModeChanged', active: pickMode });
    if (!pickMode) {
      document.body.classList.remove('pick-mode');
      return;
    }
    document.body.classList.add('pick-mode');
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const found = findKeyForElement(e.target as Element, valueToKey);
      if (found) copyChannel?.postMessage({ type: 'pick', key: found });
    };
    document.addEventListener('click', handler, true);
    return () => {
      document.removeEventListener('click', handler, true);
      document.body.classList.remove('pick-mode');
    };
  }, [pickMode, valueToKey]);

  useHotkeys([
    {
      key: 'e', mods: ['mod', 'shift', 'alt'],
      handler: () => DEV_MODE && copyChannel?.postMessage({ type: 'toggleShowAll' }),
    },
    {
      key: 'e', mods: ['mod', 'shift'],
      handler: () => {
        if (!DEV_MODE) return;
        try { localStorage.setItem('copy:accessedKeys', JSON.stringify([...getAccessedKeys()])); } catch { /* */ }
        openCopyEditorWindow();
        setPickMode(p => !p);
      },
    },
  ]);

  // Keep the in-memory active project in lockstep with persisted settings/preferences.
  // `activeProject` is held here, separate from the projects store, so without
  // this the AnnotationWindow header (name + gradient) and its own `projectRef`
  // (used by the debounced persisters) would read stale data after a save —
  // a later persist could even write the old data back over a fresh change.
  const updateActiveProjectSettings = useCallback(
    async (id: string, settings: ProjectSettings): Promise<Project | undefined> => {
      const updated = await updateProjectSettings(id, settings);
      if (updated) setActiveProject(prev => (prev && prev.id === updated.id ? updated : prev));
      return updated;
    },
    [updateProjectSettings],
  );

  const updateActiveProjectPreferences = useCallback(
    async (id: string, preferences: ProjectPreferences): Promise<Project | undefined> => {
      const updated = await updateProjectPreferences(id, preferences);
      if (updated) setActiveProject(prev => (prev && prev.id === updated.id ? updated : prev));
      return updated;
    },
    [updateProjectPreferences],
  );

  const handleOpenProject = useCallback(async (project: Project) => {
    // The LaunchScreen has already lazily re-validated this project (either
    // via reconnectProject on click, or via relinkProject after a re-link),
    // so we trust `project` here and don't stat the project dir again — that
    // would just cost another macOS TCC consent prompt for no new information.
    const touched = await touchLastOpened(project.id) ?? project;
    const mediaExists = await listDirectory(touched.mediaDirectoryAbs).then(() => true).catch(() => false);
    if (!mediaExists) {
      setRepairProject({ project: touched, repairedMedia: touched.mediaDirectoryAbs });
      return;
    }
    setActiveProject(touched);
  }, [touchLastOpened]);

  const handleCloseProject = useCallback(() => {
    setActiveProject(null);
  }, []);

  if (activeProject) {
    return (
      <AnnotationWindow
        project={activeProject}
        onClose={handleCloseProject}
        updateProjectSettings={updateActiveProjectSettings}
        updateProjectPreferences={updateActiveProjectPreferences}
        touchLastOpened={touchLastOpened}
      />
    );
  }

  return (
    <>
      <LaunchScreen
        entries={entries}
        isLoading={isLoading}
        loadError={loadError}
        projectsFilePath={projectsFilePath}
        onOpenProject={handleOpenProject}
        createProject={createProject}
        addExistingProject={addExistingProject}
        removeProject={removeProject}
        relinkProject={relinkProject}
        reconnectProject={reconnectProject}
        updateProjectSettings={updateProjectSettings}
      />
      {repairProject && (
        <RepairProjectModal
          repairProject={repairProject}
          setRepairProject={setRepairProject}
          updateProjectSettings={updateProjectSettings}
          onOpenProject={handleOpenProject}
        />
      )}
      <TooltipLayer />
    </>
  );
}
