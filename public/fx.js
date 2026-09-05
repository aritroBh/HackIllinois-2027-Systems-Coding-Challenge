/**
 * fx — the ambient layer behind the war room, and the one-shot bursts the UI
 * fires on real events (a claimed slot, a capture, a loot drop).
 *
 * Deliberately quiet: a sparse drift of dust motes on the ground, nothing
 * else perpetual. Motion that does not carry information was the first thing
 * the redesign cut. The canvas parks itself when the tab is hidden or the
 * user prefers reduced motion.
 */

(function () {
  const canvas = document.getElementById('ambient-canvas');
  if (!canvas) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  const MOTES = reduceMotion ? 0 : 48;
  const MAX_BURSTS = 240;
  const motes = [];
  const bursts = [];

  // Storm greys and one warm mote in twelve — the ambient layer stays on-brand.
  const PALETTE = ['#8e9090', '#c6c7c6', '#5c6470', '#ff5f05'];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    motes.length = 0;
    for (let i = 0; i < MOTES; i++) {
      motes.push({
        x: Math.random() * W, y: Math.random() * H,
        r: 0.6 + Math.random() * 1.1,
        vx: (Math.random() - 0.5) * 0.08,
        vy: -0.03 - Math.random() * 0.1,
        a: 0.08 + Math.random() * 0.22,
        hue: PALETTE[i % 12 === 0 ? 3 : (i % 3)],
        twinkle: Math.random() * Math.PI * 2,
      });
    }
  }

  let last = performance.now();
  let raf = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, now - last) / 16.67;
    last = now;
    if (canvas.clientWidth !== W || canvas.clientHeight !== H) resize();
    ctx.clearRect(0, 0, W, H);

    for (const m of motes) {
      m.x += m.vx * dt; m.y += m.vy * dt; m.twinkle += 0.02 * dt;
      if (m.y < -10) { m.y = H + 10; m.x = Math.random() * W; }
      if (m.x < -10) m.x = W + 10;
      if (m.x > W + 10) m.x = -10;
      ctx.globalAlpha = m.a * (0.6 + 0.4 * Math.sin(m.twinkle));
      ctx.fillStyle = m.hue;
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
    }

    for (let i = bursts.length - 1; i >= 0; i--) {
      const p = bursts[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 0.05 * dt; p.vx *= 0.99;
      p.life -= 0.018 * dt;
      if (p.life <= 0) { bursts.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life) * 0.9;
      ctx.fillStyle = p.hue;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  resize(); seed();
  window.addEventListener('resize', () => { resize(); seed(); });

  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  start();

  window.fx = {
    /** Burst at a viewport point. Only for events the user caused. */
    burst(x, y, color = '#ff5f05', count = 22) {
      if (reduceMotion) return;
      const n = Math.min(count, MAX_BURSTS - bursts.length);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 1.2 + Math.random() * 4.2;
        bursts.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.4,
          r: 1.2 + Math.random() * 2.2, life: 0.6 + Math.random() * 0.5,
          hue: Math.random() < 0.2 ? '#ffffff' : color,
        });
      }
    },
    burstAt(el, color, count) {
      if (!el) return;
      const r = el.getBoundingClientRect();
      window.fx.burst(r.left + r.width / 2, r.top + r.height / 2, color, count);
    },
  };
})();
