/**
 * Rotating QR attendance tokens.
 *
 * The fraud this defeats is mundane and effective: a volunteer screenshots their check-in
 * QR and sends it to a friend, who scans it from a phone across campus. A static token
 * cannot tell the two apart. So the token is bound to a 30-second *time slice* — it is
 * only valid inside the window it was minted in, plus or minus one slice.
 *
 * `version:volunteerId:shiftId:timeSlice:nonce`, base64url-encoded, dot, HMAC-SHA256 over
 * the same string. The signature covers every field, so none of them can be edited: swap
 * the shift id and the HMAC no longer verifies.
 *
 * **Why ±1 slice.** Clocks drift and a scan takes time. A strict single-slice window would
 * reject a token minted at 29.9 s into its slice and scanned 0.2 s later, which reads as a
 * broken scanner to the person at the desk.
 *
 * Be precise about what the tolerance costs, because the two numbers differ. Verification
 * accepts a token whose slice is within one of the current slice, so the acceptance
 * envelope spans three slices — 90 s wide. A given token's *usable life* is shorter than
 * that: minted at the start of its slice it survives 60 s, minted at the end, 30 s. The
 * backward half of the envelope only matters if a token is verified against a clock
 * behind the one that minted it, which within a single process it never is.
 *
 * **Replay is a separate problem from expiry**, and needs a separate defence: a token is
 * valid for up to a minute, so the same one can be presented twice inside its own window.
 * Two layers close that:
 *
 *  - An in-process nonce cache, deliberately *bounded*. It sweeps at most every 30 s and
 *    caps at `MAX_NONCES`, because an unbounded map that is scanned on every check-in is
 *    itself the attack — flood it with tokens and the O(n) sweep becomes the outage.
 *  - A unique index on `CheckIn.nonce`, which is the durable one. The in-process cache is
 *    empty after a restart and is not shared between replicas; the database constraint
 *    holds across both. The cache is an optimisation, the index is the guarantee.
 *
 * Nonces are 96-bit (`randomBytes(12)`). At 48 bits a birthday collision arrives around
 * 2^24 tokens, which is reachable over a weekend of scanning; at 96 it is around 2^48,
 * which is not.
 *
 * The secret comes from `QR_HMAC_SECRET`, which is ephemeral per boot outside production
 * and refuses to start on the committed default in production.
 */
import crypto from 'crypto';
import { env } from '../../config/env';

export interface ITokenPayload {
  version: number;
  volunteerId: string;
  shiftId: string;
  timeSlice: number;
  nonce: string;
}

export interface IVerificationResult {
  valid: boolean;
  reason?: 'EXPIRED' | 'INVALID_SIGNATURE' | 'REPLAY_ATTACK' | 'MALFORMED';
  volunteerId?: string;
  shiftId?: string;
  driftSlices?: number;
}

/**
 * Dynamic QR Code Cryptographic Engine.
 * Generates and validates time-windowed HMAC-SHA256 tokens that rotate every 30 seconds
 * to prevent screenshot sharing fraud at hackathon check-in desks.
 */
export class DynamicQrTokenEngine {
  public static readonly TIME_STEP_SECONDS = 30;
  public static readonly TOKEN_VERSION = 1;
  private static consumedNonces = new Map<string, number>();
  private static lastCleanAt = 0;
  // ponytail: bounded replay store — sweep at most every 30s and cap entries so the
  // O(n) scan can't be weaponized into CPU/memory DoS. (Multi-replica replay across
  // restarts is still covered by the DB unique index on CheckIn.nonce.)
  private static readonly MAX_NONCES = 5000;
  private static readonly CLEAN_INTERVAL_MS = 30000;

  /**
   * Generates a 30-second rotating cryptographic token.
   */
  public static generateToken(
    volunteerId: string,
    shiftId: string,
    timestampMs: number = Date.now(),
    secret: string = env.QR_HMAC_SECRET
  ): string {
    const timeSlice = Math.floor(timestampMs / 1000 / this.TIME_STEP_SECONDS);
    // 96-bit nonces: birthday collisions at ~2^48 tokens, not ~2^24 (old 6-byte).
    const nonce = crypto.randomBytes(12).toString('hex');
    const version = this.TOKEN_VERSION;

    const payloadString = `${version}:${volunteerId}:${shiftId}:${timeSlice}:${nonce}`;
    const payloadBase64 = Buffer.from(payloadString, 'utf8').toString('base64url');

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payloadString);
    const signature = hmac.digest('hex');

