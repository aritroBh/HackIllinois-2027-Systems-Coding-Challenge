/**
 * Direction 1 — "GAME BOY COLOR / POKÉMON RED ERA"
 *
 * A handheld you could have owned in 1999, running the HackIllinois war room.
 * Strict 4-tone screens, flat everything, dialog boxes with the double-line
 * inset, a menu cursor instead of buttons, and a game layer — trainer card,
 * sticker-book bag, Pokédex-style monument entries, an encounter screen.
 *
 * Render one page per process (opentype's shaper gets poisoned across pages):
 *
 *   for p in foundations warroom turf bag; do
 *     NODE_PATH=~/.bun/install/global/node_modules bun design/directions/gameboy.mjs $p
 *   done
 */

import { SceneGraph, renderJSX, initCanvasKit, headlessRenderNodes } from '@open-pencil/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'exports', 'gameboy');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ *
 * Palettes — exactly four tones per screen
 * ------------------------------------------------------------------ */

/** Illini LCD: navy ink, two greys, orange highlight. Screen is the pale tone. */
const P = {
  ink: '#13294B',   // T0 — darkest, all outlines and text
  mid: '#5A6B8C',   // T1 — shadow / disabled / secondary
  pale: '#C7D0DB',  // T2 — screen light / fills
  hi: '#FF5F05',    // T3 — the one highlight
};

/** DMG green for Turf Wars — the original brick's four greens, orange kept for the cursor. */
const G = {
  ink: '#0F380F',
  mid: '#306230',
  pale: '#9BBC0F',
  lite: '#CFE08A',
  hi: '#FF5F05',
};

/** Device bezel around the LCD — outside the 4-tone rule because it is not screen. */
const SHELL = { body: '#0B1220', edge: '#1C2A47', label: '#6E7FA0' };

const F = { hud: 'Press Start 2P', body: 'VT323' };

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const hud = (t, size = 10, color = P.ink) =>
  `<Text font="${F.hud}" size={${size}} weight={400} lineHeight={${Math.round(size * 1.6)}} color="${color}">${t}</Text>`;

const body = (t, size = 20, color = P.ink) =>
  `<Text w="fill" font="${F.body}" size={${size}} weight={400} lineHeight={${Math.round(size * 1.05)}} color="${color}">${t}</Text>`;

/**
 * The Pokémon dialog box: 2px outer border, 1px inner line, 3px gap.
 * Everything on screen that holds content is one of these.
 */
const box = ({ w = 'fill', h = 'hug', grow = 0, pad = 10, gap = 6, children = '', pal = P, flex = 'col', bg = null, name = 'Box' }) => {
  // An h="fill" child inside an h="hug" parent resolves to zero height, so the
  // inner frame hugs unless the outer box has a real height to fill.
  const innerH = 'hug';
  return `
<Frame name="${name}" w={${JSON.stringify(w)}} h={${JSON.stringify(h)}} ${grow ? `grow={${grow}}` : ''} p={3} bg="${bg || pal.pale}" stroke="${pal.ink}" strokeWidth={2}>
  <Frame w="fill" h="${innerH}" flex="${flex}" gap={${gap}} p={${pad}} stroke="${pal.ink}" strokeWidth={1} bg="${bg || pal.pale}">
    ${children}
  </Frame>
</Frame>`;
};

/** Menu row: cursor + label, inverted when selected. */
const row = (label, { selected = false, right = '', pal = P, size = 12 } = {}) => `
<Frame w="fill" flex="row" items="center" justify="between" px={6} py={4} bg="${selected ? pal.ink : '#00000000'}">
  <Frame flex="row" gap={10} items="center">
    ${hud(selected ? '▶' : ' ', size, selected ? pal.hi : pal.pale)}
    ${hud(label, size, selected ? pal.pale : pal.ink)}
  </Frame>
  ${right ? hud(right, size - 2, selected ? pal.pale : pal.mid) : ''}
</Frame>`;

/** HP-style bar: label, boxed track, chunky fill. Fill colour by ratio. */
const hpBar = (label, cur, max, w = 200, pal = P) => {
  const r = cur / max;
  const fill = r > 0.5 ? pal.hi : r > 0.2 ? pal.mid : pal.ink;
  const inner = w - 4;
  return `
<Frame flex="col" gap={3} w={${w}}>
  <Frame w="fill" flex="row" justify="between">${hud(label, 8)}${hud(`${cur}/${max}`, 8, pal.mid)}</Frame>
  <Frame w={${w}} h={10} p={2} stroke="${pal.ink}" strokeWidth={2} bg="${pal.pale}">
    <Frame w={${Math.max(2, Math.round(inner * r))}} h={4} bg="${fill}" />
  </Frame>
</Frame>`;
};

