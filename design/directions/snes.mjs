/**
 * Direction 2 — "SNES / 16-bit JRPG".
 *
 * Chrono Trigger / FFVI / Earthbound menu language for the HackIllinois war
 * room: ornate-bordered navy windows, Harvest title plates, segmented HP
 * bars, a command menu, a message window with a blinking cursor, and a pixel
 * overworld that echoes the real campus.
 *
 *   NODE_PATH=~/.bun/install/global/node_modules bun design/directions/snes.mjs <page>
 *   page ∈ foundations | warroom | turf | bag   (one process per page)
 */

import { SceneGraph, renderJSX, initCanvasKit, headlessRenderNodes } from '@open-pencil/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'exports', 'snes');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ *
 * 16-colour palette (official Illini set, quantised for pixel art)
 * ------------------------------------------------------------------ */
export const P = {
  ink: '#0A0F1C',      // 0 near-black
  navy: '#13294B',     // 1 Illini Blue
  navy2: '#1F3D6E',    // 2 lighter navy (dither partner)
  arches: '#009FD4',   // 3
  patina: '#007E8E',   // 4
  prairie: '#006230',  // 5
  leaf: '#3AA24A',     // 6
  earth: '#7D3E13',    // 7
  brick: '#B5482B',    // 8
  orange: '#FF5F05',   // 9 Illini Orange
  harvest: '#FCB316',  // 10
  cream: '#F4E6C8',    // 11
  storm: '#707372',    // 12
  storm60: '#8E9090',  // 13
  storm80: '#C6C7C6',  // 14
  white: '#FFFFFF',    // 15
};
// One-letter keys for sprite maps.
const K = {
  '.': null, k: P.ink, n: P.navy, N: P.navy2, a: P.arches, p: P.patina, g: P.prairie, l: P.leaf,
  e: P.earth, b: P.brick, o: P.orange, h: P.harvest, c: P.cream, s: P.storm, S: P.storm60, t: P.storm80, w: P.white,
};

const F = { head: 'Pixelify Sans', body: 'DotGothic16', mono: 'VT323', hud: 'Silkscreen' };

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const T = (t, { font = F.body, size = 18, color = P.cream, ls = 0, w } = {}) =>
  `<Text font="${font}" size={${size}} weight={400} letterSpacing={${ls}} color="${color}"${w ? ` w={${w}}` : ''}>${t}</Text>`;
const H = (t, o = {}) => T(t, { font: F.head, size: 22, color: P.cream, ...o });
const HUD = (t, o = {}) => T(t, { font: F.hud, size: 11, color: P.harvest, ls: 1, ...o });
const M = (t, o = {}) => T(t, { font: F.mono, size: 20, color: P.storm80, ...o });

/** Pixel sprite from a string map; `px` = screen pixels per texel. */
const sprite = (rows, px = 4, name = 'Sprite') => {
  const h = rows.length, w = Math.max(...rows.map((r) => r.length));
  const cells = [];
  rows.forEach((row, y) => {
    // Run-length merge horizontally to keep node counts down.
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      const col = K[ch];
      if (col) cells.push(`<Frame position="absolute" top={${y * px}} left={${x * px}} w={${run * px}} h={${px}} bg="${col}" />`);
      x += run;
    }
  });
  return `<Frame name="${name}" w={${w * px}} h={${h * px}}>${cells.join('')}</Frame>`;
};

/** Checker dither field, cell = texel size. */
const dither = (w, h, c1, c2, cell = 6) => {
  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if ((x + y) % 2) cells.push(`<Frame position="absolute" top={${y * cell}} left={${x * cell}} w={${cell}} h={${cell}} bg="${c2}" />`);
    }
  }
  return `<Frame w={${w}} h={${h}} bg="${c1}" overflow="hidden">${cells.join('')}</Frame>`;
};

/**
 * JRPG window: 3px light outer border, 1px dark line, 2px inner light, navy
 * fill, corner notches; optional Harvest title plate top-left.
 */
const win = ({ w, h = 'hug', title, children = '', pad = 14, gap = 8, fill = P.navy, name = 'Window', dark = false }) => {
  const H = JSON.stringify(h);
  const inner = h === 'hug' ? '"hug"' : '"fill"';
  return `
<Frame name="${name}" w={${JSON.stringify(w)}} h={${H}} bg="${P.storm80}" p={3} flex="col">
  <Frame w="fill" h={${inner}} bg="${P.ink}" p={1} flex="col">
    <Frame w="fill" h={${inner}} bg="${P.storm60}" p={2} flex="col">
      <Frame w="fill" h={${inner}} bg="${dark ? P.ink : fill}" flex="col" gap={${gap}} p={${pad}} ${title ? 'pt={24}' : ''}>
        ${children}
      </Frame>
    </Frame>
  </Frame>
  ${title ? `
  <Frame position="absolute" top={-9} left={14} bg="${P.ink}" p={2}>
    <Frame bg="${P.harvest}" px={10} py={3}>
      ${T(title, { font: F.hud, size: 11, color: P.ink, ls: 1.2 })}
    </Frame>
  </Frame>` : ''}
</Frame>`;
};

