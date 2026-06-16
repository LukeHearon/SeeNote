import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import GitSyncSetupModal from './components/GitSyncSetupModal';
import { closeSyncGuideWindow } from './utils/tauriCommands';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const params = new URLSearchParams(window.location.search);
const windowMode = params.get('window');

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    {windowMode === 'sync-guide'
      ? <GitSyncSetupModal standalone onClose={closeSyncGuideWindow} />
      : <App />}
  </React.StrictMode>
);