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
  // `v18`: Silkscreen 700 on every pixel caption, the Me tab's trainer card, and a gym
  //        encounter that plays the hit instead of printing it.
  // `v19`: the update prompt itself — pwa.js now sends the skip-waiting message this file
  //        has described since v11, so a new build is reachable without closing every tab.
  // `v20`: the avatar the trainer creator makes is actually sent to the server, so the
  //        moderation queue and other trainers' faces stop being unreachable code.
  // `v24`: round-eighteen review — the battle no longer plays its animation in front of the
  //        write, the encounter guards check identity, and the face follows the map switch.
  // `v25`: the faction picker writes to the server and locks once allegiance is bound, and
  //        the pixel dropdown honours `disabled` so a locked control looks locked.
  // `v26`: gym defender counts read the projected `defenderCount`, so the compatibility shim
  //        on the server side can go.
  // `v27`: the defenders array is gone from the wire, so the fallback that read it is gone too.
  // `v28`: the spin geofence comes from the pack now that the server resolves it, instead of
  //        a client-side literal 75 that could disagree with the server in either direction.
  // `v30`: each Spin button and the token hint use the radius the server resolved for that
  //        stop or venue, instead of one campus number for everything.
  // `v32`: round-nineteen review — a 409 no longer locks the picker to the stale side, and a
  //        handover no longer wipes the incoming account's faction.
  // `v33`: round twenty — the nearest-stop readout uses that stop's fence, not the campus one.
  // `v34`: round twenty-one — the faction picker is disabled while its write is in flight,
  //        and a handover re-renders everything that reads the faction, not just the picker.
  // `v35`: comment corrections only; no behaviour change.
  // `v36`: round twenty-two — a faction write that never settles no longer disables the
  //        picker for ever, and the renders that precede it moved inside the try.
  // `v37`: the map says whether the trainer's position is your GPS or a demo placement, and
  //        how far off-campus a real fix is.
  // `v38`: the faction picker's in-flight state is state, not a paint argument.
  // `v39`: a HackStop on cooldown disables its own Spin button and counts down, instead of
  //        staying enabled and failing for five minutes after every success.
  // `v41`: Spin, Contest and Deploy said "place your trainer first" through a toast function
  //        that never existed, so all three failed silently.
  // `v42`: the quest board stops offering quests you are already on, and a refused claim is
  //        said where you are rather than in the War Room console.
  // `v43`: a handover no longer shows the departing account's shifts as the arriving one's.
  // `v44`: in lite mode a real GPS fix now beats the hidden demo sprite, for both the button
  //        gate and the coordinates sent to the server.
  // `v21`, `v22`, `v23`, `v29`, `v31`: intermediate bumps during the review rounds, each a lock rewrite for
  //        a change described in the commit rather than here. Named so the sequence has no
  //        silent gaps — these notes are the audit trail for a cache that evicts everything,
  //        and a missing number invites the question of what shipped undescribed.
  // `v40`: plugins.js no longer claims a content pack can carry a plugin.
  // `v45`: round twenty-three — cooldowns come from the server ledger, the nearest-stop
  //        readout honours them, and a handover resets faction and position provenance.
  // `v46`: the Privacy panel no longer tells you presence is symmetric. It is not: a lead
  //        reads your exact position whether or not they have switched themselves on.
  // `v47`: the Turf Wars intro's monument count comes from the pack instead of the word
  //        "Fourteen", which the Campus intro had already been rewriting for months.
  // `v48`: the Details link on a quest card opens a panel instead of writing one line to a
  //        console on a tab you are not looking at.
  // `v50`: the client stopped hardcoding this repository's three factions — Turf Wars threw
  //        and rendered nothing under any other content pack.
  // `v49`, `v51`: lock rewrites for changes described in their commits rather than here —
  //        the same convention as `v21`/`v22`/`v23`/`v29`/`v31` above. Named because the note
  //        above claims this sequence has no silent gaps, and until now it had two.
  // `v52`: the OSM attribution named three UIUC buildings a fork does not have, directly
  //        under a legal credit, with nothing rewriting it.
  // `v53`: a content pack with no baked campus model said "Renderer failed" over an empty
  //        grid — indistinguishable from the campus having been deleted. It now names the
  //        pack and the command that builds one. Also: Spin, Contest and Deploy refusals are
  //        spoken where you are instead of only in the War Room console.
  // `v54`: the missing-model notice stacked a second copy on every return to the tab, and a
  //        later successful boot left the old one on screen.
  // `v55`: round twenty-five — the jacket now rebakes instead of being repainted (a repaint
  //        cannot change a colour baked into pixels), the missing-model notice converges to
  //        one from any count, a Reinforce refusal no longer calls itself a battle, and the
  //        Details panel stopped removing a host that other dialogs' close path resolves.
  // `v56`: the map's refusals were silent. The presence server rejects a sample for seven
  //        distinct reasons and emitted every one of them as a `nack` that exactly one
  //        listener received, discarded and repainted — so the chip went on reading
  //        "Visible" while the server dropped every fix, asserting the opposite of what was
  //        happening. Each reason now says itself, in its own words: an inaccurate fix
  //        blames the radio and quotes both numbers, a single fast jump is not an accusation,
  //        and opting out is not an error. Also: `!navigator.geolocation` could not fire on
  //        an insecure origin (the object exists, the calls fail), so that case now names
  //        itself instead of surfacing as the browser blaming the user; and a geolocation
  //        timeout no longer switches walking off for good — only a refusal does.
  // `v57`: the SSE fallback discarded the same refusal reasons. `POST /presence` answers
  //        `{ accepted: false, reason }` and `postPosition` awaited it and dropped it on the
  //        floor — which matters more than it sounds, because the WebSocket transport sends a
  //        nack for only three of the seven reasons, so this HTTP reply is the only place
  //        OFF_CAMPUS and INACCURATE can currently be observed by a browser at all.
  const VERSION = 'v57';
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

  // No skipWaiting() here. A new worker waits until the last dashboard tab is gone so a
  // running shift never has its scripts swapped mid-session; the page opts in with a
  // `nexus-sw-skip-waiting` message when it is safe.
  //
  // That opt-in is sent by `pwa.js`, which shows the "a new version is ready" bar and posts
  // the message when the user accepts. It is named here because the sentence above described
  // it for eight versions while no client sent it: the escape hatch was documented and
  // absent, so the only route to a new build was closing every dashboard tab, and a
  // cache-first shell meant a tab left open served the old bundle for as long as it stayed
  // open. If that bar is ever removed, this comment is wrong again.
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
