/**
 * Service worker for the dashboard shell (plan §C10).
 *
 * The file is served from /dashboard/sw.js, so its default scope is /dashboard/
 * and nothing outside the dashboard is ever intercepted. Registration must not
 * widen that: no Service-Worker-Allowed header is set anywhere, and asking for a
 * broader scope would simply fail.
 *
 * The offline contract is deliberately narrow. A volunteer who walks into a
 * basement should still get the shell and their trainer card; they should never
 * get a stale quest board, and they should never be able to claim a shift into a
 * queue that replays minutes later against a slot someone else already took. So:
 *
 *   - The shell (HTML, CSS, the classic scripts, the vendored fonts) is
 *     precached on install and served cache-first. It is versioned bytes; the
 *     network is only the fallback.
 *   - GET /api/v1/me/card is the single cacheable API response, and this worker
 *     is the *only* thing that keeps a copy. The server sends `no-store`: it used
 *     to send `private, max-age=86400`, which put the card in the browser's own
 *     HTTP cache keyed on the URL and not partitioned by cookie, so on a shared
 *     laptop the next account's request was answered from disk with the previous
 *     account's card (see src/routes/v1/me.routes.ts). The copy here is purged on
 *     logout and on handover, which is what makes it the safe one. It carries only
 *     a short id, a display name, a faction and counts, and is served network-first
 *     so a signed-in volunteer always sees live values.
 *   - Every other /api/ request, and every non-GET request, is left alone. The
 *     fetch handler returns without calling respondWith, which hands the request
 *     back to the browser untouched.
 *
 * There is no Background Sync registration and no write queue, by design. An
 * offline claim, check-in, SOS or swap must fail loudly in the UI while the
 * volunteer can still react to it.
 */

