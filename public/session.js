/**
 * session — identity for the dashboard (plan A2 client side).
 *
 * Fills in `Nexus.session` and installs `Nexus.api`, the fetch wrapper every
 * mutating request goes through so the CSRF header rides along. The session
 * itself is an HttpOnly cookie this script never sees; the only cookie read
 * here is the JS-readable CSRF nonce (`__Host-nexus_csrf`, or `nexus_csrf`
 * over plain http in development).
 *
 * Boot order (all before `Nexus.session.ready` resolves):
 *   0. An Adonix landing (`/dashboard/auth/adonix?token=…`) has its query
 *      token moved into the fragment immediately — fragments never reach the
 *      server or its logs.
 *   1. GET /me. 200 → signed in.
 *   2. Else a `#claim=` / `#magic=` / `#adonix=` fragment is exchanged, then
 *      cleared from the URL.
 *   3. Else, when the server is in legacy mode or lists the `dev` provider,
 *      dev-login as the first volunteer so `npm run demo` stays zero-setup.
 *   4. Else `session:required` fires and onboarding takes over.
 *
 * Every auth endpoint may 404 while the backend lands: that is treated as
 * legacy mode with no session, and the shell keeps working exactly as before.
 *
 * The content pack descriptor (`GET /api/v1/content`, plan A1) is fetched in
 * parallel with `/me` and settled on `Nexus.content` before `ready` resolves;
 * a 404 falls back to the static `/dashboard/content/*.json` paths.
 */

