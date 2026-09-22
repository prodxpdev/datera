import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { DateraApi } from '../shared/contract.js';
import { createApi } from './api.js';
import { Workspace } from './Workspace.js';
import './tokens.css';
import './app.css';

declare global {
  interface Window {
    datera: DateraApi;
    dateraBridge: Record<string, (...args: unknown[]) => Promise<never>>;
  }
}

const api = createApi(window.dateraBridge);

// Published on `window` so end-to-end tests — and anyone debugging in devtools — can drive
// the same API the UI uses, rather than a parallel one that could drift from it.
window.datera = api;

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Workspace api={api} />
  </StrictMode>,
);