/** Sprite from rows of chars. `map` is char → colour; '.' is transparent. */
const sprite = (rows, map, px, name = 'Sprite') => {
  const w = rows[0].length * px, h = rows.length * px;
  const cells = [];
  rows.forEach((r, y) => {
    let x = 0;
    while (x < r.length) {
      const c = r[x];
      let run = 1;
      while (x + run < r.length && r[x + run] === c) run++;
      if (c !== '.' && map[c]) {
        cells.push(`<Frame position="absolute" top={${y * px}} left={${x * px}} w={${run * px}} h={${px}} bg="${map[c]}" />`);
      }
      x += run;
    }
  });
  return `<Frame name="${name}" w={${w}} h={${h}}>${cells.join('')}</Frame>`;
};

/* ------------------------------------------------------------------ *
 * Pixel art — 32×32 trainer, 16×16 stickers, 24×24 monument icons
 * ------------------------------------------------------------------ */

const K = { k: P.ink, m: P.mid, p: P.pale, h: P.hi, w: '#FFFFFF' };

// Trainer in an Illini cap and hoodie, facing forward. k ink · m mid · h orange · p pale · w white
const TRAINER = [
  '................................',
  '..........kkkkkkkkkkk...........',
  '........kkhhhhhhhhhhhkk.........',
  '.......khhhhhhhhhhhhhhhk........',
  '......khhhhhhhwwwhhhhhhhk.......',
  '......khhhhhhhwhwhhhhhhhk.......',
  '......khhhhhhhwwwhhhhhhhk.......',
  '.....kkkkkkkkkkkkkkkkkkkkk......',
  '.....kkkkkkkkkkkkkkkkkkkkkk.....',
  '......kppppppppppppppppppk......',
  '......kppppppppppppppppppk......',
  '......kppkkppppppppkkpppk.......',
  '......kppkkppppppppkkpppk.......',
  '......kppppppppppppppppppk......',
  '.......kpppppkkkkkppppppk.......',
  '........kpppppppppppppk.........',
  '.........kkkkkkkkkkkkk..........',
  '.......kkmmmmmmmmmmmmmkk........',
  '......kmmmmmmmmmmmmmmmmmk.......',
  '.....kmmmmmmhhhhhhhmmmmmmk......',
  '.....kmmmmmmhhhhhhhmmmmmmk......',
  '....kmmkmmmmmmmmmmmmmmmkmmk.....',
  '....kmmkmmmmmmmmmmmmmmmkmmk.....',
  '....kppkmmmmmmmmmmmmmmmkppk.....',
  '.....kkkmmmmmmmmmmmmmmmkkk......',
  '.......kmmmmmmmmmmmmmmmk........',
  '.......kkkkkkkkkkkkkkkkk........',
  '.......kkkkkkk...kkkkkkk........',
  '.......kkkkkkk...kkkkkkk........',
  '.......kkkkkkk...kkkkkkk........',
  '......kkkkkkkk...kkkkkkkk.......',
  '......kkkkkkkk...kkkkkkkk.......',
];

