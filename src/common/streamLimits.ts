/**
 * The one stream-limit table — shared by the SSE hub today and the presence WebSocket
 * later (plan A3/A4), so a device's two long-lived connections are counted in one place.
 *
 * Three ceilings, each sized against a different failure:
 *
 *  - **`TOTAL_SLOTS` = 2,600** is capacity: 1,200 accounts × 2 devices plus headroom. An
 *    unbounded map of live sockets is a memory-DoS with no authentication required, so the
 *    table refuses (`reason: 'TOTAL'`) rather than growing.
 *  - **`PER_ACCOUNT` = 2, across transports.** Phone + laptop both work. A third connection
 *    replaces the *oldest connection of the same transport* and never touches the other
 *    transport — a WebSocket reconnect must not tear down the SSE leg that is still
 *    delivering ops events. When an account is at its cap but has no connection of the
 *    incoming transport to replace, the connection is admitted rather than refused: the
 *    cap is enforced by replacement, never by a hard error to a client under its device
 *    quota (M4b counts cross-transport evictions and refusals as failures, not
 *    same-transport replacement). Worst case is therefore two per transport.
 *  - **`PER_IP` = 800** is an anti-abuse ceiling, not a capacity control. 1,200 people on
 *    venue Wi-Fi arrive from a handful of NAT egress addresses, so a per-IP figure low
 *    enough to matter against one attacker would lock out the venue. Addresses inside
 *    `TRUSTED_EGRESS_CIDRS` are exempt from PER_IP; everyone else gets 800, which still lets
 *    four egress IPs carry the whole event.
 *  - **Anonymous streams are boxed in separately** (`ANON_SLOTS` = 400 total,
 *    `ANON_PER_IP` = 20, applied even on trusted egress). Without an account there is
 *    nothing else to cap them by, and a single venue address could otherwise hold every
 *    slot and lock out signed-in users.
 *
 * Only IPv4 CIDRs are parsed (plus IPv4-mapped IPv6 `::ffff:a.b.c.d`, which is how Node
 * reports a v4 peer on a dual-stack listener). The venue's egress ranges are v4; an IPv6
 * literal in the list is ignored with a warning rather than failing boot.
 *
 * Everything here is in-memory and per-process, like the hub it serves. A second replica
 * would need its own table or an external one; the event runs one instance.
 */

import { env } from '../config/env';

export type StreamTransport = 'sse' | 'ws';

export interface SlotHandle {
  readonly id: number;
  readonly transport: StreamTransport;
  readonly accountId?: string;
  readonly ip: string;
  readonly acquiredAt: number;
}

export type AcquireRequest = {
  transport: StreamTransport;
  accountId?: string;
  ip: string;
};

export type AcquireResult =
  | { ok: true; slot: SlotHandle; evict?: SlotHandle }
  | { ok: false; reason: 'TOTAL' | 'PER_IP' | 'ANON' };

export interface StreamLimitStats {
  total: number;
  totalSlots: number;
  anonymous: number;
  anonSlots: number;
  byTransport: Record<StreamTransport, number>;
  accounts: number;
  ips: number;
}

export interface StreamLimitsOptions {
  totalSlots?: number;
  perAccount?: number;
  perIp?: number;
  /** Explicit trusted CIDR list; defaults to `TRUSTED_EGRESS_CIDRS` from the environment. */
  trustedCidrs?: string[];
  anonSlots?: number;
  anonPerIp?: number;
}

// ---------------------------------------------------------------------------
// IPv4 CIDR helpers (no dependency; the list is tiny and read once).
// ---------------------------------------------------------------------------

interface Cidr {
  base: number;
  mask: number;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** Strip the IPv4-mapped IPv6 prefix Node uses on dual-stack listeners. */
function normaliseIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Parse a comma-separated CIDR list. Bare addresses are treated as /32. Anything that is
 * not an IPv4 CIDR is dropped with a warning — a typo in an allow-list must not take the
 * process down, but it must not silently pass either.
 */
export function parseCidrList(raw: string | undefined): Cidr[] {
  if (!raw) return [];
  const out: Cidr[] = [];
  for (const entry of raw.split(',')) {
    const text = entry.trim();
    if (!text) continue;
    const [addr, bitsText = '32'] = text.split('/');
    const base = ipv4ToInt(addr);
    const bits = Number(bitsText);
    if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      console.warn(`⚠️  TRUSTED_EGRESS_CIDRS: ignoring "${text}" (only IPv4 CIDRs are supported).`);
      continue;
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    out.push({ base: (base & mask) >>> 0, mask });
  }
  return out;
}

export function ipInCidrs(ip: string | undefined, cidrs: readonly Cidr[]): boolean {
  if (!ip || cidrs.length === 0) return false;
  const n = ipv4ToInt(normaliseIp(ip));
  if (n === null) return false;
  return cidrs.some((c) => ((n & c.mask) >>> 0) === c.base);
}

let envCidrs: Cidr[] | null = null;

/** Trusted egress ranges from the validated environment, parsed once. */
export function trustedEgressCidrs(): readonly Cidr[] {
  if (envCidrs === null) envCidrs = parseCidrList(env.TRUSTED_EGRESS_CIDRS);
  return envCidrs;
}

export function isTrustedEgress(ip: string | undefined, cidrs: readonly Cidr[] = trustedEgressCidrs()): boolean {
  return ipInCidrs(ip, cidrs);
}

// ---------------------------------------------------------------------------
// The table.
// ---------------------------------------------------------------------------

export class StreamLimits {
  public static readonly TOTAL_SLOTS = 2600;
  public static readonly PER_ACCOUNT = 2;
  public static readonly PER_IP = 800;
  /** Anonymous streams (no account to cap them) share this small pool… */
  public static readonly ANON_SLOTS = 400;
  /** …and this per-IP cap, which applies even on trusted egress. */
  public static readonly ANON_PER_IP = 20;

