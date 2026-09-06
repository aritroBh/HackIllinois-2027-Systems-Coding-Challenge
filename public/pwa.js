/**
 * Service-worker registration (plan §C10).
 *
 * A separate file rather than an inline block, because the dashboard runs under
 * `script-src 'self'` and an inline registration would simply not execute.
 *
 * The worker is scoped to `/dashboard/` and caches the shell only. It is registered after
 * load so it never competes with the first paint, and a failure is logged rather than
 * surfaced: an installable app is a nicety, and a browser that refuses one still has a
 * working dashboard.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;
  // A dev reload loop is worse than no offline shell, so skip registration when the page
  // was opened with ?nosw=1.
  if (/[?&]nosw=1/.test(location.search)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/dashboard/sw.js', { scope: '/dashboard/' })
      .then((reg) => {
        window.Nexus?.emit?.('pwa:ready', { scope: reg.scope });
      })
      .catch((err) => {
        console.info('[pwa] service worker not registered:', err.message);
      });
  });
})();