/** Segmented HP/CP bar. */
const bar = (filled, total, color = P.leaf, w = 220, h = 12, cellGap = 2) => {
  const cw = (w - cellGap * (total - 1)) / total;
  return `
<Frame w={${w}} h={${h}} bg="${P.ink}" p={2}>
  <Frame flex="row" gap={${cellGap}} w="fill" h="fill">
    ${Array.from({ length: total }, (_, i) => `<Frame w={${cw.toFixed(2)}} h="fill" bg="${i < filled ? color : P.navy2}" />`).join('')}
  </Frame>
</Frame>`;
};

/** Classic continuous HP bar with a lighter top line. */
const hp = (pct, color = P.leaf, w = 260) => `
<Frame w={${w}} h={12} bg="${P.ink}" p={2}>
  <Frame w={${Math.max(4, Math.round((w - 4) * pct))}} h="fill" bg="${color}">
    <Frame position="absolute" top={0} left={0} w="fill" h={3} bg="${P.white}" opacity={0.35} />
  </Frame>
</Frame>`;

/** Command menu with ▶ cursor. */
const menu = (items, sel = 0, w = 220) => `
<Frame flex="col" gap={4} w={${w}}>
  ${items.map((it, i) => `
  <Frame flex="row" gap={10} items="center" px={6} py={2} ${i === sel ? `bg="${P.navy2}"` : ''}>
    ${T(i === sel ? '▶' : ' ', { font: F.mono, size: 20, color: P.harvest, w: 16 })}
    ${T(it, { font: F.body, size: 20, color: i === sel ? P.white : P.cream })}
  </Frame>`).join('')}
</Frame>`;

/** Bottom message window with blinking cursor. */
const message = (lines, w = 'fill') => win({
  w, pad: 16, gap: 6, name: 'Message', children: `
  ${lines.map((l) => T(l, { font: F.body, size: 21, color: P.cream })).join('')}
  <Frame w="fill" flex="row" justify="end">${T('▼', { font: F.mono, size: 20, color: P.harvest })}</Frame>`,
});

/* ------------------------------------------------------------------ *
 * Sprites
 * ------------------------------------------------------------------ */

// 24×32 player — orange hoodie, navy jeans, Block-I cap.
const PLAYER = [
  '........kkkkkkkk........',
  '.......koooooooook......',
  '......kooooooooooook.....',
  '......kohhoooohhook.....',
  '.......kkkkkkkkkkk......',
  '.......kccccccccck......',
  '......kcckccccckcck.....',
  '......kcccccccccck......',
  '.......kccckkkccck......',
  '........kcccccck........',
  '.........kkkkkk.........',
  '......kkkoooooookkk.....',
  '.....koooooooooooook....',
  '....kooookooooookoook...',
  '....kooookohhhokoooook..',
  '....kooookohhhokoooook..',
  '....kccokoooooookoccok..',
  '.....kkkkoooooookkkk....',
  '........kooooooook......',
  '........kkkkkkkkkk......',
  '........knnnnnnnnk......',
  '........knnnkknnnk......',
  '........knnnkknnnk......',
  '........knnnkknnnk......',
  '........knnnkknnnk......',
  '........knnnkknnnk......',
  '........kkkkkkkkkk......',
  '.......kSSSkkkkSSSk.....',
  '.......kSSSk..kSSSk.....',
  '.......kkkkk..kkkkk.....',
  '........................',
  '........................',
];

// 24×32 rival — Tensor purple-ish? Palette has no purple; use patina cloak + harvest visor.
const RIVAL = [
  '........kkkkkkkk........',
  '.......kppppppppk.......',
  '......kppppppppppk......',
  '......kphhhhhhhhpk......',
  '......kpkkkkkkkkpk......',
  '.......kccccccccck......',
  '......kcckccccckcck.....',
  '......kcccccccccck......',
  '.......kcccckkcccck.....',
  '........kcccccck........',
  '.........kkkkkk.........',
  '......kkkppppppppkkk....',
  '.....kppppppppppppppk...',
  '....kppppkppppppkpppk...',
  '....kppppkpaaaapkpppk...',
  '....kppppkpaaaapkpppk...',
  '....kccpkppppppppkpcck..',
  '.....kkkkppppppppkkkk...',
  '........kppppppppk......',
  '........kkkkkkkkkk......',
  '........kkkkkkkkkk......',
  '........kkkkkkkkkk......',
  '........kkkkkkkkkk......',
  '........kkkkkkkkkk......',
  '........kkkkkkkkkk......',
  '........kkkkkkkkkk......',
  '........kkkkkkkkkk......',
  '.......kSSSkkkkSSSk.....',
  '.......kSSSk..kSSSk.....',
  '.......kkkkk..kkkkk.....',
  '........................',
  '........................',
];

