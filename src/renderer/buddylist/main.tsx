import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../base.css';
// The AIM 5.1 visual system. Everything the component library renders is scoped to the
// `aim-root` class the App puts on its wrapper.
import '../ui/theme.css';

import { App } from './App';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('buddylist: #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
