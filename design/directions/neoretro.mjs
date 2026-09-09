/**
 * Direction 3 — "NEO-RETRO INDIE"
 *
 * Pixel-art sensibility with modern layout discipline: the menus of Celeste,
 * Stardew Valley, Shovel Knight, Hyper Light Drifter. Flat saturated palette,
 * hard 4px shadows, chamfered "notch" corners instead of radius, stickers as
 * the accent language, a mascot (the Boneyard duck) that talks in toasts.
 *
 * Renders four pages to design/exports/neoretro/:
 *   NODE_PATH=~/.bun/install/global/node_modules bun design/directions/neoretro.mjs
 *
 * All pixel art is Frame grids (run-length encoded per row); no images.
 */

import { SceneGraph, renderJSX, initCanvasKit, headlessRenderNodes } from '@open-pencil/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'exports', 'neoretro');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

const C = {
  ground: '#13294B',
  panel: '#1B3461',
  inset: '#0E1F3A',
  ink: '#08152B',          // outlines + hard shadows
  edge: '#2C4A85',         // lighter top/left bevel
  orange: '#FF5F05',
  orangeDk: '#B8420A',
  harvest: '#FCB316',
  patina: '#007E8E',
  patinaLt: '#35B8C4',
  prairie: '#006230',
  prairieLt: '#2EA05A',
  cream: '#FFF3E0',
  creamDim: '#D8C4A6',
  mute: '#8A9BC0',
  pink: '#FF3E8C',
  white: '#FFFFFF',
  kernel: '#35B8C4',
  tensor: '#B98CFF',
  silicon: '#FCB316',
  gold: '#FFD34D',
  bronze: '#C8763A',
};

const F = {
  hud: 'Silkscreen',       // caps-only HUD labels, 8–10px
  num: 'Jersey 10',        // condensed display numbers
  head: 'Pixelify Sans',   // headings
  body: 'VT323',           // readable body at 16–18px
};

const W = 1600, H = 1000;

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const hud = (t, color = C.mute, size = 9) =>
  `<Text font="${F.hud}" size={${size}} lineHeight={${size + 3}} color="${color}" letterSpacing={0.5}>${t}</Text>`;
const num = (t, color = C.cream, size = 30) =>
  `<Text font="${F.num}" size={${size}} lineHeight={${Math.round(size * 0.9)}} color="${color}">${t}</Text>`;
const head = (t, color = C.cream, size = 22) =>
  `<Text font="${F.head}" size={${size}} lineHeight={${Math.round(size * 1.15)}} weight={600} color="${color}">${t}</Text>`;
const body = (t, color = C.creamDim, size = 17, lh, w) =>
  `<Text font="${F.body}" size={${size}} color="${color}" lineHeight={${lh ?? Math.round(size * 1.15)}} ${w ? `w={${w}}` : ''}>${t}</Text>`;

/** Four notch squares in the surrounding colour fake a chamfered corner. */
const notches = (w, h, n = 4, bg = C.ground) => `
  <Frame position="absolute" top={0} left={0} w={${n}} h={${n}} bg="${bg}" />
  <Frame position="absolute" top={0} left={${w - n}} w={${n}} h={${n}} bg="${bg}" />
  <Frame position="absolute" top={${h - n}} left={0} w={${n}} h={${n}} bg="${bg}" />
  <Frame position="absolute" top={${h - n}} left={${w - n}} w={${n}} h={${n}} bg="${bg}" />`;

/**
 * Pixel panel: hard 4px shadow, 2px ink outline, chamfered corners, a 2px
 * lighter bevel along top+left. Fixed size (w,h) so the notches can be placed.
 */
const panel = ({ w, h, children = '', bg = C.panel, outline = C.ink, shadow = true, bevel = true, pad = 16, gap = 12, flex = 'col', around = C.ground, name = 'Panel' }) => `
<Frame name="${name}" w={${w + 4}} h={${h + 4}}>
  <Frame position="absolute" top={0} left={0} w={${w}} h={${h}} bg="${bg}" stroke="${outline}" strokeWidth={2} overflow="hidden" ${shadow ? `shadow="4 4 0 ${outline}"` : ''}>
    ${bevel ? `<Frame position="absolute" top={2} left={2} w={${w - 4}} h={2} bg="${C.edge}" /><Frame position="absolute" top={2} left={2} w={2} h={${h - 4}} bg="${C.edge}" />` : ''}
    <Frame position="absolute" top={0} left={0} w={${w}} h={${h}} flex="${flex}" gap={${gap}} p={${pad}}>
      ${children}
    </Frame>
  </Frame>
  ${notches(w, h, 4, around)}
</Frame>`;

/** Physical pixel button: face + darker base; `pressed` sinks the face. Width
 * is computed from the label because Silkscreen is a fixed-width-ish pixel face
 * (~0.92em per glyph at these sizes). */
const button = (text, { color = C.orange, dark = C.orangeDk, ink = C.ink, textColor = C.ink, pressed = false, w, px = 14, h = 30, size = 9, font = F.hud } = {}) => {
  const width = w ?? Math.round(text.length * size * 0.92 + px * 2);
  const drop = pressed ? 3 : 0;
  return `
<Frame w={${width}} h={${h + 4}}>
  <Frame position="absolute" top={4} left={0} w={${width}} h={${h}} bg="${dark}" stroke="${ink}" strokeWidth={2} />
  <Frame position="absolute" top={${drop}} left={0} w={${width}} h={${h}} flex="row" items="center" justify="center" bg="${color}" stroke="${ink}" strokeWidth={2}>
    <Text font="${font}" size={${size}} color="${textColor}" letterSpacing={0.6}>${text}</Text>
  </Frame>
</Frame>`;
};

/** Rotated sticker badge with a hard shadow. */
const sticker = (text, { color = C.harvest, textColor = C.ink, rotate = -6, size = 9 } = {}) => `
<Frame rotate={${rotate}} px={8} py={4} bg="${color}" stroke="${C.ink}" strokeWidth={2} shadow="3 3 0 ${C.ink}">
  <Text font="${F.hud}" size={${size}} color="${textColor}" letterSpacing={0.6}>${text}</Text>
</Frame>`;

/** Segmented pixel bar. */
const bar = (filled, total, { color = C.orange, w = 220, h = 10, gap = 2 } = {}) => {
  const cell = (w - gap * (total - 1)) / total;
  return `
<Frame w={${w + 4}} h={${h + 4}} bg="${C.ink}" p={2} flex="row" gap={${gap}}>
  ${Array.from({ length: total }, (_, i) => `<Frame w={${cell.toFixed(2)}} h={${h}} bg="${i < filled ? color : C.inset}" />`).join('')}
</Frame>`;
};

/** Continuous pixel meter (stepped to 4px). */
const meter = (pct, { color = C.orange, w = 220, h = 8 } = {}) => {
  const fill = Math.round((w * pct) / 4) * 4;
  return `
<Frame w={${w + 4}} h={${h + 4}} bg="${C.ink}" p={2}>
  <Frame w={${w}} h={${h}} bg="${C.inset}">
    <Frame position="absolute" top={0} left={0} w={${Math.max(4, fill)}} h={${h}} bg="${color}" />
    <Frame position="absolute" top={0} left={0} w={${Math.max(4, fill)}} h={2} bg="${C.white}" opacity={0.35} />
  </Frame>
</Frame>`;
};

