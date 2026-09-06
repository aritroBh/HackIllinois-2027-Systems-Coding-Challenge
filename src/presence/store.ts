/**
 * Presence store (plan §A4): an in-process spatial hash of everyone who has opted in.
 *
 * Entries live in memory only — positions are never persisted. A 50 m cell grid answers
 * "who is near (x, z)?" for interest management and for SOS dispatch (ring expansion).
 * Every accepted sample passes the gates in order: opt-in → pack bbox → accuracy → rate →
 * speed (three consecutive violations mute the sender for 60 s, in `presenceMutes`).
 * Published positions are fuzzed (20 m grid snap + per-hour stable jitter ±8 m) and lag one
 * tick behind the accepted sample; exact positions exist only for lead+ reads and dispatch,
 * both audited by the callers.
 */
import crypto from 'crypto';
import { pack, toLocal, inBbox } from '../content/loader';
import { PresenceMute } from '../models/presenceMute.model';

export type PresenceKind = 'VOLUNTEER' | 'HACKER';

export interface PresenceEntry {
  id: string;
  name: string;
  kind: PresenceKind;
  role: string;
  faction: string | null;
  avatarHash: string | null;
  onDuty: boolean;
  /** Exact position (world units) and the raw fix. */
  x: number;
  z: number;
  lat: number;
  lng: number;
  acc: number;
  h: number;
  /** Fuzzed, published position (lags one tick). */
  fx: number;
  fz: number;
  pendingFx: number;
  pendingFz: number;
  cell: string;
  /** Last accepted sample (ms). */
  t: number;
  /** Bumps on every accepted sample; clients track what they have sent. */
  version: number;
  strikes: number;
  muteUntil: number;
  lastSampleT: number;
  /** Mirrors the account's `presenceOptIn`; false means the entry is on its way out. */
  optIn: boolean;
}

export interface Sample {
  lat: number;
  lng: number;
  acc: number;
  h?: number;
  spd?: number;
}

export type UpdateResult =
  | { ok: true; entry: PresenceEntry }
  | { ok: false; reason: 'OPT_OUT' | 'OFF_CAMPUS' | 'INACCURATE' | 'TOO_FAST' | 'MUTED' | 'RATE' | 'SPEED_STRIKE' };

/**
 * Everyone visible, bucketed by published cell, computed once per tick.
 *
 * Without this, every connected client independently walked the same cells, dereferenced the
 * same entries out of the id map and re-ran the same visibility test. That is fine at a
 * hundred clients and quadratic-feeling at five thousand: the work is proportional to
 * clients × neighbours, and on a dense Quad both factors are large at once.
 *
 * `all` is what a lead may see; `pub` is the subset an ordinary player may see, which differs
 * only by off-duty volunteers. Both are plain arrays because they are built once and then
 * only iterated.
 */
export interface CellMembers {
  all: PresenceEntry[];
  pub: PresenceEntry[];
  /**
   * The cell's own integer coordinates and key, carried on the bucket rather than recovered
   * from the key each time it is read.
   *
   * The scan used to split the key string and coerce both halves to numbers once per cell per
   * cohort. On a thinly spread campus that is hundreds of thousands of throwaway arrays and
   * strings a second, spent re-deriving two integers that were known when the bucket was made.
   */
  ci: number;
  cj: number;
  key: string;
}

export interface TickIndex {
  cells: Map<string, CellMembers>;
  /**
   * A coarse occupancy index over the fine cells: block key → the occupied fine cells in it.
   *
   * Scanning the interest span cell by cell costs the same whether the ground is crowded or
   * empty — a 300 m radius over 50 m cells is a hundred and sixty-nine lookups either way.
   * On a campus where most of the map is car parks and farmland at three in the morning,
   * nearly all of those lookups find nothing, and they are paid once per occupied cell per
   * tick. The block index turns the empty case into a handful of lookups by asking a coarser
   * question first: which blocks have anybody in them at all.
   *
   * The block is eight fine cells (400 m) square. Smaller and the block map is nearly as
   * large as the cell map; larger and a block stops discriminating, because the interest
   * span is only 650 m across.
   */
  blocks: Map<string, CellMembers[]>;
  /** Cell size in world units, so a consumer need not re-derive it from the config. */
  cellUnits: number;
  builtAt: number;
}