(function () {
  'use strict';

  // Bump VERSION whenever the **contents** of any precached file change — not only when the
  // shell list or the caching rules do. Old caches are deleted on activate, so a bump is also
  // the eviction mechanism.
  //
  // The narrower rule this comment used to state is what made the trap below reachable: the
  // list can be identical while every file in it is different, and that is the ordinary shape
  // of a release. `scripts/checkShell.mjs` now hashes the precached bytes against
  // `public/sw-shell.lock` and fails the build if they moved without a bump, because a rule
  // that has to be remembered is one this repository has repeatedly found rots.
  //
  // Not bumping is not cosmetic — the shell is served cache-first, so an installed worker
  // keeps handing the page the JS it cached at install time, and a `fetch(url, {cache:
  // 'reload'})` does not get past it either. That is how it should behave for a user on a
  // train; it is also how a developer spends twenty minutes testing code the browser is not
  // running, and how a shipped security fix reaches nobody who already has the tab open.
  //
  // `v2`: the shell list gained the nine scripts the per-tab split had left out, and the
  // clear-card handler learned to acknowledge.
  // `v3`: the handover teardown in views/lead.js and app.js, and the SOS cache it clears.
  // `v4`: pxselect.js joins the shell, and the type scale moved — a cached v3 bundle would show
  //       the old sizes and the OS dropdown next to a page that had stopped using either.
  // `v5`: dropdown options wrap instead of truncating, and only one list opens at a time.
  // `v6`: qr.js joins the shell — the attendance panel draws a real scannable code now — and
  //       the tab strip grew to a readable size.
  // `v7`: low-power map stacking — the way back to the 3D campus was under the 3D HUD.
  // `v8`: the campus never stands itself down now; low-power is a choice, not a guess.
  // `v9`: contrast and type pass — invisible ink-on-dark text, undefined tokens, 7px Silkscreen.
  // `v10`: destructive demo controls removed from the shipped nav.
  const VERSION = 'v11';
  const SHELL_CACHE = 'nexus-shell-' + VERSION;
  const CARD_CACHE = 'nexus-card-' + VERSION;
  const CURRENT_CACHES = [SHELL_CACHE, CARD_CACHE];

  const INDEX = '/dashboard/index.html';
  const CARD_PATH = '/api/v1/me/card';

  // Loaded by index.html on every visit. If any of these is missing the install
  // fails and the previous worker stays in charge, which is the outcome we want:
  // a half-cached shell is worse than no shell.
  //
  // Kept in lockstep with index.html by `scripts/checkShell.mjs`, which is a gate rather than
  // a convention because this list drifted silently once already: the dashboard was split
  // into per-tab views and nine of the scripts index.html loads were never added here. The
  // shell cached, the page loaded offline, and every one of those scripts failed at
  // `ERR_INTERNET_DISCONNECTED` — so Me, Quests, SOS and Lead rendered as empty containers.
  // An offline shell that serves a blank page is worse than no offline shell, because it
  // looks like it worked.
  const SHELL = [
    INDEX,
    '/dashboard/manifest.webmanifest',
    '/dashboard/tokens.css',
    '/dashboard/styles.css',
    '/dashboard/nexus.js',
    '/dashboard/session.js',
    '/dashboard/theme.js',
    '/dashboard/lite.js',
    '/dashboard/qr.js',
    '/dashboard/pxselect.js',
    '/dashboard/a11y.js',
    '/dashboard/pwa.js',
    '/dashboard/plugins.js',
    '/dashboard/views/onboarding.js',
    '/dashboard/views/players.js',
    '/dashboard/views/announce.js',
    '/dashboard/views/me.js',
    '/dashboard/views/lead.js',
    '/dashboard/views/sos.js',
    '/dashboard/views/quests.js',
    '/dashboard/sprites.js',
    '/dashboard/fx.js',
    '/dashboard/soundEngine.js',
    '/dashboard/game.js',
    '/dashboard/app.js',
  ];

  // Fetched one at a time and allowed to fail. A font subset can be renamed by a
  // rebuild of the vendored set, and avatar.js is only pulled in when the trainer
  // opens the builder; neither is worth failing an install over.
  const SHELL_OPTIONAL = [
    '/dashboard/avatar.js',
    '/dashboard/fonts/silkscreen-400-latin.woff2',
    '/dashboard/fonts/silkscreen-400-latin-ext.woff2',
    '/dashboard/fonts/silkscreen-700-latin.woff2',
    '/dashboard/fonts/silkscreen-700-latin-ext.woff2',
    '/dashboard/fonts/jersey-10-400-latin.woff2',
    '/dashboard/fonts/jersey-10-400-latin-ext.woff2',
    '/dashboard/fonts/pixelify-sans-400-700-latin.woff2',
    '/dashboard/fonts/pixelify-sans-400-700-latin-ext.woff2',
    '/dashboard/fonts/pixelify-sans-400-700-cyrillic.woff2',
    '/dashboard/fonts/vt323-400-latin.woff2',
    '/dashboard/fonts/vt323-400-latin-ext.woff2',
    '/dashboard/fonts/vt323-400-vietnamese.woff2',
  ];

  // The renderer under /dashboard/gl/ is left out on purpose. It is the largest
  // thing the dashboard loads, it is imported lazily by app.js, and the campus it
  // draws needs live presence data anyway, so there is nothing useful to show
  // from a cached copy of it.

  const PRECACHED = new Set(SHELL.concat(SHELL_OPTIONAL));

  /* ------------------------------------------------------------------ *
   * Install / activate
   * ------------------------------------------------------------------ */

  self.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        // `cache: 'reload'` skips the HTTP cache, so a freshly installed worker
        // never precaches bytes an earlier visit left behind.
        await cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })));
        await Promise.all(
          SHELL_OPTIONAL.map(async (url) => {
            try {
              await cache.add(new Request(url, { cache: 'reload' }));
            } catch (err) {
              console.warn('[sw] optional shell asset skipped:', url, err);
            }
          })
        );
      })()
    );
  });

  // No skipWaiting() here. A new worker waits until the last dashboard tab is
  // gone so a running shift never has its scripts swapped mid-session; the page
  // can opt in with a `nexus-sw-skip-waiting` message when it is safe.
  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter((name) => name.startsWith('nexus-') && !CURRENT_CACHES.includes(name))
            .map((name) => caches.delete(name))
        );
        await self.clients.claim();
      })()
    );
  });

  /* ------------------------------------------------------------------ *
   * Fetch strategies
   * ------------------------------------------------------------------ */

  /** Precached shell asset: cache first, network only when it is missing. */
  async function fromShell(request, key) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(key);
    if (hit) return hit;
    return fetch(request);
  }

  /**
   * Navigations go to the network first: the shell HTML names the scripts, and a
   * stale copy would pin the app to a previous release for as long as the tab
   * lives. The cached index is the offline fallback only.
   */
  async function fromNetworkThenIndex(request) {
    try {
      return await fetch(request);
    } catch (err) {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(INDEX);
      if (hit) return hit;
      throw err;
    }
  }

  /**
   * The trainer card. `private` here means "not a shared cache", and this store
   * is scoped to one browser profile on one device, which is the storage the
   * header intends. A 401 or 403 means the session ended or changed hands, so the
   * previous account's card is dropped rather than left to be served offline.
   */
  async function fromNetworkThenCard(request) {
    const cache = await caches.open(CARD_CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(CARD_PATH, response.clone());
      } else if (response.status === 401 || response.status === 403) {
        await cache.delete(CARD_PATH);
      }
      return response;
    } catch (err) {
      const hit = await cache.match(CARD_PATH);
      if (hit) return hit;
      throw err;
    }
  }

  self.addEventListener('fetch', (event) => {
    const request = event.request;

    // Mutations are never served, never queued, never retried.
    if (request.method !== 'GET') return;

    let url;
    try {
      url = new URL(request.url);
    } catch (err) {
      return;
    }
    if (url.origin !== self.location.origin) return;

    if (url.pathname === CARD_PATH) {
      event.respondWith(fromNetworkThenCard(request));
      return;
    }

    // Everything else under /api/ is live data: quests, presence, leaderboards,
    // SOS tickets. Falling through leaves the request to the browser.
    if (url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate') {
      event.respondWith(fromNetworkThenIndex(request));
      return;
    }

    if (PRECACHED.has(url.pathname)) {
      event.respondWith(fromShell(request, url.pathname));
    }
  });

  /* ------------------------------------------------------------------ *
   * Page messages
   * ------------------------------------------------------------------ */

  self.addEventListener('message', (event) => {
    const type = event.data && event.data.type;
    if (type === 'nexus-sw-skip-waiting') {
      self.skipWaiting();
      return;
    }
    // Sent by session.js on sign-out: the card belongs to the account that just
    // left, and the next person on this device must not be able to read it.
    if (type === 'nexus-sw-clear-card') {
      // Acknowledged on the port the sender provided, so `session.js` can wait for the
      // deletion rather than for a timeout it chose. Without the reply the sender cannot tell
      // "cleared" from "the worker is not listening", and it tears the page down either way.
      const reply = event.ports && event.ports[0];
      event.waitUntil(
        caches
          .open(CARD_CACHE)
          .then((cache) => cache.delete(CARD_PATH))
          .catch(() => undefined)
          .then(() => { if (reply) { try { reply.postMessage({ ok: true }); } catch { /* port closed */ } } })
      );
    }
  });
})();
