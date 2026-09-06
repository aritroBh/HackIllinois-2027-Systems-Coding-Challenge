/**
 * Nexus — the registry every dashboard script hangs off (plan C1).
 *
 * Loaded first. Owns the tab registry (nav is rendered from it), the action
 * registry behind the one delegated `data-action` click listener, a tiny
 * pub/sub bus, the sticker / item-renderer / HUD-widget registries that
 * content packs and plugins will fill from M2 onward, and `Nexus.dialog`,
 * the focus-trapping modal helper that generalises the gym encounter.
 *
 * Identity lives in `Nexus.session` but is *filled in* by session.js, which
 * loads next: this file only creates the deferred `ready` promise so that any
 * script can `await Nexus.session.ready` regardless of load order. No token is
 * ever held here — the session is an HttpOnly cookie the browser carries.
 *
 * Plain script (CSP: script-src 'self', no inline). Everything is on
 * `window.Nexus`; the legacy globals (`window.game`, `window.campus`, the
 * cache getters) keep working for one release, `window.switchTab` warns.
 */

(function () {
  'use strict';

  if (window.Nexus) {
    console.warn('[nexus] loaded twice; keeping the first instance');
    return;
  }

  /* ------------------------------------------------------------------ *
   * Event bus
   * ------------------------------------------------------------------ */

  const channels = new Map(); // channel → Set<fn>

  function onEvent(channel, fn) {
    if (typeof fn !== 'function') throw new TypeError('Nexus.onEvent: handler must be a function');
    let set = channels.get(channel);
    if (!set) channels.set(channel, (set = new Set()));
    set.add(fn);
    return () => { set.delete(fn); };
  }

  function emit(channel, payload) {
    const set = channels.get(channel);
    if (!set || set.size === 0) return 0;
    // Copy: a handler may unsubscribe itself (or others) while we iterate.
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[nexus] "${channel}" handler threw:`, err); }
    }
    return set.size;
  }

  /* ------------------------------------------------------------------ *
   * Flags
   * ------------------------------------------------------------------ */

  const reducedMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const flags = {
    dev: false,            // session.js: legacy mode or the dev provider is enabled
    lite: /(?:^|[?&])lite=1(?:&|$)/.test(location.search) || !!navigator.connection?.saveData,
    reducedMotion: !!reducedMotionQuery?.matches,
  };
  reducedMotionQuery?.addEventListener?.('change', (e) => {
    flags.reducedMotion = e.matches;
    emit('flags', flags);
  });

  /* ------------------------------------------------------------------ *
   * Session (deferred; session.js settles it)
   * ------------------------------------------------------------------ */

  let settleReady;
  const session = {
    user: null,
    ready: new Promise((resolve) => { settleReady = resolve; }),
    // session.js replaces these; the stubs keep callers safe if it fails to load.
    refresh: async () => session.user,
    logout: async () => {},
  };
  Object.defineProperty(session, '_settle', {
    enumerable: false,
    value(user) { session.user = user ?? null; settleReady(session.user); },
  });

  /* ------------------------------------------------------------------ *
   * Content pack (deferred; session.js fetches GET /api/v1/content)
   * ------------------------------------------------------------------ */

  // Where the active pack's files are served when the descriptor is not (yet)
  // available: the server mounts the pack directory at /dashboard/content.
  const CONTENT_BASE = '/dashboard/content';
  const CONTENT_FALLBACK_FILES = {
    campus: `${CONTENT_BASE}/campus.json`,
    memorabilia: `${CONTENT_BASE}/memorabilia.json`,
    'monuments-info': `${CONTENT_BASE}/monuments-info.json`,
  };

  let settleContent;
  const contentReady = new Promise((resolve) => { settleContent = resolve; });

  /**
   * URL of a pack file by its basename without `.json` (`campus`,
   * `memorabilia`, `monuments-info`, …). Reads `Nexus.content.files` when the
   * descriptor has loaded and falls back to the static mount otherwise, so a
   * script that runs before session.js settles still gets a usable path.
   */
  function contentUrl(name) {
    const files = Nexus.content?.files;
    if (files && typeof files[name] === 'string') return files[name];
    if (CONTENT_FALLBACK_FILES[name]) return CONTENT_FALLBACK_FILES[name];
    return `${Nexus.content?.contentBase || CONTENT_BASE}/${name}.json`;
  }

  /* ------------------------------------------------------------------ *
   * Actions: one delegated listener for every `[data-action]`
   * ------------------------------------------------------------------ */

  const actions = new Map();

  /**
   * Registers a click handler for `data-action="<name>"`. Last registration
   * wins on purpose: app.js re-registers `encounter` over game.js's version to
   * add its no-renderer fallback, and a plugin may override a shell action.
   * Returns the previous handler so an override can chain to it.
   */
  function registerAction(name, handler) {
    if (typeof name !== 'string' || !name) throw new TypeError('Nexus.registerAction: name required');
    if (typeof handler !== 'function') throw new TypeError(`Nexus.registerAction("${name}"): handler must be a function`);
    const prev = actions.get(name) || null;
    actions.set(name, handler);
    return prev;
  }

  document.addEventListener('click', (event) => {
    const el = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!el) return;
    const name = el.dataset.action;
    const handler = actions.get(name);
    if (handler) { handler(el, event); return; }
    // Not registered — game.js's own map is the fallback until it migrates
    // fully. If neither claims it the control is dead; say so instead of
    // failing silently (an inline onclick would at least have thrown).
    if (window.game?.handle?.(name, el)) return;
    console.warn(`[nexus] no handler for data-action="${name}"`, el);
  });

  /* ------------------------------------------------------------------ *
   * Dialogs: focus trap + Escape + return-focus
   * ------------------------------------------------------------------ */

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const dialogStack = []; // bottom → top; the top one owns Tab and Escape

  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(isVisible);

  /**
   * Opens `el` as a modal: adds `.open`, moves focus inside, traps Tab, closes
   * on Escape and restores focus to the opener (or `returnFocus`) on close.
   * Re-opening an element already on the stack keeps its original opener so a
   * dialog that re-renders itself (the encounter after each command) still
   * hands focus back to where the user came from.
   */
  function dialogOpen(el, opts = {}) {
    if (!(el instanceof Element)) return null;
    const existing = dialogStack.findIndex((d) => d.el === el);
    let entry;
    if (existing >= 0) {
      [entry] = dialogStack.splice(existing, 1);
      if (opts.onClose) entry.onClose = opts.onClose;
    } else {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      entry = {
        el,
        returnFocus: opts.returnFocus === undefined ? active : opts.returnFocus,
        onClose: opts.onClose || null,
        dismissible: true,
      };
    }
    // `dismissible: false` makes Escape a no-op — a sign-in the server requires
    // has nothing behind it to escape to.
    if (opts.dismissible !== undefined) entry.dismissible = !!opts.dismissible;
    dialogStack.push(entry);
    if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
    el.classList.add('open');
    el.removeAttribute('hidden');
    const initial = typeof opts.initialFocus === 'string' ? el.querySelector(opts.initialFocus)
      : opts.initialFocus instanceof HTMLElement ? opts.initialFocus
        : focusables(el)[0] || el;
    initial?.focus?.({ preventScroll: true });
    emit('dialog:open', { el });
    return entry;
  }

  /** Closes `el` (or the topmost dialog when omitted). Returns whether one closed. */
  function dialogClose(el, { restoreFocus = true } = {}) {
    const i = el ? dialogStack.findIndex((d) => d.el === el) : dialogStack.length - 1;
    if (i < 0) return false;
    const [entry] = dialogStack.splice(i, 1);
    entry.el.classList.remove('open');
    try { entry.onClose?.(); } catch (err) { console.error('[nexus] dialog onClose threw:', err); }
    if (restoreFocus && entry.returnFocus?.isConnected) entry.returnFocus.focus({ preventScroll: true });
    emit('dialog:close', { el: entry.el });
    return true;
  }

  const dialogIsOpen = (el) => dialogStack.some((d) => d.el === el);

  document.addEventListener('keydown', (e) => {
    const top = dialogStack[dialogStack.length - 1];

    if (e.key === 'Escape') {
      if (top) { e.preventDefault(); if (top.dismissible) dialogClose(top.el); return; }
      emit('escape', e); // app.js: loot modal, cinematic mode
      return;
    }

    if (e.key === 'Tab' && top) {
      const list = focusables(top.el);
      if (list.length === 0) { e.preventDefault(); top.el.focus(); return; }
      const first = list[0], last = list[list.length - 1];
      const inside = top.el.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
      return;
    }

    // Non-button elements carrying an action (the gym cards are role=button
    // articles) must be keyboard-operable like a real button.
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLElement && e.target.matches('[data-action][role="button"]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  /* ------------------------------------------------------------------ *
   * Tabs + nav
   * ------------------------------------------------------------------ */

  const tabs = new Map(); // id → def
  let activeTab = null;
  let navQueued = false;

  const canSee = (def) => !def.roles?.length || (session.user && def.roles.includes(session.user.role));
  const orderedTabs = () => [...tabs.values()].sort((a, b) => (a.order - b.order) || a.label.localeCompare(b.label));
  const visibleTabs = () => orderedTabs().filter(canSee);

  /**
   * registerTab({ id, label, roles = [], order = 100, render, onShow, onHide, badge })
   *  - `id` is the section id (`tab-shifts`); an existing `<section id>` is
   *    adopted, otherwise one is created in <main> and `render(section)` is
   *    called on first show.
   *  - `roles` empty → visible to everyone (the role router lands in M5).
   *  - `badge` is a string/number or a function returning one, shown as a
   *    sticker on the nav button; call `Nexus.refreshNav()` after it changes.
   */
  function registerTab(def) {
    if (!def || typeof def.id !== 'string' || !def.id) throw new TypeError('Nexus.registerTab: id required');
    const entry = {
      roles: [], order: 100, render: null, onShow: null, onHide: null, badge: null,
      label: def.id,
      ...def,
      rendered: false,
    };
    tabs.set(entry.id, entry);
    scheduleNav();
    return entry;
  }

  function scheduleNav() {
    if (navQueued) return;
    navQueued = true;
    queueMicrotask(() => { navQueued = false; renderNav(); });
  }

  function navHost() {
    return document.querySelector('nav.tabs-nav .inner') || document.querySelector('nav.tabs-nav');
  }

  function badgeText(def) {
    try {
      const v = typeof def.badge === 'function' ? def.badge() : def.badge;
      return v == null || v === '' || v === 0 ? '' : String(v);
    } catch { return ''; }
  }

  function renderNav() {
    const host = navHost();
    if (!host) return;
    if (!activeTab) activeTab = document.querySelector('.tab-content.active')?.id || null;
    const list = visibleTabs();
    if (list.length === 0) return; // nothing registered yet: keep the static fallback buttons
    if (!list.some((t) => t.id === activeTab)) activeTab = list[0].id;

    host.setAttribute('role', 'tablist');
    host.replaceChildren(...list.map((def) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pb tab-btn' + (def.id === activeTab ? ' active' : '');
      btn.id = `tabbtn-${def.id}`;
      btn.dataset.action = 'tab';
      btn.dataset.tab = def.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(def.id === activeTab));
      btn.setAttribute('aria-controls', def.id);
      btn.tabIndex = def.id === activeTab ? 0 : -1;
      btn.append(document.createTextNode(def.label));
      const badge = badgeText(def);
      if (badge) {
        const s = document.createElement('span');
        s.className = 'sticker tab-badge';
        s.textContent = badge;
        btn.append(s);
      }
      return btn;
    }));

    for (const def of list) {
      const section = document.getElementById(def.id);
      if (section) {
        section.setAttribute('role', 'tabpanel');
        section.setAttribute('aria-labelledby', `tabbtn-${def.id}`);
        section.classList.toggle('active', def.id === activeTab);
      }
    }
  }

  // Roving tabindex + arrow keys, per the WAI-ARIA tabs pattern (automatic activation).
  document.addEventListener('keydown', (e) => {
    const host = navHost();
    if (!host || !(e.target instanceof HTMLElement) || !host.contains(e.target) || e.target.getAttribute('role') !== 'tab') return;
    const btns = [...host.querySelectorAll('[role="tab"]')];
    const i = btns.indexOf(e.target);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % btns.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + btns.length) % btns.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = btns.length - 1;
    if (next < 0) return;
    e.preventDefault();
    btns[next].focus();
    showTab(btns[next].dataset.tab);
  });

  function ensureSection(def) {
    let section = document.getElementById(def.id);
    if (!section) {
      section = document.createElement('section');
      section.id = def.id;
      section.className = 'tab-content';
      section.setAttribute('role', 'tabpanel');
      section.setAttribute('aria-labelledby', `tabbtn-${def.id}`);
      (document.querySelector('main') || document.body).appendChild(section);
    }
    if (!def.rendered && typeof def.render === 'function') {
      def.rendered = true;
      try { def.render(section); } catch (err) { console.error(`[nexus] render for tab "${def.id}" threw:`, err); }
    }
    return section;
  }

  /** Activates a tab. Replaces app.js's `switchTab`; returns false for unknown ids. */
  function showTab(id) {
    const def = tabs.get(id);
    if (!def) { console.warn(`[nexus] showTab: unknown tab "${id}"`); return false; }
    if (!canSee(def)) { console.warn(`[nexus] showTab: "${id}" is not available to this account`); return false; }
    const prev = activeTab;
    if (prev && prev !== id) {
      try { tabs.get(prev)?.onHide?.(document.getElementById(prev)); } catch (err) { console.error('[nexus] onHide threw:', err); }
    }
    activeTab = id;
    const section = ensureSection(def);
    document.querySelectorAll('.tab-content').forEach((s) => s.classList.toggle('active', s === section));
    const host = navHost();
    if (host) {
      host.querySelectorAll('[role="tab"]').forEach((b) => {
        const on = b.dataset.tab === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      });
    }
    try { def.onShow?.(section, { prev }); } catch (err) { console.error(`[nexus] onShow for "${id}" threw:`, err); }
    emit('tab', { id, prev });
    return true;
  }

  registerAction('tab', (el) => showTab(el.dataset.tab));

  // Roles can change what is visible; re-render whenever the session settles.
  onEvent('session', () => scheduleNav());

  /* ------------------------------------------------------------------ *
   * Content registries (filled by content packs / plugins from M2)
   * ------------------------------------------------------------------ */

  const stickers = new Map();     // id → item
  const itemRenderers = new Map(); // kind → fn(item, ctx) → Node|string
  const hudWidgets = new Map();    // id → widget

  function registerSticker(item) {
    if (!item || typeof item.id !== 'string') throw new TypeError('Nexus.registerSticker: item.id required');
    stickers.set(item.id, item);
    // sprites.js owns the drawn registry; hand it the item when it can take one.
    if (typeof window.Sprites?.registerItem === 'function') {
      try { window.Sprites.registerItem(item); } catch (err) { console.warn('[nexus] Sprites.registerItem rejected', item.id, err); }
    }
    emit('sticker:registered', item);
    return item;
  }

  function registerItemRenderer(kind, fn) {
    if (typeof kind !== 'string' || typeof fn !== 'function') throw new TypeError('Nexus.registerItemRenderer(kind, fn)');
    const prev = itemRenderers.get(kind) || null;
    itemRenderers.set(kind, fn);
    return prev;
  }

  /**
   * registerHudWidget({ id, corner: 'tl'|'tr'|'bl'|'br'|'mt', render(el), tick(el, frame) })
   * Mounts a `.hudbox` into the matching `.viewport-hud.<corner>` over the
   * campus canvas. `tick` runs from the renderer's frame callback, throttled
   * to 2 Hz so a widget cannot become the jank.
   */
  function registerHudWidget(w) {
    if (!w || typeof w.id !== 'string') throw new TypeError('Nexus.registerHudWidget: id required');
    const widget = { corner: 'tr', render: null, tick: null, ...w, el: null, last: 0 };
    hudWidgets.set(widget.id, widget);
    mountHudWidget(widget);
    return widget;
  }

  function mountHudWidget(widget) {
    const host = document.querySelector(`.viewport-hud.${widget.corner}`);
    if (!host) return; // campus section not in this page; try again on demand
    let el = host.querySelector(`[data-widget="${widget.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'hudbox nexus-widget';
      el.dataset.widget = widget.id;
      host.appendChild(el);
    }
    widget.el = el;
    try { widget.render?.(el); } catch (err) { console.error(`[nexus] HUD widget "${widget.id}" render threw:`, err); }
  }

  onEvent('frame', (frame) => {
    const now = performance.now();
    for (const w of hudWidgets.values()) {
      if (!w.tick) continue;
      if (!w.el || !w.el.isConnected) mountHudWidget(w);
      if (!w.el || now - w.last < 500) continue;
      w.last = now;
      try { w.tick(w.el, frame); } catch (err) { console.error(`[nexus] HUD widget "${w.id}" tick threw:`, err); }
    }
  });

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  const Nexus = {
    version: '2',
    session,
    flags,
    // The content pack descriptor (A1): `{ pack, packVersion, event, venues,
    // factions, monuments, contentBase, files }`. null until session.js has
    // fetched GET /api/v1/content; `contentReady` resolves with it (or with the
    // static fallback when the endpoint is missing) before `session.ready`.
    content: null,
    contentReady,
    contentUrl,

    registerTab, showTab, refreshNav: scheduleNav,
    tabs: () => orderedTabs().map(({ rendered, ...def }) => def),
    activeTab: () => activeTab,

    registerAction,
    action: (name) => actions.get(name) || null,

    onEvent, emit,

    registerSticker,
    stickers: () => [...stickers.values()],
    registerItemRenderer,
    itemRenderer: (kind) => itemRenderers.get(kind) || null,
    registerHudWidget,
    hudWidgets: () => [...hudWidgets.values()],

    dialog: { open: dialogOpen, close: dialogClose, isOpen: dialogIsOpen, depth: () => dialogStack.length },

    // session.js installs `api`; until then a call fails loudly rather than silently.
    api: async () => { throw new Error('Nexus.api is not available: session.js did not load'); },
  };

  Object.defineProperty(Nexus, '_settleContent', {
    enumerable: false,
    value(content) {
      Nexus.content = content || null;
      settleContent(Nexus.content);
      if (Nexus.content) emit('content', Nexus.content);
    },
  });

  Object.defineProperty(window, 'Nexus', { value: Nexus, writable: false, configurable: false, enumerable: true });

  // Deprecated alias — one warning, then it just works.
  let warnedSwitchTab = false;
  Object.defineProperty(window, 'switchTab', {
    configurable: true,
    enumerable: false,
    get() {
      if (!warnedSwitchTab) {
        warnedSwitchTab = true;
        console.warn('[nexus] window.switchTab is deprecated; use Nexus.showTab(id)');
      }
      return showTab;
    },
    set() { console.warn('[nexus] window.switchTab is read-only; register tabs with Nexus.registerTab'); },
  });
})();
