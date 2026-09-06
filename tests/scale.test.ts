/**
 * The five-thousand-attendee gate.
 *
 * These are not micro-benchmarks. They pin the two *structural* properties that make five
 * thousand concurrent clients affordable, so that a future change which quietly reintroduces
 * per-client work fails here rather than at three in the morning on the Quad:
 *
 *   1. The interest computation is shared by cell. The number of expensive passes per tick is
 *      bounded by the number of occupied cells and audiences, not by the number of clients.
 *   2. The dispatch query expands rings and stops, rather than scanning everyone. It must
 *      nevertheless agree exactly with the brute-force answer it replaced, because a faster
 *      search that sends the second-nearest responder is worse than the slow one.
 *
 * There is one wall-clock assertion, and it is deliberately loose. A shared CI runner cannot
 * be held to a 30 ms tick, and a tight timing assertion on a shared machine is a test that
 * fails for reasons nobody can act on. The real budget is measured by `scripts/loadPresence.ts`
 * against real sockets on the deployment host; this ceiling only catches a regression bad
 * enough to be visible through the noise — an accidental O(clients²), say.
 */
import { PresenceStore, PresenceEntry } from '../src/presence/store';
import { PresenceService } from '../src/presence/service';
import { PresenceSession } from '../src/presence/session';
import type { PresenceClient } from '../src/presence/transport';
import type { AccountContext, AccountRole } from '../src/common/types/account';
import { StreamLimits } from '../src/common/streamLimits';
import { pack } from '../src/content/loader';

/** A client that accepts everything and remembers nothing: the tick path is what is measured. */
function fakeClient(id: string, role: AccountRole = 'VOLUNTEER'): PresenceClient {
  const account: AccountContext = {
    id: `acct-${id}`, role, kind: 'VOLUNTEER', faction: null, displayName: id,
    sessionVersion: 0, source: 'session',
  };
  return {
    id,
    account,
    transport: 'ws',
    binary: true,
    send: () => true,
    sendBinary: () => true,
    bufferedBytes: () => 0,
    close: () => undefined,
  };
}

/**
 * Populate a store directly. `update()` would be the honest path, but it enforces a two-second
 * minimum sample interval that a synchronous loop cannot satisfy, and the gates it applies are
 * covered by presence.test.ts. What is under test here is the read side.
 */
