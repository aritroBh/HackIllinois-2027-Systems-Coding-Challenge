/**
 * NEXUS OS design tokens — "Illini Night".
 *
 * Single source of truth shared by the OpenPencil build (design/build.mjs)
 * and the shipped CSS custom properties in public/styles.css. Keep in sync.
 *
 * Direction: a University of Illinois operations console at night. Ground is
 * Illini-blue-tinted navy (never black, never purple). One warm accent, Illini
 * Orange, used sparingly for the primary action and the live signal. Factions
 * keep their own hues but only appear on faction-owned objects.
 *
 * Diagnosis of the previous build (why this exists):
 *  - every panel carried the same gradient hairline + tinted glow, so the rail
 *    weighed the same as the hero and nothing led the eye
 *  - chips on every panel head as decoration; uniform 9px mono-caps everywhere
 *  - stats were numbers with a coloured underline: no data-viz at all
 *  - perpetual sweeps/shimmers with no purpose; unicode glyphs as icons
 *  - cyan-on-black palette read as generic AI cyberpunk, not Illinois
 */

export const C = {
  // Ground — navy tinted toward Illini Blue #13294B, never pure black.
  ground: '#0B1220',
  panel: '#111B2E',
  raised: '#172338',
  inset: '#0D1627',
  hairline: '#243450',
  hairlineHi: '#31456A',

  // Brand
  illiniBlue: '#13294B',
  illiniOrange: '#FF5F05',
  orangeDeep: '#C2410C',
  orangeSoft: '#FFB38A',

  // Ink — the official Storm ramp (#C6C7C6 / #8E9090 / #707372)
  text: '#EEF0F2',
  text2: '#C6C7C6',
  text3: '#8E9090',
  text4: '#5C6470',

  // Semantic — Patina and Harvest are official brand accents
  patina: '#007E8E',
  harvest: '#FCB316',
  live: '#2FB3C2',
  danger: '#FF4D6A',
  warn: '#FCB316',

  // Factions (only on faction-owned objects)
  kernel: '#22D3EE',
  tensor: '#A78BFA',
  silicon: '#FBBF24',
  neutral: '#7C8DAA',
};

export const FACTIONS = {
  TEAM_KERNEL: { name: 'KERNEL', color: C.kernel, venue: 'SIEBEL HQ' },
  TEAM_TENSOR: { name: 'TENSOR', color: C.tensor, venue: 'ECEB LABS' },
  TEAM_SILICON: { name: 'SILICON', color: C.silicon, venue: 'KENNEY GYM' },
};

/**
 * Type. Bricolage Grotesque: a grotesk with real character and optical sizes,
 * chosen because an ops console for a university should feel institutional
 * and confident, not startup-generic. IBM Plex Mono for data: engineered,
 * tabular, reads at 11px.
 */
export const F = {
  display: 'Bricolage Grotesque',
  mono: 'IBM Plex Mono',
};

/** Minor-third ramp on a 15px base; data sizes live on the mono face. */
export const TYPE = [
  { name: 'display', size: 40, weight: 600, ls: -1.2, lh: 44, font: F.display },
  { name: 'h1', size: 26, weight: 600, ls: -0.6, lh: 30, font: F.display },
  { name: 'h2', size: 18, weight: 600, ls: -0.3, lh: 22, font: F.display },
  { name: 'body', size: 15, weight: 400, ls: 0, lh: 22, font: F.display },
  { name: 'small', size: 13, weight: 400, ls: 0, lh: 18, font: F.display },
  { name: 'data-l', size: 28, weight: 500, ls: -0.8, lh: 30, font: F.mono },
  { name: 'data', size: 12, weight: 500, ls: 0, lh: 16, font: F.mono },
  { name: 'label', size: 10, weight: 600, ls: 1.0, lh: 12, font: F.mono },
];

/** 4pt scale. */
export const S = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 };

/** Concentric radii: outer = inner + padding. */
export const R = { xs: 4, sm: 6, md: 10, lg: 14, xl: 18 };
