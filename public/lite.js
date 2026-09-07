/**
 * lite — the flat campus surface, as an explicit choice.
 *
 * This file used to decide for you. It no longer does; see the note by the boot block.
 *
 * The WebGL campus bakes thousands of building footprints and then holds a render loop for as
 * long as the tab is open. On a weak device that is a real cost, and every other panel in the
 * war room is text and stays useful without it — so a flat 2D map exists as an alternative.
 *
 * What changed: this script used to *decide*, on Data Saver, on two gigabytes of reported
 * memory, or on a low battery. The battery rule was evaluated on every load and never recorded,
 * so a laptop on battery got the flat map every single time with no memory of having chosen it
 * — and because the panel mounted under the 3D HUD, the way back was invisible. That reads
 * exactly like the campus having been deleted, and it is the best thing here.
 *
 * Now it only ever raises `Nexus.flags.lite` and paints the flat map when somebody asks.
 *
 * The decision stays the user's. "Load 3D" clears the flag and boots the
 * renderer, and the answer is remembered under `nexus.lite.v1` so a reload does
 * not argue with it. `?lite` and `?lite=0` override that memory, which is what
 * a demo or a bug report needs. Other scripts should read `Nexus.flags.lite`
 * and listen on the `lite` channel rather than repeating the detection here.
 *
 * Loads before app.js: the flag has to exist before `bootCampus` reads it.
 * Plain script (CSP: script-src 'self'); styles go through the CSSOM, never an
 * injected <style> element or a style attribute.
 */

