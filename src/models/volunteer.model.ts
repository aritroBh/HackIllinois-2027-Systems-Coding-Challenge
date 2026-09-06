/**
 * Volunteer records — identity, certifications, karma and faction allegiance.
 *
 * `certifications` is the gate the scheduler checks before letting anyone hold a shift
 * that requires one (a driver for airport runs, food handling for the pizza stations).
 * It is **self-declared at signup**: nothing here issues or verifies a credential, so the
 * field documents intent rather than enforcing it. Issuing certifications from an
 * organiser account is the change that would make this a real control.
 *
 * `karmaPoints` is the single source of truth for standing, and `prestigeTier` is a
 * derived label over it — the thresholds live beside the enum members above. Storing the
 * tier rather than computing it on read keeps the leaderboard a straight indexed sort
 * instead of a scan plus a per-row computation.
 */
import mongoose, { Schema, Document } from 'mongoose';

export enum VolunteerRole {
  VOLUNTEER = 'VOLUNTEER',
  SHIFT_LEAD = 'SHIFT_LEAD',
  ORGANIZER = 'ORGANIZER',
  ADMIN = 'ADMIN',
  /** Hackers are accounts too (they play gyms, spin HackStops, raise SOS) but hold no shifts. */
  HACKER = 'HACKER',
}

/**
 * The only axis for "is this a staff member" decisions. Shifts, check-in, swaps, SOS
 * resolution and rosters are VOLUNTEER-only; gyms, HackStops, quests, stickers, presence,
 * avatars and SOS *creation* accept either kind. `role` stays the lead/organiser ladder
 * and is bound to `kind` by the invariant enforced in the pre-validate hook below.
 */
export enum AccountKind {
  VOLUNTEER = 'VOLUNTEER',
  HACKER = 'HACKER',
}

export type IdentityProvider = 'claim' | 'email' | 'adonix';

export interface IIdentity {
  provider: IdentityProvider;
  /** Provider-scoped subject: the claim code id, the lowercased email, or the Adonix user id. */
  subject: string;
  linkedAt: Date;
}

export enum PrestigeTier {
  NEOPHYTE_PLANKTON = 'NEOPHYTE_PLANKTON', // 0 - 199
  CURRENT_RIDER = 'CURRENT_RIDER',         // 200 - 499
  ABYSSAL_VANGUARD = 'ABYSSAL_VANGUARD',   // 500 - 999
  SIEBEL_GUARDIAN = 'SIEBEL_GUARDIAN',     // 1,000 - 1,999
  MIDNIGHT_KRAKEN = 'MIDNIGHT_KRAKEN',     // 2,000 - 3,499
  LEVIATHAN_PRIME = 'LEVIATHAN_PRIME',     // 3,500+
}

export interface IVolunteer extends Document {
  name: string;
  /** Optional since M1: badge-claim hackers have no email. Sparse-unique when present. */
  email?: string | null;
  phone?: string;
  kind: AccountKind;
  role: VolunteerRole;
  identities: IIdentity[];
  /** Bumped to revoke every session minted for this account (lost phone, leaked code). */
  sessionVersion: number;
  /** Content hash of the approved avatar sheet; null until an upload is approved. */
  avatarHash?: string | null;
  /** Presence is opt-in and symmetric: off means neither seen nor seeing. */
  presenceOptIn: boolean;
  streak: { count: number; lastDay: string | null };
  reliability: { completed: number; noShow: number };
  certifications: string[];
  karmaPoints: number;
  hoursServed: number;
  prestigeTier: PrestigeTier;
  badges: string[];
  /** Faction locked on first gym battle; prevents one account playing both sides. */
  faction?: string | null;
  /** Last timestamp gym-battle karma was awarded; backs the anti-farm cooldown. */
  lastGymKarmaAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const VolunteerSchema = new Schema<IVolunteer>(
  {
    name: { type: String, required: true, trim: true },
    // Sparse + unique: two volunteers cannot share an email, but any number of hackers may
    // have none. (`scripts/migrate.ts` drops the old non-sparse unique index.)
    // No `default: null`: a null is a *present* value under the sparse unique index below,
    // so defaulting it would make every email-less hacker collide with the first one.
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    kind: {
      type: String,
      enum: Object.values(AccountKind),
      default: AccountKind.VOLUNTEER,
      index: true,
    },
    role: {
      type: String,
      enum: Object.values(VolunteerRole),
      default: VolunteerRole.VOLUNTEER,
    },
    identities: {
      type: [
        {
          _id: false,
          provider: { type: String, enum: ['claim', 'email', 'adonix'], required: true },
          subject: { type: String, required: true },
          linkedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    sessionVersion: { type: Number, default: 0 },
    avatarHash: { type: String, default: null },
    presenceOptIn: { type: Boolean, default: false },
    streak: {
      count: { type: Number, default: 0 },
      lastDay: { type: String, default: null },
    },
    reliability: {
      completed: { type: Number, default: 0 },
      noShow: { type: Number, default: 0 },
    },
    certifications: { type: [String], default: [] },
    karmaPoints: { type: Number, default: 0, min: 0, index: true },
    hoursServed: { type: Number, default: 0, min: 0 },
    prestigeTier: {
      type: String,
      enum: Object.values(PrestigeTier),
      default: PrestigeTier.NEOPHYTE_PLANKTON,
    },
    badges: { type: [String], default: [] },
    faction: { type: String, default: null },
    lastGymKarmaAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Sparse unique indexes: uniqueness only among documents that have the field.
VolunteerSchema.index({ email: 1 }, { unique: true, sparse: true });
VolunteerSchema.index({ 'identities.provider': 1, 'identities.subject': 1 }, { unique: true, sparse: true });

/**
 * `kind === HACKER ⇔ role === HACKER`. Lead/organiser checks read `role`, staff-only checks
 * read `kind`; binding the two means neither check can be fooled by an incoherent document
 * (a "hacker" with SHIFT_LEAD, or a "volunteer" whose role says HACKER).
 */
VolunteerSchema.pre('validate', function (next) {
  const isHackerKind = this.kind === AccountKind.HACKER;
  const isHackerRole = this.role === VolunteerRole.HACKER;
  if (isHackerKind !== isHackerRole) {
    next(new Error(`Incoherent account: kind=${this.kind} role=${this.role} (kind HACKER must pair with role HACKER)`));
    return;
  }
  // A sparse unique index only skips documents where the field is ABSENT. An email stored
  // as `null` (or `""`) is present, so a second badge-claim hacker with no email would
  // collide on `email_1`. Unset it instead, which is what makes "sparse" do what it says.
  if (this.email === '' || this.email === null) this.set('email', undefined, { strict: false });
  next();
});

/**
 * Calculates current prestige tier from karma points.
 */
export function computePrestigeTier(points: number): PrestigeTier {
  if (points >= 3500) return PrestigeTier.LEVIATHAN_PRIME;
  if (points >= 2000) return PrestigeTier.MIDNIGHT_KRAKEN;
  if (points >= 1000) return PrestigeTier.SIEBEL_GUARDIAN;
  if (points >= 500) return PrestigeTier.ABYSSAL_VANGUARD;
  if (points >= 200) return PrestigeTier.CURRENT_RIDER;
  return PrestigeTier.NEOPHYTE_PLANKTON;
}

export const Volunteer = mongoose.model<IVolunteer>('Volunteer', VolunteerSchema);
