import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startVersionWatch } from './version';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Outside the App tree on purpose: the login gate returns early and would
// otherwise disable update detection for logged-out users.
startVersionWatch();
