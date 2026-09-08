/**
 * One connected client's view of the world (plan §A4).
 *
 * Interest management: each tick the session takes the 50 m cells within `interestRadiusMeters`
 * of its own published position, sends the nearest `maxDetail` players at full detail (only
 * those whose `version` moved since the last send) and everything else as per-cell cluster
 * counts, which are sent only when they change. Slots (`idx`) are scoped to this connection
 * via `IdxTable`, so a client never sees an id it was not told about in a join record.
 *
 * Degradation: a three-rung ladder in the service, judged on CPU spent per tick. Two ticks
 * over 200 ms halve `detailBudget`; two over 500 ms set `clusterOnly`; recovery climbs one
 * rung at a time after 10 s of ticks under 120 ms. The single 30 ms threshold this comment
 * used to describe was replaced when the tick was sliced, which made wall-clock meaningless.
 */
import { IdxTable, JoinRecord, WireRow, encodeRows, toJsonRow } from './protocol';
import type { PresenceClient } from './transport';
import type { Cohort, PresenceEntry, PresenceStore } from './store';

/**
 * Per-client presence connection session managing differential delta updates,
 * tile index caching, and bandwidth-throttled position streaming.
 */
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
  /** The `pendingAddBack` cells the last sent cluster payload was corrected for, joined. */
  private lastClusterAddBack = '';
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
  /** Slots released by `forget` between frames, drained by the next `send`. */
  private pendingExpire: number[] = [];
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

  /**
   * `detailCap` is settled once and never moves, because the transport cannot: a socket does
   * not become an event stream. The load ladder's `detailBudget` is the part that varies, and
   * `effectiveCap` is where the two are reconciled — the cohort is built from that figure, not
   * from either half alone.
   *
   * `lead` is seeded from the role this connection authenticated with and then re-asserted
   * every tick from the account facts; the field's own comment explains why a stale one is a
   * disclosure rather than a cosmetic error.
   */
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
   * Whether this viewer may see off-shift volunteers.
   *
   * Set from the session cookie at connect and re-read from the account facts on every tick.
   *
   * It was `readonly`, fixed for the life of the socket, so a lead demoted mid-event kept lead
   * vision — and any open `presence:exact` stream — until they happened to reconnect. Losing a
   * privilege has to take effect immediately even though gaining one can wait.
   *
   * "Every tick" is only as fresh as the facts cache behind it, which is why the role routes
   * call `presenceService.invalidate` on a demotion: without that the tick re-asserted the old
   * role from a thirty-second-old copy, and the window was half a minute rather than a second.
   */
  public lead: boolean;

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

    const cap = this.effectiveCap();
    // Cells owed a body back: see `pendingAddBack`.
    this.pendingAddBack.length = 0;
    if (cap > 0) {
      let taken = 0;
      for (const e of cohort.detail) {
        if (e.id === this.accountId) continue;
        if (taken >= cap) {
          // Excluded from the shared counts as a row, and then not sent as one. This happens
          // to exactly the viewers that are not themselves in `detail`, and to at most one
          // person per tick, but "at most one person is invisible" is not a property this
          // layer is allowed to have.
          this.pendingAddBack.push(e.cell);
          continue;
        }
        taken += 1;
        visible.add(e.id);
        const [idx, isNew] = this.idx.assign(e.id, nowMs);
        if (isNew || this.idx.needsFullSnapshot) joins.push(this.joinOf(e, idx));
        const sent = this.sentVersion.get(e.id);
        if (sent === e.version && !isNew && !this.idx.needsFullSnapshot) continue;
        this.sentVersion.set(e.id, e.version);
        rows.push(this.rowInto(rows.length, e, idx, nowMs));
      }
    } else {
      // No rows at all, so nobody was excluded from the counts on this session's behalf and
      // there is nothing to put back. The cohort was built with a budget of zero, which
      // selects nobody, so its counts already hold everybody.
      void 0;
    }

    // Whether this viewer has to be subtracted from its own cell's count is decided here and
    // acted on only if the payload is actually sent — the copy that the subtraction needs is
    // the single largest allocation on this path, and most ticks do not send clusters at all.
    //
    // Two conditions, and both were previously wrong in a way that removed somebody else from
    // the map. The viewer is only in a count at all if it is publishable to its own audience:
    // an off-duty volunteer looking at the map is absent from the public counts, so subtracting
    // itself took a neighbour away instead. And once the ladder stops sending rows, the list
    // being adjusted is the all-inclusive one, whose own-cell entry sits at a different index.
    //
    // And the viewer subtracts itself only if it is actually in the shared count. It usually
    // is not: the cohort is built one longer than the budget precisely so the viewer — which
    // is normally the nearest candidate to its own cell centre, being in it — lands in
    // `detail`, and everything in `detail` is already out of the counts. Subtracting again
    // took a NEIGHBOUR off the map, and where the cell held one other person it removed the
    // whole cluster. The condition is membership of the count, not membership of the cell.
    const inOwnCount = !cohort.detailIds.has(this.accountId) && this.countsSelf();
    this.pendingAdjust = inOwnCount && cohort.ownClusterIndex >= 0;
    return { rows, joins, visible };
  }

  /**
   * Whether this viewer appears in the cluster counts it is about to be sent.
   *
   * A count is built from the cell members visible to this viewer's audience. A lead sees
   * everybody, so a lead is always in it. A player sees only publishable people, so an
   * off-duty volunteer — invisible to players by design — is not, and must not subtract
   * itself from a tally it was never part of.
   */
  private countsSelf(): boolean {
    if (this.lead) return true;
    const me = this.store.get(this.accountId);
    return !!me && this.store.visible(me, false);
  }

  /**
   * How many rows this session may actually send.
   *
   * The transport's cap and the load ladder's budget, whichever is smaller. The cohort is
   * built with this figure so that the people its counts exclude are exactly the people this
   * session sends — the two disagreeing is what left the middle rung's unsent neighbours in
   * neither the rows nor the counts.
   */
  effectiveCap(): number {
    if (this.clusterOnly) return 0;
    return Math.max(0, Math.min(this.detailCap, this.detailBudget));
  }

  /** Whether the cluster payload just computed had this viewer subtracted from its own cell. */
  private pendingAdjust = false;
  /**
   * Cells holding somebody the shared cohort excluded from its counts and this session did
   * not send, one entry per such person. Reused between ticks rather than reallocated; it is
   * empty on almost every tick and never longer than one.
   */
  private pendingAddBack: string[] = [];
  private visibleBuf = new Set<string>();

  /**
   * The shared cluster list with this viewer removed from its own cell, or the shared list
   * itself when no adjustment is needed. Only called when the payload is going out.
   */
  private adjustedClusters(cohort: Cohort): Array<[number, number, number]> {
    // One list, and at most two corrections to it.
    //
    // The cohort was built with this session's effective row budget, so its counts exclude
    // the people this session sends as rows — plus, when the viewer is in `detail`, the
    // viewer itself. Both corrections below exist because that "plus" is conditional and the
    // cohort serves every viewer in the cell at once.
    //
    // The invariant they preserve, and the one the test asserts: every publishable person
    // within reach is on this viewer's map exactly once — as a row, or in exactly one cluster
    // count — except the viewer, who is neither.
    const base = cohort.clusters;
    if (!this.pendingAdjust && this.pendingAddBack.length === 0) return base;
    const out = base.slice();

    // Somebody excluded from the counts as a row who never became one.
    for (const cellKey of this.pendingAddBack) {
      const at = cohort.indexOfCell.get(cellKey);
      if (at !== undefined) {
        const [cxu, czu, n] = out[at];
        out[at] = [cxu, czu, n + 1];
        continue;
      }
      // Their cell contributed no count at all — every other member of it was sent — so the
      // cluster was dropped and has to be recreated rather than incremented.
      const [ciRaw, cjRaw] = cellKey.split(':');
      const s = cohort.cellUnits;
      out.push([
        Math.round(Number(ciRaw) * s * 100) / 100,
        Math.round(Number(cjRaw) * s * 100) / 100,
        1,
      ]);
    }

    if (this.pendingAdjust) {
      const at = cohort.ownClusterIndex;
      if (at >= 0) {
        const [cxu, czu, n] = out[at];
        if (n <= 1) out.splice(at, 1);
        else out[at] = [cxu, czu, n - 1];
      }
    }
    return out;
  }

  /** Join frame: who arrived. Positions ride the rows, never this record. */
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

  /**
   * Build and send this tick's frame. Returns the number of rows sent.
   *
   * A binary client gets two frames, not one: a JSON head carrying the joins, the cluster
   * counts and the row count, then the rows themselves as eight bytes each. Splitting them is
   * safe because a WebSocket delivers in order, and `n` in the head is what tells the client
   * how many rows are coming.
   *
   * A tick with nothing to say sends nothing, and the four things that count as something are
   * the four terms of the early return: rows, joins, released slots, and a cluster payload that
   * has changed. A full snapshot is exempt and goes out even when it is empty, because this is
   * also the path that advances `lastSnapshotAt` and clears `needsFullSnapshot` — returning
   * early would leave a session permanently owing a snapshot it never sent.
   */
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
    let gone: number[] | null = this.pendingExpire.length ? this.pendingExpire.splice(0) : null;
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
    // The per-viewer corrections are part of "has this payload changed". The shared checksum
    // cannot see them — every session in the cell shares it — so a tick where the cohort is
    // unchanged but this viewer's own correction is not would otherwise leave the client
    // holding the previous tick's counts. `pendingAddBack` is empty on nearly every tick and
    // never longer than one, so this is a comparison of two short strings, usually both empty.
    const addBackSig = this.pendingAddBack.length ? this.pendingAddBack.join(',') : '';
    if (
      active &&
      (full ||
        sig !== this.lastClusterSig ||
        this.pendingAdjust !== this.lastClusterAdjusted ||
        addBackSig !== this.lastClusterAddBack)
    ) {
      clusterPayload = this.adjustedClusters(active);
      this.lastClusterSig = sig;
      this.lastClusterAdjusted = this.pendingAdjust;
      this.lastClusterAddBack = addBackSig;
    }

    // `gone` on its own is a reason to send: a frame that says only "these slots are empty" is
    // the one that removes a departed player from the map.
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

  /**
   * Update the audience this session belongs to.
   *
   * A change forces a resync: the cohort the client has been reading from is keyed on this
   * flag, so the next frame is drawn from a different candidate set and a delta against the
   * old one would leave people on the map who are no longer visible to it.
   */
  setLead(next: boolean): void {
    if (next === this.lead) return;
    this.lead = next;
    this.requestResync();
  }

  /** A client that saw an unknown idx asks for a rebind. */
  requestResync(): void {
    this.idx.needsFullSnapshot = true;
    this.sentVersion.clear();
    this.lastClusterSig = Number.NaN;
  }

  /**
   * Drop somebody who has stopped reporting, and remember to tell the client.
   *
   * The service calls this for every expired account at the top of the tick, before any frame
   * is built, and it used to throw the returned slot away. By the time `send` ran its own
   * expiry sweep the id was already out of the slot table, so the sweep never saw it either
   * and no `expire` frame was ever sent for anybody who timed out. Their sprite stayed on
   * every map indefinitely, and when the slot number was eventually handed to somebody else
   * the client had two people bound to it.
   *
   * The released slot is queued instead, and the next frame drains the queue.
   */
  forget(id: string, tick: number): number | undefined {
    this.sentVersion.delete(id);
    const idx = this.idx.release(id, tick);
    if (idx !== undefined) this.pendingExpire.push(idx);
    return idx;
  }
}