// Foellinger: brick drum, limestone portico, verdigris dome (32 wide).
const FOELLINGER = [
  '..............kk................',
  '.............khhk...............',
  '..........kkkppppkkk............',
  '........kkppppppppppkk..........',
  '.......kppppppppppppppk.........',
  '......kpppppppppppppppk.........',
  '......kppapppppapppppak.........',
  '......kkkkkkkkkkkkkkkkk.........',
  '.....kcccccccccccccccck.........',
  '.....kcbbbbbbbbbbbbbbck.........',
  '.....kcbbcbbcbbcbbcbbck.........',
  '.....kcbbcbbcbbcbbcbbck.........',
  '.....kcbbcbbcbbcbbcbbck.........',
  '.....kcbbcbbcbbcbbcbbck.........',
  '.....kcbbhbbhbbhbbhbbck.........',
  '.....kcbbbbbbbbbbbbbbck.........',
  '.....kcccccccccccccccck.........',
  '....kkkkkkkkkkkkkkkkkkkk........',
];

// Altgeld: grey stone hall, tall tower with red tile spire and turrets.
const ALTGELD = [
  '..........kk......................',
  '.........kbbk.....................',
  '........kbbbbk....................',
  '.......kbbbbbbk...................',
  '......kbbbbbbbbk..................',
  '.....kbbbbbbbbbbk.................',
  '....kbkkkkkkkkkkbk................',
  '....kSkSSSSSSSSkSk................',
  '....kSkSkSSSSkSkSk................',
  '....kSkSkSSSSkSkSk................',
  '....kkkSSSSSSSSkkk................',
  '......kSSkSSkSSk..................',
  '......kSSkSSkSSk..................',
  '......kSShSShSSk..................',
  '......kSSSSSSSSkkkkkkkkkkkkkkkkk..',
  '......kSSSSSSSSkSSSSSSSSSSSSSSSSk.',
  '......kSSSSSSSSkSSkSSkSSkSSkSSSSk.',
  '......kSSSSSSSSkSSkSSkSSkSSkSSSSk.',
  '......kSSSSSSSSkSShSShSShSShSSSSk.',
  '......kSSSSSSSSkSSSSSSSSSSSSSSSSk.',
  '.....kkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
];

// Elm tree 16×20.
const ELM = [
  '......kkkk......',
  '....kkllllkk....',
  '...kllllllllk...',
  '..kllglllllllk..',
  '..kllllllglllk..',
  '.klllllllllllk..',
  '.kgllllllgllllk.',
  '.kllllllllllllk.',
  '..klllglllllgk..',
  '..kkllllllllkk..',
  '....kkllllkk....',
  '......kkkk......',
  '.......kek......',
  '.......kek......',
  '.......kek......',
  '.......kek......',
  '......kkekk.....',
  '.....kggggk.....',
  '......kkkkk.....',
  '................',
];

// 16×16 memorabilia.
const ITEMS = {
  alma: ['......kkkk......','.....khhhhk.....','....khhhhhhk....','....kheeeehk....','...khhhhhhhhk...','...kheeeeeehk...','...khhhhhhhhk...','....khhhhhhk....','.....khhhhk.....','......kkkk......','......kSSk......','......kSSk......','......kSSk......','.....kSSSSk.....','.....kkkkkk.....','................'],
  mug:  ['................','..kkkkkkkkkk....','..kccccccccckk..','..kcbbbbbbbck.k.','..kcbbbbbbbck.k.','..kcbhhhhbbck.k.','..kcbhhhhbbckkk.','..kcbbbbbbbck...','..kccccccccck...','...kkkkkkkkk....','................','................','................','................','................','................'],
  duck: ['................','......kkkk......','.....khhhhk.....','....khhhhhhk....','....kkhhhhhkk...','...koohhhhhhk...','....kkkhhhhhk...','......khhhhhhkk.','.....khhhhhhhhhk','.....khhhhhhhhhk','......khhhhhhhk.','.......kkkkkkk..','................','................','................','................'],
  pennant: ['kk..............','kok.............','kookk...........','koooook.........','koooooookk......','koohhhoooooook..','koohhhoooooook..','koooooookk......','koooook.........','kookk...........','kok.............','kk..............','k...............','k...............','k...............','k...............'],
  iron: ['..............kk','.............kSk','............kSSk','...........kSSk.','..........kSSk..','.........kSSk...','........kkkk....','.......kbbk.....','......kbbbk.....','.....kbbbk......','....kbbbk.......','...kkkkk........','..kok...........','.koook..........','.koook..........','..kkk...........'],
  patch: ['....kkkkkkkk....','..kknnnnnnnnkk..','.knnnnnnnnnnnnk.','.knhhnnhnnhhnnk.','knnhnhnhnhnhnnnk','knnhhnnhnnhhnnnk','knnnnnnnnnnnnnnk','knnnhhhhhhhnnnnk','knnnnnnnnnnnnnnk','.knnhhnnnnhhnnk.','.knnnnnnnnnnnnk.','..kknnnnnnnnkk..','....kkkkkkkk....','................','................','................'],
  badge: ['......kkkk......','....kkppppkk....','...kppppppppk...','..kpppppppppk...','..kppkkkkkppk...','..kpkccccckpk...','..kpkcbbbckpk...','..kpkccccckpk...','..kppkkkkkppk...','..kpppppppppk...','...kppppppppk...','....kkppppkk....','......kkkk......','.....kh..hk.....','....kh....hk....','....kk....kk....'],
  blocki: ['kkkkkkkkkkkkkkkk','koooooooooooooook','koonnnnnnnnnnook','koonnnnnnnnnnook','kooooooonooooook','kkkkkkkonokkkkkk','......konok.....','......konok.....','......konok.....','......konok.....','kkkkkkkonokkkkkk','kooooooonooooook','koonnnnnnnnnnook','koonnnnnnnnnnook','koooooooooooooook','kkkkkkkkkkkkkkkk'],
};

