/**
 * Presence store (plan §A4): an in-process spatial hash of everyone who has opted in.
 *
 * Entries live in memory only — positions are never persisted. A cell grid (50 m in the
 * shipped pack; `cellMeters`, see `DEFAULT_CONFIG`) answers "who is near (x, z)?" for interest
 * management and for SOS dispatch (ring expansion).
 *
 * Every accepted sample passes the gates in order: opt-in → pack bbox → accuracy → mute →
 * rate → speed (three consecutive violations mute the sender for 60 s, durably in the
 * `PresenceMute` collection). This list used to leave the mute out, and its position is not a
 * footnote: it is tested BEFORE the rate gate so a muted sender hears `MUTED` however fast it
 * is sending, rather than being told `RATE` and left guessing. `update` is the authority.
 *
 * Published positions are fuzzed (a snap to the `fuzzGridMeters` lattice — 20 m in the shipped
 * pack — plus a per-hour stable jitter of up to ±8 m on each axis) and lag one tick behind the
 * accepted sample; exact positions exist only for lead+ reads and dispatch, both audited by the
 * callers.
 */
import crypto from 'crypto';
import { env } from '../config/env';
import { pack, toLocal, inBbox } from '../content/loader';
import { PresenceMute } from '../models/presenceMute.model';

/**
 * The two kinds of person on the map, and the only thing that distinguishes them here.
 *
 * `VOLUNTEER` is the kind the shift rules apply to: a volunteer who is not `onDuty` is hidden
 * from ordinary players and shown to leads (`visible`, and the `pub`/`all` split in
 * `buildIndex`), and only a volunteer is ever a dispatch candidate (`nearestVolunteers`). A
 * `HACKER` is subject to none of that and is visible whenever they have opted in. The kind also
 * rides the wire as one bit of a row's flag byte — see `encodeRows` in `protocol.ts`.
 */
export type PresenceKind = 'VOLUNTEER' | 'HACKER';

/**
 * One person's live position, and the most dangerous object in this file.
 *
 * It holds the exact fix and the published one side by side, four fields apart, differing only
 * by a lower-case f. `x`/`z` and `lat`/`lng` are where somebody actually is; `fx`/`fz` are what
 * the world is allowed to see. Everything that leaves this process to an ordinary viewer must
 * read the fuzzed pair, and the handful of readers entitled to the exact pair are enumerated in
 * `docs/PRESENCE.md` and audited by their callers. A field name is the only thing standing
 * between those two cases, which is worth remembering when adding a fifth reader.
 *
 * The entry is also the store's unit of lifetime: it is created by the first accepted sample,
 * deleted when the account's last socket closes or after `expireAfterMs` of silence, and its
 * `cell` is a cached index key maintained solely by `reindex`.
 */
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

/**
 * One fix as a client reports it. Every field is attacker-controlled; nothing here is trusted
 * on its face, which is what the gates in `update` are for.
 *
 * `acc` is the accuracy radius in metres the device claims, and a large one is the difference
 * between a refusal and a lie about where somebody is — over `maxAccuracyMeters` the sample is
 * dropped as `INACCURATE`, never counted as a strike. `h` is an optional heading in degrees;
 * when it is absent or not finite, `update` derives one from the displacement instead.
 *
 * **`spd` is accepted and ignored.** Both transports forward it (`wsTransport.handleMessage`
 * and `POST /api/v1/presence`, whose `postPresenceSchema` validates it), and the protocol
 * header in `protocol.ts` advertises it, but nothing in `src/` reads it: the speed gate
 * measures displacement between two consecutive accepted fixes and divides by the elapsed
 * time. Whatever else that costs, it is the safe direction: a sender crossing campus in a
 * second cannot talk its way past the gate by reporting `spd: 0`. Read the field as protocol
 * surface with no consumer, not as an input to any decision — and do not add a consumer that
 * believes it.
 */
export interface Sample {
  lat: number;
  lng: number;
  acc: number;
  h?: number;
  spd?: number;
}

