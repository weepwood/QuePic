import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AccountBackupManager } from './components/AccountBackupManager';
import './styles.css';
import './preview.css';
import './yuque-theme.css';
import './batch-document.css';
import './feature-enhancements.css';
import './queue-library.css';
import './account-backup.css';
import './ui-polish.css';
// 原图查看器与图库比例规则需要在通用视觉修正之后加载。
import './original-viewer.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AccountBackupManager />
  </StrictMode>,
);
