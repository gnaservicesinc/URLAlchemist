import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './index.css';

const RESIZE_OBSERVER_LOOP_MESSAGES = new Set([
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded',
]);

function isBenignResizeObserverLoop(message: unknown): boolean {
  return typeof message === 'string' && RESIZE_OBSERVER_LOOP_MESSAGES.has(message);
}

window.addEventListener(
  'error',
  (event) => {
    if (!isBenignResizeObserverLoop(event.message)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);

const previousWindowOnError = window.onerror;
window.onerror = (message, source, lineno, colno, error) => {
  if (isBenignResizeObserverLoop(message)) {
    return true;
  }

  return typeof previousWindowOnError === 'function'
    ? previousWindowOnError(message, source, lineno, colno, error)
    : false;
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
