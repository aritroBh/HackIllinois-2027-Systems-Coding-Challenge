/**
 * a11y — a text mirror of the 3D campus (plan C10).
 *
 * The WebGL viewport is a canvas. To a screen reader it is one image with a
 * label, so the gyms, HackStops and other trainers on it are unreachable and
 * "walk closer to spin" means nothing. This script keeps a visually hidden
 * region beside the canvas listing what is nearest, as real buttons carrying
 * the same `data-action` the map and the panels use. Pressing one is the same
 * event as clicking the monument, so nothing here forks the behaviour.
 *
 * Distances come from the renderer's player when one is placed. Without it
 * (lite mode, no WebGL2, the trainer not dropped yet) the lists still render,
 * ordered by name, and the summary says why there are no distances.
 *
 * The region is rebuilt at most once a second and only when its text actually
 * changed: an aria-live region that re-announces identical content on a timer
 * is worse than no region at all. It is revealed while keyboard focus is
 * inside it so a sighted keyboard user can see what they are on.
 *
 * Plain script (CSP: script-src 'self'); styles go through the CSSOM.
 */

(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[a11y] nexus.js must load first'); return; }

  const TICK_MS = 1000;
  const NEAR_M = 75;          // the spin geofence, matching PROX_RADIUS in game.js
  const PER_LIST = 5;

  const OFFSCREEN = { position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: '0', overflow: 'hidden', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: '0' };
  const REVEALED = { position: 'absolute', top: '18px', left: '18px', zIndex: '5', width: 'auto', height: 'auto', maxWidth: 'min(420px, 60%)', maxHeight: '80%', margin: '0', padding: '12px 14px', overflow: 'auto', clip: 'auto', clipPath: 'none', whiteSpace: 'normal', border: '2px solid var(--edge)', background: 'var(--panel)' };

  const state = { region: null, desc: null, live: null, lists: {}, sig: '', spoken: '', timer: null };

  const meters = (d) => (Number.isFinite(d) ? `${Math.round(d)} m` : 'distance unknown');
  const byDistance = (a, b) => (Number.isFinite(a.d) ? a.d : Infinity) - (Number.isFinite(b.d) ? b.d : Infinity) || String(a.name).localeCompare(String(b.name));

  /* ------------------------------------------------------------------ *
   * Reading the world
   * ------------------------------------------------------------------ */

  /**
   * The nearest gyms, HackStops and trainers. `d` is metres from the placed
   * player, or NaN when there is nobody to measure from.
   */
  function snapshot() {
    const player = window.campus?.getPlayer?.() || null;
    const mpu = window.campusMeta?.metersPerUnit || 10;
    const toWorld = typeof window.toWorld === 'function' ? window.toWorld : null;
    const fromLatLng = (lat, lng) => {
      if (!player || !toWorld || !Number.isFinite(lat)) return NaN;
      const w = toWorld(lat, lng);
      return Math.hypot(w.x - player.x, w.z - player.z) * mpu;
    };

    const gyms = (window.gymsCache || []).map((g) => ({
      name: g.name, faction: g.controllingFaction, d: fromLatLng(g.latitude, g.longitude),
      action: 'encounter', data: { id: String(g._id) },
    }));
    const stops = (window.hackStopsCache || []).map((s) => ({
      name: s.name, d: fromLatLng(s.latitude, s.longitude),
      action: 'spin', data: { beacon: String(s.beaconId), lat: String(s.latitude), lon: String(s.longitude) },
    }));
    const trainers = [...(N.presence?.state?.peers?.values?.() || [])].map((p) => ({
      name: p.name || 'Trainer', kind: p.kind, stale: p.stale,
      d: player ? Math.hypot(p.x - player.x, p.z - player.z) * mpu : NaN,
      action: 'player-card', data: { player: String(p.id) },
    }));

    const top = (list) => list.sort(byDistance).slice(0, PER_LIST);
    return { player: !!player, gyms: top(gyms), stops: top(stops), trainers: top(trainers) };
  }

  function describe(m) {
    const counts = `${m.gyms.length} gyms, ${m.stops.length} HackStops and ${m.trainers.length} trainers listed`;
    if (!m.player) return `Text mirror of the campus map: ${counts}. Distances need a placed trainer; use "Drop me on the Quad" or turn on "Walk with me".`;
    return `Text mirror of the campus map, nearest first: ${counts}. A HackStop can be spun from within ${NEAR_M} metres.`;
  }

  /** The one proximity sentence worth interrupting a reader for. */
  function proximity(m) {
    if (!m.player) return 'Trainer not placed, so nothing is measured yet.';
    const nearest = [...m.gyms, ...m.stops].sort(byDistance)[0];
    if (!nearest || !Number.isFinite(nearest.d)) return 'Nothing measurable nearby.';
    const where = nearest.action === 'spin' ? 'HackStop' : 'gym';
    return nearest.d <= NEAR_M
      ? `In range of the ${where} ${nearest.name}, ${meters(nearest.d)} away.`
      : `Nearest is the ${where} ${nearest.name}, ${meters(nearest.d)} away. Walk ${Math.round(nearest.d - NEAR_M)} metres closer to act on it.`;
  }

  /* ------------------------------------------------------------------ *
   * The region
   * ------------------------------------------------------------------ */

  function row(label, entry) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pb pb-sm';
    btn.dataset.action = entry.action;
    for (const [k, v] of Object.entries(entry.data)) btn.dataset[k] = v;
    // textContent, not innerHTML: gym and trainer names are user-supplied.
    btn.textContent = label;
    li.appendChild(btn);
    return li;
  }

  function build(viewport) {
    const region = document.createElement('div');
    region.id = 'sr-campus';
    region.setAttribute('role', 'group');
    region.setAttribute('aria-label', 'Campus map in text');
    Object.assign(region.style, OFFSCREEN);

    const desc = document.createElement('p');
    desc.id = 'sr-campus-desc';
    const live = document.createElement('p');
    live.id = 'sr-campus-live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    region.append(desc, live);

    const lists = {};
    for (const [key, heading] of [['gyms', 'Nearest gyms'], ['stops', 'Nearest HackStops'], ['trainers', 'Nearest trainers']]) {
      const h = document.createElement('h3');
      h.textContent = heading;
      const ul = document.createElement('ul');
      ul.id = `sr-campus-${key}`;
      region.append(h, ul);
      lists[key] = ul;
    }

    // Revealed on focus: a control a keyboard user can reach but not see is
    // its own accessibility bug.
    region.addEventListener('focusin', () => Object.assign(region.style, REVEALED));
    region.addEventListener('focusout', () => {
      if (!region.contains(document.activeElement)) Object.assign(region.style, OFFSCREEN);
    });

    viewport.appendChild(region);
    Object.assign(state, { region, desc, live, lists });

    for (const id of ['campus-3d-canvas', 'lite-map-canvas']) {
      document.getElementById(id)?.setAttribute('aria-describedby', desc.id);
    }
  }

  function render() {
    const m = snapshot();
    const line = proximity(m);
    const sig = JSON.stringify([describe(m), line,
      m.gyms.map((g) => [g.name, g.faction, Math.round(g.d) || 0]),
      m.stops.map((s) => [s.name, Math.round(s.d) || 0]),
      m.trainers.map((t) => [t.name, t.kind, t.stale, Math.round(t.d) || 0])]);
    if (sig === state.sig) return;
    state.sig = sig;

    state.desc.textContent = describe(m);
    if (line !== state.spoken) { state.spoken = line; state.live.textContent = line; }

    state.lists.gyms.replaceChildren(...m.gyms.map((g) => row(`${g.name}, held by ${String(g.faction || 'nobody').replace('TEAM_', 'Team ')}, ${meters(g.d)}`, g)));
    state.lists.stops.replaceChildren(...m.stops.map((s) => row(`${s.name}, ${meters(s.d)}${Number.isFinite(s.d) && s.d <= NEAR_M ? ', in range' : ''}`, s)));
    state.lists.trainers.replaceChildren(...m.trainers.map((t) => row(`${t.name}, ${t.kind === 'HACKER' ? 'hacker' : 'volunteer'}, ${meters(t.d)}${t.stale ? ', last seen a while ago' : ''}`, t)));
  }

  /* ------------------------------------------------------------------ *
   * Cadence
   * ------------------------------------------------------------------ */

  function tick() {
    if (document.hidden || !state.region) return;
    // A hidden tab panel is not announced, and the buttons in it would be a
    // trap in the tab order. Skip the work entirely.
    if (!document.getElementById('tab-campus')?.classList.contains('active')) return;
    try { render(); } catch (err) { console.error('[a11y] render threw:', err); }
  }

  function start() {
    const viewport = document.getElementById('campus-viewport');
    if (!viewport) { console.warn('[a11y] no #campus-viewport; the text mirror is not mounted'); return; }
    build(viewport);
    render();
    state.timer = setInterval(tick, TICK_MS);
    N.onEvent('tab', ({ id }) => { if (id === 'tab-campus') tick(); });
    // lite.js creates its canvas after this runs, so wire it when it appears.
    N.onEvent('lite', () => document.getElementById('lite-map-canvas')?.setAttribute('aria-describedby', 'sr-campus-desc'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  Object.defineProperty(N, 'a11y', {
    enumerable: true,
    value: { refresh: tick, snapshot, region: () => state.region },
  });
})();
