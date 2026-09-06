/**
 * One connected client's view of the world (plan §A4).
 *
 * Interest management: each tick the session takes the 50 m cells within `interestRadiusMeters`
 * of its own published position, sends the nearest `maxDetail` players at full detail (only
 * those whose `version` moved since the last send) and everything else as per-cell cluster
 * counts, which are sent only when they change. Slots (`idx`) are scoped to this connection
 * via `IdxTable`, so a client never sees an id it was not told about in a join record.
 *
 * Degradation: the service flips every session to cluster-only when two consecutive ticks
 * exceed 30 ms, and back after 10 s under 15 ms.
 */
import { IdxTable, JoinRecord, WireRow, encodeRows, toJsonRow } from './protocol';
import type { PresenceClient } from './transport';
import type { Cohort, PresenceEntry, PresenceStore } from './store';

export class PresenceSession {
  public readonly idx = new IdxTable();
  private sentVersion = new Map<string, number>();
  /**
   * The cohort signature this session last sent clusters for, and whether it had subtracted
   * itself from its own cell at the time.
   *
   * This used to be a map of cell key to count, rebuilt from template strings every tick for
   * every session. Two numbers say the same thing, because the array being compared is shared
   * by the whole cohort: if the cohort's checksum has not moved and this session's own-cell
   * adjustment has not flipped, the payload is byte-for-byte what was already sent.
   */
  private lastClusterSig = Number.NaN;
  private lastClusterAdjusted = false;
  /**
   * Reused across ticks: a row array and the row objects inside it.
   *
   * Both are consumed synchronously — `encodeRows` writes them into a buffer and `toJsonRow`
   * flattens them, and neither keeps a reference past the call — so refilling the same objects
   * is safe. Allocating sixty fresh objects per session per second is three hundred thousand
   * short-lived objects a second at full attendance, and the young-generation collections that
   * causes were the whole of the tick's p95 spread.
   */
  private rowPool: WireRow[] = [];
  private rowBuf: WireRow[] = [];
  private joinBuf: JoinRecord[] = [];
  private lastSnapshotAt = 0;
  public helloAt = 0;
  public lastPosAt = 0;
  public clusterOnly = false;
  /**
   * How many rows this session may carry this tick, set by the service's load ladder.
   *
   * A single step from "everybody at full detail" to "nobody, have some cluster counts" is a
   * visible cliff: sprites vanish from the map the instant the server has a busy second. A
   * detail budget that can be halved first degrades the far edge of the ring, which nobody
   * looks at, before it touches the crowd in front of the player.
   */
  public detailBudget = Number.POSITIVE_INFINITY;
  /** SSE clients get a smaller cut: the fallback carries JSON rows over the event stream. */
  public readonly detailCap: number;

  constructor(
    public readonly client: PresenceClient,
    private readonly store: PresenceStore,
    private readonly opts: { snapshotEveryMs: number; jsonDetailCap: number }
  ) {
    this.detailCap = client.transport === 'sse' ? opts.jsonDetailCap : store.cfg.maxDetail;
    const role = client.account.role;
    this.lead = role === 'SHIFT_LEAD' || role === 'ORGANIZER' || role === 'ADMIN';
  }

  get accountId(): string {
    return this.client.account.id;
  }

  /**
   * Fixed for the life of the connection. A role change takes effect on the client's next
   * reconnect, which is also when the session cookie carrying it is re-read — computing it
   * once is what lets the service key its cohort cache on it without a per-tick lookup.
   */
  public readonly lead: boolean;

  /**
   * Everything this client should know about right now, plus the joins it has not seen.
   *
   * The candidate set and the cluster counts arrive precomputed in `cohort`, shared with every
   * other client standing in the same cell. What remains here is genuinely per-connection: the
   * slot table, which versions this particular socket has already been sent, and dropping the
   * viewer from its own view.
   */
  private computeInterest(nowMs: number, cohort: Cohort | null): { rows: WireRow[]; joins: JoinRecord[]; visible: Set<string> } {
    const rows = this.rowBuf;
    const joins = this.joinBuf;
    rows.length = 0;
    joins.length = 0;
    const visible = this.visibleBuf;
    visible.clear();
    // Privacy is symmetric: a client that is not publishing does not receive positions, and
    // the service hands us a null cohort precisely when that is the case.
    if (!cohort) { this.pendingAdjust = false; return { rows, joins, visible }; }

    if (!this.clusterOnly) {
      let taken = 0;
      for (const e of cohort.detail) {
        if (e.id === this.accountId) continue;
        if (taken >= this.detailCap || taken >= this.detailBudget) break;
        taken += 1;
        visible.add(e.id);
        const [idx, isNew] = this.idx.assign(e.id, nowMs);
        if (isNew || this.idx.needsFullSnapshot) joins.push(this.joinOf(e, idx));
        const sent = this.sentVersion.get(e.id);
        if (sent === e.version && !isNew && !this.idx.needsFullSnapshot) continue;
        this.sentVersion.set(e.id, e.version);
        rows.push(this.rowInto(rows.length, e, idx, nowMs));
      }
    }

    // Whether this viewer has to be subtracted from its own cell's count is decided here and
    // acted on only if the payload is actually sent — the copy that the subtraction needs is
    // the single largest allocation on this path, and most ticks do not send clusters at all.
    this.pendingAdjust = cohort.ownClusterIndex >= 0 && !cohort.detailIds.has(this.accountId);
    return { rows, joins, visible };
  }

  /** Whether the cluster payload just computed had this viewer subtracted from its own cell. */
  private pendingAdjust = false;
  private visibleBuf = new Set<string>();

