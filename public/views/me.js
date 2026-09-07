/**
 * me — the volunteer's own card (plan §C4).
 *
 * Every request on this tab goes to a `/me` endpoint rather than to a list filtered in
 * the browser: `/me/shifts` for the next shift, `/me/inventory` for power-ups, `/me/card`
 * for the short id and tier. The attendance token is minted against the account's own
 * confirmed registration, and the server derives the volunteer from the session, so there
 * is no id to pass on this path.
 *
 * "No way to mint one for somebody else" is now true of the whole client, which it was not
 * when this was written. The older Trainer path in `app.js` posted `{volunteerId, shiftId}`
 * and a server in `AUTH_MODE=legacy` believed it; that panel and its four module variables
 * were deleted, and this tab is the only thing that mints an attendance token. The server
 * side is unchanged and still governs: `legacy` believes a body id for an action, `required`
 * refuses one that disagrees with the session.
 *
 * The walking ETA is local arithmetic. The renderer knows where the player is in world
 * units, the content pack knows where the venue is in degrees, and both share the frame
 * build-campus.py laid down (origin at the Main Quad, +x east, +z south). Nothing is
 * asked of the server to work out how far away a shift is.
 *
 * Plain script under `script-src 'self'`: no inline handlers, and everything reaching
 * innerHTML goes through esc().
 */
