import type { Annotation, SpectrogramSettings } from '../types';
import type { AnnotationToolsApi } from '../hooks/useAnnotationTools';
import type { ExamplePlayer } from '../hooks/useExamplePlayer';
import { nextAvailableHotkey, pickNextToolColor } from '../constants';
import AnnotationToolsSettingsModal from './AnnotationToolsSettingsModal';
import AnnotationToolEditModal from './AnnotationToolEditModal';
import AnnotationToolLibrary from './AnnotationToolLibrary';
import DeleteToolConfirmDialog from './DeleteToolConfirmDialog';

interface Props {
  tools: AnnotationToolsApi;
  annotations: Annotation[];
  examplePlayer: ExamplePlayer;
  spectrogramSettings: SpectrogramSettings;
  addLog: (msg: string, type?: 'info' | 'error') => void;
  showToolSettings: boolean;
  onCloseToolSettings: () => void;
  /** Label for the create-tool modal, opened from the Labels palette; null = closed. */
  creatingToolText: string | null;
  onCloseCreate: () => void;
  /** Ready a tool by hotkey once it's been created. */
  readyTool: (key: string) => void;
}

/** The annotation-tool modals: settings, edit, create, example library, delete. */
export default function ToolModals({
  tools, annotations, examplePlayer, spectrogramSettings: settings, addLog,
  showToolSettings, onCloseToolSettings, creatingToolText: panelCreatingToolText, onCloseCreate, readyTool,
}: Props) {
  const {
    annotationTools,
    panelEditingToolIndex, setPanelEditingToolIndex,
    panelDeletingToolIndex, setPanelDeletingToolIndex,
    libraryToolIndex, setLibraryToolIndex, setLibraryPlaying,
    handleShowExamples, handleCreateTool, handleRenameTool, handleDeleteTool, handlePreviewToolColor,
    handleReorderTools, handleImportExamples, handleImportExamplesToTool, handleRestoreToolsState,
  } = tools;
  return (
    <>
    {showToolSettings && (
      <AnnotationToolsSettingsModal
        annotationTools={annotationTools}
        annotations={annotations}
        onClose={onCloseToolSettings}
        onReorderTools={handleReorderTools}
        onRenameTool={handleRenameTool}
        onDeleteTool={handleDeleteTool}
        onPreviewColor={handlePreviewToolColor}
        onCreateTool={handleCreateTool}
        onRestoreToolsState={handleRestoreToolsState}
        onImportExamples={handleImportExamples}
        onImportExamplesToTool={handleImportExamplesToTool}
        playingExampleToolId={examplePlayer.playingToolId}
        onPlayExample={examplePlayer.toggle}
        onShowExamples={handleShowExamples}
      />
    )}
    {panelEditingToolIndex !== null && (
      <AnnotationToolEditModal
        tool={annotationTools[panelEditingToolIndex]}
        toolIndex={panelEditingToolIndex}
        annotations={annotations}
        annotationTools={annotationTools}
        onClose={() => setPanelEditingToolIndex(null)}
        onPreviewColor={handlePreviewToolColor}
        onImportExamples={handleImportExamplesToTool}
        onShowExamples={(idx) => { setPanelEditingToolIndex(null); handleShowExamples(idx); }}
        onDelete={
          panelEditingToolIndex !== 0 && annotationTools[panelEditingToolIndex]?.key !== '0'
            ? () => { const idx = panelEditingToolIndex; setPanelEditingToolIndex(null); setPanelDeletingToolIndex(idx); }
            : undefined
        }
        onSave={(text, color, description) => {
          handleRenameTool(panelEditingToolIndex, text, color, description);
          setPanelEditingToolIndex(null);
        }}
      />
    )}
    {panelCreatingToolText !== null && (
      <AnnotationToolEditModal
        tool={{ id: '', key: nextAvailableHotkey(annotationTools), text: panelCreatingToolText, color: pickNextToolColor(annotationTools) }}
        toolIndex={-1}
        annotations={annotations}
        annotationTools={annotationTools}
        isCreate
        onClose={onCloseCreate}
        onSave={(text, color, description) => {
          const key = nextAvailableHotkey(annotationTools);
          handleCreateTool(text, color, key, description);
          onCloseCreate();
          if (key) readyTool(key);
        }}
      />
    )}
    {libraryToolIndex !== null && annotationTools[libraryToolIndex] && (
      <AnnotationToolLibrary
        tool={annotationTools[libraryToolIndex]}
        initialSettings={settings}
        addLog={addLog}
        onPlayingChange={setLibraryPlaying}
        onClose={() => { setLibraryPlaying(false); setLibraryToolIndex(null); }}
      />
    )}
    {panelDeletingToolIndex !== null && (() => {
      const idx = panelDeletingToolIndex;
      const tool = annotationTools[idx];
      const close = () => setPanelDeletingToolIndex(null);
      return tool ? (
        <DeleteToolConfirmDialog
          tool={tool}
          onClose={close}
          onDelete={() => { handleDeleteTool(idx, 'delete'); close(); }}
          onUnlink={() => { handleDeleteTool(idx, 'unlink'); close(); }}
        />
      ) : null;
    })()}
    </>
  );
}