(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[lite] nexus.js must load first'); return; }

  const KEY = 'nexus.lite.v1';
  const REDRAW_MS = 2000;
  const QUERY = /(?:^|[?&])lite(?:=([^&]*))?(?=&|$)/;
  const FALLBACK_COLOR = { TEAM_KERNEL: '#22d3ee', TEAM_TENSOR: '#a78bfa', TEAM_SILICON: '#fbbf24', NEUTRAL: '#7c8daa' };

  // app.js declares `factionOf` with `const`, so it is a global lexical binding
  // and not a window property. `typeof` reads it safely once app.js has
  // evaluated, and is equally safe if app.js never loaded.
  const colorOf = (f) => (typeof factionOf === 'function' ? factionOf(f)?.color : null) || FALLBACK_COLOR[f] || FALLBACK_COLOR.NEUTRAL;

  const state = { active: null, reason: '', panel: null, canvas: null, note: null, timer: null, sig: '' };

  const readChoice = () => { try { const v = localStorage.getItem(KEY); return v === '1' ? true : v === '0' ? false : null; } catch { return null; } };
  const writeChoice = (on) => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ } };

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  /* ------------------------------------------------------------------ *
   * Deciding
   * ------------------------------------------------------------------ */

  function queryChoice() {
    const m = QUERY.exec(location.search);
    return m ? !(m[1] === '0' || m[1] === 'false') : null;
  }

  /*
   * There is no automatic downgrade any more, and that is a deliberate reversal.
   *
   * This file used to stand the 3D campus down on its own: Data Saver, a device reporting two
   * gigabytes or less, or a battery under the floor. The battery rule is the one that bit — it
   * is evaluated on every load and never recorded, so a laptop running on battery got the flat
   * map every single time, with no memory of having chosen anything and (because the panel
   * mounted *under* the 3D HUD) no visible way back. From the outside that is indistinguishable
   * from the 3D campus having been deleted.
   *
   * The campus is the thing worth showing. A guess about somebody's hardware is not a good
   * enough reason to hide it from them, and the renderer already has a real fallback for the
   * only case that genuinely cannot work: no WebGL2, which it detects and reports honestly.
   *
   * The flat map is still here and still good. It is now reached the way a preference should
   * be — `?lite` in the URL, or the toggle — and never by the page deciding for you.
   */

  function apply(on, reason) {
    state.reason = reason;
    if (state.active === on) return;
    state.active = on;
    N.flags.lite = on;
    N.emit('lite', { lite: on, reason });
    N.emit('flags', N.flags);
    whenReady(() => {
      document.body.classList.toggle('lite', on);
      if (on) mount(); else unmount();
    });
  }

  /* ------------------------------------------------------------------ *
   * The flat map
   * ------------------------------------------------------------------ */

  /** Gyms and HackStops as plottable points, plus a signature for change detection. */
  function points() {
    const list = [];
    for (const g of window.gymsCache || []) {
      if (Number.isFinite(g.latitude)) list.push({ lat: g.latitude, lng: g.longitude, r: 5, color: colorOf(g.controllingFaction), name: g.name });
    }
    for (const s of window.hackStopsCache || []) {
      if (Number.isFinite(s.latitude)) list.push({ lat: s.latitude, lng: s.longitude, r: 3, color: '#e9e3d3', name: null });
    }
    return { list, sig: list.map((p) => `${p.lat},${p.lng},${p.color}`).join('|') };
  }

  /** Fits the points to the canvas box with an equirectangular projection. */
  function project(list, w, h) {
    const pad = 24;
    const k = Math.cos((list[0].lat * Math.PI) / 180);
    const xs = list.map((p) => p.lng * k);
    const ys = list.map((p) => -p.lat);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const scale = Math.min((w - pad * 2) / Math.max(1e-9, x1 - x0), (h - pad * 2) / Math.max(1e-9, y1 - y0));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return list.map((p, i) => ({ ...p, px: w / 2 + (xs[i] - cx) * scale, py: h / 2 + (ys[i] - cy) * scale }));
  }

  function draw(force = false) {
    const canvas = state.canvas;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    if (box.width < 8) return;                       // the tab is hidden; nothing to paint
    // With the renderer up, its own minimap is the better picture and is
    // already in step with the camera.
    if (typeof window.campus?.renderMinimap === 'function') { window.campus.renderMinimap(canvas); return; }

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(box.width), h = Math.round(box.height);
    const resized = canvas.width !== w * dpr || canvas.height !== h * dpr;
    if (resized) { canvas.width = w * dpr; canvas.height = h * dpr; }

    const { list, sig } = points();
    if (!force && !resized && sig === state.sig) return;
    state.sig = sig;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1a33';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(233,227,211,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 32) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = 0; y <= h; y += 32) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();

    ctx.font = '11px "Courier New", monospace';
    if (list.length === 0) {
      ctx.fillStyle = 'rgba(233,227,211,0.6)';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for campus data…', w / 2, h / 2);
      return;
    }
    ctx.textAlign = 'left';
    for (const p of project(list, w, h)) {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.px - p.r, p.py - p.r, p.r * 2, p.r * 2);
      if (!p.name) continue;
      ctx.fillStyle = 'rgba(233,227,211,0.75)';
      ctx.fillText(String(p.name).slice(0, 22), p.px + p.r + 4, p.py + 3);
    }
  }

  /* ------------------------------------------------------------------ *
   * Mounting
   * ------------------------------------------------------------------ */

  const setDisplay = (node, value) => { if (node) node.style.display = value; };

  function el(tag, style, props) {
    const node = Object.assign(document.createElement(tag), props);
    Object.assign(node.style, style);
    return node;
  }

  function mount() {
    const viewport = document.getElementById('campus-viewport');
    if (!viewport) return;
    // `hidden` is not enough for either element: styles.css sets
    // `#campus-3d-canvas { display: block }` and the panel carries an inline
    // `display: grid`, and both outrank the UA rule behind the attribute.
    setDisplay(document.getElementById('campus-3d-canvas'), 'none');

    if (!state.panel) {
      // z-index 6 sits over the WebGL canvas **and** over the 3D HUD (4) and the corner frame
      // (3). It used to be 1, which put this panel under the HUD of the renderer it replaces —
      // including under its own "Load 3D" button, so the way back to the campus was drawn but
      // unclickable. `body.lite` hides that HUD as well, since half of it (FPS, building count,
      // the walk hint, the retro/cinematic toggles) describes a renderer that is not running.
      //
      // Set here rather than only in the stylesheet: this is an inline style, and an inline
      // style wins, so a `body.lite #lite-map { z-index: … }` rule could never have moved it.
      const panel = el('div', { position: 'absolute', inset: '0', zIndex: '6', display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: '8px', padding: '18px 18px 14px', background: '#0b1a33' }, { id: 'lite-map' });
      const label = el('div', {}, { className: 'hud-label', textContent: 'LOW-POWER MAP' });
      const canvas = el('canvas', { width: '100%', height: '100%', display: 'block' }, { id: 'lite-map-canvas' });
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Flat campus map showing gyms and HackStops');
      const foot = el('div', { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' });
      const note = el('p', { margin: '0', flex: '1 1 220px' }, { className: 'muted' });
      const load = el('button', {}, { type: 'button', className: 'pb pb-sm', textContent: 'Load 3D' });
      load.dataset.action = 'lite-3d';
      foot.append(note, load);
      panel.append(label, canvas, foot);
      viewport.appendChild(panel);
      state.panel = panel; state.canvas = canvas; state.note = note;
      window.addEventListener('resize', () => draw(true));
    }

    state.note.textContent = `The 3D campus is off because ${state.reason}. Every other panel is live.`;
    setDisplay(state.panel, 'grid');
    draw(true);
    if (!state.timer) state.timer = setInterval(() => draw(), REDRAW_MS);
  }

  function unmount() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    setDisplay(state.panel, 'none');
    setDisplay(document.getElementById('campus-3d-canvas'), 'block');
  }

  /**
   * app.js keeps `bootCampus` module-private and calls it from the Campus tab's
   * `onShow`. Re-showing the tab is the only handle another script has on it;
   * `Nexus.bootCampus` is preferred when app.js exposes one.
   */
  function boot3D() {
    if (window.campus) return;
    if (typeof N.bootCampus === 'function') N.bootCampus();
    else N.showTab('tab-campus');
  }

  // The panel has no box while its tab is hidden, so `draw` bails; repaint on
  // the way in rather than waiting out the interval.
  N.onEvent('tab', ({ id }) => { if (id === 'tab-campus' && state.active) draw(true); });

  N.registerAction('lite-3d', () => {
    writeChoice(false);
    apply(false, 'you asked for the 3D map');
    boot3D();
    window.game?.toast?.('Booting the 3D campus. Reload with ?lite for the flat map.');
  });

  // For a HUD button that goes back the other way; nothing renders one yet.
  N.registerAction('lite-toggle', () => {
    const on = !state.active;
    writeChoice(on);
    apply(on, on ? 'you chose low-power mode' : 'you asked for the 3D map');
    if (!on) boot3D();
  });

  Object.defineProperty(N, 'lite', {
    enumerable: true,
    value: {
      get active() { return !!state.active; },
      get reason() { return state.reason; },
      enable: (why = 'you chose low-power mode') => { writeChoice(true); apply(true, why); },
      disable: () => { writeChoice(false); apply(false, 'you asked for the 3D map'); boot3D(); },
      redraw: () => draw(true),
    },
  });

  const forced = queryChoice();
  const saved = readChoice();
  if (forced !== null) apply(forced, forced ? 'the ?lite flag is set' : 'the ?lite=0 flag is set');
  else if (saved === true) apply(true, 'you chose low-power mode');
  // Anything else boots the campus. `saved === false` needs no call: not applying is the 3D map.
})();
