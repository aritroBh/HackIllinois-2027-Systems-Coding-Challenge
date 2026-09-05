/**
 * NEXUS OS — OpenPencil design build ("Illini Night").
 *
 * Generates design/nexus.fig plus per-page PNG references in design/exports/.
 *
 *   NODE_PATH=~/.bun/install/global/node_modules bun design/build.mjs
 */

import {
  SceneGraph, renderJSX, exportFigFile, initCanvasKit, headlessRenderNodes,
} from '@open-pencil/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C, F, S, R, FACTIONS, TYPE } from './tokens.mjs';
import {
  label, data, body, h1, h2, panel, head, signal, tag, segments, meter, ring, spark,
  button, factionMark, logRow,
} from './parts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'exports');
mkdirSync(OUT, { recursive: true });

const W = 1600;
const H = 1000;

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

/**
 * Header: a deep Illini-blue band. Wordmark left, live signal, then the three
 * operational numbers as real numbers (not pills), then two quiet controls.
 * The active tab is an underline, not a glowing box.
 */
const chrome = (active) => {
  const tabs = ['Shift Radar', 'Campus Grid', 'Turf Wars', 'Chaos Lab', 'Check-In', 'Leaderboard'];
  return `
<Frame name="Chrome" w="fill" flex="col" bg="${C.illiniBlue}">
  <Frame w="fill" h={64} flex="row" items="center" justify="between" px={${S[8]}}>
    <Frame flex="row" gap={${S[5]}} items="center">
      <Frame w={28} h={28} rounded={7} bg="${C.illiniOrange}" flex="row" items="center" justify="center">
        <Frame w={10} h={10} rounded={2} bg="${C.illiniBlue}" />
      </Frame>
      <Frame flex="col" gap={1}>
        <Text font="${F.display}" size={17} weight={600} letterSpacing={-0.2} color="${C.text}">Nexus OS</Text>
        <Text font="${F.mono}" size={10} weight={500} letterSpacing={0.6} color="#8FA3C8">HACKILLINOIS 2027 · VOLUNTEER OPERATIONS</Text>
      </Frame>
      <Frame w={1} h={26} bg="#2A4470" />
      ${signal('LIVE', C.live)}
    </Frame>

    <Frame flex="row" gap={${S[8]}} items="center">
      ${[['24', 'shifts'], ['31%', 'coverage'], ['9,294', 'karma']].map(([v, k]) => `
      <Frame flex="col" gap={2} items="end">
        <Text font="${F.mono}" size={18} weight={500} letterSpacing={-0.5} color="${C.text}">${v}</Text>
        <Text font="${F.mono}" size={10} weight={500} letterSpacing={0.6} color="#8FA3C8">${k.toUpperCase()}</Text>
      </Frame>`).join('')}
      <Frame w={1} h={26} bg="#2A4470" />
      ${button('Sync Adonix', { ghost: true, h: 32 })}
    </Frame>
  </Frame>

  <Frame w="fill" h={44} flex="row" gap={${S[1]}} items="end" px={${S[8]}} bg="${C.ground}" stroke="${C.hairline}" strokeWidth={1}>
    ${tabs.map((t) => t === active ? `
    <Frame flex="col" gap={0} px={14} h={44} justify="end">
      <Frame h={40} flex="row" items="center"><Text font="${F.display}" size={13} weight={600} color="${C.text}">${t}</Text></Frame>
      <Frame w="fill" h={2} bg="${C.illiniOrange}" />
    </Frame>` : `
    <Frame flex="col" px={14} h={44} justify="end">
      <Frame h={40} flex="row" items="center"><Text font="${F.display}" size={13} weight={500} color="${C.text3}">${t}</Text></Frame>
      <Frame w="fill" h={2} bg="#00000000" />
    </Frame>`).join('')}
  </Frame>
</Frame>`;
};

const screen = (name, active, content) => `
<Frame name="${name}" w={${W}} h={${H}} bg="${C.ground}" flex="col" overflow="hidden">
  ${chrome(active)}
  ${content}
</Frame>`;

const viewHead = (eyebrow, title, sub, right = '') => `
<Frame w="fill" flex="row" justify="between" items="end">
  <Frame flex="col" gap={6} w={720}>
    ${label(eyebrow)}
    ${h1(title)}
    ${body(sub, C.text2, 14)}
  </Frame>
  ${right}
</Frame>`;

