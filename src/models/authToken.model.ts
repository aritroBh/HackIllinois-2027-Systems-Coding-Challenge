/**
 * Short-lived single-use tokens for the email magic-link adapter.
 *
 * Same storage discipline as claim codes: only the SHA-256 of the token is stored, the
 * token itself travels once in the mail and once in the URL fragment (`#magic=…`, never a
 * query string, so it does not reach server or proxy logs). 15-minute TTL, burned on use.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

export type AuthTokenPurpose = 'MAGIC';

export interface IAuthToken extends Document {
  tokenHash: string;
  accountId: Types.ObjectId;
  purpose: AuthTokenPurpose;
  expiresAt: Date;
  usedAt?: Date | null;
  createdAt: Date;
}

const AuthTokenSchema = new Schema<IAuthToken>(
  {
    tokenHash: { type: String, required: true, unique: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    purpose: { type: String, enum: ['MAGIC'], required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuthTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthToken = mongoose.model<IAuthToken>('AuthToken', AuthTokenSchema);
