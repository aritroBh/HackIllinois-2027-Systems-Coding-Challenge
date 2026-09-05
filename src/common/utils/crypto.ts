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
  private static consumedNonces = new Map<string, number>();

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
    const nonce = crypto.randomBytes(6).toString('hex');
    const version = 1;

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
    this.cleanExpiredNonces(currentTimestampMs);

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

    const [, volunteerId, shiftId, tokenSliceStr, nonce] = segments;
    const tokenTimeSlice = parseInt(tokenSliceStr, 10);
    const currentSlice = Math.floor(currentTimestampMs / 1000 / this.TIME_STEP_SECONDS);

    // 1. Anti-Replay Cache Check
    if (this.consumedNonces.has(nonce)) {
      return { valid: false, reason: 'REPLAY_ATTACK' };
    }

    // 2. Sliding Window Drift Tolerance Check
    const drift = tokenTimeSlice - currentSlice;
    if (Math.abs(drift) > driftToleranceSlices) {
      return { valid: false, reason: 'EXPIRED' };
    }

    // 3. Constant-Time HMAC-SHA256 Signature Verification
    const expectedHmac = crypto.createHmac('sha256', secret);
    expectedHmac.update(payloadString);
    const expectedSignature = expectedHmac.digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedSigBuf = Buffer.from(expectedSignature, 'utf8');

    if (sigBuf.length !== expectedSigBuf.length || !crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    // 4. Mark Nonce as Consumed (TTL = 3 time steps to outlast any drift window)
    const expiry = currentTimestampMs + (driftToleranceSlices * 2 + 1) * this.TIME_STEP_SECONDS * 1000;
    this.consumedNonces.set(nonce, expiry);

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
  }
}
