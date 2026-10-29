/** Browser entry point: Timeline tokens and styles from @ledgerforce/ui, then the shell's own. */
import '@ledgerforce/ui/tokens.css';
import '@ledgerforce/ui/timeline.css';
import './styles/shell.css';
import './styles/admin.css';
import './styles/sync.css';
import './styles/gl.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { browserEnv } from './env.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <App env={browserEnv()} />
  </StrictMode>,
);
