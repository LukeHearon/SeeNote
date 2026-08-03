import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import GitSyncSetupModal from './components/GitSyncSetupModal';
import { CopyEditor } from './components/CopyEditor';
import { HelpWindow } from './components/help/HelpWindow';
import { closeSyncGuideWindow } from './utils/tauriCommands';
import { useCopyEditorBridge } from './hooks/useCopyEditorBridge';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const params = new URLSearchParams(window.location.search);
const windowMode = params.get('window');

// Wraps a standalone window so copy edits apply live and pick mode works there,
// matching the behaviour App already gets via the same hook.
function SyncGuideWindow() {
  useCopyEditorBridge();
  return <GitSyncSetupModal standalone onClose={closeSyncGuideWindow} />;
}

function HelpGuideWindow() {
  useCopyEditorBridge();
  return <HelpWindow />;
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {windowMode === 'sync-guide'
      ? <SyncGuideWindow />
      : windowMode === 'help'
      ? <HelpGuideWindow />
      : windowMode === 'copy-editor'
      ? <CopyEditor />
      : <App />}
  </React.StrictMode>
);