/* ------------------------------------------------------------------ *
 * Shift card — the hero component
 * ------------------------------------------------------------------ */

/**
 * Time block on the left carries the scan: big start hour, small end. Title,
 * venue, then a segmented capacity meter (one cell per slot — real meaning,
 * not a percentage bar). Surge is an orange tag only when it applies.
 */
const shiftCard = ({ title, venue, start, end, filled, cap, surge, karma }) => {
  const full = filled >= cap;
  return `
<Frame w={372} h="hug" flex="row" gap={${S[4]}} p={${S[4]}} bg="${C.panel}" rounded={${R.lg}} stroke="${C.hairline}" strokeWidth={1}>
  <Frame w={64} flex="col" gap={2} pt={2}>
    <Text font="${F.mono}" size={22} weight={500} letterSpacing={-0.8} color="${C.text}">${start.split(' ')[0]}</Text>
    <Text font="${F.mono}" size={10} weight={500} letterSpacing={0.4} color="${C.text3}">${start.split(' ')[1]}</Text>
    <Frame w={20} h={1} bg="${C.hairlineHi}" />
    <Text font="${F.mono}" size={11} weight={500} color="${C.text3}">${end}</Text>
  </Frame>

  <Frame flex="col" gap={${S[3]}} grow={1}>
    <Frame w="fill" flex="row" justify="between" items="start" gap={8}>
      <Frame flex="col" gap={4} grow={1}>
        <Text font="${F.display}" size={15} weight={600} letterSpacing={-0.2} lineHeight={19} color="${C.text}">${title}</Text>
        <Frame flex="row" gap={6} items="center">
          <Frame w={8} h={8} rounded={2} stroke="${C.text3}" strokeWidth={1} />
          <Text font="${F.display}" size={12} weight={400} color="${C.text2}">${venue}</Text>
        </Frame>
      </Frame>
      ${surge ? `<Frame px={7} py={3} rounded={${R.xs}} bg="#FF5F0522"><Text font="${F.mono}" size={10} weight={600} letterSpacing={0.5} color="${C.illiniOrange}">×${surge}</Text></Frame>` : ''}
    </Frame>

    <Frame flex="col" gap={6}>
      ${segments(filled, cap, full ? C.danger : C.illiniOrange, 250)}
      <Frame w="fill" flex="row" justify="between">
        ${data(`${filled} of ${cap} filled`, C.text2, 11)}
        ${data(`${karma} karma`, C.text3, 11)}
      </Frame>
    </Frame>

    <Frame flex="row" gap={8} items="center">
      ${button(full ? 'Join waitlist' : 'Claim slot', { color: full ? C.raised : C.illiniOrange, ghost: full, h: 32 })}
      <Text font="${F.display}" size={12} weight={500} color="${C.text3}">Details</Text>
    </Frame>
  </Frame>
</Frame>`;
};

/* ------------------------------------------------------------------ *
 * 02 — War Room
 * ------------------------------------------------------------------ */

const podiumRow = (rank, name, tier, karma, max) => {
  const isTop = rank === 1;
  return `
<Frame w="fill" flex="row" items="center" gap={${S[3]}} py={7}>
  <Text font="${F.mono}" size={11} weight={600} color="${isTop ? C.illiniOrange : C.text3}" >${String(rank).padStart(2, '0')}</Text>
  <Frame flex="col" gap={3} w={150}>
    <Text font="${F.display}" size={13} weight={${isTop ? 600 : 500}} color="${C.text}">${name}</Text>
    ${label(tier, C.text4)}
  </Frame>
  <Frame grow={1} h={4} rounded={2} bg="${C.hairline}" overflow="hidden">
    <Frame position="absolute" top={0} left={0} w={${Math.round(140 * (karma / max))}} h={4} rounded={2} bg="${isTop ? C.illiniOrange : C.text3}" />
  </Frame>
  <Text font="${F.mono}" size={12} weight={500} color="${C.text}">${karma.toLocaleString()}</Text>
</Frame>`;
};

