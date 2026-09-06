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

export const ROW_BYTES = 8;
export const HEADER_BYTES = 7;
export const UNIT_PER_METRE = 5; // 0.2 m units
export const IDX_WRAP = 65000;
export const IDX_NO_REUSE_TICKS = 600;

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

export interface JoinRecord {
  idx: number;
  id: string;
  name: string;
  faction: string | null;
  avatarHash: string | null;
  kind: 'VOLUNTEER' | 'HACKER';
}

/** Encode rows for the binary transport. */
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

  get(id: string): number | undefined {
    return this.byId.get(id);
  }

  idOf(idx: number): string | undefined {
    return this.byIdx.get(idx);
  }

  /** Returns [idx, isNew]. */
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

  size(): number {
    return this.byId.size;
  }

  ids(): IterableIterator<string> {
    return this.byId.keys();
  }
}
