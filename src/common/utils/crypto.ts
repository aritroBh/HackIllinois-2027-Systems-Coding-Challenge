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

/**
 * The five fields inside a token, in the order they are colon-joined before signing.
 *
 * Documentation only: nothing constructs or receives one of these. `generateToken` builds the
 * string directly and `verifyToken` destructures the split segments, so this type is a
 * description of the wire format rather than a shape any code passes around. Kept because the
 * format is otherwise only visible as a template literal, and deleted-and-regretted is worse
 * than unused; do not read its presence as evidence of a parser.
 */
export interface ITokenPayload {
  version: number;
  volunteerId: string;
  shiftId: string;
  timeSlice: number;
  nonce: string;
}

/**
 * Deliberately not an exception: a failed verification is an ordinary outcome at a check-in
 * desk, and `reason` is what the service turns into the right status code — `EXPIRED` and
 * `INVALID_SIGNATURE` are **400s** — `ApiError.badRequest`, carrying `TOKEN_EXPIRED` and
 * `MALFORMED_TOKEN` — and `REPLAY_ATTACK` is the 409 the desk actually sees on a double
 * scan.
 *
 * `volunteerId` and `shiftId` are populated only on success, and that is the point: they come
 * out of the signed payload, so reading them anywhere else would be reading unauthenticated
 * input.
 */
export interface IVerificationResult {
  valid: boolean;
  reason?: 'EXPIRED' | 'INVALID_SIGNATURE' | 'REPLAY_ATTACK' | 'MALFORMED';
  volunteerId?: string;
  shiftId?: string;
  driftSlices?: number;
  /**
   * The authenticated nonce, returned so a caller that verified without consuming can
   * consume it later — see `verifyToken`'s `consume` option and `consumeNonce`.
   */
  nonce?: string;
}

/**
 * Dynamic QR Code Cryptographic Engine.
 * Generates and validates time-windowed HMAC-SHA256 tokens that rotate every 30 seconds
 * to prevent screenshot sharing fraud at hackathon check-in desks.
 *
 * Everything here is static, including the nonce cache, which makes the cache
 * process-global — that is what lets a double scan be rejected without a database round
 * trip, and equally why it is not the guarantee: another replica has its own empty copy.
 * `clearNonceCache` exists because static state persists between tests in one process.
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
   * Mint one token for one volunteer and one shift.
   *
   * Both ids go inside the signature, so a token is not merely proof that *someone* was issued
   * one — it names who and for what. `verifyAndCheckIn` then looks the registration up *from
   * the signed ids*, never from anything the scanner sent alongside the token, so a desk
   * cannot point a valid token at a different shift or a different person. Editing either
   * field breaks the HMAC.
   *
   * Minting does **not** reserve the nonce. Nothing is spent until a scan verifies, so a
   * volunteer whose phone re-renders the QR a dozen times has not burned a dozen tokens; the
   * cache only ever holds nonces that were actually presented.
   *
   * `timestampMs` and `secret` are parameters rather than reads so tests can mint a token for
   * a chosen slice, and so a rotation could sign with an old key. Ordinary callers pass
   * neither.
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
  /**
   * @param consume Whether a successful verification also spends the nonce. Defaults to
   *   true, which is what a caller wanting one call wants. Pass `false` when the check-in
   *   can still be refused after this returns — the geofence, the registration status and
   *   the venue lookup all sit downstream — and then call `consumeNonce` at the point the
   *   check-in actually commits. Burning the nonce during verification meant an honest
   *   volunteer who scanned a few metres too far away got a geofence refusal *and* a spent
   *   token, so their next scan at the desk reported a replay attack and they had to mint
   *   a fresh one. Single use is still single use: the window between verifying and
   *   consuming is one synchronous stretch here, and `CheckIn.nonce` carries a unique
   *   index that is the authoritative guard across restarts and replicas.
   */
  public static verifyToken(
    token: string,
    driftToleranceSlices = 1,
    currentTimestampMs: number = Date.now(),
    secret: string | undefined = undefined,
    consume = true
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
    const expectedHmac = crypto.createHmac('sha256', secret ?? env.QR_HMAC_SECRET);
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
    if (consume) {
      this.markConsumed(nonce, currentTimestampMs, driftToleranceSlices);
    }

    return {
      valid: true,
      volunteerId,
      shiftId,
      driftSlices: drift,
      nonce,
    };
  }

  /**
   * Spend an already-authenticated nonce. Returns false if somebody else spent it first.
   *
   * The check and the set are one synchronous stretch, so two concurrent scans of the same
   * token produce one true and one false in this process; across processes the unique index
   * on `CheckIn.nonce` is what decides.
   */
  public static consumeNonce(nonce: string, currentTimestampMs: number = Date.now(), driftToleranceSlices = 1): boolean {
    if (this.consumedNonces.has(nonce)) return false;
    this.markConsumed(nonce, currentTimestampMs, driftToleranceSlices);
    return true;
  }

  /**
   * Hard cap: if the map is somehow still oversized after the sweep, evict the oldest
   * entries (Map preserves insertion order) rather than growing forever.
   */
  private static markConsumed(nonce: string, currentTimestampMs: number, driftToleranceSlices: number): void {
    const expiry = currentTimestampMs + (driftToleranceSlices * 2 + 1) * this.TIME_STEP_SECONDS * 1000;
    this.consumedNonces.set(nonce, expiry);
    while (this.consumedNonces.size > DynamicQrTokenEngine.MAX_NONCES) {
      const oldest = this.consumedNonces.keys().next();
      if (oldest.done) break;
      this.consumedNonces.delete(oldest.value);
    }
  }

  /**
   * Drop every nonce whose replay window has passed.
   *
   * A full scan of the map, which is why `verifyToken` throttles it to once per 30 s (or
   * immediately when the map is oversized) rather than running it per verification: an
   * attacker who can make the server do an O(n) sweep on every request has turned the replay
   * defence into the outage. Deleting during iteration is safe here — a `Map` iterator
   * tolerates removal of the entry it has already yielded.
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
