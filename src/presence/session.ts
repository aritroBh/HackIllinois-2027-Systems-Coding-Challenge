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
import type { PresenceEntry, PresenceStore } from './store';

const CLUSTER_KEY = (c: [number, number, number]) => `${c[0]},${c[1]}`;

export class PresenceSession {
  public readonly idx = new IdxTable();
  private sentVersion = new Map<string, number>();
  private lastClusters = new Map<string, number>();
  private lastSnapshotAt = 0;
  public helloAt = 0;
  public lastPosAt = 0;
  public clusterOnly = false;
  /** SSE clients get a smaller cut: the fallback carries JSON rows over the event stream. */
  public readonly detailCap: number;

  constructor(
    public readonly client: PresenceClient,
    private readonly store: PresenceStore,
    private readonly opts: { snapshotEveryMs: number; jsonDetailCap: number }
  ) {
    this.detailCap = client.transport === 'sse' ? opts.jsonDetailCap : store.cfg.maxDetail;
  }

  get accountId(): string {
    return this.client.account.id;
  }

  private isLead(): boolean {
    const r = this.client.account.role;
    return r === 'SHIFT_LEAD' || r === 'ORGANIZER' || r === 'ADMIN';
  }

  /** Everything this client should know about right now, plus the joins it has not seen. */
  private computeInterest(nowMs: number): { rows: WireRow[]; joins: JoinRecord[]; clusters: Array<[number, number, number]>; visible: Set<string> } {
    const me = this.store.get(this.accountId);
    const rows: WireRow[] = [];
    const joins: JoinRecord[] = [];
    const visible = new Set<string>();
    // Privacy is symmetric: a client that is not publishing does not receive positions.
    if (!me || Number.isNaN(me.fx)) return { rows, joins, clusters: [], visible };

    const lead = this.isLead();
    const near = this.store.near(me.fx, me.fz, this.store.cfg.interestRadiusMeters, lead);
    const detail = this.clusterOnly ? [] : near.filter((n) => n.e.id !== this.accountId).slice(0, this.detailCap);
    const detailIds = new Set(detail.map((n) => n.e.id));
    detailIds.add(this.accountId);

    for (const { e } of detail) {
      visible.add(e.id);
      const [idx, isNew] = this.idx.assign(e.id, nowMs);
      if (isNew || this.idx.needsFullSnapshot) joins.push(this.joinOf(e, idx));
      const sent = this.sentVersion.get(e.id);
      if (sent === e.version && !isNew && !this.idx.needsFullSnapshot) continue;
      this.sentVersion.set(e.id, e.version);
      rows.push(this.rowOf(e, idx, nowMs));
    }
    const clusters = this.store.clusters(me.fx, me.fz, this.store.cfg.interestRadiusMeters, detailIds, lead);
    return { rows, joins, clusters, visible };
  }

  private joinOf(e: PresenceEntry, idx: number): JoinRecord {
    return { idx, id: e.id, name: e.name, faction: e.faction, avatarHash: e.avatarHash, kind: e.kind };
  }

  private rowOf(e: PresenceEntry, idx: number, nowMs: number): WireRow {
    return {
      idx, x: e.fx, z: e.fz, h: e.h,
      faction: factionIndex(e.faction),
      stale: this.store.isStale(e, nowMs),
      kind: e.kind === 'HACKER' ? 1 : 0,
    };
  }

  /** Build and send this tick's frame. Returns the number of rows sent. */
  send(tick: number, nowMs: number, metersPerUnit: number): number {
    const full = this.idx.needsFullSnapshot || nowMs - this.lastSnapshotAt >= this.opts.snapshotEveryMs;
    if (full) {
      this.sentVersion.clear();
      this.lastClusters.clear();
    }
    const { rows, joins, clusters, visible } = this.computeInterest(nowMs);

    // Expire slots the client can no longer see.
    const gone: number[] = [];
    for (const id of [...this.idx.ids()]) {
      if (visible.has(id) || id === this.accountId) continue;
      const idx = this.idx.release(id, tick);
      if (idx !== undefined) gone.push(idx);
      this.sentVersion.delete(id);
    }

    // Clusters are sent only when they change.
    let clusterPayload: Array<[number, number, number]> | undefined;
    const nextMap = new Map<string, number>();
    let changed = false;
    for (const c of clusters) {
      nextMap.set(CLUSTER_KEY(c), c[2]);
      if (this.lastClusters.get(CLUSTER_KEY(c)) !== c[2]) changed = true;
    }
    if (full || changed || nextMap.size !== this.lastClusters.size) {
      clusterPayload = clusters;
      this.lastClusters = nextMap;
    }

    if (!full && !rows.length && !joins.length && !gone.length && !clusterPayload) return 0;

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
    if (gone.length) this.client.send({ t: 'expire', tick, ids: gone });
    if (full) {
      this.lastSnapshotAt = nowMs;
      this.idx.needsFullSnapshot = false;
    }
    return rows.length;
  }

  /** A client that saw an unknown idx asks for a rebind. */
  requestResync(): void {
    this.idx.needsFullSnapshot = true;
    this.sentVersion.clear();
    this.lastClusters.clear();
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
