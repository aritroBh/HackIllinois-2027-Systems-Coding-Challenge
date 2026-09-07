/**
 * quests — the play loop (plan §C8).
 *
 * Four things share this tab because they are the same loop seen from four angles: what
 * the event is asking of you this hour (`/me/quests`), the window where it is worth more
 * (`/game/raids`), who is winning the weekend (`/game/objectives`), and the codes sitting
 * on the sponsor tables (`/game/booths/:id/scan`).
 *
 * Unlike the other views this one does not repaint by rewriting its whole section. The
 * scanner owns a live `<video>` bound to a camera stream, and rebuilding the section under
 * it would tear the stream out mid-frame. So the shell is written once and `paint()` fills
 * three regions inside it; the scanner panel is updated through its own status line.
 *
 * The raid banner's Join delegates to the `locate` action app.js already owns, which is the
 * only thing that knows where the camera is and how to retry while the renderer warms up.
 * Duplicating that here would mean two answers to "focus this monument".
 *
 * Raids and objectives are optional content. A pack that ships neither gets a 404 from
 * both, and the banner and the bar are simply absent rather than showing an error for
 * something nobody asked for.
 *
 * Plain script under `script-src 'self'`: no inline handlers, everything reaching innerHTML
 * goes through esc(), and pack colours reaching a `style` attribute go through hex().
 */
