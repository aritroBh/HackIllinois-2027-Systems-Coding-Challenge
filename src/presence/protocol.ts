/**
 * Presence wire protocol (plan §A4).
 *
 * Client → server (JSON text frames):
 *   {t:'hello', v:1, enc:'bin'|'json', lastTick?}   within 5 s of the upgrade, else close 4401
 *   {t:'pos', lat, lng, acc, h?, spd?}               ≥ 10 m moved or 5 s elapsed; server accepts ≥ 2 s apart
 *   {t:'resync'}                                     unknown idx seen → full snapshot
 *   {t:'bye'}
 *
 * Server → client:
 *   {t:'hello_ack', idx, tick, serverTime, fuzz, interestM, you, mode}
 *   {t:'snapshot'|'delta', tick, j:[join…], c:[[cx,cz,count]…]?, n, p?:[row…]}
 *       — with enc 'bin' the rows follow as ONE binary frame; with 'json' they are inline as `p`
 *   {t:'expire', tick, ids:[idx…]}
 *   {t:'nack', reason}
 *   {t:'notice', mode:'clusters'|'full'}
 *
 * Binary rows: header u8 kind (1 snapshot, 2 delta) · u32 tick · u16 n, then n × 8 B:
 *   u16 idx · i16 x · i16 z (0.2 m units, ±6.5 km) · u8 heading (0–255 ≙ 0–360°) ·
 *   u8 flags (faction 3 b | stale 1 b | kind 1 b)
 *
 * `idx` is scoped to the receiving connection (see IdxTable).
 */

/**
 * The wire's five numbers, and what actually reads each of them.
 *
 * `ROW_BYTES` and `HEADER_BYTES` are the layout above counted out — 2 + 2 + 2 + 1 + 1 for a
 * row, 1 + 4 + 2 for the header — and they are duplicated as literals in
 * `public/views/players.js`, which decodes these frames in the browser without importing
 * anything. At the pack's 60-row cap a full frame of rows is 487 bytes, once a second, per
 * client.
 *
 * `UNIT_PER_METRE` fixes both the resolution and the reach of the i16 coordinates. Two
 * decimetres is far finer than the data deserves — every position on this wire has already
 * been snapped to a 20 m fuzz grid — and that is the point: the precision is free and what it
 * buys is range, ±6553 m from the pack origin on each axis. The shipped campus reaches about
 * 3.3 km from its origin along its longest axis, so `clampI16` is unreachable there and only a
 * fork with a far larger pack would meet it.
 *
 * `IDX_WRAP` is not the u16 ceiling but a little under it: `idx` is written with
 * `setUint16`, so 65535 is the hard limit, and stopping at 65000 leaves the wrap path room
 * to be taken deliberately rather than by overflow.
 *
 * `IDX_NO_REUSE_TICKS` is counted in ticks, and `service.ts` ticks once a second, so it is ten
 * minutes. See `IdxTable.release` for the awkward truth about what it currently governs.
 */
export const ROW_BYTES = 8;
export const HEADER_BYTES = 7;
export const UNIT_PER_METRE = 5; // 0.2 m units
export const IDX_WRAP = 65000;
export const IDX_NO_REUSE_TICKS = 600;

/**
 * One player as a frame carries them.
 *
 * `x` and `z` are always the FUZZED, published position: `session.rowInto` fills them from
 * `PresenceEntry.fx`/`fz`, never from the exact `x`/`z` beside them in the store. No exact
 * coordinate has a representation on this wire at all, which is the property that makes the
 * transport safe to broadcast to everybody at once.
 */
export interface WireRow {
  idx: number;
  /** World units (10 m) from the pack origin, +x east, +z south. */
  x: number;
  z: number;
  /** Heading in degrees 0–360. */
  h: number;
  faction: number; // 0–7
  stale: boolean;
  kind: 0 | 1;     // 0 volunteer, 1 hacker
}

/**
 * The identity half of a frame: who a slot belongs to, sent once when a player first becomes
 * visible to this connection and cached against `idx` by the client from then on.
 *
 * Position is deliberately not among its fields: rows are the per-tick channel and joins are
 * the per-arrival one, so what a join carries is refreshed on rebinding rather than every
 * second. `session.joinOf` is the only producer, and it emits one when a slot is newly
 * assigned or while `IdxTable.needsFullSnapshot` is set — in the latter case for every player
 * the frame selects, so a client that lost its table is rebound before it is asked to draw
 * anything.
 *
 * Note that `id` is the raw account id, and it reaches every viewer who can see that person.
 * That is a deliberate part of the contract — the client keys its own state on it — but it is
 * also the fact that made the position jitter recoverable before it was keyed on a server
 * secret; `store.jitterFor` is where that story is written down.
 */
