/**
 * Announcements (plan §A7) — the lead's broadcast to the floor.
 *
 * `audience` decides who sees it: everyone, only volunteers, only hackers, or only staff.
 * The hub filters on delivery, so an announcement for staff never reaches a hacker's
 * stream. They expire on their own, because a stale "pizza is here" banner is worse than
 * no banner.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

export enum AnnouncementAudience {
  ALL = 'ALL',
  VOLUNTEERS = 'VOLUNTEERS',
  HACKERS = 'HACKERS',
  STAFF = 'STAFF',
}

export enum AnnouncementTone {
  INFO = 'INFO',
  WARNING = 'WARNING',
  URGENT = 'URGENT',
}

export interface IAnnouncement extends Document {
  message: string;
  audience: AnnouncementAudience;
  tone: AnnouncementTone;
  authorId: Types.ObjectId;
  authorName: string;
  venueKey?: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AnnouncementSchema = new Schema<IAnnouncement>(
  {
    message: { type: String, required: true, trim: true, maxlength: 280 },
    audience: { type: String, enum: Object.values(AnnouncementAudience), default: AnnouncementAudience.ALL, index: true },
    tone: { type: String, enum: Object.values(AnnouncementTone), default: AnnouncementTone.INFO },
    authorId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true },
    authorName: { type: String, required: true },
    venueKey: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

// Gone from the database once it is gone from the floor.
AnnouncementSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Announcement = mongoose.model<IAnnouncement>('Announcement', AnnouncementSchema);

/** Whether an account of this kind/role should receive this announcement. */
export function announcementReaches(audience: AnnouncementAudience, kind: string | undefined, role: string | undefined): boolean {
  switch (audience) {
    case AnnouncementAudience.ALL:
      return true;
    case AnnouncementAudience.VOLUNTEERS:
      return kind === 'VOLUNTEER';
    case AnnouncementAudience.HACKERS:
      return kind === 'HACKER';
    case AnnouncementAudience.STAFF:
      return role === 'SHIFT_LEAD' || role === 'ORGANIZER' || role === 'ADMIN';
    default:
      return false;
  }
}