/**
 * Why a sample was refused, in the vocabulary the transports turn into `nack` frames.
 *
 * The two speed outcomes are not synonyms and the distinction is the whole point of the
 * counter: `TOO_FAST` is one implausible jump, which a phone can produce without anybody
 * lying, and costs nothing but that sample. `SPEED_STRIKE` is the third in a row, and it is
 * also the only reply that tells the sender they
 * have just been muted for a minute. `INACCURATE` never counts towards either — a poor fix is
 * a bad radio, not a lie.
 */
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
   * Cell key → its index in `clusters`, for the one other adjustment a session may need.
   *
   * A cohort is built one longer than the row budget so a viewer can drop itself and still
   * fill its quota. A viewer that is NOT in `detail` — it can happen, because `detail` is
   * ranked from the cell centre and a viewer at the cell edge may be further out than the
   * budget's worth of people clustered at the middle — sends only `cap` of the `cap + 1`,
   * and the odd one out was excluded from the counts as though it had been sent. It is then
   * in neither list: not a row, not a dot, simply not on that viewer's map. Putting it back
   * needs the cluster for *its* cell, which is not necessarily the viewer's own.
   */
  indexOfCell: Map<string, number>;
  /** Cell size in world units, so a session can synthesise a cluster for a cell that had none. */
  cellUnits: number;
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

/**
 * The line between what a fork may tune and what it may not.
 *
 * The first seven values come from the content pack, so an event with a different campus can
 * change its cell size, its interest radius, its fuzz grid and its gates by editing
 * `event.json` — `content/schema.ts` defaults the six under `presence`, requires
 * `metersPerUnit` outright, and refuses any of them at zero or below, so a pack cannot start
 * the server with a cell size of nothing. The last four are written here and nowhere else: the
 * sample interval
 * the protocol header advertises as "≥ 2 s apart", the thirty seconds after which a dot is
 * labelled stale, the two minutes after which an entry is expired outright, and the minute a
 * speed mute lasts. They are timings of the wire and of the abuse gate rather than facts about
 * a campus, and a fork changing them would be changing the protocol.
 *
 * This is read once at module load, so a pack is not hot-swappable. The constructor accepts a
 * partial override for a store that needs different numbers, but nothing takes it up today:
 * every `new PresenceStore()` in `src/`, in the suite and in `scripts/benchmarks/` is built on
 * the defaults, so any test that wants a different cell size would be the first.
 */
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

/**
 * Metres of per-hour jitter added on each axis after the grid snap. See `fuzz`.
 */
const JITTER_METRES = 8;

/**
 * The furthest a published position can sit from the real one, in metres.
 *
 * A grid snap moves a point by at most half a cell of the fuzz grid, and the jitter adds up to
 * `JITTER_METRES` on each axis on top. Anything that reasons about distance using the CELL a
 * person is filed under, while measuring against their EXACT position, has to allow for this
 * gap — the two are not the same point and can differ by most of a building.
 */
export function maxFuzzDisplacementMetres(fuzzGridMeters: number): number {
  return fuzzGridMeters / 2 + JITTER_METRES;
}

/**
 * The per-account, per-hour jitter offset — keyed on a **server secret**, not on public inputs.
 *
 * This used to hash `${id}:${hourIndex}` alone, and both halves of that are things a viewer
 * already has: the raw account id ships in every join record, and the hour is derivable from
 * the `serverTime` in `hello_ack`. So any viewer could recompute the exact offset applied to
 * anybody they could see and subtract it, recovering the grid-snapped position exactly. The
 * jitter defended against nobody who was actually looking, while `docs/PRESENCE.md` presented
 * the snap and the jitter as layered protection.
 *
 * Mixing `SESSION_SECRET` in keeps every property the jitter was chosen for — stable within an
 * hour so a stationary person does not shimmer, uncorrelated between accounts, free to compute
 * — and removes the one that made it decorative. It is not a session token here, just a value
 * the process has and a client does not.
 */