/** Faction id → the 3-bit wire slot. NEUTRAL is 0; the pack's order fixes the rest. */
let factionOrder: string[] = [];
/**
 * Install the wire order from the content pack. Called once, from the service's constructor,
 * which runs at import time because the service is a module singleton.
 *
 * NEUTRAL is forced into slot 0. The pack validator requires that faction to exist but says
 * nothing about where it sits, and an unrecognised faction also maps to 0, so the two have to
 * mean the same thing to a client. Eight slots is a hard ceiling from the wire format — the
 * row's flag byte gives the faction three bits — so a pack listing more than eight factions in
 * total loses the extras here and draws their members as neutral. Nothing warns about it: the
 * schema caps nothing above a minimum of two.
 */
export function setFactionOrder(ids: string[]): void {
  factionOrder = ['NEUTRAL', ...ids.filter((f) => f !== 'NEUTRAL')].slice(0, 8);
}
/** Missing, unknown, and truncated-past-slot-seven all collapse to 0, which the client draws as NEUTRAL. */
export function factionIndex(faction: string | null | undefined): number {
  if (!faction) return 0;
  const i = factionOrder.indexOf(faction);
  return i < 0 ? 0 : i;
}
/** The inverse, for a decoded row. Nothing in this tree calls it — `decodeRows` returns the raw index. */
export function factionAt(index: number): string {
  return factionOrder[index] ?? 'NEUTRAL';
}
