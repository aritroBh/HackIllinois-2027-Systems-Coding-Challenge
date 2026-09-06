/**
 * NEXUS OS — war-room frontend.
 *
 * Binds the live API and SSE stream to the dashboard, and drives the WebGL
 * campus (gl/campus3d.js): gyms recolour their monument, on-duty volunteers
 * orbit the buildings they are working, HackStops become geofenced beacons and
 * open SOS tickets become distress cones on the real UIUC map.
 */

let shiftsCache = [];
let volunteersCache = [];
let currentQrToken = null;
let currentQrVolunteerId = null;
let currentQrShiftId = null;
let qrCountdownTimer = null;
// The session user's faction when signed in; the picker still overrides it
// locally until PATCH /me lands in M3. Re-synced on the `session` event below.
let currentVolunteerFaction = window.Nexus?.session?.user?.faction || 'TEAM_KERNEL';
let gymsCache = [];
let hackStopsCache = [];
let userInventoryCache = [];
let openSosTicketsCache = [];

// game.js reads the caches through `window.*`; top-level `let` bindings are
// not window properties, so expose live getters rather than copies.
Object.defineProperties(window, {
  shiftsCache: { get: () => shiftsCache },
  volunteersCache: { get: () => volunteersCache },
  gymsCache: { get: () => gymsCache },
  hackStopsCache: { get: () => hackStopsCache },
  userInventoryCache: { get: () => userInventoryCache },
  openSosTicketsCache: { get: () => openSosTicketsCache },
  currentVolunteerFaction: { get: () => currentVolunteerFaction },
  // Renderer handle + projection, declared further down (TDZ is fine: the
  // getters only run once the script has finished evaluating).
  campus: { get: () => campus },
  toWorld: { get: () => toWorld },
  campusMeta: { get: () => campusMeta },
  // game.js reads the dossiers in openEncounter for the first "fact" line.
  monumentInfo: { get: () => monumentInfo },
});

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

// HTML-escape server-controlled strings before innerHTML interpolation.
// Shift titles, volunteer names and SOS text are attacker-controlled via the
// open API; without this every render sink below is stored XSS.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/**
 * Faction table, keyed by faction id. Filled from the content pack
 * (`Nexus.content.factions`, plan A1) by `applyFactions()` at boot; the
 * literals are the fallback for a server that has no `/api/v1/content` yet.
 * `FACTION` itself is mutated in place so every closure that captured it
 * (labels, map colours, the gym list) sees the pack's values.
 */
const FACTION_DEFAULTS = {
  TEAM_KERNEL: { label: 'Team Kernel', short: 'Kernel', color: '#22d3ee', cls: 'c-cyan' },
  TEAM_TENSOR: { label: 'Team Tensor', short: 'Tensor', color: '#a78bfa', cls: 'c-violet' },
  TEAM_SILICON: { label: 'Team Silicon', short: 'Silicon', color: '#fbbf24', cls: 'c-amber' },
  NEUTRAL: { label: 'Unclaimed', short: 'Unclaimed', color: '#7c8daa', cls: 'c-dim' },
};
const FACTION_CLS = { TEAM_KERNEL: 'c-cyan', TEAM_TENSOR: 'c-violet', TEAM_SILICON: 'c-amber', NEUTRAL: 'c-dim' };
const FACTION = Object.fromEntries(Object.entries(FACTION_DEFAULTS).map(([k, v]) => [k, { ...v }]));

/** Rebuilds `FACTION` (and the faction picker) from the pack's list. Returns false when the list is unusable. */
function applyFactions(list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const next = {};
  for (const f of list) {
    if (!f || typeof f.id !== 'string' || !f.id) continue;
    const dflt = FACTION_DEFAULTS[f.id] || FACTION_DEFAULTS.NEUTRAL;
    next[f.id] = {
      label: f.label || dflt.label,
      short: f.short || f.label || dflt.short,
      color: typeof f.color === 'string' && /^#[0-9a-f]{6}$/i.test(f.color) ? f.color : dflt.color,
      cls: FACTION_CLS[f.id] || 'c-dim',
      hqVenue: f.hqVenue || null,
      theme: f.theme || null,
    };
  }
  if (Object.keys(next).length === 0) return false;
  // NEUTRAL is the unclaimed state; the pack schema requires it, but a missing
  // entry must not leave `factionOf()` returning undefined.
  if (!next.NEUTRAL) next.NEUTRAL = { ...FACTION_DEFAULTS.NEUTRAL };

  for (const k of Object.keys(FACTION)) delete FACTION[k];
  Object.assign(FACTION, next);

  const playable = Object.keys(FACTION).filter((id) => id !== 'NEUTRAL');
  if (!FACTION[currentVolunteerFaction] || currentVolunteerFaction === 'NEUTRAL') currentVolunteerFaction = playable[0] || 'NEUTRAL';

  const sel = document.getElementById('user-faction-selector');
  if (sel) {
    sel.replaceChildren(...playable.map((id) => {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = FACTION[id].label;
      return o;
    }));
    sel.value = currentVolunteerFaction;
  }
  return true;
}

/**
 * Event branding from the pack's `event.json`: page title, the header chip,
 * the campus heading and the sticker-book title. The HTML ships sensible
 * defaults so nothing is blank before the descriptor arrives.
 */
function applyBranding(content) {
  const ev = content?.event;
  if (!ev || typeof ev !== 'object') return false;
  const setAll = (key, text) => {
    if (!text) return;
    for (const el of document.querySelectorAll(`[data-brand="${key}"]`)) el.textContent = text;
  };
  const name = typeof ev.name === 'string' ? ev.name : '';
  const eventName = typeof ev.eventName === 'string' ? ev.eventName : '';
  const tagline = typeof ev.tagline === 'string' ? ev.tagline : '';
  const title = [name, eventName].filter(Boolean).join(' · ');
  if (title) document.title = title;
  setAll('name', name);
  setAll('event-chip', [eventName, tagline].filter(Boolean).join(' · '));
  setAll('campus-label', ev.campus?.label);
  setAll('sticker-title', ev.branding?.stickerBookTitle);
  const n = Array.isArray(content.monuments) ? content.monuments.length : 0;
  if (n) setAll('monument-count', `${n} landmarks`);
  if (Number.isFinite(ev.campus?.geofenceMeters)) setAll('geofence', `${ev.campus.geofenceMeters} m`);
  return true;
}

// The map wants a deeper neutral than the UI does: an unclaimed monument lit
// with the panel's light slate blows out to white against the night city.
const MAP_NEUTRAL = '#5d7096';

const factionOf = (f) => FACTION[f] || FACTION.NEUTRAL;

/**
 * The player's real position as lat/lng, for proof-of-presence on spins and
 * gym battles. Null until the campus has a placed player, in which case the
 * legacy behaviour (the target's own coordinates) is used — that path is
 * demo-only and the server's geofence cannot verify it.
 */
function playerCoords() {
  const p = typeof campus?.getPlayer === 'function' ? campus.getPlayer() : null;
  if (!p || !fromWorld) return null;
  return fromWorld(p.x, p.z);
}

/**
 * The volunteer whose identity drives demo actions. Returns null and says so
 * when the roster has not loaded — every action used to `return` silently, so
 * clicking Claim or Contest before the first fetch resolved did nothing at all
 * with no indication why.
 */
function actingVolunteer() {
  const u = window.Nexus?.session?.user;
  if (u) return sessionAsVolunteer(u);
  // Legacy fallback — dies in M5 with the role router: with no session (the
  // server in AUTH_MODE=legacy and no dev-login), act as the first roster entry.
  if (volunteersCache.length === 0) {
    logChaosTerminal('[ERROR] No volunteers loaded yet — wait for the roster to sync.');
    return null;
  }
  return volunteersCache[0];
}

/** `/me` speaks `id`/`displayName`; the roster code below speaks `_id`/`name`. */
function sessionAsVolunteer(u) {
  return { ...u, _id: u.id, name: u.displayName || u.name || 'Trainer' };
}
const mapColorOf = (f) => (f === 'NEUTRAL' || !FACTION[f] ? MAP_NEUTRAL : FACTION[f].color);

/** Sprite icon per rarity — names resolve against the sprite table in `sprites.js`. */
const RARITY_ICON = {
  COMMON: 'box', UNCOMMON: 'gift', RARE: 'star', EPIC: 'zap', LEGENDARY: 'star', MYTHIC: 'flag',
};

/** 8×8 pixel icon from sprites.js; `sm` in cls means 2× instead of 3×. */
const icon = (name, cls = 'icon') =>
  (window.Sprites ? window.Sprites.img(name, /\bsm\b/.test(cls) ? 2 : 3, 'pxi', '') : '');

/** Stamps every static `<img data-sprite>` in the page with its data URL. */
function hydrateSprites(root = document) {
  if (!window.Sprites) return;
  root.querySelectorAll('img[data-sprite]').forEach((img) => {
    img.src = window.Sprites.url(img.dataset.sprite, Number(img.dataset.scale) || 3);
  });
}

/** Splits a Date into the pieces the shift card's time block lays out. */
function timeParts(iso) {
  const d = new Date(iso);
  const hh = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  // "08:00 AM" → ["08:00", "AM"]; locales without a dayPeriod fall back cleanly.
  const [clock, period = ''] = hh.split(' ');
  return { clock, period };
}

const hhmm = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Formats a count for display. Calling .toLocaleString() straight off the
 * payload throws when a field is absent, and because these sit inside template
 * literals one missing value aborted the whole list render — a single
 * volunteer without karmaPoints blanked the entire leaderboard.
 */
const num = (v) => (Number.isFinite(v) ? v : 0).toLocaleString();

/** A ring of 24 pixel pips; the first round(pct/100·24) light up. */
function paintRing(id, pct, pips = 24) {
  const ring = document.getElementById(id);
  if (!ring) return;
  if (ring.querySelectorAll('i').length !== pips) {
    ring.querySelectorAll('i').forEach((n) => n.remove());
    for (let k = 0; k < pips; k++) {
      const a = (k / pips) * Math.PI * 2 - Math.PI / 2;
      const i = document.createElement('i');
      i.style.left = `${50 + 46 * Math.cos(a)}%`;
      i.style.top = `${50 + 46 * Math.sin(a)}%`;
      ring.appendChild(i);
    }
  }
  const lit = Math.round((Math.max(0, Math.min(100, pct)) / 100) * pips);
  ring.querySelectorAll('i').forEach((i, k) => i.classList.toggle('on', k < lit));
}