export interface JoinRecord {
  idx: number;
  id: string;
  name: string;
  faction: string | null;
  avatarHash: string | null;
  kind: 'VOLUNTEER' | 'HACKER';
}

/**
 * Encode rows for the binary transport.
 *
 * Three quantisations happen here and each one loses something on purpose.
 *
 * Position goes through two scalings, not one: world units × `metersPerUnit` gives metres,
 * metres × `UNIT_PER_METRE` gives the fifths of a metre the i16 holds. Anything that survives
 * that and still will not fit is clamped rather than rejected, so a coordinate past the
 * envelope arrives pinned to its edge and the frame stays well formed — see `clampI16`.
 *
 * Heading is a whole turn in 255 steps, about 1.4° apiece, which is finer than a sprite
 * rotation is worth arguing about. The modulo pair before it normalises a negative or
 * over-wound angle rather than trusting the caller, though in practice every row the server
 * builds has been through `store.update`, which already folds the heading into 0–360.
 *
 * The flags byte spends three bits on the faction, and that is where the eight-faction ceiling
 * in `session.setFactionOrder` comes from: the order is sliced to eight because a ninth would
 * have nowhere to go on the wire.
 */
export function encodeRows(kind: 1 | 2, tick: number, rows: WireRow[], metersPerUnit: number): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_BYTES + rows.length * ROW_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, kind);
  dv.setUint32(1, tick >>> 0, true);
  dv.setUint16(5, rows.length, true);
  let o = HEADER_BYTES;
  for (const r of rows) {
    dv.setUint16(o, r.idx, true);
    dv.setInt16(o + 2, clampI16(Math.round(r.x * metersPerUnit * UNIT_PER_METRE)), true);
    dv.setInt16(o + 4, clampI16(Math.round(r.z * metersPerUnit * UNIT_PER_METRE)), true);
    dv.setUint8(o + 6, Math.round((((r.h % 360) + 360) % 360) / 360 * 255) & 0xff);
    dv.setUint8(o + 7, ((r.faction & 7) | (r.stale ? 8 : 0) | (r.kind ? 16 : 0)) & 0xff);
    o += ROW_BYTES;
  }
  return buf;
}

/**
 * The inverse of `encodeRows`, and — be clear about this — not the decoder that runs in
 * production.
 *
 * The browser has its own hand-written copy in `public/views/players.js`, with `HEADER_BYTES`,
 * `ROW_BYTES` and `UNIT_PER_METRE` re-declared as literals there because that file imports
 * nothing. This one exists so that `tests/presence.test.ts` can round-trip a frame and pin the
 * layout, which means the test proves this pair agrees with itself and proves nothing about
 * the copy. A change to the row layout has to be made in both files or the map goes wrong in
 * the browser while the suite stays green.
 *
 * It trusts its input: the row count comes from the header and the buffer is read on that
 * word alone, so a short or corrupt frame reads past the end and throws rather than being
 * rejected politely. That is acceptable here because the only producer is this server over a
 * framed transport, and it would not be if a frame could arrive from anywhere else.
 */
export function decodeRows(buf: ArrayBuffer, metersPerUnit: number): { kind: number; tick: number; rows: WireRow[] } {
  const dv = new DataView(buf);
  const kind = dv.getUint8(0);
  const tick = dv.getUint32(1, true);
  const n = dv.getUint16(5, true);
  const rows: WireRow[] = [];
  let o = HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const flags = dv.getUint8(o + 7);
    rows.push({
      idx: dv.getUint16(o, true),
      x: dv.getInt16(o + 2, true) / (metersPerUnit * UNIT_PER_METRE),
      z: dv.getInt16(o + 4, true) / (metersPerUnit * UNIT_PER_METRE),
      h: (dv.getUint8(o + 6) / 255) * 360,
      faction: flags & 7,
      stale: !!(flags & 8),
      kind: flags & 16 ? 1 : 0,
    });
    o += ROW_BYTES;
  }
  return { kind, tick, rows };
}

/**
 * Pin a coordinate to the i16 envelope instead of letting `setInt16` wrap it.
 *
 * Without this a position past ±6553 m would not fail loudly; it would truncate to sixteen
 * bits and reappear on the far side of the campus, which reads as a teleport rather than as a
 * bug. Clamping is still a lie — the player is drawn at the edge of the world instead of
 * outside it — but it is a lie in the direction of where they actually are, and a pack big
 * enough to reach it is out of contract anyway.
 */
function clampI16(v: number): number {
  return Math.max(-32768, Math.min(32767, v));
}

/**
 * JSON row for the SSE fallback and debugging:
 * `[idx, x, z, heading, factionIdx, stale, kind]` — the same six fields the binary row
 * carries, `kind` included, so the fallback does not quietly render every hacker as a
 * volunteer.
 */
