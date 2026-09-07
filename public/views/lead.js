/**
 * lead — the shift-lead console (plan §C5).
 *
 * Four panels behind one tab: the roster for a chosen shift, the announcement composer,
 * the SOS queue with its lifecycle, and the avatar review queue. The roster's presence
 * columns are the server's buckets, never a coordinate, because the lead needs "are they
 * here yet?", not a position.
 *
 * `roles` on the tab only hides the nav button. Every endpoint below enforces the role
 * itself, so a volunteer who forces the tab open gets 403s and an empty console rather
 * than someone else's roster.
 *
 * Refreshing is a 20 second poll while the tab is on screen, stopped on the way out. The
 * listeners at the bottom take over the moment app.js re-emits the SSE frames onto the
 * bus. Plain script (CSP: script-src 'self'); styles are the `.lead-*` block.
 */

(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[lead] nexus.js must load first'); return; }

  const POLL_MS = 20000;
  const PIPS = ['OPEN', 'DISPATCHED', 'ACKNOWLEDGED', 'ON_SCENE', 'RESOLVED'];

  /**
   * The moves each status offers, in the order a lead reaches for them. This mirrors
   * SOS_TRANSITIONS in the model, minus the edges only the creator may take: the server
   * is still the authority, so a stale button gets a 409 rather than a wrong write.
   */
  const MOVES = {
    OPEN: ['dispatch', 'cancel'],
    DISPATCHED: ['acknowledge', 'on-scene', 'resolve', 'reassign', 'cancel'],
    ACKNOWLEDGED: ['on-scene', 'resolve', 'reassign', 'cancel'],
    ON_SCENE: ['resolve', 'reassign', 'cancel'],
    RESOLVED: [],
    CANCELLED: [],
  };
  const MOVE_LABEL = {
    dispatch: 'Dispatch', acknowledge: 'Acknowledge', 'on-scene': 'On scene',
    resolve: 'Resolve', reassign: 'Reassign', cancel: 'Cancel',
  };

  // `roster` is the whole `{ shift, counts, roster }` envelope, or null when nothing loaded.
  const state = { timer: null, shifts: [], shiftId: '', roster: null, announcements: [], tickets: [], avatars: [] };

  /**
   * Bumped on every handover, so a response addressed to the departed lead is dropped.
   *
   * This console holds the most sensitive data in the client: the roster (names, statuses,
   * karma), and the SOS queue as a lead reads it — hacker names, seat numbers, descriptions,
   * medical categories. It is also the one view that subscribed to no session event at all,
   * so a device changing hands left every one of those in memory and painted in the DOM,
   * readable from devtools by whoever sat down next even once the tab itself refused to open.
   */
  let generation = 0;

  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const clock = (v) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  function say(text, kind) {
    const el = document.getElementById('lead-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'lead-status' + (kind ? ` is-${kind}` : '');
  }

  /** Reports failure in both places a lead might be looking. */
  function failed(what, err) {
    const message = err?.status === 403
      ? `${what}: your account is not a shift lead.`
      : `${what}: ${err?.message || 'request failed'}`;
    say(message, 'err');
    window.game?.toast?.(message);
  }

  // Skeleton
  function render(section) {
    section.innerHTML = `
      <div class="view-head">
        <div>
          <div class="eyebrow">Shift lead</div>
          <h2>Console</h2>
          <p>Who is on the floor, what the floor has been told, and what is still on fire.</p>
        </div>
        <div class="actions"><button class="pb pb-ghost pb-sm" type="button" data-action="lead-refresh">Refresh</button></div>
      </div>

      <div class="lead-status" id="lead-status" role="status" aria-live="polite"></div>

      <div class="lead-grid">
        <div class="px lead-roster">
          <div class="panel-head">
            <div><div class="eyebrow">Roster</div><h3>Who is here</h3></div>
            <label class="hud-label" for="lead-shift">Shift</label>
          </div>
          <select class="pb" id="lead-shift" name="shiftId" aria-label="Shift to show the roster for"></select>
          <div id="lead-counts" class="lead-counts"></div>
          <div class="table-container"><table id="lead-roster-table"></table></div>
        </div>

        <div class="px lead-announce">
          <div class="panel-head"><div><div class="eyebrow">Broadcast</div><h3>Say something</h3></div></div>
          <form id="lead-announce-form" novalidate>
            <label class="hud-label" for="lead-message">Message</label>
            <textarea class="px-input" id="lead-message" name="message" rows="3" maxlength="280" required
              placeholder="Pizza is at Siebel east door for the next ten minutes."></textarea>
            <div class="lead-row">
              <label class="hud-label" for="lead-audience">Audience</label>
              <select class="pb" id="lead-audience" name="audience">
                <option value="ALL">Everyone</option>
                <option value="VOLUNTEERS">Volunteers</option>
                <option value="HACKERS">Hackers</option>
                <option value="STAFF">Staff</option>
              </select>
              <label class="hud-label" for="lead-tone">Tone</label>
              <select class="pb" id="lead-tone" name="tone">
                <option value="INFO">Info</option>
                <option value="WARNING">Warning</option>
                <option value="URGENT">Urgent</option>
              </select>
              <label class="hud-label" for="lead-minutes">Minutes</label>
              <input class="px-input" id="lead-minutes" name="minutes" type="number" inputmode="numeric" min="1" max="240" value="10">
              <button class="pb" type="submit">Post</button>
            </div>
          </form>
          <div id="lead-announce-list" class="lead-list"></div>
        </div>

        <div class="px lead-sos">
          <div class="panel-head"><div><div class="eyebrow">Distress</div><h3>SOS queue</h3></div></div>
          <div id="lead-sos-list" class="sos-list"></div>
        </div>

        <div class="px lead-avatars">
          <div class="panel-head"><div><div class="eyebrow">Moderation</div><h3>Avatar queue</h3></div></div>
          <div id="lead-avatar-list" class="lead-avatars-grid"></div>
        </div>
      </div>`;

    section.addEventListener('submit', onSubmit);
    section.addEventListener('change', onChange);
  }

  // Roster
  function paintShiftPicker() {
    const sel = document.getElementById('lead-shift');
    if (!sel) return;
    if (state.shifts.length === 0) { sel.innerHTML = '<option value="">No shifts</option>'; return; }
    sel.innerHTML = state.shifts.map((s) => `
      <option value="${esc(s._id)}"${s._id === state.shiftId ? ' selected' : ''}>${esc(s.title)} · ${esc(s.location)} · ${clock(s.startTime)}</option>`).join('');
  }

  function paintRoster() {
    const counts = document.getElementById('lead-counts');
    const table = document.getElementById('lead-roster-table');
    if (!counts || !table) return;
    if (!state.roster) { counts.innerHTML = ''; table.innerHTML = ''; return; }
    const c = state.roster.counts || {};
    const shift = state.roster.shift || {};
    counts.innerHTML = `
      <span class="sticker flat">${Number(c.checkedIn) || 0} here</span>
      <span class="sticker flat">${Number(c.confirmed) || 0} due</span>
      <span class="sticker flat">${Number(c.waitlisted) || 0} waiting</span>
      <span class="sticker flat">${Number(c.completed) || 0} done</span>
      <span class="hud-label">${Number(shift.filledSlots) || 0} / ${Number(shift.capacity) || 0} slots</span>`;

    const rows = state.roster.roster || [];
    if (rows.length === 0) {
      table.innerHTML = '<tbody><tr><td class="muted">Nobody has signed up for this one yet.</td></tr></tbody>';
      return;
    }
    table.innerHTML = `
      <thead><tr><th>Volunteer</th><th>Status</th><th>Fix</th><th>Distance</th><th class="num">Karma</th></tr></thead>
      <tbody>${rows.map((r) => {
        const p = r.presence || {};
        return `<tr>
          <td>${esc(r.name)}${r.role && r.role !== 'VOLUNTEER' ? ` <span class="sticker flat">${esc(String(r.role).replace(/_/g, ' '))}</span>` : ''}</td>
          <td><span class="sticker flat">${esc(String(r.status || '').replace(/_/g, ' '))}</span></td>
          <td class="lead-bucket" data-bucket="${esc(p.age || 'none')}">${esc(p.publishing ? p.age || 'none' : 'not sharing')}</td>
          <td class="lead-bucket" data-bucket="${esc(p.distance || 'unknown')}">${esc(p.distance || 'unknown')}</td>
          <td class="num">${Number(r.karmaPoints) || 0}</td>
        </tr>`;
      }).join('')}</tbody>`;
  }

  /** GET one panel and repaint it. A failure says so and leaves the panel as it was. */
  async function load(what, path, apply) {
    const mine = generation;
    try {
      const { data } = await N.api(path);
      if (mine !== generation) return; // the lead this was for has left the device
      apply(data);
    } catch (err) {
      if (mine !== generation) return;
      failed(what, err);
    }
  }

  const loadShifts = () => load('Could not list shifts', '/api/v1/shifts', (data) => {
    state.shifts = Array.isArray(data) ? data : [];
    if (!state.shifts.some((s) => s._id === state.shiftId)) state.shiftId = state.shifts[0]?._id || '';
    paintShiftPicker();
  });

  async function loadRoster() {
    if (!state.shiftId) { state.roster = null; paintRoster(); return; }
    // Both paths carry the guard. The success path had it and the failure path did not, so a
    // roster request that was still in flight when the device changed hands could clear state
    // and paint an error into the new occupant's console — the one case where the departed
    // lead's request is still able to write to the screen.
    const mine = generation;
    try {
      const { data } = await N.api(`/api/v1/shifts/${encodeURIComponent(state.shiftId)}/roster`);
      if (mine !== generation) return; // see `generation`
      state.roster = data || null;
      paintRoster();
    } catch (err) {
      if (mine !== generation) return; // as above: a late failure is not this account's
      state.roster = null;
      paintRoster();
      failed('Could not load the roster', err);
    }
  }

  // Announcements
  function paintAnnouncements() {
    const host = document.getElementById('lead-announce-list');
    if (!host) return;
    if (state.announcements.length === 0) { host.innerHTML = '<div class="empty-state">Nothing is live right now.</div>'; return; }
    host.innerHTML = state.announcements.map((a) => `
      <div class="lead-item" data-tone="${esc(a.tone)}">
        <div>
          <div class="lead-item-text">${esc(a.message)}</div>
          <div class="hud-label">${esc(a.audience)} · ${esc(a.authorName || 'lead')} · until ${clock(a.expiresAt)}</div>
        </div>
        <button class="pb pb-ghost pb-sm" type="button" data-action="lead-announce-clear" data-id="${esc(a.id)}">Take down</button>
      </div>`).join('');
  }

  const loadAnnouncements = () => load('Could not load announcements', '/api/v1/announcements', (data) => {
    state.announcements = Array.isArray(data) ? data : [];
    paintAnnouncements();
  });

  // SOS queue
  function pips(status) {
    // CANCELLED never reaches RESOLVED, so it lights nothing past where it stopped.
    const reached = PIPS.indexOf(status);
    return `<div class="lead-pips" role="img" aria-label="Status ${esc(String(status).replace(/_/g, ' '))}">${
      PIPS.map((p, i) => `<i class="lead-pip" data-on="${reached >= 0 && i <= reached ? '1' : '0'}" title="${p}"></i>`).join('')
    }</div>`;
  }

  function paintTickets() {
    const host = document.getElementById('lead-sos-list');
    if (!host) return;
    if (state.tickets.length === 0) { host.innerHTML = '<div class="empty-state">Nothing on fire.</div>'; return; }
    host.innerHTML = state.tickets.map((t) => {
      const id = t._id || t.id;
      const moves = MOVES[t.status] || [];
      return `<div class="sos${t.urgency === 'CRITICAL' || t.urgency === 'HIGH' ? ' urgent' : ''}">
        <span class="sos-dot"></span>
        <div>
          <div class="sos-who">${esc(t.hackerName)}</div>
          <div class="sos-where">${esc(t.tableLocation)} · ${esc(String(t.category || '').replace(/_/g, ' '))}</div>
          <div class="sos-desc">${esc(t.description)}</div>
          ${pips(t.status)}
          <div class="lead-moves">${moves.map((m) => `
            <button class="pb ${m === 'cancel' ? 'pb-danger' : 'pb-ghost'} pb-sm" type="button"
              data-action="lead-sos" data-ticket="${esc(id)}" data-op="${m}">${MOVE_LABEL[m]}</button>`).join('')}
          </div>
        </div>
        <div class="sos-side">
          <span class="sos-urg">${esc(t.urgency)}</span>
          <span class="sos-bounty">+${Number(t.karmaBounty) || 0}</span>
          <span class="hud-label">${clock(t.createdAt)}</span>
        </div>
      </div>`;
    }).join('');
  }

  // Closed tickets stay out of the queue: the lead is looking for work, not for history.
  const loadTickets = () => load('Could not load the SOS queue', '/api/v1/sos/tickets', (data) => {
    state.tickets = (Array.isArray(data) ? data : []).filter((t) => t.status !== 'RESOLVED' && t.status !== 'CANCELLED');
    paintTickets();
  });

  // Avatar review
  function paintAvatars() {
    const host = document.getElementById('lead-avatar-list');
    if (!host) return;
    if (state.avatars.length === 0) { host.innerHTML = '<div class="empty-state">Queue is clear.</div>'; return; }
    host.innerHTML = state.avatars.map((a) => `
      <div class="lead-avatar">
        <img class="lead-avatar-img" src="/api/v1/avatars/${encodeURIComponent(a.hash)}" alt="Avatar sheet awaiting review" width="64" height="64" loading="lazy">
        <div class="hud-label">${esc(String(a.hash).slice(0, 8))} · ${Number(a.width) || 0}×${Number(a.height) || 0}${a.flags ? ` · ${Number(a.flags)} flags` : ''}</div>
        <div class="lead-moves">
          <button class="pb pb-sm" type="button" data-action="lead-avatar" data-hash="${esc(a.hash)}" data-verdict="approve">Approve</button>
          <button class="pb pb-danger pb-sm" type="button" data-action="lead-avatar" data-hash="${esc(a.hash)}" data-verdict="reject">Reject</button>
          <button class="pb pb-ghost pb-sm" type="button" data-action="lead-avatar" data-hash="${esc(a.hash)}" data-verdict="flag">Flag</button>
        </div>
      </div>`).join('');
  }

  const loadAvatars = () => load('Could not load the avatar queue', '/api/v1/avatars/queue', (data) => {
    state.avatars = Array.isArray(data) ? data : [];
    paintAvatars();
  });

  // Actions
  async function refreshAll() {
    await loadShifts();
    await Promise.all([loadRoster(), loadAnnouncements(), loadTickets(), loadAvatars()]);
  }

  function onChange(event) {
    const el = event.target;
    if (!(el instanceof HTMLElement) || el.id !== 'lead-shift') return;
    state.shiftId = el.value;
    void loadRoster();
  }

  async function onSubmit(event) {
    if (event.target?.id !== 'lead-announce-form') return;
    event.preventDefault();
    const form = event.target;
    const message = form.elements.message.value.trim();
    if (!message) { say('Say something first.', 'warn'); return; }
    const minutes = Math.min(240, Math.max(1, Math.round(Number(form.elements.minutes.value) || 10)));
    try {
      await N.api('/api/v1/announcements', {
        method: 'POST',
        body: { message, audience: form.elements.audience.value, tone: form.elements.tone.value, minutes },
      });
      form.elements.message.value = '';
      say('Posted.', 'ok');
      await loadAnnouncements();
    } catch (err) {
      failed('Could not post that', err);
    }
  }

  N.registerAction('lead-refresh', () => { say(''); void refreshAll(); });

  N.registerAction('lead-announce-clear', async (el) => {
    try {
      await N.api(`/api/v1/announcements/${encodeURIComponent(el.dataset.id)}`, { method: 'DELETE' });
      await loadAnnouncements();
    } catch (err) { failed('Could not take that down', err); }
  });

  N.registerAction('lead-sos', async (el) => {
    const { ticket, op } = el.dataset;
    el.disabled = true;
    try {
      await N.api(`/api/v1/sos/tickets/${encodeURIComponent(ticket)}/${op}`, { method: 'POST', body: {} });
      say(`${MOVE_LABEL[op] || op} accepted.`, 'ok');
      await loadTickets();
    } catch (err) {
      el.disabled = false;
      failed(`${MOVE_LABEL[op] || op} refused`, err);
    }
  });

  N.registerAction('lead-avatar', async (el) => {
    const { hash, verdict } = el.dataset;
    const path = verdict === 'flag' ? 'flag' : 'review';
    const body = verdict === 'flag' ? { reason: 'LEAD_REVIEW' } : { approve: verdict === 'approve' };
    el.disabled = true;
    try {
      await N.api(`/api/v1/avatars/${encodeURIComponent(hash)}/${path}`, { method: 'POST', body });
      await loadAvatars();
    } catch (err) {
      el.disabled = false;
      failed('Could not record that verdict', err);
    }
  });

  // Tab
  N.registerTab({
    id: 'tab-lead',
    label: 'Lead',
    order: 5,
    roles: ['SHIFT_LEAD', 'ORGANIZER', 'ADMIN'],
    render,
    onShow: () => {
      void refreshAll();
      if (!state.timer) state.timer = setInterval(() => void refreshAll(), POLL_MS);
    },
    onHide: () => { if (state.timer) { clearInterval(state.timer); state.timer = null; } },
  });

  // Live nudges, for whenever app.js re-emits the SSE frames onto the bus. Repainting is
  // cheap and only happens while the console is the visible tab.
  const onFrame = (loader) => () => { if (N.activeTab() === 'tab-lead') void loader(); };
  // Every transition, by the name the server actually publishes.
  //
  // `transition()` names its event after the status it moved to, so acknowledging a ticket is
  // `SOS_TICKET_ACKNOWLEDGED` and reassigning one — which puts it back to OPEN — is
  // `SOS_TICKET_OPEN`. This list waited on a single `SOS_TICKET_UPDATED` that nothing has
  // ever emitted, so the lead's queue did not move when a responder acknowledged, arrived,
  // cancelled or was reassigned: the three states in the middle of the lifecycle, which are
  // exactly the ones a lead is watching for.
  for (const type of [
    'SOS_TICKET_CREATED', 'SOS_TICKET_OPEN', 'SOS_TICKET_DISPATCHED',
    'SOS_TICKET_ACKNOWLEDGED', 'SOS_TICKET_ON_SCENE', 'SOS_TICKET_CANCELLED',
    'SOS_TICKET_RESOLVED', 'SOS_ESCALATED',
  ]) {
    N.onEvent(type, onFrame(loadTickets));
  }
  N.onEvent('ANNOUNCEMENT', onFrame(loadAnnouncements));
  N.onEvent('ANNOUNCEMENT_CLEARED', onFrame(loadAnnouncements));

  /**
   * The browser changed hands, so everything this console is holding belongs to someone else.
   *
   * `me.js`, `quests.js`, `players.js` and `app.js` all grew one of these; this file never
   * had one, and it is the view with the most to lose. Both halves matter: emptying `state`
   * is what stops the next occupant reading a stranger's roster and open medical calls out of
   * memory, and repainting is what takes them off the screen — the tab is hidden by the role
   * gate, not unmounted, so unpainted DOM survives in place.
   *
   * **Not** reloaded from here, and the poll timer is stopped.
   *
   * The first version of this called `refreshAll()` unconditionally, which bypassed the gate
   * this tab already has: `registerTab` declares `roles: ['SHIFT_LEAD','ORGANIZER','ADMIN']`
   * and every existing load runs through `onShow`, so the console only ever fetches for
   * somebody entitled to it. Reloading here meant that when the device passed to an ordinary
   * volunteer, `/roster` answered 403 and `failed()` raised a **toast** — a global popup
   * telling a user who had never opened this tab that their account is not a shift lead.
   *
   * Stopping the timer is the other half, and that one was wrong before this handler existed:
   * the interval belongs to the departing lead's `onShow` and kept polling under the new
   * account, so the same 403 toast would have arrived a few seconds later anyway. An entitled
   * account gets everything back through `onShow` the next time the tab is opened.
   */
  N.onEvent('session:handover', () => {
    generation += 1;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.roster = null;
    state.tickets = [];
    state.avatars = [];
    state.announcements = [];
    state.shifts = [];
    state.shiftId = '';
    paintShiftPicker();
    paintRoster();
    paintTickets();
    paintAvatars();
    paintAnnouncements();
    say('');
  });
})();
