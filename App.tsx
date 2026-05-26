import React, { useState, useCallback } from 'react';
import LaunchScreen from './components/LaunchScreen';
import AnnotationWindow from './AnnotationWindow';
import RepairProjectModal, { RepairProjectState } from './components/RepairProjectModal';
import TooltipLayer from './components/TooltipLayer';
import { Project, ProjectSettings } from './types';
import { useProjects } from './hooks/useProjects';
import { listDirectory } from './utils/tauriCommands';

export default function App() {
  const {
    entries, isLoading, loadError, projectsFilePath,
    createProject, addExistingProject, updateProjectSettings,
    removeProject, touchLastOpened, reconnectProject, relinkProject, revalidateAll,
  } = useProjects();
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  const [repairProject, setRepairProject] = useState<RepairProjectState | null>(null);

  // Keep the in-memory active project in lockstep with persisted settings.
  // `activeProject` is held here, separate from the projects store, so without
  // this the AnnotationWindow header (name + gradient) and its own `projectRef`
  // (used by the debounced persisters) would read stale settings after a save —
  // a later persist could even write the old settings back over a fresh change.
  const updateActiveProjectSettings = useCallback(
    async (id: string, settings: ProjectSettings): Promise<Project | undefined> => {
      const updated = await updateProjectSettings(id, settings);
      if (updated) setActiveProject(prev => (prev && prev.id === updated.id ? updated : prev));
      return updated;
    },
    [updateProjectSettings],
  );

  const handleOpenProject = useCallback(async (project: Project) => {
    // The project may have been deleted while the launch screen was open.
    // Re-validate it first so we can distinguish "project gone" from "media
    // folder missing". If the project itself is gone, reconnectProject has
    // already flipped the row to its non-ok status (graying it out); leave it
    // in the list and abort — don't show the media-repair modal.
    const resolved = await reconnectProject(project.id);
    if (resolved && resolved.status !== 'ok') return;
    const fresh = resolved && resolved.status === 'ok' ? resolved.project : project;

    const touched = await touchLastOpened(fresh.id) ?? fresh;
    const mediaExists = await listDirectory(touched.mediaDirectoryAbs).then(() => true).catch(() => false);
    if (!mediaExists) {
      setRepairProject({ project: touched, repairedMedia: touched.mediaDirectoryAbs });
      return;
    }
    setActiveProject(touched);
  }, [touchLastOpened, reconnectProject]);

  const handleCloseProject = useCallback(() => {
    setActiveProject(null);
  }, []);

  if (activeProject) {
    return (
      <AnnotationWindow
        project={activeProject}
        onClose={handleCloseProject}
        updateProjectSettings={updateActiveProjectSettings}
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
        revalidateAll={revalidateAll}
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