/**
 * Sprite from a string map. Each char indexes `pal`; '.' is transparent.
 * Rows are run-length encoded so a 32×32 avatar stays a few hundred nodes.
 */
const sprite = (rows, pal, s = 4, name = 'Sprite') => {
  const w = rows[0].length, h = rows.length;
  const out = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < w) {
      const ch = row[x];
      let run = 1;
      while (x + run < w && row[x + run] === ch) run++;
      if (ch !== '.' && pal[ch]) {
        out.push(`<Frame position="absolute" top={${y * s}} left={${x * s}} w={${run * s}} h={${s}} bg="${pal[ch]}" />`);
      }
      x += run;
    }
  });
  return `<Frame name="${name}" w={${w * s}} h={${h * s}}>${out.join('')}</Frame>`;
};

/* ------------------------------------------------------------------ *
 * Pixel art
 * ------------------------------------------------------------------ */

const P = {
  k: C.ink, o: C.orange, O: C.orangeDk, h: C.harvest, w: C.white, c: C.cream, d: C.creamDim,
  p: C.patina, P: C.patinaLt, g: C.prairie, G: C.prairieLt, b: '#4A7BD6', B: C.ground,
  r: '#B8322B', t: C.tensor, y: C.gold, n: C.bronze, s: '#6E7A96', S: '#3A4560', f: '#F1B58C', F: '#C98761',
  x: C.pink, m: '#8C5A3C', M: '#5B3A26', l: '#6EC1FF', v: '#9DDB4A',
};

/** Boneyard duck mascot, 16×16. */
const DUCK = [
  '................',
  '.....kkkk.......',
  '....kyyyyk......',
  '...kyyyyyykk....',
  '...kyykyyyook...',
  '...kyyyyyyook...',
  '....kyyyykkk....',
  '.....kyyyk......',
  '..kkkkyyyykkk...',
  '.kyyyyyyyyyyyk..',
  '.kyyyyyyyyyyyk..',
  '..kyyyyyyyyyk...',
  '...kkyyyyykk....',
  '.....kookok.....',
  '....kookook.....',
  '....kkkkkkk.....',
];

/** Trainer sprite (player), 16×16, facing down. */
const TRAINER = [
  '.....kkkkkk.....',
  '....kooooook....',
  '...koooooooook..',
  '...kffffffffk...',
  '...kfkffkfffk...',
  '...kffffffffk...',
  '....kffkkffk....',
  '.....kkbbkk.....',
  '...kkbbbbbbkk...',
  '..kbbkbbbbkbbk..',
  '..kbbkbbbbkbbk..',
  '..kffkbbbbkffk..',
  '.....kSSSSk.....',
  '.....kSkkSk.....',
  '.....kSk.kSk....',
  '.....kkk.kkk....',
];

/** 32×32 avatar (pixelised photo result). */
const AVATAR32 = [
  '............kkkkkkkk............',
  '..........kkMMMMMMMMkk..........',
  '.........kMMMMMMMMMMMMk.........',
  '........kMMMMMMMMMMMMMMk........',
  '........kMMmmMMMMMMmmMMk........',
  '.......kMMmmmmmmmmmmmmMMk.......',
  '.......kMmmmmmmmmmmmmmmMk.......',
  '.......kMmfffffffffffffMk.......',
  '.......kmffffffffffffffmk.......',
  '.......kfffffffffffffffFk.......',
  '.......kffkkffffffkkffffk.......',
  '.......kffkwkfffffkwkfffk.......',
  '.......kffkkkfffffkkkfffk.......',
  '.......kffffffffffffffFFk.......',
  '.......kfffffffkkffffffFk.......',
  '........kffffffffffffFFk........',
  '........kfffffkkkkfffFFk........',
  '.........kffffffffffFFk.........',
  '..........kkffffffFFkk..........',
  '............kkkffFkk............',
  '..........kkkkkffkkkkk..........',
  '........kkoooookkooooookk.......',
  '.......kooooooookoooooooook.....',
  '......kooooooooBBoooooooook.....',
  '......koooooooBBBBooooooook.....',
  '......kooooooBBBBBBoooooook.....',
  '.....kfoooooooBBBBoooooooofk....',
  '.....kfoooooooooooooooooofk.....',
  '.....kfkooooooooooooooooofk.....',
  '.....kk.kooooooooooooooook......',
  '........kkkkkkkkkkkkkkkkk.......',
  '................................',
];

/** 16×16 memorabilia. */
const STICKERS = {
  almaPin: { name: 'Alma Mater Pin', rarity: 'RARE', rows: [
    '......nnnn......', '.....nyyyyn.....', '....nyyyyyyn....', '....nyynnyyn....',
    '.....nyyyyn.....', '......nyyn......', '...nnnnyynnnn...', '..nyyyyyyyyyyn..',
    '..nyynyyyynyyn..', '..nyynyyyynyyn..', '..nyyyyyyyyyyn..', '...nyyyyyyyyn...',
    '....nnnnnnnn....', '.....nSSSSn.....', '....nSSSSSSn....', '....nnnnnnnn....',
  ] },
  mug: { name: 'All-Nighter Mug', rarity: 'COMMON', rows: [
    '................', '.....kkkkkkk....', '....kwwwwwwwk...', '....kwwwwwwwkkk.',
    '....kwwoowwwkOk.', '....kwwoowwwkOk.', '....kwwwwwwwkOk.', '....kwwoowwwkkk.',
    '....kwwoowwwk...', '....kwwwwwwwk...', '....kwwwwwwwk...', '.....kkkkkkk....',
    '....ssssssss....', '...ssssssssss...', '................', '................',
  ] },
  duck: { name: 'Boneyard Duck', rarity: 'UNCOMMON', rows: DUCK },
  pennant: { name: 'Illini Pennant', rarity: 'COMMON', rows: [
    '.k..............', '.kk.............', '.kokk...........', '.koookk.........',
    '.kooooookk......', '.koooooooookk...', '.koBBBoooooooook', '.koBBBBooooookk.',
    '.koBBBoooookk...', '.kooooooookk....', '.koooooookk.....', '.koooookk.......',
    '.kooookk........', '.kkkkk..........', '.k..............', '.k..............',
  ] },
  iron: { name: 'Soldering Iron', rarity: 'RARE', rows: [
    '..............ok', '.............oo.', '............ss..', '...........sss..',
    '..........sss...', '.........sss....', '........kkk.....', '.......kSSk.....',
    '......kSSSk.....', '.....kSSSk......', '....kSSSk.......', '...kSSSk........',
    '..kSSSk.........', '.kSSSk..........', 'kkkkk...........', '................',
  ] },
  patch330: { name: '3:30 AM Cleanup', rarity: 'EPIC', rows: [
    '....kkkkkkkk....', '...kxxxxxxxxk...', '..kxxkkkkkkxxk..', '.kxxkccccccbxxk.',
    '.kxkccckcccckxk.', '.kxkcckccccckxk.', '.kxkccckkcccckk.', '.kxkccccckccckk.',
    '.kxkcccccckcckk.', '.kxkccccccccckk.', '.kxxkccccccckxk.', '..kxxkkkkkkxxk..',
    '...kxxxxxxxxk...', '....kkkkkkkk....', '.....kxxxxk.....', '......kkkk......',
  ] },
  dome: { name: 'Foellinger Dome', rarity: 'LEGENDARY', rows: [
    '.......kk.......', '......kyyk......', '.....kPPPPk.....', '....kPPPPPPk....',
    '...kPPPpPPPPk...', '..kPPPpPPpPPPk..', '.kPPPPpPPpPPPPk.', '.kkkkkkkkkkkkkk.',
    '.kdddddddddddkk.', '.kdkdkdkdkdkdkk.', '.kdkdkdkdkdkdkk.', '.krrrrrrrrrrrrk.',
    '.krrrrrrrrrrrrk.', '.krrkrrrrrrkrrk.', '.kkkkkkkkkkkkkk.', '................',
  ] },
  blockI: { name: 'Block I Patch', rarity: 'UNCOMMON', rows: [
    '.kkkkkkkkkkkkkk.', 'kBBBBBBBBBBBBBBk', 'kBooooooooooooBk', 'kBooooooooooooBk',
    'kBoookkkkkkoooBk', 'kBBBBkooookBBBBk', 'kBBBBkooookBBBBk', 'kBBBBkooookBBBBk',
    'kBBBBkooookBBBBk', 'kBBBBkooookBBBBk', 'kBoookkkkkkoooBk', 'kBooooooooooooBk',
    'kBooooooooooooBk', 'kBBBBBBBBBBBBBBk', '.kkkkkkkkkkkkkk.', '................',
  ] },
};

