/**
 * What one presence tick costs, in CPU and in event-loop blocking, at event scale.
 *
 * This is the in-process counterpart to `scripts/loadPresence.ts`. The soak measures the whole
 * system through real sockets and is the gate; this measures only the frame-building loop, with
 * no network and no database, and exists to answer one question quickly while changing it: did
 * that edit make the tick more expensive, and does the tick still get out of the event loop's
 * way?
 *
 * Two numbers matter and they are not the same number.
 *
 *   **CPU per tick** is the total work. It is what the load ladder in `PresenceService` judges,
 *   because it is what determines whether presence can keep up at all. A one-second cadence
 *   gives a budget of a thousand milliseconds; the first rung of the ladder trips at two
 *   hundred.
 *
 *   **The longest contiguous block** is what everything else in the process experiences. A tick
 *   that costs fifty milliseconds in one go adds fifty milliseconds to the tail of every HTTP
 *   request unlucky enough to arrive during it. Sliced, the same fifty milliseconds of work
 *   should never block for more than about the slice budget.
 *
 *   npx tsx scripts/benchmarks/presenceTick.ts [--sessions 5000] [--entries 5000] [--ticks 40]
 *                                              [--spread venues|scatter]
 */
import { PresenceStore, PresenceEntry } from '../../src/presence/store';
import { PresenceService } from '../../src/presence/service';
import { PresenceSession } from '../../src/presence/session';
import type { PresenceClient } from '../../src/presence/transport';
import type { AccountContext } from '../../src/common/types/account';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SESSIONS = Number(arg('sessions', '5000'));
const ENTRIES = Number(arg('entries', '5000'));
const TICKS = Number(arg('ticks', '40'));
const SPREAD = arg('spread', 'venues');

/**
 * Where everybody is standing.
 *
 * `venues` is the shape a hackathon actually has: nearly everyone inside one of a dozen
 * buildings, a few walking between them. `scatter` is the opposite and worse case, five
 * thousand people spread evenly over two and a half kilometres, where nothing can be shared
 * between viewers and the cost falls entirely on the block index.
 */
function positionOf(i: number, count: number): [number, number] {
  const golden = i * 2.399963; // the golden angle, which fills a disc without banding
  if (SPREAD === 'scatter') {
    const r = Math.sqrt(i / count) * 250;
    return [Math.cos(golden) * r, Math.sin(golden) * r];
  }
  if (i % 20 === 0) return [Math.cos(golden) * 110, Math.sin(golden) * 110];
  const v = i % 12;
  const a = (v / 12) * Math.PI * 2;
  const r = ((i * 37) % 40) / 10; // 0 to 4 units, i.e. up to 40 m inside the venue
  return [Math.cos(a) * 90 + Math.cos(golden) * r, Math.sin(a) * 90 + Math.sin(golden) * r];
}

const store = new PresenceStore();
const ids: string[] = [];
const now = Date.now();
for (let i = 0; i < ENTRIES; i++) {
  const id = `p${i}`;
  ids.push(id);
  const [x, z] = positionOf(i, ENTRIES);
  const e: PresenceEntry = {
    id, name: id, kind: 'VOLUNTEER', role: 'VOLUNTEER', faction: null, avatarHash: null, onDuty: true,
    x, z, lat: 0, lng: 0, acc: 5, h: 0, fx: x, fz: z, pendingFx: NaN, pendingFz: NaN,
    cell: '', t: now, version: 1, strikes: 0, muteUntil: 0, lastSampleT: now, optIn: true,
  };
  // Reaching past `update()` on purpose: it enforces a two-second minimum sample interval that
  // a setup loop cannot satisfy, and its gates are not what is being measured here.
  (store as unknown as { entries: Map<string, PresenceEntry> }).entries.set(id, e);
  (store as unknown as { reindex(e: PresenceEntry): void }).reindex(e);
}

const service = new PresenceService(store);
let framesSent = 0;
let bytesSent = 0;
for (let i = 0; i < SESSIONS; i++) {
  const account: AccountContext = {
    id: ids[i], role: 'VOLUNTEER', kind: 'VOLUNTEER', faction: null,
    displayName: ids[i], sessionVersion: 0, source: 'session',
  };
  const client: PresenceClient = {
    id: ids[i], account, transport: 'ws', binary: true,
    send: (m) => { framesSent++; bytesSent += JSON.stringify(m).length; return true; },
    sendBinary: (b) => { framesSent++; bytesSent += b.byteLength; return true; },
    bufferedBytes: () => 0,
    close: () => undefined,
  };
  const session = new PresenceSession(client, store, { snapshotEveryMs: 15_000, jsonDetailCap: 40 });
  Object.defineProperty(session, 'accountId', { get: () => ids[i] });
  (service as unknown as { sessions: Map<string, PresenceSession> }).sessions.set(client.id, session);
}

const cpu: number[] = [];
for (let t = 0; t < TICKS; t++) {
  for (const e of store.all()) { e.fx += 0.02; e.version += 1; } // everybody moves: the worst case
  const t0 = process.hrtime.bigint();
  service.tickNow();
  cpu.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
cpu.sort((a, b) => a - b);
const at = (q: number) => cpu[Math.min(cpu.length - 1, Math.floor(cpu.length * q))].toFixed(1);

/**
 * The blocking measurement, on the real sliced path.
 *
 * A timer fired every millisecond records how late it was. The largest lateness is the longest
 * the event loop was held by anything, which during this window is the tick. Sampling from a
 * timer rather than instrumenting the tick is deliberate: it measures what an unrelated request
 * would have felt, which is the thing that matters.
 */
async function measureBlocking(): Promise<number> {
  let worst = 0;
  let last = process.hrtime.bigint();
  const probe = setInterval(() => {
    const gap = Number(process.hrtime.bigint() - last) / 1e6;
    if (gap > worst) worst = gap;
    last = process.hrtime.bigint();
  }, 1);
  for (const e of store.all()) { e.fx += 0.02; e.version += 1; }
  (service as unknown as { tick(sync?: boolean): void }).tick(false);
  await new Promise((r) => setTimeout(r, 600));
  clearInterval(probe);
  return worst;
}

void (async () => {
  const worstBlock = await measureBlocking();
  const s = service.stats;
  console.log('');
  console.log(`  layout            ${SPREAD}`);
  console.log(`  sessions          ${SESSIONS}`);
  console.log(`  entries           ${ENTRIES}`);
  console.log(`  cohorts per tick  ${s.cohortsLastTick}  (shared passes; one per occupied cell per audience)`);
  console.log(`  rows per tick     ${s.rowsLastTick}`);
  console.log(`  bytes per tick    ${Math.round(bytesSent / TICKS / 1024)} KiB`);
  console.log(`  frames per tick   ${Math.round(framesSent / TICKS)}`);
  console.log('');
  console.log(`  CPU per tick      p50 ${at(0.5)} ms   p95 ${at(0.95)} ms   max ${at(1)} ms`);
  console.log(`  longest block     ${worstBlock.toFixed(1)} ms  (event-loop stall on the sliced path)`);
  console.log(`  ladder rung       ${s.rung}  (0 full, 1 reduced, 2 clusters only)`);
  console.log(`  skipped ticks     ${s.skippedTicks}`);
  console.log('');
  process.exit(0);
})();