const warRoom = () => screen('War Room', 'Shift Radar', `
<Frame w="fill" grow={1} flex="row" gap={${S[6]}} p={${S[8]}}>
  <Frame flex="col" gap={${S[5]}} grow={1}>
    ${viewHead('LIVE SCHEDULE', 'Active shifts', 'Slots reserve under an atomic lock: fifty simultaneous claims still settle at exactly capacity.',
      `<Frame flex="row" gap={${S[2]}}>${tag('5 venues')}${tag('Sorted by start')}</Frame>`)}

    <Frame flex="row" gap={${S[3]}} wrap rowGap={${S[3]}}>
      ${shiftCard({ title: 'Registration Desk — Wave A', venue: 'Siebel Center Atrium', start: '08:00 AM', end: '12:00 PM', filled: 6, cap: 8, surge: null, karma: 120 })}
      ${shiftCard({ title: 'Overnight Hardware Support', venue: 'ECEB Second-Floor Labs', start: '12:00 AM', end: '04:00 AM', filled: 1, cap: 6, surge: '2.4', karma: 338 })}
      ${shiftCard({ title: 'Mentor Floor Sweep', venue: 'Kenney Gym Main Floor', start: '02:00 PM', end: '06:00 PM', filled: 5, cap: 5, surge: null, karma: 140 })}
      ${shiftCard({ title: 'Midnight Snack Runner', venue: 'DCL Loading Dock', start: '11:00 PM', end: '02:00 AM', filled: 3, cap: 4, surge: '1.8', karma: 213 })}
    </Frame>

    ${panel({ name: 'Telemetry', children: `
      ${head('EVENT STREAM', 'Dispatch telemetry', signal('3 CLIENTS', C.live))}
      <Frame w="fill" flex="col" gap={6} p={${S[3]}} bg="${C.inset}" rounded={${R.sm}}>
        ${logRow('04:58:12', 'CLAIM', 'v_8812 reserved a slot on s_0442 · lock 11ms', C.live)}
        ${logRow('04:58:09', 'SURGE', 's_0771 multiplier → ×2.4 (16% filled, t−4h)', C.illiniOrange)}
        ${logRow('04:57:51', 'SOS', 't_0031 dispatched → Priya K. · 42.7m · eta 1 min', C.danger)}
        ${logRow('04:57:20', 'SWAP', 'Tarjan cycle resolved v_11 → v_04 → v_27 → v_11', C.tensor)}
      </Frame>` })}
  </Frame>

  <Frame w={380} flex="col" gap={${S[4]}}>
    ${panel({ name: 'Vitals', children: `
      ${head('SYSTEM', 'Ops vitals')}
      <Frame flex="row" gap={${S[5]}} items="center">
        ${ring(0.31, '31', '%', 'COVERAGE')}
        <Frame flex="col" gap={${S[3]}} w={224}>
          <Frame w="fill" flex="row" justify="between" items="end">
            <Frame flex="col" gap={2}>${label('KARMA · 60 MIN')}<Text font="${F.mono}" size={20} weight={500} letterSpacing={-0.6} color="${C.text}">+1,240</Text></Frame>
            ${spark([0.2, 0.3, 0.25, 0.5, 0.45, 0.7, 0.6, 0.85, 0.8, 1.0], C.illiniOrange, 120, 32)}
          </Frame>
          <Frame w="fill" h={1} bg="${C.hairline}" />
          <Frame w="fill" flex="row" justify="between">
            <Frame flex="col" gap={2}>${label('OVERBOOKS')}${data('0', C.live, 16)}</Frame>
            <Frame flex="col" gap={2}>${label('WAITLISTED')}${data('64', C.text, 16)}</Frame>
            <Frame flex="col" gap={2}>${label('OPEN SOS')}${data('2', C.danger, 16)}</Frame>
          </Frame>
        </Frame>
      </Frame>` })}

    ${panel({ name: 'Leaders', children: `
      ${head('KARMA', 'Top volunteers')}
      <Frame w="fill" flex="col" gap={0}>
        ${podiumRow(1, 'Charlie Patel', 'LEVIATHAN · 32H', 3600, 3600)}
        ${podiumRow(2, 'Bob Martinez', 'KRAKEN · 18H', 2744, 3600)}
        ${podiumRow(3, 'Alice Chen', 'GUARDIAN · 10.5H', 1375, 3600)}
        ${podiumRow(4, 'Dana Scully', 'RIDER · 4H', 450, 3600)}
      </Frame>` })}

    ${panel({ name: 'Distress', children: `
      ${head('QUEUE', 'Open distress calls', button('Simulate', { ghost: true, h: 28 }))}
      <Frame w="fill" flex="col" gap={${S[2]}}>
        ${[['Alex — Hardware', 'Table 42 · Siebel Basement', 'HIGH', C.danger], ['Maya — Spill', 'Kenney bleachers', 'MEDIUM', C.warn]].map(([n, w, u, c]) => `
        <Frame w="fill" flex="row" gap={${S[3]}} items="center" p={${S[3]}} rounded={${R.sm}} bg="${C.raised}">
          <Ellipse w={8} h={8} bg="${c}" />
          <Frame flex="col" gap={2} grow={1}>
            <Text font="${F.display}" size={13} weight={600} color="${C.text}">${n}</Text>
            <Text font="${F.display}" size={12} weight={400} color="${C.text2}">${w}</Text>
          </Frame>
          ${label(u, c)}
          ${button('Dispatch', { ghost: true, h: 28 })}
        </Frame>`).join('')}
      </Frame>` })}
  </Frame>
</Frame>`);