/** 8×8 icons. */
const ICON = {
  clock: ['.kkkkkk.', 'k.....k.', 'k..w..k.', 'k..w..k.', 'k..ww.k.', 'k.....k.', '.kkkkk..', '........'].map((r) => r.replace(/\./g, 'B').replace(/B(?=.*)/g, (m, o) => (o === 0 || o === 7) ? '.' : 'B')),
  pin:   ['..kkkk..', '.koook..', '.kokok..', '.koook..', '..kok...', '..kok...', '...k....', '........'],
  zap:   ['....hh..', '...hh...', '..hhhh..', '.hhhhh..', '...hh...', '..hh....', '.hh.....', '........'],
  shield:['.kkkkkk.', 'kPPPPPPk', 'kPPPPPPk', 'kPPPPPPk', '.kPPPPk.', '..kPPk..', '...kk...', '........'],
  star:  ['...y....', '..yyy...', '.yyyyy..', 'yyyyyyy.', '..yyy...', '.yy.yy..', 'y.....y.', '........'],
  heart: ['.xx.xx..', 'xxxxxxx.', 'xxxxxxx.', '.xxxxx..', '..xxx...', '...x....', '........', '........'],
  gift:  ['..h..h..', '.hhhhhh.', 'kkkkkkkk', 'koookook', 'kkkkkkkk', 'koookook', 'koookook', 'kkkkkkkk'],
  alert: ['...x....', '..xxx...', '..xkx...', '.xxkxx..', '.xxkxx..', 'xxxxxxx.', 'xxxkxxx.', 'xxxxxxx.'],
  gear:  ['..s..s..', '.ssssss.', 'ssskkss.', '.sskkss.', 'ssskkss.', '.ssssss.', '..s..s..', '........'],
  stop:  ['..PPPP..', '.PPPPPP.', 'PPkPPkPP', 'PPPPPPPP', 'PPPPPPPP', '.PPPPPP.', '..PPPP..', '........'],
  check: ['......G.', '.....GG.', '....GG..', 'G..GG...', 'GGGG....', '.GG.....', '........', '........'],
  cam:   ['.kk.....', 'kkkkkkkk', 'kwwwwwwk', 'kwkkkkwk', 'kwkwwkwk', 'kwkkkkwk', 'kwwwwwwk', 'kkkkkkkk'],
};
ICON.clock = ['.kkkkkk.', 'kwwwwwwk', 'kwwkwwwk', 'kwwkwwwk', 'kwwkkwwk', 'kwwwwwwk', '.kkkkkk.', '........'];

const icon = (n, s = 3) => sprite(ICON[n], P, s, `icon-${n}`);

/** Altgeld tower for the monument card, 24×32. */
const ALTGELD = [
  '...........r............',
  '..........rrr...........',
  '.........rrrrr..........',
  '........rrrrrrr.........',
  '.......rrrrrrrrr........',
  '......rrrrrrrrrrr.......',
  '.....rrrrrrrrrrrrr......',
  '....kkkkkkkkkkkkkkk.....',
  '....ksssssssssssssk.....',
  '....kskkskkskkskksk.....',
  '....kskkskkskkskksk.....',
  '....ksssssssssssssk.....',
  '....kssSsssSsssSssk.....',
  '....kssSsssSsssSssk.....',
  '....kssSsssSsssSssk.....',
  '....ksssssssssssssk.....',
  '....kssSsssSsssSssk.....',
  '....kssSsssSsssSssk.....',
  '....ksssssssssssssk.....',
  '.kkkkssssssssssssskkkk..',
  'kssssssssssssssssssssss.',
  'kssSssSssssSssssSssSss.',
  'kssSssSssssSssssSssSss.',
  'kssssssssssssssssssssss.',
  'kssSssSssShhhSssSssSss.',
  'kssSssSssShhhSssSssSss.',
  'kssssssssShhhSsssssssss.',
  'kkkkkkkkkkkkkkkkkkkkkkk.',
  '.GGGGGGGGGGGGGGGGGGGGGG.',
  '.GGGGGGGGGGGGGGGGGGGGGG.',
  '........................',
  '........................',
];

/* ------------------------------------------------------------------ *
 * Composite components
 * ------------------------------------------------------------------ */

const factionDot = (color) => `<Frame w={10} h={10} bg="${color}" stroke="${C.ink}" strokeWidth={2} />`;

/** Mascot speech-bubble toast. */
const toast = (text, { w = 300 } = {}) => `
<Frame flex="row" gap={10} items="end">
  ${sprite(DUCK, P, 3, 'duck')}
  <Frame w={${w}} h="hug" p={12} bg="${C.cream}" stroke="${C.ink}" strokeWidth={2} shadow="4 4 0 ${C.ink}">
    ${body(text, C.ink, 17, 19, w - 24)}
    <Frame position="absolute" top={14} left={-8} w={8} h={10} bg="${C.cream}" />
    <Frame position="absolute" top={12} left={-10} w={2} h={14} bg="${C.ink}" />
  </Frame>
</Frame>`;

