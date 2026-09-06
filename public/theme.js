/**
 * theme — the content pack's branding applied at runtime (plan C1 tokens).
 *
 * `public/tokens.css` (generated from design/tokens.mjs) ships the neo-retro
 * baseline. When `Nexus.content` arrives with `event.branding`, this script
 * writes the pack's palette and fonts onto `:root` through the CSSOM —
 * `document.documentElement.style.setProperty(…)` — which the tightened
 * `style-src 'self'` permits. No `<style>` element is ever injected and no
 * `style=` attribute is written; the CSP audit checks for both.
 *
 * The key → token map and the derivation rules (bevels from `blue`, the
 * pressed shade from `orange`) mirror `cssVars()` in design/tokens.mjs. The
 * baseline pack produces the same values tokens.css already holds, so on the
 * UIUC event this is a no-op that costs nothing; a re-coloured pack re-themes
 * the shell without a rebuild.
 *
 * Loads after session.js (which fetches GET /api/v1/content). Plain script.
 */

(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[theme] nexus.js must load first'); return; }

  // ---- mirrors design/tokens.mjs (keep in step) ----
  const BASE = { ground: '#13294B', orange: '#FF5F05' };
  const PALETTE_TOKENS = { orange: '--orange', blue: '--ground', patina: '--patina', harvest: '--harvest', prairie: '--prairie' };
  const FONT_TOKENS = {
    hud: ['--f-hud', "'Courier New', monospace"],
    numbers: ['--f-num', "'Silkscreen', monospace"],
    headings: ['--f-head', "'Silkscreen', sans-serif"],
    body: ['--f-body', "'Courier New', monospace"],
  };
  const HEX = /^#[0-9a-f]{6}$/i;
  const isHex = (v) => typeof v === 'string' && HEX.test(v);

  function mix(a, b, t) {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  // ---- end mirror ----

  const root = document.documentElement;
  const applied = new Set();

  function set(name, value) {
    root.style.setProperty(name, value);
    applied.add(name);
  }

  /** Applies `event.branding`; returns the number of custom properties written. */
  function apply(content) {
    const branding = content?.event?.branding;
    // A pack without branding (or the static fallback) means the baseline: undo
    // anything a previous descriptor set so a re-fetch cannot leave stale colours.
    for (const name of applied) root.style.removeProperty(name);
    applied.clear();
    if (!branding || typeof branding !== 'object') return 0;

    const palette = branding.palette && typeof branding.palette === 'object' ? branding.palette : {};
    const fonts = branding.fonts && typeof branding.fonts === 'object' ? branding.fonts : {};

    for (const [key, token] of Object.entries(PALETTE_TOKENS)) {
      if (isHex(palette[key])) set(token, palette[key]);
    }
    if (isHex(palette.blue) && palette.blue.toUpperCase() !== BASE.ground) {
      const g = palette.blue;
      set('--panel', mix(g, '#FFFFFF', 0.10));
      set('--inset', mix(g, '#000000', 0.28));
      set('--ink', mix(g, '#000000', 0.58));
      set('--edge', mix(g, '#FFFFFF', 0.22));
    }
    if (isHex(palette.orangeDk)) set('--orange-dk', palette.orangeDk);
    else if (isHex(palette.orange) && palette.orange.toUpperCase() !== BASE.orange) set('--orange-dk', mix(palette.orange, '#000000', 0.28));

    for (const [key, [token, fallback]] of Object.entries(FONT_TOKENS)) {
      const family = fonts[key];
      if (typeof family === 'string' && family.trim()) set(token, `'${family.replace(/['\\]/g, '').trim()}', ${fallback}`);
    }

    // The browser chrome colour follows the ground; an attribute, not a style.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && isHex(palette.blue)) meta.setAttribute('content', palette.blue);

    return applied.size;
  }

  N.contentReady.then((content) => {
    const n = apply(content);
    if (n) console.info(`[theme] ${content.pack || 'pack'}: ${n} token override(s) applied`);
  }).catch((err) => console.warn('[theme] not applied:', err.message));

  Object.defineProperty(N, 'theme', { enumerable: true, value: { apply, applied: () => [...applied] } });
})();