// 16×16 memorabilia. Each uses the 4-tone map plus white.
const STICKERS = {
  'ALMA MATER PIN': [
    '................','......kkkk......','.....kmmmmk.....','.....kmmmmk.....','......kkkk......',
    '..kk..kmmk..kk..','.kmmkkkmmkkkmmk.','.kmmmmmmmmmmmmk.','..kkkkmmmmkkkk..','.....kmmmmk.....',
    '.....kmmmmk.....','....kmmmmmmk....','....kmmmmmmk....','...kkkkkkkkkk...','...khhhhhhhhk...','...kkkkkkkkkk...',
  ],
  'ALL-NIGHTER MUG': [
    '................','....k.k.k.......','...k.k.k.k......','................','..kkkkkkkkkk....',
    '..khhhhhhhhkkk..','..khhhhhhhhkmmk.','..khhhhhhhhkmmk.','..khhhhhhhhkmmk.','..kppppppppkkk..',
    '..kppppppppk....','..kppppppppk....','..kppppppppk....','..kppppppppk....','...kkkkkkkk.....','................',
  ],
  'BONEYARD DUCK': [
    '................','.......kkkk.....','......khhhhk....','.....khhkhhhkkk.','.....khhhhhhkmmk',
    '.....khhhhhhkkk.','......khhhhk....','..kk...khhhk....','.khhkkkkhhhhkk..','.khhhhhhhhhhhhk.',
    '..khhhhhhhhhhhk.','...khhhhhhhhhk..','....kkkkkkkkk...','......k..k......','.....kmk.kmk....','.....kkk.kkk....',
  ],
  'ILLINI PENNANT': [
    '................','.kk.............','.kmkkkkkkkkkk...','.kmhhhhhhhhhhkk.','.kmhhhhhhhhhhhhk',
    '.kmhhhpppphhhhhk','.kmhhhhpphhhhhk.','.kmhhhhpphhhhk..','.kmhhhpppphhhk..','.kmhhhhhhhhhk...',
    '.kmhhhhhhhhk....','.kmkkkkkkkk.....','.kmk............','.kmk............','.kkk............','................',
  ],
  'SOLDERING IRON': [
    '................','..............kk','.............khk','............khhk','...........khhk.',
    '..........kkkk..','.........kmmk...','........kmmk....','.......kmmk.....','......kmmk......',
    '....kkkkkk......','...kkkkkkk......','..kkkkkkk.......','..kkkkkk........','...kkkk.........','................',
  ],
  '3:30AM SURVIVOR': [
    '................','...kkkkkkkkkk...','..kmmmmmmmmmmk..','.kmmkkkkkkkkmmk.','.kmkppppppppkmk.',
    '.kmkpkkkkkkpkmk.','.kmkpkhhhhkpkmk.','.kmkpkhhhhkpkmk.','.kmkpkhkkhkpkmk.','.kmkpkhhhhkpkmk.',
    '.kmkpkkkkkkpkmk.','.kmkppppppppkmk.','.kmmkkkkkkkkmmk.','..kmmmmmmmmmmk..','...kkkkkkkkkk...','................',
  ],
  'FOELLINGER DOME': [
    '................','.......kk.......','......kmmk......','.....kmmmmk.....','....kmmmmmmk....',
    '...kmmmmmmmmk...','..kmmmmmmmmmmk..','..kkkkkkkkkkkk..','..khhhhhhhhhhk..','..khkhkhkhkhhk..',
    '..khkhkhkhkhhk..','..khkhkhkhkhhk..','..khkhkhkhkhhk..','..kkkkkkkkkkkk..','.kppppppppppppk.','.kkkkkkkkkkkkkk.',
  ],
  'BLOCK I PATCH': [
    '................','.kkkkkkkkkkkkkk.','.kppppppppppppk.','.kpkkkkkkkkkkpk.','.kpkhhhhhhhhkpk.',
    '.kpkkkkhhkkkkpk.','.kpppkkhhkkpppk.','.kpppkkhhkkpppk.','.kpppkkhhkkpppk.','.kpppkkhhkkpppk.',
    '.kpkkkkhhkkkkpk.','.kpkhhhhhhhhkpk.','.kpkkkkkkkkkkpk.','.kppppppppppppk.','.kkkkkkkkkkkkkk.','................',
  ],
};

const RARITY = { 'ALMA MATER PIN': 'RARE', 'ALL-NIGHTER MUG': 'COMMON', 'BONEYARD DUCK': 'UNCOMMON', 'ILLINI PENNANT': 'COMMON', 'SOLDERING IRON': 'UNCOMMON', '3:30AM SURVIVOR': 'LEGENDARY', 'FOELLINGER DOME': 'RARE', 'BLOCK I PATCH': 'RARE' };
const OWNED = { 'ALMA MATER PIN': 1, 'ALL-NIGHTER MUG': 3, 'BONEYARD DUCK': 2, 'ILLINI PENNANT': 4, 'SOLDERING IRON': 1, '3:30AM SURVIVOR': 0, 'FOELLINGER DOME': 1, 'BLOCK I PATCH': 0 };

// 24×24 Altgeld silhouette for the Pokédex entry (tower left, hall right, spire).
const ALTGELD = [
  '........................',
  '....kk..................',
  '...kkkk.................',
  '..kkkkkk................',
  '..kkkkkk................',
  '..k.kk.k................',
  '..kkkkkk................',
  '..kkkkkk................',
  '..kmmmmk................',
  '..kmkkmk........kkkk....',
  '..kmmmmk.......kkkkkk...',
  '..kmkkmk......kkkkkkkk..',
  '..kmmmmk.....kkkkkkkkkk.',
  '..kmmmmkkkkkkkkkkkkkkkkk',
  '..kmkkmkmmmmmmmmmmmmmmmk',
  '..kmmmmkmmkmmkmmkmmkmmmk',
  '..kmmmmkmmkmmkmmkmmkmmmk',
  '..kmmmmkmmmmmmmmmmmmmmmk',
  '..kmmmmkmmmkkkkkmmmmmmmk',
  '..kmmmmkmmmkkkkkmmmmmmmk',
  '..kmmmmkmmmkkkkkmmmmmmmk',
  '..kkkkkkkkkkkkkkkkkkkkkk',
  'kkkkkkkkkkkkkkkkkkkkkkkk',
  '........................',
];

// Tiny 8×8 overworld player (back view) for the map strip.
const WALKER = ['..kkkk..', '.khhhhk.', '.khhhhk.', '..kppk..', '.kmmmmk.', 'kmkmmkmk', '.kmmmmk.', '.kk..kk.'];