/** Rewrites a metric tile's value and flashes it when it actually changed. */
function setMetric(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const next = String(value);
  if (el.innerText === next) return;
  el.innerText = next;
  const tile = el.closest('.metric-item');
  if (tile) {
    tile.classList.remove('tick');
    void tile.offsetWidth; // restart the animation
    tile.classList.add('tick');
  }
}

/* ------------------------------------------------------------------ *
 * Terminals
 * ------------------------------------------------------------------ */

/** Colours a bracketed [TAG] prefix so logs scan at a glance. */
const TAG_CLASS = {
  EVENT: 'hi', SSE: 'hi', LOCK: 'hi', DETAILS: 'hi',
  CASCADE: 'ok', 'CHECK-IN': 'ok', RESOLVED: 'ok', DEPLOYED: 'ok', VERIFIED: 'ok',
  SURGE: 'warn', CHAOS: 'warn', ADONIX: 'warn',
  ERROR: 'err', SOS: 'err', DISPATCH: 'err',
  GYM: 'mag', TARJAN: 'mag', HACKSTOP: 'mag',
};

function writeTerminal(id, msg) {
  const term = document.getElementById(id);
  if (!term) return;
  const time = new Date().toLocaleTimeString();
  const safe = esc(msg).replace(/\[([A-Z][A-Z -]*)\]/g, (m, tag) => {
    const key = Object.keys(TAG_CLASS).find((k) => tag.startsWith(k));
    return key ? `<span class="${TAG_CLASS[key]}">[${tag}]</span>` : m;
  });
  if (term.classList.contains('ticker')) {
    // Ticker: newest item first, one 8×8 icon per tag, at most eight in view.
    const tag = (msg.match(/^\[([A-Z][A-Z -]*)\]/) || [])[1] || '';
    const key = Object.keys(TAG_CLASS).find((k) => tag.startsWith(k));
    const iconFor = { EVENT: 'radio', SSE: 'radio', LOCK: 'lock', DETAILS: 'inbox', CASCADE: 'refresh', 'CHECK-IN': 'check', RESOLVED: 'check', DEPLOYED: 'zap', VERIFIED: 'shield', SURGE: 'zap', CHAOS: 'alert', ADONIX: 'cpu', ERROR: 'alert', SOS: 'heart', DISPATCH: 'walk', GYM: 'flag', TARJAN: 'gear', HACKSTOP: 'gift' };
    const item = document.createElement('span');
    item.className = `tick-item ${key ? TAG_CLASS[key] : ''}`;
    item.innerHTML = `${icon(iconFor[key] || 'activity', 'icon sm')}<span>${safe}</span>`;
    term.prepend(item);
    while (term.children.length > 8) term.lastElementChild.remove();
    return;
  }
  // Keep the buffer bounded — an all-night event would otherwise grow forever.
  const lines = (`<span class="ts">${time}</span>  ${safe}\n` + term.innerHTML).split('\n');
  term.innerHTML = lines.slice(0, 300).join('\n');
}

const logChaosTerminal = (msg) => { writeTerminal('chaos-terminal', msg); writeTerminal('stream-terminal', msg); };
const logSosTerminal = (msg) => writeTerminal('sos-terminal', msg);
const logQrTerminal = (msg) => writeTerminal('qr-terminal', msg);

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

/**
 * The six shell tabs, registered with the Nexus registry (nexus.js renders the
 * nav from it and owns activation — `switchTab` is gone; `Nexus.showTab(id)`
 * replaces it and `window.switchTab` survives one release as a warning alias).
 * `roles` stays empty until the role router lands in M5: everyone sees every tab.
 */
Nexus.registerTab({ id: 'tab-shifts', label: 'War Room', order: 10 });
Nexus.registerTab({ id: 'tab-campus', label: 'Campus', order: 20, onShow: () => bootCampus() });
Nexus.registerTab({
  id: 'tab-pokeshift', label: 'Turf Wars', order: 30,
  onShow: () => { loadGymsData(); loadHackStopsData(); loadUserInventory(); },
});
Nexus.registerTab({
  id: 'tab-qr', label: 'Trainer', order: 40,
  onShow: () => { if (shiftsCache.length > 0 && !currentQrShiftId) setupDefaultQr(); },
});
Nexus.registerTab({ id: 'tab-chaos', label: 'Chaos Lab', order: 50 });
Nexus.registerTab({ id: 'tab-leaderboard', label: 'Ranks', order: 60 });
Nexus.onEvent('tab', ({ id }) => window.game?.onTabChange(id));

document.getElementById('sound-toggle-btn')?.addEventListener('click', (e) => {
  if (!window.soundEngine) return;
  const on = (window.soundEngine.enabled = !window.soundEngine.enabled);
  e.currentTarget.textContent = on ? 'Audio On' : 'Audio Off';
  e.currentTarget.setAttribute('aria-pressed', String(on));
});

/* ------------------------------------------------------------------ *
 * Delegated actions
 * ------------------------------------------------------------------ */

/**
 * One delegated listener for every button the renderers emit, keyed on
 * `data-action`.
 *
 * The rows below used to be built as `onclick="fn('${esc(id)}')"`. Escaping does
 * not make that safe: the HTML parser decodes `&#39;` back to a real apostrophe
 * before the JS in the attribute is ever parsed, so an escaped quote still
 * terminates the string literal. Nothing was exploitable — every value there is
 * a server-generated ObjectId or a seeded constant, and no endpoint lets a
 * client name a gym or a beacon — but the safety depended on that coincidence.
 * `data-*` attributes read through `dataset` are never parsed as code, so this
 * removes the hazard instead of relying on the inputs staying benign.
 */
const CLICK_ACTIONS = {
  claim: (el) => quickSignUp(el.dataset.id, el),
  details: (el) => viewShiftDetails(el.dataset.id),
  dispatch: (el) => dispatchNearestVolunteer(el.dataset.id, el),
  encounter: (el) => (window.game ? window.game.openEncounter(el.dataset.id) : battleOrFortifyGym(el.dataset.id, el)),
  locate: (el) => { Nexus.showTab('tab-campus'); focusMonument(el.dataset.venue); },
  deploy: (el) => deployPowerUp(el.dataset.item, el),
  spin: (el) => spinHackStop(
    el.dataset.beacon,
    Number(el.dataset.lat),
    Number(el.dataset.lon),
    el
  ),

  // --- static shell controls -------------------------------------------------
  // These were inline `onclick=` attributes until they stopped firing: Helmet's
  // default CSP sends `script-src-attr 'none'`, which neutralises inline event
  // handlers even though `script-src` allows 'unsafe-inline'. The result was that
  // every tab and every demo button was inert while the dynamically rendered
  // buttons above kept working, because those go through this delegated listener.
  // Routing the shell through the same map fixes it without weakening the CSP.
  'adonix-sync': () => triggerAdonixSync(),
  'sos-simulate': () => simulateHackerSOS(),
  'sos-refresh': () => loadSOSTickets(),
  'chaos-bomb': () => runConcurrencyBomb(),
  'chaos-drop': () => simulateDropCascade(),
  'chaos-cycle': () => resolveCyclicTrade(),
  'qr-scan': () => simulateDeskScan(),
  'qr-replay': () => simulateReplayAttack(),
  'loot-close': () => closeLootModal(),
  'campus-reset': () => campusResetView(),
  'campus-cinema': () => toggleCinema(),
  'gyms-refresh': () => loadGymsData(),
  'stops-refresh': () => loadHackStopsData(),
};

// The one delegated click listener lives in nexus.js; the map above is just
// registered into it. (`tab` is registered by nexus.js itself.) Registration
// order matters for `encounter`: game.js registered its own first, this one
// wins and adds the no-renderer fallback.
for (const [name, handler] of Object.entries(CLICK_ACTIONS)) Nexus.registerAction(name, handler);

/**
 * Delegated `change` handling, for the same CSP reason as the click map above:
 * inline `onchange=` is an event-handler attribute and is blocked identically.
 */
const CHANGE_ACTIONS = {
  faction: (el) => changeUserFaction(el.value),
};

document.addEventListener('change', (event) => {
  const el = event.target.closest('[data-action-change]');
  if (!el) return;
  CHANGE_ACTIONS[el.dataset.actionChange]?.(el);
});

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.message || `GET ${path} failed`);
  return json.data;
}

async function fetchVolunteers() {
  try {
    volunteersCache = await apiGet('/api/v1/volunteers');
  } catch (err) {
    console.error('Error fetching volunteers:', err);
  }
}

async function fetchShifts() {
  try {
    shiftsCache = await apiGet('/api/v1/shifts');
    renderShifts(shiftsCache);
    syncCampusActors();
  } catch (err) {
    console.error('Error fetching shifts:', err);
  }
}

/** Rolling samples of total karma this session, for the sparkline. */
const karmaSeries = [];
const KARMA_SAMPLES = 24;

async function fetchStats() {
  try {
    const d = await apiGet('/api/v1/stats/operations');
    setMetric('hud-total-shifts', d.totalShifts);
    setMetric('hud-fill-rate', `${d.overallFillRatePercent}%`);
    setMetric('hud-total-karma', num(d.totalKarmaAwarded));

    // Coverage ring: the arc is a circle of r=42, circumference 263.9.
    const pct = Math.max(0, Math.min(100, Number(d.overallFillRatePercent) || 0));
    const coverage = document.getElementById('vital-coverage');
    if (coverage) coverage.innerText = Math.round(pct);
    paintRing('coverage-ring', pct);

    // Karma over the session: a sample per stats poll, bars scaled to range.
    const total = Number(d.totalKarmaAwarded) || 0;
    if (karmaSeries.length === 0 || karmaSeries[karmaSeries.length - 1] !== total) {
      karmaSeries.push(total);
      if (karmaSeries.length > KARMA_SAMPLES) karmaSeries.shift();
    }
    const delta = document.getElementById('karma-delta');
    if (delta) {
      const gained = total - karmaSeries[0];
      delta.innerText = `${gained >= 0 ? '+' : ''}${num(gained)}`;
    }
    const spark = document.getElementById('karma-spark');
    if (spark) {
      const n = KARMA_SAMPLES;
      const lo = Math.min(...karmaSeries), hi = Math.max(...karmaSeries);
      const span = Math.max(1, hi - lo);
      const w = 120 / n, gap = 1.5;
      // Always draw all 24 slots: a young session shows a flat baseline with
      // only the newest sample lit, rather than a lone dot at the right edge.
      const pad = n - karmaSeries.length;
      spark.innerHTML = Array.from({ length: n }, (_, k) => {
        const i = k - pad;
        const has = i >= 0;
        const v = has ? karmaSeries[i] : lo;
        const h = has ? 4 + ((v - lo) / span) * 28 : 3;
        const last = has && i === karmaSeries.length - 1;
        return `<rect x="${(k * w).toFixed(1)}" y="${(32 - h).toFixed(1)}" width="${(w - gap).toFixed(1)}" height="${h.toFixed(1)}" rx="1" class="${last ? '' : 'dim'}"/>`;
      }).join('');
    }

    const waitlist = document.getElementById('vital-waitlist');
    if (waitlist) {
      waitlist.innerText = shiftsCache.reduce((n, s) => n + (s.waitlistCount || 0), 0);
    }

    // Derived, not hardcoded: a shift whose filled count exceeds its capacity
    // is an oversell. The tile previously displayed a literal 0 forever, which
    // would have reported "no overbooking" even while overbooking.
    const overbooks = document.getElementById('vital-overbooks');
    if (overbooks) {
      const breaches = shiftsCache.reduce(
        (n, s) => n + Math.max(0, (s.filledSlots || 0) - (s.capacity || 0)), 0
      );
      overbooks.innerText = breaches;
      overbooks.closest('.stat')?.classList.toggle('c-danger', breaches > 0);
    }
  } catch (err) {
    console.error('Error fetching stats:', err);
  }
}