/** Fine cells per block edge. See the note on `TickIndex.blocks` for why eight. */
const BLOCK_CELLS = 8;

/**
 * What one *cell* of viewers is shown — not one viewer.
 *
 * The interest span is `floor(x / cell)` ± span, so every client standing in the same 50 m
 * cell scans exactly the same cells and sees exactly the same candidates. Computing that
 * once per occupied cell instead of once per client is the whole scaling argument: five
 * thousand clients on a campus occupy a few hundred cells, so the shared work shrinks by
 * more than an order of magnitude and the per-client work drops to reading a list.
 *
 * The price is that `detail` is ranked from the cell *centre* rather than from each viewer's
 * exact position. Two viewers 50 m apart therefore agree on who is interesting even though
 * one of them is marginally closer to somebody at the edge of the ring. At a 300 m radius
 * with a 60-player cut that reorders the tail of the list and changes nothing a player can
 * perceive, which is a good trade for the cost it removes.
 */
export interface Cohort {
  /** Nearest-first from the cell centre, one longer than the cap so a viewer can drop itself. */
  detail: PresenceEntry[];
  detailIds: Set<string>;
  /** [cellOriginX, cellOriginZ, count] for cells whose members are not already in `detail`. */
  clusters: Array<[number, number, number]>;
  /**
   * The same counts with nobody excluded — what a viewer sees when it is being sent no rows.
   *
   * `clusters` deliberately omits the people who are arriving as individual rows, so that a
   * player is not drawn twice. On the bottom rung of the load ladder nobody is sent as a row,
   * and the same exclusion then removed the nearest sixty people from the counts as well: a
   * room with forty people in it reported zero. The map emptied at exactly the moment it was
   * fullest, which is the opposite of what a degradation mode is for.
   */
  clustersAll: Array<[number, number, number]>;
  ownClusterIndexAll: number;
  /** The cell these were computed for, so a session can adjust its own count. */
  cellKey: string;
  /**
   * Where `cellKey`'s own triple sits in `clusters`, or -1.
   *
   * A viewer has to subtract itself from the count for the cell it is standing in, and the
   * cohort cannot do that for it because a cohort serves everybody in the cell at once.
   * Finding that triple by rebuilding cell keys and searching cost a template string per
   * cluster per session, which at five thousand sessions was a quarter of a million string
   * allocations a second, entirely to answer a question the cohort already knew the answer to.
   */
  ownClusterIndex: number;
  /**
   * A cheap order-sensitive checksum of `clusters`.
   *
   * Cluster counts are sent only when they change, and every session in a cohort is looking at
   * the same array, so "has it changed" is one number compared against one number rather than
   * a per-session map of cell keys rebuilt every tick. Collisions would cost a missed update
   * for one tick, not a wrong position: the next change re-sends, and a snapshot every fifteen
   * seconds resets the comparison outright.
   */
  sig: number;
}

export interface StoreConfig {
  metersPerUnit: number;
  cellMeters: number;
  maxAccuracyMeters: number;
  maxSpeedMps: number;
  fuzzGridMeters: number;
  interestRadiusMeters: number;
  maxDetail: number;
  minSampleIntervalMs: number;
  staleAfterMs: number;
  expireAfterMs: number;
  muteMs: number;
}

export const DEFAULT_CONFIG: StoreConfig = {
  metersPerUnit: pack.event.campus.metersPerUnit,
  cellMeters: pack.event.presence.cellMeters,
  maxAccuracyMeters: pack.event.presence.maxAccuracyMeters,
  maxSpeedMps: pack.event.presence.maxSpeedMps,
  fuzzGridMeters: pack.event.presence.fuzzGridMeters,
  interestRadiusMeters: pack.event.presence.interestRadiusMeters,
  maxDetail: pack.event.presence.maxDetail,
  minSampleIntervalMs: 2000,
  staleAfterMs: 30_000,
  expireAfterMs: 120_000,
  muteMs: 60_000,
};