/* ------------------------------------------------------------------ *
 * Device shell
 * ------------------------------------------------------------------ */

/**
 * The whole page is a handheld: navy shell, LCD screen, menu strip along
 * the top of the screen, dialog bar along the bottom. 1600×1000.
 */
const device = (active, screen, pal = P, dialog = '') => {
  const tabs = ['SHIFTS', 'CAMPUS', 'TURF', 'CHAOS', 'CHECK-IN', 'BAG', 'RANKS'];
  return `
<Frame name="Device" w={1600} h={1000} bg="${SHELL.body}" flex="col" items="center" justify="center" p={28}>
  <Frame w={1544} h={944} bg="${SHELL.edge}" p={18} flex="col" gap={10} stroke="#0A0F1B" strokeWidth={2}>
    <Frame w="fill" flex="row" justify="between" items="center" px={6}>
      <Frame flex="row" gap={12} items="center">
        <Frame w={10} h={10} bg="${P.hi}" />
        <Text font="${F.hud}" size={9} weight={400} color="${SHELL.label}">NEXUS OS · HACKILLINOIS 2027</Text>
      </Frame>
      <Text font="${F.hud}" size={8} weight={400} color="${SHELL.label}">BATTERY ▮▮▮▯  ·  SSE ▶ LIVE</Text>
    </Frame>

    <Frame name="LCD" w="fill" grow={1} bg="${pal.pale}" p={12} flex="col" gap={10} stroke="#050912" strokeWidth={3}>
      <Frame name="MenuStrip" w="fill" flex="row" gap={0} items="center" stroke="${pal.ink}" strokeWidth={2} p={2}>
        ${tabs.map((t) => `
        <Frame px={12} py={7} bg="${t === active ? pal.ink : pal.pale}" flex="row" gap={6} items="center">
          ${t === active ? hud('▶', 9, pal.hi) : ''}
          ${hud(t, 9, t === active ? pal.pale : pal.ink)}
        </Frame>`).join('')}
        <Frame grow={1} />
        ${hud('SHIFTS 07  COV 50%  KARMA 7976', 8, pal.mid)}
      </Frame>

      <Frame w="fill" grow={1} flex="row" gap={12}>
        ${screen}
      </Frame>

      ${box({ name: 'DialogBar', w: 'fill', h: 92, pal, pad: 10, children: `
        <Frame flex="row" gap={14} items="start" w="fill">
          ${body(dialog, 24, pal.ink)}
        </Frame>
        <Frame w="fill" flex="row" justify="end">${hud('▼', 10, pal.ink)}</Frame>` })}
    </Frame>
  </Frame>
</Frame>`;
};

/* ------------------------------------------------------------------ *
 * Page: War Room
 * ------------------------------------------------------------------ */

const shifts = [
  ['12:21P', 'CONTESTED PIZZA STATION', 2, 2, 48, 150, true],
  ['02:00P', 'SIEBEL MIDNIGHT PIZZA', 2, 3, 1, 174, false],
  ['05:00P', 'ECEB HARDWARE CHECKOUT', 1, 2, 0, 269, false],
  ['08:00P', 'WILLARD AIRPORT SHUTTLE', 1, 2, 0, 263, false],
  ['03:30A', 'BASEMENT CLEANUP EMERG.', 0, 4, 0, 1100, false],
  ['12:00P', 'SWAG DISTRIBUTION', 2, 5, 0, 165, false],
];

const slotCells = (filled, cap, pal = P) => `
<Frame flex="row" gap={2}>
  ${Array.from({ length: cap }, (_, i) => `<Frame w={10} h={10} stroke="${pal.ink}" strokeWidth={1} bg="${i < filled ? pal.hi : pal.pale}" />`).join('')}
</Frame>`;

