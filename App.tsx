import React, { useState, useCallback } from 'react';
import LaunchScreen from './components/LaunchScreen';
import AnnotationWindow from './AnnotationWindow';
import RepairProjectModal, { RepairProjectState } from './components/RepairProjectModal';
import TooltipLayer from './components/TooltipLayer';
import { Project } from './types';
import { useProjects } from './hooks/useProjects';
import { listDirectory } from './utils/tauriCommands';

export default function App() {
  const {
    entries, isLoading, loadError, projectsFilePath,
    createProject, addExistingProject, updateProjectSettings,
    removeProject, touchLastOpened, reconnectProject,
  } = useProjects();
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  const [repairProject, setRepairProject] = useState<RepairProjectState | null>(null);

  const handleOpenProject = useCallback(async (project: Project) => {
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
        updateProjectSettings={updateProjectSettings}
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