/** Chrome: title bar + physical tab buttons. */
const chrome = (active) => {
  const tabs = ['WAR ROOM', 'CAMPUS', 'TRAINER', 'CHAOS LAB', 'CHECK-IN', 'RANKS'];
  return `
<Frame w="fill" flex="col">
  <Frame w="fill" h={64} px={28} flex="row" items="center" justify="between" bg="${C.ink}">
    <Frame flex="row" gap={14} items="center">
      ${sprite(STICKERS.blockI.rows, P, 3, 'logo')}
      <Frame flex="col" gap={2}>
        ${head('HACKILLINOIS 2027', C.cream, 20)}
        ${hud('HACKILLINOIS 2027 · VOLUNTEER OPS', C.mute, 8)}
      </Frame>
      <Frame w={2} h={30} bg="${C.edge}" />
      <Frame flex="row" gap={6} items="center">
        <Frame w={8} h={8} bg="${C.prairieLt}" />
        ${hud('ONLINE', C.prairieLt, 9)}
      </Frame>
    </Frame>
    <Frame flex="row" gap={26} items="center">
      ${[['24', 'QUESTS'], ['31%', 'COVERAGE'], ['9,294', 'KARMA']].map(([v, k]) => `
      <Frame flex="col" items="end" gap={0}>
        ${num(v, C.cream, 30)}
        ${hud(k, C.mute, 8)}
      </Frame>`).join('')}
      ${button('SYNC ADONIX', { color: C.patinaLt, dark: C.patina })}
    </Frame>
  </Frame>
  <Frame w="fill" h={52} px={28} flex="row" gap={8} items="center" bg="${C.ground}" stroke="${C.ink}" strokeWidth={2}>
    ${tabs.map((t) => t === active
      ? button(t, { color: C.orange, dark: C.orangeDk, pressed: true, h: 28 })
      : button(t, { color: C.panel, dark: C.ink, textColor: C.creamDim, h: 28 })).join('')}
  </Frame>
</Frame>`;
};

const screen = (name, active, content) => `
<Frame name="${name}" w={${W}} h={${H}} bg="${C.ground}" flex="col" overflow="hidden">
  ${chrome(active)}
  ${content}
</Frame>`;

/** Quest card = a shift. */
const questCard = ({ title, venue, time, filled, cap, karma, tag, ico = 'clock', accent = C.orange }) => panel({
  w: 470, h: 156, pad: 14, gap: 8, name: 'Quest', children: `
  <Frame w="fill" flex="row" justify="between" items="start">
    <Frame flex="row" gap={12} items="start">
      <Frame w={44} h={44} bg="${C.inset}" stroke="${C.ink}" strokeWidth={2} flex="row" items="center" justify="center">
        ${icon(ico, 4)}
      </Frame>
      <Frame flex="col" gap={3} w={300}>
        ${head(title, C.cream, 17)}
        <Frame flex="row" gap={6} items="center">
          ${icon('pin', 2)}
          ${body(venue, C.mute, 15)}
        </Frame>
      </Frame>
    </Frame>
    ${tag ? sticker(tag, { color: accent, rotate: 6 }) : ''}
  </Frame>
  <Frame flex="row" gap={12} items="center">
    ${hud(time, C.creamDim, 9)}
    <Frame w={4} h={4} bg="${C.mute}" />
    ${hud(`${karma} KARMA`, C.harvest, 9)}
  </Frame>
  <Frame w="fill" flex="row" justify="between" items="end">
    <Frame flex="col" gap={5}>
      ${bar(filled, cap, { color: filled >= cap ? C.pink : accent, w: 200, h: 10 })}
      ${hud(`${filled}/${cap} SLOTS`, C.mute, 8)}
    </Frame>
    ${button(filled >= cap ? 'JOIN WAITLIST' : 'ACCEPT QUEST', filled >= cap ? { color: C.panel, dark: C.ink, textColor: C.creamDim } : {})}
  </Frame>`,
});

/** Scrolling ticker of events with pixel icons. */
const ticker = (items, w) => `
<Frame w={${w}} h={40} bg="${C.ink}" flex="row" items="center" gap={22} px={14} overflow="hidden">
  ${items.map(([ic, txt, col]) => `
  <Frame flex="row" gap={7} items="center">
    ${icon(ic, 2)}
    <Text font="${F.body}" size={16} color="${col || C.cream}">${txt}</Text>
  </Frame>`).join('')}
</Frame>`;

/** Level ring drawn as 16 pixel arc segments. */
const levelRing = (filled, total = 16, { r = 34, color = C.orange, size = 76 } = {}) => {
  const cx = size / 2, cy = size / 2;
  const segs = [];
  for (let i = 0; i < total; i++) {
    const a = (i / total) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(a) * r - 4, y = cy + Math.sin(a) * r - 4;
    segs.push(`<Frame position="absolute" top={${y.toFixed(1)}} left={${x.toFixed(1)}} w={8} h={8} bg="${i < filled ? color : C.inset}" stroke="${C.ink}" strokeWidth={1} />`);
  }
  return `<Frame w={${size}} h={${size}}>${segs.join('')}</Frame>`;
};

const RARITY = { COMMON: C.mute, UNCOMMON: C.prairieLt, RARE: C.patinaLt, EPIC: C.tensor, LEGENDARY: C.gold };

/** Sticker-book slot. */
const slot = (key, { fresh = false, locked = false } = {}) => {
  const s = STICKERS[key];
  const col = RARITY[s.rarity];
  return `
<Frame w={112} h={150} flex="col" gap={6} items="center">
  <Frame w={100} h={100}>
    <Frame position="absolute" top={0} left={0} w={96} h={96} bg="${locked ? C.inset : C.panel}" stroke="${col}" strokeWidth={${locked ? 2 : 3}} flex="row" items="center" justify="center" shadow="4 4 0 ${C.ink}">
      ${locked ? `<Text font="${F.num}" size={40} color="${C.inset}">?</Text>` : sprite(s.rows, P, 4)}
    </Frame>
    ${fresh ? `<Frame position="absolute" top={-10} left={62}>${sticker('NEW!', { color: C.pink, textColor: C.white, rotate: 12, size: 8 })}</Frame>` : ''}
  </Frame>
  <Frame flex="col" gap={2} items="center">
    ${hud(locked ? '???' : s.name.toUpperCase(), C.cream, 7)}
    ${hud(s.rarity, col, 7)}
  </Frame>
</Frame>`;
};

