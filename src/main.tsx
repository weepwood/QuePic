import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { BatchDocumentUploader } from './components/BatchDocumentUploader';
import './styles.css';
import './preview.css';
import './batch-document.css';
import './yuque-theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <BatchDocumentUploader />
  </StrictMode>,
);