/* ------------------------------------------------------------------ *
 * Chrome shared by every page
 * ------------------------------------------------------------------ */

const W = 1600, HH = 1000;

const topbar = (active) => {
  const tabs = ['WAR ROOM', 'TURF WARS', 'BAG', 'BESTIARY', 'CHECK-IN', 'RANKS'];
  return `
<Frame w="fill" h="hug" flex="col" bg="${P.ink}">
  <Frame w="fill" h={56} flex="row" items="center" justify="between" px={24} bg="${P.navy}">
    <Frame flex="row" gap={16} items="center">
      ${sprite(ITEMS.blocki, 2, 'BlockI')}
      <Frame flex="col" gap={2}>
        ${H('HACKILLINOIS 2027', { size: 20, color: P.harvest })}
        ${HUD('VOLUNTEER OPS · QUEST LOG', { color: P.storm80 })}
      </Frame>
    </Frame>
    <Frame flex="row" gap={26} items="center">
      ${[['SHIFTS', '24'], ['COVER', '87%'], ['KARMA', '14207']].map(([k, v]) => `
      <Frame flex="col" gap={2} items="end">
        ${T(v, { font: F.mono, size: 26, color: P.white })}
        ${HUD(k, { color: P.storm80 })}
      </Frame>`).join('')}
      <Frame bg="${P.ink}" p={2}><Frame bg="${P.leaf}" px={8} py={3}>${HUD('● LIVE', { color: P.ink })}</Frame></Frame>
    </Frame>
  </Frame>
  <Frame w="fill" h={40} flex="row" gap={2} items="center" px={22} bg="${P.ink}">
    ${tabs.map((t) => t === active
      ? `<Frame bg="${P.storm80}" p={2}><Frame bg="${P.harvest}" px={12} py={5}>${HUD('▶ ' + t, { color: P.ink })}</Frame></Frame>`
      : `<Frame px={14} py={7}>${HUD(t, { color: P.storm60 })}</Frame>`).join('')}
  </Frame>
</Frame>`;
};

const screen = (name, active, content) => `
<Frame name="${name}" w={${W}} h={${HH}} bg="${P.ink}" flex="col" overflow="hidden">
  <Frame position="absolute" top={96} left={0} w={${W}} h={${HH - 96}}>${dither(W, HH - 96, P.ink, P.navy, 10)}</Frame>
  ${topbar(active)}
  ${content}
</Frame>`;

/* ------------------------------------------------------------------ *
 * Page: Foundations
 * ------------------------------------------------------------------ */

const foundations = () => `
<Frame name="Foundations" w={${W}} h={${HH}} bg="${P.ink}" flex="col" gap={26} p={40}>
  ${H('DIRECTION 2 · SNES / 16-BIT JRPG', { size: 34, color: P.harvest })}
  ${T('Chrono Trigger windows, Earthbound bluntness, Illini colours quantised to 16 texels.', { size: 20, color: P.storm80 })}

  <Frame flex="col" gap={10}>
    ${HUD('16-COLOUR PALETTE')}
    <Frame flex="row" gap={6} wrap>
      ${Object.entries(P).map(([n, c]) => `
      <Frame flex="col" gap={4} w={88}>
        <Frame w={88} h={44} bg="${c}" stroke="${P.storm80}" strokeWidth={2} />
        ${T(n, { font: F.mono, size: 16, color: P.storm80 })}
      </Frame>`).join('')}
    </Frame>
  </Frame>

  <Frame flex="row" gap={40}>
    <Frame flex="col" gap={10} w={720}>
      ${HUD('TYPE RAMP')}
      ${H('Pixelify Sans — headings & titles', { size: 30 })}
      ${T('DotGothic16 — body copy and menus, reads at 18–21px', { size: 20 })}
      ${M('VT323 — numerals, logs, the ▼ cursor  0123456789')}
      ${HUD('SILKSCREEN — HUD labels · TABS · STATUS', { size: 12 })}
    </Frame>
    <Frame flex="col" gap={10}>
      ${HUD('WINDOW ANATOMY')}
      ${win({ w: 360, title: 'TITLE PLATE', children: `
        ${T('3px light · 1px ink · 2px mid · navy fill', { size: 18 })}
        ${T('corner notches, Harvest plate on ink', { size: 18, color: P.storm80 })}
        ${bar(7, 10, P.leaf)}
        ${menu(['CLAIM', 'DETAILS', 'LOCATE'], 0, 180)}` })}
    </Frame>
  </Frame>

  <Frame flex="col" gap={10}>
    ${HUD('SPRITE SHEET · 1× / 4×')}
    <Frame flex="row" gap={30} items="end">
      ${sprite(PLAYER, 1)} ${sprite(PLAYER, 4, 'Player')} ${sprite(RIVAL, 4, 'Rival')}
      ${sprite(ELM, 4, 'Elm')} ${sprite(FOELLINGER, 4, 'Foellinger')} ${sprite(ALTGELD, 4, 'Altgeld')}
    </Frame>
    <Frame flex="row" gap={18} items="end">
      ${Object.entries(ITEMS).map(([n, r]) => `<Frame flex="col" gap={6} items="center">${sprite(r, 4, n)}${T(n, { font: F.mono, size: 16, color: P.storm80 })}</Frame>`).join('')}
    </Frame>
  </Frame>
</Frame>`;