(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[session] nexus.js must load first'); return; }

  const API = '/api/v1';
  const LANDING = '/dashboard/';

  /* ------------------------------------------------------------------ *
   * 0. Adonix landing: query → fragment, synchronously, before anything else
   * ------------------------------------------------------------------ */

  (function moveQueryTokenIntoFragment() {
    const onLanding = /\/auth\/adonix\/?$/.test(location.pathname);
    const q = new URLSearchParams(location.search);
    const token = q.get('token') || q.get('jwt') || q.get('access_token');
    if (!onLanding && !token) return;
    const hash = token ? `#adonix=${encodeURIComponent(token)}` : location.hash;
    try { history.replaceState(null, '', LANDING + hash); } catch { /* opaque origin */ }
  })();

  /* ------------------------------------------------------------------ *
   * CSRF + fetch wrapper
   * ------------------------------------------------------------------ */

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?nexus_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  class ApiError extends Error {
    constructor(message, { status = 0, code = 'UNKNOWN', details = null, body = null } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
      this.body = body;
    }
  }

  /**
   * Nexus.api(path, { method = 'GET', body, headers, lenient, signal })
   *
   * Same-origin fetch that JSON-encodes `body`, adds `X-CSRF-Token` to every
   * non-GET, parses the `{ success, data, ... }` envelope and returns it whole
   * (callers read `.data`, and the registration endpoint also puts `.status`
   * beside `.success`). `success:false` or a non-2xx throws an ApiError with
   * `.status` (HTTP) and `.code` (the server's `error` field). `lenient: true`
   * returns the envelope instead of throwing — for callers that inspect
   * rejections themselves, like the concurrency bomb tallying its losers.
   */
  async function api(path, { method = 'GET', body, headers = {}, lenient = false, signal } = {}) {
    const url = path.startsWith('/') ? path : `${API}/${path}`;
    const m = String(method).toUpperCase();
    const h = { Accept: 'application/json', ...headers };
    if (m !== 'GET' && m !== 'HEAD') {
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      const token = csrfToken();
      if (token) h['X-CSRF-Token'] = token;
    }
    const init = { method: m, credentials: 'same-origin', headers: h, signal };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);

    const res = await fetch(url, init);
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }

    if (!json || typeof json !== 'object') {
      if (!res.ok) throw new ApiError(`${m} ${url} -> HTTP ${res.status}`, { status: res.status, code: `HTTP_${res.status}` });
      json = { success: true, data: null }; // 202/204 with an empty body
    }
    Object.defineProperty(json, 'httpStatus', { value: res.status, enumerable: false });

    if (json.success === false || !res.ok) {
      if (lenient) return json;
      throw new ApiError(json.message || json.error || `${m} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        code: json.error || json.code || `HTTP_${res.status}`,
        details: json.details ?? null,
        body: json,
      });
    }
    return json;
  }

  N.api = api;
  N.ApiError = ApiError;

  /* ------------------------------------------------------------------ *
   * Providers
   * ------------------------------------------------------------------ */

  let providersCache = null;

  /** `{ mode: 'legacy'|'required', providers: [...], available: boolean }`. 404 → legacy, unavailable. */
  async function providers(force = false) {
    if (providersCache && !force) return providersCache;
    try {
      const { data } = await api(`${API}/auth/providers`);
      providersCache = {
        mode: data?.mode === 'required' ? 'required' : 'legacy',
        providers: Array.isArray(data?.providers) ? data.providers : [],
        available: true,
      };
    } catch (err) {
      if (err.status !== 404) console.warn('[session] providers unavailable:', err.message);
      providersCache = { mode: 'legacy', providers: [], available: false };
    }
    N.flags.dev = providersCache.mode === 'legacy'
      || providersCache.providers.some((p) => p.id === 'dev' && p.enabled);
    return providersCache;
  }

  const hasProvider = (prov, id) => prov.providers.some((p) => p.id === id && p.enabled);

  /* ------------------------------------------------------------------ *
   * Session state
   * ------------------------------------------------------------------ */

  const session = N.session;

  /**
   * Per-account state this browser keeps outside the cookie.
   *
   * A reload clears everything in memory, which is why `logout` could get away with one for
   * so long — but `localStorage` and the service-worker cache both survive it, and this is a
   * shared laptop at a hackathon. Left behind, these were readable by whoever sat down next:
   * a distress call's seat number and the name attached to it, a face drawn from somebody's
   * photograph, a sticker book, a trainer card the worker would serve from cache the moment
   * the network dropped.
   *
   * `nexus.lite.v1` is deliberately absent: it is a rendering preference for the device, not
   * a fact about the person, and the next user of a slow laptop wants it kept.
   */
  const ACCOUNT_KEYS = ['nexus.sos.ticket', 'nexus.avatar.v1', 'nexus.stickers.v1'];

  /**
   * Which account this device last had signed in, so a change of hands is detectable.
   *
   * The id is already public — it appears in every roster payload — and holding it is what
   * lets the guard below fire for the case `logout` cannot cover: somebody closes the laptop
   * lid without signing out, and the next person signs in on the same browser. Clearing on
   * logout alone assumes people log out, and at four in the morning they do not.
   */
  const DEVICE_ACCOUNT_KEY = 'nexus.device.account';

  function setUser(account) {
    const prev = session.user;
    session.user = account || null;

    // A different person than the one this browser last carried: drop what the previous
    // account left behind before anything reads it. Deliberately not when the same account
    // signs back in, which would cost somebody their sticker book for refreshing a session.
    //
    // The FULL teardown, not just the storage keys. This branch exists for the handoff that
    // happens without a sign-out — somebody closes the lid, somebody else scans a badge —
    // and in that path there is no reload either, so the service-worker card survives and
    // `sessionStorage` survives with it. Clearing three `localStorage` keys and leaving the
    // cached trainer card behind is the shape of a fix rather than a fix.
    //
    // Not awaited: nothing here is reloading the page, so there is no teardown to race, and
    // `setUser` is called from synchronous paths that must not become asynchronous.
    let handedOver = false;
    if (session.user && session.user.id) {
      let last = null;
      try { last = localStorage.getItem(DEVICE_ACCOUNT_KEY); } catch { /* storage disabled */ }
      handedOver = !!last && last !== String(session.user.id);
      if (handedOver) void clearDeviceState();
      try { localStorage.setItem(DEVICE_ACCOUNT_KEY, String(session.user.id)); } catch { /* as above */ }
    }

    if (prev !== session.user) N.emit('session', session.user);
    // Storage is not the only place the previous account lives: the sticker book, the face
    // and the open SOS ticket are all held in memory by views that loaded them once. They
    // listen for this and forget. Emitted after `session` so a listener that wants both sees
    // the new user first.
    if (handedOver) N.emit('session:handover', session.user);
    return session.user;
  }

  /** Re-reads GET /me. 401 → signed out (not an error); anything else throws. */
  session.refresh = async function refresh() {
    try {
      const { data } = await api(`${API}/me`);
      return setUser(data?.account || null);
    } catch (err) {
      if (err.status === 401 || err.status === 404) return setUser(null);
      throw err;
    }
  };

  /**
   * Everything the departing account leaves on this device, removed before the reload.
   *
   * Awaited, not fired and forgotten. The service-worker message is delivered asynchronously
   * and `location.replace` tears the page down, so posting it and reloading in the same turn
   * is a race the cache usually wins — which is indistinguishable from never sending it, and
   * `sw.js` has carried a handler for a message nothing sent since it was written. The
   * timeout is there because a worker that never answers must not strand somebody on a
   * screen they are trying to leave.
   */
  async function clearDeviceState() {
    for (const key of ACCOUNT_KEYS) {
      try { localStorage.removeItem(key); } catch { /* private mode, or storage disabled */ }
    }
    try { sessionStorage.clear(); } catch { /* as above */ }

    const worker = navigator.serviceWorker;
    if (!worker || !worker.controller) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, 750);
      try {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { clearTimeout(timer); finish(); };
        worker.controller.postMessage({ type: 'nexus-sw-clear-card' }, [channel.port2]);
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  }

  session.logout = async function logout({ reload = true } = {}) {
    try { await api(`${API}/auth/logout`, { method: 'POST' }); } catch (err) { console.warn('[session] logout:', err.message); }
    setUser(null);
    N.emit('session:logout');
    // Before the reload, not after: the reload is what makes the in-memory caches safe, and
    // it is also what would cut a fire-and-forget cleanup short.
    await clearDeviceState();
    // Every cache in app.js was filled for the old account; a clean load is
    // the honest reset rather than chasing each one.
    if (reload) location.replace(LANDING);
  };

  session.providers = providers;

  /* ------------------------------------------------------------------ *
   * Exchanges
   * ------------------------------------------------------------------ */

  const EXCHANGE = {
    claim: { path: `${API}/auth/claim`, field: 'code' },
    magic: { path: `${API}/auth/magic`, field: 'token' },
    adonix: { path: `${API}/auth/adonix`, field: 'token' },
    dev: { path: `${API}/auth/dev-login`, field: 'accountId' },
  };

  /** POSTs a credential to its adapter, then refreshes /me. Returns the account. */
  session.exchange = async function exchange(kind, value) {
    const ex = EXCHANGE[kind];
    if (!ex) throw new ApiError(`unknown provider "${kind}"`, { code: 'UNKNOWN_PROVIDER' });
    const trimmed = String(value ?? '').trim();
    if (!trimmed) throw new ApiError('Nothing to send.', { code: 'EMPTY_CREDENTIAL' });
    await api(ex.path, { method: 'POST', body: { [ex.field]: kind === 'claim' ? trimmed.toUpperCase() : trimmed } });
    const user = await session.refresh();
    if (!user) throw new ApiError('Signed in, but /me says otherwise.', { code: 'SESSION_NOT_ESTABLISHED' });
    N.emit('session:exchanged', { kind, user });
    return user;
  };

  /** Explicitly link the held Adonix token to the signed-in account (the confirm button). */
  session.confirmLink = async function confirmLink() {
    const token = session.pendingLink?.token;
    session.pendingLink = null;
    if (!token) throw new ApiError('Nothing to link.', { code: 'NO_PENDING_LINK' });
    await api(EXCHANGE.adonix.path, { method: 'POST', body: { token, link: true } });
    const user = await session.refresh();
    N.emit('session:exchanged', { kind: 'adonix', user });
    return user;
  };
  session.dismissLink = function dismissLink() { session.pendingLink = null; };
  session.pendingLink = null;

  /** POST /auth/magic-link {email} → 202. */
  session.requestMagicLink = (email) => api(`${API}/auth/magic-link`, { method: 'POST', body: { email: String(email || '').trim() } });

  /** The `#claim=`, `#magic=`, `#adonix=` fragments — exactly those names. */
  function readFragment() {
    const m = location.hash.match(/^#(claim|magic|adonix)=(.+)$/);
    if (!m) return null;
    let value = m[2];
    try { value = decodeURIComponent(value); } catch { /* keep raw */ }
    return { kind: m[1], value };
  }

  function clearFragment() {
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* opaque origin */ }
  }

  const ROLE_RANK = { HACKER: 0, VOLUNTEER: 0, SHIFT_LEAD: 1, ORGANIZER: 2, ADMIN: 3 };

  /**
   * `npm run demo`: sign in as the highest-ranked seeded account (the ORGANIZER
   * "Nexus Ops"), so every war-room tool passes its role gate. Reads the
   * non-production dev-accounts list; falls back to the volunteer directory.
   */
  session.pickDemoAccount = async function pickDemoAccount() {
    let rows = null;
    try { rows = (await api(`${API}/auth/dev-accounts`)).data; } catch (err) { if (err.status !== 404) throw err; }
    if (!Array.isArray(rows)) {
      const { data } = await api(`${API}/volunteers`);
      rows = (Array.isArray(data) ? data : []).map((v) => ({ id: v._id, name: v.name, role: v.role, kind: v.kind }));
    }
    rows.sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0));
    return rows[0] || null;
  };

  async function devAutoLogin() {
    const first = await session.pickDemoAccount();
    if (!first?.id) throw new ApiError('No volunteers seeded', { code: 'NO_VOLUNTEERS' });
    await api(EXCHANGE.dev.path, { method: 'POST', body: { accountId: first.id } });
    return session.refresh();
  }

  /* ------------------------------------------------------------------ *
   * Content pack descriptor
   * ------------------------------------------------------------------ */

  const CONTENT_BASE = '/dashboard/content';

  /** What the shell assumes when GET /api/v1/content is not there (yet). */
  function contentFallback() {
    return {
      pack: null,
      packVersion: 0,
      event: null,
      venues: {},
      factions: [],
      monuments: [],
      contentBase: CONTENT_BASE,
      files: {
        campus: `${CONTENT_BASE}/campus.json`,
        memorabilia: `${CONTENT_BASE}/memorabilia.json`,
        'monuments-info': `${CONTENT_BASE}/monuments-info.json`,
      },
      fallback: true,
    };
  }

  /** GET /api/v1/content → `Nexus.content`. Never throws: any failure means the fallback. */
  async function loadContent() {
    let content;
    try {
      const { data } = await api(`${API}/content`);
      if (!data || typeof data !== 'object' || typeof data.files !== 'object') throw new ApiError('malformed content descriptor', { code: 'BAD_CONTENT' });
      content = {
        ...data,
        contentBase: typeof data.contentBase === 'string' ? data.contentBase : CONTENT_BASE,
        factions: Array.isArray(data.factions) ? data.factions : [],
        monuments: Array.isArray(data.monuments) ? data.monuments : [],
        venues: data.venues && typeof data.venues === 'object' ? data.venues : {},
        files: { ...contentFallback().files, ...data.files },
      };
    } catch (err) {
      console.warn(`[session] content descriptor unavailable (${err.status || err.code || err.message}); using ${CONTENT_BASE}/*.json`);
      content = contentFallback();
    }
    N._settleContent(content);
    return content;
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  async function boot() {
    const frag = readFragment();
    let user = null;
    let fragmentError = null;

    // /me and the content descriptor are independent; one round trip, not two.
    const contentLoading = loadContent();
    try { user = await session.refresh(); } catch (err) { console.warn('[session] /me failed:', err.message); }
    await contentLoading;

    if (frag && frag.kind === 'adonix' && user) {
      // Account-tying guard: a signed-in person arriving with an Adonix token is a LINK, and
      // a link needs their say-so. Otherwise anyone could send a victim to
      // /dashboard/#adonix=<attacker token> and this page would tie the attacker's SSO identity
      // to the victim's account. The token is held in memory until they confirm or dismiss;
      // the server refuses to link without `link: true` regardless.
      session.pendingLink = { token: frag.value };
      clearFragment();
      N.emit('session:link-pending', { user });
    } else if (frag) {
      // A fresh credential wins over whatever session the browser already had
      // — scanning a badge on a shared laptop must sign *that* hacker in.
      try {
        user = await session.exchange(frag.kind, frag.value);
      } catch (err) {
        fragmentError = { kind: frag.kind, error: err };
        console.warn(`[session] ${frag.kind} exchange failed:`, err.message);
      } finally {
        clearFragment();
      }
    }

    const prov = await providers();

    if (!user && (prov.mode === 'legacy' || hasProvider(prov, 'dev'))) {
      try { user = await devAutoLogin(); } catch (err) {
        if (err.status !== 404) console.info('[session] dev auto-login skipped:', err.message);
      }
    }

    session._settle(user);
    N.emit('session:ready', { user, providers: prov, fragment: frag, fragmentError });

    if (fragmentError) N.emit('session:error', fragmentError);
    if (!user && prov.mode === 'required') N.emit('session:required', prov);
  }

  boot().catch((err) => {
    console.error('[session] boot failed:', err);
    if (!N.content) N._settleContent(contentFallback());
    session._settle(null);
    N.emit('session:ready', { user: null, providers: providersCache || { mode: 'legacy', providers: [], available: false }, fragment: null, fragmentError: null });
  });
})();