/* ------------------------------------------------------------------ *
 * 03 — Turf Wars
 * ------------------------------------------------------------------ */

const gymRow = (f, { venue, cp, max, defenders, mine }) => `
<Frame w="fill" flex="row" gap={${S[4]}} items="center" p={${S[4]}} bg="${C.panel}" rounded={${R.md}} stroke="${C.hairline}" strokeWidth={1}>
  ${factionMark(f.color, 12)}
  <Frame flex="col" gap={3} w={240}>
    <Text font="${F.display}" size={15} weight={600} letterSpacing={-0.2} color="${C.text}">${venue}</Text>
    <Frame flex="row" gap={6} items="center">
      <Text font="${F.mono}" size={10} weight={600} letterSpacing={0.6} color="${f.color}">${f.name}</Text>
      <Text font="${F.mono}" size={10} weight={500} color="${C.text4}">·</Text>
      <Text font="${F.mono}" size={10} weight={500} color="${C.text3}">${defenders} defending</Text>
    </Frame>
  </Frame>
  <Frame flex="col" gap={5} grow={1}>
    ${meter(cp / max, f.color, 300)}
    <Frame w={300} flex="row" justify="between">
      ${data(`${cp.toLocaleString()} CP`, C.text, 11)}
      ${data(`${max.toLocaleString()}`, C.text4, 11)}
    </Frame>
  </Frame>
  ${mine ? button('Reinforce', { color: f.color, h: 32 }) : button('Contest', { ghost: true, h: 32 })}
</Frame>`;

