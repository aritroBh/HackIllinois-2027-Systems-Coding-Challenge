/**
 * Presence service (plan §A4): the 1 Hz tick, the session registry, the on-duty roster
 * cache, and the degradation trigger.
 *
 * One instance serves the event. Positions live only in `presenceStore` (never persisted);
 * mutes live in `presenceMutes` with a TTL; every exact read by a lead or by dispatch is
 * audited by its caller. Presence never grants karma — `awardKarma` has no presence source.
 */
import { PresenceSession, setFactionOrder } from './session';
import type { PresenceClient } from './transport';
import { Cohort, presenceStore, PresenceStore, Sample } from './store';
import { PresenceMute } from '../models/presenceMute.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { Volunteer, AccountKind } from '../models/volunteer.model';
import { pack } from '../content/loader';
import { env } from '../config/env';
import { LEAD_ROLES, AccountRole } from '../common/types/account';

const TICK_MS = 1000;
const SNAPSHOT_EVERY_MS = 15_000;
/**
 * The SSE fallback's row cut, against the pack's `maxDetail` (sixty in the shipped pack) for a
 * WebSocket.
 *
 * A JSON row is seven values inside a text frame where a binary row is eight bytes, and the
 * fallback owns no connection of its own — its frames go out on the account's existing event
 * stream, alongside everything else that stream carries. The session applies this as its
 * `detailCap`, and the cohort is built from the same figure through `effectiveCap`, so the
 * cluster counts a fallback client receives exclude exactly the people it is sent as rows and
 * nobody falls between the two.
 */
const JSON_DETAIL_CAP = 40;
const ROSTER_REFRESH_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
/**
 * The load ladder's thresholds, in milliseconds of CPU spent building one tick's frames.
 *
 * These are budgets against a one-second cadence, not against a frame time. Two hundred
 * milliseconds is a fifth of the second spent on presence, which is where the process starts
 * to feel it elsewhere; five hundred is where it is clearly the bottleneck and cluster counts
 * are better than a map that stutters. Recovery is deliberately far below the first rung so
 * the ladder does not oscillate around a threshold.
 */
const HALVE_MS = 200;
const CLUSTER_MS = 500;
const RECOVER_MS = 120;
const RECOVER_HOLD_MS = 10_000;
/**
 * How long one slice may run before yielding to the event loop.
 *
 * Eight milliseconds is about half a display frame and well under the latency anyone notices
 * on an HTTP request. Smaller slices would yield more often and spend more of the tick in
 * scheduling overhead than in work.
 */
const SLICE_BUDGET_MS = 8;
/** How long an account's facts stay usable before a re-read. */
const FACT_TTL_MS = 30_000;
/** The coalescing window for batched fact reads: one macrotask, not a real delay. */
const FACT_BATCH_MS = 0;
const MUTE_SWEEP_MS = 5_000;

/**
 * Everything the tick and the sample gates need to know about an account, assembled from three
 * sources with three different freshnesses.
 *
 * The account document itself is cached for `FACT_TTL_MS`; `onDuty` comes from the roster
 * sweep and is at most `ROSTER_REFRESH_MS` old; `muteUntil` comes from the mute sweep and is at
 * most `MUTE_SWEEP_MS` old. `factsFor` overlays the latter two onto a cache hit rather than
 * returning the copies frozen into it, because both are the kind of fact that has to bite
 * sooner than half a minute.
 *
 * There is no negative caching: an account this returns null for is re-read on the next miss.
 * A null is treated as opted out everywhere it is consumed, which is the safe direction for a
 * deleted account and for a database that blinked.
 */
export interface AccountFacts {
  id: string;
  name: string;
  kind: 'VOLUNTEER' | 'HACKER';
  role: string;
  faction: string | null;
  avatarHash: string | null;
  optIn: boolean;
  onDuty: boolean;
  muteUntil: number;
  /**
   * The account's *current* session version, compared each tick against the one the socket
   * connected with. `evictRevoked()`, called at the top of every `tick()`, is what closes the
   * socket when the two disagree — which is how a revoked session stops receiving the map even
   * if it never sends anything again.
   */
  sessionVersion: number;
}