(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[quests] nexus.js must load first'); return; }

  const TAB_ID = 'tab-quests';
  const SEGMENTS = 10;
  const SCAN_MS = 300;

  /**
   * What a booth placard carries. The QR encodes `nexus:booth:<id>:<code>`; the bare
   * `<id>:<code>` pair is the same thing without the scheme, which is what a person can
   * retype when there is no camera. Validating here means a mistyped id never reaches the
   * URL path.
   */
  const BOOTH_CODE = /^(?:nexus:booth:)?([a-z0-9][a-z0-9-]{0,39}):([A-Za-z0-9_-]{4,64})$/;

  const WINDOW_LABEL = { HOURLY: 'this hour', DAILY: 'today', EVENT: 'all weekend' };
  const WINDOW_ORDER = { HOURLY: 0, DAILY: 1, EVENT: 2 };

  const state = {
    section: null,
    mounted: false,
    loading: false,
    quests: [],
    raid: null,
    objective: null,
    tick: null,
    rolledAt: 0,          // the raid boundary we have already re-read across
    scan: { stream: null, detector: null, timer: null, last: null, busy: false },
  };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Pack colours land inside a `style` attribute, so only a literal hex is let through. */
  const hex = (v) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v ?? '')) ? String(v) : 'var(--neutral)');

  /** An ISO string or epoch milliseconds; NaN for anything else. */
  function at(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  /** The pack's playable teams. NEUTRAL is the unclaimed state, not a side anyone is on. */
  const factions = () => (N.content?.factions || []).filter((f) => f.id !== 'NEUTRAL');

  const clockOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  /**
   * A countdown a person can read at a glance.
   *
   * The clock format is only meaningful once the thing is close. `raids.json` anchors the
   * Opening Bell to the real event — 26 February 2027 — so the honest gap from a September
   * demo is about a hundred and seventy days, and rolling that into hours printed
   * `4144:51:40`: nine digits that look like a fault, not a date. Nobody counts down five
   * months in seconds. Past a day the unit becomes days (and hours, while they still say
   * something), and only inside the last day does it become the clock that the closing half
   * of a live raid actually needs.
   */
  function countdownText(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    const days = Math.floor(total / 86400);
    if (days >= 1) {
      const hours = Math.floor((total % 86400) / 3600);
      // Past a week the hours are noise; a fortnight out, "14d" is the whole answer.
      if (days >= 7) return `${days}d`;
      return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
    const hours = Math.floor(total / 3600);
    return hours > 0
      ? `${hours}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
      : `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
  }

  /* ------------------------------------------------------------------ *
   * Data
   * ------------------------------------------------------------------ */

  /**
   * The one raid worth a banner: the live one, or the next one to open. A raid that has
   * already closed is dropped rather than greyed out, because a banner for something
   * nobody can join is a banner in the way.
   */
  function pickRaid(payload) {
    const rows = Array.isArray(payload) ? payload
      : Array.isArray(payload?.raids) ? payload.raids
        : payload && typeof payload === 'object' ? [payload] : [];
    const now = Date.now();
    return rows
      .map((r) => ({ ...r, startsAt: at(r?.startsAt), endsAt: at(r?.endsAt) }))
      .filter((r) => Number.isFinite(r.startsAt) && Number.isFinite(r.endsAt) && r.endsAt > now)
      .sort((a, b) => a.startsAt - b.startsAt)[0] || null;
  }

  /**
   * The contested objective, with per-faction scores keyed by faction id. Scores arrive
   * either as rows or as a plain map; unknown ids are dropped, which is also what keeps a
   * bare objective object from being read as if its own fields were scores.
   */
  function readObjective(payload) {
    const row = Array.isArray(payload) ? payload[0] : payload;
    if (!row || typeof row !== 'object') return null;
    const raw = row.scores ?? row.factions ?? row;
    const pairs = Array.isArray(raw)
      ? raw.map((s) => [s?.factionId ?? s?.id, s?.score])
      : Object.entries(raw);
    const known = new Set(factions().map((f) => f.id));
    const scores = new Map(pairs.filter(([id]) => known.has(id)).map(([id, v]) => [id, Number(v) || 0]));
    if (!scores.size) return null;
    return { title: row.title || 'The weekend', blurb: row.blurb || '', endsAt: at(row.endsAt), scores };
  }

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
    const [quests, raids, objectives] = await Promise.all([
      N.api('/api/v1/me/quests', { lenient: true }),
      N.api('/api/v1/game/raids', { lenient: true }),
      N.api('/api/v1/game/objectives', { lenient: true }),
    ]).catch((err) => { console.debug('[quests] load failed', err.message); return [null, null, null]; });
    state.loading = false;
    // Somebody else's answer, arriving after the browser changed hands.
    if (mine !== generation) return;
    if (quests?.success) state.quests = Array.isArray(quests.data) ? quests.data : [];
    state.raid = raids?.success ? pickRaid(raids.data) : null;
    state.objective = objectives?.success ? readObjective(objectives.data) : null;
    paint();
  }

  /* ------------------------------------------------------------------ *
   * Quest board
   * ------------------------------------------------------------------ */

  /**
   * Ten segments, not one per unit: a quest with a target of 200 would otherwise draw 200
   * hairlines that read as a solid block. The last segment lights only on completion, so a
   * full bar always means finished rather than 96 %.
   */
  function segbar(progress, target) {
    const lit = progress >= target
      ? SEGMENTS
      : Math.min(SEGMENTS - 1, Math.floor((progress / target) * SEGMENTS));
    let cells = '';
    for (let i = 0; i < SEGMENTS; i += 1) cells += `<i class="${i < lit ? 'on' : ''}"></i>`;
    return `<div class="seg" role="img" aria-label="${esc(`${progress} of ${target}`)}">${cells}</div>`;
  }

  function kindLine(q) {
    if (q.kind === 'STREAK') return q.window === 'HOURLY' ? 'hours in a row' : 'days in a row';
    return q.kind === 'DISTINCT' ? 'each one counts once' : 'every one counts';
  }

  /** A sticker id is a memorabilia id; sprites.js knows its display name once the sheet is in. */
  const stickerName = (id) => (id ? (window.Sprites?.item?.(id)?.name || id) : null);

  function rewardLine(q) {
    const karma = Number(q.reward?.karma) || 0;
    const sticker = stickerName(q.reward?.sticker);
    if (karma && sticker) return `${karma} karma + ${sticker}`;
    return sticker || `${karma} karma`;
  }

  const rewardArt = (q) => (q.reward?.sticker && window.Sprites?.item?.(q.reward.sticker)
    ? window.Sprites.img(q.reward.sticker, 2)
    : '');

  function questHtml(q) {
    const target = Math.max(1, Number(q.target) || 1);
    const progress = Math.min(target, Math.max(0, Number(q.progress) || 0));
    const flag = q.completed ? '<span class="sticker live">DONE</span>'
      : q.anchoredToDuty ? '<span class="sticker flat">ON SHIFT</span>' : '';
    return `
      <div class="quest">
        <div class="qicon">${rewardArt(q)}</div>
        <div class="qbody">
          <div class="qtop">
            <div>
              <div class="qtitle">${esc(q.title)}</div>
              <div class="qvenue">${esc(q.blurb || '')}</div>
            </div>
            ${flag}
          </div>
          <div class="qtime"><span>${esc(WINDOW_LABEL[q.window] || '')}</span><span>${esc(kindLine(q))}</span></div>
          <div class="qrow">
            ${segbar(progress, target)}
            <span class="qtime"><b>${progress}/${target}</b><span>${esc(rewardLine(q))}</span></span>
          </div>
        </div>
      </div>`;
  }

  function boardHtml() {
    if (!state.quests.length) {
      return `<div class="panel-head"><div><div class="eyebrow">Quest board</div><h3>Nothing on the board</h3></div></div>
        <div class="empty-state">No quests on this board yet. New ones appear here the moment an organiser posts them.</div>`;
    }
    // Open first, and inside that the shortest window first: an hourly quest is the one
    // that is about to expire, so it is the one worth reading first.
    const rank = (q) => (q.completed ? 1 : 0) * 10 + (WINDOW_ORDER[q.window] ?? 3);
    const rows = [...state.quests].sort((a, b) => rank(a) - rank(b));
    const done = state.quests.filter((q) => q.completed).length;
    return `
      <div class="panel-head">
        <div><div class="eyebrow">Quest board</div><h3>${state.quests.length - done} open</h3></div>
        <span class="sticker flat">${done} done</span>
      </div>
      ${rows.map(questHtml).join('')}`;
  }

  /* ------------------------------------------------------------------ *
   * Raid banner
   * ------------------------------------------------------------------ */

  /**
   * The name `focusMonument` matches on. It compares its argument against every monument's
   * `venue` and `name`, and raids.json names a venue key (`ALTGELD_HALL`), so the
   * translation happens here rather than teaching the camera code about raids. A venue with
   * no monument still yields its display name, which reads better than the key even though
   * the camera will not find it.
   */
  function raidVenue(raid) {
    const wanted = String(raid.venue || raid.venueKey || raid.monumentId || raid.monument || '').trim();
    if (!wanted) return null;
    const hit = (N.content?.monuments || []).find((m) => m.id === wanted || m.venueKey === wanted || m.name === wanted || m.venue === wanted);
    if (hit) return hit.name;
    return N.content?.venues?.[wanted]?.name || wanted;
  }

  function raidHtml() {
    const r = state.raid;
    if (!r) return '';
    const live = r.startsAt <= Date.now();
    const venue = raidVenue(r);
    const multiplier = Number(r.karmaMultiplier ?? r.multiplier) || 0;
    return `
      <div class="px">
        <div class="panel-head">
          <div><div class="eyebrow">${live ? 'Raid open' : 'Raid window'}</div><h3>${esc(r.title || 'Raid')}</h3></div>
          <span class="sticker ${live ? 'live' : 'flat'}">${live ? 'LIVE' : 'SOON'}</span>
        </div>
        ${r.blurb ? `<p>${esc(r.blurb)}</p>` : ''}
        <div class="vitals-row" style="margin-top:12px">
          <div class="stat"><div class="v" id="raid-clock">--:--</div><div class="hud-label">${live ? 'until it closes' : 'until it opens'}</div></div>
          ${multiplier ? `<div class="stat"><div class="v">${esc(`${multiplier}x`)}</div><div class="hud-label">karma</div></div>` : ''}
        </div>
        ${live ? '<div class="countdown-bar" style="margin-top:12px"><div class="countdown-fill" id="raid-fill" style="width:100%"></div></div>' : ''}
        <div class="btn-row" style="margin-top:12px">
          <button class="pb pb-sm" type="button" data-action="quests-raid-join" data-venue="${esc(venue || '')}"${venue ? '' : ' disabled'}>${live ? 'Join' : 'Show me where'}</button>
        </div>
        <p class="ob-hint">${venue
          ? esc(`Held at ${venue}. Join puts the campus camera on it.`)
          : 'This raid names no landmark, so there is nothing to point the camera at.'}</p>
      </div>`;
  }

  /** The second hand on the banner. Only the two clock nodes are touched, never the panel. */
  function paintClock() {
    const r = state.raid;
    const clock = document.getElementById('raid-clock');
    if (!r || !clock) return;
    const now = Date.now();
    const live = r.startsAt <= now;
    const target = live ? r.endsAt : r.startsAt;
    const left = target - now;
    clock.textContent = countdownText(left);
    const fill = document.getElementById('raid-fill');
    if (fill) {
      const span = r.endsAt - r.startsAt;
      fill.style.width = `${span > 0 ? Math.max(0, Math.min(100, (left / span) * 100)) : 0}%`;
      fill.classList.toggle('low', left <= 60000);
    }
    // The window turned over under the banner. Re-read once per boundary; without the
    // guard the tick would ask the server again every second until the answer changed.
    if (left <= 0 && state.rolledAt !== target) {
      state.rolledAt = target;
      void load();
    }
  }

  function startTick() {
    if (state.tick) clearInterval(state.tick);
    state.tick = setInterval(paintClock, 1000);
    paintClock();
  }

  function stopTick() {
    if (state.tick) { clearInterval(state.tick); state.tick = null; }
  }

  /* ------------------------------------------------------------------ *
   * Faction objective
   * ------------------------------------------------------------------ */

  function objectiveHtml() {
    const o = state.objective;
    const teams = factions();
    if (!o || !teams.length) {
      return `<div class="panel-head"><div><div class="eyebrow">Faction objective</div><h3>Nothing contested</h3></div></div>
        <p class="ob-hint">Objectives open when the organisers start one. Until then no ground is being fought over.</p>`;
    }
    const rows = teams.map((f) => ({ f, score: o.scores.get(f.id) || 0 }));
    const total = rows.reduce((sum, r) => sum + r.score, 0);
    // Nobody has scored yet.
    //
    // Equal thirds was chosen as "the honest picture, not a winner by rounding", and the
    // arithmetic is honest, but the *drawing* is not: three saturated blocks filling the
    // whole bar is the same picture this bar paints for a real three-way tie, and it sat
    // directly above three zeros. It read as a broken widget. An empty track cannot be
    // misread — there is nothing in it because nothing has been scored — and the legend
    // underneath still carries the zeros.
    const bar = total > 0
      ? rows.map((r) => `<span style="width:${((r.score / total) * 100).toFixed(2)}%;background:${hex(r.f.color)}"></span>`).join('')
      : '';
    const legend = rows.map((r) => `<div class="stat">
        <div class="v" style="color:${hex(r.f.color)}">${r.score}</div>
        <div class="hud-label">${esc(r.f.short || r.f.label || r.f.id)}</div>
      </div>`).join('');
    return `
      <div class="panel-head">
        <div><div class="eyebrow">Faction objective</div><h3>${esc(o.title)}</h3></div>
        ${Number.isFinite(o.endsAt) ? `<span class="sticker flat">till ${esc(clockOf(o.endsAt))}</span>` : ''}
      </div>
      ${o.blurb ? `<p>${esc(o.blurb)}</p>` : ''}
      <div style="display:flex;height:16px;margin-top:12px;border:2px solid var(--ink);background:var(--inset)" aria-hidden="true">${bar}</div>
      <div class="vitals-row" style="margin-top:12px">${legend}</div>
      <p class="ob-hint">${total > 0
        ? 'Scored from shifts served and strongholds held, not from walking around.'
        : 'No side has scored yet. Points come from shifts served and strongholds held, not from walking around.'}</p>`;
  }

  /* ------------------------------------------------------------------ *
   * Sponsor-booth scanner
   * ------------------------------------------------------------------ */

  function scannerHtml() {
    return `
      <div class="px">
        <div class="panel-head">
          <div><div class="eyebrow">Sponsor booths</div><h3>Claim a bounty</h3></div>
          <button class="pb pb-sm" type="button" id="scan-toggle" data-action="quests-scan-camera">Use camera</button>
        </div>
        <video id="scan-video" playsinline muted hidden style="width:100%;max-height:220px;background:var(--ink);border:2px solid var(--ink)"></video>
        <form id="scan-form" novalidate style="margin-top:12px">
          <label class="eyebrow" for="scan-code">Or type the code under the QR</label>
          <input class="px-input code" id="scan-code" maxlength="120" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="booth-boneyard-labs:7F2A9C114B3E">
          <div class="btn-row" style="margin-top:10px"><button class="pb pb-sm" type="submit">Claim</button></div>
        </form>
        <div class="ob-status" id="scan-status" role="status"></div>
        <p class="ob-hint">One claim per booth per account, so a photograph of somebody else's placard still only works once.</p>
      </div>`;
  }

  function setScan(tone, text) {
    const el = document.getElementById('scan-status');
    if (!el) return;
    el.className = `ob-status${tone ? ` ${tone}` : ''}`;
    el.textContent = text || '';
  }

  function paintScanButton() {
    const btn = document.getElementById('scan-toggle');
    if (btn) btn.textContent = state.scan.stream ? 'Stop camera' : 'Use camera';
  }

  const parseCode = (raw) => {
    const m = BOOTH_CODE.exec(String(raw ?? '').trim());
    return m ? { boothId: m[1], code: m[2] } : null;
  };

  async function claim(raw) {
    if (state.scan.busy) return;
    const parsed = parseCode(raw);
    if (!parsed) { setScan('is-err', 'That is not a booth code. They look like "booth-boneyard-labs:7F2A9C114B3E".'); return; }
    state.scan.busy = true;
    setScan('', 'Claiming…');
    try {
      const { data } = await N.api(`/api/v1/game/booths/${encodeURIComponent(parsed.boothId)}/scan`, {
        method: 'POST',
        body: { code: parsed.code },
      });
      stopCamera();
      const karma = Number(data?.awardedKarma) || 0;
      const prize = stickerName(data?.sticker) || (data?.powerUp ? String(data.powerUp).replace(/_/g, ' ').toLowerCase() : '');
      // `karmaCapped` is the daily booth budget having held part of the award back. Saying so
      // is the difference between a generous booth and a bug the player reports.
      setScan('is-ok', `${data?.name || parsed.boothId} claimed${karma ? ` for ${karma} karma` : ''}${prize ? ` and a ${prize}` : ''}.`
        + (data?.karmaCapped ? ' The daily booth karma cap took the rest.' : ''));
      const input = document.getElementById('scan-code');
      if (input) input.value = '';
      void load();
    } catch (err) {
      setScan('is-err', err.status === 409 ? 'You have already claimed this booth. One per account.'
        : err.status === 404 ? 'No booth answers to that id.'
          : err.status === 403 ? 'That code does not belong to this booth. Read it off the placard again.'
            : err.message);
    } finally {
      state.scan.busy = false;
    }
  }

  /**
   * The camera path exists only where the browser decodes QR itself. Shipping a decoder
   * would be a second copy of something Chrome and Android already have, and the typed
   * code is the fallback either way. It is printed on the placard for exactly this.
   */
  async function startCamera() {
    const video = document.getElementById('scan-video');
    if (!video) return;
    if (!navigator.mediaDevices?.getUserMedia) { setScan('is-warn', 'This browser has no camera. Type the code instead.'); return; }
    if (typeof window.BarcodeDetector !== 'function') { setScan('is-warn', 'This browser cannot read QR codes. Type the code under it instead.'); return; }

    let detector = null;
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch { detector = null; }
    if (!detector) { setScan('is-warn', 'This browser cannot read QR codes. Type the code under it instead.'); return; }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    } catch (err) {
      setScan('is-err', err?.name === 'NotAllowedError'
        ? 'Camera blocked for this page. Type the code instead.'
        : 'No camera answered. Type the code instead.');
      return;
    }

    state.scan.stream = stream;
    state.scan.detector = detector;
    state.scan.last = null;
    video.srcObject = stream;
    video.hidden = false;
    try { await video.play(); } catch { /* autoplay refused; frames still arrive for detect() */ }
    state.scan.timer = setInterval(() => { void readFrame(); }, SCAN_MS);
    setScan('', 'Point it at the QR on the placard.');
    paintScanButton();
  }

  async function readFrame() {
    const video = document.getElementById('scan-video');
    if (!state.scan.detector || !video || video.readyState < 2 || state.scan.busy) return;
    let codes = [];
    try { codes = await state.scan.detector.detect(video); } catch { return; }
    const raw = codes[0]?.rawValue;
    // The same placard is in frame three times a second. Claiming it once is the point.
    if (!raw || raw === state.scan.last) return;
    state.scan.last = raw;
    await claim(raw);
  }

  function stopCamera() {
    if (state.scan.timer) { clearInterval(state.scan.timer); state.scan.timer = null; }
    for (const track of state.scan.stream?.getTracks() || []) track.stop();
    state.scan.stream = null;
    state.scan.detector = null;
    state.scan.last = null;
    const video = document.getElementById('scan-video');
    if (video) { video.srcObject = null; video.hidden = true; }
    paintScanButton();
  }

  /* ------------------------------------------------------------------ *
   * Painting
   * ------------------------------------------------------------------ */

  function mount() {
    state.section.innerHTML = `
      <div class="view-head">
        <div>
          <div class="eyebrow">Play loop</div>
          <h2>Quests</h2>
          <p>What the event is asking of you this hour, where it is worth more right now, and the codes on the sponsor tables.</p>
        </div>
        <div class="actions">
          <button class="pb pb-ghost pb-sm" type="button" data-action="quests-refresh">Refresh</button>
        </div>
      </div>
      <div class="split">
        <div class="rail">
          <div id="quests-raid" hidden></div>
          <div class="px" id="quests-board"></div>
        </div>
        <div class="rail">
          <div class="px" id="quests-objective"></div>
          ${scannerHtml()}
        </div>
      </div>`;
    state.mounted = true;
  }

  function paint() {
    const el = state.section;
    if (!el) return;
    if (!N.session.user) {
      stopCamera();
      stopTick();
      state.mounted = false;
      el.innerHTML = '<div class="empty-state">Sign in to see what the event is asking of you.<button class="pb" type="button" data-action="session">Sign in</button></div>';
      return;
    }
    if (!state.mounted) mount();

    const raidHost = document.getElementById('quests-raid');
    if (raidHost) {
      raidHost.innerHTML = raidHtml();
      raidHost.hidden = !state.raid;
    }
    const board = document.getElementById('quests-board');
    if (board) board.innerHTML = boardHtml();
    const objective = document.getElementById('quests-objective');
    if (objective) objective.innerHTML = objectiveHtml();

    if (state.raid) startTick(); else stopTick();
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  N.registerAction('quests-refresh', () => { void load(); });

  N.registerAction('quests-raid-join', (el) => {
    const venue = el?.dataset?.venue;
    if (!venue) return;
    // app.js owns the camera and the warm-up retry; this is the same door the gym cards use.
    const locate = N.action('locate');
    if (locate) { locate(el); return; }
    window.game?.toast?.('The campus map has not loaded yet.');
  });

  N.registerAction('quests-scan-camera', () => {
    if (state.scan.stream) { stopCamera(); setScan('', ''); return; }
    void startCamera();
  });

  N.registerTab({
    id: TAB_ID,
    label: 'Quests',
    order: 20,
    roles: ['VOLUNTEER', 'SHIFT_LEAD', 'ORGANIZER', 'ADMIN', 'HACKER'],
    render(section) {
      state.section = section;
      section.addEventListener('submit', (event) => {
        if (event.target.id !== 'scan-form') return;
        event.preventDefault();
        void claim(document.getElementById('scan-code')?.value || '');
      });
      // sprites.js loads after this file and fetches the sticker sheet asynchronously.
      // Repaint once it is in so reward art appears without a manual refresh.
      window.Sprites?.ready?.then?.(() => { if (state.mounted) paint(); }).catch(() => {});
      paint();
      void load();
    },
    onShow() { void load(); },
    // A camera running behind a hidden tab is a camera nobody asked for, and the raid
    // clock has nothing to tick for.
    onHide() { stopCamera(); stopTick(); },
  });

  N.onEvent('session:ready', ({ user }) => { if (user) void load(); else paint(); });
  // Paint on any session change; *load* when somebody signs in at runtime.
  //
  // `session:ready` fires once, at boot. A user who lands signed out and then signs in — a
  // badge scan at the desk, the only path in `AUTH_MODE=required` — got a repaint of empty
  // state and nothing else, so this tab sat blank until they navigated away and back.
  N.onEvent('session', (user) => { if (user) void load(); else paint(); });

  // Same as Me, plus the camera: a scanner stream opened by the previous person keeps
  // running through a handover, because `stopCamera` otherwise only fires when the tab hides
  // or the session goes empty — and neither happens when one account replaces another.
  N.onEvent('session:handover', () => {
    generation += 1;
    state.loading = false;
    stopCamera();
    state.quests = [];
    state.raid = null;
    state.objective = null;
    paint();
    void load();
  });

  // Everything a quest counts, plus the two tickers that move a raid or an objective.
  for (const type of [
    'QUEST_COMPLETED', 'STICKER_AWARDED', 'SLOT_RESERVED', 'VOLUNTEER_CHECKED_IN', 'VOLUNTEER_CHECKED_OUT',
    'HACKSTOP_SPUN', 'GYM_CAPTURED', 'SOS_TICKET_RESOLVED',
    // The names the server actually publishes. `RAID_STARTED`, `RAID_ENDED`,
    // `OBJECTIVE_UPDATED` and `OBJECTIVE_CLOSED` are plausible and are not among them, so
    // this view sat inert through every raid window — no live banner, no roster, nothing
    // until somebody pressed Refresh. `scripts/checkEvents.mjs` now fails the build on a
    // name either side has invented.
    'RAID_OPENED', 'RAID_CLOSED', 'RAID_JOINED', 'REGISTRATION_CANCELLED',
  ]) {
    N.onEvent(type, () => { if (state.section) void load(); });
  }

  // The tab can stay "shown" while the page itself is backgrounded; the stream must not.
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
})();
