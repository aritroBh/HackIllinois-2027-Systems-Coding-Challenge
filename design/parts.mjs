/**
 * Reusable design-JSX fragments for the "Illini Night" NEXUS OS design file.
 * Each helper returns a JSX string; pages compose them by interpolation.
 *
 * Restraint is the point: flat surfaces, one hairline, shadows only on the
 * hero, no glows, no decorative chips. Hierarchy comes from type and space.
 */

import { C, F, S, R } from './tokens.mjs';

export const label = (t, color = C.text3) =>
  `<Text font="${F.mono}" size={10} weight={600} letterSpacing={1.0} color="${color}">${t}</Text>`;

export const data = (t, color = C.text, size = 12) =>
  `<Text font="${F.mono}" size={${size}} weight={500} color="${color}">${t}</Text>`;

export const body = (t, color = C.text2, size = 14) =>
  `<Text font="${F.display}" size={${size}} weight={400} lineHeight={${Math.round(size * 1.5)}} color="${color}">${t}</Text>`;

export const h1 = (t, color = C.text) =>
  `<Text font="${F.display}" size={26} weight={600} letterSpacing={-0.6} color="${color}">${t}</Text>`;

export const h2 = (t, color = C.text) =>
  `<Text font="${F.display}" size={17} weight={600} letterSpacing={-0.3} color="${color}">${t}</Text>`;

/** Flat panel. `hero` adds the one layered shadow the page is allowed. */
export const panel = ({ w = 'fill', h = 'hug', pad = S[5], gap = S[4], children = '', name = 'Panel', hero = false }) => `
<Frame name="${name}" w={${JSON.stringify(w)}} h={${JSON.stringify(h)}} flex="col" gap={${gap}} p={${pad}}
       bg="${C.panel}" rounded={${R.lg}} stroke="${C.hairline}" strokeWidth={1}
       ${hero ? `shadow="0 18 48 #00000055"` : ''}>
  ${children}
</Frame>`;

/** Panel head: eyebrow label + title on the left, one optional control on the right. */
export const head = (eyebrow, title, right = '') => `
<Frame w="fill" flex="row" justify="between" items="end">
  <Frame flex="col" gap={5}>
    ${label(eyebrow)}
    ${h2(title)}
  </Frame>
  ${right}
</Frame>`;

/** Status dot + mono text. Used only for live signals, never as decoration. */
export const signal = (text, color = C.live) => `
<Frame flex="row" gap={7} items="center">
  <Ellipse w={6} h={6} bg="${color}" />
  <Text font="${F.mono}" size={10} weight={600} letterSpacing={0.8} color="${color}">${text}</Text>
</Frame>`;

/** Small tag: quiet outline, mono, no dot. */
export const tag = (text, color = C.text2) => `
<Frame px={8} py={3} rounded={${R.xs}} stroke="${C.hairlineHi}" strokeWidth={1}>
  <Text font="${F.mono}" size={10} weight={600} letterSpacing={0.6} color="${color}">${text}</Text>
</Frame>`;

/** Segmented capacity: one cell per slot, filled cells in `color`. */
export const segments = (filled, cap, color = C.illiniOrange, w = 260, h = 6) => {
  const gap = 3;
  const cell = (w - gap * (cap - 1)) / cap;
  return `
<Frame flex="row" gap={${gap}} w={${w}} h={${h}}>
  ${Array.from({ length: cap }, (_, i) =>
    `<Frame w={${cell.toFixed(2)}} h={${h}} rounded={2} bg="${i < filled ? color : C.hairline}" />`
  ).join('')}
</Frame>`;
};

/** Continuous meter for large ranges (control points). */
export const meter = (pct, color = C.illiniOrange, w = 240, h = 4) => `
<Frame w={${w}} h={${h}} rounded={2} bg="${C.hairline}" overflow="hidden">
  <Frame position="absolute" top={0} left={0} w={${Math.max(2, Math.round(w * pct))}} h={${h}} rounded={2} bg="${color}" />
</Frame>`;

/**
 * Ring gauge. OpenPencil has no arc primitive, so the mock shows the track and
 * a value; the shipped SVG draws the real arc with stroke-dasharray.
 */
export const ring = (pct, value, unit, lab, color = C.illiniOrange, size = 96) => {
  const t = 7;
  const inner = size - t * 2;
  return `
<Frame w={${size}} h={${size}}>
  <Ellipse position="absolute" top={0} left={0} w={${size}} h={${size}} bg="${C.hairline}" />
  <Ellipse position="absolute" top={0} left={0} w={${size}} h={${size}} bg="${color}" opacity={${pct.toFixed(2)}} />
  <Ellipse position="absolute" top={${t}} left={${t}} w={${inner}} h={${inner}} bg="${C.panel}" />
  <Frame position="absolute" top={${t}} left={${t}} w={${inner}} h={${inner}} flex="col" items="center" justify="center" gap={1}>
    <Frame flex="row" items="end" gap={2}>
      <Text font="${F.mono}" size={22} weight={500} letterSpacing={-0.8} color="${C.text}">${value}</Text>
      <Text font="${F.mono}" size={10} weight={500} color="${C.text3}">${unit}</Text>
    </Frame>
    ${label(lab, C.text3)}
  </Frame>
</Frame>`;
};

/** Sparkline from an array of 0..1 values. */
export const spark = (vals, color = C.illiniOrange, w = 160, h = 36) => {
  const n = vals.length;
  return `
<Frame w={${w}} h={${h}} flex="row" gap={2} items="end">
  ${vals.map((v) => `<Frame w={${((w - 2 * (n - 1)) / n).toFixed(2)}} h={${Math.max(2, Math.round(v * h))}} rounded={1} bg="${color}" opacity={${(0.35 + v * 0.65).toFixed(2)}} />`).join('')}
</Frame>`;
};

/** Primary button: orange, dark text. `ghost` variant: outline. */
export const button = (text, { color = C.illiniOrange, ghost = false, w = 'hug', h = 36 } = {}) => `
<Frame w={${JSON.stringify(w)}} h={${h}} flex="row" items="center" justify="center" px={16} rounded={${R.sm}}
       bg="${ghost ? '#00000000' : color}" stroke="${ghost ? C.hairlineHi : color}" strokeWidth={1}>
  <Text font="${F.display}" size={13} weight={600} color="${ghost ? C.text : C.ground}">${text}</Text>
</Frame>`;

/** Faction mark: a small filled square with rounded corners — no glyph theatre. */
export const factionMark = (color, size = 10) =>
  `<Frame w={${size}} h={${size}} rounded={3} bg="${color}" />`;

/** Log row: gutter timestamp, semantic tag, message. */
export const logRow = (time, tag, text, tagColor = C.text2) => `
<Frame flex="row" gap={12} items="start" w="fill">
  <Text font="${F.mono}" size={11} weight={400} color="${C.text4}">${time}</Text>
  <Text font="${F.mono}" size={11} weight={600} color="${tagColor}">${tag}</Text>
  <Text font="${F.mono}" size={11} weight={400} color="${C.text2}" grow={1}>${text}</Text>
</Frame>`;