const warRoom = () => device('SHIFTS', `
  ${box({ name: 'ShiftList', w: 760, h: 'fill', pad: 8, gap: 2, children: `
    <Frame w="fill" flex="row" justify="between" px={6} pb={4}>${hud('ACTIVE SHIFTS', 10)}${hud('06 OF 07', 8, P.mid)}</Frame>
    <Frame w="fill" h={2} bg="${P.ink}" />
    ${shifts.map(([t, n, f, c, wl, k, sel]) => `
    <Frame w="fill" h={52} flex="row" items="center" gap={10} px={6} bg="${sel ? P.ink : '#00000000'}">
      <Frame w={16} h={52} flex="row" items="center">${hud(sel ? '▶' : '', 11, P.hi)}</Frame>
      <Frame w={76} h={52} flex="row" items="center">${hud(t, 9, sel ? P.pale : P.ink)}</Frame>
      <Frame w={470} h={52} flex="col" justify="center" gap={5}>
        ${hud(n, 9, sel ? P.pale : P.ink)}
        <Frame flex="row" gap={10} items="center" h="hug">
          ${slotCells(f, c, sel ? { ...P, pale: P.ink } : P)}
          ${hud(`${f}/${c}${wl ? ` · WL ${wl}` : ''}`, 7, sel ? P.pale : P.mid)}
        </Frame>
      </Frame>
      <Frame w={120} h={52} flex="row" justify="end" items="center">${hud(`${k}K`, 9, sel ? P.hi : P.mid)}</Frame>
    </Frame>`).join('')}
  ` })}

  <Frame flex="col" gap={12} grow={1}>
    ${box({ name: 'Vitals', w: 'fill', pad: 10, gap: 8, children: `
      ${hud('OPS VITALS', 10)}
      <Frame w="fill" h={2} bg="${P.ink}" />
      ${hpBar('COVERAGE', 50, 100, 300)}
      ${hpBar('OPEN SOS', 1, 5, 300)}
      <Frame w="fill" flex="row" justify="between">${hud('OVERBOOKS', 8)}${hud('0', 8, P.mid)}</Frame>
      <Frame w="fill" flex="row" justify="between">${hud('WAITLISTED', 8)}${hud('49', 8, P.mid)}</Frame>
    ` })}

    ${box({ name: 'Ranks', w: 'fill', pad: 10, gap: 4, children: `
      ${hud('TOP TRAINERS', 10)}
      <Frame w="fill" h={2} bg="${P.ink}" />
      ${[['01', 'CHARLIE', '3600'], ['02', 'BOB', '2400'], ['03', 'ALICE', '1250'], ['04', 'DANA', '450']].map(([r, n, k], i) =>
        row(`${r}  ${n}`, { selected: i === 0, right: `${k} KARMA`, size: 9 })).join('')}
    ` })}

    ${box({ name: 'Encounter', w: 'fill', pad: 10, gap: 8, children: `
      <Frame w="fill" flex="row" justify="between">${hud('WILD SOS', 10, P.hi)}${hud('LV 3 · HIGH', 8, P.mid)}</Frame>
      <Frame w="fill" h={2} bg="${P.ink}" />
      ${body('ALEX @ TABLE 42, SIEBEL BASEMENT', 20)}
      ${body('"Soldering station shorted out — need a backup ESP32!"', 19, P.mid)}
      ${hpBar('BOUNTY', 250, 250, 300)}
      <Frame w="fill" flex="col" gap={0} pt={4}>
        ${row('DISPATCH NEAREST', { selected: true, size: 9 })}
        ${row('ASSIGN VOLUNTEER', { size: 9 })}
        ${row('IGNORE', { size: 9 })}
      </Frame>
    ` })}
  </Frame>
`, P, 'A wild SOS appeared at SIEBEL BASEMENT!  Nearest trainer: PRIYA (42m).  Dispatch?');

/* ------------------------------------------------------------------ *
 * Page: Turf Wars — encounter + trainer card, DMG green screen
 * ------------------------------------------------------------------ */

const badges = (earned) => `
<Frame flex="row" gap={6} wrap>
  ${['ALT', 'FOE', 'UNI', 'SIE', 'ECE', 'GRA', 'STA', 'KRA'].map((b, i) => `
  <Frame w={44} h={44} stroke="${G.ink}" strokeWidth={2} bg="${i < earned ? G.hi : G.lite}" flex="col" items="center" justify="center" gap={2}>
    ${i < earned ? sprite(['.kk.', 'kkkk', 'kkkk', '.kk.'], { k: G.ink }, 4, 'Gem') : hud('?', 10, G.mid)}
    ${hud(b, 6, G.ink)}
  </Frame>`).join('')}
</Frame>`;

