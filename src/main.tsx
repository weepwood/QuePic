import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AccountBackupManager } from './components/AccountBackupManager';
import './styles.css';
import './preview.css';
import './yuque-theme.css';
import './batch-document.css';
import './feature-enhancements.css';
import './account-backup.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AccountBackupManager />
  </StrictMode>,
);
