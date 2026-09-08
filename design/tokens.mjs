/**
 * NEXUS QUEST design tokens — "Neo-retro indie".
 *
 * The single source of truth for the shipped palette and fonts. Three readers:
 *
 *   - `public/tokens.css` is GENERATED from here (`npm run tokens:build`, i.e.
 *     `node design/tokens.mjs --css > public/tokens.css`) and committed;
 *     `scripts/verify.sh` fails when the two drift.
 *   - `public/theme.js` applies a content pack's `event.json` `branding`
 *     overrides at runtime through the CSSOM. Its palette → token mapping and
 *     derivation rules mirror `cssVars()` below; keep them in step.
 *   - `design/build.mjs` / `design/parts.mjs` / `design/directions/*.mjs`
 *     (OpenPencil mock builds) import `C`, `F`, `S`, `R`.
 *
 * Direction: pixel-art sensibility with modern layout discipline (Celeste,
 * Stardew Valley, Shovel Knight). Flat saturated palette on Illini-blue
 * ground, 2px ink outlines, hard 4px offset shadows, chamfer notches instead of
 * radius, stickers as accents. No glows, no blur, no soft gradients.
 *
 *   node design/tokens.mjs --css                       baseline :root block
 *   node design/tokens.mjs --css --event content/x/event.json   merged with a pack
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */

export const C = {
  // Ground — Illini Blue #13294B and its bevels. Never pure black.
  ground: '#13294B',
  panel: '#1B3461',
  inset: '#0E1F3A',
  ink: '#08152B',          // outlines + hard shadows
  edge: '#2C4A85',         // lighter top/left bevel

  // Brand accents (brand.illinois.edu): Illini Orange, Harvest, Patina, Prairie
  orange: '#FF5F05',
  orangeDk: '#B8420A',
  harvest: '#FCB316',
  patina: '#007E8E',
  patinaLt: '#35B8C4',
  prairie: '#006230',
  prairieLt: '#3fc474',

  // Ink on the ground
  cream: '#FFF3E0',
  creamDim: '#D8C4A6',
  mute: '#97A6C7',            // 5.03:1 on --panel; #8A9BC0 measured 4.40 and failed AA
  pink: '#FF3E8C',
  white: '#FFFFFF',
  gold: '#FFD34D',
  bronze: '#C8763A',

  // Factions (only on faction-owned objects; the pack's factions.json wins at runtime)
  kernel: '#35B8C4',
  tensor: '#B98CFF',
  silicon: '#FCB316',
  neutral: '#7C8DAA',
};

// Aliases kept for design/build.mjs + parts.mjs (the earlier console build);
// they resolve onto the neo-retro palette so the mocks stay renderable.
Object.assign(C, {
  text: C.cream, text2: C.creamDim, text3: C.mute, text4: '#929EB9',
  hairline: C.edge, hairlineHi: '#3A5A9A', raised: C.edge,
  illiniBlue: C.ground, illiniOrange: C.orange, orangeDeep: C.orangeDk, orangeSoft: '#FFB38A',
  live: C.prairieLt, danger: C.pink, warn: C.harvest,
});

export const FACTIONS = {
  TEAM_KERNEL: { name: 'KERNEL', color: C.kernel, venue: 'SIEBEL HQ' },
  TEAM_TENSOR: { name: 'TENSOR', color: C.tensor, venue: 'ECEB LABS' },
  TEAM_SILICON: { name: 'SILICON', color: C.silicon, venue: 'KENNEY GYM' },
};

/* ------------------------------------------------------------------ *
 * Type
 * ------------------------------------------------------------------ */

/** Family names. Self-hosted in public/fonts (OFL 1.1); see styles.css @font-face. */
export const F = {
  hud: 'Silkscreen',       // caps-only HUD labels, 8–10px
  num: 'Jersey 10',        // condensed display numbers
  head: 'Pixelify Sans',   // headings
  body: 'VT323',           // readable body at 16–18px
};
Object.assign(F, { display: F.head, mono: F.body });