/* ------------------------------------------------------------------ *
 * Page: War Room — quest board
 * ------------------------------------------------------------------ */

const quest = ({ name, venue, time, filled, cap, stars, reward, surge, sel }) => `
<Frame w="fill" flex="row" gap={14} items="center" px={10} py={8} ${sel ? `bg="${P.navy2}"` : ''}>
  ${T(sel ? '▶' : ' ', { font: F.mono, size: 22, color: P.harvest, w: 16 })}
  <Frame flex="col" gap={4} w={420}>
    <Frame flex="row" gap={10} items="center">
      ${T(name, { font: F.body, size: 21, color: sel ? P.white : P.cream })}
      ${surge ? `<Frame bg="${P.ink}" p={1}><Frame bg="${P.orange}" px={6} py={1}>${HUD('SURGE ×' + surge, { color: P.ink, size: 10 })}</Frame></Frame>` : ''}
    </Frame>
    ${T(venue + '  ·  ' + time, { font: F.mono, size: 18, color: P.storm80 })}
  </Frame>
  ${T('★'.repeat(stars) + '☆'.repeat(3 - stars), { font: F.mono, size: 20, color: P.harvest, w: 70 })}
  <Frame flex="col" gap={3} w={200}>
    ${bar(filled, cap, filled >= cap ? P.brick : P.leaf, 200, 12)}
    ${T(`${filled}/${cap} SLOTS`, { font: F.mono, size: 16, color: P.storm80 })}
  </Frame>
  ${T(reward + ' KP', { font: F.mono, size: 22, color: P.harvest, w: 110 })}
</Frame>`;

const partyMember = (name, cls, lv, hpPct, spr) => `
<Frame flex="row" gap={12} items="center" w="fill">
  <Frame w={36} h={48} overflow="hidden">${spr}</Frame>
  <Frame flex="col" gap={3} w={300}>
    <Frame flex="row" justify="between" w="fill">
      ${T(name, { size: 19, color: P.white })}
      ${T('Lv' + lv, { font: F.mono, size: 18, color: P.harvest })}
    </Frame>
    ${T(cls, { font: F.mono, size: 16, color: P.storm80 })}
    ${hp(hpPct, hpPct > 0.5 ? P.leaf : hpPct > 0.25 ? P.harvest : P.brick, 190)}
  </Frame>
</Frame>`;