function seedStore(store: PresenceStore, count: number, spreadUnits: number, onDuty = true): string[] {
  return place(store, count, onDuty, (i) => {
    // A deterministic spiral, so the population is uneven the way a campus is: dense in the
    // middle, thinning outward. A uniform grid would flatter the cell index.
    const t = i / count;
    const r = Math.sqrt(t) * spreadUnits;
    const a = i * 2.399963; // the golden angle, which fills a disc without banding
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
}

/**
 * The distribution an actual hackathon has: nearly everybody inside one of a dozen venues,
 * with a thin scatter of people walking between them.
 *
 * This matters because the two regimes stress different halves of the design. Clustered, the
 * cohort cache is what saves the tick; scattered, the block index is. A test that only ever
 * built one of them would let the other rot.
 */
function seedVenues(store: PresenceStore, count: number, venues = 12): string[] {
  // Venue centres on a ring 90 units (900 m) out, which is roughly the spread of the real
  // buildings this event runs in.
  const centres = Array.from({ length: venues }, (_, v) => {
    const a = (v / venues) * Math.PI * 2;
    return [Math.cos(a) * 90, Math.sin(a) * 90] as [number, number];
  });
  return place(store, count, true, (i) => {
    // One in twenty is outdoors between venues; the rest are inside one, within about 40 m.
    if (i % 20 === 0) {
      const a = i * 2.399963;
      return [Math.cos(a) * 110, Math.sin(a) * 110];
    }
    const [cxv, czv] = centres[i % venues];
    const a = i * 2.399963;
    const r = ((i * 37) % 40) / 10; // 0 to 4 units, i.e. 0 to 40 m
    return [cxv + Math.cos(a) * r, czv + Math.sin(a) * r];
  });
}

/**
 * Populate a store directly. `update()` would be the honest path, but it enforces a two-second
 * minimum sample interval that a synchronous loop cannot satisfy, and the gates it applies are
 * covered by presence.test.ts. What is under test here is the read side.
 */
function place(store: PresenceStore, count: number, onDuty: boolean, at: (i: number) => [number, number] | number[]): string[] {
  const ids: string[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const id = `p${i}`;
    ids.push(id);
    const [x, z] = at(i);
    const e: PresenceEntry = {
      id, name: id, kind: 'VOLUNTEER', role: 'VOLUNTEER', faction: null, avatarHash: null,
      onDuty,
      x, z, lat: 0, lng: 0, acc: 5, h: 0,
      fx: x, fz: z, pendingFx: NaN, pendingFz: NaN,
      cell: '', t: now, version: 1, strikes: 0, muteUntil: 0, lastSampleT: now, optIn: true,
    };
    (store as unknown as { entries: Map<string, PresenceEntry> }).entries.set(id, e);
    (store as unknown as { reindex(e: PresenceEntry): void }).reindex(e);
  }
  return ids;
}

/** Attach `watchers` fake sessions standing on the first `watchers` entries. */
function watch(service: PresenceService, store: PresenceStore, ids: string[], watchers: number): void {
  for (let i = 0; i < watchers; i++) {
    const client = fakeClient(ids[i]);
    const session = new PresenceSession(client, store, { snapshotEveryMs: 15_000, jsonDetailCap: 40 });
    // The session's account must be the entry it stands on, or it has no position and is
    // handed a null cohort.
    Object.defineProperty(session, 'accountId', { get: () => ids[i] });
    (service as unknown as { sessions: Map<string, PresenceSession> }).sessions.set(client.id, session);
  }
}

describe('the interest computation is shared, not repeated per client', () => {
  it('buckets every publishable entry exactly once', () => {
    const store = new PresenceStore();
    seedStore(store, 5000, 250);
    const index = store.buildIndex();
    let counted = 0;
    const seen = new Set<string>();
    for (const m of index.cells.values()) {
      counted += m.all.length;
      for (const e of m.all) seen.add(e.id);
    }
    expect(counted).toBe(5000);
    expect(seen.size).toBe(5000);
  });

  it('hides off-duty volunteers from the public view and shows them to a lead, in one pass', () => {
    const store = new PresenceStore();
    seedStore(store, 400, 40, false); // everyone off shift
    const index = store.buildIndex();
    let pub = 0, all = 0;
    for (const m of index.cells.values()) { pub += m.pub.length; all += m.all.length; }
    expect(all).toBe(400);
    expect(pub).toBe(0);
  });

  it('caps the detail list and ranks it nearest-first from the cell centre', () => {
    const store = new PresenceStore();
    seedStore(store, 3000, 120);
    const index = store.buildIndex();
    const cohort = store.cohort(store.cellKeyFor(0, 0), 300, false, 60, index);
    // One longer than the cap, so a viewer can drop itself without losing the last neighbour.
    expect(cohort.detail.length).toBeLessThanOrEqual(61);
    expect(cohort.detail.length).toBeGreaterThan(10);
    const s = pack.event.presence.cellMeters / pack.event.campus.metersPerUnit;
    const [cx, cz] = store.cellKeyFor(0, 0).split(':').map(Number);
    const centre = [(cx + 0.5) * s, (cz + 0.5) * s];
    const ds = cohort.detail.map((e) => Math.hypot(e.fx - centre[0], e.fz - centre[1]));
    expect([...ds].sort((a, b) => a - b)).toEqual(ds);
    // Nobody in the detail list is also counted as an anonymous cluster member.
    for (const [, , n] of cohort.clusters) expect(n).toBeGreaterThan(0);
  });

  it('collapses to one shared pass per venue when the crowd is clustered, as a real event is', () => {
    const store = new PresenceStore();
    const ids = seedVenues(store, 5000);
    const service = new PresenceService(store);
    // Two thousand of the five thousand are watching, which is the realistic shape: everybody
    // publishes, not everybody has the map open.
    watch(service, store, ids, 2000);

    const t0 = Date.now();
    service.tickNow();
    const elapsed = Date.now() - t0;

    const stats = service.stats;
    expect(stats.sessions).toBe(2000);
    expect(stats.cohortsLastTick).toBeGreaterThan(0);
    // The whole point of the cohort cache: the expensive pass runs per occupied cell, not per
    // client. A dozen venues plus stragglers is a couple of hundred cells against two thousand
    // watchers, so anything close to one-to-one means the sharing has been broken.
    expect(stats.cohortsLastTick).toBeLessThan(stats.sessions / 4);
    expect(elapsed).toBeLessThan(4000);
  });

  it('stays cheap in the opposite regime, where the crowd is spread thin over the whole pack', () => {
    // Five thousand people scattered over a 2.5 km disc is not a hackathon; it is the worst
    // case for the cohort cache, because almost everybody stands alone in their own cell and
    // nothing can be shared. What has to save the tick here is the block index: the interest
    // span is a hundred and sixty-nine cells wide and nearly all of them are empty, so the
    // scan must skip empty ground rather than walk it.
    const store = new PresenceStore();
    const ids = seedStore(store, 5000, 250);
    const service = new PresenceService(store);
    watch(service, store, ids, 2000);

    const t0 = Date.now();
    service.tickNow();
    const elapsed = Date.now() - t0;

    expect(service.stats.sessions).toBe(2000);
    // No sharing is available, and that is fine as long as each pass is cheap.
    expect(service.stats.cohortsLastTick).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(4000);
  });

});

describe('dispatch search expands rings and still finds the true nearest', () => {
  it('agrees with a brute-force scan over five thousand candidates', () => {
    const store = new PresenceStore();
    seedStore(store, 5000, 250);
    const now = Date.now();
    const at = { x: 12.5, z: -7.25 };

    const ring = store.nearestVolunteers(at.x, at.z, 60_000, now, 10);

    const brute = [...store.all()]
      .filter((e) => e.kind === 'VOLUNTEER' && e.onDuty && now - e.t <= 60_000)
      .map((e) => ({ id: e.id, d: Math.hypot(e.x - at.x, e.z - at.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 10);

    expect(ring.map((r) => r.e.id)).toEqual(brute.map((b) => b.id));
  });

  it('does not stop at the first full shell, which is how the diagonal beats the axis', () => {
    // The case the old rule got wrong, and the reason its own comment was not enough.
    //
    // Shells are squares; distance is a circle. Ten responders sitting in the far CORNERS of
    // a ring fill the quota there, but somebody on the near EDGE of a ring several shells
    // further out is still closer in metres — a corner of ring R is √2·R away while an edge
    // of ring R+3 is only R+3. Stopping one shell after the quota sent the second-nearest
    // volunteer to an emergency, and the existing brute-force test never caught it because
    // its uniform disc fills the quota in the first ring or two, where the mismatch is small.
    const store = new PresenceStore();
    const now = Date.now();
    const cell = 5; // 50 m at 10 m per unit
    const ids: string[] = [];
    const put = (id: string, x: number, z: number) => {
      ids.push(id);
      const e: PresenceEntry = {
        id, name: id, kind: 'VOLUNTEER', role: 'VOLUNTEER', faction: null, avatarHash: null, onDuty: true,
        x, z, lat: 0, lng: 0, acc: 5, h: 0, fx: x, fz: z, pendingFx: NaN, pendingFz: NaN,
        cell: '', t: now, version: 1, strikes: 0, muteUntil: 0, lastSampleT: now, optIn: true,
      };
      (store as unknown as { entries: Map<string, PresenceEntry> }).entries.set(id, e);
      (store as unknown as { reindex(e: PresenceEntry): void }).reindex(e);
    };

    // Ten in the diagonal corners of ring 8: about 56 cells away in a straight line.
    for (let i = 0; i < 10; i++) put(`corner${i}`, 8 * cell + i * 0.05, 8 * cell);
    // One on the cardinal axis of ring 10: further in rings, nearer in metres.
    put('axis', 10 * cell, 0);

    const found = store.nearestVolunteers(0, 0, 60_000, now, 10);
    const brute = [...store.all()]
      .map((e) => ({ id: e.id, d: Math.hypot(e.x, e.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 10);

    expect(found.map((f) => f.e.id)).toEqual(brute.map((b) => b.id));
    // And the axis candidate really is in the answer, which is the whole point.
    expect(found.some((f) => f.e.id === 'axis')).toBe(true);
  });

  it('agrees with brute force across two hundred random populations', () => {
    // The stopping rule is a geometry argument, and geometry arguments are exactly the kind
    // that read as correct and are not. Two hand-built cases prove the two failures already
    // found; this proves the rule itself, over populations nobody chose.
    //
    // A fixed seed rather than Math.random: a fuzz test that fails once and passes on the
    // rerun tells you nothing, and this one has to be able to name the population it
    // disagreed on.
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    let mismatches = 0;
    for (let trial = 0; trial < 200; trial++) {
      const store = new PresenceStore();
      const now = Date.now();
      const n = 1 + Math.floor(rnd() * 60);
      const spread = 5 + rnd() * 400;
      for (let i = 0; i < n; i++) {
        const x = (rnd() - 0.5) * 2 * spread;
        const z = (rnd() - 0.5) * 2 * spread;
        const e: PresenceEntry = {
          id: `v${i}`, name: `v${i}`, kind: 'VOLUNTEER', role: 'VOLUNTEER', faction: null,
          avatarHash: null, onDuty: true, x, z, lat: 0, lng: 0, acc: 5, h: 0, fx: x, fz: z,
          pendingFx: NaN, pendingFz: NaN, cell: '', t: now, version: 1, strikes: 0,
          muteUntil: 0, lastSampleT: now, optIn: true,
        };
        (store as unknown as { entries: Map<string, PresenceEntry> }).entries.set(e.id, e);
        (store as unknown as { reindex(e: PresenceEntry): void }).reindex(e);
      }
      const qx = (rnd() - 0.5) * 2 * spread;
      const qz = (rnd() - 0.5) * 2 * spread;
      const limit = 1 + Math.floor(rnd() * 12);
      const dOf = (id: string) => { const e = store.get(id)!; return Math.hypot(e.x - qx, e.z - qz); };

      const got = store.nearestVolunteers(qx, qz, 600_000, now, limit).map((r) => dOf(r.e.id).toFixed(6));
      // Compared by distance, not by id: two candidates at the same range are legitimately
      // either order, and asserting an order would be asserting an implementation detail.
      const want = [...store.all()]
        .map((e) => Math.hypot(e.x - qx, e.z - qz))
        .sort((a, b) => a - b)
        .slice(0, limit)
        .map((d) => d.toFixed(6));

      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches += 1;
    }
    expect(mismatches).toBe(0);
  });

  it('never considers somebody who opted out, even with a fresh fix', () => {
    // Opting out is a promise, and dispatch is the one place it is most tempting to break:
    // the entry is sitting right there with a live position on it. It is also the place where
    // breaking it does the most damage, because the person is then sent to a call at a
    // location they explicitly declined to share.
    //
    // Pinned as a test rather than left to the reading, because this guard was silently
    // reverted once already by a snapshot restored from before it landed.
    const store = new PresenceStore();
    const now = Date.now();
    const put = (id: string, x: number, optIn: boolean) => {
      const e: PresenceEntry = {
        id, name: id, kind: 'VOLUNTEER', role: 'VOLUNTEER', faction: null, avatarHash: null,
        onDuty: true, x, z: 0, lat: 0, lng: 0, acc: 5, h: 0, fx: x, fz: 0,
        pendingFx: NaN, pendingFz: NaN, cell: '', t: now, version: 1, strikes: 0,
        muteUntil: 0, lastSampleT: now, optIn,
      };
      (store as unknown as { entries: Map<string, PresenceEntry> }).entries.set(id, e);
      (store as unknown as { reindex(e: PresenceEntry): void }).reindex(e);
    };
    // The nearest by far, and opted out. The next nearest is ten times the distance.
    put('hidden', 1, false);
    put('willing', 10, true);

    const found = store.nearestVolunteers(0, 0, 60_000, now, 5);
    expect(found.map((f) => f.e.id)).toEqual(['willing']);
  });

  it('terminates on an almost empty campus rather than walking the plane', () => {
    const store = new PresenceStore();
    seedStore(store, 2, 5);
    const found = store.nearestVolunteers(400, 400, 60_000, Date.now(), 10);
    // Both are far outside any ring that would be reached quickly; the bound is what returns.
    expect(found.length).toBeLessThanOrEqual(2);
  });
});

describe('the stream table admits a five-thousand-person event', () => {
  it('seats five thousand accounts on two devices each', () => {
    const limits = new StreamLimits({ trustedCidrs: ['10.0.0.0/8'] });
    let admitted = 0;
    for (let i = 0; i < 5000; i++) {
      for (const transport of ['ws', 'sse'] as const) {
        const r = limits.tryAcquire({ transport, accountId: `a${i}`, ip: '10.1.2.3' });
        if (r.ok && !r.evict) admitted += 1;
      }
    }
    expect(admitted).toBe(10_000);
    expect(limits.stats().total).toBe(10_000);
    expect(limits.stats().totalSlots).toBeGreaterThanOrEqual(11_000);
  });

  it('still refuses an unauthenticated flood from one address', () => {
    const limits = new StreamLimits();
    let refused = 0;
    for (let i = 0; i < 100; i++) {
      const r = limits.tryAcquire({ transport: 'sse', ip: '198.51.100.7' });
      if (!r.ok) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
  });
});
