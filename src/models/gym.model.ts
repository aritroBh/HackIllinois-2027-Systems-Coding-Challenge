/**
 * Gym — a campus control point in the PokéShift territory layer.
 *
 * The gamification exists to solve a real scheduling problem: unglamorous shifts (3 a.m.
 * cleanup, basement trash) go unfilled. Tying territory to physical presence gives
 * volunteers a reason to be somewhere unpopular.
 *
 * Contention here is genuine — several volunteers can attack the same gym in the same
 * second — so mutations use **optimistic concurrency control**, not a read-then-write:
 *
 *   Gym.findOneAndUpdate({ _id, version }, { ...change, $inc: { version: 1 } })
 *
 * A `null` result means another writer won and the version moved; the caller re-reads
 * and retries, bounded by MAX_RETRIES. This is why `version` exists and why it must be
 * included in the filter of every gym mutation that reads, computes, then writes.
 *
 * The power-up control-point boost in `hackstop.service` is the one write that does not
 * carry `version` in its filter, and that is correct rather than an exception: it is an
 * aggregation-pipeline update whose arithmetic (`$min` of `$add`) evaluates against the
 * document's own current values, so it has nothing stale to lose. It bumps `version`
 * anyway, so a battle CAS in flight re-reads instead of acting on a pre-boost snapshot.
 * Do not "fix" it into a CAS retry loop — that would reintroduce the read-modify-write
 * this replaced.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * The three competing factions, plus NEUTRAL for an unclaimed control point.
 *
 * A volunteer's allegiance is bound on their first non-neutral battle and locked
 * thereafter, so one account cannot reinforce as an ally and attack as a rival.
 */
/*
 * Ids only. **Colours, labels and HQ venues live in the content pack**
 * (`content/<pack>/factions.json`), which is what the map, the HUD and the sticker tints read.
 *
 * These comments used to carry hex values, and they had gone stale — they still named the
 * pre-redesign palette (`#00F2FE`/`#FF007F`/`#FFB300`) while everything that actually renders
 * used the pack's (`#22d3ee`/`#a78bfa`/`#fbbf24`). Duplicating a pack value in a source comment
 * makes it a second source of truth that nothing checks, so the theme is named here and the
 * value is not.
 */
export enum Faction {
  TEAM_KERNEL = 'TEAM_KERNEL',   // Systems & Infrastructure
  TEAM_TENSOR = 'TEAM_TENSOR',   // AI & ML
  TEAM_SILICON = 'TEAM_SILICON', // Hardware & Robotics
  NEUTRAL = 'NEUTRAL',           // Unclaimed; must exist, per factions.json
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
