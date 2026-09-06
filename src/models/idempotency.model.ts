/**
 * IdempotencyRecord — exactly-once semantics for reservation requests.
 *
 * Volunteers claim shifts from phones on congested event wifi, where a request can
 * succeed server-side and still time out client-side. Without this table the natural
 * client behaviour (retry) would double-book. With it, a retry carrying the same
 * `Idempotency-Key` replays the stored response instead of re-executing.
 *
 * The record is claimed as PENDING before any work, then settled to COMMITTED (with the
 * response body to replay) or FAILED. `requestHash` guards against key reuse with a
 * different payload — the same key describing different work is a client bug, answered
 * with 409 rather than silently serving the wrong cached response.
 *
 * Rows self-expire after 24 h via the TTL index below; the key space is per-request, so
 * without expiry this collection would grow without bound.
 */
import mongoose, { Schema, Document } from 'mongoose';

export enum IdempotencyStatus {
  PENDING = 'PENDING',
  COMMITTED = 'COMMITTED',
  FAILED = 'FAILED',
}

export interface IIdempotencyRecord extends Document {
  key: string;
  userId: string;
  endpoint: string;
  requestHash: string;
  /**
   * Which *attempt* currently owns this key.
   *
   * A key can change hands: an owner that stalls for more than two minutes is presumed dead
   * and a second caller steals the record so a crash cannot poison the key for the full
   * twenty-four hours. Without a token naming the attempt, the settle writes could not tell
   * which of them they belonged to — the stalled owner finishing late would stamp its own
   * result over the stealer's, and the stealer's failure path would mark a committed record
   * FAILED, so two same-key retries could see success and then failure. A fresh token per
   * acquisition makes every settle write conditional on still holding the key, which is the
   * same fence the per-volunteer reservation lock uses.
   */
  ownerToken: string;
  status: IdempotencyStatus;
  responseStatusCode?: number;
  responseBody?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const IdempotencySchema = new Schema<IIdempotencyRecord>(
  {
    key: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true },
    endpoint: { type: String, required: true },
    requestHash: { type: String, required: true },
    // Not required: records written before this field existed have none, and a settle that
    // matches on `ownerToken: undefined` still behaves correctly for them.
    ownerToken: { type: String },
    status: {
      type: String,
      enum: Object.values(IdempotencyStatus),
      required: true,
      default: IdempotencyStatus.PENDING,
    },
    responseStatusCode: { type: Number },
    responseBody: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

/**
 * TTL: purge after 24 h. Long enough that any realistic client retry still replays the
 * cached response, short enough that the collection stays bounded over a hackathon.
 */
IdempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export const IdempotencyRecord = mongoose.model<IIdempotencyRecord>('IdempotencyRecord', IdempotencySchema);
