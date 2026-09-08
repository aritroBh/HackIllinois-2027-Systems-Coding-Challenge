/**
 * Player avatars (plan §A5).
 *
 * An avatar is stored by the sha256 of its **re-encoded** bytes: every upload is decoded
 * and written out again by pngjs, which strips metadata and makes a polyglot file (a PNG
 * that is also a script or an archive) impossible to serve back. The hash is therefore a
 * property of the pixels, not of whatever the client uploaded, and two identical sheets
 * deduplicate to one document.
 *
 * The presence wire carries only the hash; peers fetch the sheet once and cache the texture
 * by hash, so a takedown has to reach them through the `AVATAR_UNPUBLISHED` event rather
 * than through cache expiry alone.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

export enum AvatarStatus {
  /** Uploaded, visible to the owner and to leads, not yet shared with other players. */
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * One report against an avatar. Kept as an array on the document rather than its own
 * collection because the count is what matters and it is bounded by the number of people at
 * the event; there is no query that wants flags across avatars.
 *
 * `reporterId` is retained so the same person reporting twice can be recognised as one report
 * rather than two — a moderation decision that has to be made from the data, so the data keeps
 * it.
 */
export interface IAvatarFlag {
  reporterId: Types.ObjectId;
  reason: string;
  at: Date;
}

/**
 * `shareOptIn` and `status` are two different gates and both must pass before other players
 * see a sheet: the owner has to offer it and a lead has to approve it. Either one alone is not
 * consent, and there is no auto-approval — `AvatarStatus.APPROVED` is written in exactly one
 * place, the review call, so an unreviewed sheet stays private however long the queue is.
 *
 * `reviewedBy` / `reviewedAt` are the moderation audit trail. They are null on a row that was
 * rejected by a flag takedown rather than by a person, which is how the two kinds of REJECTED
 * are told apart.
 */
export interface IAvatar extends Document {
  hash: string;
  bytes: Buffer;
  width: number;
  height: number;
  ownerId: Types.ObjectId;
  status: AvatarStatus;
  /** True once the owner asks for it to be shown to other players. */
  shareOptIn: boolean;
  flags: IAvatarFlag[];
  reviewedBy?: Types.ObjectId | null;
  reviewedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const AvatarSchema = new Schema<IAvatar>(
  {
    hash: { type: String, required: true, index: true },
    bytes: { type: Buffer, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    status: { type: String, enum: Object.values(AvatarStatus), default: AvatarStatus.PENDING, index: true },
    shareOptIn: { type: Boolean, default: false },
    flags: [
      {
        _id: false,
        reporterId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true },
        reason: { type: String, default: 'REPORTED' },
        at: { type: Date, default: () => new Date() },
      },
    ],
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * One row per (image, owner). Two people who upload the same sheet get their own document:
 * a shared row would mean one person's takedown clears the other's avatar, and a PENDING
 * row owned by someone else would 404 for its own second uploader.
 */
AvatarSchema.index({ hash: 1, ownerId: 1 }, { unique: true });

export const Avatar = mongoose.model<IAvatar>('Avatar', AvatarSchema);