const turf = () => device('TURF', `
  <Frame flex="col" gap={12} w={880}>
    ${box({ name: 'Battle', w: 'fill', h: 470, pal: G, pad: 14, gap: 10, children: `
      <Frame w="fill" flex="row" justify="between" items="start">
        <Frame flex="col" gap={6}>
          ${hud('ALTGELD HALL', 12, G.ink)}
          ${hud('HELD BY TEAM TENSOR · LV 3', 8, G.mid)}
          ${hpBar('CP', 690, 2000, 320, G)}
        </Frame>
        <Frame flex="col" items="center" gap={0}>
          ${sprite(ALTGELD, { k: G.ink, m: G.mid }, 6, 'AltgeldSprite')}
          <Frame w={190} h={14} bg="${G.mid}" stroke="${G.ink}" strokeWidth={2} />
        </Frame>
      </Frame>

      <Frame w="fill" h={2} bg="${G.ink}" />

      <Frame w="fill" flex="row" justify="between" items="end">
        <Frame flex="col" items="center" gap={0}>
          ${sprite(TRAINER, { k: G.ink, m: G.mid, p: G.lite, h: G.hi, w: G.lite }, 4, 'TrainerBack')}
          <Frame w={170} h={14} bg="${G.mid}" stroke="${G.ink}" strokeWidth={2} />
        </Frame>
        <Frame flex="col" gap={6} items="end">
          ${hud('YOU · TEAM KERNEL', 12, G.ink)}
          ${hud('CHARLIE · LV 12', 8, G.mid)}
          ${hpBar('POWER', 150, 150, 320, G)}
        </Frame>
      </Frame>
    ` })}

    ${box({ name: 'Moves', w: 'fill', pal: G, pad: 8, gap: 0, flex: 'col', children: `
      <Frame w="fill" flex="row" gap={0}>
        <Frame w={420} flex="col">
          ${row('CONTEST  −150 CP', { selected: true, pal: G, size: 10 })}
          ${row('REINFORCE  +150 CP', { pal: G, size: 10 })}
        </Frame>
        <Frame w={2} h="fill" bg="${G.ink}" />
        <Frame grow={1} flex="col">
          ${row('USE ITEM', { pal: G, size: 10 })}
          ${row('RUN', { pal: G, size: 10 })}
        </Frame>
      </Frame>
    ` })}
  </Frame>

  ${box({ name: 'TrainerCard', w: 'fill', h: 'fill', pal: G, pad: 14, gap: 10, children: `
    <Frame w="fill" flex="row" justify="between">${hud('TRAINER CARD', 12, G.ink)}${hud('ID 00812', 8, G.mid)}</Frame>
    <Frame w="fill" h={2} bg="${G.ink}" />
    <Frame flex="row" gap={16} items="start">
      <Frame p={4} stroke="${G.ink}" strokeWidth={2} bg="${G.lite}">
        ${sprite(TRAINER, { k: G.ink, m: G.mid, p: G.lite, h: G.hi, w: G.lite }, 4, 'TrainerFront')}
      </Frame>
      <Frame flex="col" gap={6} h="hug">
        ${hud('CHARLIE PATEL', 11, G.ink)}
        ${hud('TEAM KERNEL', 8, G.hi)}
        <Frame flex="col" gap={3} pt={4}>
          <Frame flex="row" gap={12}>${hud('LEVEL', 8, G.mid)}${hud('12', 8, G.ink)}</Frame>
          <Frame flex="row" gap={12}>${hud('KARMA', 8, G.mid)}${hud('3,600', 8, G.ink)}</Frame>
          <Frame flex="row" gap={12}>${hud('HOURS', 8, G.mid)}${hud('32.0', 8, G.ink)}</Frame>
          <Frame flex="row" gap={12}>${hud('SOS  ', 8, G.mid)}${hud('7 ANSWERED', 8, G.ink)}</Frame>
        </Frame>
      </Frame>
    </Frame>
    <Frame w="fill" h={2} bg="${G.ink}" />
    ${hud('GYM BADGES  3/8', 9, G.ink)}
    ${badges(3)}
    <Frame w="fill" h={2} bg="${G.ink}" />
    ${hud('OVERWORLD · MAIN QUAD', 9, G.ink)}
    <Frame w="fill" h={96} bg="${G.lite}" stroke="${G.ink}" strokeWidth={2} p={0}>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<Frame position="absolute" top={${18 + (i % 2) * 40}} left={${16 + i * 60}} w={22} h={22} bg="${G.mid}" stroke="${G.ink}" strokeWidth={1} />`).join('')}
      <Frame position="absolute" top={40} left={0} w="fill" h={12} bg="${G.pale}" />
      <Frame position="absolute" top={38} left={170}>${sprite(WALKER, { k: G.ink, m: G.mid, p: G.lite, h: G.hi }, 3, 'Walker')}</Frame>
      <Frame position="absolute" top={10} left={250}>${hud('ALTGELD', 6, G.ink)}</Frame>
      <Frame position="absolute" top={70} left={300}>${hud('42m ▶', 6, G.mid)}</Frame>
    </Frame>
  ` })}
`, G, 'TEAM TENSOR holds ALTGELD HALL.  CHARLIE used CONTEST!  It\'s super effective — 150 CP knocked off.');

/* ------------------------------------------------------------------ *
 * Page: Bag — sticker book + Pokédex monument entry
 * ------------------------------------------------------------------ */

const stickerCard = (name, rows, selected = false) => {
  const owned = OWNED[name];
  const rarity = RARITY[name];
  const frame = rarity === 'LEGENDARY' ? P.hi : rarity === 'RARE' ? P.ink : P.mid;
  return `