const turfWars = () => screen('Turf Wars', 'Turf Wars', `
<Frame w="fill" grow={1} flex="row" gap={${S[6]}} p={${S[8]}}>
  <Frame flex="col" gap={${S[5]}} grow={1}>
    ${viewHead('POKÉSHIFT', 'Campus turf wars', 'Fourteen monuments are strongholds. Reinforce your own, contest the others.',
      `<Frame flex="row" gap={${S[2]}} items="center">${label('YOUR FACTION')}<Frame flex="row" gap={8} items="center" px={12} py={7} rounded={${R.sm}} stroke="${C.hairlineHi}" strokeWidth={1}>${factionMark(C.kernel)}<Text font="${F.display}" size={13} weight={600} color="${C.text}">Team Kernel</Text></Frame></Frame>`)}

    <Frame flex="row" gap={${S[6]}} items="center" px={${S[4]}} py={${S[3]}} bg="${C.panel}" rounded={${R.md}} stroke="${C.hairline}" strokeWidth={1}>
      ${[['KERNEL', C.kernel, 5, 8120], ['TENSOR', C.tensor, 4, 6380], ['SILICON', C.silicon, 3, 5250], ['UNCLAIMED', C.neutral, 2, 900]].map(([n, c, held, cp]) => `
      <Frame flex="row" gap={${S[3]}} items="center">
        ${factionMark(c)}
        <Frame flex="col" gap={2}>
          <Text font="${F.mono}" size={10} weight={600} letterSpacing={0.6} color="${C.text3}">${n}</Text>
          <Frame flex="row" gap={6} items="end">
            <Text font="${F.mono}" size={16} weight={500} letterSpacing={-0.4} color="${C.text}">${held}</Text>
            <Text font="${F.mono}" size={10} weight={500} color="${C.text4}">held · ${cp.toLocaleString()} CP</Text>
          </Frame>
        </Frame>
      </Frame>`).join('')}
    </Frame>

    <Frame flex="col" gap={${S[2]}} w="fill">
      ${gymRow(FACTIONS.TEAM_KERNEL, { venue: 'Siebel Center for CS', cp: 1680, max: 2000, defenders: 5, mine: true })}
      ${gymRow(FACTIONS.TEAM_TENSOR, { venue: 'Altgeld Hall', cp: 690, max: 2000, defenders: 3, mine: false })}
      ${gymRow(FACTIONS.TEAM_SILICON, { venue: 'Foellinger Auditorium', cp: 1120, max: 2000, defenders: 2, mine: false })}
      ${gymRow({ name: 'UNCLAIMED', color: C.neutral }, { venue: 'Alma Mater', cp: 500, max: 2500, defenders: 0, mine: true })}
      ${gymRow(FACTIONS.TEAM_SILICON, { venue: 'Memorial Stadium', cp: 1940, max: 2500, defenders: 4, mine: false })}
    </Frame>
  </Frame>

  <Frame w={380} flex="col" gap={${S[4]}}>
    ${panel({ name: 'Bag', children: `
      ${head('MY BAG', 'Power-ups', tag('3 items'))}
      <Frame flex="col" gap={${S[2]}}>
        ${[['Cold Brew Elixir', 'UNCOMMON', 2, C.live], ['Surge Amplifier', 'LEGENDARY', 1, C.illiniOrange]].map(([n, r, q, c]) => `
        <Frame w={340} flex="row" gap={${S[3]}} items="center" p={${S[3]}} rounded={${R.sm}} bg="${C.raised}">
          <Frame w={32} h={32} rounded={${R.xs}} bg="${C.inset}" flex="row" items="center" justify="center"><Frame w={10} h={10} rounded={2} bg="${c}" /></Frame>
          <Frame flex="col" gap={2} grow={1}>
            <Text font="${F.display}" size={13} weight={600} color="${C.text}">${n}</Text>
            ${label(r, c)}
          </Frame>
          ${data(`×${q}`, C.text2, 12)}
          ${button('Deploy', { ghost: true, h: 28 })}
        </Frame>`).join('')}
      </Frame>` })}

    ${panel({ name: 'Beacons', children: `
      ${head('BEACONS', 'HackStops nearby', tag('75 m'))}
      <Frame flex="col" gap={${S[2]}}>
        ${[['Alma Mater Reliquary', 'Green & Wright', '24 m'], ['Altgeld Chime Resonator', 'Altgeld steps', '61 m'], ['Stadium Tunnel Locker', 'Gate 4', '540 m']].map(([n, w, d], i) => `
        <Frame w={340} flex="row" gap={${S[3]}} items="center" py={${S[2]}}>
          <Frame flex="col" gap={2} grow={1}>
            <Text font="${F.display}" size={13} weight={500} color="${C.text}">${n}</Text>
            <Text font="${F.display}" size={12} weight={400} color="${C.text3}">${w}</Text>
          </Frame>
          ${data(d, i < 2 ? C.live : C.text4, 11)}
          ${button('Spin', { ghost: i >= 2, h: 28, color: C.illiniOrange })}
        </Frame>`).join('')}
      </Frame>` })}
  </Frame>
</Frame>`);

/* ------------------------------------------------------------------ *
 * 01 — Foundations
 * ------------------------------------------------------------------ */

const swatch = (hex, name) => `
<Frame flex="col" gap={6} w={116}>
  <Frame w={116} h={56} rounded={${R.md}} bg="${hex}" stroke="${C.hairline}" strokeWidth={1} />
  <Text font="${F.mono}" size={10} weight={600} color="${C.text2}">${name}</Text>
  <Text font="${F.mono}" size={10} weight={400} color="${C.text4}">${hex}</Text>
</Frame>`;