/**
 * Real-time presence orchestration service managing active volunteer socket sessions,
 * high-frequency tick broadcasting, spatial quantization, adaptive load shedding, and presence audits.
 */
export class PresenceService {
  private sessions = new Map<string, PresenceSession>();
  /**
   * accountId → the client ids it holds. Without it, deciding whether a disconnecting client
   * was the account's last one meant walking every session, which is a linear scan on a path
   * that runs once per disconnect. At five thousand clients a reconnect storm turns that into
   * millions of comparisons for an answer two set operations already have.
   */
  private byAccount = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private tickNo = 0;
  private slowTicks = 0;
  private fastSince = 0;
  private clusterMode = false;
  /** 0 = full detail, 1 = half the ring, 2 = cluster counts only. See `setRung`. */
  private rung: 0 | 1 | 2 = 0;
  private detailBudget = Number.POSITIVE_INFINITY;
  /** True while a tick is still slicing, so the next timer fire skips rather than overlaps. */
  private inFlight = false;
  /** accountId → on duty, refreshed every 30 s from the roster. */
  private onDuty = new Map<string, boolean>();
  private rosterAt = 0;
  private facts = new Map<string, AccountFacts>();
  /**
   * Accounts whose cached facts were explicitly thrown away and not yet re-read.
   *
   * `invalidate()` used to only delete, and the tick only acts when it *has* facts — so
   * invalidating an account removed the very evidence that would have demoted its live
   * session. A lead demoted mid-event kept lead vision on an open socket for as long as they
   * held it, which is the exact case `invalidate` was added for and the one it could not
   * reach. Membership here means "assume nothing until the re-read lands", and a session in
   * that state loses the privilege rather than keeping it.
   */
  private pendingRevalidate = new Set<string>();
  /** Boot timestamp; the denominator under every uptime and rate the health endpoint reports. */
  public readonly startedAt = Date.now();
  /** Tick telemetry, spread into `GET /health`: counts, timings, and the load-ladder rung. */
  public stats = {
    ticks: 0, lastTickMs: 0, p95TickMs: 0, rowsLastTick: 0, sessions: 0, clusterMode: false,
    bytesLastTick: 0,
    /** Distinct cohorts computed this tick. The ratio of sessions to cohorts is the win. */
    cohortsLastTick: 0,
    /** Accounts whose facts were fetched in the last coalesced batch. */
    factBatchLast: 0,
    /** Ticks skipped because the previous one was still slicing. The overload signal. */
    skippedTicks: 0,
    /** Current rung of the load ladder: 0 full, 1 reduced, 2 clusters only. */
    rung: 0 as 0 | 1 | 2,
  };
  private tickSamples: number[] = [];

  /**
   * Accounts whose facts are being fetched right now, and the promise each caller is waiting
   * on. Five thousand phones sampling every five seconds miss the thirty-second cache at a
   * steady thousand accounts a second; issuing a `findById` per miss turns presence into the
   * database's busiest client for no reason, because the misses arrive in bursts of hundreds
   * that one `$in` answers. `inFlight` also collapses the duplicate lookups a single account's
   * two devices would otherwise both make.
   */
  private pendingFacts = new Map<string, Array<(f: AccountFacts | null) => void>>();
  private factFlushTimer: NodeJS.Timeout | null = null;
  /** accountId → mute expiry, swept from the (small) collection rather than read per account. */
  private mutes = new Map<string, number>();
  private mutesAt = 0;

  /** Defaults to the shared store; a test may inject its own. */
  constructor(private readonly store: PresenceStore = presenceStore) {
    setFactionOrder(pack.factions.map((f) => f.id));
  }