async function fetchLeaderboard() {
  try {
    renderLeaderboard(await apiGet('/api/v1/stats/leaderboard'));
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
  }
}

async function viewShiftDetails(shiftId) {
  try {
    const shift = await apiGet(`/api/v1/shifts/${encodeURIComponent(shiftId)}`);
    const confirmed = (shift.confirmedVolunteers || []).length;
    const waitlisted = (shift.waitlistedVolunteers || []).length;
    logChaosTerminal(
      `[DETAILS] "${shift.title}" @ ${shift.location} — ${shift.filledSlots}/${shift.capacity} filled, ${confirmed} confirmed, ${waitlisted} waitlisted`
    );
  } catch (err) {
    logChaosTerminal(`[ERROR] Could not load shift: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Renderers
 * ------------------------------------------------------------------ */

function renderShifts(shifts) {
  const container = document.getElementById('shifts-grid');
  if (!container) return;

  const venues = new Set(shifts.map((s) => s.location));
  const vc = document.getElementById('venue-count');
  if (vc) vc.innerText = `${venues.size} venue${venues.size === 1 ? '' : 's'}`;

  if (shifts.length === 0) {
    container.innerHTML = `<div class="empty-state">${icon('clock')}<div>No quests posted yet.</div></div>`;
    return;
  }

  const sorted = [...shifts].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const questIcon = (title = '') => {
    const t = title.toLowerCase();
    if (/food|coffee|snack|catering|meal/.test(t)) return 'coffee';
    if (/check|desk|registration|badge/.test(t)) return 'check';
    if (/security|door|guard|night/.test(t)) return 'shield';
    if (/hardware|lab|tech|help|mentor/.test(t)) return 'cpu';
    if (/judg|demo|expo|ceremony/.test(t)) return 'star';
    if (/clean|teardown|setup|logistics/.test(t)) return 'box';
    return 'flag';
  };

  container.innerHTML = sorted.map((shift) => {
    const cap = Math.max(1, shift.capacity | 0);
    const filled = Math.max(0, shift.filledSlots | 0);
    const mult = shift.surge ? Number(shift.surge.surgeMultiplier) : 1;
    const isSurge = mult >= 1.3;
    const karma = shift.surge ? shift.surge.karmaAward : shift.baseKarma;
    const full = filled >= cap;
    const start = timeParts(shift.startTime);
    const end = timeParts(shift.endTime);

    // One segment per slot reads as real meaning; past twelve slots a bar is
    // clearer than a picket fence.
    const capacity = cap <= 12
      ? `<div class="seg ${full ? 'is-full' : ''}">${Array.from({ length: cap }, (_, k) => `<i class="${k < filled ? 'on' : ''}"></i>`).join('')}</div>`
      : `<div class="pxbar"><i style="width:${Math.min(100, (filled / cap) * 100)}%"></i></div>`;
    const sticker = full ? '<span class="sticker full qstick">Full</span>'
      : isSurge ? `<span class="sticker qstick" title="Surge multiplier">×${mult.toFixed(mult % 1 ? 2 : 0)} surge</span>` : '';

    return `
      <article class="px quest" id="shift-card-${esc(shift._id)}">
        ${sticker}
        <div class="qicon" aria-hidden="true">${icon(questIcon(shift.title))}</div>
        <div class="qbody">
          <div class="qtop">
            <div style="min-width:0">
              <div class="qtitle">${esc(shift.title)}</div>
              <div class="qvenue">${icon('pin', 'icon sm')}<span>${esc(shift.location)}</span></div>
            </div>
          </div>
          <div class="qtime"><span><b>${esc(start.clock)}</b> ${esc(start.period)}</span><span>→</span><span><b>${esc(end.clock)}</b> ${esc(end.period)}</span></div>
          <div class="qrow">
            <div>
              ${capacity}
              <div class="seg-label">
                <span>${filled}/${cap} party${shift.waitlistCount ? ` <span class="wait">· ${Number(shift.waitlistCount) || 0} waiting</span>` : ''}</span>
              </div>
            </div>
            <div class="big-num" style="color:var(--harvest)">+${num(karma)}<span class="hud-label" style="display:block;text-align:right">karma</span></div>
          </div>
          <div class="btn-row">
            <button class="pb ${full ? 'pb-ghost' : ''} pb-sm" data-action="claim" data-id="${esc(shift._id)}">${full ? 'Join waitlist' : 'Accept quest'}</button>
            <button class="link" data-action="details" data-id="${esc(shift._id)}">Details</button>
          </div>
        </div>
      </article>`;
  }).join('');
}

/** "NEOPHYTE_PLANKTON" → "Neophyte Plankton". Enum names are not copy. */
const humanise = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

function renderLeaderboard(entries) {
  const tbody = document.getElementById('leaderboard-body');
  const mini = document.getElementById('mini-leaderboard');
  const max = Math.max(1, ...entries.map((e) => Number(e.karmaPoints) || 0));
  const pct = (e) => ((Number(e.karmaPoints) || 0) / max * 100).toFixed(1);
  const lvl = (e) => (window.game ? window.game.levelFor(Number(e.karmaPoints) || 0) : 1);

  if (tbody) {
    tbody.innerHTML = entries.map((e) => `
      <tr class="${e.rank === 1 ? 'is-top' : ''}">
        <td><span class="rank-pill">${Number(e.rank) || 0}</span></td>
        <td>${icon('trainer')}</td>
        <td><strong>${esc(e.name)}</strong><div class="hud-label">Lv ${lvl(e)}</div></td>
        <td><span class="tier">${esc(humanise(e.prestigeTier))}</span></td>
        <td class="num muted">${esc(e.hoursServed)} h</td>
        <td class="karma-col">
          <div class="karma-cell">
            <span class="num">${num(e.karmaPoints)}</span>
            <div class="pxbar lb-bar"><i style="width:${pct(e)}%"></i></div>
          </div>
        </td>
        <td>${(e.badges || []).map((b) => `<span class="badge-tag">${esc(humanise(b))}</span>`).join('')}</td>
      </tr>`).join('');
  }

  if (mini) {
    mini.innerHTML = entries.slice(0, 5).map((e) => `
      <div class="rank-row ${e.rank === 1 ? 'is-top' : ''}">
        <span class="rk">${String(e.rank).padStart(2, '0')}</span>
        <span>${icon('trainer', 'icon sm')}</span>
        <div style="min-width:0">
          <div class="nm">${esc(e.name)}</div>
          <div class="tier">Lv ${lvl(e)} · ${esc(humanise(e.prestigeTier))}</div>
        </div>
        <div class="pxbar"><i style="width:${pct(e)}%"></i></div>
        <span class="kp">${num(e.karmaPoints)}</span>
      </div>`).join('');
  }
}

function renderSOSTicketsList(tickets) {
  const container = document.getElementById('sos-tickets-container');
  const vital = document.getElementById('vital-sos');
  if (vital) vital.innerText = tickets.length;
  if (!container) return;

  if (tickets.length === 0) {
    container.innerHTML = `<div class="empty-state">${icon('duck', 'icon')}<div>Nothing on fire. The duck is napping. Go hold a gym.</div></div>`;
    return;
  }

  container.innerHTML = tickets.map((t) => {
    const critical = t.urgency === 'CRITICAL' || t.urgency === 'HIGH';
    const c = critical ? 'var(--danger)' : 'var(--warn)';
    return `
      <div class="sos ${critical ? 'urgent' : ''}" style="--c:${c}">
        <span class="sos-dot" aria-hidden="true"></span>
        <div style="min-width:0">
          <div class="sos-who">${esc(t.hackerName)}</div>
          <div class="sos-where">${esc(t.tableLocation)} · ${esc(String(t.category || '').replace(/_/g, ' ').toLowerCase())}</div>
          <div class="sos-desc">${esc(t.description)}</div>
        </div>
        <div class="sos-side">
          <span class="sos-urg">${esc(t.urgency)}</span>
          <span class="sos-bounty">+${num(t.karmaBounty)} karma</span>
          <button class="pb pb-sm ${critical ? 'pb-danger' : 'pb-ghost'}" data-action="dispatch" data-id="${esc(t._id)}">Dispatch</button>
        </div>
      </div>`;
  }).join('');
}

function renderFactionStrip() {
  const strip = document.getElementById('faction-strip');
  if (!strip) return;
  const tally = {};
  for (const g of gymsCache) {
    const k = FACTION[g.controllingFaction] ? g.controllingFaction : 'NEUTRAL';
    tally[k] ??= { held: 0, cp: 0 };
    tally[k].held += 1;
    tally[k].cp += Number(g.controlPoints) || 0;
  }
  strip.innerHTML = ['TEAM_KERNEL', 'TEAM_TENSOR', 'TEAM_SILICON', 'NEUTRAL'].map((k) => {
    const f = FACTION[k];
    const t = tally[k] || { held: 0, cp: 0 };
    return `
      <div class="faction-cell" style="--c:${f.color}">
        <span class="fmark" aria-hidden="true"></span>
        <div>
          <div class="label">${esc(f.short)}</div>
          <div class="n"><b>${t.held}</b><span>held · ${num(t.cp)} CP</span></div>
        </div>
      </div>`;
  }).join('');
}

function renderGymsList() {
  const container = document.getElementById('gyms-list-container');
  if (!container) return;
  renderFactionStrip();

  if (gymsCache.length === 0) {
    container.innerHTML = `<div class="empty-state">${icon('flag')}<div>No territory data. Seed the database to start the turf war.</div></div>`;
    return;
  }

  container.innerHTML = gymsCache.map((g) => {
    const f = factionOf(g.controllingFaction);
    const pct = Math.max(0, Math.min(100, Math.round((g.controlPoints / (g.maxControlPoints || 1)) * 100) || 0));
    const ally = g.controllingFaction === currentVolunteerFaction || g.controllingFaction === 'NEUTRAL';
    const defenders = (g.defenders || []).length;
    const mon = monumentForGym(g);

    return `
      <article class="px gym ${g.isShielded ? 'is-shielded' : ''}" style="--c:${f.color}" data-action="encounter" data-id="${esc(g._id)}" role="button" tabindex="0">
        <div class="gart" aria-hidden="true">${icon(mon?.kind || 'hall', 'icon sm')}</div>
        <div style="min-width:0">
          <div class="gym-name" title="${esc(g.name)}">${esc(g.locationName)}</div>
          <div class="gym-sub">
            <span class="f">${esc(f.short)}</span><span class="dot"></span>
            <span class="d">${defenders} defending</span><span class="dot"></span>
            <span class="d">Lv ${Number(g.level) || 1}</span>
            ${g.isShielded ? `<span class="dot"></span><span class="d" style="color:var(--live)">shielded</span>` : ''}
          </div>
        </div>
        <div class="gym-cp">
          <div class="pxbar"><i style="width:${pct}%;background:${f.color}"></i></div>
          <div class="cp-row"><span>${num(g.controlPoints)} CP</span><span class="max">${num(g.maxControlPoints)}</span></div>
        </div>
        <div class="gym-actions">
          <button class="pb pb-sm ${ally ? 'pb-patina' : ''}" data-action="encounter" data-id="${esc(g._id)}">${ally ? 'Reinforce' : 'Contest'}</button>
          <button class="pb pb-ghost pb-sm" data-action="locate" data-venue="${esc(g.locationName)}" aria-label="Locate ${esc(g.locationName)} on the map">${icon('crosshair', 'icon sm')}</button>
        </div>
      </article>`;
  }).join('');
}

function renderHackStopsList() {
  const markup = hackStopsCache.length === 0
    ? `<div class="empty-state">${icon('radio')}<div>No beacons deployed.</div></div>`
    : hackStopsCache.map((stop) => `
        <div class="stop" data-beacon-row="${esc(stop.beaconId)}">
          <span aria-hidden="true">${icon('gift')}</span>
          <div style="min-width:0">
            <div class="name">${esc(stop.name)}</div>
            <div class="where">${esc(stop.locationName)}</div>
          </div>
          <span class="dist" data-dist>${Number(stop.geofenceRadiusMeters) || 75} m</span>
          <button class="pb pb-ghost pb-sm" data-action="spin" data-beacon="${esc(stop.beaconId)}" data-lat="${Number(stop.latitude)}" data-lon="${Number(stop.longitude)}" disabled title="Walk to within 75 m to spin">Spin</button>
        </div>`).join('');

  // The beacon list appears on both the campus and turf-wars tabs.
  for (const id of ['hackstops-list-container', 'hackstops-mirror']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = markup;
  }
  window.game?.gateSpins();
}

function renderUserInventory() {
  const container = document.getElementById('inventory-list-container');
  const count = document.getElementById('inv-count');
  if (count) {
    const total = userInventoryCache.reduce((n, i) => n + (i.quantity | 0), 0);
    count.innerText = `${total} item${total === 1 ? '' : 's'}`;
  }
  if (!container) return;

  if (userInventoryCache.length === 0) {
    container.innerHTML = `<div class="empty-state">${icon('gift')}<div>Bag empty. Spin a campus HackStop to find power-ups.</div></div>`;
    return;
  }

  container.innerHTML = userInventoryCache.map((item) => `
    <div class="inv-tile rarity-${esc(item.rarity)}">
      <div class="inv-glyph" aria-hidden="true">${icon(RARITY_ICON[item.rarity] || 'gift')}</div>
      <div style="min-width:0">
        <div class="inv-name">${esc(item.name)}</div>
        <div class="inv-rarity">${esc(item.rarity)}</div>
      </div>
      <span class="inv-count">×${item.quantity | 0}</span>
      <button class="pb pb-ghost pb-sm" data-action="deploy" data-item="${esc(item.itemType)}">Deploy</button>
    </div>`).join('');
}

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */


/**
 * Coalesces bursts of refetches into one request per window.
 *
 * Every SSE event used to trigger its own fetch: a 50-worker concurrency bomb
 * emits ~100 SLOT_RESERVED / WAITLIST_JOINED events in under a second, which
 * became ~100 GET /shifts in the same second and tripped the API's 300/min
 * limiter — on the dashboard's own traffic. Coalescing to at most one call per
 * 250 ms window keeps the UI current without the self-inflicted 429 storm.
 */
function coalesce(fn, ms = 250) {
  let timer = null;
  let pending = false;
  return () => {
    pending = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending) { pending = false; fn(); }
    }, ms);
  };
}

const refresh = {
  shifts: coalesce(fetchShifts),
  stats: coalesce(fetchStats),
  leaderboard: coalesce(fetchLeaderboard),
  sos: coalesce(loadSOSTickets),
  gyms: coalesce(loadGymsData),
  hackstops: coalesce(loadHackStopsData),
  inventory: coalesce(loadUserInventory),
};

let sseRetryMs = 1000;

/** Maps the legacy colour classes callers pass to the signal variants. */
const signalClass = (cls = '') =>
  /amber|warn/.test(cls) ? 'signal is-warn' : /hazard|danger/.test(cls) ? 'signal is-danger' : /dim|quiet/.test(cls) ? 'signal is-quiet' : 'signal';

function setSseStatus(text, cls) {
  const el = document.getElementById('sse-status');
  if (el) { el.innerText = text; el.className = signalClass(cls); }
  const c = document.getElementById('sse-clients');
  if (c) { c.innerText = text; c.className = signalClass(cls); }
}

function connectSSE() {
  const eventSource = new EventSource('/api/v1/stats/events');

  // Reconnect with backoff — one failed stream used to mean a permanently
  // dead dashboard with no visible sign that it had stopped updating.
  eventSource.onopen = () => {
    sseRetryMs = 1000;
    setSseStatus('SSE Live', 'c-mint');
  };
  eventSource.onerror = () => {
    eventSource.close();
    const wait = Math.min(30000, sseRetryMs);
    sseRetryMs = Math.min(30000, sseRetryMs * 2);
    setSseStatus('Reconnecting', 'c-amber');
    logChaosTerminal(`[SSE] Stream lost — reconnecting in ${wait / 1000}s…`);
    setTimeout(connectSSE, wait);
  };

  const on = (name, fn) => eventSource.addEventListener(name, (e) => {
    let payload = {};
    try { payload = JSON.parse(e.data); } catch { /* keep-alive or malformed frame */ }
    fn(payload);
  });

  on('SLOT_RESERVED', (p) => {
    window.soundEngine?.playSonarPing();
    logChaosTerminal(`[EVENT] Slot reserved on shift ${p.shiftId} by ${p.volunteerName}`);
    refresh.shifts();
    refresh.stats();
  });

  on('WAITLIST_JOINED', (p) => {
    logChaosTerminal(`[EVENT] Waitlist joined on shift ${p.shiftId}: ${p.volunteerName} (position #${p.waitlistPosition})`);
    refresh.shifts();
  });

  on('WAITLIST_PROMOTED', (p) => {
    window.soundEngine?.playCascadeChime();
    logChaosTerminal(`[CASCADE] ${p.volunteerName} atomically promoted from waitlist to CONFIRMED`);
    refresh.shifts();
    refresh.stats();
  });

  on('VOLUNTEER_CHECKED_IN', (p) => {
    window.soundEngine?.playSonarPing();
    logChaosTerminal(`[CHECK-IN] ${p.volunteerName} checked in to "${p.shiftTitle}"`);
    refresh.stats();
  });

  on('VOLUNTEER_CHECKED_OUT', () => { refresh.stats(); refresh.leaderboard(); });

  on('SOS_TICKET_CREATED', (p) => {
    window.soundEngine?.playSosAlarm();
    logSosTerminal(`[SOS] ${p.hackerName} reported ${p.category} at ${p.tableLocation} (+${p.karmaBounty} karma)`);
    refresh.sos();
  });

  on('SOS_TICKET_DISPATCHED', (p) => {
    window.soundEngine?.playDispatchChime();
    logSosTerminal(`[DISPATCH] ${p.volunteerName} en route to ${p.hackerName} (${p.distanceMeters}m away)`);
    refresh.sos();
  });

  on('SOS_TICKET_RESOLVED', (p) => {
    logSosTerminal(`[RESOLVED] Ticket ${String(p.ticketId).slice(-6)} closed by ${p.volunteerName}. +${p.karmaAwarded} karma`);
    refresh.sos();
    refresh.leaderboard();
  });

  on('ADONIX_EVENTS_SYNCED', (p) => {
    logChaosTerminal(`[ADONIX] ${p.syncedCount} official HackIllinois shifts synchronised`);
    refresh.shifts();
    refresh.stats();
  });

  on('GYM_REINFORCED', () => refresh.gyms());
  on('GYM_ATTACKED', () => refresh.gyms());
  on('GYM_CAPTURED', (p) => {
    window.soundEngine?.playGymVictoryFanfare();
    logChaosTerminal(`[GYM CAPTURED] ${p.gymName || 'A stronghold'} changed hands`);
    refresh.gyms();
  });
  on('HACKSTOP_SPUN', () => { refresh.hackstops(); refresh.inventory(); });
  on('POWERUP_CONSUMED', () => { refresh.inventory(); refresh.gyms(); });
}

/* ------------------------------------------------------------------ *
 * Chaos lab
 * ------------------------------------------------------------------ */

const WORKERS = 50;
const CAPACITY = 2;

async function runConcurrencyBomb() {
  logChaosTerminal(`[CHAOS] Priming ${WORKERS} concurrent workers against a ${CAPACITY}-slot shift…`);
  window.soundEngine?.playSurgeAlert();

  try {
    const shiftData = await Nexus.api('/api/v1/shifts', {
      method: 'POST',
      body: {
        title: 'Contested Pizza Station (HOT)',
        description: 'High contention shift to benchmark atomic locks',
        category: 'FOOD',
        location: 'Siebel 1st Floor East',
        startTime: new Date(Date.now() + 3600000).toISOString(),
        endTime: new Date(Date.now() + 7200000).toISOString(),
        capacity: CAPACITY,
        baseKarma: 150,
      },
    });
    const testShiftId = shiftData.data._id;

    // Fifty *distinct* contenders. Recycling the five seeded volunteers made
    // 45 of the 50 requests bounce off the duplicate-registration guard, so
    // the run proved nothing about the lock and reported the rejections as
    // "oversold". Each worker now races as its own volunteer.
    logChaosTerminal('[CHAOS] Provisioning 50 distinct workers…');
    const stamp = Date.now();
    const workers = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        Nexus.api('/api/v1/volunteers', {
          method: 'POST',
          body: {
            name: `Load Worker ${i + 1}`,
            email: `worker.${stamp}.${i}@bomb.test`,
            certifications: [],
          },
          lenient: true,
        })
      )
    );
    const workerIds = workers.filter((w) => w.success).map((w) => w.data._id);
    if (workerIds.length < WORKERS) {
      logChaosTerminal(`[CHAOS] Only ${workerIds.length}/${WORKERS} workers provisioned; racing with those.`);
    }

    logChaosTerminal(`[CHAOS] Contested shift created (capacity ${CAPACITY}). Releasing ${workerIds.length} workers…`);

    const start = performance.now();
    const responses = await Promise.all(
      workerIds.map((volunteerId, i) =>
        Nexus.api('/api/v1/registrations', {
          method: 'POST',
          headers: { 'idempotency-key': `concurrency_bomb_${stamp}_worker_${i}` },
          body: { shiftId: testShiftId, volunteerId },
          lenient: true,
        })
      )
    );
    const elapsed = (performance.now() - start).toFixed(1);

    const confirmed = responses.filter((r) => r.status === 'CONFIRMED').length;
    const waitlisted = responses.filter((r) => r.status === 'WAITLISTED').length;
    const rejected = responses.filter((r) => !r.success).length;
    // The invariant under test: the lock must never hand out more confirmed
    // slots than the shift has capacity. Anything else is a rejection, not a
    // sale, and reporting the two together is what hid this for so long.
    const oversold = Math.max(0, confirmed - CAPACITY);

    logChaosTerminal(`[CHAOS] ${responses.length} workers settled in ${elapsed}ms`);
    logChaosTerminal(`         confirmed   ${confirmed}   (capacity ${CAPACITY})`);
    logChaosTerminal(`         waitlisted  ${waitlisted}`);
    logChaosTerminal(`         rejected    ${rejected}`);
    logChaosTerminal(`         OVERSOLD    ${oversold}   (invariant: 0)`);

    if (oversold === 0 && confirmed === CAPACITY) {
      logChaosTerminal('[VERIFIED] Exactly capacity confirmed, zero oversell — the atomic CAS held.');
      window.fx?.burst(window.innerWidth / 2, window.innerHeight / 2, '#34f5a0', 60);
    } else {
      logChaosTerminal(`[ERROR] Invariant violated: ${confirmed} confirmed against capacity ${CAPACITY}.`);
    }

    fetchShifts();
    fetchStats();
  } catch (err) {
    logChaosTerminal(`[ERROR] Concurrency bomb failed: ${err.message}`);
  }
}

