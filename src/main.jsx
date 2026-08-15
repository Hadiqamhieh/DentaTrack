import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AuthGate from './AuthGate.jsx';
import VerifiedPage from './VerifiedPage.jsx';
import { registerSW } from 'virtual:pwa-register';

// Prompt-style update handling: a new deploy should never be invisible.
// registerSW() calls onNeedRefresh() the moment a new version has finished
// downloading and is ready to take over — instead of updating silently in
// the background on its own schedule (which is exactly how a stale,
// already-open tab kept running pre-fix code past a real deploy), we stash
// the "apply the update" function on window and fire an event App.jsx
// listens for to show a visible "Update available" banner. Nothing changes
// until someone actually taps it.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    window.__dtApplyUpdate = () => updateSW(true);
    window.dispatchEvent(new Event('dt-update-available'));
  },
});

const isVerifiedPage = window.location.pathname.replace(/\/+$/, '') === '/verified';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isVerifiedPage ? (
      <VerifiedPage />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </React.StrictMode>
);