/** Fallback stacks appended after the named face in the CSS variables. */
export const FONT_FALLBACK = {
  hud: "'Courier New', monospace",
  num: "'Silkscreen', monospace",
  head: "'Silkscreen', sans-serif",
  body: "'Courier New', monospace",
};

export const TYPE = [
  { name: 'display', size: 40, weight: 400, ls: 0, lh: 44, font: F.num },
  { name: 'h1', size: 26, weight: 600, ls: 0, lh: 30, font: F.head },
  { name: 'h2', size: 30, weight: 600, ls: 0, lh: 33, font: F.head },
  { name: 'h3', size: 20, weight: 600, ls: 0, lh: 22, font: F.head },
  { name: 'body', size: 17, weight: 400, ls: 0, lh: 20, font: F.body },
  { name: 'small', size: 15, weight: 400, ls: 0, lh: 17, font: F.body },
  { name: 'data-l', size: 28, weight: 400, ls: 0, lh: 26, font: F.num },
  { name: 'hud', size: 9, weight: 400, ls: 0.6, lh: 12, font: F.hud },
];

/** 4pt scale. */
export const S = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 };

/** Neo-retro uses chamfer notches, not radius; these are the notch sizes. */
export const R = { xs: 2, sm: 3, md: 4, lg: 6, xl: 8 };

/* ------------------------------------------------------------------ *
 * event.json → CSS custom properties
 * ------------------------------------------------------------------ */

/** `event.branding.palette` key → the token it drives. Mirrored in public/theme.js. */
export const PALETTE_TOKENS = {
  orange: '--orange',
  blue: '--ground',
  patina: '--patina',
  harvest: '--harvest',
  prairie: '--prairie',
};

/** `event.branding.fonts` key → token + fallback stack. Mirrored in public/theme.js. */
export const FONT_TOKENS = {
  hud: ['--f-hud', FONT_FALLBACK.hud],
  numbers: ['--f-num', FONT_FALLBACK.num],
  headings: ['--f-head', FONT_FALLBACK.head],
  body: ['--f-body', FONT_FALLBACK.body],
};

const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v) => typeof v === 'string' && HEX.test(v);

