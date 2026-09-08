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
    denied: 'Location is off for this page. Pick the nearest landmark below.',
    unavailable: 'This browser has no location. Pick the nearest landmark below.',
    // An insecure origin is not a missing API and not a refusal: the call fails no matter
    // what the person does in site settings, so sending them there wastes time in the one
    // flow where time is the point.
    insecure: 'Location needs a secure page (https, or localhost). Pick the nearest landmark below.',
    timeout: 'Still looking for your position. Pick the nearest landmark below.',
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
    if (!window.isSecureContext) { state.geo = 'insecure'; paintGeo(); return; }
    state.geo = 'locating';
    paintGeo();
    navigator.geolocation.getCurrentPosition(
      (pos) => { state.coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude }; state.geo = 'ok'; paintGeo(); },
      // Every failure read "denied", including a timeout, which sent people to check a
      // permission they had already granted. The landmark picker below is the real fallback
      // in all three cases, so each one names itself and points at the same next step.
      (err) => { state.geo = err && err.code === 1 ? 'denied' : err && err.code === 3 ? 'timeout' : 'unavailable'; paintGeo(); },
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
        ${LIVE.has(t.status)
          // An escape from a live stage, always. Cancelling is refused once somebody has been
          // dispatched — correctly, because a responder is walking towards you — but that left
          // a DISPATCHED ticket with no button at all, and a ticket that had quietly finished
          // server-side while the tab was shut could never be dismissed. This does not touch
          // the ticket; it stops this browser showing it. `GET /me/sos` reconciles on the next
          // load, so an actually-live call comes straight back.
          ? '<button class="pb pb-ghost" data-action="sos-clear" title="Stops showing it here. The call itself is unaffected.">Hide this</button>'
          : '<button class="pb pb-ghost" data-action="sos-clear">Clear</button>'}
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

  /**
   * The remembered ticket, reconciled against the server.
   *
   * `GET /me/sos` is the hacker-readable "my ticket" endpoint, and it answers with the
   * caller's own live call or `null`. That `null` is the important half: it is what unsticks
   * a device holding a ticket that finished while the tab was shut.
   *
   * Only hackers reach this. `/sos/tickets` — the staff list this used to try, and always be
   * refused from — is not consulted at all any more, and nothing here matches on a display
   * name: the server decides whose ticket this is from the session, which is the only party
   * that can.
   */
  async function restore(user) {
    const held = recall();
    if (held) state.ticket = held;
    void user;
    try {
      // The server is the truth, and `GET /me/sos` is where a hacker can finally ask it.
      //
      // The remembered ticket is a starting point, not an answer. A ticket resolved or
      // cancelled while the tab was closed left it stuck at DISPATCHED — a state with no
      // Cancel (only OPEN may cancel) and no Clear (only a settled ticket may be cleared) —
      // and no SSE would ever arrive for a call that had already finished. The result was a
      // hacker with no button, unable to raise another call from that device for the rest of
      // the event. A `null` here is the answer that unsticks them.
      const { data } = await N.api('/api/v1/me/sos');
      state.ticket = data
        ? { id: String(data.id), hackerName: data.hackerName, status: data.status, category: data.category, tableLocation: data.tableLocation }
        : null;
      remember(state.ticket);
    } catch (err) {
      // Offline or signed out: keep what was remembered rather than blanking a live call,
      // and let the escape hatch in `liveHtml` cover the case where it is stale.
      if (err.status !== 401 && err.status !== 403) console.debug('[sos] own ticket unavailable:', err.message);
    }
    show(state.ticket ? 'live' : 'idle');
  }

  // The browser changed hands without a sign-out. `session.js` has cleared the stored ticket
  // by now; this drops the copy held in memory, which is the one on the screen. Without it
  // the next person sits down looking at a stranger's live distress call, seat number and
  // all, with a Cancel button under it.
  /** The tab is HACKER-only, and so is the reconcile: a volunteer has the lead queue instead. */
  const isHacker = (user) => !!user && (user.role === 'HACKER' || user.kind === 'HACKER');

  N.onEvent('session:handover', (user) => {
    state.ticket = null;
    // The previous occupant's GPS fix and their rate-limit, both of which outlive the
    // ticket. A fix left behind is the worse of the two: the new user taps "I need help",
    // fills the form faster than the browser returns a position, and the call goes out with
    // somebody else's seat on it — so dispatch ranks responders against the wrong table
    // while the person who needs help waits. The cooldown is only unfair.
    state.coords = null;
    state.geo = 'idle';
    if (state.cooldown?.timer) clearInterval(state.cooldown.timer);
    state.cooldown = null;
    state.category = CATEGORIES[0].id;
    show('idle');
    // And ask the server what the new person's situation is, rather than showing them an
    // idle form while a volunteer is already walking towards their table.
    if (isHacker(user)) void restore(user);
  });

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
  // Both events, not just the first.
  //
  // `session:ready` fires once, at boot. A hacker who signs in afterwards — a badge scan, a
  // claim code, the ordinary path at a registration desk — got no reconcile at all, so the
  // tab showed the idle form while their DISPATCHED ticket sat live on the server. Pressing
  // "I need help" then raised a second call and sent a second volunteer to the same table.
  N.onEvent('session:ready', ({ user }) => { if (isHacker(user)) void restore(user); });
  N.onEvent('session', (user) => { if (isHacker(user) && !state.ticket) void restore(user); });
})();
