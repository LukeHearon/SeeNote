import React, { useState } from 'react';
import { AudioWaveform, Plus, Settings, Loader2, Trash2 } from 'lucide-react';
import { Project } from '../types';
import { useProjects } from '../hooks/useProjects';
import CreateProjectModal from './CreateProjectModal';
import ProjectSettingsModal from './ProjectSettingsModal';

interface Props {
  onOpenProject: (project: Project) => void;
}

export default function LaunchScreen({ onOpenProject }: Props) {
  const { projects, isLoading, createProject, updateProject, deleteProject } = useProjects();
  const [showCreate, setShowCreate] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  const handleCreated = (project: Project) => {
    setShowCreate(false);
    onOpenProject(project);
  };

  const handleSettingsSaved = async (updated: Project) => {
    await updateProject(updated);
    setEditingProject(null);
  };

  const handleDelete = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    if (confirm(`Delete project "${project.name}"? This will not delete any files.`)) {
      await deleteProject(project.id);
    }
  };

  const handleGear = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    setEditingProject(project);
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-8">
      {/* Logo / title */}
      <div className="flex items-center gap-3 mb-10">
        <AudioWaveform size={36} className="text-blue-400" />
        <span className="text-white text-3xl font-semibold tracking-tight">SeeNote</span>
      </div>

      <div className="w-full max-w-xl">
        {/* Header row */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-gray-300 text-sm font-medium uppercase tracking-wider">Projects</h2>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
          >
            <Plus size={15} />
            New Project
          </button>
        </div>

        {/* Project list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-500">
            <Loader2 size={24} className="animate-spin mr-2" />
            <span className="text-sm">Loading projects…</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="border border-dashed border-gray-700 rounded-xl py-16 text-center">
            <p className="text-gray-500 text-sm mb-3">No projects yet.</p>
            <button
              onClick={() => setShowCreate(true)}
              className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
            >
              Create your first project
            </button>
          </div>
        ) : (
          <ul className="space-y-2">
            {projects.map(project => (
              <li
                key={project.id}
                onClick={() => onOpenProject(project)}
                className="group bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-gray-600 rounded-xl px-5 py-4 cursor-pointer transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate">{project.name}</p>
                    <p className="text-gray-500 text-xs mt-1 truncate">{project.audioDirectory}</p>
                    <p className="text-gray-600 text-xs truncate">{project.annotationDirectory}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={e => handleGear(e, project)}
                      className="text-gray-400 hover:text-white p-1 rounded transition-colors"
                      title="Project settings"
                    >
                      <Settings size={15} />
                    </button>
                    <button
                      onClick={e => handleDelete(e, project)}
                      className="text-gray-400 hover:text-red-400 p-1 rounded transition-colors"
                      title="Delete project"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                <p className="text-gray-600 text-xs mt-2">
                  Last opened {formatDate(project.lastOpened)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showCreate && (
        <CreateProjectModal
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
          createProject={createProject}
        />
      )}

      {editingProject && (
        <ProjectSettingsModal
          project={editingProject}
          onSave={handleSettingsSaved}
          onClose={() => setEditingProject(null)}
        />
      )}
    </div>
  );
}