/** Linear mix of two #rrggbb colours, t ∈ [0,1] toward `b`. */
export function mix(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const fontVar = (name, fallback) => `'${String(name).replace(/['\\]/g, '')}', ${fallback}`;

/**
 * The `:root` custom properties as an ordered map, optionally merged with a
 * pack's `event.json`. With no event (or one without `branding`) the result
 * is exactly the baseline palette above — that is what `public/tokens.css`
 * holds. Overrides: the five brand keys in PALETTE_TOKENS replace their token;
 * `blue` also re-derives the panel/inset/ink/edge bevels and `orange` its
 * pressed shade, so a re-coloured pack keeps the neo-retro relief.
 */
export function cssVars(event = null) {
  const palette = event?.branding?.palette && typeof event.branding.palette === 'object' ? event.branding.palette : {};
  const fonts = event?.branding?.fonts && typeof event.branding.fonts === 'object' ? event.branding.fonts : {};

  const ground = isHex(palette.blue) ? palette.blue : C.ground;
  const orange = isHex(palette.orange) ? palette.orange : C.orange;
  const reground = ground !== C.ground;
  const reorange = orange !== C.orange;

  const vars = {
    'color-scheme': 'dark',
    '--ground': ground,
    '--panel': reground ? mix(ground, C.white, 0.10) : C.panel,
    '--inset': reground ? mix(ground, '#000000', 0.28) : C.inset,
    '--ink': reground ? mix(ground, '#000000', 0.58) : C.ink,
    '--edge': reground ? mix(ground, C.white, 0.22) : C.edge,
    '--orange': orange,
    '--orange-dk': isHex(palette.orangeDk) ? palette.orangeDk : reorange ? mix(orange, '#000000', 0.28) : C.orangeDk,
    '--harvest': isHex(palette.harvest) ? palette.harvest : C.harvest,
    '--patina': isHex(palette.patina) ? palette.patina : C.patina,
    '--patina-lt': C.patinaLt,
    '--prairie': isHex(palette.prairie) ? palette.prairie : C.prairie,
    '--prairie-lt': C.prairieLt,
    '--cream': C.cream,
    '--cream-dim': C.creamDim,
    '--mute': C.mute,
    '--pink': C.pink,
    '--white': C.white,
    '--gold': C.gold,
    '--kernel': C.kernel,
    '--tensor': C.tensor,
    '--silicon': C.silicon,
    '--neutral': C.neutral,
    '': null, // blank line
    '--live': 'var(--prairie-lt)',
    '--danger': 'var(--pink)',
    // Pink is a fill; as text on a panel it is 3.69:1. Error copy uses this at 4.66:1.
    '--danger-text': '#FF6CA8',
    '--warn': 'var(--harvest)',
    ' ': null,
    '/* Legacy aliases still referenced by older markup / the label layer. */': null,
    '--text': 'var(--cream)', '--text-2': 'var(--cream-dim)', '--text-3': 'var(--mute)', '--text-4': C.text4,
    '--cyan': 'var(--kernel)', '--violet': 'var(--tensor)', '--amber': 'var(--silicon)', '--mint': 'var(--live)',
    // A HackStop beacon is not a faction. The campus legend pointed at `--tensor` for it,
    // which resolves and looks right in the shipped pack while reading as a claim that
    // beacons belong to Team Tensor. Aliased so the meaning is in the name; the value is
    // deliberately unchanged, so nothing moves on screen.
    '--beacon': 'var(--tensor)',
    '--hazard': 'var(--danger)', '--dim': 'var(--cream-dim)', '--faint': 'var(--mute)', '--void': 'var(--ground)',
    '--panel-hi': 'var(--edge)', '--text-main': 'var(--cream)', '--text-dim': 'var(--cream-dim)',
    '--hazard-coral': 'var(--danger)', '--amber-surge': 'var(--orange)', '--neon-green': 'var(--live)',
    '--bg-abyss': 'var(--ground)', '--bg-surface': 'var(--panel)', '--raised': 'var(--edge)', '--hairline': 'var(--edge)',
    '  ': null,
    '--f-hud': fontVar(typeof fonts.hud === 'string' ? fonts.hud : F.hud, FONT_FALLBACK.hud),
    '--f-num': fontVar(typeof fonts.numbers === 'string' ? fonts.numbers : F.num, FONT_FALLBACK.num),
    '--f-head': fontVar(typeof fonts.headings === 'string' ? fonts.headings : F.head, FONT_FALLBACK.head),
    '--f-body': fontVar(typeof fonts.body === 'string' ? fonts.body : F.body, FONT_FALLBACK.body),
    '--font-mono': 'var(--f-body)',
    '--font-display': 'var(--f-head)',
    '   ': null,
    '--shell': '1560px',
    '--shadow': '4px 4px 0 var(--ink)',
    '--shadow-sm': '3px 3px 0 var(--ink)',
    '--t': '120ms',
  };
  return vars;
}

/** Renders `cssVars()` output as a `:root { … }` block. */
export function toCss(vars = cssVars(), { header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push('/* GENERATED by design/tokens.mjs — do not edit by hand.');
    lines.push('   Rebuild with `npm run tokens:build`; scripts/verify.sh fails when this file is stale.');
    lines.push('   Neo-retro palette + fonts; a content pack\'s event.json branding is applied on top by theme.js. */');
    lines.push('');
  }
  lines.push(':root {');
  for (const [k, v] of Object.entries(vars)) {
    if (v === null) { lines.push(k.trim() ? `  ${k}` : ''); continue; }
    lines.push(`  ${k}: ${v};`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const isMain = typeof process !== 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--css')) {
    const i = args.indexOf('--event');
    const event = i >= 0 && args[i + 1] ? JSON.parse(readFileSync(args[i + 1], 'utf8')) : null;
    process.stdout.write(toCss(cssVars(event)));
  } else {
    process.stderr.write('usage: node design/tokens.mjs --css [--event path/to/event.json]\n');
    process.exit(2);
  }
}