const foundations = () => `
<Frame name="Foundations" w={${W}} h={1100} bg="${C.ground}" flex="col" gap={${S[10]}} p={${S[12]}}>
  <Frame flex="col" gap={${S[2]}} w={900}>
    <Text font="${F.display}" size={40} weight={600} letterSpacing={-1.2} lineHeight={44} color="${C.text}">Illini Night</Text>
    ${body('The visual system for the HackIllinois volunteer operations console. Navy tinted toward Illini Blue, one warm accent, type that does the hierarchy, and motion only where state changes.', C.text2, 15)}
  </Frame>

  <Frame flex="col" gap={${S[4]}}>
    ${label('GROUND · 60%')}
    <Frame flex="row" gap={${S[3]}}>${swatch(C.ground, 'ground')}${swatch(C.panel, 'panel')}${swatch(C.raised, 'raised')}${swatch(C.inset, 'inset')}${swatch(C.hairline, 'hairline')}${swatch(C.illiniBlue, 'illini blue')}</Frame>
  </Frame>

  <Frame flex="col" gap={${S[4]}}>
    ${label('ACCENT · 10% — AND SEMANTIC, FACTION')}
    <Frame flex="row" gap={${S[3]}}>${swatch(C.illiniOrange, 'illini orange')}${swatch(C.live, 'live')}${swatch(C.danger, 'danger')}${swatch(C.warn, 'warn')}${swatch(C.kernel, 'kernel')}${swatch(C.tensor, 'tensor')}${swatch(C.silicon, 'silicon')}</Frame>
  </Frame>

  <Frame flex="col" gap={${S[3]}}>
    ${label('TYPE — BRICOLAGE GROTESQUE · IBM PLEX MONO')}
    ${TYPE.map((t) => `
    <Frame flex="row" gap={${S[6]}} items="center">
      <Frame w={110}>${label(t.name, C.text4)}</Frame>
      <Frame w={90}>${data(`${t.size}/${t.weight}`, C.text4, 10)}</Frame>
      <Text font="${t.font}" size={${t.size}} weight={${t.weight}} letterSpacing={${t.ls}} color="${C.text}">Dispatch the nearest volunteer to Altgeld Hall</Text>
    </Frame>`).join('')}
  </Frame>

  <Frame flex="col" gap={${S[4]}}>
    ${label('COMPONENTS')}
    <Frame flex="row" gap={${S[5]}} items="center" wrap>
      ${button('Claim slot')}${button('Contest', { ghost: true })}${button('Dispatch', { color: C.danger })}
      ${tag('5 venues')}${signal('LIVE')}${segments(5, 8, C.illiniOrange, 180)}${meter(0.62, C.kernel, 180)}${ring(0.31, '31', '%', 'COVERAGE')}${spark([0.2, 0.4, 0.3, 0.7, 0.6, 0.9, 1.0])}
    </Frame>
  </Frame>
</Frame>`;

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

export { chrome, shiftCard, warRoom, turfWars, foundations, podiumRow, gymRow, viewHead };

if (import.meta.main) {
const PAGES = [
  { page: '02 · War Room', jsx: warRoom, file: '02-war-room' },
  { page: '03 · Turf Wars', jsx: turfWars, file: '03-turf-wars' },
  { page: '01 · Foundations', jsx: foundations, file: '01-foundations' },
];

/**
 * Each PNG renders in its own process. Rasterising one page leaves the
 * opentype.js shaper in a state where the next page's layout trips an
 * unsupported GSUB lookup — the pages are fine individually and in any order,
 * it is only raster-then-layout in one process that fails. Isolating them is
 * simpler and more honest than working around the shaper.
 */
const only = process.argv.indexOf('--page');
if (only !== -1) {
  const target = PAGES.find((x) => x.file === process.argv[only + 1]);
  if (!target) throw new Error(`unknown page ${process.argv[only + 1]}`);
  await initCanvasKit();
  const g = new SceneGraph();
  const pg = g.addPage(target.page);
  const [root] = await renderJSX(g, target.jsx(), { parentId: pg.id, x: 0, y: 0 });
  if (root.warnings?.length) console.warn(`${target.file}: ${root.warnings.join('; ')}`);
  const png = await headlessRenderNodes(g, pg.id, [root.id], { scale: 1, format: 'png' });
  writeFileSync(join(OUT, `${target.file}.png`), png);
  console.log(`rendered ${target.file}.png  (${(png.length / 1024).toFixed(0)} KB)`);
} else {
  for (const { file } of PAGES) {
    const r = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url), '--page', file], {
      env: process.env, stdout: 'inherit', stderr: 'inherit',
    });
    if (r.exitCode !== 0) process.exit(r.exitCode);
  }

  // The .fig carries all pages in one document; layout only, no raster.
  const graph = new SceneGraph();
  let firstPageId = null;
  for (const { page, jsx } of PAGES) {
    const pg = graph.addPage(page);
    firstPageId ??= pg.id;
    await renderJSX(graph, jsx(), { parentId: pg.id, x: 0, y: 0 });
  }
  const ck = await initCanvasKit();
  const fig = await exportFigFile(graph, ck, undefined, firstPageId, false);
  writeFileSync(join(HERE, 'nexus.fig'), fig);
  console.log(`wrote design/nexus.fig  (${(fig.length / 1024).toFixed(0)} KB)`);
}
}
