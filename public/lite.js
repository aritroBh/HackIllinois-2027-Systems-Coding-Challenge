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

  /** `geoError`: null | 'insecure' | 'denied' | 'timeout' | 'unavailable' — why there is no fix. */
  const state = { active: null, reason: '', panel: null, canvas: null, note: null, timer: null, sig: '', fix: null, geoWatch: null, geoError: null };

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
   * Where you are
   * ------------------------------------------------------------------ *
   *
   * `game.js` owns the GPS watch in 3D mode, but it gates starting one on
   * `window.campus.setPlayerLatLng` existing — so in lite mode there was no watch, no player
   * marker, and no distance to anything. The HackStop "Spin" buttons read those distances, so
   * a lite-mode user could see the stops and never reach one.
   *
   * This is a second watch rather than a refactor of the first because the two modes want
   * different things: `game.js` drives a camera and a sprite, this drives two numbers. Both
   * hand the fix to the same presence publisher, which is the only place that decides whether
   * a position is shared at all.
   *
   * They must not both be live, and nothing made that true on its own: entering lite mode does
   * not stop the renderer, so a user who was already walking and then chose the flat map had
   * two watches running and two publishers, of which `unmount()` stopped one. `startWatch()`
   * closes game.js's first.
   */

  // The radius a HackStop can be spun from. Read from `game.js` rather than copied, because
  // the readout down here and the Spin buttons over there have to agree about the same number
  // — one saying "in range" while the other stays disabled is the bug this whole branch
  // exists to fix. The literal is the fallback for game.js not having loaded.
  const proxRadius = () => window.game?.PROX_RADIUS ?? 75;

  /** Metres between two WGS84 points. Equirectangular; exact enough over one campus. */
  function metresBetween(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
    const y = (b.lat - a.lat) * rad;
    return Math.sqrt(x * x + y * y) * R;
  }

  function startWatch() {
    if (state.geoWatch != null || !navigator.geolocation) return;
    // The object exists on an insecure origin and every call fails, so an existence check is
    // not a secure-context check. Say which it is instead of waiting silently for ever.
    if (!window.isSecureContext) { state.geoError = 'insecure'; paintNearest(); return; }
    state.geoError = null;
    // See the note above: one watch at a time, and lite mode owns it while it is mounted.
    window.game?.stopWalk?.();
    state.geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        state.fix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        // The presence service decides whether to publish; the opt-in, the cadence and the
        // accuracy gate all live there, and none of them are this file's business.
        N.presence?.publish?.(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? 999, pos.coords.heading ?? undefined);
        paintNearest();
        // The Spin buttons are gated on distance and there is no renderer tick to re-gate
        // them, so this is the only thing that can. Without it a lite-mode player walks into
        // range, is told to spin, and the button stays disabled until they change tab.
        window.game?.gateSpins?.();
        draw(true);
      },
      // A refusal is an answer and still gets no toast — but it does now get a readout, and
      // only a refusal closes the watch. This ran `stopWatch()` on ANY error, so a single
      // timeout (routine indoors at `enableHighAccuracy` with a cold fix) permanently ended
      // the watch while the readout went on saying "Waiting for a location fix" — waiting on
      // something that had been cancelled.
      (err) => {
        state.fix = null;
        if (err && err.code === 1) { state.geoError = 'denied'; stopWatch(); }
        else state.geoError = err && err.code === 3 ? 'timeout' : 'unavailable';
        paintNearest();
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  function stopWatch() {
    if (state.geoWatch != null) navigator.geolocation?.clearWatch(state.geoWatch);
    state.geoWatch = null;
  }

  /**
   * Write the nearest-HackStop readout.
   *
   * Into `#hud-nearest`, the same box the 3D HUD uses, because it is the same fact in the same
   * place — `body.lite` keeps that corner visible for exactly this.
   *
   * `game.js`'s `updateHud()` writes the same element, and it is *not* driven only by the
   * render loop: `onTabChange` calls it on every switch to the Campus tab, and so do the
   * handover handler and the walk, follow and place actions. Any of those firing in lite mode
   * replaced this readout with "Place your trainer to start walking". `updateHud` now returns
   * early on `Nexus.flags.lite`, so while lite is mounted this file is the only writer.
   */
  function paintNearest() {
    const near = document.getElementById('hud-nearest');
    if (!near) return;
    const label = '<div class="hud-label">NEAREST HACKSTOP</div>';
    if (!state.fix) {
      const why = !navigator.geolocation ? 'This device has no location.'
        : state.geoError === 'insecure' ? 'Location needs a secure page (https, or localhost).'
          : state.geoError === 'denied' ? 'Location is off for this page. Turn it on in the address bar.'
            : state.geoError === 'timeout' ? 'Still looking for a location fix — this is slow indoors.'
              : state.geoError === 'unavailable' ? 'No location fix right now. Still trying.'
                : 'Waiting for a location fix.';
      near.innerHTML = `${label}<div class="near-dist"><span>${esc(why)}</span></div>`;
      return;
    }
    const stops = (window.hackStopsCache || []).filter((s) => Number.isFinite(s.latitude));
    if (!stops.length) {
      near.innerHTML = `${label}<div class="near-dist"><span>No beacons deployed yet.</span></div>`;
      return;
    }
    let best = null;
    for (const s of stops) {
      const d = metresBetween(state.fix, { lat: s.latitude, lng: s.longitude });
      if (!best || d < best.d) best = { d, name: s.name || 'HackStop' };
    }
    const d = Math.round(best.d);
    const segs = 8, on = Math.max(0, Math.min(segs, Math.round(segs * (1 - Math.min(1, d / 600)))));
    const bar = Array.from({ length: segs }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
    const prox = proxRadius();
    const hint = d <= prox ? 'in range — spin it!' : `walk ${d - prox} m closer to spin`;
    near.innerHTML = `${label}<div class="near-name">${esc(best.name)}</div>`
      + `<div class="near-dist"><b>${d} m</b><span>${hint}</span></div><div class="segbar">${bar}</div>`;
  }

  /** The names come from the API, and this writes into innerHTML. */
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    // The player is projected by the same call as everything else, so it lands in the same
    // frame. Appended here rather than added to `points()` so it stays out of the change
    // signature: that signature exists to skip repaints when the campus has not changed, and
    // a position that moves every second would defeat it. Movement repaints because the watch
    // callback calls `draw(true)`.
    const withMe = state.fix
      ? project([...list, { lat: state.fix.lat, lng: state.fix.lng, r: 4, color: '#FF5F05', name: null, me: true }], w, h)
      : project(list, w, h);
    for (const p of withMe) {
      if (p.me) {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.px - p.r, p.py - p.r, p.r * 2, p.r * 2);
        ctx.strokeStyle = '#FFF3E0'; ctx.lineWidth = 2;
        ctx.strokeRect(p.px - p.r - 2.5, p.py - p.r - 2.5, p.r * 2 + 5, p.r * 2 + 5);
        ctx.fillStyle = '#FFF3E0';
        ctx.fillText('YOU', p.px + p.r + 5, p.py + 3);
        continue;
      }
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
    startWatch();
    paintNearest();
    draw(true);
    if (!state.timer) state.timer = setInterval(() => { draw(); paintNearest(); }, REDRAW_MS);
  }

  function unmount() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    stopWatch();
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
      /**
       * The last device fix, as `{ latitude, longitude }`, or null.
       *
       * `app.js`'s `playerCoords()` reads this when the renderer is down, so a spin or a gym
       * contest in lite mode carries a real position rather than being refused. Shaped like
       * `fromWorld()`'s return value so that function needs no branch.
       */
      get fix() { return state.fix ? { latitude: state.fix.lat, longitude: state.fix.lng } : null; },
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
