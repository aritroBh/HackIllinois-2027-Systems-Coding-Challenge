/**
 * Presence mutes — the ONLY place a mute lives (plan §A4). A sender whose samples exceed
 * the speed gate three times in a row is muted for 60 s; the TTL index on `until` makes
 * the document vanish on its own, and the store re-reads it before `hello_ack` so a
 * reconnect cannot dodge it.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IPresenceMute extends Document {
  accountId: Types.ObjectId;
  until: Date;
  reason: string;
}

const PresenceMuteSchema = new Schema<IPresenceMute>(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, unique: true },
    until: { type: Date, required: true },
    reason: { type: String, required: true, default: 'SPEED' },
  },
  { timestamps: true }
);
PresenceMuteSchema.index({ until: 1 }, { expireAfterSeconds: 0 });

export const PresenceMute = mongoose.model<IPresenceMute>('PresenceMute', PresenceMuteSchema);