const warroom = () => screen('War Room', 'WAR ROOM', `
<Frame w="fill" grow={1} flex="row" gap={22} p={24}>
  <Frame flex="col" gap={18} grow={1}>
    ${win({ w: 'fill', title: 'QUEST BOARD · ACTIVE SHIFTS', pad: 12, gap: 2, children: `
      ${quest({ name: 'Registration Desk — Wave A', venue: 'ILLINI UNION', time: 'SAT 08:00→12:00', filled: 6, cap: 8, stars: 1, reward: 150, sel: true })}
      ${quest({ name: 'Overnight Hardware Support', venue: 'ECEB LABS', time: 'SUN 00:00→04:00', filled: 1, cap: 6, stars: 3, reward: 360, surge: '2.4' })}
      ${quest({ name: 'Mentor Floor Sweep', venue: 'KENNEY GYM', time: 'SAT 14:00→18:00', filled: 5, cap: 5, stars: 2, reward: 200 })}
      ${quest({ name: 'Midnight Snack Runner', venue: 'DCL DOCK', time: 'SUN 23:00→02:00', filled: 3, cap: 4, stars: 2, reward: 270, surge: '1.8' })}
      ${quest({ name: '3:30 AM Basement Cleanup', venue: 'SIEBEL B1', time: 'SUN 03:30→05:30', filled: 0, cap: 4, stars: 3, reward: 1100, surge: '5' })}
      ${quest({ name: 'Closing Ceremony Crew', venue: 'FOELLINGER', time: 'SUN 15:00→18:00', filled: 2, cap: 6, stars: 1, reward: 180 })}` })}

    <Frame flex="row" gap={18} w="fill">
      ${win({ w: 300, title: 'COMMAND', children: menu(['CLAIM', 'DETAILS', 'LOCATE', 'WAITLIST'], 0, 240) })}
      <Frame grow={1}>${message([
        'A shift at ILLINI UNION needs 2 more hands.',
        'Claim it? The reservation lock will hold your slot for 30s.',
      ])}</Frame>
    </Frame>
  </Frame>

  <Frame w={400} flex="col" gap={18}>
    ${win({ w: 'fill', title: 'PARTY · ON DUTY', gap: 12, children: `
      ${partyMember('PRIYA', 'HARDWARE HERO', 12, 0.9, sprite(PLAYER, 1.5))}
      ${partyMember('MARCUS', 'SNACK RUNNER', 9, 0.55, sprite(RIVAL, 1.5))}
      ${partyMember('SOFIA', 'NIGHT OWL', 11, 0.3, sprite(PLAYER, 1.5))}
      ${partyMember('WEI', 'DESK PALADIN', 7, 0.75, sprite(RIVAL, 1.5))}` })}
    ${win({ w: 'fill', title: 'SOS · DISTRESS', children: `
      <Frame flex="row" gap={10} items="center">
        ${T('!', { font: F.head, size: 30, color: P.orange })}
        <Frame flex="col" gap={2}>
          ${T('Alex · Table 42 · Siebel B1', { size: 19, color: P.white })}
          ${T('Soldering station shorted. +250 KP', { font: F.mono, size: 17, color: P.storm80 })}
        </Frame>
      </Frame>
      ${menu(['DISPATCH NEAREST', 'IGNORE'], 0, 240)}` })}
  </Frame>
</Frame>`);

/* ------------------------------------------------------------------ *
 * Page: Turf Wars — overworld strip + gym battle
 * ------------------------------------------------------------------ */

const overworld = () => {
  const w = W - 48, h = 250;
  const tiles = [];
  // Quad lawn with lit walks (pixel strips).
  const lawn = `<Frame position="absolute" top={0} left={0} w={${w}} h={${h}}>${dither(w, h, P.prairie, '#0B4D2A', 8)}</Frame>`;
  const walk = (x, y, ww, hh) => `<Frame position="absolute" top={${y}} left={${x}} w={${ww}} h={${hh}} bg="${P.storm80}" />`;
  tiles.push(lawn, walk(0, 118, w, 14), walk(560, 0, 14, h), walk(1040, 0, 14, h), walk(240, 40, 14, 90), walk(830, 140, 14, 110));
  // Trees along the walks.
  [40, 120, 200, 320, 400, 480, 640, 720, 800, 920, 1000, 1140, 1220, 1300, 1400, 1480].forEach((x, i) => {
    tiles.push(`<Frame position="absolute" top={${i % 2 ? 60 : 148}} left={${x}} w={48} h={60}>${sprite(ELM, 3)}</Frame>`);
  });
  tiles.push(`<Frame position="absolute" top={18} left={600} w={128} h={72}>${sprite(FOELLINGER, 4)}</Frame>`);
  tiles.push(`<Frame position="absolute" top={40} left={1080} w={136} h={84}>${sprite(ALTGELD, 4)}</Frame>`);
  tiles.push(`<Frame position="absolute" top={96} left={520} w={72} h={96}>${sprite(PLAYER, 3, 'You')}</Frame>`);
  tiles.push(`<Frame position="absolute" top={66} left={520} bg="${P.ink}" px={6} py={2}>${HUD('YOU', { size: 10 })}</Frame>`);
  tiles.push(`<Frame position="absolute" top={130} left={1000} w={72} h={96}>${sprite(RIVAL, 3, 'Rival')}</Frame>`);
  tiles.push(`<Frame position="absolute" top={100} left={1000} bg="${P.ink}" px={6} py={2}>${HUD('RIVAL · TENSOR', { size: 10, color: P.patina })}</Frame>`);
  // Lamps.
  [300, 700, 1200].forEach((x) => tiles.push(`<Frame position="absolute" top={104} left={${x}} w={6} h={30} bg="${P.storm}" /><Frame position="absolute" top={98} left={${x - 4}} w={14} h={10} bg="${P.harvest}" />`));
  return `<Frame w={${w}} h={${h}} bg="${P.prairie}" overflow="hidden">${tiles.join('')}</Frame>`;
};

