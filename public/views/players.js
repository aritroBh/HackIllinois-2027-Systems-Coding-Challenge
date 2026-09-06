/**
 * players — live multiplayer presence in the browser (plan §C7).
 *
 * Opens `wss://<host>/ws/presence` with the CSRF nonce as the `nexus.v1.<nonce>`
 * subprotocol; the browser attaches the HttpOnly session cookie itself, so no credential
 * ever appears in a URL. After two failed attempts it falls back to the SSE `presence`
 * channel plus `POST /api/v1/presence`, which carries the same rows as JSON.
 *
 * Outbound: a `pos` frame when the player has moved 10 m or five seconds have passed, and
 * only while they are actually walking. Inbound: snapshots and deltas of everyone within
 * 300 m, plus cluster counts beyond that, fed straight into `campus.setPlayers`.
 *
 * Privacy is symmetric and opt-in. While `presenceOptIn` is false the client neither
 * publishes nor receives, and the server enforces the same rule — the toggle in Me →
 * Settings is the only way in.
 */
(function () {
  const N = window.Nexus;
  if (!N) { console.error('[players] nexus.js must load first'); return; }

  const WS_PATH = '/ws/presence';
  const SEND_INTERVAL_MS = 5000;
  const SEND_DISTANCE_M = 10;
  const MAX_WS_FAILURES = 2;
  const BACKOFF_MIN_MS = 1000;
  const BACKOFF_MAX_MS = 30000;

  const state = {
    ws: null,
    mode: 'off',            // off | ws | sse
    failures: 0,
    backoff: BACKOFF_MIN_MS,
    reconnectTimer: null,
    optIn: false,
    enc: 'json',
    metersPerUnit: 10,
    factions: ['NEUTRAL'],
    /** idx → { id, name, faction, avatarHash, kind } from join records. */
    slots: new Map(),
    /** id → row */
    peers: new Map(),
    clusters: [],
    lastSent: 0,
    lastSentLatLng: null,
    lastFrameAt: 0,
    tick: 0,
    serverTimeSkew: 0,
    pendingBinaryHeader: null,
    avatarsWanted: new Set(),
  };

  const api = { state };
  N.presence = api;

  /* ------------------------------------------------------------------ *
   * Wire decoding — mirrors src/presence/protocol.ts
   * ------------------------------------------------------------------ */

  const HEADER_BYTES = 7;
  const ROW_BYTES = 8;
  const UNIT_PER_METRE = 5;

  function decodeRows(buffer) {
    const dv = new DataView(buffer);
    const kind = dv.getUint8(0);
    const tick = dv.getUint32(1, true);
    const n = dv.getUint16(5, true);
    const rows = [];
    let o = HEADER_BYTES;
    const scale = state.metersPerUnit * UNIT_PER_METRE;
    for (let i = 0; i < n; i++) {
      const flags = dv.getUint8(o + 7);
      rows.push({
        idx: dv.getUint16(o, true),
        x: dv.getInt16(o + 2, true) / scale,
        z: dv.getInt16(o + 4, true) / scale,
        h: (dv.getUint8(o + 6) / 255) * 360,
        faction: flags & 7,
        stale: !!(flags & 8),
        kind: flags & 16 ? 'HACKER' : 'VOLUNTEER',
      });
      o += ROW_BYTES;
    }
    return { kind, tick, rows };
  }

  const jsonRow = (r) => ({ idx: r[0], x: r[1], z: r[2], h: r[3], faction: r[4], stale: !!r[5] });

  /* ------------------------------------------------------------------ *
   * Applying frames
   * ------------------------------------------------------------------ */

  function applyJoins(joins) {
    for (const j of joins) {
      state.slots.set(j.idx, { id: j.id, name: j.name, faction: j.faction, avatarHash: j.avatarHash, kind: j.kind });
      if (j.avatarHash) wantAvatar(j.avatarHash);
    }
  }

  function applyRows(rows, full) {
    if (full) state.peers.clear();
    let unknown = 0;
    for (const r of rows) {
      const meta = state.slots.get(r.idx);
      if (!meta) { unknown += 1; continue; }
      state.peers.set(meta.id, {
        id: meta.id, name: meta.name, kind: meta.kind, avatarHash: meta.avatarHash,
        faction: meta.faction ?? state.factions[r.faction] ?? 'NEUTRAL',
        x: r.x, z: r.z, h: r.h, stale: r.stale,
      });
    }
    // A row for an idx we were never told about means we dropped a join; ask for a rebind
    // rather than drawing an anonymous sprite.
    if (unknown) send({ t: 'resync' });
  }

  function applyExpire(ids) {
    for (const idx of ids) {
      const meta = state.slots.get(idx);
      if (meta) state.peers.delete(meta.id);
      state.slots.delete(idx);
    }
  }

  function pushToMap() {
    const campus = window.campus;
    if (!campus || typeof campus.setPlayers !== 'function') return;
    campus.setPlayers([...state.peers.values()]);
    N.emit('presence:players', { players: [...state.peers.values()], clusters: state.clusters });
    renderNearby();
  }

  function handleFrame(msg) {
    state.lastFrameAt = Date.now();
    switch (msg.t) {
      case 'hello_ack':
        state.tick = msg.tick ?? 0;
        state.enc = msg.enc || 'json';
        state.metersPerUnit = msg.metersPerUnit || state.metersPerUnit;
        state.factions = Array.isArray(msg.factions) && msg.factions.length ? msg.factions : state.factions;
        state.serverTimeSkew = (msg.serverTime || Date.now()) - Date.now();
        state.optIn = !!msg.you?.optIn;
        N.emit('presence:ready', { you: msg.you, interestM: msg.interestM, fuzz: msg.fuzz, mode: msg.mode });
        paintChip();
        break;
      case 'snapshot':
      case 'delta':
        state.tick = msg.tick ?? state.tick;
        if (msg.j) applyJoins(msg.j);
        if (msg.c) state.clusters = msg.c;
        if (msg.p) { applyRows(msg.p.map(jsonRow), msg.t === 'snapshot'); pushToMap(); }
        else if (state.enc === 'bin') state.pendingBinaryHeader = msg; // rows arrive next, as one binary frame
        else pushToMap();
        break;
      case 'expire':
        applyExpire(msg.ids || []);
        pushToMap();
        break;
      case 'notice':
        N.emit('presence:mode', { mode: msg.mode });
        break;
      case 'nack':
        if (msg.reason === 'OPT_OUT') { state.optIn = false; paintChip(); }
        N.emit('presence:nack', { reason: msg.reason });
        break;
      default:
        break;
    }
  }

  function handleBinary(buffer) {
    const { kind, tick, rows } = decodeRows(buffer);
    state.tick = tick;
    applyRows(rows, kind === 1);
    state.pendingBinaryHeader = null;
    pushToMap();
  }

  /* ------------------------------------------------------------------ *
   * Avatars
   * ------------------------------------------------------------------ */

  async function wantAvatar(hash) {
    if (!hash || state.avatarsWanted.has(hash)) return;
    if (window.campus?.hasAvatar?.(hash)) return;
    state.avatarsWanted.add(hash);
    try {
      const res = await fetch(`/api/v1/avatars/${encodeURIComponent(hash)}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      window.campus?.registerAvatar?.(hash, bitmap);
    } catch (err) {
      console.debug('[players] avatar fetch failed', err.message);
    } finally {
      state.avatarsWanted.delete(hash);
    }
  }

  // A takedown evicts the texture everywhere it is cached.
  N.onEvent('AVATAR_UNPUBLISHED', (data) => {
    if (data?.hash) window.campus?.forgetAvatar?.(data.hash);
  });

  /* ------------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------------ */

  function csrfNonce() {
    const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?nexus_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function send(msg) {
    if (state.mode === 'ws' && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function connectWs() {
    const nonce = csrfNonce();
    if (!nonce) return false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`, [`nexus.v1.${nonce}`]);
    } catch (err) {
      console.debug('[players] ws construct failed', err.message);
      return false;
    }
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      state.mode = 'ws';
      state.failures = 0;
      state.backoff = BACKOFF_MIN_MS;
      ws.send(JSON.stringify({ t: 'hello', v: 1, enc: 'bin' }));
      N.emit('presence:transport', { mode: 'ws' });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') handleFrame(JSON.parse(ev.data));
      else handleBinary(ev.data);
    };
    ws.onclose = () => {
      state.ws = null;
      if (state.mode === 'ws') state.mode = 'off';
      state.failures += 1;
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
    return true;
  }

  function scheduleReconnect() {
    if (!state.optIn || state.reconnectTimer) return;
    // Two WebSocket failures and we stop fighting the network: the SSE leg carries the
    // same rows, just fewer of them.
    if (state.failures >= MAX_WS_FAILURES) { startSse(); return; }
    const jitter = state.backoff * (0.5 + Math.random());
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectWs();
    }, jitter);
    state.backoff = Math.min(state.backoff * 2, BACKOFF_MAX_MS);
  }

  function startSse() {
    if (state.mode === 'sse') return;
    state.mode = 'sse';
    N.emit('presence:transport', { mode: 'sse' });
    // The dashboard's existing SSE stream carries the frames; app.js subscribes to the
    // `presence` channel and re-emits them as PRESENCE_FRAME.
    N.onEvent('PRESENCE_FRAME', (data) => handleFrame(data));
  }

  async function postPosition(lat, lng, acc, heading) {
    try {
      await N.api('/api/v1/presence', { method: 'POST', body: { lat, lng, acc, h: heading }, lenient: true });
    } catch (err) {
      console.debug('[players] presence post failed', err.message);
    }
  }

  /* ------------------------------------------------------------------ *
   * Publishing our own position
   * ------------------------------------------------------------------ */

  function metresBetween(a, b) {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const la = (a.lat * Math.PI) / 180, lb = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Called by game.js on every GPS fix while "Walk with me" is on. */
  api.publish = function publish(lat, lng, acc, heading) {
    if (!state.optIn) return false;
    const now = Date.now();
    const here = { lat, lng };
    const moved = state.lastSentLatLng ? metresBetween(state.lastSentLatLng, here) : Infinity;
    if (moved < SEND_DISTANCE_M && now - state.lastSent < SEND_INTERVAL_MS) return false;
    state.lastSent = now;
    state.lastSentLatLng = here;
    if (state.mode === 'ws') {
      return send({ t: 'pos', lat, lng, acc, h: heading });
    }
    if (state.mode === 'sse') {
      void postPosition(lat, lng, acc, heading);
      return true;
    }
    return false;
  };

  /* ------------------------------------------------------------------ *
   * Opt-in
   * ------------------------------------------------------------------ */

  api.setOptIn = async function setOptIn(on) {
    const res = await N.api('/api/v1/me/presence', { method: 'PATCH', body: { optIn: !!on } });
    state.optIn = !!res.data?.presenceOptIn;
    paintChip();
    if (state.optIn) api.start();
    else api.stop();
    return state.optIn;
  };

  api.start = function start() {
    if (!state.optIn || state.mode !== 'off') return false;
    state.failures = 0;
    return connectWs();
  };

  api.stop = function stop() {
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    if (state.ws) { try { state.ws.send(JSON.stringify({ t: 'bye' })); state.ws.close(1000, 'opt out'); } catch { /* closing */ } }
    state.ws = null;
    state.mode = 'off';
    state.peers.clear();
    state.slots.clear();
    state.clusters = [];
    pushToMap();
    void N.api('/api/v1/presence', { method: 'DELETE', lenient: true });
    N.emit('presence:transport', { mode: 'off' });
  };

  /* ------------------------------------------------------------------ *
   * UI: the nearby list, the player card and the privacy chip
   * ------------------------------------------------------------------ */

  function renderNearby() {
    const host = document.getElementById('nearby-list');
    if (!host) return;
    const me = window.campus?.getPlayer?.();
    const rows = [...state.peers.values()]
      .map((p) => ({ ...p, d: me ? Math.hypot(p.x - me.x, p.z - me.z) * state.metersPerUnit : Infinity }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 12);
    const total = state.peers.size + state.clusters.reduce((s, c) => s + c[2], 0);
    if (!rows.length) {
      host.innerHTML = `<div class="empty-state">${state.optIn ? 'Nobody nearby yet.' : 'Presence is off. Turn it on in Me → Settings to see other trainers.'}</div>`;
      return;
    }
    host.innerHTML = `<div class="nearby-head"><b>${total}</b> trainer${total === 1 ? '' : 's'} on campus</div>` +
      rows.map((p) => `
        <button class="nearby-row" type="button" data-action="player-card" data-player="${esc(p.id)}">
          <span class="nearby-dot" data-faction="${esc(p.faction || 'NEUTRAL')}"></span>
          <span class="nearby-name">${esc(p.name || 'Trainer')}</span>
          <span class="nearby-kind">${p.kind === 'HACKER' ? 'hacker' : 'volunteer'}</span>
          <span class="nearby-dist">${Number.isFinite(p.d) ? `${Math.round(p.d)} m` : ''}${p.stale ? ' · stale' : ''}</span>
        </button>`).join('');
  }

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function paintChip() {
    const el = document.getElementById('presence-chip');
    if (!el) return;
    el.textContent = state.optIn ? (state.mode === 'off' ? 'Presence connecting…' : `Visible · ${state.mode.toUpperCase()}`) : 'Presence off';
    el.dataset.on = state.optIn ? '1' : '0';
    const toggle = document.getElementById('pref-visible');
    if (toggle) toggle.checked = state.optIn;
  }

  N.registerAction('player-card', (el) => {
    const id = el?.dataset?.player;
    const p = id && state.peers.get(id);
    if (!p) return;
    N.emit('presence:card', { player: p });
    window.game?.toast?.(`${p.name || 'Trainer'} · ${p.kind === 'HACKER' ? 'hacker' : 'volunteer'}${p.stale ? ' · last seen a while ago' : ''}`);
  });

  N.registerAction('presence-toggle', async () => {
    try {
      await api.setOptIn(!state.optIn);
      window.game?.toast?.(state.optIn
        ? 'You are on the map. Other trainers can see you, and you can see them.'
        : 'Hidden. You do not appear, and other trainers do not appear to you.');
    } catch (err) {
      window.game?.toast?.(`Could not change that: ${err.message}`);
    }
  });

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  N.onEvent('session:ready', async ({ user }) => {
    if (!user) return;
    state.optIn = !!user.presenceOptIn;
    // Faction colours so remote pills and clusters match the map.
    try {
      const factions = N.content?.factions || [];
      const map = {};
      for (const f of factions) map[f.id] = f.color;
      window.campus?.setFactionColours?.(map);
      if (factions.length) state.factions = ['NEUTRAL', ...factions.map((f) => f.id).filter((f) => f !== 'NEUTRAL')];
    } catch { /* the pack may not have loaded yet */ }
    paintChip();
    if (state.optIn) api.start();
    renderNearby();
  });

  window.addEventListener('beforeunload', () => { if (state.ws) try { state.ws.close(1001, 'unload'); } catch { /* gone */ } });
})();