    return `${payloadBase64}.${signature}`;
  }

  /**
   * Verifies dynamic token with sliding window clock drift tolerance (default +-1 slice = +-30s).
   */
  public static verifyToken(
    token: string,
    driftToleranceSlices = 1,
    currentTimestampMs: number = Date.now(),
    secret: string = env.QR_HMAC_SECRET
  ): IVerificationResult {
    // Throttled sweep: the full-map scan runs at most every 30s (or when oversized),
    // not on every verification.
    if (
      currentTimestampMs - this.lastCleanAt >= DynamicQrTokenEngine.CLEAN_INTERVAL_MS ||
      this.consumedNonces.size > DynamicQrTokenEngine.MAX_NONCES
    ) {
      this.cleanExpiredNonces(currentTimestampMs);
      this.lastCleanAt = currentTimestampMs;
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return { valid: false, reason: 'MALFORMED' };
    }

    const [payloadBase64, signature] = parts;
    let payloadString: string;
    try {
      payloadString = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    } catch {
      return { valid: false, reason: 'MALFORMED' };
    }

    const segments = payloadString.split(':');
    if (segments.length !== 5) {
      return { valid: false, reason: 'MALFORMED' };
    }

    const [versionStr, volunteerId, shiftId, tokenSliceStr, nonce] = segments;
    // ponytail: version was parsed and ignored — unknown versions are now rejected.
    if (parseInt(versionStr, 10) !== DynamicQrTokenEngine.TOKEN_VERSION) {
      return { valid: false, reason: 'MALFORMED' };
    }
    const tokenTimeSlice = parseInt(tokenSliceStr, 10);
    const currentSlice = Math.floor(currentTimestampMs / 1000 / this.TIME_STEP_SECONDS);

    // 1. Constant-Time HMAC-SHA256 Signature Verification FIRST.
    // (Previously the replay check ran on the unverified payload, so a forged
    // token reusing a consumed nonce reported REPLAY_ATTACK instead of
    // INVALID_SIGNATURE — a verification oracle.)
    const expectedHmac = crypto.createHmac('sha256', secret);
    expectedHmac.update(payloadString);
    const expectedSignature = expectedHmac.digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedSigBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    // 2. Sliding Window Drift Tolerance Check
    const drift = tokenTimeSlice - currentSlice;
    if (Math.abs(drift) > driftToleranceSlices) {
      return { valid: false, reason: 'EXPIRED' };
    }

    // 3. Anti-Replay Cache Check (nonce is now authenticated)
    if (this.consumedNonces.has(nonce)) {
      return { valid: false, reason: 'REPLAY_ATTACK' };
    }

    // 4. Mark Nonce as Consumed (TTL = 3 time steps to outlast any drift window).
    // Hard cap: if the map is somehow still oversized after the sweep, evict the
    // oldest entries (Map preserves insertion order) rather than growing forever.
    const expiry = currentTimestampMs + (driftToleranceSlices * 2 + 1) * this.TIME_STEP_SECONDS * 1000;
    this.consumedNonces.set(nonce, expiry);
    while (this.consumedNonces.size > DynamicQrTokenEngine.MAX_NONCES) {
      const oldest = this.consumedNonces.keys().next();
      if (oldest.done) break;
      this.consumedNonces.delete(oldest.value);
    }

    return {
      valid: true,
      volunteerId,
      shiftId,
      driftSlices: drift,
    };
  }

  /**
   * Cleans expired nonces from memory cache.
   */
  public static cleanExpiredNonces(now: number = Date.now()): void {
    for (const [nonce, expiry] of this.consumedNonces.entries()) {
      if (now > expiry) {
        this.consumedNonces.delete(nonce);
      }
    }
  }

  /**
   * Reset the consumed nonces cache (useful in tests).
   */
  public static clearNonceCache(): void {
    this.consumedNonces.clear();
    this.lastCleanAt = 0;
  }
}
