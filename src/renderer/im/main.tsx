import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../base.css';
// The AIM 5.1 visual system. Everything the component library renders is scoped to the
// `aim-root` class the App puts on its wrapper.
import '../ui/theme.css';

import { App } from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('im: #root is missing from index.html');
}

/**
 * Which conversation this window is for. Main passes it as a query parameter when it creates
 * the window (see createImWindow in src/main/index.ts) — one IM window per conversation, so
 * the identity has to arrive with the document, not over IPC after the fact.
 *
 * In production main loads the file with `{ search }`, in dev it appends the query to the dev
 * server URL; both land in `window.location.search`.
 */
const conversationId = new URLSearchParams(window.location.search).get('conversationId');

createRoot(container).render(
  <StrictMode>
    <App conversationId={conversationId} />
  </StrictMode>
);