/** Collectible monument card. */
const monumentCard = () => `
<Frame w={302} h={422}>
  <Frame position="absolute" top={0} left={0} w={296} h={416} bg="${C.harvest}" stroke="${C.ink}" strokeWidth={3} p={8} flex="col" gap={8} shadow="5 5 0 ${C.ink}">
    <Frame w="fill" flex="row" justify="between" items="center" px={4}>
      ${hud('ALTGELD HALL', C.ink, 10)}
      <Frame flex="row" gap={4} items="center">${factionDot(C.tensor)}${hud('TENSOR', C.ink, 8)}</Frame>
    </Frame>
    <Frame w="fill" h={190} bg="${C.ground}" stroke="${C.ink}" strokeWidth={2} flex="row" items="end" justify="center" overflow="hidden">
      <Frame position="absolute" top={0} left={0} w="fill" h={190} bg="${C.inset}" />
      <Frame position="absolute" top={10} left={20} w={6} h={6} bg="${C.cream}" />
      <Frame position="absolute" top={30} left={230} w={4} h={4} bg="${C.cream}" />
      <Frame position="absolute" top={60} left={60} w={4} h={4} bg="${C.cream}" />
      <Frame position="absolute" top={40} left={190} w={6} h={6} bg="${C.harvest}" />
      <Frame position="absolute" top={0} left={70}>${sprite(ALTGELD, P, 6, 'altgeld')}</Frame>
    </Frame>
    <Frame w="fill" bg="${C.cream}" stroke="${C.ink}" strokeWidth={2} p={10} flex="col" gap={6}>
      ${head('Chime Tower', C.ink, 16)}
      ${body('Built 1897 · Richardsonian Romanesque. 15 bells, 7.5 tons, one gargoyle.', C.ink, 15, 17)}
      <Frame flex="row" gap={8} items="center">
        ${hud('CONTROL', C.ink, 8)}
        ${meter(690 / 2000, { color: C.tensor, w: 120, h: 8 })}
        ${hud('690/2000', C.ink, 8)}
      </Frame>
    </Frame>
    <Frame w="fill" flex="row" justify="between" items="center" px={4}>
      ${hud('No. 04 / 14', C.ink, 8)}
      ${sticker('RARE', { color: C.patinaLt, rotate: -4, size: 8 })}
    </Frame>
  </Frame>
</Frame>`;

/* ------------------------------------------------------------------ *
 * Page 1 — War Room
 * ------------------------------------------------------------------ */

const warRoom = () => screen('War Room', 'WAR ROOM', `
<Frame w="fill" grow={1} flex="row" gap={24} p={28}>
  <Frame flex="col" gap={16} grow={1}>
    <Frame w="fill" flex="row" justify="between" items="end">
      <Frame flex="col" gap={4}>
        ${hud('QUEST BOARD', C.mute, 9)}
        ${head('Active quests', C.cream, 30)}
        ${body('Fifty volunteers can hit one slot at once — the lock still hands out exactly capacity. Pick a quest, earn karma, hold the campus.', C.creamDim, 17, 20, 760)}
      </Frame>
      ${sticker('5 VENUES', { color: C.patinaLt, rotate: -5 })}
    </Frame>

    <Frame flex="row" gap={16} wrap rowGap={16} w={980}>
      ${questCard({ title: 'Siebel Midnight Pizza Rush', venue: 'Siebel Center Atrium', time: '02:00 PM → 04:00 PM', filled: 2, cap: 3, karma: 174, tag: 'SURGE ×1.4', ico: 'zap' })}
      ${questCard({ title: 'ECEB Hardware Check-Out', venue: 'ECEB Room 1020', time: '05:00 PM → 07:00 PM', filled: 1, cap: 2, karma: 269, tag: 'SURGE ×1.8', ico: 'gear' })}
      ${questCard({ title: 'Willard Airport Shuttle', venue: 'Siebel North Entrance', time: '08:00 PM → 10:00 PM', filled: 2, cap: 2, karma: 263, tag: 'FULL', accent: C.pink, ico: 'pin' })}
      ${questCard({ title: '3:30 AM Basement Cleanup', venue: 'Siebel Basement Corridors', time: '03:30 AM → 05:30 AM', filled: 0, cap: 4, karma: 1100, tag: 'SURGE ×5', accent: C.harvest, ico: 'alert' })}
    </Frame>

    ${ticker([
      ['check', 'Alice claimed Pizza Rush', C.prairieLt],
      ['zap', 'Surge on Basement Cleanup ×5', C.harvest],
      ['alert', 'SOS: Table 42 soldering iron down', C.pink],
      ['shield', 'Kernel reinforced Siebel +150', C.patinaLt],
      ['star', 'Charlie hit Level 12', C.gold],
    ], 980)}
  </Frame>

  <Frame w={470} flex="col" gap={18}>
    ${panel({ w: 466, h: 236, name: 'Vitals', children: `
      ${hud('OPS VITALS', C.mute, 9)}
      <Frame flex="row" gap={18} items="center">
        <Frame w={90} h={90} flex="row" items="center" justify="center">
          ${levelRing(6, 16, { color: C.prairieLt, size: 90, r: 40 })}
          <Frame position="absolute" top={24} left={0} w={90} flex="col" items="center" gap={0}>
            ${num('37%', C.cream, 26)}
            ${hud('COVER', C.mute, 7)}
          </Frame>
        </Frame>
        <Frame flex="col" gap={10}>
          <Frame flex="row" gap={14}>
            <Frame flex="col" gap={0}>${num('0', C.prairieLt, 30)}${hud('OVERBOOK', C.mute, 7)}</Frame>
            <Frame flex="col" gap={0}>${num('106', C.cream, 30)}${hud('WAITING', C.mute, 7)}</Frame>
            <Frame flex="col" gap={0}>${num('1', C.pink, 30)}${hud('SOS', C.mute, 7)}</Frame>
          </Frame>
          <Frame flex="col" gap={4}>
            ${hud('KARMA THIS SESSION  +121', C.harvest, 8)}
            <Frame flex="row" gap={2} items="end">
              ${[3, 5, 4, 8, 6, 9, 7, 12, 10, 14, 11, 16, 13, 18, 16, 20].map((v) => `<Frame w={8} h={${v}} bg="${C.harvest}" />`).join('')}
            </Frame>
          </Frame>
        </Frame>
      </Frame>` })}

    ${panel({ w: 466, h: 330, name: 'Ranks', children: `
      <Frame w="fill" flex="row" justify="between" items="center">
        ${hud('TOP TRAINERS', C.mute, 9)}
        ${sticker('LIVE', { color: C.prairieLt, rotate: 4, size: 8 })}
      </Frame>
      ${[['01', 'Charlie Patel', 'LEVIATHAN PRIME', 3600, C.gold], ['02', 'Bob Martinez', 'MIDNIGHT KRAKEN', 2400, C.creamDim], ['03', 'Alice Chen', 'SIEBEL GUARDIAN', 1250, C.bronze], ['04', 'Dana Scully', 'CURRENT RIDER', 450, C.mute], ['05', 'Evan Wright', 'NEOPHYTE', 150, C.mute]].map(([r, n, t, k, col]) => `
      <Frame w="fill" flex="row" gap={10} items="center">
        ${num(r, col, 22)}
        ${sprite(TRAINER, P, 2)}
        <Frame flex="col" gap={0} w={150}>
          ${body(n, C.cream, 17)}
          ${hud(t, col, 7)}
        </Frame>
        ${meter(k / 3600, { color: col, w: 100, h: 6 })}
        ${num(k.toLocaleString(), C.cream, 20)}
      </Frame>`).join('')}` })}

    ${toast('Table 42 needs a soldering iron. Nearest is Priya, 42 m out. Dispatch?', { w: 380 })}
    ${panel({ w: 466, h: 96, pad: 12, gap: 4, name: 'Empty', bg: C.inset, children: `
      <Frame flex="row" gap={14} items="center">
        ${sprite(DUCK, P, 3)}
        <Frame flex="col" gap={4}>
          ${hud('SOS QUEUE · ALL CLEAR', C.prairieLt, 9)}
          ${body('Nothing on fire. The duck is napping. Go hold a gym.', C.creamDim, 16, 18, 360)}
        </Frame>
      </Frame>` })}
  </Frame>
</Frame>`);