const turf = () => screen('Turf Wars', 'TURF WARS', `
<Frame w="fill" grow={1} flex="col" gap={16} p={24}>
  ${win({ w: 'fill', title: 'OVERWORLD · MAIN QUAD', pad: 6, children: overworld() })}

  <Frame w="fill" grow={1} flex="row" gap={18}>
    <Frame grow={1} flex="col" gap={14}>
      <Frame w="fill" flex="row" justify="between" items="start">
        ${win({ w: 460, title: 'ENEMY GYM', children: `
          <Frame flex="row" justify="between" items="center">
            ${T('ALTGELD HALL', { font: F.head, size: 24, color: P.white })}
            ${T('Lv3', { font: F.mono, size: 22, color: P.harvest })}
          </Frame>
          ${T('HELD BY TEAM TENSOR · CHIME TOWER', { font: F.mono, size: 17, color: P.patina })}
          <Frame flex="row" gap={8} items="center">
            ${HUD('CP', { size: 11 })}
            ${hp(0.35, P.patina, 300)}
            ${T('690/2000', { font: F.mono, size: 18, color: P.storm80 })}
          </Frame>` })}
        <Frame w={140} h={90}>${sprite(ALTGELD, 4)}</Frame>
      </Frame>

      <Frame w="fill" flex="row" justify="between" items="end">
        <Frame w={100} h={130}>${sprite(PLAYER, 4)}</Frame>
        ${win({ w: 480, title: 'YOUR FACTION', children: `
          <Frame flex="row" justify="between" items="center">
            ${T('TEAM KERNEL', { font: F.head, size: 24, color: P.arches })}
            ${T('Lv5 · 5 held', { font: F.mono, size: 20, color: P.harvest })}
          </Frame>
          <Frame flex="row" gap={8} items="center">
            ${HUD('CP', { size: 11 })}
            ${hp(0.84, P.arches, 300)}
            ${T('1680/2000', { font: F.mono, size: 18, color: P.storm80 })}
          </Frame>
          <Frame flex="row" gap={8} items="center">
            ${HUD('EXP', { size: 11 })}
            ${bar(13, 20, P.harvest, 300, 8, 1)}
          </Frame>` })}
      </Frame>
    </Frame>

    <Frame w={380} flex="col" gap={14}>
      ${win({ w: 'fill', title: 'COMMAND', children: menu(['FIGHT  (−150 CP)', 'BAG', 'MAP · LOCATE', 'RUN'], 0, 320) })}
      ${win({ w: 'fill', title: 'CONTROL', children: `
        <Frame flex="row" gap={12} wrap>
          ${[['KERNEL', 5, P.arches], ['TENSOR', 4, P.patina], ['SILICON', 4, P.harvest], ['FREE', 1, P.storm60]].map(([n, c, col]) => `
          <Frame flex="col" gap={3} w={150}>
            <Frame flex="row" gap={8} items="center"><Frame w={12} h={12} bg="${col}" />${HUD(n, { color: col })}</Frame>
            ${T(c + ' gyms', { font: F.mono, size: 18, color: P.storm80 })}
          </Frame>`).join('')}
        </Frame>` })}
    </Frame>
  </Frame>

  ${message(['ALTGELD HALL rings its 15 bells! TEAM TENSOR braces.', 'What will TEAM KERNEL do?'])}
</Frame>`);

/* ------------------------------------------------------------------ *
 * Page: Bag & Bestiary
 * ------------------------------------------------------------------ */

const RARITY = { common: P.storm60, uncommon: P.leaf, rare: P.arches, epic: P.patina, legendary: P.harvest, mythic: P.orange };

const itemCell = (key, rarity, qty, sel = false) => `
<Frame w={92} h={92} bg="${sel ? P.harvest : RARITY[rarity]}" p={3}>
  <Frame w="fill" h="fill" bg="${P.ink}" p={2}>
    <Frame w="fill" h="fill" bg="${P.navy2}" flex="col" items="center" justify="between" pt={8} pb={2} px={4}>
      ${sprite(ITEMS[key], 4, key)}
      <Frame w="fill" flex="row" justify="end">${T('×' + qty, { font: F.mono, size: 15, color: P.white })}</Frame>
    </Frame>
  </Frame>
</Frame>`;

