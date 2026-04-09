import React, { useState } from 'react';
import { X, FolderOpen } from 'lucide-react';
import { Project, LabelConfig } from '../types';
import { openDirectoryDialog } from '../utils/tauriCommands';
import { DEFAULT_LABEL_CONFIGS, randomMagmaGradient } from '../constants';

interface Props {
  onCreated: (project: Project) => void;
  onClose: () => void;
  createProject: (draft: Omit<Project, 'id' | 'createdAt' | 'lastOpened'>) => Promise<Project>;
}

export default function CreateProjectModal({ onCreated, onClose, createProject }: Props) {
  const [name, setName] = useState('');
  const [audioDir, setAudioDir] = useState('');
  const [annotationDir, setAnnotationDir] = useState('');
  const [outputFormat, setOutputFormat] = useState<'json' | 'csv' | 'txt'>('txt');
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const handleBrowseAudio = async () => {
    const dir = await openDirectoryDialog();
    if (dir) setAudioDir(dir);
  };

  const handleBrowseAnnotation = async () => {
    const dir = await openDirectoryDialog();
    if (dir) setAnnotationDir(dir);
  };

  const handleCreate = async () => {
    if (!name.trim()) { setError('Project name is required.'); return; }
    if (!audioDir) { setError('Audio directory is required.'); return; }
    if (!annotationDir) { setError('Annotations directory is required.'); return; }

    setError('');
    setIsCreating(true);
    try {
      const project = await createProject({
        name: name.trim(),
        audioDirectory: audioDir,
        annotationDirectory: annotationDir,
        outputFormat,
        labelConfigs: DEFAULT_LABEL_CONFIGS,
        nameGradientColors: randomMagmaGradient(),
      });
      onCreated(project);
    } catch (err) {
      setError(String(err));
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-white text-lg font-semibold">Create New Project</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-gray-400 text-sm block mb-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My Project"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              autoFocus
            />
          </div>

          {/* Audio directory */}
          <div>
            <label className="text-gray-400 text-sm block mb-1">Audio Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={audioDir}
                onChange={e => setAudioDir(e.target.value)}
                placeholder="/path/to/audio"
                className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleBrowseAudio}
                className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          {/* Annotations directory */}
          <div>
            <label className="text-gray-400 text-sm block mb-1">Annotations Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={annotationDir}
                onChange={e => setAnnotationDir(e.target.value)}
                placeholder="/path/to/annotations"
                className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={handleBrowseAnnotation}
                className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          {/* Output format */}
          <div>
            <label className="text-gray-400 text-sm block mb-1">Output Format</label>
            <select
              value={outputFormat}
              onChange={e => setOutputFormat(e.target.value as 'json' | 'csv' | 'txt')}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="txt">Audacity (.txt)</option>
              <option value="csv">CSV (.csv)</option>
              <option value="json">JSON (.json)</option>
            </select>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>

        <div className="flex gap-3 mt-6 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreating}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
          >
            {isCreating ? 'Creating…' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