  private readonly totalSlots: number;
  private readonly perAccount: number;
  private readonly perIp: number;
  private readonly anonSlots: number;
  private readonly anonPerIp: number;
  private readonly trusted: readonly Cidr[] | null;

  private nextId = 1;
  private anonCount = 0;
  private readonly slots = new Map<number, SlotHandle>();
  private readonly byAccount = new Map<string, SlotHandle[]>();
  private readonly byIp = new Map<string, number>();
  private readonly byIpAnon = new Map<string, number>();

  constructor(opts: StreamLimitsOptions = {}) {
    this.totalSlots = opts.totalSlots ?? StreamLimits.TOTAL_SLOTS;
    this.perAccount = opts.perAccount ?? StreamLimits.PER_ACCOUNT;
    this.perIp = opts.perIp ?? StreamLimits.PER_IP;
    this.anonSlots = opts.anonSlots ?? StreamLimits.ANON_SLOTS;
    this.anonPerIp = opts.anonPerIp ?? StreamLimits.ANON_PER_IP;
    this.trusted = opts.trustedCidrs ? parseCidrList(opts.trustedCidrs.join(',')) : null;
  }

  public tryAcquire(req: AcquireRequest): AcquireResult {
    const ip = normaliseIp(req.ip || 'unknown');

    // 1. Per-account replacement. Decided first because the evicted slot frees capacity
    //    that the TOTAL and PER_IP checks below must see, otherwise a full table would
    //    refuse a legitimate reconnect whose predecessor is about to be released anyway.
    let evict: SlotHandle | undefined;
    if (req.accountId) {
      const held = this.byAccount.get(req.accountId) ?? [];
      if (held.length >= this.perAccount) {
        // `held` is insertion-ordered, so the first same-transport entry is the oldest.
        evict = held.find((s) => s.transport === req.transport);
      }
    }

    const freed = evict ? 1 : 0;
    if (this.slots.size - freed >= this.totalSlots) {
      return { ok: false, reason: 'TOTAL' };
    }

    // 2. Anonymous connections have no account to cap them, so they draw from their own
    //    small pool and a per-IP cap that applies even on trusted egress. Otherwise one
    //    address on the venue NAT could hold every slot and lock out signed-in users.
    if (!req.accountId) {
      if (this.anonCount >= this.anonSlots) {
        return { ok: false, reason: 'ANON' };
      }
      if ((this.byIpAnon.get(ip) ?? 0) >= this.anonPerIp) {
        return { ok: false, reason: 'PER_IP' };
      }
    }

    const trustedIp = isTrustedEgress(ip, this.trusted ?? trustedEgressCidrs());
    if (!trustedIp) {
      const ipHeld = (this.byIp.get(ip) ?? 0) - (evict && evict.ip === ip ? 1 : 0);
      if (ipHeld >= this.perIp) {
        return { ok: false, reason: 'PER_IP' };
      }
    }

    if (evict) this.release(evict);

    const slot: SlotHandle = {
      id: this.nextId++,
      transport: req.transport,
      accountId: req.accountId,
      ip,
      acquiredAt: Date.now(),
    };
    this.slots.set(slot.id, slot);
    this.byIp.set(ip, (this.byIp.get(ip) ?? 0) + 1);
    if (slot.accountId) {
      const list = this.byAccount.get(slot.accountId);
      if (list) list.push(slot);
      else this.byAccount.set(slot.accountId, [slot]);
    } else {
      this.anonCount += 1;
      this.byIpAnon.set(ip, (this.byIpAnon.get(ip) ?? 0) + 1);
    }

    return evict ? { ok: true, slot, evict } : { ok: true, slot };
  }

  /** Idempotent: the hub releases on `close` and again on eviction paths without bookkeeping. */
  public release(slot: SlotHandle): void {
    if (!this.slots.delete(slot.id)) return;

    const ipCount = (this.byIp.get(slot.ip) ?? 1) - 1;
    if (ipCount <= 0) this.byIp.delete(slot.ip);
    else this.byIp.set(slot.ip, ipCount);

    if (slot.accountId) {
      const list = this.byAccount.get(slot.accountId);
      if (list) {
        const remaining = list.filter((s) => s.id !== slot.id);
        if (remaining.length === 0) this.byAccount.delete(slot.accountId);
        else this.byAccount.set(slot.accountId, remaining);
      }
    } else {
      this.anonCount = Math.max(0, this.anonCount - 1);
      const anonIp = (this.byIpAnon.get(slot.ip) ?? 1) - 1;
      if (anonIp <= 0) this.byIpAnon.delete(slot.ip);
      else this.byIpAnon.set(slot.ip, anonIp);
    }
  }

  public stats(): StreamLimitStats {
    const byTransport: Record<StreamTransport, number> = { sse: 0, ws: 0 };
    for (const slot of this.slots.values()) byTransport[slot.transport] += 1;
    return {
      total: this.slots.size,
      totalSlots: this.totalSlots,
      anonymous: this.anonCount,
      anonSlots: this.anonSlots,
      byTransport,
      accounts: this.byAccount.size,
      ips: this.byIp.size,
    };
  }
}

export const streamLimits = new StreamLimits();
