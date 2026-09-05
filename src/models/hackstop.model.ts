/**
 * HackStop — a geofenced supply beacon that dispenses power-ups on a cooldown.
 *
 * Two gates protect a spin, and both matter:
 *
 *  - **Geofence.** The volunteer's coordinates must be within `geofenceRadiusMeters`
 *    (75 m) of the beacon, by Haversine distance. This is what ties the reward to
 *    actually walking to the location.
 *  - **Cooldown.** `lastSpunUsers` maps volunteerId → last spin time, and a spin is
 *    refused within `cooldownSeconds` (5 min).
 *
 * The cooldown is claimed with a single conditional update rather than read-then-write,
 * so concurrent spins cannot both pass the check:
 *
 *   HackStop.findOneAndUpdate(
 *     { _id, $or: [ { 'lastSpunUsers.<id>': { $exists: false } },
 *                   { 'lastSpunUsers.<id>': { $lt: cutoff } } ] },
 *     { $set: { 'lastSpunUsers.<id>': now }, $inc: { totalSpins: 1 } }
 *   )
 *
 * Note the map key is the caller-supplied id string, so it must be normalised before
 * use — differently-cased forms of one ObjectId would otherwise occupy separate keys
 * and split the cooldown (see the audit's F1).
 */
import mongoose, { Schema, Document } from 'mongoose';

export interface IHackStop extends Document {
  beaconId: string;
  name: string;
  locationName: string;
  latitude: number;
  longitude: number;
  cooldownSeconds: number; // 300s = 5 min default
  geofenceRadiusMeters: number; // 75m default
  lastSpunUsers: Map<string, Date>; // volunteerId -> lastSpunAt timestamp
  totalSpins: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const HackStopSchema = new Schema<IHackStop>(
  {
    beaconId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    locationName: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    cooldownSeconds: { type: Number, default: 300 },
    geofenceRadiusMeters: { type: Number, default: 75 },
    lastSpunUsers: {
      type: Map,
      of: Date,
      default: () => new Map(),
    },
    totalSpins: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const HackStop = mongoose.model<IHackStop>('HackStop', HackStopSchema);