  /**
   * The shared cluster list with this viewer removed from its own cell, or the shared list
   * itself when no adjustment is needed. Only called when the payload is going out.
   */
  private adjustedClusters(cohort: Cohort): Array<[number, number, number]> {
    if (!this.pendingAdjust) return cohort.clusters;
    const out = cohort.clusters.slice();
    const [cxu, czu, n] = out[cohort.ownClusterIndex];
    if (n <= 1) out.splice(cohort.ownClusterIndex, 1);
    else out[cohort.ownClusterIndex] = [cxu, czu, n - 1];
    return out;
  }

  private joinOf(e: PresenceEntry, idx: number): JoinRecord {
    return { idx, id: e.id, name: e.name, faction: e.faction, avatarHash: e.avatarHash, kind: e.kind };
  }

  /** Fill (and if necessary create) the pooled row at `slot`. See `rowPool` for why. */
  private rowInto(slot: number, e: PresenceEntry, idx: number, nowMs: number): WireRow {
    let r = this.rowPool[slot];
    if (!r) {
      r = { idx: 0, x: 0, z: 0, h: 0, faction: 0, stale: false, kind: 0 };
      this.rowPool[slot] = r;
    }
    r.idx = idx; r.x = e.fx; r.z = e.fz; r.h = e.h;
    r.faction = factionIndex(e.faction);
    r.stale = this.store.isStale(e, nowMs);
    r.kind = e.kind === 'HACKER' ? 1 : 0;
    return r;
  }

  /** Build and send this tick's frame. Returns the number of rows sent. */
  send(tick: number, nowMs: number, metersPerUnit: number, cohort: Cohort | null = null): number {
    const full = this.idx.needsFullSnapshot || nowMs - this.lastSnapshotAt >= this.opts.snapshotEveryMs;
    if (full) {
      this.sentVersion.clear();
      this.lastClusterSig = Number.NaN;
    }
    const active = cohort ?? this.ownCohort();
    const { rows, joins, visible } = this.computeInterest(nowMs, active);

    // Expire slots the client can no longer see.
    //
    // Iterating the table's own key iterator rather than a copy of it. Deleting the key you
    // are standing on is well defined for a JavaScript Map, and the copy was a fresh array of
    // up to sixty strings per session per tick — five thousand of those a second is garbage
    // collection pressure bought for nothing.
    let gone: number[] | null = null;
    for (const id of this.idx.ids()) {
      if (visible.has(id) || id === this.accountId) continue;
      const idx = this.idx.release(id, tick);
      if (idx !== undefined) (gone ??= []).push(idx);
      this.sentVersion.delete(id);
    }

    // Clusters are sent only when they change, and "changed" is now two integer comparisons
    // against the shared cohort rather than a rebuilt map per session.
    let clusterPayload: Array<[number, number, number]> | undefined;
    const sig = active ? active.sig : 0;
    if (active && (full || sig !== this.lastClusterSig || this.pendingAdjust !== this.lastClusterAdjusted)) {
      clusterPayload = this.adjustedClusters(active);
      this.lastClusterSig = sig;
      this.lastClusterAdjusted = this.pendingAdjust;
    }

    if (!full && !rows.length && !joins.length && !gone && !clusterPayload) return 0;

    const kind = full ? 'snapshot' : 'delta';
    const head: Record<string, unknown> = { t: kind, tick, n: rows.length };
    if (joins.length) head.j = joins;
    if (clusterPayload) head.c = clusterPayload;
    if (this.clusterOnly) head.mode = 'clusters';

    if (this.client.binary) {
      this.client.send(head);
      if (rows.length) this.client.sendBinary(encodeRows(full ? 1 : 2, tick, rows, metersPerUnit));
    } else {
      head.p = rows.map(toJsonRow);
      this.client.send(head);
    }
    if (gone) this.client.send({ t: 'expire', tick, ids: gone });
    if (full) {
      this.lastSnapshotAt = nowMs;
      this.idx.needsFullSnapshot = false;
    }
    return rows.length;
  }

  /**
   * The cohort this session would be in, computed on its own.
   *
   * The service passes a shared cohort on the tick path, which is where the cost lives. This
   * exists for the callers that send a frame outside a tick — tests, and a hello that must be
   * answered before the next second — where computing one list for one client is the cheaper
   * thing to do than plumbing a tick index through.
   */
  private ownCohort(): Cohort | null {
    const me = this.store.get(this.accountId);
    if (!me || Number.isNaN(me.fx)) return null;
    return this.store.cohort(
      this.store.cellKeyFor(me.fx, me.fz),
      this.store.cfg.interestRadiusMeters,
      this.lead,
      this.detailCap,
      this.store.buildIndex()
    );
  }

  /** A client that saw an unknown idx asks for a rebind. */
  requestResync(): void {
    this.idx.needsFullSnapshot = true;
    this.sentVersion.clear();
    this.lastClusterSig = Number.NaN;
  }

  forget(id: string, tick: number): number | undefined {
    this.sentVersion.delete(id);
    return this.idx.release(id, tick);
  }
}

/** Faction id → the 3-bit wire slot. NEUTRAL is 0; the pack's order fixes the rest. */
let factionOrder: string[] = [];
export function setFactionOrder(ids: string[]): void {
  factionOrder = ['NEUTRAL', ...ids.filter((f) => f !== 'NEUTRAL')].slice(0, 8);
}
export function factionIndex(faction: string | null | undefined): number {
  if (!faction) return 0;
  const i = factionOrder.indexOf(faction);
  return i < 0 ? 0 : i;
}
export function factionAt(index: number): string {
  return factionOrder[index] ?? 'NEUTRAL';
}