/* ------------------------------------------------------------------ *
 * Page 2 — Campus overworld HUD
 * ------------------------------------------------------------------ */

const campus = () => screen('Campus', 'CAMPUS', `
<Frame w="fill" grow={1} p={28} flex="col" gap={14}>
  <Frame w="fill" flex="row" justify="between" items="end">
    <Frame flex="col" gap={4}>
      ${hud('OVERWORLD', C.mute, 9)}
      ${head('UIUC campus', C.cream, 30)}
    </Frame>
    <Frame flex="row" gap={10} items="center">
      ${button('CINEMATIC', { color: C.panel, dark: C.ink, textColor: C.creamDim })}
      ${button('RESET VIEW', { color: C.panel, dark: C.ink, textColor: C.creamDim })}
    </Frame>
  </Frame>

  <Frame w={1544} h={790}>
    <Frame position="absolute" top={0} left={0} w={1540} h={786} bg="#0A1730" stroke="${C.ink}" strokeWidth={3} overflow="hidden" shadow="4 4 0 ${C.ink}">
      ${[160, 320, 480, 640].map((y) => `<Frame position="absolute" top={${y}} left={0} w={1540} h={6} bg="#1A2E55" />`).join('')}
      ${[300, 560, 820, 1080, 1340].map((x) => `<Frame position="absolute" top={0} left={${x}} w={6} h={786} bg="#1A2E55" />`).join('')}
      <Frame position="absolute" top={330} left={580} w={230} h={140} bg="${C.prairie}" />
      ${[[330,200],[350,230],[470,260],[610,180],[790,370],[950,450],[1120,300],[1180,500],[400,520],[1300,420],[700,600],[1000,640]].map(([x,y]) => `<Frame position="absolute" top={${y}} left={${x}} w={4} h={4} bg="${C.harvest}" />`).join('')}
      ${[[420, 300, 120, 80, '#3B2A2A'], [600, 260, 90, 120, '#2C3A5C'], [760, 330, 140, 90, '#3B2A2A'], [520, 440, 100, 70, '#2C3A5C'], [900, 420, 110, 110, '#3B2A2A'], [340, 460, 80, 90, '#2C3A5C'], [1150, 330, 130, 100, '#3B2A2A'], [1080, 540, 90, 80, '#2C3A5C']].map(([x, y, w, h, c]) => `<Frame position="absolute" top={${y}} left={${x}} w={${w}} h={${h}} bg="${c}" stroke="${C.ink}" strokeWidth={2} shadow="4 4 0 ${C.ink}">${Array.from({ length: Math.floor(w / 24) * Math.floor(h / 24) }, (_, i) => { const cols = Math.floor(w / 24); const cx = (i % cols) * 24 + 8, cy = Math.floor(i / cols) * 24 + 8; return (i * 7) % 3 === 0 ? `<Frame position="absolute" top={${cy}} left={${cx}} w={6} h={6} bg="${C.harvest}" />` : ''; }).join('')}</Frame>`).join('')}
      <Frame position="absolute" top={200} left={640} flex="col" items="center" gap={6}>
        ${sticker('FOELLINGER · 1120 CP', { color: C.silicon, rotate: 0, size: 8 })}
        <Frame w={90} h={70} bg="#5E3A2E" stroke="${C.ink}" strokeWidth={2} />
        <Frame position="absolute" top={26} left={12} w={66} h={30} bg="${C.patinaLt}" stroke="${C.ink}" strokeWidth={2} />
      </Frame>
      <Frame position="absolute" top={560} left={860} w={80} h={20} bg="${C.ink}" opacity={0.45} />
      <Frame position="absolute" top={500} left={868}>${sprite(TRAINER, P, 5, 'player')}</Frame>
      <Frame position="absolute" top={470} left={930}>${toast('That way to Foellinger! 48 m.', { w: 220 })}</Frame>

      <Frame position="absolute" top={16} left={16} flex="col" gap={8}>
        <Frame flex="row" gap={10} items="center">
          <Frame w={40} h={40} bg="${C.inset}" stroke="${C.ink}" strokeWidth={2} flex="row" items="center" justify="center">${sprite(AVATAR32, P, 1)}</Frame>
          <Frame flex="col" gap={2}>
            ${hud('ARITRO · LV 12', C.cream, 9)}
            ${meter(0.62, { color: C.harvest, w: 140, h: 6 })}
          </Frame>
        </Frame>
        <Frame flex="row" gap={6} items="center">${factionDot(C.kernel)}${hud('TEAM KERNEL', C.kernel, 8)}</Frame>
      </Frame>

      <Frame position="absolute" top={16} left={1270} w={250} flex="col" gap={6}>
        ${hud('CAMPUS CONTROL', C.mute, 8)}
        <Frame w={250} h={14} bg="${C.ink}" p={2} flex="row" gap={2}>
          <Frame w={92} h={10} bg="${C.kernel}" /><Frame w={80} h={10} bg="${C.tensor}" /><Frame w={54} h={10} bg="${C.silicon}" /><Frame w={14} h={10} bg="${C.inset}" />
        </Frame>
        <Frame flex="row" gap={12}>
          <Frame flex="row" gap={4} items="center">${factionDot(C.kernel)}${hud('5', C.cream, 8)}</Frame>
          <Frame flex="row" gap={4} items="center">${factionDot(C.tensor)}${hud('4', C.cream, 8)}</Frame>
          <Frame flex="row" gap={4} items="center">${factionDot(C.silicon)}${hud('4', C.cream, 8)}</Frame>
          <Frame flex="row" gap={4} items="center">${factionDot(C.mute)}${hud('1', C.cream, 8)}</Frame>
        </Frame>
      </Frame>

      <Frame position="absolute" top={610} left={16}>
        ${panel({ w: 180, h: 150, pad: 8, gap: 6, around: '#0A1730', bg: C.inset, name: 'Minimap', children: `
          ${hud('MINIMAP', C.mute, 7)}
          <Frame w={160} h={110} bg="${C.ground}" stroke="${C.ink}" strokeWidth={2}>
            ${[[30, 20], [60, 40], [90, 30], [120, 60], [50, 70], [100, 80]].map(([x, y]) => `<Frame position="absolute" top={${y}} left={${x}} w={6} h={6} bg="${C.tensor}" />`).join('')}
            <Frame position="absolute" top={52} left={78} w={6} h={6} bg="${C.orange}" />
            <Frame position="absolute" top={48} left={74} w={14} h={14} stroke="${C.orange}" strokeWidth={2} />
          </Frame>` })}
      </Frame>

      <Frame position="absolute" top={640} left={1180}>
        ${panel({ w: 340, h: 120, pad: 12, gap: 6, around: '#0A1730', name: 'Nearest', children: `
          <Frame w="fill" flex="row" justify="between" items="center">
            ${hud('NEAREST HACKSTOP', C.mute, 8)}
            ${icon('stop', 3)}
          </Frame>
          ${head('Foellinger Colonnade Drop', C.cream, 15)}
          <Frame flex="row" gap={10} items="center">
            ${num('48 m', C.harvest, 26)}
            ${body('walk 27 m closer to spin', C.mute, 15)}
          </Frame>
          ${bar(3, 6, { color: C.patinaLt, w: 300, h: 8 })}` })}
      </Frame>

      <Frame position="absolute" top={16} left={560} flex="row" gap={16} items="center">
        ${hud('N', C.cream, 10)}
        ${Array.from({ length: 24 }, (_, i) => `<Frame w={2} h={${i % 6 === 0 ? 12 : 6}} bg="${i === 9 ? C.orange : C.mute}" />`).join('')}
        ${hud('E', C.cream, 10)}
      </Frame>
    </Frame>
    ${notches(1540, 786, 5, C.ground)}
  </Frame>
</Frame>`);

