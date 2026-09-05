/**
 * Standalone preview harness for the pixel-avatar builder.
 *
 * Extracted from an inline `<script type="module">` in avatar-demo.html so that the
 * Content-Security-Policy no longer has to allow `'unsafe-inline'` for scripts. This
 * page and gl/materials-demo.html held the last two inline scripts in the app; with both
 * external, `script-src` is a bare `'self'` and an injected `<script>` in any dashboard
 * render cannot execute.
 *
 * Not linked from the war room — open /dashboard/avatar-demo.html directly.
 */
    import {
      PALETTES, captureFromCamera, fromImageFile, pixelate, sprite, frameAt,
      renderPreview, saveAvatar, loadAvatar,
    } from './avatar.js';

    const $ = (id) => document.getElementById(id);
    const state = { source: null, palette: PALETTES.SNES16, dither: true, bias: 0.3, sat: 1.25, faction: 'TEAM_KERNEL', cap: true, head: null, sheet: null };
    let walkTimer = null;

    const say = (m) => { $('status').textContent = m; };

    // Palette pickers: one 8× preview per palette so they can be compared.
    const pickers = {};
    for (const pal of Object.values(PALETTES)) {
      const wrap = document.createElement('div');
      wrap.className = 'pal' + (pal === state.palette ? ' picked' : '');
      const c = document.createElement('canvas'); c.width = 224; c.height = 224;
      const sw = document.createElement('div'); sw.className = 'swatches';
      for (const [r, g, b] of pal.colors) { const i = document.createElement('i'); i.style.background = `rgb(${r},${g},${b})`; sw.appendChild(i); }
      const name = document.createElement('div'); name.className = 'name'; name.textContent = `${pal.name} · ${pal.colors.length}`;
      wrap.append(c, sw, name);
      wrap.addEventListener('click', () => { state.palette = pal; document.querySelectorAll('.pal').forEach((p) => p.classList.toggle('picked', p === wrap)); build(); });
      $('palettes').appendChild(wrap);
      pickers[pal.name] = c;
    }

    function build() {
      if (!state.source) return;
      for (const pal of Object.values(PALETTES)) {
        const img = pixelate(state.source, { palette: pal, dither: state.dither, faceBias: state.bias, saturation: state.sat });
        renderPreview(pickers[pal.name], img, 7);
        if (pal === state.palette) state.head = img;
      }
      suit();
    }

    function suit() {
      if (!state.head) return;
      state.sheet = sprite(state.head, { faction: state.faction, cap: state.cap });
      const s = state.sheet;
      const draw = (cv, scale, frame) => {
        const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, cv.width, cv.height);
        if (frame == null) ctx.drawImage(s, 0, 0, s.width * scale, s.height * scale);
        else { const f = frameAt(s, frame); ctx.drawImage(s, f.x, f.y, f.w, f.h, 0, 0, f.w * scale, f.h * scale); }
      };
      draw($('sheet'), 3, null);
      clearInterval(walkTimer);
      let i = 0;
      const tick = () => { draw($('walk'), 6, i % 4); draw($('tiny'), 2, i % 4); i++; };
      tick(); walkTimer = setInterval(tick, 160);
    }

    $('cam').addEventListener('click', async () => {
      try {
        say('Look at the camera…');
        state.source = await captureFromCamera($('video'), { countdown: 3, onTick: (n) => { $('count').textContent = n || '📸'; } });
        setTimeout(() => { $('count').textContent = ''; }, 600);
        say('Captured.'); build();
      } catch (err) { $('count').textContent = ''; say(err.message); }
    });
    const useFile = async (file) => { try { state.source = await fromImageFile(file); say(`Loaded ${file.name}.`); build(); } catch (err) { say(err.message); } };
    $('file').addEventListener('change', (e) => e.target.files[0] && useFile(e.target.files[0]));
    const drop = $('drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && useFile(e.dataTransfer.files[0]); });

    // A drawn face, so the pipeline can be judged without a camera.
    $('synth').addEventListener('click', () => {
      const c = document.createElement('canvas'); c.width = 400; c.height = 480; const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 0, 480); g.addColorStop(0, '#5a6a8a'); g.addColorStop(1, '#2a3450');
      x.fillStyle = g; x.fillRect(0, 0, 400, 480);
      x.fillStyle = '#e9b48c'; x.beginPath(); x.ellipse(200, 210, 110, 140, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#3a2417'; x.beginPath(); x.ellipse(200, 110, 118, 70, 0, Math.PI, 0); x.fill(); x.fillRect(82, 110, 236, 30);
      x.fillStyle = '#d19a75'; x.beginPath(); x.ellipse(200, 250, 95, 100, 0, 0, Math.PI); x.fill();
      x.fillStyle = '#f5f5f5'; x.beginPath(); x.ellipse(160, 200, 20, 12, 0, 0, Math.PI * 2); x.ellipse(240, 200, 20, 12, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#2b1b12'; x.beginPath(); x.arc(162, 201, 8, 0, Math.PI * 2); x.arc(242, 201, 8, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#3a2417'; x.lineWidth = 8; x.beginPath(); x.moveTo(135, 170); x.lineTo(185, 165); x.moveTo(215, 165); x.lineTo(265, 170); x.stroke();
      x.fillStyle = '#c07a5c'; x.beginPath(); x.ellipse(200, 300, 38, 14, 0, 0, Math.PI); x.fill();
      x.fillStyle = '#ff5f05'; x.fillRect(0, 380, 400, 100); x.fillStyle = '#13294b'; x.fillRect(120, 380, 160, 100);
      state.source = c; say('Synthetic face loaded.'); build();
    });

    $('dither').addEventListener('click', (e) => { state.dither = !state.dither; e.target.setAttribute('aria-pressed', state.dither); e.target.textContent = `Dither: ${state.dither ? 'on' : 'off'}`; build(); });
    $('bias').addEventListener('input', (e) => { state.bias = +e.target.value; build(); });
    $('sat').addEventListener('input', (e) => { state.sat = +e.target.value; build(); });
    $('faction').addEventListener('change', (e) => { state.faction = e.target.value; suit(); });
    $('cap').addEventListener('click', (e) => { state.cap = !state.cap; e.target.setAttribute('aria-pressed', state.cap); e.target.textContent = `Cap: ${state.cap ? 'on' : 'off'}`; suit(); });
    $('save').addEventListener('click', () => { if (!state.head) return say('Make an avatar first.'); $('saved').textContent = saveAvatar({ head: state.head, faction: state.faction, cap: state.cap, palette: state.palette }) ? 'SAVED ✓' : 'storage blocked'; });
    $('load').addEventListener('click', async () => {
      const a = await loadAvatar(); if (!a) return say('Nothing saved yet.');
      state.head = a.head; state.faction = a.faction; state.cap = a.cap; state.palette = a.palette;
      $('faction').value = a.faction; renderPreview(pickers[a.palette.name], a.head, 7); suit(); say('Loaded saved avatar.');
    });

    window.__avatar = { state, build, suit };