const bag = () => screen('Bag & Bestiary', 'BAG', `
<Frame w="fill" grow={1} flex="row" gap={22} p={24}>
  <Frame w={560} flex="col" gap={18}>
    ${win({ w: 'fill', title: 'BAG · MEMORABILIA', gap: 12, children: `
      <Frame flex="row" gap={10} wrap>
        ${itemCell('alma', 'legendary', 1, true)}${itemCell('mug', 'common', 3)}${itemCell('duck', 'rare', 1)}${itemCell('pennant', 'uncommon', 2)}
        ${itemCell('iron', 'epic', 1)}${itemCell('patch', 'mythic', 1)}${itemCell('badge', 'rare', 2)}${itemCell('blocki', 'legendary', 1)}
      </Frame>
      <Frame w="fill" h={2} bg="${P.storm}" />
      ${T('ALMA MATER PIN', { font: F.head, size: 22, color: P.harvest })}
      ${T('LEGENDARY · earned at Green & Wright, 03:41.', { font: F.mono, size: 17, color: P.storm80 })}
      ${T('"To thy happy children of the future…" +5% karma on Quad shifts.', { size: 19, w: 500 })}
      ${menu(['USE', 'EQUIP', 'DROP'], 0, 200)}` })}

    ${win({ w: 'fill', title: 'TRAINER CARD', children: `
      <Frame flex="row" gap={16} items="start">
        <Frame w={96} h={128} bg="${P.ink}" p={2}><Frame w="fill" h="fill" bg="${P.navy2}" flex="row" items="center" justify="center">${sprite(PLAYER, 3.5)}</Frame></Frame>
        <Frame flex="col" gap={6} w={380}>
          ${T('PRIYA K.', { font: F.head, size: 24, color: P.white })}
          ${T('HARDWARE HERO · TEAM KERNEL', { font: F.mono, size: 17, color: P.arches })}
          <Frame flex="row" gap={8} items="center">${HUD('LV 12', { size: 11 })}${bar(9, 12, P.harvest, 200, 10, 1)}</Frame>
          <Frame flex="row" gap={8} items="center">${HUD('KARMA', { size: 11 })}${T('4,820', { font: F.mono, size: 22, color: P.harvest })}</Frame>
          <Frame flex="row" gap={6}>${['badge', 'patch', 'duck'].map((k) => sprite(ITEMS[k], 2)).join('')}</Frame>
        </Frame>
      </Frame>` })}
  </Frame>

  <Frame grow={1} flex="col" gap={18}>
    ${win({ w: 'fill', title: 'BESTIARY · No.004', gap: 12, children: `
      <Frame flex="row" gap={24} items="start">
        <Frame w={272} h={176} bg="${P.ink}" p={3}><Frame w="fill" h="fill" bg="${P.navy2}" flex="row" items="center" justify="center">${sprite(ALTGELD, 7)}</Frame></Frame>
        <Frame flex="col" gap={8} w={600}>
          ${T('ALTGELD HALL', { font: F.head, size: 30, color: P.white })}
          ${T('Lv.3 CHIME TOWER · BUILT 1897', { font: F.mono, size: 19, color: P.harvest })}
          <Frame flex="row" gap={20}>
            <Frame flex="col" gap={3}>${HUD('TYPE')}${T('STONE / BELL', { font: F.mono, size: 19 })}</Frame>
            <Frame flex="col" gap={3}>${HUD('HELD BY')}${T('TENSOR', { font: F.mono, size: 19, color: P.patina })}</Frame>
            <Frame flex="col" gap={3}>${HUD('WEAK TO')}${T('SILICON', { font: F.mono, size: 19, color: P.harvest })}</Frame>
          </Frame>
          <Frame flex="row" gap={8} items="center">${HUD('CP', { size: 11 })}${hp(0.35, P.patina, 260)}${T('690', { font: F.mono, size: 18, color: P.storm80 })}</Frame>
        </Frame>
      </Frame>
      <Frame w="fill" h={2} bg="${P.storm}" />
      ${T('Its 132-foot tower holds 15 bells weighing 7.5 tons, rung by hand from a wooden', { size: 19 })}
      ${T('chimestand. Grey rusticated stone under a red tile spire. Home to the only', { size: 19 })}
      ${T('gargoyle on campus. Nathan Ricker & James McLaren White, Richardsonian Romanesque.', { size: 19 })}` })}

    <Frame flex="row" gap={14}>
      ${[['No.001', 'ALMA MATER', 'Lv.2'], ['No.002', 'ILLINI UNION', 'Lv.4'], ['No.003', 'FOELLINGER', 'Lv.4'], ['No.010', 'MEM. STADIUM', 'Lv.6']].map(([n, t, l]) => `
      <Frame w={222} bg="${P.storm80}" p={2} flex="col"><Frame w="fill" bg="${P.ink}" p={1} flex="col"><Frame w="fill" bg="${P.navy}" px={10} py={8} flex="col" gap={3}>
        ${HUD(n, { color: P.storm80 })}${T(t, { size: 18, color: P.white })}${T(l, { font: F.mono, size: 17, color: P.harvest })}
      </Frame></Frame></Frame>`).join('')}
    </Frame>

    ${message(['Bestiary 14/14 recorded. Capture ALTGELD HALL to claim its bells.'])}
  </Frame>
</Frame>`);

/* ------------------------------------------------------------------ *
 * Render one page per process
 * ------------------------------------------------------------------ */

const PAGES = { foundations, warroom, turf, bag };
const which = process.argv[2];
if (!PAGES[which]) {
  console.error(`usage: bun snes.mjs <${Object.keys(PAGES).join('|')}>`);
  process.exit(1);
}
const graph = new SceneGraph();
const page = graph.addPage(which);
await initCanvasKit();
const [root] = await renderJSX(graph, PAGES[which](), { parentId: page.id, x: 0, y: 0 });
if (root.warnings?.length) console.warn(root.warnings.join('\n'));
const png = await headlessRenderNodes(graph, page.id, [root.id], { scale: 1, format: 'png' });
const out = join(OUT, `${which}.png`);
writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(0)} KB, ${graph.nodes.size} nodes)`);
