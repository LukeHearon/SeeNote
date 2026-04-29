import React, { useState, useCallback } from 'react';
import LaunchScreen from './components/LaunchScreen';
import AnnotationWindow from './AnnotationWindow';
import RepairProjectModal, { RepairProjectState } from './components/RepairProjectModal';
import TooltipLayer from './components/TooltipLayer';
import { Project } from './types';
import { useProjects } from './hooks/useProjects';
import { listDirectory } from './utils/tauriCommands';

export default function App() {
  const { projects, isLoading, loadError, projectsFilePath, createProject, updateProject, deleteProject, touchLastOpened } = useProjects();
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  // Broken-path repair modal: set when a project's audio/annotation dir is missing
  const [repairProject, setRepairProject] = useState<RepairProjectState | null>(null);

  const handleOpenProject = useCallback(async (project: Project) => {
    const touched = await touchLastOpened(project.id) ?? project;

    // Check that both directories still exist before opening.
    const audioExists = await listDirectory(touched.audioDirectory).then(() => true).catch(() => false);
    const annotationExists = await listDirectory(touched.annotationDirectory).then(() => true).catch(() => false);
    if (!audioExists || !annotationExists) {
      setRepairProject({
        project: touched,
        audioMissing: !audioExists,
        annotationMissing: !annotationExists,
        repairedAudio: touched.audioDirectory,
        repairedAnnotation: touched.annotationDirectory,
      });
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
        updateProject={updateProject}
        touchLastOpened={touchLastOpened}
      />
    );
  }

  return (
    <>
      <LaunchScreen
        projects={projects}
        isLoading={isLoading}
        loadError={loadError}
        projectsFilePath={projectsFilePath}
        onOpenProject={handleOpenProject}
        createProject={createProject}
        updateProject={updateProject}
        deleteProject={deleteProject}
      />
      {repairProject && (
        <RepairProjectModal
          repairProject={repairProject}
          setRepairProject={setRepairProject}
          updateProject={updateProject}
          onOpenProject={handleOpenProject}
        />
      )}
      <TooltipLayer />
    </>
  );
}
