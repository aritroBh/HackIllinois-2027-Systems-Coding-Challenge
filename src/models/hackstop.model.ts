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