(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[me] nexus.js must load first'); return; }

  const TAB_ID = 'tab-me';
  const WALK_MPS = 1.3;
  const TOKEN_WINDOW_S = 30;
  const LEAD_ROLES = ['SHIFT_LEAD', 'ORGANIZER', 'ADMIN'];

  const state = {
    section: null,
    visible: false,
    shifts: [],
    next: null,
    inventory: [],
    card: null,
    loading: false,
    token: null,          // { token, shiftId }
    tokenError: null,
    tokenBusy: false,
    remaining: 0,
    timer: null,
  };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * The geofence the desk scanner will actually apply to *this* shift's venue.
   *
   * The copy quoted a literal 75 while the server resolved the number from the pack. It is
   * the only place the rule is stated to the person it applies to, so a pack that widens or
   * narrows the fence would have had this panel telling a volunteer to stand somewhere the
   * scanner disagrees with.
   *
   * The venue's own resolved `geofenceMeters` wins, because a shift happens at one place and
   * that place may override. `resolveVenue` already returns the whole venue object, so this
   * is a field read rather than a second copy of the precedence rule — the ordering lives
   * once, in `geofenceMetersFor` on the server, and both fields arrive already resolved.
   */
  const geofenceMetres = (location) => {
    const venue = location ? resolveVenue(location) : null;
    const m = Number(venue?.geofenceMeters ?? N.content?.event?.campus?.geofenceMeters);
    return Number.isFinite(m) && m > 0 ? m : 75;
  };

  /** SIEBEL_GUARDIAN -> "Siebel Guardian". The card printed the raw enum before. */
  const humanise = (v) => String(v ?? '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase());

  /**
   * The karma bands, mirrored from `computePrestigeTier` in src/models/volunteer.model.ts.
   *
   * A second copy of a server rule is how this repository grows its favourite bug, so this
   * one is gated rather than trusted: `tests/prestige.test.ts` parses the thresholds back out
   * of the model and fails if the two ever disagree. The copy has to exist because the card
   * draws a *distance* — "you are 1,500 karma short of Leviathan Prime" needs both edges of
   * the band, and `GET /me/card` sends the tier the balance landed in without its bounds.
   * (It sends plenty else this panel uses — `karma`, `shortId`, `faction`; it is the band
   * edges specifically that are absent, and they are the only thing a distance needs.)
   */
  const TIER_BANDS = [
    { tier: 'NEOPHYTE_PLANKTON', minKarma: 0 },
    { tier: 'CURRENT_RIDER', minKarma: 200 },
    { tier: 'ABYSSAL_VANGUARD', minKarma: 500 },
    { tier: 'SIEBEL_GUARDIAN', minKarma: 1000 },
    { tier: 'MIDNIGHT_KRAKEN', minKarma: 2000 },
    { tier: 'LEVIATHAN_PRIME', minKarma: 3500 },
  ];

  /** The band a balance sits in, and the one above it — null once there is nothing above. */
  function bandsFor(karma) {
    const k = Math.max(0, Number(karma) || 0);
    let current = TIER_BANDS[0];
    for (const band of TIER_BANDS) if (k >= band.minKarma) current = band;
    return { current, next: TIER_BANDS.find((band) => k < band.minKarma) || null };
  }

  /**
   * The team the rest of the client believes you are on.
   *
   * Deliberately `window.currentVolunteerFaction` first and the card's `faction` second, in
   * that order. They disagree today: the server stores `null` for every seeded account, and
   * app.js picks the first playable team so the campus HUD, the gym list and the encounter
   * all have a colour to work with. Reading the card first would put "Unclaimed" on this
   * panel while the Campus tab two clicks away said "Team Kernel" about the same person.
   * One wrong-looking answer is better than two answers.
   */
  function myFaction() {
    const id = window.currentVolunteerFaction || state.card?.faction || 'NEUTRAL';
    return (N.content?.factions || []).find((f) => f.id === id)
      || { id, label: humanise(id), short: humanise(id), color: '#7c8daa' };
  }

  /* ------------------------------------------------------------------ *
   * Where things are
   * ------------------------------------------------------------------ */

  /**
   * The client half of `resolveVenue` in src/common/utils/geo.ts: an exact venue key
   * wins, then the longest matching hint. There is no HQ fallback here — a shift we
   * cannot place gets no ETA rather than a confident distance to the wrong building.
   */
  function resolveVenue(location) {
    const venues = N.content?.venues;
    const raw = String(location || '').trim();
    if (!venues || !raw) return null;
    if (Object.prototype.hasOwnProperty.call(venues, raw)) return venues[raw];
    const upper = raw.toUpperCase();
    let best = null;
    for (const venue of Object.values(venues)) {
      for (const raw2 of venue.hints || []) {
        // Upper-cased here, not trusted from the pack — the same reason `geo.ts` gives on the
        // server: this is a substring test against an upper-cased input, so a lower-case hint
        // would never fire. The server does it and this did not, which meant a mixed-case
        // hint resolved server-side and silently missed here, and a venue that cannot be
        // resolved falls back to the campus default without saying so. The shipped pack has
        // no such hint today; a fork's would have been the first to find out.
        const hint = String(raw2).toUpperCase();
        if (upper.includes(hint) && (!best || hint.length > best.score)) best = { venue, score: hint.length };
      }
    }
    return best ? best.venue : null;
  }

  /** Metres from the player's sprite to a shift's venue, or null when either is unknown. */
  function metresToShift(shift) {
    const meta = window.campusMeta;
    const me = window.campus?.getPlayer?.();
    const venue = shift && resolveVenue(shift.location);
    if (!meta?.origin || !me || !venue) return null;
    const mpu = meta.metersPerUnit || 10;
    const [lat0, lng0] = meta.origin;
    const x = ((venue.longitude - lng0) * 111320 * Math.cos((lat0 * Math.PI) / 180)) / mpu;
    const z = -((venue.latitude - lat0) * 111320) / mpu;
    return Math.hypot(x - me.x, z - me.z) * mpu;
  }

  const clockOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function relative(ms) {
    const mins = Math.round(ms / 60000);
    if (mins <= 0) return 'now';
    if (mins < 60) return `in ${mins} min`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
  }

  /**
   * Consecutive days ending today or yesterday on which this account showed up. The
   * server holds the authoritative counter; until `/me` carries it, worked days from
   * `/me/shifts` are that same number computed from the same rows.
   */
  function streakDays() {
    const held = N.session.user?.streak?.count;
    if (Number.isFinite(held)) return held;
    const key = (d) => new Date(d).toDateString();
    const days = new Set(state.shifts.filter((s) => s.status === 'CHECKED_IN' || s.status === 'COMPLETED').map((s) => key(s.startTime)));
    if (!days.size) return 0;
    const cursor = new Date();
    if (!days.has(key(cursor))) cursor.setDate(cursor.getDate() - 1);
    let count = 0;
    while (days.has(key(cursor))) { count += 1; cursor.setDate(cursor.getDate() - 1); }
    return count;
  }

  /* ------------------------------------------------------------------ *
   * Data
   * ------------------------------------------------------------------ */

  /**
   * Which account's data the state currently belongs to.
   *
   * A `load()` that is already in flight when the browser changes hands resolves *after* the
   * handover has cleared everything, and writes the previous account's answer into the state
   * it just emptied — the one window the synchronous clear cannot close, because the response
   * is already on its way. Bumping this on handover makes a stale response identifiable, and
   * a stale response is dropped rather than painted.
   *
   * A counter rather than the account id: it is also correct for two handovers in quick
   * succession, and it needs no identity to compare against.
   */
  let generation = 0;

  async function load() {
    if (state.loading || !N.session.user) return;
    state.loading = true;
    const mine = generation;
    const [shifts, inventory, card] = await Promise.all([
      N.api('/api/v1/me/shifts', { lenient: true }),
      N.api('/api/v1/me/inventory', { lenient: true }),
      N.api('/api/v1/me/card', { lenient: true }),
    ]).catch((err) => { console.debug('[me] load failed', err.message); return [null, null, null]; });
    state.loading = false;
    // Somebody else's answer, arriving after the browser changed hands.
    if (mine !== generation) return;
    if (shifts?.success) { state.shifts = shifts.data.shifts || []; state.next = shifts.data.next || null; }
    if (inventory?.success) state.inventory = Array.isArray(inventory.data) ? inventory.data : [];
    if (card?.success) state.card = card.data;
    // A token minted for a shift that is no longer the next one is not the one to show.
    if (state.token && state.token.shiftId !== state.next?.shiftId) clearToken();
    paint();
  }

  /* ------------------------------------------------------------------ *
   * Attendance token
   * ------------------------------------------------------------------ */

  const canMint = () => N.session.user?.kind === 'VOLUNTEER'
    && !!state.next && (state.next.status === 'CONFIRMED' || state.next.status === 'CHECKED_IN');

  function clearToken() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.token = null;
    state.remaining = 0;
  }

  async function mintToken() {
    if (state.tokenBusy || !canMint()) return;
    state.tokenBusy = true;
    state.tokenError = null;
    paint();
    try {
      const { data } = await N.api('/api/v1/attendance/token', { method: 'POST', body: { shiftId: state.next.shiftId } });
      state.token = { token: data.token, shiftId: state.next.shiftId };
      state.remaining = data.expiresInSeconds;
      startCountdown();
    } catch (err) {
      clearToken();
      state.tokenError = err.status === 403 ? 'Attendance tokens are for volunteers.'
        : err.status === 400 ? 'You do not hold a confirmed spot on that shift yet.'
          : err.message;
    } finally {
      state.tokenBusy = false;
      paint();
    }
  }

  /**
   * A token is only valid inside its 30 s slice, so the countdown is the honest thing to
   * draw. It re-mints while the tab is open and stops the moment it is not: a live HMAC
   * ticking away behind a hidden panel is a token nobody asked for.
   */
  function startCountdown() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      state.remaining -= 1;
      if (state.remaining > 0) { paintCountdown(); return; }
      clearInterval(state.timer);
      state.timer = null;
      if (state.visible) void mintToken(); else { clearToken(); paint(); }
    }, 1000);
    paintCountdown();
  }

  function paintCountdown() {
    const fill = state.section?.querySelector('#me-token-fill');
    const text = state.section?.querySelector('#me-token-text');
    if (fill) {
      fill.style.width = `${Math.max(0, (state.remaining / TOKEN_WINDOW_S) * 100)}%`;
      fill.classList.toggle('low', state.remaining <= 8);
    }
    if (text && state.token) text.textContent = `Expires in ${Math.max(0, state.remaining)}s`;
  }

  /* ------------------------------------------------------------------ *
   * Markup
   * ------------------------------------------------------------------ */

  const cell = (value, label) => `<div class="stat"><div class="v">${esc(value)}</div><div class="hud-label">${esc(label)}</div></div>`;

  /**
   * The board this account can actually open.
   *
   * War Room is `roles: STAFF` (app.js), which excludes HACKER; the Quests board lists every
   * role. This button used to name `tab-shifts` unconditionally, so a hacker pressed a
   * labelled button and `showTab` refused it with a `console.warn` — visible to nobody, on a
   * screen that gave no other way forward.
   */
  const boardTab = () => (N.session.user?.kind === 'HACKER' ? 'tab-quests' : 'tab-shifts');

  function nextShiftPanel() {
    const s = state.next;
    if (!s) {
      return `<div class="px"><div class="panel-head"><div><div class="eyebrow">Next up</div><h3>Nothing booked</h3></div></div>
        <div class="empty-state">No shift on your card yet.
          <button class="pb" type="button" data-action="tab" data-tab="${boardTab()}">Open the quest board</button></div></div>`;
    }
    const starts = new Date(s.startTime).getTime();
    const metres = metresToShift(s);
    const walkMin = metres === null ? null : Math.max(1, Math.round(metres / WALK_MPS / 60));
    const leaveBy = walkMin === null ? 0 : starts - walkMin * 60000;
    const walk = walkMin === null
      ? 'Drop your trainer on the campus map for a walking time to the door.'
      : `${Math.round(metres)} m away, about ${walkMin} min at a walk. ${leaveBy <= Date.now() ? 'Leave now.' : `Leave by ${clockOf(leaveBy)}.`}`;
    return `
      <div class="px">
        <div class="panel-head">
          <div><div class="eyebrow">Next up</div><h3>${esc(s.title)}</h3></div>
          <span class="sticker ${s.active ? 'live' : 'flat'}">${esc(s.active ? 'ON NOW' : s.status)}</span>
        </div>
        <p>${esc(s.location)}</p>
        <div class="vitals-row" style="margin-top:12px">
          ${cell(clockOf(starts), relative(starts - Date.now()))}
          ${cell(`${Number(s.baseKarma) || 0}`, 'karma')}
          ${cell(String(s.category || '').replace(/_/g, ' ').slice(0, 10), 'category')}
        </div>
        <p class="ob-hint">${esc(walk)}</p>
      </div>`;
  }

  /**
   * The check-in token, or a sentence saying why there is not one.
   *
   * Returning '' for a hacker left a visible hole where every other role has a panel: the tab
   * simply had one fewer card and said nothing about it. Absence is not an explanation — a
   * hacker reading this screen has no way to tell whether check-in is broken, still loading,
   * or not theirs.
   */
  function tokenPanel() {
    if (N.session.user?.kind === 'HACKER') {
      return `<div class="px"><div class="panel-head"><div><div class="eyebrow">Check in</div><h3>Not your check-in</h3></div></div>
        <p class="ob-hint">Attendance tokens are how <em>volunteers</em> clock on to a shift. As a hacker you never need one — raise an SOS from the SOS tab if you need somebody, and spin HackStops on the campus map for power-ups.</p></div>`;
    }
    // `AccountKind` is VOLUNTEER | HACKER and the branch above takes HACKER, so this only
    // catches an account with no kind at all — signed out, or a session still loading.
    if (N.session.user?.kind !== 'VOLUNTEER') return '';
    if (!canMint()) {
      return `<div class="px"><div class="panel-head"><div><div class="eyebrow">Check in</div><h3>No token yet</h3></div></div>
        <p class="ob-hint">A token is minted against a confirmed spot. Claim a shift and it appears here.</p></div>`;
    }
    const live = !!state.token;
    return `
      <div class="px">
        <div class="panel-head">
          <div><div class="eyebrow">Check in</div><h3>Show this at the desk</h3></div>
          <button class="pb pb-sm" type="button" data-action="me-token"${state.tokenBusy ? ' disabled' : ''}>${live ? 'New token' : 'Mint token'}</button>
        </div>
        <div class="qr-container">
          <div class="qr-box"><div id="me-token-code" class="qr-target"></div></div>
          <div>
            <div class="countdown-bar"><div class="countdown-fill" id="me-token-fill" style="width:${live ? 100 : 0}%"></div></div>
            <div class="qr-meta"><span id="me-token-text">${live ? '' : 'No live token'}</span><span>${esc(state.next.title)}</span></div>
            <p class="ob-hint">Rotates every ${TOKEN_WINDOW_S} seconds. The scanner also checks you are within ${geofenceMetres(state.next?.location || state.next?.locationName)} m of the venue, so mint it once you are there.</p>
            ${state.tokenError ? `<div class="ob-status is-err">${esc(state.tokenError)}</div>` : ''}
          </div>
        </div>
      </div>`;
  }

  /**
   * Who you are, in the game's own terms.
   *
   * This panel used to be three numbers and a streak line, and it printed `SIEBEL_GUARDIAN`
   * — the raw enum, underscore and all — as its heading, while the Ranks table two tabs over
   * humanised the same value. What it never showed at all was the half of the identity the
   * player actually picks: the sprite, the team, the level, and which badges the count was
   * counting. All four were already on the client; nothing here asks the server for anything
   * it was not already sending.
   */
  function statsPanel() {
    const u = N.session.user || {};
    const card = state.card || {};
    // Clamped once, here, and used everywhere below.
    //
    // `bandsFor` clamps internally but returned bands were being combined with the *raw*
    // value, so a negative balance printed "205 karma to Current Rider" at -5 and produced
    // `width: -3%`, which is not a length and is simply dropped. The schema says `min: 0`,
    // but `computePrestigeTier(-1)` is explicitly tested server-side, so the client is not
    // entitled to assume it will never see one.
    const karma = Math.max(0, Number(card.karma ?? u.karmaPoints) || 0);
    const streak = streakDays();
    const carrying = state.inventory.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
    const faction = myFaction();
    const { current, next } = bandsFor(karma);

    // The level curve and the karma bands are two different ladders over the same balance:
    // levels come from game.js (a square-root curve, no ceiling), tiers from the server's
    // six named bands. Showing one and not the other is what made "4,200 karma" feel like a
    // number with nothing attached to it.
    const level = window.game?.levelFor ? window.game.levelFor(karma) : null;
    const levelPct = window.game?.levelProgress ? Math.round(window.game.levelProgress(karma) * 100) : 0;
    const bandSpan = next ? next.minKarma - current.minKarma : 0;
    const bandPct = next ? Math.round(((karma - current.minKarma) / bandSpan) * 100) : 100;

    // The trainer you made on the Trainer tab, or the stock sprite until you make one.
    // `Sprites` is a plain script like this one and may not have parsed yet on a cold load;
    // an empty face is a smaller failure than a thrown render.
    const S = window.Sprites;
    const head = window.game?.state?.head;
    const face = !S ? ''
      : head ? `<img class="pxi" alt="" src="${S.imageDataURL(head, 4)}">`
        : S.img('trainer', 5);

    const badges = Array.isArray(u.badges) ? u.badges : [];

    return `
      <div class="px" id="me-standing">
        <div class="panel-head">
          <div><div class="eyebrow">Standing</div><h3>${esc(humanise(card.tier || u.prestigeTier || 'Rookie'))}</h3></div>
          ${level ? `<span class="sticker">LV ${level}</span>` : ''}
        </div>

        <div class="me-card">
          <div class="me-face" aria-hidden="true">${face}</div>
          <div class="me-facts">
            <div class="me-chips">
              <span class="tag is-orange">${esc(humanise(u.kind === 'HACKER' ? 'HACKER' : u.role || 'VOLUNTEER'))}</span>
              <span class="tag" style="border-color:${esc(faction.color)};color:${esc(faction.color)}">${esc(faction.label || faction.id)}</span>
              ${card.shortId ? `<span class="tag">#${esc(card.shortId)}</span>` : ''}
            </div>
            ${level ? `<div class="me-meter">
              <div class="hud-label">Level ${level} &middot; ${levelPct}% of the way to ${level + 1}</div>
              <div class="pxbar"><i style="width:${levelPct}%"></i></div>
            </div>` : ''}
            <div class="me-meter">
              <div class="hud-label">${next
                ? `${next.minKarma - karma} karma to ${esc(humanise(next.tier))}`
                : 'Top tier &mdash; there is nothing above this'}</div>
              <div class="pxbar"><i class="is-tier" style="width:${bandPct}%"></i></div>
            </div>
          </div>
        </div>

        <div class="ob-stats">
          <span><b>${karma}</b><small>KARMA</small></span>
          <span><b>${(Number(u.hoursServed) || 0).toFixed(1)}</b><small>HOURS</small></span>
          <span><b>${badges.length}</b><small>BADGES</small></span>
        </div>
        ${badges.length
          ? `<div class="me-badges">${badges.map((b) => `<span class="badge-tag">${esc(humanise(b))}</span>`).join('')}</div>`
          : '<p class="ob-hint">No badges yet. They come from surge shifts, distress calls answered and strongholds held.</p>'}
        <p class="ob-hint">${streak > 0
          ? `${streak} day${streak === 1 ? '' : 's'} in a row. Serve a shift today to keep it.`
          : 'No streak yet. Serve a shift on two days running to start one.'}</p>
        <p class="ob-hint">Carrying ${carrying} power-up${carrying === 1 ? '' : 's'}.</p>
      </div>`;
  }

  /**
   * What opting in actually discloses, said differently for each role.
   *
   * This said "It is symmetric" — you are invisible and you see nobody — and that is not true
   * of the one thing a person reading it cares about. `GET /api/v1/presence` is
   * `requireSession` + `requireRole('SHIFT_LEAD')` and checks nothing about the reader's own
   * opt-in, and the shift roster behaves the same way: a lead who has switched themselves off
   * still reads exact positions, audited, whatever this switch says.
   *
   * The same panel already told leads that four sentences later, so it carried the claim and
   * its own contradiction. README, `docs/PRESENCE.md` and `docs/DEMO.md` were corrected for
   * this earlier; **this is the only one of the four addressed to the person whose privacy it
   * describes**, and it is the one they read at the moment they decide. Nobody opens
   * PRESENCE.md before flipping a location switch.
   */
  function privacyCopy() {
    const u = N.session.user || {};
    const base = 'Off, you are invisible on the map and you see nobody there. Leads can still read your exact position — from the shift roster and GET /presence — and every one of those reads is logged under their name. On, other trainers see a position snapped to a 20 m grid, nudged a few metres, and released a second late.';
    if (u.kind === 'HACKER') {
      return `${base} Those logs are kept for thirty days. Raising an SOS shares where you are whatever this switch says.`;
    }
    const volunteer = `${base} Off shift you stay hidden from everyone but a lead. Distress calls only reach volunteers who are opted in and on shift; opted out, dispatch falls back to your shift venue.`;
    return LEAD_ROLES.includes(u.role)
      ? `${volunteer} You can also read exact positions from the roster, and each of those reads is written to the audit log under your name.`
      : volunteer;
  }

  function settingsPanel() {
    const on = N.presence?.state?.optIn ?? N.session.user?.presenceOptIn;
    // Why the switch is on and the map still does not have you. The server refuses samples
    // for six different reasons and used to say none of them out loud; this is the sentence.
    const refusal = N.presence?.refusalLine?.() ?? null;
    return `
      <div class="px">
        <div class="panel-head"><div><div class="eyebrow">Settings</div><h3>Privacy</h3></div></div>
        <div class="ob-row" style="align-items:center">
          <input type="checkbox" id="pref-visible" data-action="presence-toggle" aria-labelledby="me-presence-label" aria-describedby="me-presence-copy"${on ? ' checked' : ''}>
          <span class="hud-label" id="me-presence-label">Show me on the campus map</span>
        </div>
        ${on && refusal ? `<p class="ob-hint me-presence-why" role="status">${esc(refusal)}</p>` : ''}
        <p class="ob-hint" id="me-presence-copy">${esc(privacyCopy())}</p>
      </div>`;
  }

  function paint() {
    const el = state.section;
    if (!el) return;
    const u = N.session.user;
    if (!u) {
      el.innerHTML = '<div class="empty-state">Sign in to see your card.<button class="pb" type="button" data-action="session">Sign in</button></div>';
      return;
    }
    el.innerHTML = `
      <div class="view-head">
        <div>
          <div class="eyebrow">${esc(u.kind === 'HACKER' ? 'Hacker' : String(u.role || 'Volunteer').replace(/_/g, ' '))}</div>
          <h2>${esc(u.displayName || 'Trainer')}</h2>
          <p>Your shift, your token, your standing. Nothing here is about anybody else.</p>
        </div>
        <div class="actions">
          ${state.card ? `<span class="sticker rare">#${esc(state.card.shortId)}</span>` : ''}
          <button class="pb pb-ghost pb-sm" type="button" data-action="me-refresh">Refresh</button>
        </div>
      </div>
      <div class="split">
        <div class="rail">${nextShiftPanel()}${tokenPanel()}</div>
        <div class="rail">${statsPanel()}${settingsPanel()}</div>
      </div>`;
    paintCountdown();
    // The token is drawn, not printed. `qr.js` encodes it in the page — the panel says "show
    // this at the desk" and a desk scanner cannot read base64, which is what this box held
    // before. Rendered after `innerHTML` because the element has to exist first.
    const qrBox = document.getElementById('me-token-code');
      // If qr.js did not load, show the token rather than an empty box under a running
      // countdown: a desk can type a token, it cannot type a blank square.
      if (window.NexusQR) window.NexusQR.render(qrBox, (state.token ? state.token.token : ''));
      else if (qrBox) { qrBox.textContent = (state.token ? state.token.token : ''); qrBox.classList.add('qr-fallback'); }
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  N.registerAction('me-token', () => { void mintToken(); });
  N.registerAction('me-refresh', () => { void load(); });

  N.registerTab({
    id: TAB_ID,
    label: 'Me',
    order: 10,
    roles: ['VOLUNTEER', 'SHIFT_LEAD', 'ORGANIZER', 'ADMIN', 'HACKER'],
    render(section) { state.section = section; paint(); void load(); },
    onShow() { state.visible = true; void load(); },
    onHide() { state.visible = false; clearToken(); paint(); },
  });

  N.onEvent('session:ready', ({ user }) => { if (user) void load(); else paint(); });
  // Paint on any session change; *load* when somebody signs in at runtime.
  //
  // `session:ready` fires once, at boot. A user who lands signed out and then signs in — a
  // badge scan at the desk, the only path in `AUTH_MODE=required` — got a repaint of empty
  // state and nothing else, so this tab sat blank until they navigated away and back.
  N.onEvent('session', (user) => { if (user) void load(); else paint(); });

  /**
   * The browser changed hands. Drop everything before repainting, not after the fetch lands.
   *
   * `session` alone repaints, and a repaint draws the new name over the previous account's
   * shifts, venues and inventory counts — and over their live attendance token, which is a
   * credential a scanner accepts. The window is short, one round trip, and it is a window in
   * which the screen is showing one person's badge under another person's name.
   *
   * Two things beyond the clear. `state.loading` is released, or the corrective `load()`
   * below is dropped by its own latch and the tab sits empty; and `generation` is bumped, so
   * a `load()` that was already in flight cannot land afterwards and repaint what was just
   * cleared. That is the only part of this the synchronous clear cannot reach on its own.
   */
  N.onEvent('session:handover', () => {
    generation += 1;
    state.loading = false;
    clearToken();
    state.shifts = [];
    state.next = null;
    state.inventory = [];
    state.card = null;
    paint();
    void load();
  });

  // Anything that moves a registration, a check-in or the inventory changes what this tab
  // is showing. The rows are small and the tab is usually closed, so reloading all three
  // is cheaper than tracking each mutation.
  for (const type of ['SLOT_RESERVED', 'WAITLIST_PROMOTED', 'VOLUNTEER_CHECKED_IN', 'VOLUNTEER_CHECKED_OUT', 'SWAP_EXECUTED', 'HACKSTOP_SPUN', 'POWERUP_CONSUMED']) {
    N.onEvent(type, () => { if (state.section) void load(); });
  }

  // players.js owns the toggle; repaint so the checkbox agrees with the transport.
  /**
   * Repaint the standing panel once the things it reads have actually arrived.
   *
   * `index.html` loads this file before `sprites.js`, `game.js` and `app.js`. They are plain
   * classic scripts, so by the time anything here runs on a `session:ready` that resolved
   * early, `window.Sprites` can be undefined and `currentVolunteerFaction` has not been
   * reconciled against the content pack. Everything was read once, at first paint, and never
   * again: the trainer's face came out an empty box and the team chip said "Unclaimed" while
   * the Campus tab, reading the same variable a moment later, said "Team Kernel" about the
   * same person.
   *
   * Three signals, because there are three different arrivals and no single one covers them:
   * `load` for the scripts existing at all, `content` for the faction table, and `game:ready`
   * for `state.head` and `levelFor` — which `game.init` only sets *after* awaiting
   * `Sprites.ready` and a dynamic import, so subscribing to `Sprites.ready` here would have
   * fired too early and left the face empty anyway.
   *
   * Only this panel is redrawn, not the tab. `paint()` rebuilds the attendance QR from
   * scratch, and a token minted thirty seconds ago should not be torn down and redrawn
   * because a sprite sheet finished decoding.
   */
  function repaintStanding() {
    const el = document.getElementById('me-standing');
    // Absent when the tab has never been opened, or when nobody is signed in — in both
    // cases there is nothing to correct and `paint()` will read the settled values.
    if (el) el.outerHTML = statsPanel();
  }

  // Whichever arrives last wins; both are cheap and idempotent.
  window.addEventListener('load', repaintStanding);
  N.onEvent('content', repaintStanding);
  N.onEvent('game:ready', repaintStanding);

  N.onEvent('presence:transport', () => paint());
  N.onEvent('presence:nack', () => paint());
})();