async function simulateDropCascade() {
  logChaosTerminal('[CHAOS] Finding a confirmed registration to drop…');
  try {
    const res = await fetch('/api/v1/registrations?status=CONFIRMED');
    const json = await res.json();
    if (!json.success || json.data.length === 0) {
      logChaosTerminal('[CHAOS] No confirmed registrations available to drop.');
      return;
    }

    const target = json.data[0];
    logChaosTerminal(`[CHAOS] Cancelling registration for "${target.shiftId.title}"…`);

    const ownerId = target.volunteerId?._id ?? target.volunteerId;
    const dropJson = await Nexus.api(`/api/v1/registrations/${target._id}?volunteerId=${encodeURIComponent(ownerId)}`, { method: 'DELETE', lenient: true });

    if (dropJson.success) {
      if (dropJson.data.promoted) {
        logChaosTerminal(`[CASCADE] Waitlist candidate ${dropJson.data.promoted.volunteerId} atomically promoted to CONFIRMED`);
        window.soundEngine?.playCascadeChime();
      } else {
        logChaosTerminal('[CHAOS] Slot reopened — no waitlisted candidates to promote.');
      }
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] Drop cascade failed: ${err.message}`);
  }
}

async function resolveCyclicTrade() {
  logChaosTerminal('[TARJAN] Searching the trade graph for circular exchange dependencies…');
  try {
    const json = await Nexus.api('/api/v1/swaps/cycles/resolve', { method: 'POST', lenient: true });
    if (json.success) {
      const cycles = json.data.discoveredCycles;
      logChaosTerminal(`[TARJAN] Discovered ${cycles.length} elementary cycle(s).`);
      cycles.forEach((c) => logChaosTerminal(`         ring: ${c.join(' → ')} → ${c[0]}`));
      logChaosTerminal(`[TARJAN] Executed ${json.data.executedCount} atomic rotation(s) in one transaction.`);
      fetchShifts();
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] Cyclic trade resolution failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Rotating check-in token
 * ------------------------------------------------------------------ */

/**
 * Picks a volunteer/shift pair that can actually mint a token.
 *
 * Pairing volunteersCache[0] with shiftsCache[0] blindly meant the panel
 * usually opened on "volunteer does not hold a confirmed spot for this shift",
 * because the first volunteer is rarely registered for the first shift. The
 * server only issues tokens against a CONFIRMED registration, so ask it for one.
 */
async function setupDefaultQr() {
  if (volunteersCache.length === 0 || shiftsCache.length === 0) return;

  try {
    const res = await fetch('/api/v1/registrations?status=CONFIRMED');
    const json = await res.json();
    const reg = json.success && json.data.find((r) => r.volunteerId && r.shiftId);
    if (reg) {
      currentQrVolunteerId = reg.volunteerId._id ?? reg.volunteerId;
      currentQrShiftId = reg.shiftId._id ?? reg.shiftId;
      await refreshQrToken();
      return;
    }
  } catch (err) {
    logQrTerminal(`[ERROR] Could not look up a confirmed registration: ${err.message}`);
  }

  logQrTerminal('No confirmed registration yet — claim a shift on Shift Radar, then come back.');
}

async function refreshQrToken() {
  if (!currentQrVolunteerId || !currentQrShiftId) return;
  try {
    const json = await Nexus.api('/api/v1/attendance/token', { method: 'POST', body: { volunteerId: currentQrVolunteerId, shiftId: currentQrShiftId }, lenient: true });

    if (json.success) {
      currentQrToken = json.data.token;
      // Local-only render: never ship the live HMAC token to a third-party QR API.
      const local = document.getElementById('qr-local');
      if (local) local.innerText = currentQrToken;
      startQrCountdown(json.data.expiresInSeconds);
      logQrTerminal(`Token generated (slice ${json.data.timeSlice}) — ${currentQrToken.substring(0, 24)}…`);
    } else {
      logQrTerminal(`[ERROR] Token generation failed: ${json.message}`);
    }
  } catch (err) {
    logQrTerminal(`[ERROR] ${err.message}`);
  }
}

function startQrCountdown(seconds) {
  if (qrCountdownTimer) clearInterval(qrCountdownTimer);
  let remaining = seconds;
  const fill = document.getElementById('countdown-fill');
  const text = document.getElementById('countdown-text');

  qrCountdownTimer = setInterval(() => {
    remaining--;
    if (text) text.innerText = `Expires in ${remaining}s`;
    if (fill) {
      fill.style.width = `${Math.max(0, (remaining / 30) * 100)}%`;
      fill.classList.toggle('low', remaining <= 8);
    }
    if (remaining <= 0) {
      clearInterval(qrCountdownTimer);
      refreshQrToken();
    }
  }, 1000);
}

// The demo desk sits at the Siebel atrium; coordinates are mandatory server-side.
const DESK_COORDS = { latitude: 40.113812, longitude: -88.224937 };

async function simulateDeskScan() {
  if (!currentQrToken) { logQrTerminal('No active token to scan.'); return; }
  logQrTerminal('Scanning token at the check-in desk…');
  try {
    const json = await Nexus.api('/api/v1/attendance/verify', { method: 'POST', body: { token: currentQrToken, coordinates: DESK_COORDS }, lenient: true });
    if (json.success) {
      logQrTerminal('[VERIFIED] Check-in accepted — volunteer status CHECKED_IN.');
      window.soundEngine?.playSonarPing();
      window.fx?.burstAt(document.querySelector('.qr-box'), '#34f5a0', 34);
      fetchStats();
    } else {
      logQrTerminal(`[ERROR] Verification rejected: ${json.message}`);
    }
  } catch (err) {
    logQrTerminal(`[ERROR] ${err.message}`);
  }
}

async function simulateReplayAttack() {
  if (!currentQrToken) return;
  logQrTerminal('Re-submitting an already-scanned token…');
  try {
    const json = await Nexus.api('/api/v1/attendance/verify', { method: 'POST', body: { token: currentQrToken, coordinates: DESK_COORDS }, lenient: true });
    if (!json.success && json.error === 'REPLAY_ATTACK_DETECTED') {
      logQrTerminal('[VERIFIED] Replay detected and rejected.');
    } else {
      logQrTerminal(`Outcome: ${JSON.stringify(json)}`);
    }
  } catch (err) {
    logQrTerminal(`[ERROR] ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function quickSignUp(shiftId, btn) {
  const vol = actingVolunteer();
  if (!vol) return;
  try {
    const json = await Nexus.api('/api/v1/registrations', { method: 'POST', body: { shiftId, volunteerId: vol._id }, lenient: true });
    if (json.success) {
      logChaosTerminal(`[EVENT] ${vol.name} claimed a slot (status ${json.status})`);
      window.fx?.burstAt(btn, json.status === 'CONFIRMED' ? '#34f5a0' : '#ffb020', 26);
      fetchShifts();
    } else {
      logChaosTerminal(`[ERROR] Sign-up rejected: ${json.message}`);
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] ${err.message}`);
  }
}

async function loadSOSTickets() {
  try {
    openSosTicketsCache = await apiGet('/api/v1/sos/tickets?status=OPEN');
    renderSOSTicketsList(openSosTicketsCache);
    syncCampusActors();
  } catch (err) {
    console.error('Failed to load SOS tickets:', err);
  }
}

/**
 * Sample distress calls. `coordinates` are mandatory server-side — the dispatch
 * engine measures Haversine distance from them — and omitting them made every
 * simulated SOS fail validation silently. Each sample carries the real
 * coordinates of the venue its table location names.
 */
const SOS_SAMPLES = [
  {
    hackerName: 'Alex (Hardware Hacker)', tableLocation: 'Table 42 (Siebel Basement)',
    coordinates: { latitude: 40.113725, longitude: -88.224810 },
    category: 'HARDWARE_MALFUNCTION', urgency: 'HIGH', requiredSkill: 'HARDWARE', karmaBounty: 250,
    description: 'Soldering station shorted out, need a backup ESP32.',
  },
  {
    hackerName: 'Devin (Hacker Team 19)', tableLocation: 'ECEB 2nd Floor Balcony',
    coordinates: { latitude: 40.114828, longitude: -88.228056 },
    category: 'POWER_OUTAGE', urgency: 'CRITICAL', requiredSkill: 'EVENT_LOGISTICS', karmaBounty: 200,
    description: 'Power strip blew a fuse — four laptops at 15%.',
  },
  {
    hackerName: 'Maya (Team Quantum)', tableLocation: 'Kenney Gym bleachers',
    coordinates: { latitude: 40.113054, longitude: -88.228012 },
    category: 'SPILL_CLEANUP', urgency: 'MEDIUM', requiredSkill: 'EVENT_LOGISTICS', karmaBounty: 150,
    description: 'Boba spill under Table 108, right by the power run.',
  },
  {
    hackerName: 'Ren (Team Altgeld)', tableLocation: 'Illini Union South Lounge',
    coordinates: { latitude: 40.109540, longitude: -88.227340 },
    category: 'HARDWARE_MALFUNCTION', urgency: 'HIGH', requiredSkill: 'HARDWARE', karmaBounty: 220,
    description: 'Projector HDMI handshake failing minutes before the demo.',
  },
  {
    hackerName: 'Priya (Team Foellinger)', tableLocation: 'Foellinger Auditorium stage left',
    coordinates: { latitude: 40.106030, longitude: -88.227210 },
    category: 'LOGISTICS_SUPPLIES', urgency: 'MEDIUM', requiredSkill: 'EVENT_LOGISTICS', karmaBounty: 160,
    description: 'Out of extension cords for the closing-ceremony rehearsal.',
  },
];

async function simulateHackerSOS() {
  const pick = SOS_SAMPLES[Math.floor(Math.random() * SOS_SAMPLES.length)];

  try {
    const json = await Nexus.api('/api/v1/sos/tickets', { method: 'POST', body: pick, lenient: true });
    if (json.success) {
      logSosTerminal(`[SOS] Simulated ticket ${json.data._id.slice(-6)} raised at ${pick.tableLocation}`);
      loadSOSTickets();
    } else {
      logSosTerminal(`[ERROR] Could not raise ticket: ${json.message}`);
    }
  } catch (err) {
    logSosTerminal(`[ERROR] ${err.message}`);
  }
}

async function dispatchNearestVolunteer(ticketId, btn) {
  logSosTerminal(`[DISPATCH] Computing Haversine distances for ticket ${ticketId.slice(-6)}…`);
  try {
    const json = await Nexus.api(`/api/v1/sos/tickets/${ticketId}/dispatch`, { method: 'POST', lenient: true });
    if (json.success) {
      const vol = json.data.dispatchedVolunteer;
      const dist = json.data.distanceMeters;
      const eta = Math.max(1, Math.ceil(dist / 80));
      logSosTerminal(`[DISPATCH] ${vol.name} selected — ${dist.toFixed(1)}m away, ETA ${eta} min.`);
      window.soundEngine?.playDispatchChime();
      window.fx?.burstAt(btn, '#ff3b6b', 24);
      loadSOSTickets();
    } else {
      logSosTerminal(`[ERROR] Dispatch failed: ${json.message}`);
    }
  } catch (err) {
    logSosTerminal(`[ERROR] ${err.message}`);
  }
}

async function triggerAdonixSync() {
  const btn = document.getElementById('adonix-sync-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon('refresh', 'icon sm')}Syncing…`; }
  logChaosTerminal('[ADONIX] Synchronising the official schedule…');

  try {
    const json = await Nexus.api('/api/v1/adonix/sync', { method: 'POST', lenient: true });
    if (json.success) {
      logChaosTerminal(`[ADONIX] ${json.data.syncedCount} shifts synchronised.`);
      fetchShifts();
      fetchStats();
    } else {
      logChaosTerminal(`[ERROR] Adonix sync failed: ${json.message}`);
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] Adonix sync failed: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('refresh', 'icon sm')}Sync Adonix`; }
  }
}

/* ------------------------------------------------------------------ *
 * PokéShift
 * ------------------------------------------------------------------ */

function changeUserFaction(faction) {
  currentVolunteerFaction = faction;
  const sel = document.getElementById('user-faction-selector');
  if (sel) sel.style.borderColor = factionOf(faction).color;
  renderGymsList();
  window.game?.onFactionChange();
}

async function loadGymsData() {
  try {
    gymsCache = await apiGet('/api/v1/pokeshift/gyms');
    renderGymsList();
    syncCampusFactions();
    window.game?.renderTrainer();
  } catch (err) {
    console.error('Failed to load gyms:', err);
  }
}

async function battleOrFortifyGym(gymId, btn) {
  const vol = actingVolunteer();
  if (!vol) return;

  // battleGymSchema requires coordinates — the engine geofences a capture so a
  // stronghold cannot be taken from across campus. Omitting them made every
  // click fail with a bare "Request validation failed", so the button had never
  // worked from the dashboard. Contesting a gym means standing at it, so the
  // gym's own position is the honest thing to send.
  const gym = gymsCache.find((g) => g._id === gymId);
  if (!gym) {
    logChaosTerminal('[ERROR] Gym not in cache — refresh the territory list.');
    return;
  }

  try {
    const json = await Nexus.api(`/api/v1/pokeshift/gyms/${gymId}/battle`, {
      method: 'POST',
      body: {
        volunteerId: vol._id,
        faction: currentVolunteerFaction,
        power: 150,
        coordinates: playerCoords() ?? { latitude: gym.latitude, longitude: gym.longitude },
      },
      lenient: true,
    });
    if (json.success) {
      const captured = json.data.action === 'CAPTURED';
      if (captured) window.soundEngine?.playGymVictoryFanfare();
      else window.soundEngine?.playSonarPing();
      window.fx?.burstAt(btn, factionOf(currentVolunteerFaction).color, captured ? 54 : 22);
      logChaosTerminal(`[GYM ${json.data.action}] ${json.data.message}`);
      pulseMonumentFor(gymId);
      loadGymsData();
      fetchStats();
    } else {
      logChaosTerminal(`[ERROR] Gym battle failed: ${json.message}`);
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] ${err.message}`);
  }
}

