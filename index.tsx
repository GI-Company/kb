import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initAnalytics } from './lib/analytics';
import { useOS } from './store';
import './index.css';

initAnalytics();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Registered after load so it never competes with the initial render for
// bandwidth/main-thread time — see public/sw.js for exactly what it caches
// and why it never touches /api/* or cross-origin requests.
if ('serviceWorker' in navigator) {
  // Read BEFORE the load-time register() call below can change it — the
  // very first time a service worker ever activates for this origin also
  // fires 'controllerchange', but that's not an update, it's onboarding.
  // Only a controllerchange with a controller already present at page load
  // means a running SW just got replaced by a newer one.
  const hadControllerAtLoad = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadControllerAtLoad) {
      // sw.js calls skipWaiting()/clients.claim() unconditionally, so by
      // the time this fires the new worker is already serving fetches —
      // the only thing still stale is the JS already loaded in memory,
      // which only a reload picks up. See components/ui/Taskbar.tsx's
      // UpdateAvailableChip for the reload prompt this drives.
      useOS.getState().setUpdateAvailable(true);
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}