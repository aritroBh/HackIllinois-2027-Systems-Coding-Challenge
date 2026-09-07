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
  /**
   * How close you have to be to spin, in metres — the pack's number, not ours.
   *
   * The server stopped hardcoding this: `geofenceMetersFor()` resolves a venue's own
   * `radiusMeters`, then `campus.geofenceMeters`, then 75. A client holding its own literal
   * 75 is a second copy of a rule that can now move, and it fails in both directions. A pack
   * widening the fence to 120 leaves every Spin button disabled between 75 m and 120 m for a
   * server that would have accepted — an entitled user losing the feature silently. A pack
   * narrowing it to 50 enables the button from 75 m in, so it posts and is refused, which is
   * the labelled-control-that-always-fails shape this dashboard has spent the round removing.
   *
   * `let`, because the pack arrives after this file is parsed. 75 is the same fallback the
   * server uses when a pack says nothing, so the two agree before the descriptor lands as
   * well as after.
   *
   * **This is the campus default, not the only radius.** Each HackStop carries its own
   * resolved `geofenceRadiusMeters`, and each venue in the content descriptor carries a
   * resolved `geofenceMeters`; where a caller knows which stop or venue it is talking about
   * it reads that number instead of this one. This value is for the cases with no specific
   * subject — the proximity index and the nearest-HackStop readout.
   *
   * Read the resolved field and do no arithmetic. The precedence (venue, then campus, then
   * 75) is written down once, server-side, in `geofenceMetersFor`. Recomputing it here from
   * the raw fields would put the ordering in two languages, which is the shape that produced
   * the duplicated gazetteer and the duplicated loot table this repository has just finished
   * deleting — both of which agreed by coincidence until somebody checked.
   */
  let PROX_RADIUS = 75;

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

  /**
   * Turn a sprite sheet into the PNG bytes `POST /api/v1/avatars` accepts.
   *
   * `AvatarService.upload` reads width and height out of the IHDR before decoding anything
   * and refuses whatever is not 128x48, 128x32, 32x32 or 32x48, so the pixels are written at
   * their own size and never scaled.
   *
   * Both shapes turn up here. `avatar.js`'s `sprite()` returns a **canvas** — the four-frame
   * 128x48 walk sheet, with `frameWidth`/`frames` hung off it — while `state.head` and the
   * creator's per-palette heads are `ImageData`. Handling only one of them is how the first
   * version of this failed: `putImageData` threw `parameter 1 is not of type 'ImageData'`,
   * inside a `try` whose whole job was to report upload failures, so it reported a failure
   * to encode as though the server had refused it.
   */
  function sheetToPng(sheet) {
    return new Promise((resolve) => {
      if (typeof sheet?.toBlob === 'function') { sheet.toBlob(resolve, 'image/png'); return; }
      const canvas = document.createElement('canvas');
      canvas.width = sheet.width;
      canvas.height = sheet.height;
      canvas.getContext('2d').putImageData(sheet, 0, 0);
      canvas.toBlob(resolve, 'image/png');
    });
  }

  /**
   * Send the sheet to the server, and say what the server made of it.
   *
   * Split out of `creatorKeep` because consent can change after the face is made: the
   * `shareOptIn` flag is decided at upload time, and `AvatarService.upload` updates it in
   * place when the same owner re-posts the same pixels. Without a second caller, a player who
   * made a face while hidden and *then* turned on "Show me on the campus map" — which is
   * exactly what the toast tells them to do — stayed invisible for ever, because nothing
   * re-sent the consent. That is a worse failure than the original: the instruction is
   * followed and nothing happens.
   */
  async function publishAvatar(sheet, share) {
    const png = await sheetToPng(sheet);
    if (!png) throw new Error('the browser could not encode the sheet');
    const res = await window.Nexus.api(`/api/v1/avatars${share ? '?share=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    return res?.data?.status || null;
  }

  /**
   * Publish the avatar, then keep it locally whatever the server said.
   *
   * Before shell v20 this stopped at `saveAvatar` — it went on to update the sprite, the
   * sticker shelf and the HUD, but localStorage was as far as the *image* ever travelled, and
   * no file in the shipped client called `POST /api/v1/avatars`. (The POST itself landed in
   * v20; this round only split it out. An earlier draft of this paragraph dropped the word
   * "else" from "nothing else called it" and so claimed the endpoint was unreachable in a
   * version where this very function was already calling it.) The server half was unreachable
   * until then: `AvatarService.upload` with its
   * IHDR bounds check and its re-encode-to-kill-polyglots step, the pending queue, the
   * lead console's Approve / Reject / Flag buttons, the per-owner deduplication, the takedown
   * path. The lead's "Avatar queue" panel could never show anything, because nothing could
   * ever be queued. `players.js` renders other trainers by avatar hash, and no account ever
   * had one, so every trainer on the map wore the stock sprite for ever.
   *
   * Order matters. The local save happens regardless of the upload, because the avatar is
   * the player's own face on their own map and a server that is down, or a moderator who
   * later rejects the image, is no reason to hand somebody back a blank trainer. What the
   * upload buys is everyone *else* seeing it, once a lead approves it.
   *
   * The failure is reported rather than swallowed. A silent catch here would recreate the
   * exact defect this replaces — a feature that looks like it worked and did nothing.
   */
  async function creatorKeep() {
    const A = await avatar();
    const head = creator.heads[creator.palette];
    if (!head) return;
    state.head = head;
    state.palette = creator.palette;
    state.cap = creator.cap;
    state.sheet = creator.sheet || A.sprite(head, { faction: state.faction, cap: creator.cap });
    A.saveAvatar({ head, faction: state.faction, cap: creator.cap, palette: A.PALETTES[creator.palette] });
    applyPlayerSprite();
    award('lanyard', 'Welcome to the roster.');
    $('cre-step')?.replaceChildren(document.createTextNode('STEP 3 / 3 · SAVED'));
    renderTrainer();
    updateHud(true);

    // Whether this face is offered to anyone else, and the consent that decides it.
    //
    // `?share=1` is not a detail: `AvatarService.pendingQueue` selects on
    // `{ status: PENDING, shareOptIn: true }`, so an upload without it is stored, is pointed
    // at by the account, and is invisible to the moderation queue for ever — uploaded and
    // unreviewable. That filter is right, and deliberately so: it keeps a face its owner
    // never offered from being put in front of a moderator at all.
    //
    // So the flag is tied to the consent the player has already given or withheld — the same
    // "Show me on the campus map" switch that governs whether other trainers see their
    // position. Somebody who has chosen to be invisible does not have their face queued for
    // review as a side effect of making one, and the message below says which of the two
    // happened rather than leaving them to guess.
    // `presence.state.optIn` first, and deliberately: `players.js`'s `setOptIn` writes it
    // from the server's own `PATCH /me/presence` response, so after a toggle it is the
    // *fresher* of the two. `session.user.presenceOptIn` is only refreshed when the session
    // reloads, which is why it is the fallback rather than the source.
    const share = window.Nexus?.presence?.state?.optIn ?? window.Nexus?.session?.user?.presenceOptIn ?? false;

    let note;
    try {
      const status = await publishAvatar(state.sheet, share);
      // PENDING is the normal answer, not a problem: a face other people will see is held
      // for a lead to look at first. REJECTED is not — these exact pixels have already been
      // turned down, `AvatarService.upload` deduplicates per owner and hands the old row
      // straight back, and no queue will ever list it again. Saying "a lead reviews it"
      // there would be a promise nothing intends to keep.
      note = status === 'REJECTED'
        ? 'That face was reviewed and turned down. Make a different one and try again.'
        : !share
          ? "Looking sharp. That's you on your own map. Turn on \u201cShow me on the campus map\u201d in Me and other trainers will see it too."
          : status === 'APPROVED'
            ? "Looking sharp. That's you on the map now."
            : "Looking sharp. That's you on your map now \u2014 a lead reviews it before other trainers see it.";
    } catch (err) {
      note = `Saved on this device, but the organisers did not get it: ${err.message}`;
    }
    toast(note);
  }

  /**
   * Rebake the trainer's sheet, which is the only way the jacket colour can change.
   *
   * `factionColour` is read exactly once, inside `avatar.sprite()`, and the result is painted
   * into the sheet's pixels. `applyPlayerSprite` below re-sends that finished canvas, so a
   * repaint — however many times it runs — cannot recolour a jacket. An earlier version of
   * this fix called `onFactionChange()` on every content settle and believed that rebuilt the
   * sprite; it does not, and the fork whose pack arrived late kept the default jacket anyway.
   */
  async function rebuildSheet() {
    if (!state.head) return;
    try {
      const A = await avatar();
      state.sheet = A.sprite(state.head, { faction: state.faction, cap: state.cap !== false });
      applyPlayerSprite();
      renderTrainer();
    } catch (err) {
      console.error('Could not rebuild the trainer sheet:', err);
    }
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
      if (!positionSource) positionSource = 'demo';
      applyPlayerSprite();
    }
    if (has('setProximityRadius')) window.campus.setProximityRadius(PROX_RADIUS);
    gateSpins(); // the player now exists, so measure instead of the demo fallback
    // Proximity events fire on the pack's campus edge — 75 m only when the pack says so, and
    // `applyGeofence` moves it; the tick keeps the distance labels
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
  /**
   * Enable or disable each Spin button by great-circle distance from a lat/lng.
   *
   * The 3D path measures in world units through the renderer's spatial index; this measures
   * straight from a device fix, which is what lite mode has. Each button carries the radius
   * the server resolved for that stop, so both paths gate on the stop's own geofence rather
   * than a single campus number — and the server measures it again regardless; this only
   * decides what the button says.
   */
  function gateSpinsFrom(at) {
    const R = 6371000, rad = Math.PI / 180;
    document.querySelectorAll('[data-action="spin"]').forEach((btn) => {
      const lat = Number(btn.dataset.lat), lon = Number(btn.dataset.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        btn.disabled = true; btn.textContent = 'Spin';
        btn.title = 'This HackStop has no coordinates, so its distance cannot be checked';
        return;
      }
      const x = (lon - at.longitude) * rad * Math.cos(((at.latitude + lat) / 2) * rad);
      const y = (lat - at.latitude) * rad;
      const d = Math.round(Math.sqrt(x * x + y * y) * R);
      const radius = Number(btn.dataset.radius) || PROX_RADIUS;
      const cool = cooldownLeft(btn.dataset.beacon);
      const ok = d <= radius && cool === 0;
      if (btn.disabled !== !ok) btn.disabled = !ok;
      // The label names the actual reason. Showing a distance for a stop the player is
      // standing on, because it is cooling down, is a lie in three characters.
      const label = ok ? 'Spin' : cool > 0 ? coolLabel(cool) : `${d} m`;
      if (btn.textContent !== label) btn.textContent = label;
      btn.title = ok ? 'Spin this HackStop' : cool > 0 ? `Cooling down — ${cool}s left` : `Walk to within ${radius} m to spin`;
    });
  }

  function gateSpins() {
    // Lite mode: no renderer to measure with, but a real GPS fix to measure *from*. Without
    // this branch the flat map's readout said "in range — spin it!" beside a Spin button that
    // stayed disabled for ever, because the disabled branch below keys off the renderer.
    // Same precedence as `playerCoords`: in lite mode a real fix wins over a hidden sprite.
    //
    // `!window.campus?.getPlayer?.()` assumed lite implies no renderer player. It does not —
    // lite hides the canvas and leaves the renderer standing — so a trainer placed before the
    // switch kept gating these buttons from the Quad while the phone said otherwise. The two
    // must agree, because this decides what the button says and `playerCoords` decides what
    // the server is told; disagreeing is how a button reads "Spin" and the spin is refused.
    const liteFix = window.Nexus?.lite?.fix;
    if (liteFix && (window.Nexus?.flags?.lite || !window.campus?.getPlayer?.())) { gateSpinsFrom(liteFix); return; }
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
      const radius = Number(btn.dataset.radius) || PROX_RADIUS;
      // A measured distance wins over the proximity index, and the index is only consulted
      // when there is no distance to compare.
      //
      // This read nearIds.has(id) || (Number.isFinite(d) && d <= PROX_RADIUS) — unbackticked,
      // because that line no longer exists and a backtick here is a claim you can find it.
      // The index is built at the *campus*
      // radius — so for a stop whose own fence is tighter than the campus default, membership
      // of that set short-circuited past the comparison and left the button enabled from
      // outside its geofence. The server refuses that spin, which makes it the enabled button
      // that always fails. Caught by testing a narrowed radius as well as a widened one; only
      // the widening direction worked.
      // Unmeasurable falls back to the proximity index, but only when that index is not more
      // generous than this stop's own fence. `nearIds` is built at the campus radius, so for
      // a stop with a tighter one it would answer "near enough" for a distance its own fence
      // rejects — enabling a button the server refuses. A geofence with no measurement fails
      // closed; that is the rule the rest of this file already follows.
      const cool = cooldownLeft(id);
      const inRange = Number.isFinite(d) ? d <= radius : (radius >= PROX_RADIUS && nearIds.has(id));
      const ok = inRange && cool === 0;
      const label = ok ? 'Spin'
        : cool > 0 ? coolLabel(cool)
          : (Number.isFinite(d) ? `${Math.round(d)} m` : 'Walk closer');
      // Only touch the DOM on change: this runs on a tick while the player walks.
      if (btn.disabled !== !ok) btn.disabled = !ok;
      if (btn.textContent !== label) btn.textContent = label;
      btn.title = ok ? 'Spin this HackStop' : cool > 0 ? `Cooling down — ${cool}s left` : `Walk to within ${radius} m to spin`;
    });
  }

  function toggleWalk(force, { silent = false } = {}) {
    const on = typeof force === 'boolean' ? force : !state.walking;
    const btn = $('walk-btn');
    if (on) {
      // `!navigator.geolocation` is true only where the API is absent. It is NOT true on an
      // insecure origin: there the object exists and every call fails, so this guard passed
      // and the browser's own "User denied Geolocation" surfaced instead — blaming the person
      // for what is actually the address bar. `avatar.js` already splits these two for the
      // camera; location had no equivalent.
      if (!navigator.geolocation) { toast('This device has no location — use WASD on the map instead.'); return; }
      if (!window.isSecureContext) {
        toast('Location needs a secure page (https, or localhost). Open this on localhost or over https, or walk the map with WASD.');
        return;
      }
      if (!has('setPlayerLatLng')) { toast('The map is still loading the player layer.'); return; }
      // Turning walking on while it is already on used to overwrite the handle and strand the
      // previous watch: two callbacks driving the sprite, and `clearWatch` only ever able to
      // reach the newer one. The off-branch below is the only place that cleared, so the leak
      // survived every subsequent toggle.
      if (state.geoWatch != null) navigator.geolocation.clearWatch(state.geoWatch);
      state.geoWatch = navigator.geolocation.watchPosition(
        (pos) => {
          const r = window.campus.setPlayerLatLng(pos.coords.latitude, pos.coords.longitude);
          // Share the fix with the presence service (it decides whether to publish: the
          // opt-in, the 10 m / 5 s cadence and the accuracy gate all live there).
          window.Nexus?.presence?.publish?.(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? 999, pos.coords.heading ?? undefined);
          if (r) {
            positionSource = r.onCampus ? 'gps' : 'gps-far';
            positionOffBy = r.onCampus ? 0 : metresOutsideCampus(pos.coords.latitude, pos.coords.longitude);
            updateHud(true);
          }
          // Said once per session, not once per lifetime.
          //
          // This was gated on a flag persisted to localStorage, so the one explanation of why
          // the sprite is not moving was shown exactly once, ever, and never again on any
          // later visit — including the visit where somebody first wonders about it. The
          // distance is in the message now, because "off campus" and "ten thousand kilometres
          // away" are different situations and only one of them is worth walking off.
          if (!r?.onCampus && !offCampusToldThisSession) {
            offCampusToldThisSession = true;
            const km = Math.round(positionOffBy / 1000);
            toast(km >= 5
              ? `You are about ${km.toLocaleString()} km from campus, so the map cannot show your real position. Walk the map with WASD instead.`
              : "You're off campus, so your sprite waits at the map edge. It'll walk with you once you're on the Quad.");
          }
        },
        (err) => {
          // Only a refusal turns walking off. A timeout used to, and `timeout: 15000` with
          // `enableHighAccuracy` times out routinely on a cold fix indoors — so one tap, one
          // wait and one toast left the button off and the feature looking broken, when the
          // very next reading would have arrived. The watch stays open for 2 and 3; the OS
          // keeps trying and a later fix moves the sprite with no further action.
          const denied = err.code === 1; // PERMISSION_DENIED
          if (!denied && geoErrorToldAt && Date.now() - geoErrorToldAt < 30000) return;
          geoErrorToldAt = Date.now();
          if (denied) {
            toast('Location permission is off for this page. Turn it on in the address bar, or walk the map with WASD.');
            toggleWalk(false);
            return;
          }
          toast(err.code === 3 // TIMEOUT
            ? 'Still looking for a location fix — this is slow indoors. Keeping at it; WASD works meanwhile.'
            : 'No location fix right now. Keeping at it; WASD works meanwhile.');
        },
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
    // Lite mode owns `#hud-nearest`.
    //
    // `body.lite` keeps the bottom-right HUD corner visible — it holds the nearest-HackStop
    // readout and the presence roster, neither of which needs the renderer — and `lite.js`
    // writes that readout from its own geolocation watch. This function is not driven only by
    // the render loop: `onTabChange` calls it on every switch to the Campus tab, the handover
    // handler calls it, and so do the walk, follow and place actions. Any of those firing
    // while lite is active overwrote the live readout with "Place your trainer to start
    // walking" — an instruction for a renderer that is not running.
    //
    // Everything else this function writes (the minimap, the control meter, the FPS strip, the
    // walk hint) is inside a HUD box that `body.lite` hides, so there is nothing here to do.
    if (window.Nexus?.flags?.lite) return;
    const now = performance.now();
    if (!force && now - state.lastHud < 500) return;
    state.lastHud = now;
    const S = window.Sprites;

    const lv = $('hud-level');
    if (lv) {
      syncFromCaches();
      const pct = Math.round(levelProgress(state.karma) * 100);
      // A demo placement the player has since driven with the keyboard is no longer the drop
      // point, and saying "DEMO POSITION" of a sprite they are steering reads as broken. This
      // is also what keeps the `keys` branch below reachable — a state nothing can enter is
      // the shape this repository keeps having to delete.
      if (positionSource === 'demo') {
        const p = window.campus?.getPlayer?.();
        if (p && (Math.abs(p.x - -2) > 0.5 || Math.abs(p.z - -8) > 0.5)) positionSource = 'keys';
      }
      // The position line. Silence here was the whole problem: a demo placement and a real
      // GPS fix looked identical, so the map appeared to claim it knew where you were.
      const km = positionOffBy >= 1000 ? `${Math.round(positionOffBy / 1000).toLocaleString()} km` : `${Math.round(positionOffBy)} m`;
      const where = positionSource === 'gps' ? { text: 'GPS · ON CAMPUS', cls: 'ok' }
        : positionSource === 'gps-far' ? { text: `GPS · ${km} AWAY`, cls: 'warn' }
          : positionSource === 'keys' ? { text: 'WALKING WITH KEYS', cls: '' }
            : { text: 'DEMO POSITION · NOT YOUR GPS', cls: 'warn' };
      lv.innerHTML = `${state.head ? `<img class="pxi" alt="" src="${S.imageDataURL(state.head, 1)}">` : S.img('trainer', 2)}<div><div class="hud-label">${escq(state.name.toUpperCase())} · LV ${state.level}</div><div class="pxbar"><i style="width:${pct}%"></i></div><div class="hud-label fac" style="--c:${factionOf?.(state.faction)?.color || '#35B8C4'}">■ ${escq(String(state.faction).replace('TEAM_', 'TEAM '))}</div><div class="hud-label pos ${where.cls}">${escq(where.text)}</div></div>`;
    }

    const ctrl = $('hud-control');
    if (ctrl) {
      const gyms = window.gymsCache || [];
      // Seeded from the pack, not from this repository's three ids.
      //
      // A hardcoded `{TEAM_KERNEL:0, TEAM_TENSOR:0, TEAM_SILICON:0, NEUTRAL:0}` meant the
      // CAMPUS CONTROL strip under any other pack drew three phantom factions at zero and
      // never drew the pack's real ones at all — `example-campus` rendered `0 0 0 1` for a
      // two-team event. Non-fatal only because the `!= null` guard funnelled every real gym
      // into NEUTRAL, which is its own lie: every stronghold reported unclaimed.
      const tally = {};
      for (const id of Object.keys(factionTable())) tally[id] = 0;
      // The fallback bucket has to exist before anything falls into it. `undefined++` is `NaN`,
      // and one `NaN` here drew `width: NaN%` for every bar — an empty strip.
      //
      // A valid pack always has NEUTRAL: `crossValidate` in src/content/schema.ts rejects a
      // factions.json without one. So this fires only on a descriptor that validation would
      // have refused — a partial or hand-edited payload — and it is defence, not a live path.
      // Said plainly because the previous note here claimed a pack need not declare NEUTRAL,
      // which contradicted app.js's own (correct) comment twenty lines from the same fact.
      if (tally.NEUTRAL == null) tally.NEUTRAL = 0;
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
        // The stop's own fence, not the campus one.
        //
        // This compared against `PROX_RADIUS` while the Spin button beside it compares
        // against that stop's `data-radius`, so on a pack where the two differ the readout
        // said "in range — spin it!" next to a disabled button, or counted down to a
        // distance that would not enable anything. `hackStopsCache` is already being read a
        // couple of lines above for the name; the radius is in the same row.
        const stopRadius = Number(
          (window.hackStopsCache || []).find((x) => String(x.beaconId) === String(stop.id))?.geofenceRadiusMeters,
        ) || PROX_RADIUS;
        // The same two reasons the button uses, in the same order.
        //
        // This computed `inRange` from distance alone, so after every successful spin the
        // panel said "in range — spin it!" beside a button counting down 4:12. The diff that
        // introduced `stopRadius` fixed exactly this disagreement for distance and left it
        // standing for cooldown — one control and one caption describing the same stop and
        // contradicting each other, which is the shape this whole pass has been removing.
        const stopCool = cooldownLeft(stop.id);
        const inRange = d <= stopRadius && stopCool === 0;
        const segs = 8, on = Math.max(0, Math.min(segs, Math.round(segs * (1 - Math.min(1, d / 600)))));
        near.innerHTML = `<div class="hud-label">NEAREST HACKSTOP ${S.img('stop', 2)}</div><div class="near-name">${escq(name)}</div><div class="near-dist"><b>${d} m</b><span>${inRange ? 'in range — spin it!' : stopCool > 0 ? `cooling down · ${coolLabel(stopCool)}` : `walk ${d - stopRadius} m closer to spin`}</span></div><div class="segbar">${Array.from({ length: segs }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>`;
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

  /**
   * Battle theatrics.
   *
   * A stronghold changing hands is the biggest thing that happens in this app, and it used
   * to be a line of text swapped in a box. Everything below is decoration over an outcome
   * the server has already decided — it never gates, delays or alters a write — and all of
   * it is skipped outright under `prefers-reduced-motion`, where the same beats still play
   * out in the message line with no motion and no waiting.
   */
  /**
   * Where the trainer on the map actually came from.
   *
   * `onCampusReady` drops a sprite at a fixed spot on the Quad so the map has somebody on it,
   * and that placement was indistinguishable on screen from a real GPS fix — same name tag,
   * same sprite, same "nearest HackStop" readout counting down to a distance from a position
   * the player has never been to. Somebody standing in another country, with location
   * permission granted, saw themselves on the Quad and reasonably concluded the app was
   * lying. It was: it just never said which of the two it was showing.
   *
   * `null` until something places the trainer; then 'demo', 'gps', 'gps-far' or 'keys'.
   */
  let positionSource = null;
  /** Metres from the campus bounding box when the fix is outside it; 0 otherwise. */
  let positionOffBy = 0;
  /** Per-session, deliberately: see the note where it is set. Reset on handover too. */
  let offCampusToldThisSession = false;

  /**
   * A new account on this device inherits none of the previous one's position story.
   *
   * `positionSource` and `positionOffBy` describe *whose* GPS produced the sprite, so leaving
   * them across a handover labels B's screen with A's provenance — `GPS · ON CAMPUS` for
   * somebody who has granted nothing. And `offCampusToldThisSession` carried the suppression
   * with it, so B never got the explanation A had already dismissed: the once-per-lifetime
   * defect this round removed, recreated once per handover.
   */
  /** Throttles the repeating geolocation error toast; a watch re-fires on every failure. */
  let geoErrorToldAt = 0;

  function resetPositionProvenance() {
    positionSource = window.campus?.getPlayer?.() ? 'demo' : null;
    positionOffBy = 0;
    offCampusToldThisSession = false;
  }

  /**
   * Great-circle metres from a fix to the nearest edge of the campus bounding box.
   *
   * The renderer clamps an outside fix to the map edge and reports `onCampus: false`, which
   * is all it needs. A person wants the number: "off campus" reads like a street away, and
   * ten thousand kilometres is a different fact about their evening.
   */
  /**
   * Seconds until this stop can be spun again, or 0.
   *
   * Distance is not the only thing that disables a Spin button — a stop the player spun four
   * minutes ago is in range and still refused. `app.js` owns the record because it owns the
   * request that learns it; this only reads it.
   */
  function cooldownLeft(beaconId) {
    return (typeof window.spinCooldownLeft === 'function' ? window.spinCooldownLeft(beaconId) : 0) || 0;
  }

  /** A countdown a person can read: "4:12" rather than 252. */
  function coolLabel(secs) {
    return secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
  }

  function metresOutsideCampus(lat, lng) {
    const box = window.campusMeta?.bbox;
    if (!Array.isArray(box) || box.length !== 4) return 0;
    const [s, w, n, e] = box;
    const clampedLat = Math.max(s, Math.min(n, lat));
    const clampedLng = Math.max(w, Math.min(e, lng));
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (clampedLat - lat) * rad;
    const dLng = (clampedLng - lng) * rad;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat * rad) * Math.cos(clampedLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }


  /** Gym ids with a battle write in flight. Outlives the stage, which is the point. */
  const inFlight = new Set();

  /**
   * The pack's faction ids.
   *
   * The content descriptor first, because it is the thing the pack actually ships. The
   * fallback is `FACTION` itself: app.js declares it as a top-level `const` and both files are
   * classic scripts, so they share one script scope and the name resolves here — an earlier
   * comment here claimed no such handle existed and copied this repository's three ids
   * instead, which is the hardcoding this function was written to remove. app.js is the later
   * `<script>`, so the binding is initialised by the time anything renders but not at parse
   * time; the guarded read is for that window, not for the normal case.
   */
  function factionTable() {
    const list = window.Nexus?.content?.factions;
    if (Array.isArray(list) && list.length) {
      return Object.fromEntries(list.map((f) => [f.id, true]));
    }
    try {
      return Object.fromEntries(Object.keys(FACTION).map((k) => [k, true]));
    } catch {
      return { NEUTRAL: true };
    }
  }

  const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const beat = (ms) => new Promise((resolve) => setTimeout(resolve, REDUCE_MOTION ? 0 : ms));

  /** A number that flies up off the thing it happened to, then removes itself. */
  function floatOff(el, text, colour) {
    if (!el || REDUCE_MOTION) return;
    const box = el.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = 'enc-float';
    node.textContent = text;
    node.style.left = `${box.left + box.width / 2}px`;
    node.style.top = `${box.top + box.height * 0.4}px`;
    node.style.color = colour;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 1000);
  }

  /**
   * Restart a CSS animation that may already be on the element.
   *
   * Re-adding a class in the same frame it was removed is a no-op — the style never changed
   * as far as the engine is concerned — so a second hit on an already-shaking stage would
   * not shake. Reading `offsetWidth` between the two forces the reflow that makes it change.
   */
  function replay(el, cls, ms) {
    if (!el || REDUCE_MOTION) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }

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
          <div class="plate">${ally ? (g.controllingFaction === 'NEUTRAL' ? 'UNCLAIMED GYM' : 'ALLIED GYM') : 'ENEMY GYM'}</div>
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
        const stage = document.querySelector('.enc-stage');
        const target = stage?.querySelector('.jrpg.enemy');
        const art = stage?.querySelector('.enc-art.enemy');
        const before = Number(g?.controlPoints) || 0;
        const attacking = cmd === 'contest';

        // Lock the whole command list, not just the button that was pressed.
        //
        // Every command here posts, and the request below is not instant. Nothing stopped a
        // second CONTEST from being sent while the first was still in flight, and each one is
        // a real write against the gym: an impatient double-click spent 300 CP and two karma
        // cooldowns on what the player read as one move. `openEncounter` re-renders on the
        // way out, which is what re-enables them.
        // One write per gym at a time, tracked outside the stage.
        //
        // Disabling the command list stops a second click on *this* stage. It does not stop
        // the player closing the encounter mid-flight and reopening the same gym, which
        // renders a fresh stage with fresh enabled buttons over a request that has not landed
        // — two concurrent writes, 300 CP, for what read as one move. The stage is the wrong
        // place to hold that state because the stage is what gets thrown away.
        if (inFlight.has(enc.gymId)) {
          encounterMessage('That move is already in flight. Give it a moment.');
          break;
        }
        inFlight.add(enc.gymId);

        const cmds = [...(stage?.querySelectorAll('.cmd') || [])];
        cmds.forEach((b) => { b.disabled = true; });

        encounterMessage(`${state.name.toUpperCase()} used ${attacking ? 'CONTEST' : 'REINFORCE'}!`);

        const btn = document.querySelector(`.cmd[data-cmd="${cmd}"]`);
        // The request goes out first and the beat runs beside it, rather than after it.
        //
        // Written the other way round — `await beat(400)` and then the POST — the decoration
        // sat in front of the write, so the server heard about the move 400 ms after the
        // player made it. The beat still runs and the stage still takes the same time; what
        // moved is when the request *starts*, which is the difference between the animation
        // delaying the write and merely accompanying it.
        //
        // It does not change the double-submit window: the command list is disabled before
        // the beat in both versions. That is the lock's job and it was already doing it.
        const pending = typeof battleOrFortifyGym === 'function'
          ? battleOrFortifyGym(enc.gymId, btn)
          : Promise.resolve(null);
        await beat(400);
        let result;
        try {
          result = await pending;
        } finally {
          // `finally`, so a rejection cannot leave the gym permanently unbattleable.
          // `battleOrFortifyGym` catches internally today and this is belt and braces, but a
          // lock that can be stranded by an exception is a lock that eventually strands.
          inFlight.delete(enc.gymId);
        }

        // Still the same encounter?
        //
        // Identity, not truthiness. `!state.encounter` only catches a dismissal; it misses
        // the case where the player closed this stage and opened a *different* gym while the
        // request was in flight, because `state.encounter` is then a new object and the check
        // passes. This gym's result would have been shaken onto that gym's stage, its CP
        // number floated over the wrong monument, and the `setTimeout` at the end would have
        // torn the new encounter down to re-open the old one.
        if (state.encounter !== enc) break;

        if (!result) {
          encounterMessage('That move did not land. The reason is in the console panel.');
          cmds.forEach((b) => { b.disabled = false; });
          break;
        }

        const captured = result.action === 'CAPTURED';
        const delta = (Number(result.newControlPoints) || 0) - before;
        const holder = factionOf(result.controllingFaction);

        replay(stage, captured ? 'is-crit' : 'is-hit', captured ? 540 : 300);
        replay(target, 'is-struck', 540);
        window.fx?.burstAt(art || target, captured ? '#FCB316' : holder.color, captured ? 64 : 26);
        if (delta) floatOff(target, `${delta > 0 ? '+' : ''}${delta} CP`, delta < 0 ? '#FF3E8C' : '#7BD88F');
        if (Number(result.karmaAwarded) > 0) {
          setTimeout(() => floatOff(stage?.querySelector('.jrpg.you'), `+${result.karmaAwarded} KARMA`, '#FCB316'), 240);
        }
        await beat(520);
        if (state.encounter !== enc) break;

        if (captured) {
          const g3 = (window.gymsCache || []).find((x) => x._id === enc.gymId);
          encounterMessage(`A critical hit! ${String(g3?.locationName || g?.locationName || 'The stronghold').toUpperCase()} now flies the ${holder.label} banner.`);
          const mon = typeof monumentForGym === 'function' && g3 ? monumentForGym(g3) : null;
          const badge = mon && window.Sprites?.gymBadges()[mon.id];
          if (badge && result.controllingFaction === state.faction) award(badge, 'A gym badge for the shelf.');
        } else {
          // The server writes this line ("Inflicted 150 damage on X! 690 CP remaining."),
          // and it is the only description of the write that cannot disagree with it.
          encounterMessage(String(result.message || ''));
        }
        // `openEncounter` is what re-enables the command list, so a re-open that bails —
        // the gym is gone from the freshly reloaded cache — would leave the stage up with
        // every command dead and no way out but closing the dialog.
        setTimeout(() => {
          if (state.encounter !== enc) return;
          openEncounter(enc.gymId);
          if (state.encounter === enc) {
            document.querySelectorAll('.enc-stage .cmd').forEach((b) => { b.disabled = false; });
            encounterMessage('That stronghold is no longer on the board. Close and refresh the territory list.');
          }
        }, captured ? 1800 : 1400);
        break;
      }
      case 'bag':
        // The bag is the power-up grid in this same tab's rail, not the sticker book.
        //
        // This used to send you to `tab-qr` (Trainer) and scroll to `#sticker-book`, which is
        // wrong twice: the sticker book is a trophy shelf, not an inventory, and `tab-qr` is
        // `roles: STAFF`. For a HACKER — the role that plays this the most — `showTab` refused
        // the switch, logged a warning, and the encounter closed onto the page they were
        // already looking at. BAG did nothing at all, with no way to tell why.
        closeEncounter();
        setTimeout(() => $('inventory-list-container')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
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

  /** Take the pack's geofence, and re-gate anything already drawn against the old one. */
  function applyGeofence(content) {
    const m = Number(content?.event?.campus?.geofenceMeters);
    if (!Number.isFinite(m) || m <= 0 || m === PROX_RADIUS) return;
    PROX_RADIUS = m;
    if (has('setProximityRadius')) window.campus.setProximityRadius(PROX_RADIUS);
    gateSpins();
    updateHud(true);
  }

  async function init() {
    await window.Sprites?.ready;
    applyGeofence(window.Nexus?.content);
    window.Nexus?.onEvent?.('content', (content) => {
      applyGeofence(content);
      // The jacket is painted into the sprite sheet at bake time, and `avatar.sprite` reads
      // the pack's palette through `factionColour`. A pack that settles *after* the sheet was
      // baked therefore leaves the trainer in whatever colour the pre-pack default gave it —
      // this repository's cyan if the stored side is TEAM_KERNEL, otherwise NEUTRAL grey.
      // Only a rebake changes those pixels; a repaint re-sends the same canvas.
      void rebuildSheet();
    });
    try {
      const A = await avatar();
      const saved = await A.loadAvatar();
      if (saved?.head) {
        state.head = saved.head;
        state.palette = saved.palette?.name || 'SNES16';
        state.cap = saved.cap !== false;
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
    // Anything that draws from `state.head` or `levelFor` has to know when they are real.
    //
    // This function is async and awaits two things — `Sprites.ready` and a dynamic import of
    // avatar.js — before `state.head` exists. `views/me.js` draws the trainer's face and
    // level from exactly those, and it had no way to hear about this: subscribing to
    // `Sprites.ready` was not enough, because that resolves *before* the continuation above
    // runs, so a cold load could leave an entitled user looking at an empty face box and no
    // level meter until some unrelated later repaint.
    window.Nexus?.emit?.('game:ready', { hasAvatar: !!state.head });
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
    // "Drop me on the Quad" puts the sprite back on the demo point, so the provenance goes
    // back to `demo` with it. Without this the label kept whatever the last GPS fix had set —
    // `GPS · ON CAMPUS` over a sprite the player had just teleported, or `GPS · 10,077 KM
    // AWAY` on a trainer standing on the Quad.
    place: () => { if (has('setPlayer')) { window.campus.setPlayer({ x: -2, z: -8, name: state.name, faction: state.faction }); positionSource = 'demo'; positionOffBy = 0; applyPlayerSprite(); gateSpins(); toast('Dropped you on the Main Quad. WASD to walk.'); updateHud(true); } },
  };

  // Same handlers, registered into the Nexus action registry (nexus.js owns
  // the delegated listener). `handle` below stays for anything that still
  // dispatches directly.
  if (window.Nexus?.registerAction) {
    for (const [name, fn] of Object.entries(ACTIONS)) window.Nexus.registerAction(name, fn);
  }

  /**
   * The browser changed hands without anybody signing out.
   *
   * `session.js` clears the storage; this clears the copy of it that has been sitting in
   * `state` since boot, which is the copy the screen is drawn from. Without it the fix is
   * only half done and looks complete: the sticker book, the walk flag and the face loaded
   * from `nexus.avatar.v1` all survive in memory, so the next person sees the previous
   * person's trainer — and the first `saveFlags()` after that (a walk toggle, an award)
   * writes the old flags straight back into the key that was just emptied.
   */
  window.Nexus?.onEvent?.('session:handover', () => {
    resetPositionProvenance();
    state.flags = {};
    state.head = null;
    state.sheet = null;
    state.palette = 'SNES16';
    state.earned = new Set();
    state.fresh = new Set();
    state.walking = false;
    // The creator's working copy, which round six's storage purge could not reach: an
    // unsaved photograph and its palette previews live only here. Without this the next
    // person opening Trainer sees the previous person's face in the previews, and pressing
    // Keep writes it into their own stored avatar and onto their map sprite.
    creator.source = null;
    creator.heads = {};
    creator.palette = 'SNES16';
    if (state.geoWatch !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(state.geoWatch);
      state.geoWatch = null;
    }
    // Back to the default sprite, or the map keeps showing a face that is no longer anyone's.
    if (has('setPlayerSprite')) { try { window.campus.setPlayerSprite(null); } catch { /* renderer may be down */ } }
    renderTrainer();
    updateHud(true);
  });

  window.game = {
    state, init, renderTrainer, computeEarned, award, toast, tick,
    // The spin geofence, so `lite.js` reports the same radius rather than keeping its own
    // copy of the number. The server enforces it either way; this is what the UI promises.
    // A getter, not a snapshot: `lite.js` reads this through `window.game`, and the value
    // changes when the content pack settles.
    get PROX_RADIUS() { return PROX_RADIUS; },
    gateSpins,
    /**
     * Stop the GPS watch, if one is running. Returns whether there was one.
     *
     * `lite.js` calls this when it mounts. Both files run a `watchPosition` and both publish
     * to the presence service, and entering lite mode does not stop the renderer's walk — so
     * without this, enabling lite while walking left two watches live, two publishers, and
     * only one of them (lite's) stopped on unmount.
     */
    stopWalk() {
      if (state.geoWatch == null) return false;
      toggleWalk(false);
      return true;
    },
    onCampusReady, onProximity, gateSpins, openEncounter, closeEncounter,

    /**
     * Re-send the stored face with the consent that now applies.
     *
     * Called by `players.js` whenever the campus-map switch changes. Turning it on publishes
     * a face that was uploaded privately; turning it off withdraws one, which is the same
     * symmetry the position switch already has. No stored sheet means nothing to say.
     */
    async republishAvatar(share) {
      if (!state.sheet) return false;
      try {
        await publishAvatar(state.sheet, !!share);
        return true;
      } catch (err) {
        console.warn('[game] could not update avatar sharing:', err.message);
        return false;
      }
    },

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