/* ------------------------------------------------------------------ *
 * Page 3 — Trainer & Bag
 * ------------------------------------------------------------------ */

const trainer = () => screen('Trainer & Bag', 'TRAINER', `
<Frame w="fill" grow={1} p={28} flex="row" gap={24}>
  <Frame w={520} flex="col" gap={18}>
    ${panel({ w: 516, h: 352, name: 'Creator', children: `
      <Frame w="fill" flex="row" justify="between" items="center">
        ${hud('MAKE YOUR TRAINER', C.mute, 9)}
        ${sticker('STEP 2 / 3', { color: C.harvest, rotate: 4, size: 8 })}
      </Frame>
      <Frame flex="row" gap={16} items="center">
        <Frame flex="col" gap={6} items="center">
          <Frame w={120} h={120} bg="${C.inset}" stroke="${C.ink}" strokeWidth={2} flex="row" items="center" justify="center">
            <Frame w={100} h={100} bg="#3A4B6E" />
            <Frame position="absolute" top={26} left={32} w={56} h={56} bg="#C98761" rounded={28} />
            <Frame position="absolute" top={70} left={20} w={80} h={40} bg="${C.orange}" />
            <Frame position="absolute" top={6} left={6}>${icon('cam', 2)}</Frame>
          </Frame>
          ${hud('PHOTO', C.mute, 8)}
        </Frame>
        <Frame flex="col" gap={4} items="center">
          <Frame w={40} h={20} flex="row" items="center" justify="center">${hud('→', C.harvest, 14)}</Frame>
        </Frame>
        <Frame flex="col" gap={6} items="center">
          <Frame w={136} h={136} bg="${C.inset}" stroke="${C.ink}" strokeWidth={2} p={4} flex="row" items="center" justify="center">
            ${sprite(AVATAR32, P, 4, 'avatar')}
          </Frame>
          ${hud('32×32 · 4×', C.mute, 8)}
        </Frame>
        <Frame flex="col" gap={4} items="center">
          <Frame w={40} h={20} flex="row" items="center" justify="center">${hud('→', C.harvest, 14)}</Frame>
        </Frame>
        <Frame flex="col" gap={8} items="center">
          ${sprite(AVATAR32, P, 2)}
          ${sprite(TRAINER, P, 3)}
        </Frame>
      </Frame>
      <Frame flex="col" gap={6}>
        ${hud('PALETTE', C.mute, 8)}
        <Frame flex="row" gap={6}>
          ${[C.orange, C.harvest, C.patinaLt, C.tensor, C.prairieLt, C.pink, C.cream, C.mute].map((c, i) => `<Frame w={28} h={28} bg="${c}" stroke="${i === 0 ? C.cream : C.ink}" strokeWidth={${i === 0 ? 3 : 2}} />`).join('')}
        </Frame>
      </Frame>
      <Frame w="fill" flex="row" justify="between" items="center">
        ${toast("That's you! Looking sharp.", { w: 220 })}
        ${button('KEEP IT', { color: C.prairieLt, dark: C.prairie })}
      </Frame>` })}

    ${panel({ w: 516, h: 232, name: 'Profile', children: `
      <Frame flex="row" gap={16} items="center">
        <Frame w={88} h={88} flex="row" items="center" justify="center">
          ${levelRing(10, 16, { size: 88, r: 40 })}
          <Frame position="absolute" top={12} left={12} w={64} h={64} bg="${C.inset}" stroke="${C.ink}" strokeWidth={2} flex="row" items="center" justify="center">${sprite(AVATAR32, P, 2)}</Frame>
        </Frame>
        <Frame flex="col" gap={4} w={370}>
          ${head('Aritro', C.cream, 22)}
          <Frame flex="row" gap={8} items="center">${factionDot(C.kernel)}${hud('TEAM KERNEL · SIEBEL HQ', C.kernel, 8)}</Frame>
          <Frame flex="row" gap={18}>
            <Frame flex="col" gap={0}>${num('12', C.harvest, 30)}${hud('LEVEL', C.mute, 7)}</Frame>
            <Frame flex="col" gap={0}>${num('3,600', C.cream, 30)}${hud('KARMA', C.mute, 7)}</Frame>
            <Frame flex="col" gap={0}>${num('32', C.cream, 30)}${hud('HOURS', C.mute, 7)}</Frame>
          </Frame>
        </Frame>
      </Frame>
      <Frame flex="col" gap={6}>
        ${hud('BADGE SHELF', C.mute, 8)}
        <Frame w="fill" h={44} bg="${C.inset}" stroke="${C.ink}" strokeWidth={2} px={8} flex="row" gap={10} items="center">
          ${['shield', 'zap', 'star', 'heart', 'gift', 'check'].map((i) => icon(i, 3)).join('')}
          ${hud('+3', C.mute, 8)}
        </Frame>
      </Frame>` })}
  </Frame>

  <Frame flex="col" gap={18} grow={1}>
    ${panel({ w: 1000, h: 300, name: 'StickerBook', children: `
      <Frame w="fill" flex="row" justify="between" items="center">
        <Frame flex="col" gap={2}>
          ${hud('STICKER BOOK', C.mute, 9)}
          ${head('HackIllinois memorabilia', C.cream, 22)}
        </Frame>
        ${sticker('6 / 8 FOUND', { color: C.harvest, rotate: -4 })}
      </Frame>
      <Frame flex="row" gap={6} wrap rowGap={10}>
        ${slot('almaPin')}${slot('mug')}${slot('duck', { fresh: true })}${slot('pennant')}
        ${slot('iron')}${slot('patch330', { fresh: true })}${slot('dome', { locked: true })}${slot('blockI', { locked: true })}
      </Frame>` })}

    <Frame flex="row" gap={24} items="start">
      ${monumentCard()}
      <Frame flex="col" gap={14} grow={1}>
        ${hud('HOW CARDS WORK', C.mute, 9)}
        ${body('Stand within 75 m of a landmark and spin. Common drops are mugs and pennants; the Foellinger dome only drops after a night shift. Hold a stronghold to unlock its card back.', C.creamDim, 17, 20, 560)}
        ${toast('Psst — the duck is worth more than it looks.', { w: 300 })}
        ${button('OPEN MY BAG', { color: C.orange, dark: C.orangeDk })}
      </Frame>
    </Frame>
  </Frame>
</Frame>`);

