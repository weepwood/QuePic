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
import './backup-maintenance.css';
import './ui-polish.css';
// 原图查看器、图库比例和自动文档提示统一在视觉修正层之后加载。
import './original-viewer.css';
// 新图库布局必须最后加载，以覆盖旧网格和详情预览规则。
import './library-overhaul.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AccountBackupManager />
  </StrictMode>,
);
