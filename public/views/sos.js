/**
 * sos — the hacker's side of a distress call (plan §C6).
 *
 * One button, then a short form, then a status bar. The five pips are the lifecycle in
 * `src/models/sosTicket.model.ts`: OPEN, DISPATCHED, ACKNOWLEDGED, ON_SCENE, RESOLVED. They
 * advance on SSE events rather than on polling, so a hacker sees the responder move.
 *
 * Location is asked for once, at low accuracy: dispatch ranks responders by distance, and
 * ten metres of error changes nothing while a high-accuracy fix costs battery and takes
 * long enough that people abandon the form. The monument picker from the content pack is
 * the fallback, and it stays on screen either way so a bad fix can be corrected.
 *
 * Cancel is offered only while the ticket is OPEN, which is the server's rule: a button
 * that will be refused is worse than no button.
 *
 * Plain script (CSP: script-src 'self'). Everything injected into HTML is escaped.
 */

(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[sos] nexus.js must load first'); return; }

  const STORE_KEY = 'nexus.sos.ticket';

  /** SOSTicketCategory, ordered by how often a hacker reaches for each one. */
  const CATEGORIES = [
    { id: 'HARDWARE_MALFUNCTION', label: 'Hardware' }, { id: 'POWER_OUTAGE', label: 'Power' }, { id: 'LOGISTICS_SUPPLIES', label: 'Supplies' },
    { id: 'SPILL_CLEANUP', label: 'Spill' }, { id: 'MEDICAL_FIRST_AID', label: 'First aid' },
  ];

  const STAGES = [
    { id: 'OPEN', label: 'Filed' }, { id: 'DISPATCHED', label: 'Responder assigned' }, { id: 'ACKNOWLEDGED', label: 'On their way' },
    { id: 'ON_SCENE', label: 'With you' }, { id: 'RESOLVED', label: 'Resolved' },
  ];
  const LIVE = new Set(['OPEN', 'DISPATCHED', 'ACKNOWLEDGED', 'ON_SCENE']);
  const stageIndex = (status) => STAGES.findIndex((s) => s.id === status);

  const GEO_TEXT = {
    idle: 'Location not set yet.',
    locating: 'Finding you…',
    ok: 'Got your position. Pick a landmark below to override it.',
    denied: 'No position from this device. Pick the nearest landmark below.',
    unavailable: 'This browser has no location. Pick the nearest landmark below.',
  };

  const state = {
    host: null,          // #sos-body: the one node every view is painted into
    view: 'idle',        // idle | form | live
    ticket: null,        // { id, hackerName, status, category, tableLocation }
    category: CATEGORIES[0].id,
    coords: null, geo: 'idle',  // geo is a key of GEO_TEXT
    cooldown: null,      // { until, timer } while the server is answering 429
    busy: false,
  };

  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const sameId = (a, b) => !!a && !!b && String(a) === String(b);
  const me = () => N.session.user;
  const setError = (msg) => { const el = document.getElementById('sos-error'); if (el) el.textContent = msg || ''; };

  // A hacker cannot read GET /sos/tickets — it is staff-only, because it carries every
  // other hacker's location — so a reload has nothing to ask the server for. The last
  // ticket is kept here and re-hydrated by the SSE events that follow it.
  function remember(ticket) {
    try {
      // Stamped with the account that raised it. The record is a seat number and a name, on
      // a laptop other people sit at, and it survives everything a browser does short of
      // clearing storage — so it has to say whose it is and be refused when it is not the
      // reader's. `session.js` clears it on sign-out and on a change of account; this is the
      // belt to that pair of braces, for the tab that is simply left open.
      if (ticket) localStorage.setItem(STORE_KEY, JSON.stringify({ ...ticket, ownerId: me()?.id ? String(me().id) : null }));
      else localStorage.removeItem(STORE_KEY);
    } catch { /* private mode: the tab works, it just forgets on reload */ }
  }

  function recall() {
    try {
      const held = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!held || typeof held.id !== 'string') return null;
      // Somebody else's call, or one from before the stamp existed: forget it rather than
      // show it. Losing your own live ticket across an upgrade costs one refresh; showing a
      // stranger where a person in distress is sitting costs rather more.
      const mine = me()?.id ? String(me().id) : null;
      if (!held.ownerId || !mine || held.ownerId !== mine) {
        localStorage.removeItem(STORE_KEY);
        return null;
      }
      return held;
    } catch { return null; }
  }

  /** Monuments that resolve to a point, falling back to the pack's venues. */
  function places() {
    const content = N.content || {};
    const venues = content.venues || {};
    const point = (v) => (v ? { latitude: v.latitude, longitude: v.longitude } : null);
    const marked = (content.monuments || []).map((m) => {
      const coords = Array.isArray(m.at) ? { latitude: m.at[0], longitude: m.at[1] } : point(venues[m.venueKey]);
      return coords ? { id: m.id, label: m.name || m.short || m.id, coords } : null;
    }).filter(Boolean);
    return marked.length ? marked : Object.entries(venues).map(([key, v]) => ({ id: key, label: v.name || key, coords: point(v) }));
  }

  const paintGeo = () => { const el = document.getElementById('sos-geo'); if (el) el.textContent = GEO_TEXT[state.geo] || GEO_TEXT.idle; };

  function locate() {
    if (!navigator.geolocation) { state.geo = 'unavailable'; paintGeo(); return; }
    state.geo = 'locating';
    paintGeo();
    navigator.geolocation.getCurrentPosition(
      (pos) => { state.coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }; state.geo = 'ok'; paintGeo(); },
      () => { state.geo = 'denied'; paintGeo(); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  const idleHtml = () => `<div class="empty-state">
        <p>A dead power strip, a spill, a soldering iron that stopped, or a medical problem. File one and the nearest qualified volunteer is sent to you.</p>
        <button class="pb pb-danger" data-action="sos-open">I need help</button>
      </div>`;

  function formHtml() {
    const chips = CATEGORIES.map((c) => `<button type="button" class="pb pb-ghost pb-sm" data-action="sos-category" data-cat="${esc(c.id)}" aria-pressed="${c.id === state.category}">${esc(c.label)}</button>`).join('');
    const options = places().map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
    return `<form id="sos-form" novalidate>
        <div class="eyebrow">What is wrong</div>
        <div class="btn-row" id="sos-cats">${chips}</div>
        <label class="eyebrow" for="sos-table">Where you are sitting</label>
        <input class="px-input" id="sos-table" maxlength="80" autocomplete="off" placeholder="Table 42, second floor">
        <label class="eyebrow" for="sos-desc">What you need</label>
        <textarea class="px-input" id="sos-desc" rows="3" maxlength="400" placeholder="Our whole row lost power about ten minutes ago."></textarea>
        <div class="eyebrow">Position</div>
        <p id="sos-geo">${esc(GEO_TEXT[state.geo])}</p>
        <select class="pb pb-ghost" id="sos-place" aria-label="Nearest landmark">
          <option value="">Nearest landmark…</option>${options}
        </select>
        <p id="sos-error" role="alert"></p>
        <div class="btn-row">
          <button class="pb pb-danger" type="submit" id="sos-send">Send it</button>
          <button class="pb pb-ghost" type="button" data-action="sos-abandon">Never mind</button>
        </div>
      </form>`;
  }

  function liveHtml() {
    const t = state.ticket || {};
    const cancelled = t.status === 'CANCELLED';
    const reached = cancelled ? -1 : stageIndex(t.status);
    const pips = STAGES.map((s, i) => `<li class="sos-pip" data-on="${i <= reached ? '1' : '0'}"${i === reached ? ' aria-current="step"' : ''}><span class="sos-pip-dot"></span><span class="sos-pip-label">${esc(s.label)}</span></li>`).join('');
    const category = CATEGORIES.find((c) => c.id === t.category)?.label || t.category || 'Help';
    return `<div class="panel-head">
        <div><div class="eyebrow">${esc(category)}</div>
        <h3>${cancelled ? 'Cancelled' : esc(STAGES[Math.max(reached, 0)].label)}</h3></div>
        <span class="sticker flat">${esc(t.tableLocation || '')}</span>
      </div>
      <ol class="sos-pips" aria-label="Ticket progress">${pips}</ol>
      <p id="sos-error" role="alert"></p>
      <div class="btn-row">
        ${t.status === 'OPEN' ? '<button class="pb pb-ghost" data-action="sos-cancel">Cancel this call</button>' : ''}
        ${LIVE.has(t.status) ? '' : '<button class="pb pb-ghost" data-action="sos-clear">Clear</button>'}
      </div>`;
  }

  function show(view) {
    state.view = view;
    if (!state.host) return;
    state.host.innerHTML = view === 'form' ? formHtml() : view === 'live' ? liveHtml() : idleHtml();
    if (view !== 'form') return;
    locate();
    document.getElementById('sos-table')?.focus();
  }

  // `Nexus.api` hands back the parsed envelope, not the response headers, so the wait is
  // read from the limiter's own message ("Try again in 60s.") and falls back to a minute.
  function retryAfterSeconds(err) {
    const m = /(\d+)\s*s/.exec(String(err?.body?.message || err?.message || ''));
    return Math.min(Math.max(m ? Number(m[1]) : 60, 1), 600);
  }

  function startCooldown(seconds) {
    if (state.cooldown) clearInterval(state.cooldown.timer);
    const until = Date.now() + seconds * 1000;
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      const send = document.getElementById('sos-send');
      if (left > 0) {
        if (send) { send.disabled = true; send.textContent = `Wait ${left}s`; }
        setError(`Too many calls from this account. You can send again in ${left}s.`);
        return;
      }
      clearInterval(state.cooldown.timer);
      state.cooldown = null;
      if (send) { send.disabled = false; send.textContent = 'Send it'; }
      setError('');
    };
    state.cooldown = { until, timer: setInterval(tick, 1000) };
    tick();
  }

  N.registerAction('sos-open', () => show('form'));
  N.registerAction('sos-abandon', () => show(state.ticket ? 'live' : 'idle'));
  N.registerAction('sos-clear', () => { state.ticket = null; remember(null); show('idle'); });

  N.registerAction('sos-category', (el) => {
    state.category = el.dataset.cat || state.category;
    document.querySelectorAll('#sos-cats [data-action="sos-category"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cat === state.category)));
  });

  N.registerAction('sos-cancel', async (el) => {
    if (state.busy || !state.ticket) return;
    state.busy = true;
    el.disabled = true;
    try {
      const { data } = await N.api(`/api/v1/sos/tickets/${encodeURIComponent(state.ticket.id)}/cancel`, { method: 'POST', body: {} });
      applyStatus(data?.status || 'CANCELLED');
    } catch (err) {
      el.disabled = false;
      setError(err.status === 409 ? 'A volunteer already took this one, so it can no longer be cancelled.' : err.message);
    } finally { state.busy = false; }
  });

  async function submit(event) {
    event.preventDefault();
    if (state.busy || state.cooldown) return;
    const table = document.getElementById('sos-table')?.value.trim() || '';
    const description = document.getElementById('sos-desc')?.value.trim() || '';
    if (!table) { setError('Tell the responder where to walk to.'); return; }
    if (description.length < 3) { setError('A few words about what you need, so the right person is sent.'); return; }
    if (!state.coords) { setError('Pick the nearest landmark so dispatch knows where you are.'); return; }

    state.busy = true;
    setError('');
    try {
      const body = { hackerName: me()?.displayName || 'A hacker', tableLocation: table, coordinates: state.coords, category: state.category, description };
      const { data } = await N.api('/api/v1/sos/tickets', { method: 'POST', body });
      state.ticket = {
        id: String(data?._id || data?.id || ''), hackerName: data?.hackerName || body.hackerName,
        status: data?.status || 'OPEN', category: data?.category || state.category, tableLocation: data?.tableLocation || table,
      };
      remember(state.ticket);
      show('live');
    } catch (err) {
      if (err.status === 429) startCooldown(retryAfterSeconds(err));
      else setError(err.message || 'That did not send. Try again.');
    } finally { state.busy = false; }
  }

  function applyStatus(status) {
    if (!state.ticket || !status || status === state.ticket.status) return;
    state.ticket.status = status;
    remember(LIVE.has(status) ? state.ticket : null);
    if (state.view !== 'form') show('live');
  }

  const STATUS_OF = { CREATED: 'OPEN', OPEN: 'OPEN', DISPATCHED: 'DISPATCHED', ACKNOWLEDGED: 'ACKNOWLEDGED', ON_SCENE: 'ON_SCENE', RESOLVED: 'RESOLVED', CANCELLED: 'CANCELLED' };

  for (const suffix of Object.keys(STATUS_OF)) {
    N.onEvent(`SOS_TICKET_${suffix}`, (payload) => {
      const id = payload?.ticketId || payload?.ticket?._id || payload?._id;
      if (!state.ticket || !sameId(id, state.ticket.id)) return;
      applyStatus(payload?.status || payload?.ticket?.status || STATUS_OF[suffix]);
    });
  }

  // Staff accounts can read the ticket list, so for them the server is the truth. For a
  // hacker the endpoint is forbidden and the remembered ticket stands in.
  async function restore(user) {
    const held = recall();
    if (held) state.ticket = held;
    try {
      const { data } = await N.api('/api/v1/sos/tickets');
      const mine = (Array.isArray(data) ? data : [])
        .filter((t) => LIVE.has(t.status) && (sameId(t.createdById, user.id) || (held && sameId(t._id, held.id)) || t.hackerName === user.displayName))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const t = mine[0];
      state.ticket = t ? { id: String(t._id), hackerName: t.hackerName, status: t.status, category: t.category, tableLocation: t.tableLocation } : null;
      remember(state.ticket);
    } catch (err) {
      if (err.status !== 401 && err.status !== 403) console.debug('[sos] ticket list unavailable:', err.message);
    }
    show(state.ticket ? 'live' : 'idle');
  }

  N.registerTab({
    id: 'tab-sos', label: 'SOS', order: 1, roles: ['HACKER'],
    render(section) {
      section.innerHTML = `<div class="view-head"><div>
          <div class="eyebrow">Help</div>
          <h2>Call for a volunteer</h2>
          <p>The nearest qualified volunteer is sent to you, and you can watch them arrive.</p>
        </div></div>
        <div class="px" id="sos-body"></div>`;
      state.host = section.querySelector('#sos-body');
      section.addEventListener('submit', (e) => { if (e.target.id === 'sos-form') submit(e); });
      section.addEventListener('change', (e) => {
        const pick = e.target.id === 'sos-place' ? places().find((p) => p.id === e.target.value) : null;
        if (!pick) return;
        state.coords = pick.coords;
        state.geo = 'ok';
        paintGeo();
      });
      show(state.ticket ? 'live' : 'idle');
    },
  });

  // The same gate the tab uses, so nothing is fetched for an account that cannot see it.
  N.onEvent('session:ready', ({ user }) => { if (user && (user.role === 'HACKER' || user.kind === 'HACKER')) void restore(user); });
})();