/* ------------------------------------------------------------------ *
 * Page 0 — Foundations
 * ------------------------------------------------------------------ */

const foundations = () => `
<Frame name="Foundations" w={${W}} h={${H}} bg="${C.ground}" flex="col" gap={26} p={40}>
  <Frame flex="col" gap={6}>
    ${head('NEO-RETRO INDIE', C.cream, 34)}
    ${body('Direction 3. Pixel-art sensibility with modern layout discipline. Hard shadows, chamfered corners, stickers, a duck.', C.creamDim, 18)}
  </Frame>

  <Frame flex="row" gap={40}>
    <Frame flex="col" gap={10}>
      ${hud('PALETTE', C.mute, 9)}
      <Frame flex="row" gap={8}>
        ${[['ground', C.ground], ['panel', C.panel], ['ink', C.ink], ['orange', C.orange], ['harvest', C.harvest], ['patina', C.patinaLt], ['prairie', C.prairieLt], ['tensor', C.tensor], ['pink', C.pink], ['cream', C.cream]].map(([n, c]) => `
        <Frame flex="col" gap={4} items="center">
          <Frame w={56} h={56} bg="${c}" stroke="${C.ink}" strokeWidth={2} />
          ${hud(n, C.mute, 7)}
        </Frame>`).join('')}
      </Frame>
    </Frame>
    <Frame flex="col" gap={10}>
      ${hud('TYPE RAMP', C.mute, 9)}
      <Frame flex="col" gap={6}>
        <Frame flex="row" gap={12} items="center"><Frame w={110}>${hud('SILKSCREEN · HUD', C.mute, 7)}</Frame>${hud('QUEST BOARD · 9 PX', C.cream, 10)}</Frame>
        <Frame flex="row" gap={12} items="center"><Frame w={110}>${hud('JERSEY 10 · NUM', C.mute, 7)}</Frame>${num('3,600 KARMA', C.cream, 36)}</Frame>
        <Frame flex="row" gap={12} items="center"><Frame w={110}>${hud('PIXELIFY · HEAD', C.mute, 7)}</Frame>${head('Altgeld Hall', C.cream, 24)}</Frame>
        <Frame flex="row" gap={12} items="center"><Frame w={110}>${hud('VT323 · BODY', C.mute, 7)}</Frame>${body('Stand within 75 m of a landmark and spin. Readable at 17px.', C.creamDim, 17)}</Frame>
      </Frame>
    </Frame>
  </Frame>

  <Frame flex="row" gap={40} items="start">
    <Frame flex="col" gap={10}>
      ${hud('PANEL ANATOMY', C.mute, 9)}
      ${panel({ w: 300, h: 130, children: `${hud('2PX INK OUTLINE · 4PX HARD SHADOW', C.mute, 7)}${body('Chamfered 4px notches. Bevel on top and left. No radius, no blur, ever.', C.creamDim, 16, 18, 264)}<Frame flex="row" gap={8}>${button('PRIMARY')}${button('GHOST', { color: C.panel, dark: C.ink, textColor: C.creamDim })}${button('PRESSED', { pressed: true })}</Frame>` })}
    </Frame>
    <Frame flex="col" gap={10}>
      ${hud('STICKERS', C.mute, 9)}
      <Frame flex="row" gap={14} items="center">
        ${sticker('SURGE ×1.8')}${sticker('NEW!', { color: C.pink, textColor: C.white, rotate: 8 })}${sticker('FULL', { color: C.pink, textColor: C.white, rotate: -8 })}${sticker('LIVE', { color: C.prairieLt, rotate: 3 })}${sticker('RARE', { color: C.patinaLt, rotate: -3 })}
      </Frame>
      ${hud('METERS', C.mute, 9)}
      <Frame flex="row" gap={14} items="center">${bar(3, 5)}${bar(4, 4, { color: C.pink })}${meter(0.62, { color: C.harvest })}</Frame>
    </Frame>
    <Frame flex="col" gap={10}>
      ${hud('MASCOT & TOAST', C.mute, 9)}
      ${toast('Hey. Your 3:30 AM quest starts in 10 minutes.', { w: 260 })}
    </Frame>
  </Frame>

  <Frame flex="row" gap={40} items="start">
    <Frame flex="col" gap={10}>
      ${hud('STICKER SET · 16×16 AT 4×', C.mute, 9)}
      <Frame flex="row" gap={10}>
        ${Object.keys(STICKERS).map((k) => `<Frame w={76} h={76} bg="${C.inset}" stroke="${RARITY[STICKERS[k].rarity]}" strokeWidth={2} flex="row" items="center" justify="center">${sprite(STICKERS[k].rows, P, 4)}</Frame>`).join('')}
      </Frame>
    </Frame>
    <Frame flex="col" gap={10}>
      ${hud('SPRITES · 1× / 4×', C.mute, 9)}
      <Frame flex="row" gap={14} items="end">
        ${sprite(TRAINER, P, 1)}${sprite(TRAINER, P, 4)}${sprite(DUCK, P, 1)}${sprite(DUCK, P, 4)}${sprite(AVATAR32, P, 1)}${sprite(AVATAR32, P, 3)}
      </Frame>
    </Frame>
    <Frame flex="col" gap={10}>
      ${hud('ICONS · 8×8 AT 3×', C.mute, 9)}
      <Frame flex="row" gap={8}>${Object.keys(ICON).map((i) => icon(i, 3)).join('')}</Frame>
      ${hud('LEVEL RING', C.mute, 9)}
      ${levelRing(10, 16)}
    </Frame>
  </Frame>
</Frame>`;

/* ------------------------------------------------------------------ *
 * Render — one process per page (see design/build.mjs for why)
 * ------------------------------------------------------------------ */

const PAGES = [
  { file: '00-foundations', jsx: foundations },
  { file: '01-war-room', jsx: warRoom },
  { file: '02-campus', jsx: campus },
  { file: '03-trainer-bag', jsx: trainer },
];

const only = process.argv.indexOf('--page');
if (only !== -1) {
  const t = PAGES.find((x) => x.file === process.argv[only + 1]);
  await initCanvasKit();
  const g = new SceneGraph();
  const pg = g.addPage(t.file);
  const [root] = await renderJSX(g, t.jsx(), { parentId: pg.id, x: 0, y: 0 });
  if (root.warnings?.length) console.warn(`${t.file}: ${root.warnings.join('; ')}`);
  const png = await headlessRenderNodes(g, pg.id, [root.id], { scale: 1, format: 'png' });
  writeFileSync(join(OUT, `${t.file}.png`), png);
  console.log(`rendered neoretro/${t.file}.png  (${(png.length / 1024).toFixed(0)} KB)`);
} else {
  const want = process.argv.slice(2);
  for (const { file } of PAGES) {
    if (want.length && !want.includes(file)) continue;
    const r = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url), '--page', file], { env: process.env, stdout: 'inherit', stderr: 'inherit' });
    if (r.exitCode !== 0) process.exit(r.exitCode);
  }
}
