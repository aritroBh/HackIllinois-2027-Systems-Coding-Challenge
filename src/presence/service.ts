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
import { presenceStore, PresenceStore, Sample } from './store';
import { PresenceMute } from '../models/presenceMute.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { Volunteer, AccountKind } from '../models/volunteer.model';
import { pack } from '../content/loader';
import { env } from '../config/env';

const TICK_MS = 1000;
const SNAPSHOT_EVERY_MS = 15_000;
const JSON_DETAIL_CAP = 40;
const ROSTER_REFRESH_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
const DEGRADE_MS = 30;
const RECOVER_MS = 15;
const RECOVER_HOLD_MS = 10_000;

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
}

export class PresenceService {
  private sessions = new Map<string, PresenceSession>();
  private timer: NodeJS.Timeout | null = null;
  private tickNo = 0;
  private slowTicks = 0;
  private fastSince = 0;
  private clusterMode = false;
  /** accountId → on duty, refreshed every 30 s from the roster. */
  private onDuty = new Map<string, boolean>();
  private rosterAt = 0;
  private facts = new Map<string, AccountFacts>();
  public readonly startedAt = Date.now();
  public stats = { ticks: 0, lastTickMs: 0, p95TickMs: 0, rowsLastTick: 0, sessions: 0, clusterMode: false, bytesLastTick: 0 };
  private tickSamples: number[] = [];

  constructor(private readonly store: PresenceStore = presenceStore) {
    setFactionOrder(pack.factions.map((f) => f.id));
  }

  start(): void {
    if (this.timer || !env.PRESENCE_ENABLED) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sessions.values()) s.client.close(1001, 'server shutting down');
    this.sessions.clear();
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  /** Register a connected client. The transport has already authenticated it. */
  add(client: PresenceClient): PresenceSession {
    const session = new PresenceSession(client, this.store, { snapshotEveryMs: SNAPSHOT_EVERY_MS, jsonDetailCap: JSON_DETAIL_CAP });
    this.sessions.set(client.id, session);
    this.stats.sessions = this.sessions.size;
    // A client that never says hello is closed: it is either a probe or a broken client.
    setTimeout(() => {
      const live = this.sessions.get(client.id);
      if (live && !live.helloAt) live.client.close(4401, 'no hello');
    }, HELLO_TIMEOUT_MS).unref?.();
    return session;
  }

  remove(clientId: string): void {
    const s = this.sessions.get(clientId);
    if (!s) return;
    this.sessions.delete(clientId);
    this.stats.sessions = this.sessions.size;
    // The entry survives a reconnect (positions are ephemeral and re-sent within 5 s); it is
    // dropped only when no other session for that account remains.
    const stillHere = [...this.sessions.values()].some((o) => o.accountId === s.accountId);
    if (!stillHere) this.store.remove(s.accountId);
  }

  sessionsFor(accountId: string): PresenceSession[] {
    return [...this.sessions.values()].filter((s) => s.accountId === accountId);
  }

  /** Account facts for a sample: opt-in, faction, avatar, and whether the volunteer is on shift. */
  async factsFor(accountId: string, nowMs = Date.now()): Promise<AccountFacts | null> {
    await this.refreshRoster(nowMs);
    const cached = this.facts.get(accountId);
    if (cached && nowMs - (cached as AccountFacts & { at?: number }).at! < 30_000) {
      return { ...cached, onDuty: this.onDuty.get(accountId) ?? cached.onDuty };
    }
    const doc = await Volunteer.findById(accountId).select('name kind role faction avatarHash presenceOptIn').lean();
    if (!doc) return null;
    const mute = await PresenceMute.findOne({ accountId }).select('until').lean();
    const facts: AccountFacts & { at: number } = {
      id: accountId,
      name: doc.name,
      kind: (doc.kind ?? AccountKind.VOLUNTEER) as 'VOLUNTEER' | 'HACKER',
      role: String(doc.role),
      faction: doc.faction ?? null,
      avatarHash: doc.avatarHash ?? null,
      optIn: !!doc.presenceOptIn,
      onDuty: this.onDuty.get(accountId) ?? false,
      muteUntil: mute?.until ? new Date(mute.until).getTime() : 0,
      at: nowMs,
    };
    this.facts.set(accountId, facts);
    return facts;
  }

  /** Drop a cached fact (opt-in toggled, avatar changed, faction changed). */
  invalidate(accountId: string): void {
    this.facts.delete(accountId);
  }

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

  /** Accept one position sample; returns the store's verdict. */
  async submit(accountId: string, sample: Sample, nowMs = Date.now()) {
    const facts = await this.factsFor(accountId, nowMs);
    if (!facts) return { ok: false as const, reason: 'OPT_OUT' as const };
    return this.store.update(facts, sample, nowMs);
  }

  private tick(): void {
    const t0 = Date.now();
    this.tickNo += 1;
    const { expired } = this.store.tick(t0);
    if (expired.length) {
      for (const s of this.sessions.values()) for (const id of expired) s.forget(id, this.tickNo);
    }
    let rows = 0;
    const mpu = this.store.cfg.metersPerUnit;
    for (const s of this.sessions.values()) {
      s.clusterOnly = this.clusterMode;
      try {
        rows += s.send(this.tickNo, t0, mpu);
      } catch {
        this.remove(s.client.id);
      }
    }
    const dt = Date.now() - t0;
    this.stats.ticks = this.tickNo;
    this.stats.lastTickMs = dt;
    this.stats.rowsLastTick = rows;
    this.stats.sessions = this.sessions.size;
    this.tickSamples.push(dt);
    if (this.tickSamples.length > 120) this.tickSamples.shift();
    const sorted = [...this.tickSamples].sort((a, b) => a - b);
    this.stats.p95TickMs = sorted[Math.floor(sorted.length * 0.95)] ?? dt;

    // Degradation: two consecutive ticks over 30 ms → cluster-only for everyone; back to
    // full detail after 10 s of ticks under 15 ms.
    if (dt > DEGRADE_MS) {
      this.slowTicks += 1;
      this.fastSince = 0;
      if (this.slowTicks >= 2 && !this.clusterMode) {
        this.clusterMode = true;
        this.stats.clusterMode = true;
        for (const s of this.sessions.values()) s.client.send({ t: 'notice', mode: 'clusters' });
      }
    } else {
      this.slowTicks = 0;
      if (dt < RECOVER_MS) {
        if (!this.fastSince) this.fastSince = t0;
        if (this.clusterMode && t0 - this.fastSince >= RECOVER_HOLD_MS) {
          this.clusterMode = false;
          this.stats.clusterMode = false;
          for (const s of this.sessions.values()) { s.requestResync(); s.client.send({ t: 'notice', mode: 'full' }); }
        }
      } else {
        this.fastSince = 0;
      }
    }
  }

  /** Force one tick (tests). */
  tickNow(): void {
    this.tick();
  }
}

export const presenceService = new PresenceService();
