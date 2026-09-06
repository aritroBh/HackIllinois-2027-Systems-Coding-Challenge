/**
 * game — the Pokémon-Go layer over the war room.
 *
 * Owns the trainer (name, faction, level, avatar), the sticker book
 * (memorabilia earned vs. still `???`), the overworld HUD painted over the
 * 3D campus, the "walk to spin" proximity gate, the gym encounter overlay,
 * and the duck who narrates events in speech bubbles.
 *
 * Every call into the renderer is guarded: the player API lands in
 * public/gl/campus3d.js independently, and the dashboard must degrade to a
 * plain map when a method is missing.
 *
 * Plain script; app.js calls into `window.game`.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const has = (fn) => typeof window.campus?.[fn] === 'function';
  const escq = (v) => (typeof esc === 'function' ? esc(v) : String(v ?? ''));

  const STICKER_KEY = 'nexus.stickers.v1';
  // Walk-mode persistence lives in `state.flags.__walk` (saved with the
  // stickers); the old separate `nexus.walk.v1` key was never read.
  const PROX_RADIUS = 75;

  const state = {
    name: 'Trainer',
    faction: 'TEAM_KERNEL',
    karma: 0,
    hours: 0,
    level: 1,
    head: null,          // ImageData 32×32
    sheet: null,         // canvas 128×48 from avatar.sprite
    palette: 'SNES16',
    flags: loadFlags(),
    earned: new Set(),
    fresh: new Set(),    // earned since last time the book was opened
    nearby: new Map(),   // key → { kind, id, distanceMeters, target }
    walking: false,
    geoWatch: null,
    retro: false,
    cameraMode: 'orbit',
    encounter: null,
    avatarMod: null,
    lastHud: 0,
  };

  function loadFlags() {
    try { return JSON.parse(localStorage.getItem(STICKER_KEY) || '{}'); } catch { return {}; }
  }
  function saveFlags() {
    try { localStorage.setItem(STICKER_KEY, JSON.stringify(state.flags)); } catch { /* private mode */ }
  }

  /** Level from karma: 1 at 0, 5 at ~800, 12 at ~6000. */
  const levelFor = (karma) => Math.max(1, 1 + Math.floor(Math.sqrt(Math.max(0, karma) / 50)));
  const levelProgress = (karma) => {
    const lv = levelFor(karma);
    const lo = 50 * (lv - 1) ** 2, hi = 50 * lv ** 2;
    return Math.min(1, Math.max(0, (karma - lo) / (hi - lo)));
  };

  /* ------------------------------------------------------------------ *
   * Duck toasts
   * ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(text, { ms = 4200 } = {}) {
    let host = $('duck-toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'duck-toasts';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="toast-duck">${window.Sprites?.img('duck', 3) || ''}</span><div class="bubble">${escq(text)}</div>`;
    host.prepend(el);
    while (host.children.length > 3) host.lastChild.remove();
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 220); }, ms);
    clearTimeout(toastTimer);
  }

  /* ------------------------------------------------------------------ *
   * Trainer + sticker book
   * ------------------------------------------------------------------ */

  function syncFromCaches() {
    // The signed-in account when there is one; the first roster entry is the
    // legacy fallback that goes away with the role router in M5.
    const u = window.Nexus?.session?.user;
    const vol = u ? { name: u.displayName, karmaPoints: u.karmaPoints, hoursServed: u.hoursServed } : (window.volunteersCache || [])[0];
    if (vol) {
      state.name = vol.name || state.name;
      state.karma = Number(vol.karmaPoints) || 0;
      state.hours = Number(vol.hoursServed) || 0;
    }
    state.faction = window.currentVolunteerFaction || state.faction;
    state.level = levelFor(state.karma);
  }

  /** Which memorabilia this trainer has earned. */
  function computeEarned() {
    const S = window.Sprites;
    const earned = new Set();
    const inv = window.userInventoryCache || [];
    for (const it of inv) {
      const n = String(it.name || it.itemType || '').toLowerCase();
      if (n.includes('brew')) earned.add('cold-brew');
      if (n.includes('duck')) earned.add('rubber-duck');
      if (n.includes('solder')) earned.add('soldering-iron');
      if (n.includes('cookie') || n.includes('shield')) earned.add('cleanup-patch');
    }
    const badges = S?.gymBadges() || {};
    const gyms = window.gymsCache || [];
    for (const g of gyms) {
      if (g.controllingFaction !== state.faction) continue;
      const mon = typeof monumentForGym === 'function' ? monumentForGym(g) : null;
      if (mon && badges[mon.id]) earned.add(badges[mon.id]);
    }
    for (const [k, v] of Object.entries(state.flags)) if (v && S?.item(k)) earned.add(k);
    for (const id of earned) if (!state.earned.has(id) && state.earned.size) state.fresh.add(id);
    state.earned = earned;
    return earned;
  }

  /** Award a sticker by id (persisted); duck announces it. */
  function award(id, why) {
    const S = window.Sprites;
    if (!S?.item(id) || state.flags[id]) return false;
    state.flags[id] = Date.now();
    saveFlags();
    state.fresh.add(id);
    computeEarned();
    toast(`You found ${S.item(id).name}! It went into the sticker book.${why ? ' ' + why : ''}`);
    window.fx?.burst(window.innerWidth / 2, 120, '#FCB316', 30);
    renderTrainer();
    return true;
  }

  const RARITY_ORDER = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'];

  function renderTrainer() {
    const S = window.Sprites;
    if (!S) return;
    syncFromCaches();
    computeEarned();
    const f = (typeof factionOf === 'function' ? factionOf(state.faction) : null) || { color: '#35B8C4', label: state.faction, short: 'KERNEL' };

    // Profile card.
    const prof = $('trainer-card');
    if (prof) {
      const pct = levelProgress(state.karma);
      const segs = 16;
      const on = Math.round(pct * segs);
      const ring = Array.from({ length: segs }, (_, i) => {
        const a = (i / segs) * Math.PI * 2 - Math.PI / 2;
        const x = 50 + Math.cos(a) * 40, y = 50 + Math.sin(a) * 40;
        return `<i class="${i < on ? 'on' : ''}" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%"></i>`;
      }).join('');
      const badges = S.gymBadges();
      const gyms = window.gymsCache || [];
      const shelf = Object.entries(badges).map(([monId, itemId]) => {
        const held = gyms.some((g) => g.controllingFaction === state.faction && (typeof monumentForGym === 'function' ? monumentForGym(g)?.id : null) === monId);
        return `<span class="badge ${held ? 'on' : ''}" title="${escq(S.item(itemId)?.name || itemId)}">${held ? S.img(itemId, 2) : '<b>?</b>'}</span>`;
      }).join('');
      const avatar = state.head ? `<img class="pxi" alt="Your avatar" src="${S.imageDataURL(state.head, 3)}">` : S.img('trainer', 6);
      prof.innerHTML = `
        <div class="tc-top">
          <div class="tc-avatar"><div class="ring">${ring}</div>${avatar}</div>
          <div class="tc-id">
            <div class="tc-name">${escq(state.name)}</div>
            <div class="tc-fac" style="--c:${f.color}"><i></i>${escq(f.label || f.short)} · ${escq(state.faction === 'NEUTRAL' ? 'Free agent' : 'Field ops')}</div>
            <div class="tc-stats">
              <span><b>${state.level}</b><small>LEVEL</small></span>
              <span><b>${state.karma.toLocaleString()}</b><small>KARMA</small></span>
              <span><b>${state.hours}</b><small>HOURS</small></span>
            </div>
          </div>
        </div>
        <div class="hud-label">BADGE SHELF · ${Object.values(badges).filter((_, i) => shelf.split('badge on').length - 1 > i).length ? '' : ''}${shelf.split('class="badge on"').length - 1}/${Object.keys(badges).length}</div>
        <div class="badge-shelf">${shelf}</div>`;
    }

    // Sticker book.
    const book = $('sticker-book');
    if (book) {
      const all = S.items().slice().sort((a, b) => RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity));
      const found = all.filter((it) => state.earned.has(it.id)).length;
      const count = $('sticker-count');
      if (count) count.textContent = `${found} / ${all.length} FOUND`;
      book.innerHTML = all.map((it) => {
        const got = state.earned.has(it.id);
        const fresh = state.fresh.has(it.id);
        return `
          <button class="sticker-cell rarity-${escq(it.rarity)} ${got ? 'got' : 'missing'}" data-action="sticker" data-item="${escq(it.id)}" title="${escq(got ? it.name : 'Not found yet')}">
            ${fresh ? '<span class="sticker new">NEW!</span>' : ''}
            <span class="cell-art">${got ? S.img(it.id, 4) : '<b>???</b>'}</span>
            <span class="cell-name">${escq(got ? it.name : '???')}</span>
            <span class="cell-rarity">${escq(it.rarity)}</span>
          </button>`;
      }).join('');
    }
  }

  function showSticker(id) {
    const S = window.Sprites;
    const it = S?.item(id);
    const box = $('sticker-detail');
    if (!it || !box) return;
    const got = state.earned.has(id);
    state.fresh.delete(id);
    box.innerHTML = `
      <div class="sd-art rarity-${escq(it.rarity)}">${got ? S.img(id, 6) : '<b>?</b>'}</div>
      <div class="sd-body">
        <div class="sd-name">${escq(got ? it.name : 'Unknown sticker')}</div>
        <div class="hud-label rarity-${escq(it.rarity)}">${escq(it.rarity)} · ${escq(it.kind)}</div>
        <p class="sd-flavour">${escq(got ? it.flavour : 'Find it to read what it says.')}</p>
        <div class="sd-drop">${window.Sprites.img('pin', 2)}<span>${escq(it.drop)}</span></div>
      </div>`;
    box.classList.add('open');
  }

  /* ------------------------------------------------------------------ *
   * Avatar creator (public/avatar.js)
   * ------------------------------------------------------------------ */

  async function avatar() {
    if (!state.avatarMod) state.avatarMod = await import('/dashboard/avatar.js');
    return state.avatarMod;
  }

  const creator = { source: null, heads: {}, palette: 'SNES16', dither: true, cap: true };

  async function creatorRender() {
    const A = await avatar();
    const S = window.Sprites;
    if (!creator.source) return;
    for (const name of ['GAMEBOY', 'SNES16', 'NEORETRO']) {
      creator.heads[name] = A.pixelate(creator.source, { palette: A.PALETTES[name], dither: creator.dither, size: 32 });
      const img = $(`cre-${name}`);
      if (img) img.src = S.imageDataURL(creator.heads[name], 4);
    }
    document.querySelectorAll('.cre-pal').forEach((el) => el.classList.toggle('on', el.dataset.pal === creator.palette));
    creatorPreviewSheet();
    $('cre-step')?.replaceChildren(document.createTextNode('STEP 2 / 3 · PICK A PALETTE'));
  }

  async function creatorPreviewSheet() {
    const A = await avatar();
    const head = creator.heads[creator.palette];
    if (!head) return;
    const sheet = A.sprite(head, { faction: state.faction, cap: creator.cap });
    const host = $('cre-sheet');
    if (host) {
      host.replaceChildren();
      const c = document.createElement('canvas');
      c.width = sheet.width * 2; c.height = sheet.height * 2; c.className = 'pxi';
      const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sheet, 0, 0, c.width, c.height);
      host.appendChild(c);
    }
    creator.sheet = sheet;
    $('cre-keep')?.removeAttribute('disabled');
  }

  async function creatorFromFile(file) {
    const A = await avatar();
    creator.source = await A.fromImageFile(file);
    await creatorRender();
    toast('Nice photo. Pick the palette that looks most like you.');
  }

  async function creatorFromCamera() {
    const A = await avatar();
    const video = $('cre-video');
    const status = $('cre-status');
    try {
      if (video) video.hidden = false;
      creator.source = await A.captureFromCamera(video, {
        countdown: 3,
        onTick: (n) => { if (status) status.textContent = n > 0 ? `${n}…` : 'Say cheese!'; },
      });
      if (video) video.hidden = true;
      await creatorRender();
      toast("That's you! Pick a palette.");
    } catch (err) {
      if (video) video.hidden = true;
      const why = err?.reason === 'denied' ? 'Camera permission was denied — upload a photo instead.'
        : err?.reason === 'insecure' ? 'Camera needs HTTPS or localhost — upload a photo instead.'
        : 'No camera found — upload a photo instead.';
      if (status) status.textContent = why;
      toast(why);
    }
  }

  function creatorSynthetic() {
    // A drawn face so the flow can be tried without a camera.
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1F3D6E'; ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#E8A87C'; ctx.beginPath(); ctx.ellipse(128, 132, 74, 90, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3B2A1E'; ctx.beginPath(); ctx.ellipse(128, 70, 80, 44, 0, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2B1B12'; ctx.fillRect(94, 120, 18, 12); ctx.fillRect(144, 120, 18, 12);
    ctx.fillStyle = '#B57A4B'; ctx.fillRect(112, 172, 34, 8);
    ctx.fillStyle = '#FF5F05'; ctx.fillRect(48, 224, 160, 32);
    creator.source = c;
    creatorRender();
  }

  async function creatorKeep() {
    const A = await avatar();
    const head = creator.heads[creator.palette];
    if (!head) return;
    state.head = head;
    state.palette = creator.palette;
    state.sheet = creator.sheet || A.sprite(head, { faction: state.faction, cap: creator.cap });
    A.saveAvatar({ head, faction: state.faction, cap: creator.cap, palette: A.PALETTES[creator.palette] });
    applyPlayerSprite();
    award('lanyard', 'Welcome to the roster.');
    $('cre-step')?.replaceChildren(document.createTextNode('STEP 3 / 3 · SAVED'));
    toast("Looking sharp. That's you on the map now.");
    renderTrainer();
    updateHud(true);
  }

  function applyPlayerSprite() {
    if (!state.head || !has('setPlayerSprite')) return;
    // Prefer the full 128×48 body sheet (stand / step / stand / step); the
    // renderer falls back to bobbing the bare 32×32 head if the sheet is
    // rejected by an older build.
    const ok = state.sheet ? window.campus.setPlayerSprite(state.sheet) : false;
    if (!ok) window.campus.setPlayerSprite(state.head);
  }

  /* ------------------------------------------------------------------ *
   * Overworld: player, walking, proximity, HUD
   * ------------------------------------------------------------------ */

  function onCampusReady() {
    if (!window.campus) return;
    if (has('setPlayer')) {
      window.campus.setPlayer({ x: -2, z: -8, name: state.name, faction: state.faction });
      applyPlayerSprite();
    }
    if (has('setProximityRadius')) window.campus.setProximityRadius(PROX_RADIUS);
    gateSpins(); // the player now exists, so measure instead of the demo fallback
    // Proximity events fire on the 75 m edge; the tick keeps the distance labels
    // honest while the player walks and covers a smoothing/render race.
    if (!state.gateTimer) state.gateTimer = setInterval(() => { if (window.campus?.getPlayer?.()) gateSpins(); }, 1500);
    if (state.flags.__walk && !state.walking && navigator.permissions?.query) {
      navigator.permissions.query({ name: 'geolocation' }).then((perm) => {
        const onCampusTab = document.getElementById('tab-campus')?.classList.contains('active');
        if (perm.state === 'granted' && onCampusTab) toggleWalk(true, { silent: true });
      }).catch(() => {});
    }
    updateHud(true);
  }

  function onProximity(e) {
    const key = `${e.kind}:${e.id}`;
    if (e.entered) {
      state.nearby.set(key, e);
      if (e.kind === 'beacon' || e.kind === 'hackstop') toast(`A HackStop is in range — ${Math.round(e.distanceMeters)} m. Spin it!`);
      if (e.kind === 'monument') toast(`${String(e.target?.name || e.id)} is right here. Hold it for ${String(window.currentVolunteerFaction || '').replace('TEAM_', 'Team ')}?`);
    } else {
      state.nearby.delete(key);
    }
    gateSpins();
    updateHud(true);
  }

  /** Disable Spin buttons until the player stands within the geofence. */
  function gateSpins() {
    if (!has('getNearby') || !window.campus.getPlayer?.()) {
      // No renderer, or a trainer that has not been placed: there is nothing to measure, and
      // "nothing to measure" is not a reason to allow the action. This branch used to force
      // every Spin button ENABLED, which together with the target-coordinates fallback in
      // app.js made the 75 m geofence unreachable: a fresh profile could spin every beacon on
      // campus without moving. The button stays disabled and says what would enable it.
      document.querySelectorAll('[data-action="spin"]').forEach((btn) => {
        btn.disabled = true;
        btn.textContent = 'Spin';
        btn.title = 'Open Campus and place your trainer to spin this HackStop';
      });
      return;
    }
    const near = window.campus.getNearby(PROX_RADIUS);
    const nearIds = new Set(near.map((n) => String(n.id)));
    const all = window.campus.getNearby(5000);
    const byId = new Map(all.map((n) => [String(n.id), n]));
    // Fallback when the renderer keys beacons differently from the API: the
    // button carries the stop's lat/lng, so measure from the player directly.
    const p = window.campus.getPlayer();
    const mpu = window.campusMeta?.metersPerUnit || 10;
    const measure = (btn) => {
      if (typeof window.toWorld !== 'function' || !p) return NaN;
      const w = window.toWorld(Number(btn.dataset.lat), Number(btn.dataset.lon));
      return Math.hypot(w.x - p.x, w.z - p.z) * mpu;
    };
    document.querySelectorAll('[data-action="spin"]').forEach((btn) => {
      const id = btn.dataset.beacon;
      let d = byId.get(id)?.distanceMeters;
      if (!Number.isFinite(d)) d = measure(btn);
      const ok = nearIds.has(id) || (Number.isFinite(d) && d <= PROX_RADIUS);
      const label = ok ? 'Spin' : (Number.isFinite(d) ? `${Math.round(d)} m` : 'Walk closer');
      // Only touch the DOM on change: this runs on a tick while the player walks.
      if (btn.disabled !== !ok) btn.disabled = !ok;
      if (btn.textContent !== label) btn.textContent = label;
      btn.title = ok ? 'Spin this HackStop' : `Walk to within ${PROX_RADIUS} m to spin`;
    });
  }

  function toggleWalk(force, { silent = false } = {}) {
    const on = typeof force === 'boolean' ? force : !state.walking;
    const btn = $('walk-btn');
    if (on) {
      if (!navigator.geolocation) { toast('No geolocation on this device — use WASD on the map instead.'); return; }
      if (!has('setPlayerLatLng')) { toast('The map is still loading the player layer.'); return; }
      state.geoWatch = navigator.geolocation.watchPosition(
        (pos) => {
          const r = window.campus.setPlayerLatLng(pos.coords.latitude, pos.coords.longitude);
          // Share the fix with the presence service (it decides whether to publish: the
          // opt-in, the 10 m / 5 s cadence and the accuracy gate all live there).
          window.Nexus?.presence?.publish?.(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? 999, pos.coords.heading ?? undefined);
          if (r && !r.onCampus && !state.flags.__offCampusToldAt) {
            state.flags.__offCampusToldAt = Date.now(); saveFlags();
            toast("You're off campus, so your sprite waits at the map edge. It'll walk with you once you're on the Quad.");
          }
        },
        (err) => { toast(`Location unavailable: ${err.message}. WASD still works.`); toggleWalk(false); },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
      );
      state.walking = true;
      state.flags.__walk = 1; saveFlags();
      if (has('setCameraMode')) { window.campus.setCameraMode('follow'); state.cameraMode = 'follow'; }
      if (!silent) toast('Walking with you. Head for the Quad — the sprite follows your GPS.');
    } else {
      if (state.geoWatch != null) navigator.geolocation?.clearWatch(state.geoWatch);
      state.geoWatch = null;
      state.walking = false;
      state.flags.__walk = 0; saveFlags();
    }
    if (btn) { btn.classList.toggle('pressed', state.walking); btn.setAttribute('aria-pressed', String(state.walking)); }
  }

  function toggleFollow() {
    if (!has('setCameraMode')) return;
    state.cameraMode = state.cameraMode === 'follow' ? 'orbit' : 'follow';
    window.campus.setCameraMode(state.cameraMode);
    $('follow-btn')?.classList.toggle('pressed', state.cameraMode === 'follow');
  }

  function toggleRetro() {
    state.retro = !state.retro;
    $('retro-btn')?.classList.toggle('pressed', state.retro);
    // Renderer contract: pixelation and posterize are 0..1 strengths.
    if (has('setRetro')) window.campus.setRetro(state.retro ? { pixelation: 0.7, posterize: 0.6, scanlines: true } : { pixelation: 0, posterize: 0, scanlines: false });
    else if (state.retro) toast('Retro post-process is not in this build of the renderer yet.');
    $('retro-btn')?.setAttribute('aria-pressed', String(state.retro));
    document.getElementById('campus-viewport')?.classList.toggle('retro', state.retro);
  }

  /** HUD over the map: avatar/level, control meter, minimap, nearest stop, WASD hint. */
  function updateHud(force = false) {
    const now = performance.now();
    if (!force && now - state.lastHud < 500) return;
    state.lastHud = now;
    const S = window.Sprites;

    const lv = $('hud-level');
    if (lv) {
      syncFromCaches();
      const pct = Math.round(levelProgress(state.karma) * 100);
      lv.innerHTML = `${state.head ? `<img class="pxi" alt="" src="${S.imageDataURL(state.head, 1)}">` : S.img('trainer', 2)}<div><div class="hud-label">${escq(state.name.toUpperCase())} · LV ${state.level}</div><div class="pxbar"><i style="width:${pct}%"></i></div><div class="hud-label fac" style="--c:${factionOf?.(state.faction)?.color || '#35B8C4'}">■ ${escq(String(state.faction).replace('TEAM_', 'TEAM '))}</div></div>`;
    }

    const ctrl = $('hud-control');
    if (ctrl) {
      const gyms = window.gymsCache || [];
      const tally = { TEAM_KERNEL: 0, TEAM_TENSOR: 0, TEAM_SILICON: 0, NEUTRAL: 0 };
      for (const g of gyms) tally[tally[g.controllingFaction] != null ? g.controllingFaction : 'NEUTRAL']++;
      const total = Math.max(1, gyms.length);
      ctrl.innerHTML = `<div class="hud-label">CAMPUS CONTROL</div><div class="ctrl-meter">${Object.entries(tally).map(([k, n]) => `<i style="width:${(n / total) * 100}%;background:${factionOf?.(k)?.color || '#7C8DAA'}"></i>`).join('')}</div><div class="ctrl-legend">${Object.entries(tally).map(([k, n]) => `<span><i style="background:${factionOf?.(k)?.color || '#7C8DAA'}"></i>${n}</span>`).join('')}</div>`;
    }

    const mini = $('hud-minimap');
    if (mini && has('renderMinimap')) window.campus.renderMinimap(mini);

    const near = $('hud-nearest');
    if (near) {
      const list = has('getNearby') && window.campus.getPlayer?.() ? window.campus.getNearby(1200) : [];
      const stop = list.filter((n) => n.kind === 'beacon' || n.kind === 'hackstop').sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
      if (stop) {
        const name = stop.target?.name || (window.hackStopsCache || []).find((s) => s.beaconId === stop.id)?.name || 'HackStop';
        const d = Math.round(stop.distanceMeters);
        const inRange = d <= PROX_RADIUS;
        const segs = 8, on = Math.max(0, Math.min(segs, Math.round(segs * (1 - Math.min(1, d / 600)))));
        near.innerHTML = `<div class="hud-label">NEAREST HACKSTOP ${S.img('stop', 2)}</div><div class="near-name">${escq(name)}</div><div class="near-dist"><b>${d} m</b><span>${inRange ? 'in range — spin it!' : `walk ${d - PROX_RADIUS} m closer to spin`}</span></div><div class="segbar">${Array.from({ length: segs }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>`;
        near.hidden = false;
      } else {
        near.innerHTML = `<div class="hud-label">NEAREST HACKSTOP</div><div class="near-dist"><span>${window.campus?.getPlayer?.() ? 'Nothing in 1.2 km. Head for the Quad.' : 'Place your trainer to start walking.'}</span></div>`;
      }
    }

    const hint = $('hud-hint');
    if (hint) hint.textContent = state.walking ? 'GPS · walking with you' : 'WASD / arrows to walk · drag to look';
  }

  /** Called from the renderer's frame callback via app.js. */
  function tick(payload) {
    if (payload?.dist != null) updateHud(false);
  }

  /* ------------------------------------------------------------------ *
   * Gym encounter (the SNES battle window)
   * ------------------------------------------------------------------ */

  function openEncounter(gymId) {
    const g = (window.gymsCache || []).find((x) => x._id === gymId);
    if (!g) return;
    state.encounter = { gymId, msgIdx: 0, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null };
    const enemyF = factionOf(g.controllingFaction);
    const mine = factionOf(state.faction);
    const myGyms = (window.gymsCache || []).filter((x) => x.controllingFaction === state.faction);
    const myCp = myGyms.reduce((n, x) => n + (Number(x.controlPoints) || 0), 0);
    const myMax = Math.max(1, myGyms.reduce((n, x) => n + (Number(x.maxControlPoints) || 0), 0));
    const mon = typeof monumentForGym === 'function' ? monumentForGym(g) : null;
    const info = mon && window.monumentInfo ? window.monumentInfo[mon.id] : null;
    const kind = mon?.kind || 'hall';
    const ally = g.controllingFaction === state.faction || g.controllingFaction === 'NEUTRAL';
    const first = info?.facts?.[0] ? `${g.locationName.toUpperCase()}: ${info.facts[0]}` : `${g.locationName.toUpperCase()} stands before you.`;
    const msg = `${escq(first)} ${escq(enemyF.short || enemyF.label)} ${ally ? 'holds the line with you.' : 'braces.'} What will ${escq(mine.short || mine.label)} do?`;
    const host = $('encounter');
    if (!host) return;
    host.innerHTML = `
      <div class="enc-stage">
        <div class="jrpg enemy">
          <div class="plate">ENEMY GYM</div>
          <div class="enc-name">${escq(g.locationName)}<small>Lv${Number(g.level) || 1}</small></div>
          <div class="hud-label" style="color:${enemyF.color}">HELD BY ${escq(enemyF.label)} · ${escq(info?.style || 'STRONGHOLD')}</div>
          <div class="hpbar"><span class="hud-label">CP</span><div class="pxbar big"><i style="width:${Math.min(100, (g.controlPoints / g.maxControlPoints) * 100)}%;background:${enemyF.color}"></i></div><span class="mono">${Number(g.controlPoints)}/${Number(g.maxControlPoints)}</span></div>
        </div>
        <div class="enc-art enemy">${window.Sprites.img(kind, 5)}</div>
        <div class="enc-art you">${state.head ? `<img class="pxi" alt="" src="${window.Sprites.imageDataURL(state.head, 3)}">` : window.Sprites.img('trainer', 6)}</div>
        <div class="jrpg you">
          <div class="plate">YOUR FACTION</div>
          <div class="enc-name" style="color:${mine.color}">${escq(mine.label)}<small>Lv${state.level} · ${myGyms.length} held</small></div>
          <div class="hpbar"><span class="hud-label">CP</span><div class="pxbar big"><i style="width:${Math.min(100, (myCp / myMax) * 100)}%;background:${mine.color}"></i></div><span class="mono">${myCp}/${myMax}</span></div>
          <div class="hpbar"><span class="hud-label">EXP</span><div class="pxbar big"><i style="width:${Math.round(levelProgress(state.karma) * 100)}%;background:#FCB316"></i></div></div>
        </div>
        <div class="jrpg cmd">
          <div class="plate">COMMAND</div>
          <button class="cmd ${ally ? '' : 'first'}" data-action="enc-cmd" data-cmd="contest" ${ally ? 'disabled' : ''}>FIGHT <small>(−150 CP)</small></button>
          <button class="cmd ${ally ? 'first' : ''}" data-action="enc-cmd" data-cmd="reinforce" ${ally ? '' : 'disabled'}>REINFORCE <small>(+150 CP)</small></button>
          <button class="cmd" data-action="enc-cmd" data-cmd="bag">BAG</button>
          <button class="cmd" data-action="enc-cmd" data-cmd="map">MAP · LOCATE</button>
          <button class="cmd" data-action="enc-cmd" data-cmd="run">RUN</button>
        </div>
        <div class="jrpg msg"><div id="enc-msg">${msg}</div><span class="cursor">▼</span></div>
      </div>`;
    const initial = host.querySelector('.cmd.first') || host.querySelector('.cmd');
    if (window.Nexus?.dialog) {
      // Focus trap, Escape and return-focus come from the registry now.
      // `returnFocus` is only honoured on first open; a re-render after a
      // command keeps the original opener.
      window.Nexus.dialog.open(host, {
        returnFocus: state.encounter.returnFocus,
        initialFocus: initial,
        onClose: () => { state.encounter = null; },
      });
    } else {
      host.classList.add('open');
      initial?.focus({ preventScroll: true });
    }
    window.soundEngine?.playSonarPing?.();
  }

  function encounterMessage(text) {
    const m = $('enc-msg');
    if (m) m.textContent = text;
  }

  async function encounterCommand(cmd) {
    const enc = state.encounter;
    if (!enc) return;
    const g = (window.gymsCache || []).find((x) => x._id === enc.gymId);
    switch (cmd) {
      case 'contest':
      case 'reinforce': {
        encounterMessage(`${state.name.toUpperCase()} used ${cmd === 'contest' ? 'CONTEST' : 'REINFORCE'}!`);
        const btn = document.querySelector(`.cmd[data-cmd="${cmd}"]`);
        if (typeof battleOrFortifyGym === 'function') await battleOrFortifyGym(enc.gymId, btn);
        const g2 = (window.gymsCache || []).find((x) => x._id === enc.gymId);
        if (g2 && g && g2.controllingFaction !== g.controllingFaction) {
          encounterMessage(`It's super effective! ${g2.locationName.toUpperCase()} now flies the ${factionOf(g2.controllingFaction).label} banner.`);
          const mon = typeof monumentForGym === 'function' ? monumentForGym(g2) : null;
          const badge = mon && window.Sprites?.gymBadges()[mon.id];
          if (badge && g2.controllingFaction === state.faction) award(badge, 'A gym badge for the shelf.');
        } else if (g2) {
          encounterMessage(`${g2.locationName.toUpperCase()} is at ${g2.controlPoints}/${g2.maxControlPoints} CP.`);
        }
        setTimeout(() => state.encounter && openEncounter(enc.gymId), 1400);
        break;
      }
      case 'bag':
        closeEncounter();
        if (window.Nexus) window.Nexus.showTab('tab-qr'); else if (typeof switchTab === 'function') switchTab('tab-qr');
        setTimeout(() => $('sticker-book')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
        break;
      case 'map':
        closeEncounter();
        if (g && typeof focusMonument === 'function') focusMonument(g.locationName);
        break;
      default:
        closeEncounter();
    }
  }

  function closeEncounter() {
    const back = state.encounter?.returnFocus;
    state.encounter = null;
    const host = $('encounter');
    if (window.Nexus?.dialog && host && window.Nexus.dialog.isOpen(host)) {
      window.Nexus.dialog.close(host); // restores focus to the opener itself
      return;
    }
    host?.classList.remove('open');
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ *
   * Init + delegated actions
   * ------------------------------------------------------------------ */

  async function init() {
    await window.Sprites?.ready;
    try {
      const A = await avatar();
      const saved = await A.loadAvatar();
      if (saved?.head) {
        state.head = saved.head;
        state.palette = saved.palette?.name || 'SNES16';
        state.sheet = A.sprite(saved.head, { faction: saved.faction || state.faction, cap: saved.cap !== false });
      }
    } catch (err) { console.warn('avatar unavailable:', err.message); }
    renderTrainer();
    updateHud(true);
    document.querySelectorAll('.pxi[data-sprite]').forEach((el) => { el.src = window.Sprites.url(el.dataset.sprite, Number(el.dataset.scale) || 3); });
    // File input + drop zone for the creator.
    $('cre-file')?.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) creatorFromFile(f); });
    const drop = $('cre-drop');
    if (drop) {
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) creatorFromFile(f); });
    }
  }

  const ACTIONS = {
    'cre-camera': () => creatorFromCamera(),
    'cre-upload': () => $('cre-file')?.click(),
    'cre-synth': () => creatorSynthetic(),
    'cre-pal': (el) => { creator.palette = el.dataset.pal; creatorRender(); },
    'cre-dither': (el) => { creator.dither = !creator.dither; el.classList.toggle('pressed', creator.dither); el.textContent = `DITHER: ${creator.dither ? 'ON' : 'OFF'}`; creatorRender(); },
    'cre-cap': (el) => { creator.cap = !creator.cap; el.classList.toggle('pressed', creator.cap); el.textContent = `CAP: ${creator.cap ? 'ON' : 'OFF'}`; creatorPreviewSheet(); },
    'cre-keep': () => creatorKeep(),
    sticker: (el) => showSticker(el.dataset.item),
    'sticker-close': () => $('sticker-detail')?.classList.remove('open'),
    encounter: (el) => openEncounter(el.dataset.id),
    'enc-cmd': (el) => encounterCommand(el.dataset.cmd),
    'enc-close': () => closeEncounter(),
    walk: () => toggleWalk(),
    follow: () => toggleFollow(),
    retro: () => toggleRetro(),
    place: () => { if (has('setPlayer')) { window.campus.setPlayer({ x: -2, z: -8, name: state.name, faction: state.faction }); applyPlayerSprite(); gateSpins(); toast('Dropped you on the Main Quad. WASD to walk.'); updateHud(true); } },
  };

  // Same handlers, registered into the Nexus action registry (nexus.js owns
  // the delegated listener). `handle` below stays for anything that still
  // dispatches directly.
  if (window.Nexus?.registerAction) {
    for (const [name, fn] of Object.entries(ACTIONS)) window.Nexus.registerAction(name, fn);
  }

  window.game = {
    state, init, renderTrainer, computeEarned, award, toast, tick,
    onCampusReady, onProximity, gateSpins, openEncounter, closeEncounter,
    handle(action, el) { const fn = ACTIONS[action]; if (fn) { fn(el); return true; } return false; },
    levelFor, levelProgress,
    onFactionChange() { syncFromCaches(); if (has('setPlayer') && window.campus.getPlayer?.()) { const p = window.campus.getPlayer(); window.campus.setPlayer({ x: p.x, z: p.z, name: state.name, faction: state.faction }); applyPlayerSprite(); } renderTrainer(); updateHud(true); },
    onTabChange(tabId) {
      if (has('setPlayerControls')) window.campus.setPlayerControls(tabId === 'tab-campus');
      if (tabId === 'tab-qr') renderTrainer();
      if (tabId === 'tab-campus') updateHud(true);
    },
  };
})();