<Frame w={176} flex="col" gap={6} p={8} bg="${selected ? P.ink : P.pale}" stroke="${frame}" strokeWidth={${rarity === 'LEGENDARY' ? 3 : 2}}>
  <Frame w="fill" h={80} flex="row" items="center" justify="center" bg="${selected ? P.ink : P.pale}">
    ${owned ? sprite(rows, { ...K, p: selected ? P.ink : P.pale }, 5, name) : hud('?', 24, P.mid)}
  </Frame>
  ${hud(owned ? name : '???', 7, selected ? P.pale : P.ink)}
  <Frame w="fill" flex="row" justify="between">
    ${hud(rarity, 6, rarity === 'LEGENDARY' ? P.hi : selected ? P.pale : P.mid)}
    ${hud(owned ? `×${owned}` : '—', 6, selected ? P.pale : P.mid)}
  </Frame>
</Frame>`;
};

const bag = () => device('BAG', `
  ${box({ name: 'StickerBook', w: 940, h: 'fill', pad: 12, gap: 10, children: `
    <Frame w="fill" flex="row" justify="between">${hud('STICKER BOOK', 11)}${hud('6 / 8 FOUND', 8, P.mid)}</Frame>
    <Frame w="fill" h={2} bg="${P.ink}" />
    <Frame flex="row" gap={10} wrap rowGap={10}>
      ${Object.entries(STICKERS).map(([n, r], i) => stickerCard(n, r, i === 0)).join('')}
    </Frame>
  ` })}

  <Frame flex="col" gap={12} grow={1} justify="start" h="fill">
    ${box({ name: 'Dex', w: 'fill', h: 372, pad: 12, gap: 8, children: `
      <Frame w="fill" flex="row" justify="between">${hud('No.003  ALTGELD HALL', 10)}${hud('SEEN', 8, P.hi)}</Frame>
      <Frame w="fill" h={2} bg="${P.ink}" />
      <Frame flex="row" gap={14} items="start" h={136}>
        <Frame p={6} stroke="${P.ink}" strokeWidth={2} bg="${P.pale}" flex="row" h={136}>
          ${sprite(ALTGELD, { k: P.ink, m: P.mid }, 5, 'AltgeldDex')}
        </Frame>
        <Frame flex="col" gap={5} h={136} justify="start">
          ${hud('CHIME TOWER', 8, P.mid)}
          <Frame flex="row" gap={10} h={14} items="center"><Frame w={54} flex="row" items="center">${hud('BUILT', 8, P.mid)}</Frame>${hud('1897', 8)}</Frame>
          <Frame flex="row" gap={10} h={14} items="center"><Frame w={54} flex="row" items="center">${hud('HT', 8, P.mid)}</Frame>${hud('132 FT', 8)}</Frame>
          <Frame flex="row" gap={10} h={14} items="center"><Frame w={54} flex="row" items="center">${hud('BELLS', 8, P.mid)}</Frame>${hud('15 · 7.5T', 8)}</Frame>
          <Frame flex="row" gap={10} h={14} items="center"><Frame w={54} flex="row" items="center">${hud('HELD', 8, P.mid)}</Frame>${hud('TENSOR', 8, P.hi)}</Frame>
        </Frame>
      </Frame>
      <Frame w="fill" h={2} bg="${P.ink}" />
      ${body('Grey rusticated stone under a red tile spire. Its 15 bells are played by hand from a wooden chimestand. Home to the only gargoyle on campus.', 19)}
    ` })}

    ${box({ name: 'Item', w: 'fill', h: 236, pad: 12, gap: 8, children: `
      ${hud('ALMA MATER PIN', 10)}
      <Frame w="fill" h={2} bg="${P.ink}" />
      ${body('A tiny enamel Alma with her arms out. Found at the plaza beacon at Green & Wright.', 19)}
      ${body('EFFECT: +5% karma on Quad shifts while worn.', 19, P.mid)}
      <Frame w="fill" flex="col" pt={4}>
        ${row('WEAR', { selected: true, size: 9 })}
        ${row('GIVE TO TRAINER', { size: 9 })}
        ${row('TOSS', { size: 9 })}
      </Frame>
    ` })}
  </Frame>
