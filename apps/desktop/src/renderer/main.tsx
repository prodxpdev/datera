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

/**
 * A file dropped on the window must not navigate it.
 *
 * Chromium's default for a file dropped onto a page is to load that file in the frame. The
 * main process refuses the navigation, but preventing it here means the drop is a no-op
 * rather than a blocked navigation with a warning in the log — and it is the one route to
 * this that needs no exploit at all, just someone saying "take a look at this report".
 *
 * Sources are added through the file picker, which is a deliberate act with a dialog in
 * front of it.
 */
for (const name of ['dragover', 'drop'] as const) {
  window.addEventListener(name, (event) => event.preventDefault(), { capture: true });
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
