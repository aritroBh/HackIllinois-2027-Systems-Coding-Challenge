/**
 * Service-worker registration and the update handshake (plan §C10).
 *
 * A separate file rather than an inline block, because the dashboard runs under
 * `script-src 'self'` and an inline registration would simply not execute.
 *
 * The worker is scoped to `/dashboard/` and caches the shell only. It is registered after
 * load so it never competes with the first paint, and a failure is logged rather than
 * surfaced: an installable app is a nicety, and a browser that refuses one still has a
 * working dashboard.
 *
 * ## The update the user could not take
 *
 * `sw.js` deliberately does not call `skipWaiting()` on install — a volunteer running a
 * shift should not have the scripts swapped underneath them mid-session — and its comment
 * said the page "can opt in with a `nexus-sw-skip-waiting` message when it is safe".
 * **Nothing in the client ever sent that message.** There was no opt-in, so the documented
 * escape hatch did not exist, and the only way to reach a new version was to close every
 * dashboard tab. Nothing told the user that, either: the shell is cache-first, so a tab left
 * open kept serving the old bundle indefinitely while the server had the new one. A fix
 * shipped and confirmed on the server could be invisible in the browser, with the page
 * offering no hint that the two disagreed.
 *
 * This file supplies the missing half. The waiting worker is never activated behind the
 * user's back; they are told an update is ready and it is applied when they say so, which is
 * the posture `sw.js` describes.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;
  // A dev reload loop is worse than no offline shell, so skip registration when the page
  // was opened with ?nosw=1.
  if (/[?&]nosw=1/.test(location.search)) return;

  /**
   * The worker the visible bar belongs to, or null.
   *
   * A boolean latch was wrong: it silenced every update after the first for the rest of the
   * session, so a dashboard left open across a shift would be told about one build and never
   * another. Keyed on the worker instead, a genuinely newer one can raise a fresh bar while
   * the same worker still cannot raise two.
   */
  let offeredWorker = null;
  /** `controllerchange` fires once per handover; reloading twice is a loop. */
  let reloading = false;

  /**
   * Ask for the update, then reload when the new worker is actually in charge.
   *
   * The reload is driven by `controllerchange`, with a timer only as a backstop: the swap is
   * what has to finish before a reload is worth anything, and a reload issued too early is
   * served by the *old* worker out of the *old* cache — the same stale bundle, with the
   * prompt now gone and no way to ask again. The 5 s fallback below exists because nothing
   * in the specification promises the event ever arrives, not because time is the signal.
   */
  function apply(worker) {
    const go = () => { if (!reloading) { reloading = true; location.reload(); } };

    // Already in charge, or superseded. Neither will ever fire `controllerchange` again:
    // another tab may have accepted this same update since the bar was drawn, or a newer
    // worker may have replaced this one. Posting `skipWaiting` to either is a no-op, and
    // waiting for an event that has already happened is how a button sticks on "Reloading…"
    // for the rest of the session with no way out but a manual refresh.
    if (worker.state !== 'installed' || navigator.serviceWorker.controller === worker) { go(); return; }

    navigator.serviceWorker.addEventListener('controllerchange', go);
    worker.postMessage({ type: 'nexus-sw-skip-waiting' });

    // Nothing in the specification promises an answer, and the user has already committed to
    // a reload by clicking. A plain reload picks up whatever is current: if the swap did
    // happen it lands on the new build, and if it did not the bar simply comes back.
    setTimeout(go, 5000);
  }

  /**
   * A bar the user can ignore.
   *
   * Built in script because the dashboard is under `script-src 'self'` with no inline
   * handlers, and because a control for a state that usually does not exist has no business
   * sitting in `index.html` — `scripts/checkShell.mjs` gates that file's contents, and a
   * permanently-hidden element there is one more thing for the gate to be wrong about.
   */
  function offer(worker) {
    if (!worker || offeredWorker === worker) return;
    document.querySelector('.sw-update')?.remove();   // a bar for a worker this one supersedes
    offeredWorker = worker;

    const bar = document.createElement('div');
    bar.className = 'sw-update';
    bar.setAttribute('role', 'status');

    const text = document.createElement('span');
    text.textContent = 'A new version of HackIllinois 2027 is ready.';

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'pb pb-sm';
    go.textContent = 'Reload';
    go.addEventListener('click', () => {
      go.disabled = true;
      go.textContent = 'Reloading…';
      apply(worker);
    });

    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'pb pb-ghost pb-sm';
    later.textContent = 'Not now';
    // Dismissing does not discard the update: the worker stays waiting and the next reload
    // of the last open tab picks it up. Saying "later" mid-shift is the case sw.js was
    // written around.
    later.addEventListener('click', () => {
      bar.remove();
      // Dismissing this build should not silence the next one.
      if (offeredWorker === worker) offeredWorker = null;
    });

    bar.append(text, go, later);
    document.body.appendChild(bar);
    window.Nexus?.emit?.('pwa:update-ready', {});
  }

  /** `installed` while a controller exists is an update; without one it is the first install. */
  function watch(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
    });
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/dashboard/sw.js', { scope: '/dashboard/' })
      .then((reg) => {
        window.Nexus?.emit?.('pwa:ready', { scope: reg.scope });

        // Already waiting: the worker finished installing on an earlier visit, or in another
        // tab. This is the common case, and checking only `updatefound` missed all of it.
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
        // A worker that was already installing when this page loaded never fires
        // `updatefound` for us — that event went to whoever triggered the update — so it has
        // to be picked up by hand or the whole build is missed on this tab.
        watch(reg.installing);
        reg.addEventListener('updatefound', () => watch(reg.installing));

        // Browsers check for a new worker on navigation, which a single-page dashboard left
        // open across a shift may not do for hours. Checking when the tab is brought back to
        // the front costs one conditional request and is the moment a person is most likely
        // to accept a reload.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch((err) => {
        console.info('[pwa] service worker not registered:', err.message);
      });
  });
})();