`, P, 'You found a BONEYARD DUCK!  It went into the STICKER BOOK.  (2 of 8 stickers to next badge.)');

/* ------------------------------------------------------------------ *
 * Page: Foundations strip
 * ------------------------------------------------------------------ */

const foundations = () => `
<Frame name="Foundations" w={1600} h={1000} bg="${SHELL.body}" flex="col" gap={22} p={40}>
  <Frame flex="col" gap={6}>
    <Text font="${F.hud}" size={22} weight={400} color="${P.pale}">DIRECTION 1 · GAME BOY COLOR</Text>
    ${body('A handheld from 1999 running the war room. Four tones per screen, flat only, dialog boxes and cursors, and a game layer underneath the ops.', 22, SHELL.label)}
  </Frame>

  <Frame flex="row" gap={40} items="start">
    <Frame flex="col" gap={10}>
      ${hud('ILLINI LCD RAMP', 9, P.pale)}
      <Frame flex="row" gap={8}>
        ${[['T0 INK', P.ink], ['T1 MID', P.mid], ['T2 PALE', P.pale], ['T3 HI', P.hi]].map(([n, c]) => `
        <Frame flex="col" gap={6} items="center"><Frame w={88} h={64} bg="${c}" stroke="${P.pale}" strokeWidth={2} />${hud(n, 7, P.pale)}${hud(c, 6, SHELL.label)}</Frame>`).join('')}
      </Frame>
    </Frame>
    <Frame flex="col" gap={10}>
      ${hud('DMG GREEN RAMP (TURF)', 9, P.pale)}
      <Frame flex="row" gap={8}>
        ${[['INK', G.ink], ['MID', G.mid], ['PALE', G.pale], ['LITE', G.lite]].map(([n, c]) => `
        <Frame flex="col" gap={6} items="center"><Frame w={88} h={64} bg="${c}" stroke="${P.pale}" strokeWidth={2} />${hud(n, 7, P.pale)}${hud(c, 6, SHELL.label)}</Frame>`).join('')}
      </Frame>
    </Frame>
  </Frame>

  <Frame flex="row" gap={40} items="start">
    <Frame flex="col" gap={10} w={560}>
      ${hud('TYPE', 9, P.pale)}
      <Frame flex="col" gap={10} p={14} bg="${P.pale}" stroke="${P.ink}" strokeWidth={2}>
        ${hud('PRESS START 2P · HUD 12', 12)}
        ${hud('PRESS START 2P · LABEL 8', 8, P.mid)}
        ${body('VT323 · dialog and data at 22. Sentence case for speech, caps for the HUD.', 22)}
        ${body('0123456789  CP 690/2000  ▶ ▼', 22, P.mid)}
      </Frame>
    </Frame>

    <Frame flex="col" gap={10} w={520}>
      ${hud('DIALOG BOX ANATOMY', 9, P.pale)}
      ${box({ w: 520, pad: 12, children: `
        ${body('2 px outer border, 3 px gap, 1 px inner line. Content sits inside the inner line. The ▼ means “press A”.', 22)}
        <Frame w="fill" flex="row" justify="end">${hud('▼', 10)}</Frame>` })}
      <Frame flex="col" gap={0} bg="${P.pale}" stroke="${P.ink}" strokeWidth={2} p={3}>
        ${row('SELECTED ROW INVERTS', { selected: true, size: 9 })}
        ${row('UNSELECTED ROW', { size: 9 })}
      </Frame>
    </Frame>

    <Frame flex="col" gap={10}>
      ${hud('TRAINER SPRITE 1× · 4×', 9, P.pale)}
      <Frame flex="row" gap={16} items="end" p={12} bg="${P.pale}" stroke="${P.ink}" strokeWidth={2}>
        ${sprite(TRAINER, K, 1, 'T1x')}
        ${sprite(TRAINER, K, 4, 'T4x')}
      </Frame>
    </Frame>
  </Frame>

  <Frame flex="col" gap={10}>
    ${hud('MEMORABILIA · 16×16 · 4 TONES + WHITE', 9, P.pale)}
    <Frame flex="row" gap={14} p={12} bg="${P.pale}" stroke="${P.ink}" strokeWidth={2}>
      ${Object.entries(STICKERS).map(([n, r]) => `<Frame flex="col" gap={6} items="center" w={150}>${sprite(r, K, 4, n)}${hud(n, 6)}</Frame>`).join('')}
    </Frame>
  </Frame>
</Frame>`;

/* ------------------------------------------------------------------ *
 * Build one page per process
 * ------------------------------------------------------------------ */

const PAGES = { foundations, warroom: warRoom, turf, bag };
const which = process.argv[2];
if (!PAGES[which]) {
  console.error(`usage: bun gameboy.mjs <${Object.keys(PAGES).join('|')}>`);
  process.exit(2);
}

const graph = new SceneGraph();
const page = graph.addPage(`GB · ${which}`);
const [root] = await renderJSX(graph, PAGES[which](), { parentId: page.id, x: 0, y: 0 });
if (root.warnings?.length) console.warn(root.warnings.join('\n'));
await initCanvasKit();
const png = await headlessRenderNodes(graph, page.id, [root.id], { scale: 1, format: 'png' });
const file = join(OUT, `${which}.png`);
writeFileSync(file, png);
console.log(`wrote ${file} (${(png.length / 1024).toFixed(0)} KB)`);