function jitterFor(id: string, hourIndex: number): [number, number] {
  const h = crypto.createHash('sha256').update(`${id}:${hourIndex}`).digest();
  return [((h[0] / 255) * 2 - 1) * 8, ((h[1] / 255) * 2 - 1) * 8]; // metres, ±8
}

export class PresenceStore {
  private entries = new Map<string, PresenceEntry>();
  private cells = new Map<string, Set<string>>();
  /**
   * accountId → mute expiry, held separately from the entry.
   *
   * A mute used to live only on the entry, and `remove()` deletes the entry when the last
   * socket for an account closes. So the speed gate's sixty-second mute was escapable by
   * reconnecting: drop the socket, come back, and the entry is rebuilt with no mute on it.
   * The database row survived, but the service's sweep of it runs on a timer, so there was a
   * window in which a muted account was simply not muted — and the whole point of a mute is
   * that it applies to somebody who is deliberately misbehaving and will notice.
   *
   * This map outlives entries. It is still only a cache of `presenceMutes`, which is the
   * durable record across a restart, but it is the one the gate consults.
   */
  private mutes = new Map<string, number>();
  public readonly cfg: StoreConfig;
  /** ms since epoch of the last tick that promoted pending positions. */
  public lastTickAt = 0;

  constructor(cfg: Partial<StoreConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  private cellOf(x: number, z: number): string {
    const s = this.cfg.cellMeters / this.cfg.metersPerUnit;
    return `${Math.floor(x / s)}:${Math.floor(z / s)}`;
  }

  private fuzz(id: string, x: number, z: number, nowMs: number): [number, number] {
    const g = this.cfg.fuzzGridMeters / this.cfg.metersPerUnit;
    const [jx, jz] = jitterFor(id, Math.floor(nowMs / 3_600_000));
    return [Math.round(x / g) * g + jx / this.cfg.metersPerUnit, Math.round(z / g) * g + jz / this.cfg.metersPerUnit];
  }

  size(): number {
    return this.entries.size;
  }

  get(id: string): PresenceEntry | undefined {
    return this.entries.get(id);
  }

  all(): IterableIterator<PresenceEntry> {
    return this.entries.values();
  }

  /** Remember a mute read back from the collection (reconnect path, and the service's sweep). */
  applyMute(id: string, until: number): void {
    const e = this.entries.get(id);
    if (e) e.muteUntil = until;
    if (until > Date.now()) this.mutes.set(id, until);
    else this.mutes.delete(id);
  }

  isMuted(id: string, nowMs: number = Date.now()): boolean {
    const held = this.mutes.get(id);
    if (held !== undefined) {
      if (held > nowMs) return true;
      this.mutes.delete(id);
    }
    const e = this.entries.get(id);
    return !!e && e.muteUntil > nowMs;
  }

  /**
   * Accept or reject one sample. `who` carries the account facts the transport verified.
   * Gates (in order): opt-in, bbox, accuracy (dropped, never a strike), rate, mute, speed.
   */
  update(
    who: { id: string; name: string; kind: PresenceKind; role: string; faction: string | null; avatarHash: string | null; optIn: boolean; onDuty: boolean; muteUntil?: number },
    s: Sample,
    nowMs: number = Date.now()
  ): UpdateResult {
    if (!who.optIn) {
      // Symmetric opt-out at the source: an entry left behind by an earlier sample would
      // keep being broadcast until it expired, so the refusal also erases it.
      this.remove(who.id);
      return { ok: false, reason: 'OPT_OUT' };
    }
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng) || !inBbox(s.lat, s.lng)) return { ok: false, reason: 'OFF_CAMPUS' };
    if (!Number.isFinite(s.acc) || s.acc > this.cfg.maxAccuracyMeters) return { ok: false, reason: 'INACCURATE' };