  /**
   * Start the 1 Hz tick. Idempotent, and a no-op when presence is disabled.
   *
   * Both guards matter for the same reason: `createServer` calls this, and a process that
   * builds a second server must not end up with two timers ticking the same session map.
   * The interval is `unref`'d so the tick alone never keeps the process alive; a server that
   * has closed should exit even if `stop` was somehow missed.
   */
  start(): void {
    if (this.timer || !env.PRESENCE_ENABLED) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Stop ticking and hang up on everybody, with 1001 (going away) so a client knows to retry
   * rather than to treat it as a refusal.
   *
   * Process-wide, not per-server: `server.ts` registers this on one server's `close`, and
   * because the service is a module singleton, closing any server stops presence for all of
   * them. The sessions are dropped from this map, but each transport keeps bookkeeping of its
   * own: the WebSocket leg unwinds `bySlot` and releases the stream slot from the socket's own
   * `close` handler, while the SSE leg's `byAccount` is not touched by a close at all — see
   * `SsePresenceClient.close`.
   */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sessions.values()) s.client.close(1001, 'server shutting down');
    this.sessions.clear();
    this.byAccount.clear();
    // Any slice still queued will find an empty session map and an empty queue filter, so it
    // finishes harmlessly; clearing the flag is what lets a restarted service tick again.
    this.inFlight = false;
    if (this.factFlushTimer) { clearTimeout(this.factFlushTimer); this.factFlushTimer = null; }
  }

  /** Total number of currently connected presence client sessions. */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** Register a connected client. The transport has already authenticated it. */
  add(client: PresenceClient): PresenceSession {
    const session = new PresenceSession(client, this.store, { snapshotEveryMs: SNAPSHOT_EVERY_MS, jsonDetailCap: JSON_DETAIL_CAP });
    this.sessions.set(client.id, session);
    const held = this.byAccount.get(session.accountId);
    if (held) held.add(client.id);
    else this.byAccount.set(session.accountId, new Set([client.id]));
    this.stats.sessions = this.sessions.size;
    // A client that never says hello is closed: it is either a probe or a broken client.
    setTimeout(() => {
      const live = this.sessions.get(client.id);
      if (live && !live.helloAt) live.client.close(4401, 'no hello');
    }, HELLO_TIMEOUT_MS).unref?.();
    return session;
  }

  /** Deregister a connected client session and clean up account tracking when last session drops. */
  remove(clientId: string): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    this.sessions.delete(clientId);
    this.stats.sessions = this.sessions.size;
    // The entry survives a reconnect (positions are ephemeral and re-sent within 5 s); it is
    // dropped only when no other session for that account remains.
    const held = this.byAccount.get(s.accountId);
    held?.delete(clientId);
    if (!held || held.size === 0) {
      this.byAccount.delete(s.accountId);
      this.store.remove(s.accountId);
    }
  }

  /**
   * Every live session for one account — a phone and a laptop are two. Nothing in this tree
   * calls it; the tick reaches sessions through its own map and the eviction paths work from a
   * client id.
   */
  sessionsFor(accountId: string): PresenceSession[] {
    const ids = this.byAccount.get(accountId);
    if (!ids) return [];
    const out: PresenceSession[] = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Account facts for a sample: opt-in, faction, avatar, and whether the volunteer is on shift.
   *
   * The two sweeps are kicked from here rather than from a timer of their own, so the roster
   * and the mute map are refreshed by the traffic that needs them and a quiet server does no
   * work. Both are self-throttling on their own intervals, so calling them per sample is a
   * clock comparison in the common case.
   *
   * A cache hit is not returned as it was stored: `onDuty` and `muteUntil` are overlaid from
   * the sweeps, which are fresher than the thirty-second fact. Everything else — name, role,
   * faction, avatar hash, opt-in — can be up to `FACT_TTL_MS` stale, which is why a demotion
   * calls `invalidate` rather than waiting for the cache to turn over.
   */
  async factsFor(accountId: string, nowMs = Date.now()): Promise<AccountFacts | null> {
    await this.refreshRoster(nowMs);
    await this.refreshMutes(nowMs);
    const cached = this.facts.get(accountId);
    if (cached && nowMs - (cached as AccountFacts & { at?: number }).at! < FACT_TTL_MS) {
      return {
        ...cached,
        onDuty: this.onDuty.get(accountId) ?? cached.onDuty,
        // The mute sweep is fresher than the cached fact and is the authority on silence, so
        // a cache hit must not resurrect somebody the speed gate muted a moment ago.
        muteUntil: this.mutes.get(accountId) ?? 0,
      };
    }
    return this.loadFacts(accountId, nowMs);
  }

  /**
   * Queue one account for the next batched read and hand back a promise for it.
   *
   * The window is deliberately one macrotask rather than a fixed delay: everything that missed
   * the cache in this tick's burst of samples joins the same `$in`, and nothing waits longer
   * than the event loop already makes it wait. A per-account `findById` would be correct and
   * would also be a thousand round trips a second at full attendance.
   */
  private loadFacts(accountId: string, nowMs: number): Promise<AccountFacts | null> {
    return new Promise((resolve) => {
      const waiting = this.pendingFacts.get(accountId);
      if (waiting) { waiting.push(resolve); return; }
      this.pendingFacts.set(accountId, [resolve]);
      if (!this.factFlushTimer) {
        this.factFlushTimer = setTimeout(() => { void this.flushFacts(nowMs); }, FACT_BATCH_MS);
        this.factFlushTimer.unref?.();
      }
    });
  }

  /**
   * Run the coalesced batch: one `$in` for everybody who missed the cache in this window.
   *
   * `pendingFacts` is swapped for a fresh map before the await, so a miss arriving while the
   * query is in flight starts the next batch instead of joining one that has already been
   * sent and would never resolve it.
   *
   * An account the query does not return resolves null and is **not** cached as absent. A
   * deleted or never-existing id therefore costs a read on every miss, which is the price of
   * never caching a negative for a document that is about to be created — and null is read as
   * opted out everywhere, so the cost is a query rather than a wrong answer.
   */
  private async flushFacts(nowMs: number): Promise<void> {
    this.factFlushTimer = null;
    const batch = this.pendingFacts;
    this.pendingFacts = new Map();
    if (batch.size === 0) return;
    const ids = [...batch.keys()];
    this.stats.factBatchLast = ids.length;
    let docs: Array<{ _id: unknown; name: string; kind?: string; role?: unknown; faction?: string | null; avatarHash?: string | null; presenceOptIn?: boolean; sessionVersion?: number }> = [];
    try {
      docs = await Volunteer.find({ _id: { $in: ids } })
        .select('name kind role faction avatarHash presenceOptIn sessionVersion')
        .lean();
    } catch {
      // A read failure resolves every waiter as unknown rather than leaving them pending. An
      // unknown account is treated as opted out, which is the safe direction: nobody is
      // published because the database blinked.
      for (const resolvers of batch.values()) for (const r of resolvers) r(null);
      return;
    }
    const found = new Map<string, (typeof docs)[number]>();
    for (const d of docs) found.set(String(d._id), d);
    const at = Date.now();
    for (const [id, resolvers] of batch) {
      const doc = found.get(id);
      let facts: AccountFacts | null = null;
      if (doc) {
        const built: AccountFacts & { at: number } = {
          id,
          name: doc.name,
          kind: (doc.kind ?? AccountKind.VOLUNTEER) as 'VOLUNTEER' | 'HACKER',
          role: String(doc.role),
          sessionVersion: doc.sessionVersion ?? 0,
          faction: doc.faction ?? null,
          avatarHash: doc.avatarHash ?? null,
          optIn: !!doc.presenceOptIn,
          onDuty: this.onDuty.get(id) ?? false,
          muteUntil: this.mutes.get(id) ?? 0,
          at,
        };
        this.facts.set(id, built);
        facts = built;
      }
      for (const r of resolvers) r(facts);
    }
    void nowMs;
  }

  /**
   * Sweep the whole mute collection into a map every few seconds.
   *
   * Mutes are rare — only the speed gate writes one, and it expires in a minute — so the
   * collection is tens of documents even at full attendance. Reading it whole on a timer is
   * strictly cheaper than the per-account `findOne` this replaces, which ran on every cache
   * miss for every account whether or not it had ever been muted.
   */
  private async refreshMutes(nowMs: number): Promise<void> {
    if (nowMs - this.mutesAt < MUTE_SWEEP_MS) return;
    this.mutesAt = nowMs;
    try {
      const rows = await PresenceMute.find({ until: { $gt: new Date(nowMs) } }).select('accountId until').lean();
      const next = new Map<string, number>();
      for (const r of rows as Array<{ accountId: unknown; until: Date }>) {
        next.set(String(r.accountId), new Date(r.until).getTime());
      }
      this.mutes = next;
      // Feed the store too. Its copy is the one the gate consults on a sample, and it is the
      // one that survives a disconnect, so a mute written by another process (or before a
      // restart) has to reach it.
      for (const [id, until] of next) this.store.applyMute(id, until);
    } catch {
      /* a sweep failure leaves the previous map standing; a stale mute errs towards silence */
    }
  }

  /**
   * Close any socket whose session has been revoked since it connected.
   *
   * Revocation has to end the connection, not merely demote it. Every HTTP route re-verifies
   * the session cookie per request, and the SSE hub evicts on its heartbeat when
   * `sessionVersion` moves. This transport had neither — nothing under `src/presence/`
   * referenced `sessionVersion` at all — so a socket authenticated once at the upgrade
   * handshake kept publishing its position and receiving the map for as long as it stayed
   * open, through a revocation, a sign-out elsewhere, or an expiry.
   *
   * `invalidate()` is what made that hard to notice: it took the lead *privilege* away, so the
   * visible symptom of a demotion was handled while the connection itself survived.
   *
   * `client.account` is the context the upgrade resolved, so its `sessionVersion` is the one
   * the socket was granted on. Exactly two things bump that number: `AuthService.revoke`,
   * behind `POST /auth/revoke/:id`, and `AuthService.logout`, the sign-out-everywhere. A role
   * change is *not* one of them — `setRole` writes the new role and leaves `sessionVersion`
   * alone — so a demotion is handled by `invalidate` and the tick's `setLead(false)` rather
   * than here.
   *
   * And only the revoke half of that actually reaches this method today, because the
   * comparison is against `this.facts`, which nothing refreshes on its own: `revoke` calls
   * `invalidate`, which drops the cached copy and re-reads it, while `logout` does not. A
   * watcher that has signed out and never samples again keeps the pre-bump copy cached
   * indefinitely, the two numbers agree, and its socket survives.
   *
   * Public, and called from the tick, because the SSE hub's `reauthorise()` is public for the
   * same reason: an invariant this important is one a test should be able to drive directly.
   *
   * Returns the number of sessions closed.
   */
  public evictRevoked(): number {
    let closed = 0;
    for (const s of [...this.sessions.values()]) {
      const known = this.facts.get(s.accountId);
      if (!known || known.sessionVersion === s.client.account.sessionVersion) continue;
      s.client.close(4401, 'session revoked');
      this.remove(s.client.id);
      closed += 1;
    }
    return closed;
  }

  /**
   * Drop a cached fact (opt-in toggled, avatar changed, faction changed, role changed).
   *
   * Deleting is only half of it, and the half that was once missing is `pendingRevalidate` —
   * see that field. An account whose facts are gone is treated as unprivileged until they come
   * back, which is the right direction for the callers this actually has: role changes and
   * sign-outs, where guessing the other way for a tick is a disclosure.
   *
   * Those callers are the auth controller's `revoke` and `setRole` — the two routes that make
   * an open socket's privileges wrong — the opt-in toggle on `PATCH /me/presence`, and the
   * avatar service at both ends of an avatar's life: a new hash that would otherwise take half
   * a minute to reach the wire, and a takedown that would otherwise keep being announced for
   * just as long.
   */
  invalidate(accountId: string): void {
    this.facts.delete(accountId);
    this.pendingRevalidate.add(accountId);
    // Kick the re-read rather than waiting for the account to sample again. A lead watching
    // the map from a laptop sends no positions at all, so "the next sample" may never come,
    // and without this the fail-closed state above would be permanent for exactly the people
    // most likely to be in it. A failure here is not fatal: the session stays demoted until a
    // later read succeeds, which is the safe direction.
    void this.factsFor(accountId).catch(() => undefined);
  }

  /**
   * Who is on shift right now, rebuilt whole every thirty seconds.
   *
   * This map is the one thing standing between an off-duty volunteer and every player's map,
   * so read the two ways into it carefully. A CONFIRMED registration counts only inside its
   * shift's window plus fifteen minutes either side — the arrival and the tidy-up. A
   * CHECKED_IN one counts with no time test at all: the checkout scan is what moves it to
   * COMPLETED, so a volunteer who never scans out stays on duty, and visible to players, until
   * something else moves that registration. That errs generous — right for someone still
   * working past the end of their shift, wrong for someone who simply went home.
   *
   * A failed read leaves the previous map standing rather than emptying it: a database blip
   * should not clear the campus of every volunteer at once, and thirty seconds later it tries
   * again.
   */
  private async refreshRoster(nowMs: number): Promise<void> {
    if (nowMs - this.rosterAt < ROSTER_REFRESH_MS) return;
    this.rosterAt = nowMs;
    try {
      const regs = await Registration.find({ status: { $in: [RegistrationStatus.CHECKED_IN, RegistrationStatus.CONFIRMED] } })
        .select('volunteerId shiftId status')
        .populate('shiftId', 'startTime endTime')
        .lean();
      const next = new Map<string, boolean>();
      for (const r of regs as Array<{ volunteerId: unknown; status: string; shiftId?: { startTime?: Date; endTime?: Date } }>) {
        const shift = r.shiftId;
        const within = shift?.startTime && shift?.endTime
          ? nowMs >= new Date(shift.startTime).getTime() - 15 * 60_000 && nowMs <= new Date(shift.endTime).getTime() + 15 * 60_000
          : false;
        if (r.status === RegistrationStatus.CHECKED_IN || within) next.set(String(r.volunteerId), true);
      }
      this.onDuty = next;
    } catch {
      /* a roster read failure must not stop the tick; the previous map stands */
    }
  }

  /**
   * Accept one position sample; returns the store's verdict.
   *
   * An account the facts read cannot resolve is answered `OPT_OUT` rather than a not-found,
   * and the store never sees the sample. That covers a deleted account and, because a failed
   * batch read resolves every waiter as null, a database that blinked as well — presence
   * fails closed, publishing nobody, rather than open.
   */
  async submit(accountId: string, sample: Sample, nowMs = Date.now()) {
    const facts = await this.factsFor(accountId, nowMs);
    if (!facts) return { ok: false as const, reason: 'OPT_OUT' as const };
    return this.store.update(facts, sample, nowMs);
  }

  /**
   * One tick, sliced across the second rather than run as a single block.
   *
   * At five thousand watchers the frame-building work is tens of milliseconds. That is a small
   * fraction of a one-second cadence, but done in one go it is also tens of milliseconds during
   * which no HTTP request, no WebSocket message and no database callback runs — once a second,
   * for the whole event. Slicing keeps the same total work and the same cadence while bounding
   * any single block to roughly `SLICE_BUDGET_MS`, so the worst latency presence adds to an
   * unrelated request is a slice rather than a tick.
   *
   * **Roughly, not exactly, and the difference is measurable.** The elapsed check runs once
   * every thirty-two sessions rather than every one (see the loop below) because `hrtime` is
   * syscall-shaped and reading it five thousand times a tick would cost a real share of the
   * budget it polices. So a slice can run past 8 ms before the next check sees it: the longest
   * contiguous block measured is 12.2 ms scattered and 9.4-10.8 ms clustered, recorded in
   * `docs/PRESENCE.md`. Size event-loop latency against ~12 ms, not against 8.
   *
   * This docblock said "capping any single block at `SLICE_BUDGET_MS`" while `docs/DEMO.md` and
   * `docs/WORKFLOWS.md` — which derive from it — had already been corrected to say the opposite.
   * The source of a claim is the last place the correction reaches and the first place the next
   * reader looks.
   *
   * The shared index and the cohort cache are built once, at the top, and reused by every
   * slice. That is safe because positions are promoted exactly once per tick (`store.tick`
   * above) and nothing else moves them: a slice running twenty milliseconds later sees the
   * same world the first slice did, which is also what keeps every client's frame consistent
   * with every other client's.
   */
  private tick(sync = false): void {
    if (this.inFlight) {
      // The previous tick has not finished slicing. Skipping is the honest response: doubling
      // up would interleave two worlds, and queueing would grow without bound. This counter is
      // the overload signal the soak watches, because it means the second was genuinely full.
      this.stats.skippedTicks += 1;
      return;
    }
    const t0 = Date.now();
    this.tickNo += 1;
    // Before any frame is built: a socket whose session was revoked gets no more of them.
    //
    // This belongs here and not in `factsFor`, where it was first put by mistake. `factsFor` is
    // reached when an account *samples* or says hello, so a revoked publisher would have been
    // evicted — but a revoked **watcher**, a lead with the map open who sends nothing, never
    // calls it and would have kept receiving everybody's positions indefinitely. That watcher
    // is the half of the bug that mattered, and the half the misplaced call missed.
    this.evictRevoked();
    const { expired } = this.store.tick(t0);
    if (expired.length) {
      for (const s of this.sessions.values()) for (const id of expired) s.forget(id, this.tickNo);
    }

    // One pass over the store, then one cohort per occupied cell per audience, reused by every
    // client standing in it. This is the change that makes five thousand clients a linear cost
    // rather than a quadratic one: the expensive part (walking the interest span, ranking
    // candidates, counting clusters) no longer happens per connection.
    const index = this.store.buildIndex(t0);
    const cohorts = new Map<string, Cohort>();
    const mpu = this.store.cfg.metersPerUnit;
    const radius = this.store.cfg.interestRadiusMeters;
    const queue = [...this.sessions.values()];

    this.inFlight = true;
    let cursor = 0;
    let rows = 0;
    let workMs = 0;

    const runSlice = (): void => {
      const sliceStart = process.hrtime.bigint();
      while (cursor < queue.length) {
        const s = queue[cursor++];
        // A session removed since the queue was taken must not be sent to.
        if (!this.sessions.has(s.client.id)) continue;
        s.clusterOnly = this.clusterMode;
        s.detailBudget = this.detailBudget;
        // A demotion has to bite now, not at the next reconnect. The facts are already cached
        // for anybody who has sampled recently, so this costs a map lookup; an account we have
        // not seen keeps the flag its session cookie arrived with, which is the same answer.
        const known = this.facts.get(s.accountId);
        if (known) {
          s.setLead(LEAD_ROLES.has(known.role as AccountRole));
          this.pendingRevalidate.delete(s.accountId);
        } else if (this.pendingRevalidate.has(s.accountId)) {
          // Somebody changed this account's role and the re-read has not landed. Drop the
          // privilege now; the refresh started by `invalidate` restores it within a tick or
          // two if the change was a promotion rather than a demotion. Losing a privilege has
          // to be immediate even though gaining one can wait.
          s.setLead(false);
        }
        try {
          let cohort: Cohort | null = null;
          const me = this.store.get(s.accountId);
          if (me && !Number.isNaN(me.fx)) {
            // Three things decide what a cohort contains: where you stand, whether you may see
            // off-duty volunteers, and how many rows you will actually be sent. Everything
            // else about a client is per-connection bookkeeping the session still does itself.
            //
            // The third is the EFFECTIVE cap — the transport's ceiling and the load ladder's
            // budget, whichever is smaller — not the transport's alone. The cohort's counts
            // exclude the people it selects for detail, so building it at a cap larger than
            // the session sends left the difference in neither the rows nor the counts: on the
            // middle rung, thirty neighbours vanished from the map.
            const cap = s.effectiveCap();
            const key = `${me.cell}|${s.lead ? 1 : 0}|${cap}`;
            cohort = cohorts.get(key) ?? null;
            if (!cohort) {
              cohort = this.store.cohort(me.cell, radius, s.lead, cap, index);
              cohorts.set(key, cohort);
            }
          }
          rows += s.send(this.tickNo, t0, mpu, cohort);
        } catch {
          this.remove(s.client.id);
        }
        // Check the clock every thirty-two sessions rather than every one: `hrtime` is a
        // syscall-shaped cost, and at five thousand sessions reading it each time would be a
        // measurable share of the very budget it is policing.
        if (!sync && (cursor & 31) === 0 && Number(process.hrtime.bigint() - sliceStart) / 1e6 >= SLICE_BUDGET_MS) break;
      }
      workMs += Number(process.hrtime.bigint() - sliceStart) / 1e6;

      if (cursor < queue.length) {
        setImmediate(runSlice);
        return;
      }
      this.inFlight = false;
      this.stats.cohortsLastTick = cohorts.size;
      this.finishTick(t0, workMs, rows);
    };

    runSlice();
  }

  /**
   * Book-keeping and the load ladder, once every slice of a tick has run.
   *
   * `workMs` is the CPU actually spent building frames, not the wall-clock span the slices were
   * spread over. Judging load by wall clock would punish presence for whatever else the process
   * was doing between slices, which is exactly backwards: the point of slicing is to let that
   * other work through.
   */
  private finishTick(t0: number, workMs: number, rows: number): void {
    this.stats.ticks = this.tickNo;
    this.stats.lastTickMs = workMs;
    this.stats.rowsLastTick = rows;
    this.stats.sessions = this.sessions.size;
    this.tickSamples.push(workMs);
    if (this.tickSamples.length > 120) this.tickSamples.shift();
    const sorted = [...this.tickSamples].sort((a, b) => a - b);
    this.stats.p95TickMs = sorted[Math.floor(sorted.length * 0.95)] ?? workMs;

    // The load ladder. Two consecutive ticks over the halve threshold cut the detail budget;
    // two more over the cluster threshold drop to counts only. Recovery climbs back one rung
    // at a time after ten seconds of comfortable ticks, so a single busy moment does not strand
    // the event on the bottom rung for the rest of the night.
    if (workMs > CLUSTER_MS) {
      this.slowTicks += 1;
      this.fastSince = 0;
      if (this.slowTicks >= 2) this.setRung(2);
    } else if (workMs > HALVE_MS) {
      this.slowTicks += 1;
      this.fastSince = 0;
      if (this.slowTicks >= 2 && this.rung < 1) this.setRung(1);
    } else {
      this.slowTicks = 0;
      if (workMs < RECOVER_MS) {
        if (!this.fastSince) this.fastSince = t0;
        if (this.rung > 0 && t0 - this.fastSince >= RECOVER_HOLD_MS) {
          this.setRung(this.rung - 1);
          this.fastSince = t0;
        }
      } else {
        this.fastSince = 0;
      }
    }
    void this.stats.bytesLastTick;
  }

  /**
   * Move to a rung of the load ladder and tell every client what changed.
   *
   * Clients are told because the map has to say so. A player whose neighbours have silently
   * stopped appearing should see "showing crowd counts only", not conclude the campus emptied.
   */
  private setRung(next: 0 | 1 | 2 | number): void {
    const rung = Math.max(0, Math.min(2, next)) as 0 | 1 | 2;
    if (rung === this.rung) return;
    const climbing = rung < this.rung;
    this.rung = rung;
    this.clusterMode = rung === 2;
    this.detailBudget = rung === 0 ? Number.POSITIVE_INFINITY : rung === 1 ? Math.ceil(this.store.cfg.maxDetail / 2) : 0;
    this.stats.clusterMode = this.clusterMode;
    this.stats.rung = rung;
    const mode = rung === 0 ? 'full' : rung === 1 ? 'reduced' : 'clusters';
    for (const s of this.sessions.values()) {
      // Only a CLIMB needs a snapshot. Coming back up, the sessions have stopped tracking who
      // they sent, so a delta against a half-remembered world would leave gaps on the map.
      //
      // Stepping DOWN needs nothing, and asking for one was actively harmful: the ladder drops
      // a rung precisely because the tick is already over budget, and flagging every session
      // for a full snapshot then made the very next tick send five thousand of them — rows,
      // joins and clusters for everybody — which is the spike that forced the next rung down.
      // The mechanism meant to shed load created the largest burst of the event.
      if (climbing) s.requestResync();
      s.client.send({ t: 'notice', mode });
    }
  }

  /**
   * Run one whole tick synchronously.
   *
   * Tests and the benchmark need the tick to be finished when the call returns; slicing exists
   * for the production event loop, not for a harness that has nothing else to do. Passing the
   * flag rather than exposing two code paths keeps the thing under test the thing that ships.
   */
  tickNow(): void {
    this.tick(true);
  }
}

export const presenceService = new PresenceService();