async function loadHackStopsData() {
  try {
    hackStopsCache = await apiGet('/api/v1/pokeshift/hackstops');
    renderHackStopsList();
    syncCampusActors();
  } catch (err) {
    console.error('Failed to load hackstops:', err);
  }
}

async function spinHackStop(beaconId, lat, lon, btn) {
  const vol = actingVolunteer();
  if (!vol) return;
  window.soundEngine?.playStopSpin();

  try {
    const json = await Nexus.api(`/api/v1/pokeshift/hackstops/${beaconId}/spin`, { method: 'POST', body: { volunteerId: vol._id, coordinates: playerCoords() ?? { latitude: lat, longitude: lon } }, lenient: true });

    if (json.success) {
      const item = json.data.itemDetails;
      const legendary = item.rarity === 'LEGENDARY' || item.rarity === 'MYTHIC';
      window.fx?.burstAt(btn, legendary ? '#ffd75e' : '#22e8ff', legendary ? 70 : 32);
      window.soundEngine?.playLootDrop(legendary);
      showLootModal(item, json.data.awardedKarma);
      logChaosTerminal(`[HACKSTOP] Spun ${json.data.name} → ${item.name} (+${json.data.awardedKarma} karma)`);
      loadUserInventory();
      fetchStats();
    } else {
      logChaosTerminal(`[ERROR] HackStop spin failed: ${json.message}`);
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] ${err.message}`);
  }
}

const RARITY_TONE = {
  COMMON: '#7c8daa', UNCOMMON: '#2fb3c2', RARE: '#22d3ee',
  EPIC: '#a78bfa', LEGENDARY: '#ff5f05', MYTHIC: '#ff4d6a',
};

function showLootModal(item, karma) {
  const modal = document.getElementById('loot-drop-modal');
  const card = document.getElementById('loot-card');
  const tone = RARITY_TONE[item.rarity] || RARITY_TONE.RARE;

  if (card) card.style.setProperty('--c', tone);
  const glyph = document.getElementById('loot-glyph');
  // A memorabilia sprite matching the power-up rarity when the registry has
  // one, otherwise the rarity icon at 6× so the reveal still reads big.
  const pool = (window.Sprites?.items() || []).filter((it) => String(it.rarity).toUpperCase() === String(item.rarity).toUpperCase());
  const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  if (glyph) glyph.innerHTML = window.Sprites ? window.Sprites.img(pick ? pick.id : (RARITY_ICON[item.rarity] || 'gift'), pick ? 5 : 8) : '';
  if (pick) window.game?.award(pick.id, `${item.name} came with a ${pick.name}.`);

  const set = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };
  set('loot-item-name', item.name);
  set('loot-item-desc', item.description);
  set('loot-karma-awarded', `+${num(karma)} karma awarded`);

  const rarity = document.getElementById('loot-item-rarity');
  if (rarity) {
    rarity.innerText = String(item.rarity || '').toLowerCase();
    rarity.className = `sticker rarity-${String(item.rarity).replace(/[^A-Z_]/g, '')}`;
    rarity.style.background = tone;
  }

  if (modal) modal.classList.add('open');
  setTimeout(() => window.fx?.burst(window.innerWidth / 2, window.innerHeight / 2, tone, 36), 160);
}

function closeLootModal() {
  document.getElementById('loot-drop-modal')?.classList.remove('open');
}

// Escape reaches here only when no Nexus dialog is open (nexus.js closes the
// topmost dialog itself — the encounter is one). Enter/Space on role=button
// cards is also handled in nexus.js now.
Nexus.onEvent('escape', () => {
  closeLootModal();
  if (document.body.classList.contains('cinema')) toggleCinema(false);
});
document.getElementById('loot-drop-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'loot-drop-modal') closeLootModal();
});

async function loadUserInventory() {
  const me = window.Nexus?.session?.user ? sessionAsVolunteer(window.Nexus.session.user) : volunteersCache[0];
  if (!me) return; // startup ordering, not a user action
  try {
    userInventoryCache = await apiGet(`/api/v1/pokeshift/inventory/${encodeURIComponent(me._id)}`);
    renderUserInventory();
    window.game?.renderTrainer();
  } catch (err) {
    console.error('Failed to load inventory:', err);
  }
}

async function deployPowerUp(itemType, btn) {
  const vol = actingVolunteer();
  if (!vol) return;
  const targetGym = gymsCache[0];

  try {
    const json = await Nexus.api('/api/v1/pokeshift/inventory/use', { method: 'POST', body: { volunteerId: vol._id, itemType, targetGymId: targetGym?._id }, lenient: true });
    if (json.success) {
      window.soundEngine?.playSonarPing();
      window.fx?.burstAt(btn, '#ffb020', 24);
      logChaosTerminal(`[DEPLOYED] ${json.data.message}`);
      loadUserInventory();
      loadGymsData();
      fetchStats();
    } else {
      logChaosTerminal(`[ERROR] Could not use item: ${json.message}`);
    }
  } catch (err) {
    logChaosTerminal(`[ERROR] ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * The 3D campus
 * ------------------------------------------------------------------ */

let campus = null;          // the renderer handle
let campusBooting = false;
let campusMeta = null;
let toWorld = null;         // lat/lng → world units, built from the model's frame
let fromWorld = null;       // world units → lat/lng, the inverse, for proof-of-presence
let selectedMonumentId = null;

function setGlStatus(text, cls = 'c-mint') {
  const el = document.getElementById('gl-status');
  if (el) { el.innerText = text; el.className = signalClass(cls); }
}

/**
 * Boots the WebGL campus on first visit to its tab. Deferred rather than done
 * at page load because baking ~900 building footprints costs a few hundred
 * milliseconds we would otherwise spend before the dashboard is interactive.
 */
async function bootCampus() {
  if (campus || campusBooting) return;
  campusBooting = true;

  const canvas = document.getElementById('campus-3d-canvas');
  if (!canvas) { campusBooting = false; return; }

  try {
    const { createCampusRenderer } = await import('/dashboard/gl/campus3d.js');
    const renderer = createCampusRenderer(canvas, {
      onSelect: (mon) => selectMonument(mon),
      onFrame: paintWorldLabels,
      onProximity: (e) => window.game?.onProximity(e),
    });

    if (!renderer) {
      setGlStatus('WebGL2 unavailable', 'c-amber');
      document.getElementById('campus-viewport')?.insertAdjacentHTML('beforeend',
        '<div class="empty-state" style="position:absolute;inset:0;display:grid;place-items:center;">' +
        'This browser has no WebGL2. The campus map needs it; every other panel still works.</div>');
      campusBooting = false;
      return;
    }

    setGlStatus('Baking campus…', 'c-amber');
    const t0 = performance.now();
    const { meta } = await renderer.loadCampus(Nexus.contentUrl('campus'));
    const ms = Math.round(performance.now() - t0);

    campus = renderer;
    campusMeta = meta;

    const [lat0, lng0] = meta.origin;
    const mPerLat = 111320;
    const mPerLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
    toWorld = (lat, lng) => ({
      x: ((lng - lng0) * mPerLng) / meta.metersPerUnit,
      z: -((lat - lat0) * mPerLat) / meta.metersPerUnit,
    });
    fromWorld = (x, z) => ({
      latitude: lat0 - (z * meta.metersPerUnit) / mPerLat,
      longitude: lng0 + (x * meta.metersPerUnit) / mPerLng,
    });
    window.toWorld = toWorld;

    setGlStatus('WebGL2 · live', 'c-mint');
    // The bake time is a boot fact; the counts live in the telemetry strip.
    const stats = document.getElementById('gl-stats');
    if (stats) stats.innerText = `baked in ${ms}ms`;
    setText('tm-buildings', meta.counts.buildings);
    setText('tm-monuments', meta.counts.monuments);
    const kind = document.getElementById('mon-kind');
    if (kind) kind.innerText = `${meta.counts.monuments} monuments`;

    logSosTerminal(`[EVENT] Campus model loaded — ${meta.counts.buildings} footprints, ${meta.counts.roads} streets (${ms}ms).`);

    syncCampusFactions();
    syncCampusActors();
    window.game?.onCampusReady();
  } catch (err) {
    console.error('Campus renderer failed:', err);
    setGlStatus('Renderer failed', 'c-hazard');
    logSosTerminal(`[ERROR] Campus renderer: ${err.message}`);
  } finally {
    campusBooting = false;
  }
}

/** Matches an API gym to its monument: by venue name first, then by distance. */
function monumentForGym(gym) {
  if (!campus) return null;
  const monuments = campus.getMonuments();
  const hay = `${gym.locationName} ${gym.name}`.toLowerCase();

  const named = monuments.find((m) =>
    hay.includes(m.venue.toLowerCase()) || hay.includes(m.name.toLowerCase()));
  if (named) return named;

  if (!toWorld || gym.latitude == null) return null;
  const p = toWorld(gym.latitude, gym.longitude);
  let best = null, bestD = 12; // world units ≈ 120 m
  for (const m of monuments) {
    const d = Math.hypot(m.cx - p.x, m.cz - p.z);
    if (d < bestD) { best = m; bestD = d; }
  }
  return best;
}

/** Pushes live gym control into the map so monuments wear their faction colour. */
function syncCampusFactions() {
  if (!campus) return;
  // Clear first: a monument that no longer resolves to a gym must drop its
  // garrison rather than keep showing the last one it had.
  for (const mon of campus.getMonuments()) mon.gym = null;
  const map = {};
  for (const g of gymsCache) {
    const mon = monumentForGym(g);
    if (!mon) continue;
    map[mon.id] = {
      color: mapColorOf(g.controllingFaction),
      faction: g.controllingFaction,
      cp: g.controlPoints,
    };
    mon.gym = g;
  }
  campus.setFactions(map);
  if (selectedMonumentId) {
    const mon = campus.getMonuments().find((m) => m.id === selectedMonumentId);
    if (mon) renderMonumentDetail(mon);
  }
}

/**
 * Rebuilds the dynamic actors: one orbiting crystal per filled slot at the
 * shift's venue, a beacon per HackStop, and a cone per open distress call.
 */
function syncCampusActors() {
  if (!campus || !toWorld) return;
  const monuments = campus.getMonuments();

  const nearestMonument = (lat, lng) => {
    const p = toWorld(lat, lng);
    let best = null, bestD = Infinity;
    for (const m of monuments) {
      const d = Math.hypot(m.cx - p.x, m.cz - p.z);
      if (d < bestD) { best = m; bestD = d; }
    }
    return { mon: best, p };
  };

  const orbiters = [];
  for (const shift of shiftsCache) {
    if (!shift.filledSlots) continue;
    const hay = (shift.location || '').toLowerCase();
    const mon = monuments.find((m) => hay.includes(m.venue.toLowerCase()) || hay.includes(m.short.toLowerCase()));
    if (!mon) continue;
    for (let s = 0; s < shift.filledSlots; s++) {
      orbiters.push({
        cx: mon.cx, cz: mon.cz,
        radius: mon.radius + 1.6 + s * 0.7,
        speed: (s % 2 ? -1 : 1) * (0.34 + s * 0.05),
        baseY: mon.h * 0.55 + 0.5,
        color: '#34f5a0',
      });
    }
  }

  const beacons = hackStopsCache.map((stop) => {
    const { mon, p } = nearestMonument(stop.latitude, stop.longitude);
    return {
      id: stop.beaconId,   // proximity events and getNearby() key on this
      name: stop.name,
      x: p.x, z: p.z,
      y: (mon ? mon.h * 0.5 : 1) + 1.1,
      color: '#a855f7',
      inRange: true,
      radius: Math.max(1.4, stop.geofenceRadiusMeters / (campusMeta?.metersPerUnit || 10)),
    };
  });

  // Tickets carry real coordinates (the dispatch engine measures from them),
  // so place the cone there. The free-text fallback only matters for tickets
  // created before coordinates were required.
  const distress = openSosTicketsCache.map((t) => {
    const lat = t.coordinates?.latitude ?? t.latitude;
    const lng = t.coordinates?.longitude ?? t.longitude;
    if (lat != null && lng != null) {
      const p = toWorld(lat, lng);
      return { x: p.x, z: p.z, y: 0.7, color: '#ff3b6b' };
    }
    const hay = (t.tableLocation || '').toLowerCase();
    const mon = monuments.find((m) => hay.includes(m.venue.toLowerCase()) || hay.includes(m.short.toLowerCase()))
      || monuments.find((m) => m.id === 'siebel')
      || monuments[0];
    return { x: mon.cx + 2.4, z: mon.cz + 2.4, y: 0.7, color: '#ff3b6b' };
  });

  campus.setActors({ orbiters, beacons, distress });

  const chip = document.getElementById('onduty-chip');
  if (chip) chip.innerText = `${orbiters.length} on duty`;
}

/** Fires a shockwave on the monument a gym maps to. */
function pulseMonumentFor(gymId) {
  if (!campus) return;
  const gym = gymsCache.find((g) => g._id === gymId);
  const mon = gym && monumentForGym(gym);
  if (mon) campus.pulse(mon.cx, mon.cz, factionOf(currentVolunteerFaction).color);
}

function focusMonument(locationName, attempt = 0) {
  if (!campus) {
    // Bounded retry. This used to recurse forever, so on a browser without
    // WebGL2 (where `campus` never becomes non-null) it yanked the user back
    // to the Campus tab every 900 ms with no way to stay anywhere else.
    if (attempt >= 4) {
      logChaosTerminal('[ERROR] Campus map unavailable — cannot locate that stronghold.');
      return;
    }
    Nexus.showTab('tab-campus');
    setTimeout(() => focusMonument(locationName, attempt + 1), 900);
    return;
  }
  const hay = (locationName || '').toLowerCase();
  const mon = campus.getMonuments().find((m) =>
    hay.includes(m.venue.toLowerCase()) || hay.includes(m.name.toLowerCase()));
  if (!mon) return;
  Nexus.showTab('tab-campus');
  campus.focus(mon.id, { dist: 42 });
  selectMonument(mon);
}

function campusResetView() {
  campus?.resetView();
  selectedMonumentId = null;
  const t = document.getElementById('mon-title');
  if (t) t.innerText = 'Campus overview';
  const k = document.getElementById('mon-kind');
  if (k) k.innerText = `${campus ? campus.getMonuments().length : 14} monuments`;
  const d = document.getElementById('mon-detail');
  if (d) {
    d.innerHTML = '<p class="muted" style="font-size:13px">Click any landmark on the map to see its history, garrison and control points.</p>';
  }
}

function selectMonument(mon) {
  selectedMonumentId = mon.id;
  campus?.pulse(mon.cx, mon.cz, '#ff5f05', { reach: 6, life: 900 });
  window.soundEngine?.playSonarPing();
  renderMonumentDetail(mon);
}

function renderMonumentDetail(mon) {
  const title = document.getElementById('mon-title');
  const kind = document.getElementById('mon-kind');
  const body = document.getElementById('mon-detail');
  if (title) title.innerText = mon.name;
  if (kind) kind.innerText = mon.kind;
  if (!body) return;

  const info = monumentInfo[mon.id] || null;
  const gym = mon.gym;
  const f = factionOf(gym?.controllingFaction);
  const pct = gym ? Math.max(0, Math.min(100, Math.round((gym.controlPoints / (gym.maxControlPoints || 1)) * 100) || 0)) : 0;
  const badgeId = window.Sprites?.gymBadges()[mon.id];
  const badge = badgeId ? window.Sprites.item(badgeId) : null;
  const held = !!badgeId && !!(window.game?.state.earned?.has(badgeId) || window.game?.state.flags?.[badgeId]);
  const facts = Array.isArray(info?.facts) ? info.facts.slice(0, 3) : [];

  body.innerHTML = `
    <div class="mon-card">
      <div class="mc-head"><span>${esc(mon.kind)}</span><span>${info?.year ? `Built ${esc(info.year)}` : 'No. ' + esc(mon.id)}</span></div>
      <div class="mc-art" aria-hidden="true">${icon(mon.kind || 'hall')}</div>
      <div class="mc-body">
        <div class="mc-title">${esc(mon.name)}</div>
        ${info?.architect || info?.style ? `<div class="mon-meta">${info.architect ? `<span>${esc(info.architect)}</span>` : ''}${info.architect && info.style ? '<span class="dot"></span>' : ''}${info.style ? `<span>${esc(info.style)}</span>` : ''}</div>` : ''}
        ${facts.length ? `<ul class="mon-facts">${facts.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<div class="mc-text">${esc(mon.blurb || '')}</div>`}
        ${info?.approximate ? '<div class="mc-text">Details from general knowledge — no source article was available.</div>' : ''}
        ${gym ? `
          <div class="mon-meta" style="--c:${f.color}"><span class="f">${esc(f.short)}</span><span class="dot"></span><span>Lv ${Number(gym.level) || 1}</span><span class="dot"></span><span>${(gym.defenders || []).length} defending</span></div>
          <div class="mc-cp"><span>CP</span><div class="pxbar"><i style="width:${pct}%;background:${f.color}"></i></div><span>${num(gym.controlPoints)}/${num(gym.maxControlPoints)}</span></div>
        ` : '<div class="mc-text">Uncontested — no stronghold registered here yet.</div>'}
      </div>
      <div class="mc-foot">
        <span>${badge ? `${icon(badgeId, 'icon sm')} ${esc(badge.name)}${held ? ' ✓' : ' · hold to earn'}` : ''}</span>
        ${gym ? `<button class="pb pb-sm" data-action="encounter" data-id="${esc(gym._id)}">Engage</button>` : ''}
      </div>
    </div>`;
}

/**
 * Repositions the HTML label layer each frame from projected world positions.
 * HTML rather than in-canvas text so the labels stay crisp at any zoom and
 * inherit the page's typography.
 */
const labelNodes = new Map();

/* Telemetry. fps is a rolling count over a 500 ms window; the DOM is written
   at that cadence, not per frame, so the readout never becomes the jank. */
const tele = { frames: 0, since: 0, lastDist: -1 };
const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };

function updateTelemetry(dist) {
  const now = performance.now();
  tele.frames++;
  if (!tele.since) tele.since = now;
  const span = now - tele.since;
  if (span < 500) return;
  const fps = Math.round((tele.frames * 1000) / span);
  tele.frames = 0;
  tele.since = now;
  const fpsEl = document.getElementById('tm-fps');
  if (fpsEl) {
    fpsEl.textContent = String(fps);
    fpsEl.classList.toggle('is-low', fps < 45);
  }
  const d = Math.round(dist);
  if (d !== tele.lastDist) { tele.lastDist = d; setText('tm-dist', d); }
}

/** Cinematic mode: the map alone, edge to edge. Esc exits. */
let cinemaReturnFocus = null;

function toggleCinema(force) {
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('cinema');
  document.body.classList.toggle('cinema', on);
  const btn = document.getElementById('cinema-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(on));
    btn.innerHTML = `${icon(on ? 'collapse' : 'expand', 'icon sm')}<span>${on ? 'Exit' : 'Cinematic'}</span>`;
  }
  if (on) {
    // Remember where keyboard focus was: the header and nav are display:none
    // in cinema, so without this a keyboard or screen-reader user comes back
    // to nothing focused.
    cinemaReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Make sure the map is the active view before going edge to edge.
    if (!document.getElementById('tab-campus')?.classList.contains('active')) Nexus.showTab('tab-campus');
    bootCampus();
    document.getElementById('campus-3d-canvas')?.focus?.();
    // A browser without WebGL2 would otherwise be left in an edge-to-edge
    // empty viewport with only the Exit button; give the boot a moment, then
    // fall back out.
    setTimeout(() => {
      if (document.body.classList.contains('cinema') && !campus && !campusBooting) toggleCinema(false);
    }, 2500);
  } else if (cinemaReturnFocus) {
    const target = cinemaReturnFocus;
    cinemaReturnFocus = null;
    if (target.isConnected) target.focus({ preventScroll: true });
  }
}

function paintWorldLabels(payload) {
  const { projectToScreen, monuments, hovered, dist, player } = payload;
  updateTelemetry(dist);
  window.game?.tick(payload);
  Nexus.emit('frame', payload);
  const layer = document.getElementById('world-labels');
  if (!layer) return;

  // The player's name tag rides the sprite via the renderer's projected point.
  let you = labelNodes.get('__you');
  if (!you) {
    you = document.createElement('div');
    you.className = 'world-label you';
    you.innerHTML = '<b></b>';
    layer.appendChild(you);
    labelNodes.set('__you', you);
  }
  if (player && player.screen) {
    you.style.opacity = '1';
    you.style.transform = `translate(${player.screen.x}px, ${player.screen.y - 6}px) translate(-50%, -100%)`;
    const nm = player.name || 'You';
    if (you._b !== nm) { you._b = nm; you.querySelector('b').textContent = nm; }
  } else {
    you.style.opacity = '0';
  }

  // Labels are the point of the map — you should be able to read "ALTGELD"
  // without hunting for it. They stay on at every zoom, just quieter when the
  // whole campus is in frame so fourteen of them do not shout at once.
  const far = dist > 110;

  const layerW = layer.clientWidth, layerH = layer.clientHeight;
  for (const mon of monuments) {
    let node = labelNodes.get(mon.id);
    if (!node) {
      node = document.createElement('div');
      node.className = 'world-label';
      node.innerHTML = '<b></b><i></i>';
      layer.appendChild(node);
      labelNodes.set(mon.id, node);
    }

    const focused = hovered === mon || selectedMonumentId === mon.id;
    const s = projectToScreen(mon.cx, mon.h + 2.6, mon.cz);
    if (!s || s.x < -160 || s.x > layerW + 160 || s.y < -60 || s.y > layerH + 60) {
      node.style.opacity = '0';
      continue;
    }

    node.style.opacity = focused ? '1' : far ? '0.5' : '0.78';
    const scale = focused ? 1 : far ? 0.82 : 1;
    node.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%) scale(${scale})`;
    node.style.zIndex = focused ? '2' : '1';
    node.style.setProperty('--c', mon.gym ? factionOf(mon.gym.controllingFaction).color : FACTION.NEUTRAL.color);
    const nextB = mon.short, nextI = mon.gym ? `${mon.gym.controlPoints} CP` : 'unclaimed';
    if (node._b !== nextB) { node._b = nextB; node.querySelector('b').textContent = nextB; }
    if (node._i !== nextI) { node._i = nextI; node.querySelector('i').textContent = nextI; }
  }
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

/** Per-monument history from the pack's monuments-info.json, keyed by monument id. */
let monumentInfo = {};

async function loadMonumentInfo() {
  try {
    await Nexus.contentReady; // the descriptor says where the pack is served
    const res = await fetch(Nexus.contentUrl('monuments-info'));
    if (!res.ok) { console.warn(`Monument dossiers unavailable: HTTP ${res.status}`); return; }
    const data = await res.json();
    // The file carries a `_source` note alongside the entries; keep only ids.
    monumentInfo = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith('_')));
  } catch (err) {
    console.warn('Monument dossiers unavailable:', err.message);
  }
}

/** Sign-in / sign-out at runtime: re-point everything that keys on "me". */
function onSessionChange(user) {
  if (user?.faction && user.faction !== currentVolunteerFaction) {
    currentVolunteerFaction = user.faction;
    const sel = document.getElementById('user-faction-selector');
    if (sel && [...sel.options].some((o) => o.value === user.faction)) sel.value = user.faction;
  }
  if (user) {
    loadUserInventory();
    logChaosTerminal(`[EVENT] Signed in as ${user.displayName || user.id}`);
  }
  renderGymsList();
  window.game?.onFactionChange();
}

async function init() {
  // The pack descriptor settles before `session.ready`, so factions and
  // branding are in place before the first data-driven render below.
  Nexus.contentReady.then((content) => {
    applyFactions(content?.factions);
    applyBranding(content);
  }).catch((err) => console.warn('Content pack not applied:', err.message));
  loadMonumentInfo(); // independent of the API; no need to await
  hydrateSprites();
  window.Sprites?.ready.then(() => hydrateSprites()).catch(() => {});
  try { await window.game?.init(); } catch (err) { console.warn('Game layer failed to init:', err); }
  // One round trip to /me (plus dev-login in the demo) before the first
  // fetch, so inventory and the trainer card belong to the right account.
  const me = await Nexus.session.ready;
  if (me?.faction) {
    currentVolunteerFaction = me.faction;
    const sel = document.getElementById('user-faction-selector');
    if (sel && [...sel.options].some((o) => o.value === me.faction)) sel.value = me.faction;
  }
  Nexus.onEvent('session', onSessionChange);
  await fetchVolunteers();
  await fetchShifts();
  await fetchStats();
  await fetchLeaderboard();
  await loadSOSTickets();
  await loadGymsData();
  await loadHackStopsData();
  await loadUserInventory();
  connectSSE();

  // Warm the campus in the background so the tab is instant when clicked.
  // requestIdleCallback is still unimplemented in Safari, hence the fallback.
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => bootCampus(), { timeout: 3000 });
  } else {
    setTimeout(bootCampus, 1200);
  }
}

window.addEventListener('DOMContentLoaded', init);
