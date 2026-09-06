/**
 * Badge claim codes — the zero-dependency identity adapter.
 *
 * An organiser mints one code per account; it is printed on the badge (as text and as a
 * `/dashboard/#claim=CODE` QR) or handed over by a shift lead. Entering it once mints a
 * session and burns the code.
 *
 * Only the SHA-256 of the code is stored. A leaked database therefore yields nothing that
 * can be typed into the login screen, and a wrong guess matches no document at all — which
 * is also why there is no per-code attempt counter (nothing to decrement): brute force is
 * bounded by the per-IP limiter on `POST /auth/claim` plus the global `CLAIM_BRUTE_FORCE`
 * alarm. Codes are 10 characters of Crockford base32 (50 bits): at 30 guesses a minute the
 * expected time to a hit is about 7 × 10^7 years (2^50 / 30 minutes).
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IClaimCode extends Document {
  codeHash: string;
  accountId: Types.ObjectId;
  issuedBy: string;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt: Date;
}

const ClaimCodeSchema = new Schema<IClaimCode>(
  {
    codeHash: { type: String, required: true, unique: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    issuedBy: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// TTL: Mongo deletes the document once `expiresAt` passes. Used codes are kept until then
// for the organiser's audit view and then vanish with everything else.
ClaimCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ClaimCode = mongoose.model<IClaimCode>('ClaimCode', ClaimCodeSchema);