function jitterFor(id: string, hourIndex: number): [number, number] {
  const h = crypto.createHash('sha256').update(`${env.SESSION_SECRET}:${id}:${hourIndex}`).digest();
  return [((h[0] / 255) * 2 - 1) * JITTER_METRES, ((h[1] / 255) * 2 - 1) * JITTER_METRES];
}

/**
 * In-memory spatial index store partitioning volunteer positions into geohash grid cells,
 * tracking cohort clusters, velocity validation, and privacy quantization.
 */
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

  /**
   * The grid key a world position is filed under.
   *
   * `cellMeters / metersPerUnit` is the cell edge in world units — five, for the shipped
   * pack's 50 m cell on a ten-metre unit. `Math.floor`, not a truncation: the pack origin sits
   * inside the campus rather than at a corner, so coordinates run negative on both axes, and
   * truncating towards zero would fold the two cells either side of each axis into one
   * double-width cell straddling it.
   *
   * `reindex` feeds this the PUBLISHED position and never the exact one, so every cell-keyed
   * structure in this file is an index over fuzzed space. That costs nothing for `near` and
   * `clusters`, whose answers are fuzzed anyway, and it is the whole reason
   * `nearestVolunteers` — which ranks on the exact position — has to widen its stopping rule
   * by `maxFuzzDisplacementMetres` before it may conclude that a shell holds nobody nearer.
   *
   * `near`, `clusters` and `nearestVolunteers` repeat this arithmetic inline rather than
   * calling it, because they want the two integers rather than the joined key; `buildIndex`
   * repeats it to publish `TickIndex.cellUnits` (which is the edge `cohort` does all of its
   * geometry with), and `cellKeyForCluster` repeats it to invert the division. That is six
   * copies of one expression in this file, not the four this comment used to count — grep
   * `cellMeters / this.cfg.metersPerUnit` before changing any of them. They all have to agree;
   * one that computed a different edge would be searching a grid nothing had been written into
   * and would silently find nobody, with no error anywhere.
   */
  private cellOf(x: number, z: number): string {
    const s = this.cfg.cellMeters / this.cfg.metersPerUnit;
    return `${Math.floor(x / s)}:${Math.floor(z / s)}`;
  }

  /**
   * The published position for an exact one: snap to the fuzz grid, then add the hour's jitter.
   *
   * The snap is to the NEAREST lattice point of a `fuzzGridMeters` grid rather than to the
   * corner of the cell the point falls in, which is what holds its contribution to half a grid
   * on each axis — the term `maxFuzzDisplacementMetres` is built from. `jitterFor` answers in
   * metres, so it is divided by `metersPerUnit` on the way into world units; the snap is
   * already in world units because `g` is.
   *
   * The jitter is keyed on the hour of `nowMs`, and this runs on the sample's own clock, so the
   * offset changes at the top of each hour: a person who has not moved is republished up to
   * 2 × `JITTER_METRES` away on each axis. That step happens at their first accepted sample
   * after the boundary, not at the boundary — nothing recomputes a published position for
   * somebody who is not sending, so a phone that went quiet keeps the previous hour's offset
   * for as long as its entry survives.
   *
   * The result is written to `pendingFx`/`pendingFz` by the only caller, so it reaches the wire
   * a tick later; the exception is the first sample, which publishes at once.
   */
  private fuzz(id: string, x: number, z: number, nowMs: number): [number, number] {
    const g = this.cfg.fuzzGridMeters / this.cfg.metersPerUnit;
    const [jx, jz] = jitterFor(id, Math.floor(nowMs / 3_600_000));
    return [Math.round(x / g) * g + jx / this.cfg.metersPerUnit, Math.round(z / g) * g + jz / this.cfg.metersPerUnit];
  }

  /**
   * How many people are currently tracked. `/health` reports it as `presence.tracked`, and only
   * inside its proven-lead branch: a live headcount of the building is not an anonymous fact.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * The live entry for one account — the object itself, not a copy, exact `lat`/`lng`/`x`/`z`
   * included.
   *
   * Two kinds of caller, and only one of them is a disclosure. The tick path (`session.ts`
   * twice, `service.ts` once) always passes the id of the account that owns the session doing
   * the asking, reads `fx` and `cell`, and tells nobody anything about anybody else. The shift
   * roster in `controllers/shift.controller.ts` passes other people's ids and reads `x`, `z`
   * and `t`: that is one of the three audited exact reads named in `docs/PRESENCE.md`, and it
   * is why the roster handler gates on a proven lead, coarsens what it read into age and
   * distance buckets before answering, and writes a `PresenceAudit` row per call. This method
   * enforces none of that — it hands over the exact fix to anyone holding a store reference,
   * and the gate lives entirely in the caller.
   *
   * Because the entry is live, a caller can write through it as well as read. That is not
   * hypothetical: `scripts/benchmarks/presenceTick.ts` moves every entry by hand between ticks
   * to construct its worst case.
   */
  get(id: string): PresenceEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Every tracked entry, in insertion order, exact positions and all.
   *
   * The one production caller is the lead-only `GET /presence`, which is the second of the
   * three audited exact reads and the only response anywhere that carries a coordinate out of
   * this store — dispatch quotes ranges instead, for the reason set out in
   * `nearestVolunteers`, and the roster quotes buckets. It spreads the iterator into an array
   * first, which matters: this is the store's own map
   * iterator, so anything that removed an entry part-way through a lazy pipeline would be
   * mutating the collection being walked.
   */
  all(): IterableIterator<PresenceEntry> {
    return this.entries.values();
  }

  /**
   * Push a mute read back from the durable collection into both places the gate can see it.
   *
   * One caller in `src/`: `PresenceService.refreshMutes`, the few-second sweep of
   * `PresenceMute`. A reconnecting client reaches it the same way everyone does — `factsFor`
   * runs the sweep before it answers, so a mute written before a restart, or by another
   * process, is in the store by the time `hello_ack` is built.
   *
   * The entry is only updated if one exists; the map is written unconditionally, because the
   * map is the copy that survives the entry (see `mutes` and `remove`). An expiry already in
   * the past deletes the key instead of storing it, which no caller in `src/` actually
   * exercises: the sweep queries `until > now`, so it only ever hands over live mutes. That
   * branch is reachable from a test and from a future caller, not from today's.
   *
   * Note that this reads the wall clock directly rather than taking a `nowMs` like everything
   * else here, so a test driving the store on a fake clock cannot steer which branch it takes.
   */
  applyMute(id: string, until: number): void {
    const e = this.entries.get(id);
    if (e) e.muteUntil = until;
    if (until > Date.now()) this.mutes.set(id, until);
    else this.mutes.delete(id);
  }

  /**
   * Whether this account is currently silenced by the speed gate.
   *
   * The surviving map is asked first and the entry only as a fallback, which is the order that
   * makes the answer mean anything: an entry is deleted when an account's last socket closes,
   * so consulting it alone is how the mute used to be escapable by reconnecting.
   *
   * Be aware of what this is and is not. Nothing in `src/` calls it — `update` does its own
   * check inline over a superset of the same state (the entry, the caller's swept copy of
   * `presenceMutes`, and this map), because it needs the largest expiry as a number to seed a
   * freshly created entry with rather than a boolean. So this exists as the seam
   * `tests/presence.test.ts` uses to pin the reconnect-escape fix, and the expired-entry
   * eviction below is consequently dead in production. `applyMute` is the other path that can
   * drop a key, but only when handed an expiry already past, and the service's sweep queries
   * for live rows only — so outside `clear` a lapsed expiry stays in `mutes` for the life of
   * the process. It is inert rather than wrong: every reader compares it against the clock.
   */
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
   * Gates (in order): opt-in, bbox, accuracy (dropped, never a strike), mute, rate, speed —
   * the mute is tested before the rate limit, so a muted sender hears `MUTED` however fast it
   * sends, and the rate gate only exists for an account that already has an entry.
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
    // Heading, in three cases and in that order: the device's own if it reported a finite one,
    // otherwise one derived from how far this fix moved, otherwise the previous heading kept.
    //
    // The 1e-4 is a floor on "moved at all" in WORLD UNITS — a millimetre on the shipped pack's
    // ten-metre unit. Below it the displacement is noise from a stationary phone's fix
    // wandering, and `atan2` on noise is a sprite that spins on the spot; keeping the old
    // heading is the only answer that looks like standing still.
    //
    // `atan2(dx, -dz)` rather than the usual `atan2(dz, dx)`, and the argument order is the
    // whole of it. `toLocal` puts north at −z and east at +x, so this reads 0° at north and
    // 90° at east: degrees clockwise from north, which is the same convention the browser's
    // `coords.heading` uses. That is what makes the derived case and the reported case the
    // same quantity rather than two numbers that happen to share a field.
    //
    // The modulo pair below folds the result into [0, 360). It has to: `atan2` answers in
    // (−180, 180], a device may report an over-wound angle, and `encodeRows` quantises whatever
    // it is handed into 255 steps without checking the range.
    const heading = Number.isFinite(s.h as number) ? (s.h as number) : Math.hypot(x - e.x, z - e.z) > 1e-4 ? (Math.atan2(x - e.x, -(z - e.z)) * 180) / Math.PI : e.h;
    e.x = x; e.z = z; e.lat = s.lat; e.lng = s.lng; e.acc = s.acc; e.h = ((heading % 360) + 360) % 360;
    e.t = nowMs; e.lastSampleT = nowMs; e.onDuty = who.onDuty; e.faction = who.faction; e.avatarHash = who.avatarHash; e.name = who.name; e.role = who.role;
    const [fx, fz] = this.fuzz(who.id, x, z, nowMs);
    e.pendingFx = fx; e.pendingFz = fz;
    // First sample: publish immediately so a newcomer is not invisible for a tick.
    if (Number.isNaN(e.fx)) { e.fx = fx; e.fz = fz; e.version += 1; this.reindex(e); }
    return { ok: true, entry: e };
  }

  /**
   * Move an entry to the cell its PUBLISHED position now falls in, if that has changed.
   *
   * Called from exactly two places, and both are places where `fx`/`fz` have just been
   * written: the first-sample fast path in `update`, and the promotion of pending positions in
   * `tick`. That is what lets everything downstream treat `e.cell` as a cached
   * `cellOf(e.fx, e.fz)` — `service.ts` keys its per-tick cohort cache on `me.cell` while
   * `session.ownCohort` derives the same string through `cellKeyFor`, and the two agreeing is
   * a property of this method being the only writer.
   *
   * The early return is not an optimisation detail so much as the common case: a 50 m cell is
   * most of a building, so somebody walking around inside one costs nothing at all here, and
   * only a border crossing pays for a set delete and a set insert.
   */
  private reindex(e: PresenceEntry): void {
    const cell = this.cellOf(e.fx, e.fz);
    if (cell === e.cell) return;
    if (e.cell) this.cells.get(e.cell)?.delete(e.id);
    e.cell = cell;
    let set = this.cells.get(cell);
    if (!set) { set = new Set(); this.cells.set(cell, set); }
    set.add(e.id);
  }

  /**
   * Forget one person's position entirely — their entry and their cell membership.
   *
   * What it deliberately does NOT touch is the mute. `mutes` is a separate map for exactly
   * this reason (see its declaration): this method runs when an account's last socket closes,
   * so a mute stored on the entry would be cleared by the disconnect, and reconnecting was
   * therefore a way out of the speed gate. Removing somebody is not a pardon.
   *
   * An emptied cell's `Set` is left in `cells` rather than deleted. The set of keys that can
   * ever exist is bounded — `update` refuses any sample outside the pack bbox, and a published
   * position sits within a few tens of metres of an accepted one — so this is a fixed ceiling
   * on the order of the campus divided by the cell size, not a leak that grows with traffic.
   * The ring searches pay a map hit and an empty iteration for each such husk.
   *
   * The boolean says whether there was anything to remove. Nothing reads it today; every
   * caller in `src/` and in the suite removes unconditionally.
   */
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
   *
   * `version` is bumped only when the published position actually changed, which is what makes
   * it a change token rather than a counter: `session.ts` keeps a `sentVersion` per subject and
   * sends a row only when the two differ, so a stationary person costs nothing on the wire for
   * as long as they stand still. That is also why the promotion is guarded on the pending pair
   * differing from the live one rather than being copied unconditionally.
   *
   * Expiry is measured on `t`, the last ACCEPTED sample — not on `lastSampleT`, which the speed
   * gate also bumps when it rejects. A sender whose every sample is refused as too fast
   * therefore still ages out after `expireAfterMs`, which is the behaviour you want: being
   * refused is not a way to stay on the map. The ids are collected in the loop and removed
   * after it, which is also what the return value is built from — a caller (`service.ts`) has
   * to tell its sessions who vanished, and only this method knows.
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

  /**
   * Whether this entry's last accepted sample is old enough that it should be labelled rather
   * than trusted.
   *
   * Staleness marks; it does not hide. `staleAfterMs` is thirty seconds and `expireAfterMs` is
   * two minutes, so between the two an entry is still indexed, still sent, and still drawn —
   * with the `stale` bit set in its wire row and the same flag on the lead's `GET /presence`.
   * The client turns that into a label rather than a removal. The alternative, dropping
   * somebody the moment a sample is late, would make every lift, basement and lock-screen look
   * like a departure on everybody else's map.
   *
   * This is not the constant dispatch uses. `sos.service.ts` declares its own
   * `LIVE_POSITION_MAX_AGE_MS`, which happens to be thirty seconds too but is passed to
   * `nearestVolunteers` as `maxAgeMs` and is not read from here — moving one does not move the
   * other, and they answer different questions: this one asks whether to trust a dot on a map,
   * that one asks whether a fix is fresh enough to send somebody to.
   */
  isStale(e: PresenceEntry, nowMs: number): boolean {
    return nowMs - e.t > this.cfg.staleAfterMs;
  }

  /**
   * Three conditions, and the third is not the one this comment used to name.
   *
   *   1. `optIn` — they are here on purpose;
   *   2. not an off-shift volunteer, unless the viewer is a lead;
   *   3. a published position exists at all (`fx` is not NaN).
   *
   * The old text called (3) "on campus", which it is not and never was. Nothing in this method
   * looks at the campus: the bbox is a gate in `update`, so an off-campus fix is refused as
   * `OFF_CAMPUS` and never becomes an entry to test. What (3) actually excludes is the entry
   * between its creation and its first published position — a case that only survives because
   * `fx` starts as NaN, and one that would otherwise put somebody on the map at coordinates
   * that compare false against everything.
   *
   * Callers: `session.ts` (whether a viewer may see themselves) and `near`/`clusters` below.
   * The per-tick path does not come through here — `buildIndex` inlines the same asymmetry when
   * it splits `pub` from `all`, so the rule for who is hidden is written in two places.
   */
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
   *
   * `maxDetail` is the EFFECTIVE row budget, not the transport's ceiling.
   *
   * The counts in `clusters` exclude the people arriving as rows, so that nobody is drawn
   * twice — which is only correct if "the people arriving as rows" is what `detailIds` holds.
   * Building the cohort at the transport's cap while the session sent fewer left the
   * difference in neither list: on the middle rung of the load ladder, thirty neighbours were
   * excluded from the counts as though they had been sent and then not sent. Passing the
   * effective budget makes the two agree by construction, and a budget of zero selects nobody
   * so the counts include everybody — which is what the bottom rung needs.
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
    // dropping it must not also drop the last neighbour. A cap of zero wants nobody at all.
    const want = maxDetail > 0 ? maxDetail + 1 : 0;

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
            // Against `reach`, not `r`: the ranking is done from the cell centre but the
            // people ranked are viewed from anywhere in the cell, so the ring has to be
            // widened by the furthest a viewer can be from that centre. Testing against the
            // bare radius cut half the neighbours a corner viewer could legitimately see.
            const d = Math.hypot(e.fx - centreX, e.fz - centreZ);
            if (d > reach) continue;
            // A budget of zero selects nobody: the bottom rung of the ladder sends no rows, so
            // everybody stays available to the counts. Without this the insertion below pushed
            // and immediately popped, then read past the end of an empty array.
            if (want === 0) continue;
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
    const indexOfCell = new Map<string, number>();
    let ownClusterIndex = -1;
    let sig = 0;
    for (const m of cellsInSpan) {
      const members = lead ? m.all : m.pub;
      let n = 0;
      for (const e of members) if (!detailIds.has(e.id)) n += 1;
      if (n === 0) continue;
      if (m.key === cellKey) ownClusterIndex = clusters.length;
      indexOfCell.set(m.key, clusters.length);
      // `| 0` keeps the running value a 32-bit integer, so this stays integer arithmetic
      // rather than drifting into a float that compares by luck.
      sig = (sig * 31 + m.ci * 7 + m.cj * 13 + n * 17) | 0;
      // Rounded by arithmetic, not by `toFixed`. Two decimals of a world unit is two
      // centimetres, which is far finer than a fifty-metre cell needs, and `toFixed` builds a
      // string and parses it back — hundreds of thousands of times a second on a thinly
      // spread campus, to round a number that was never imprecise.
      clusters.push([Math.round(m.ci * s * 100) / 100, Math.round(m.cj * s * 100) / 100, n]);
    }
    return { detail, detailIds, clusters, cellKey, ownClusterIndex, indexOfCell, cellUnits: s, sig };
  }

  /**
   * The cell key a cluster triple came from. A cluster carries its cell ORIGIN in world units,
   * so dividing by the cell size recovers the integer coordinates the key is built from; the
   * rounding guards against the two-decimal quantisation the triple was emitted with.
   *
   * Not on the tick path, and not on any other path either: `Cohort.ownClusterIndex` and
   * `Cohort.indexOfCell` answer the two questions that used to need this, and nothing in
   * `src/`, in the suite or in `scripts/` calls it any more. It survives as a public method
   * with no caller.
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
  nearestVolunteers(x: number, z: number, maxAgeMs: number, nowMs: number = Date.now(), limit = 10): Array<{ e: PresenceEntry; distanceM: number; publishedDistanceM: number; ageMs: number }> {
    const out: Array<{ e: PresenceEntry; distanceM: number; publishedDistanceM: number; ageMs: number }> = [];
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
        // The nearest possible EXACT position in this shell.
        //
        // Two slacks, and the second one is not obvious. The first is a cell: the search centre
        // sits somewhere inside its own cell rather than at a corner of it. The second is the
        // fuzz. Entries are filed by their PUBLISHED position — grid-snapped and jittered — and
        // dispatch measures against the real one, so a person in shell R can genuinely be up to
        // the maximum fuzz displacement nearer than that shell's boundary suggests. Without
        // this term the search stopped a shell early and sent the second-nearest responder,
        // for a reason invisible from the geometry alone.
        const floorDistance =
          Math.max(0, ring - 1) * s * this.cfg.metersPerUnit - maxFuzzDisplacementMetres(this.cfg.fuzzGridMeters);
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
          // cell is only a search structure; dispatch is one of the three audited exact reads
          // (the others are a lead's `GET /presence` and a lead's roster — see
          // `models/presenceAudit.model.ts`, which enumerates all three and their writers).
          //
          // `publishedDistanceM` is the same measurement taken against the position everybody
          // else already sees. It exists because a *range* to an exact position is an exact
          // read wearing a number: quote it finely enough, from three chosen points, and the
          // fuzz is arithmetic to undo. Callers who are entitled to the exact read take
          // `distanceM`; callers who are not take this, and learn nothing the fuzzed map
          // did not already show them.
          out.push({
            e,
            distanceM: Math.hypot(e.x - x, e.z - z) * this.cfg.metersPerUnit,
            publishedDistanceM: Math.hypot(e.fx - x, e.fz - z) * this.cfg.metersPerUnit,
            ageMs,
          });
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
