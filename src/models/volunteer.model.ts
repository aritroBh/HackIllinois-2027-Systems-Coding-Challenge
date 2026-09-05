import mongoose, { Schema, Document } from 'mongoose';

export enum VolunteerRole {
  VOLUNTEER = 'VOLUNTEER',
  SHIFT_LEAD = 'SHIFT_LEAD',
  ORGANIZER = 'ORGANIZER',
  ADMIN = 'ADMIN',
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
  email: string;
  phone?: string;
  role: VolunteerRole;
  certifications: string[];
  karmaPoints: number;
  hoursServed: number;
  prestigeTier: PrestigeTier;
  badges: string[];
  createdAt: Date;
  updatedAt: Date;
}

const VolunteerSchema = new Schema<IVolunteer>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    phone: { type: String, trim: true },
    role: {
      type: String,
      enum: Object.values(VolunteerRole),
      default: VolunteerRole.VOLUNTEER,
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
  },
  { timestamps: true }
);

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
