import React, { useState, useCallback } from 'react';
import LaunchScreen from './components/LaunchScreen';
import AnnotationWindow from './AnnotationWindow';
import RepairProjectModal, { RepairProjectState } from './components/RepairProjectModal';
import TooltipLayer from './components/TooltipLayer';
import { Project, ProjectPreferences, ProjectSettings } from './types';
import { useProjects } from './hooks/useProjects';
import { listDirectory } from './utils/tauriCommands';

export default function App() {
  const {
    entries, isLoading, loadError, projectsFilePath,
    createProject, addExistingProject, updateProjectSettings, updateProjectPreferences,
    removeProject, touchLastOpened, reconnectProject, relinkProject,
  } = useProjects();
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  const [repairProject, setRepairProject] = useState<RepairProjectState | null>(null);

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
