/**
 * Shift — a staffable block of work with a hard capacity.
 *
 * The two counters on this document (`filledSlots`, `waitlistCount`) are denormalised
 * caches of the Registration collection. That denormalisation is deliberate: it is what
 * lets a reservation claim a seat in a **single atomic round trip** instead of counting
 * rows and then writing, which cannot be made race-free.
 *
 * Invariant I1 — no shift is ever oversold — is enforced by a conditional update in
 * `RegistrationService.reserveShift`:
 *
 *   Shift.findOneAndUpdate(
 *     { _id, $expr: { $lt: ['$filledSlots', '$capacity'] } },   // guard
 *     { $inc: { filledSlots: 1, version: 1 } }                  // claim
 *   )
 *
 * MongoDB applies the filter and the increment atomically on a single document, so N
 * concurrent claimants against C seats produce exactly C winners. A `null` return means
 * the shift was full at the moment of the write, and the caller overflows to the
 * waitlist. `scripts/benchmarks/loadtest.ts` exercises this at 5,000 concurrent users
 * against 1,000 seats and audits every shift afterwards for oversell, counter drift and
 * duplicate waitlist positions — run it rather than trusting a number in a comment.
 *
 * Because these counters are a cache, any code path that changes a registration's
 * occupancy must adjust them in the same logical operation — that is why cancellation,
 * promotion and swap all touch them explicitly.
 */
import mongoose, { Schema, Document } from 'mongoose';

/** Operational category, used for filtering and to derive default capacity on Adonix sync. */
export enum ShiftCategory {
  FOOD = 'FOOD',
  LOGISTICS = 'LOGISTICS',
  SPONSOR_RELATIONS = 'SPONSOR_RELATIONS',
  INFO_DESK = 'INFO_DESK',
  HARDWARE_LAB = 'HARDWARE_LAB',
  MENTOR_SUPPORT = 'MENTOR_SUPPORT',
  CLEANUP = 'CLEANUP',
}

export interface IShift extends Document {
  title: string;
  description: string;
  category: ShiftCategory;
  location: string;
  startTime: Date;
  endTime: Date;
  /** Hard upper bound on CONFIRMED registrations. The `$expr` guard compares against this. */
  capacity: number;
  /**
   * Denormalised count of *occupied* seats — the number the `$expr` capacity guard reads.
   *
   * It is deliberately NOT the CONFIRMED row count. A volunteer who checks in moves
   * CONFIRMED → CHECKED_IN → COMPLETED and keeps their seat the whole time, so the seat
   * stays counted while the CONFIRMED row count falls. Only cancellation and drop
   * decrement it. Reconciling this against CONFIRMED rows would free seats out from
   * under people who are physically at the shift.
   */
  filledSlots: number;
  /** Denormalised count of WAITLISTED registrations; also the next queue position to hand out. */
  waitlistCount: number;
  /** Certifications a volunteer must hold. Empty array means open to all. */
  requiredSkills: string[];
  /** Pre-surge karma award. The surge engine multiplies this; it never mutates it. */
  baseKarma: number;
  /** Organiser thumb on the scale, folded into the computed surge multiplier. */
  manualSurgeMultiplier: number;
  /**
   * Optimistic-concurrency counter, incremented on every mutation.
   *
   * Not used by the reservation path (which relies on the `$expr` guard instead), but
   * it gives readers a cheap way to detect that a shift changed under them.
   */
  version: number;
  /** Soft-delete flag. Deactivated shifts stay queryable for history but reject new claims. */
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ShiftSchema = new Schema<IShift>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    category: {
      type: String,
      enum: Object.values(ShiftCategory),
      required: true,
      default: ShiftCategory.LOGISTICS,
    },
    location: { type: String, required: true },
    startTime: { type: Date, required: true, index: true },
    endTime: { type: Date, required: true, index: true },
    capacity: { type: Number, required: true, min: 1 },
    filledSlots: { type: Number, required: true, default: 0, min: 0 },
    waitlistCount: { type: Number, required: true, default: 0, min: 0 },
    requiredSkills: { type: [String], default: [] },
    baseKarma: { type: Number, default: 100, min: 10 },
    manualSurgeMultiplier: { type: Number, default: 1.0, min: 1.0, max: 5.0 },
    version: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

/**
 * Interval lookup. The rest-buffer and fatigue checks resolve a volunteer's other
 * shifts by time window, which is a range scan over both bounds.
 */
ShiftSchema.index({ startTime: 1, endTime: 1 });

/** Backs the dashboard's category filter, which always also filters on isActive. */
ShiftSchema.index({ category: 1, isActive: 1 });

export const Shift = mongoose.model<IShift>('Shift', ShiftSchema);