    const { x, z } = toLocal(s.lat, s.lng);
    let e = this.entries.get(who.id);
    // Three sources, and the longest wins: the live entry, the caller's facts (which carry the
    // service's swept copy of the collection), and this store's own map — which is the one
    // that survives a disconnect and therefore the one that makes a mute mean anything.
    const muteUntil = Math.max(e?.muteUntil ?? 0, who.muteUntil ?? 0, this.mutes.get(who.id) ?? 0);
    if (muteUntil > nowMs) return { ok: false, reason: 'MUTED' };

    if (e) {
      if (nowMs - e.lastSampleT < this.cfg.minSampleIntervalMs) return { ok: false, reason: 'RATE' };
      const dtS = Math.max(0.001, (nowMs - e.lastSampleT) / 1000);
      const distM = Math.hypot(x - e.x, z - e.z) * this.cfg.metersPerUnit;
      if (distM / dtS > this.cfg.maxSpeedMps) {
        e.strikes += 1;
        e.lastSampleT = nowMs;
        if (e.strikes >= 3) {
          e.strikes = 0;
          e.muteUntil = nowMs + this.cfg.muteMs;
          // Into the surviving map first, then the collection. The write is fire-and-forget
          // because a mute that depends on a database round trip is a mute that does not
          // apply to the next sample.
          this.mutes.set(who.id, e.muteUntil);
          void PresenceMute.updateOne({ accountId: who.id }, { $set: { until: new Date(e.muteUntil), reason: 'SPEED' } }, { upsert: true }).catch(() => undefined);
          return { ok: false, reason: 'SPEED_STRIKE' };
        }
        return { ok: false, reason: 'TOO_FAST' };
      }
      e.strikes = 0;
    } else {
      e = {
        id: who.id, name: who.name, kind: who.kind, role: who.role, faction: who.faction, avatarHash: who.avatarHash, onDuty: who.onDuty,
        x, z, lat: s.lat, lng: s.lng, acc: s.acc, h: 0, fx: NaN, fz: NaN, pendingFx: NaN, pendingFz: NaN, cell: '', t: nowMs, version: 0, strikes: 0,
        muteUntil, lastSampleT: nowMs, optIn: true,
      };
      this.entries.set(who.id, e);
    }
    const heading = Number.isFinite(s.h as number) ? (s.h as number) : Math.hypot(x - e.x, z - e.z) > 1e-4 ? (Math.atan2(x - e.x, -(z - e.z)) * 180) / Math.PI : e.h;
    e.x = x; e.z = z; e.lat = s.lat; e.lng = s.lng; e.acc = s.acc; e.h = ((heading % 360) + 360) % 360;
    e.t = nowMs; e.lastSampleT = nowMs; e.onDuty = who.onDuty; e.faction = who.faction; e.avatarHash = who.avatarHash; e.name = who.name; e.role = who.role;
    const [fx, fz] = this.fuzz(who.id, x, z, nowMs);
    e.pendingFx = fx; e.pendingFz = fz;
    // First sample: publish immediately so a newcomer is not invisible for a tick.
    if (Number.isNaN(e.fx)) { e.fx = fx; e.fz = fz; e.version += 1; this.reindex(e); }
    return { ok: true, entry: e };
  }

  private reindex(e: PresenceEntry): void {
    const cell = this.cellOf(e.fx, e.fz);
    if (cell === e.cell) return;
    if (e.cell) this.cells.get(e.cell)?.delete(e.id);
    e.cell = cell;
    let set = this.cells.get(cell);
    if (!set) { set = new Set(); this.cells.set(cell, set); }
    set.add(e.id);
  }

  remove(id: string): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    this.cells.get(e.cell)?.delete(id);
    this.entries.delete(id);
    return true;
  }

  /**
   * Tick: promote pending (one-tick-late) positions, bump versions for movers, and expire
   * entries silent for `expireAfterMs`. Returns the ids removed.
   */
  tick(nowMs: number = Date.now()): { moved: number; expired: string[] } {
    let moved = 0;
    const expired: string[] = [];
    for (const e of this.entries.values()) {
      if (nowMs - e.t > this.cfg.expireAfterMs) { expired.push(e.id); continue; }
      if (!Number.isNaN(e.pendingFx) && (e.pendingFx !== e.fx || e.pendingFz !== e.fz)) {
        e.fx = e.pendingFx; e.fz = e.pendingFz; e.version += 1; moved += 1;
        this.reindex(e);
      }
    }
    for (const id of expired) this.remove(id);
    this.lastTickAt = nowMs;
    return { moved, expired };
  }

  isStale(e: PresenceEntry, nowMs: number): boolean {
    return nowMs - e.t > this.cfg.staleAfterMs;
  }

  /** Visible to ordinary viewers: opted-in (they are here), on campus, and not an off-shift volunteer. */
  visible(e: PresenceEntry, viewerIsLead = false): boolean {
    if (!e.optIn) return false;
    // Whether someone is hidden depends on the VIEWER's role, never on the subject's: an
    // off-duty lead is off duty like anyone else, and used to stay on every player's map.
    if (e.kind === 'VOLUNTEER' && !e.onDuty && !viewerIsLead) return false;
    return !Number.isNaN(e.fx);
  }

  /**
   * Bucket every publishable entry by its cell. One pass over the store per tick.
   *
   * Entries with no published position yet are skipped rather than represented as absent,
   * because a NaN coordinate would poison a distance comparison rather than sort last.
   */
  buildIndex(nowMs: number = Date.now()): TickIndex {
    const cells = new Map<string, CellMembers>();
    const blocks = new Map<string, CellMembers[]>();
    for (const e of this.entries.values()) {
      if (!e.optIn || Number.isNaN(e.fx)) continue;
      let m = cells.get(e.cell);
      if (!m) {
        const sep = e.cell.indexOf(':');
        const ci = Number(e.cell.slice(0, sep));
        const cj = Number(e.cell.slice(sep + 1));
        m = { all: [], pub: [], ci, cj, key: e.cell };
        cells.set(e.cell, m);
        // A cell joins its block the first time anybody stands in it, so the block lists stay
        // free of the empty cells the whole index exists to skip.
        const bk = `${Math.floor(ci / BLOCK_CELLS)}:${Math.floor(cj / BLOCK_CELLS)}`;
        const list = blocks.get(bk);
        if (list) list.push(m);
        else blocks.set(bk, [m]);
      }
      m.all.push(e);
      // The one asymmetry between the two views: an off-shift volunteer is hidden from
      // players and visible to leads. Deciding it here means the per-viewer path never has
      // to ask again.
      if (e.kind !== 'VOLUNTEER' || e.onDuty) m.pub.push(e);
    }
    return { cells, blocks, cellUnits: this.cfg.cellMeters / this.cfg.metersPerUnit, builtAt: nowMs };
  }

  /**
   * The shared view for everyone standing in `cellKey`.
   *
   * `maxDetail` candidates are selected by insertion into a small sorted array rather than by
   * sorting the whole candidate list. On the Quad the candidate list can run to several
   * hundred and the cut is sixty, so a full sort spends most of its comparisons ordering
   * people nobody will be told about.
   */
  cohort(cellKey: string, radiusM: number, lead: boolean, maxDetail: number, index: TickIndex): Cohort {
    const s = index.cellUnits;
    const [cxRaw, czRaw] = cellKey.split(':');
    const cx = Number(cxRaw), cz = Number(czRaw);
    const centreX = (cx + 0.5) * s, centreZ = (cz + 0.5) * s;
    const r = radiusM / this.cfg.metersPerUnit;
    // One cell of slack on the span, and the radius test is against the centre plus the
    // furthest a viewer can be from it.
    //
    // The cohort is ranked from the cell centre but its members are VIEWED from anywhere in
    // the cell, and a viewer at a corner is half a diagonal — about thirty-five metres on a
    // fifty-metre cell — away from where the ranking was done. Sized exactly, the ring cut
    // half the neighbours that viewer could legitimately see off the far edge. Widening by one
    // cell and by that half-diagonal costs a few more candidates in the selection and makes
    // the answer right for every viewer in the cell rather than only for one at its centre.
    const halfDiagonal = (s * Math.SQRT2) / 2;
    const reach = r + halfDiagonal;
    const span = Math.ceil(reach / s);
    // One longer than the cap: the viewer itself is usually the nearest candidate of all, and
    // dropping it must not also drop the sixtieth neighbour.
    const want = maxDetail + 1;

    const best: Array<{ e: PresenceEntry; d: number }> = [];
    let worst = Infinity;
    const cellsInSpan: CellMembers[] = [];

    // Blocks first, then the occupied cells inside them, then the members. On an empty stretch
    // of campus this is a couple of misses instead of a hundred and sixty-nine.
    const b0i = Math.floor((cx - span) / BLOCK_CELLS), b1i = Math.floor((cx + span) / BLOCK_CELLS);
    const b0j = Math.floor((cz - span) / BLOCK_CELLS), b1j = Math.floor((cz + span) / BLOCK_CELLS);
    for (let bi = b0i; bi <= b1i; bi++) {
      for (let bj = b0j; bj <= b1j; bj++) {
        const inBlock = index.blocks.get(`${bi}:${bj}`);
        if (!inBlock) continue;
        for (const m of inBlock) {
          // A block overhangs the span at its edges, so the cell still has to be in range.
          if (m.ci < cx - span || m.ci > cx + span) continue;
          if (m.cj < cz - span || m.cj > cz + span) continue;
          const members = lead ? m.all : m.pub;
          if (!members.length) continue;
          cellsInSpan.push(m);
          for (const e of members) {
            const d = Math.hypot(e.fx - centreX, e.fz - centreZ);
            if (d > r) continue;
            if (best.length >= want && d >= worst) continue;
            // Sorted insertion. `best` is at most sixty-one long, so the shift is cheap and the
            // list is already in the order the wire wants.
            let k = best.length;
            while (k > 0 && best[k - 1].d > d) k -= 1;
            best.splice(k, 0, { e, d });
            if (best.length > want) best.pop();
            worst = best[best.length - 1].d;
          }
        }
      }
    }

    const detail = best.map((b) => b.e);
    const detailIds = new Set(detail.map((e) => e.id));
    const clusters: Array<[number, number, number]> = [];
    const clustersAll: Array<[number, number, number]> = [];
    let ownClusterIndex = -1;
    let ownClusterIndexAll = -1;
    let sig = 0;
    for (const m of cellsInSpan) {
      const members = lead ? m.all : m.pub;
      let n = 0;
      for (const e of members) if (!detailIds.has(e.id)) n += 1;
      const all = members.length;
      if (all > 0) {
        if (m.key === cellKey) ownClusterIndexAll = clustersAll.length;
        clustersAll.push([Math.round(m.ci * s * 100) / 100, Math.round(m.cj * s * 100) / 100, all]);
        // The signature covers both lists, so a change in either re-sends.
        sig = (sig * 31 + m.ci * 7 + m.cj * 13 + all * 19) | 0;
      }
      if (n === 0) continue;
      if (m.key === cellKey) ownClusterIndex = clusters.length;
      // `| 0` keeps the running value a 32-bit integer, so this stays integer arithmetic
      // rather than drifting into a float that compares by luck.
      sig = (sig * 31 + m.ci * 7 + m.cj * 13 + n * 17) | 0;
      // Rounded by arithmetic, not by `toFixed`. Two decimals of a world unit is two
      // centimetres, which is far finer than a fifty-metre cell needs, and `toFixed` builds a
      // string and parses it back — hundreds of thousands of times a second on a thinly
      // spread campus, to round a number that was never imprecise.
      clusters.push([Math.round(m.ci * s * 100) / 100, Math.round(m.cj * s * 100) / 100, n]);
    }
    return { detail, detailIds, clusters, clustersAll, cellKey, ownClusterIndex, ownClusterIndexAll, sig };
  }

  /**
   * The cell key a cluster triple came from. A cluster carries its cell ORIGIN in world units,
   * so dividing by the cell size recovers the integer coordinates the key is built from; the
   * rounding guards against the two-decimal quantisation the triple was emitted with.
   *
   * Not on the tick path — `Cohort.ownClusterIndex` answers the only question that used to
   * need it. This remains for tests and for the lead heat map, which reads clusters outside
   * the tick and can afford a string.
   */
  cellKeyForCluster(c: [number, number, number]): string {
    const s = this.cfg.cellMeters / this.cfg.metersPerUnit;
    return `${Math.round(c[0] / s)}:${Math.round(c[1] / s)}`;
  }

  /** The cell a world position falls in — the key `cohort` and `buildIndex` agree on. */
  cellKeyFor(x: number, z: number): string {
    return this.cellOf(x, z);
  }

  /** Entries whose published cell lies within `radiusM` of (x, z), nearest first. */
  near(x: number, z: number, radiusM: number, viewerIsLead = false): Array<{ e: PresenceEntry; d: number }> {
    const s = this.cfg.cellMeters / this.cfg.metersPerUnit;
    const r = radiusM / this.cfg.metersPerUnit;
    const cx = Math.floor(x / s), cz = Math.floor(z / s), span = Math.ceil(r / s);
    const out: Array<{ e: PresenceEntry; d: number }> = [];
    for (let i = cx - span; i <= cx + span; i++) {
      for (let j = cz - span; j <= cz + span; j++) {
        const set = this.cells.get(`${i}:${j}`);
        if (!set) continue;
        for (const id of set) {
          const e = this.entries.get(id);
          if (!e || !this.visible(e, viewerIsLead)) continue;
          const d = Math.hypot(e.fx - x, e.fz - z);
          if (d <= r) out.push({ e, d });
        }
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  /** Cluster counts per non-empty cell within the radius: [[cellX, cellZ, count]…] in world units of the cell origin. */
  clusters(x: number, z: number, radiusM: number, exclude: Set<string>, viewerIsLead = false): Array<[number, number, number]> {
    const s = this.cfg.cellMeters / this.cfg.metersPerUnit;
    const r = radiusM / this.cfg.metersPerUnit;
    const cx = Math.floor(x / s), cz = Math.floor(z / s), span = Math.ceil(r / s);
    const out: Array<[number, number, number]> = [];
    for (let i = cx - span; i <= cx + span; i++) {
      for (let j = cz - span; j <= cz + span; j++) {
        const set = this.cells.get(`${i}:${j}`);
        if (!set) continue;
        let n = 0;
        for (const id of set) {
          if (exclude.has(id)) continue;
          const e = this.entries.get(id);
          if (e && this.visible(e, viewerIsLead)) n += 1;
        }
        if (n > 0) out.push([+(i * s).toFixed(2), +(j * s).toFixed(2), n]);
      }
    }
    return out;
  }

  /**
   * Exact nearest on-duty, opted-in volunteers to a point — the dispatch query. Ring
   * expansion over the cell grid; hackers are never candidates. The caller audits once.
   */
  nearestVolunteers(x: number, z: number, maxAgeMs: number, nowMs: number = Date.now(), limit = 10): Array<{ e: PresenceEntry; distanceM: number; ageMs: number }> {
    const out: Array<{ e: PresenceEntry; distanceM: number; ageMs: number }> = [];
    const s = this.cfg.cellMeters / this.cfg.metersPerUnit;
    const cx = Math.floor(x / s), cz = Math.floor(z / s);
    // Bounded by the campus, not by hope: an event with two on-duty volunteers must terminate,
    // and the corner-to-corner diagonal of the pack is the point past which there is nothing
    // left to find. Without the bound a sparse night shift would walk the integer plane
    // forever. Nine kilometres covers the diagonal of a five-by-five kilometre pack (about
    // 7.1 km) with room for a fork whose campus is larger; the loop leaves long before this
    // whenever there is anybody to find.
    const maxRing = Math.ceil((9000 / this.cfg.metersPerUnit) / s);
    const seen = new Set<string>();

    // Ring expansion, one shell at a time, continuing until the shell being entered cannot
    // contain anybody nearer than the worst candidate already held.
    //
    // Shells are squares and distances are circles, and the mismatch grows with the ring. A
    // candidate in the far CORNER of ring R is √2·R cells away while one on the near EDGE of
    // ring R+k is only R+k, so for any ring past two there are several later shells that can
    // still hold somebody closer. Stopping one shell after the quota — which is what the
    // previous version did, and what its comment claimed was sufficient — dispatched the
    // second-nearest responder whenever the quota filled from a diagonal.
    //
    // The correct rule needs no constant: a shell R can only contain points at least
    // (R - 1)·cellSize from the centre, so once that floor exceeds the furthest candidate
    // already held, no later shell can improve on it.
    let worstHeld = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      if (out.length >= limit) {
        // The nearest possible point in this shell. One cell of slack because the search
        // centre sits somewhere inside its own cell rather than at a corner of it.
        const floorDistance = Math.max(0, ring - 1) * s * this.cfg.metersPerUnit;
        if (floorDistance > worstHeld) break;
      }
      // The shell's perimeter, generated directly rather than filtered out of the square.
      //
      // Walking the whole (2R+1)² square and skipping its interior visits O(R³) cells across
      // all rings — at the 9 km bound that is nearly eight million iterations for one dispatch
      // on an empty campus, which is what turned a fuzz over two hundred populations into a
      // twenty-second test. Emitting the 8R perimeter cells directly makes the whole search
      // O(R²), which is the number of cells that exist.
      const shell: Array<[number, number]> = [];
      if (ring === 0) shell.push([cx, cz]);
      else {
        for (let i = cx - ring; i <= cx + ring; i++) {
          shell.push([i, cz - ring], [i, cz + ring]);
        }
        // The two vertical edges, excluding the corners the horizontal edges already covered.
        for (let j = cz - ring + 1; j <= cz + ring - 1; j++) {
          shell.push([cx - ring, j], [cx + ring, j]);
        }
      }
      for (const [i, j] of shell) {
        const set = this.cells.get(`${i}:${j}`);
        if (!set) continue;
        for (const id of set) {
          if (seen.has(id)) continue;
          seen.add(id);
          const e = this.entries.get(id);
          // Opted in, a volunteer, and on shift.
          //
          // The opt-in check is the one that used to be missing, and its absence contradicted
          // the promise made to whoever opted out: their exact position was read and they were
          // sent to a call they had declined to be findable for. The entry exists at all only
          // because they were publishing when they last sampled — an opt-out mid-session
          // leaves it behind until the next sample erases it — so the flag has to be read
          // rather than inferred from the entry's existence.
          if (!e || !e.optIn || e.kind !== 'VOLUNTEER' || !e.onDuty) continue;
          const ageMs = nowMs - e.t;
          if (ageMs > maxAgeMs) continue;
          // Ranking uses the EXACT position, never the fuzzed one the grid indexes by. The
          // cell is only a search structure; dispatch is one of the two audited exact reads.
          out.push({ e, distanceM: Math.hypot(e.x - x, e.z - z) * this.cfg.metersPerUnit, ageMs });
        }
      }

      // The furthest of the best `limit` so far — the bar a later shell has to beat.
      if (out.length >= limit) {
        const sorted = out.map((o) => o.distanceM).sort((a, b) => a - b);
        worstHeld = sorted[limit - 1];
      }
    }

    out.sort((a, b) => a.distanceM - b.distanceM);
    return out.slice(0, limit);
  }

  /** Test/ops hook. */
  clear(): void {
    this.entries.clear();
    this.cells.clear();
    this.mutes.clear();
  }
}

export const presenceStore = new PresenceStore();
