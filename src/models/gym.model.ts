import mongoose, { Schema, Document, Types } from 'mongoose';

export enum Faction {
  TEAM_KERNEL = 'TEAM_KERNEL',   // #00F2FE (Systems & Infrastructure - Siebel HQ)
  TEAM_TENSOR = 'TEAM_TENSOR',   // #FF007F (AI & ML - ECEB)
  TEAM_SILICON = 'TEAM_SILICON', // #FFB300 (Hardware & Robotics - Kenney Gym)
  NEUTRAL = 'NEUTRAL',
}

export interface IGymDefender {
  volunteerId: Types.ObjectId;
  volunteerName: string;
  contributedPower: number;
  assignedAt: Date;
}

export interface IGym extends Document {
  name: string;
  locationName: string;
  latitude: number;
  longitude: number;
  controllingFaction: Faction;
  controlPoints: number;
  maxControlPoints: number;
  leaderVolunteerId?: Types.ObjectId | null;
  leaderName: string;
  defenders: IGymDefender[];
  level: number;
  version: number;
  isShielded: boolean;
  shieldExpiresAt?: Date | null;
  lastBattledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const GymDefenderSchema = new Schema<IGymDefender>(
  {
    volunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true },
    volunteerName: { type: String, required: true },
    contributedPower: { type: Number, required: true },
    assignedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const GymSchema = new Schema<IGym>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    locationName: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    controllingFaction: {
      type: String,
      enum: Object.values(Faction),
      default: Faction.NEUTRAL,
      index: true,
    },
    controlPoints: { type: Number, required: true, default: 500, min: 0 },
    maxControlPoints: { type: Number, required: true, default: 2000 },
    leaderVolunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', default: null },
    leaderName: { type: String, default: 'Unclaimed' },
    defenders: { type: [GymDefenderSchema], default: [] },
    level: { type: Number, default: 1, min: 1, max: 10 },
    version: { type: Number, default: 0 },
    isShielded: { type: Boolean, default: false },
    shieldExpiresAt: { type: Date, default: null },
    lastBattledAt: { type: Date },
  },
  { timestamps: true }
);

GymSchema.index({ latitude: 1, longitude: 1 });

export const Gym = mongoose.model<IGym>('Gym', GymSchema);
