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

  /** Remember a mute read back from the collection (reconnect path). */
  applyMute(id: string, until: number): void {
    const e = this.entries.get(id);
    if (e) e.muteUntil = until;
  }

  isMuted(id: string, nowMs: number = Date.now()): boolean {
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
    const muteUntil = Math.max(e?.muteUntil ?? 0, who.muteUntil ?? 0);
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
    for (const e of this.entries.values()) {
      if (e.kind !== 'VOLUNTEER' || !e.onDuty) continue;
      const ageMs = nowMs - e.t;
      if (ageMs > maxAgeMs) continue;
      out.push({ e, distanceM: Math.hypot(e.x - x, e.z - z) * this.cfg.metersPerUnit, ageMs });
    }
    out.sort((a, b) => a.distanceM - b.distanceM);
    return out.slice(0, limit);
  }

  /** Test/ops hook. */
  clear(): void {
    this.entries.clear();
    this.cells.clear();
  }
}

export const presenceStore = new PresenceStore();