export type JsonRow = [number, number, number, number, number, 0 | 1, 0 | 1];
export function toJsonRow(r: WireRow): JsonRow {
  return [r.idx, +r.x.toFixed(3), +r.z.toFixed(3), Math.round(r.h), r.faction, r.stale ? 1 : 0, r.kind];
}

/**
 * Per-connection slot table. Allocates monotonically from 1, never reuses a value within
 * IDX_NO_REUSE_TICKS, and on wrap clears everything and demands a full snapshot whose joins
 * rebind every visible player — so a client can never draw an unknown or mis-bound sprite.
 */
export class IdxTable {
  private next = 1;
  private byId = new Map<string, number>();
  private byIdx = new Map<number, string>();
  private released: Array<{ idx: number; tick: number }> = [];
  public needsFullSnapshot = true;

  /**
   * The slot this connection has already given an account, or nothing. Nothing in `src/`
   * calls it; `tests/presence.test.ts` reads it to check that a released account really has
   * no slot left.
   */
  get(id: string): number | undefined {
    return this.byId.get(id);
  }

  /** Who a slot currently stands for — the reverse lookup, used by the tests over the table. */
  idOf(idx: number): string | undefined {
    return this.byIdx.get(idx);
  }

  /**
   * The slot for an account on this connection, allocating one if it has none. Returns
   * [idx, isNew]; `isNew` is what tells the caller a `JoinRecord` has to accompany the row.
   *
   * The wrap is the interesting branch and it is deliberately brutal. Rather than hunt for a
   * free slot below the ceiling, it forgets both directions of the mapping, restarts the
   * counter and raises `needsFullSnapshot`, so the next frame rebinds every visible player
   * from scratch. It costs one expensive frame after roughly 65,000 distinct people have
   * passed through a single connection's view — which at a hackathon is a session that has
   * been open a very long time — and in exchange there is no window in which an old binding
   * and a new one could both be live and a client draw the wrong name on a sprite.
   *
   * `tick` is accepted and voided. It is here because the no-reuse rule is expressed in ticks
   * and `release` records them, but this side has nothing to consult: the counter only ever
   * goes up, so it cannot hand back a value that was released. Note that `session.ts` passes
   * `nowMs` here while passing the tick number to `release` — harmless only for as long as
   * this parameter stays unread.
   */
  assign(id: string, tick: number): [number, boolean] {
    const have = this.byId.get(id);
    if (have !== undefined) return [have, false];
    if (this.next >= IDX_WRAP) {
      this.byId.clear();
      this.byIdx.clear();
      this.released = [];
      this.next = 1;
      this.needsFullSnapshot = true;
    }
    const idx = this.next++;
    this.byId.set(id, idx);
    this.byIdx.set(idx, id);
    void tick;
    return [idx, true];
  }

  /**
   * Give up the slot an account held on this connection, returning it so the caller can tell
   * the client the sprite is gone. Undefined when there was no slot, which is why `session.ts`
   * can call this unconditionally while sweeping.
   *
   * The `released` list is the part worth being honest about: nothing reads it. `assign`
   * never consults it, because the monotonic counter already makes reuse impossible before a
   * wrap, and a wrap clears the list along with everything else. So the no-reuse window it
   * implements is a rule the counter enforces more strongly on its own, and the trim below is
   * a memory bound on a structure that has no other purpose. It is not wrong, and removing it
   * would not change a byte on the wire — but do not read it as the thing that keeps a stale
   * `expire` from landing on a rebound slot, because it is not doing that work.
   */
  release(id: string, tick: number): number | undefined {
    const idx = this.byId.get(id);
    if (idx === undefined) return undefined;
    this.byId.delete(id);
    this.byIdx.delete(idx);
    this.released.push({ idx, tick });
    // Trim the no-reuse window (values are never reused before wrap anyway; this bounds memory).
    while (this.released.length && tick - this.released[0].tick > IDX_NO_REUSE_TICKS) this.released.shift();
    return idx;
  }

  /** How many slots this connection currently holds. Used by the tests to observe a wrap. */
  size(): number {
    return this.byId.size;
  }

  /**
   * The accounts this connection has slots for — the table's own live key iterator, not a copy.
   *
   * `session.ts` walks it and calls `release` on keys as it goes, which is safe because
   * deleting the key you are standing on is defined behaviour for a `Map`, and it is done on
   * purpose: copying up to sixty strings per session per tick, five thousand sessions a
   * second, was garbage bought for nothing. Anything else iterating this must not add keys
   * while it does.
   */
  ids(): IterableIterator<string> {
    return this.byId.keys();
  }
}
