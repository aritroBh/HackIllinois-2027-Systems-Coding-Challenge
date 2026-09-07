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
import { pack } from '../content/loader';

/**
 * Faction ids the *shipped* pack happens to declare, plus NEUTRAL.
 *
 * **This is a convenience, not the authority.** The authority is
 * `content/<pack>/factions.json`, and the only member of this enum a fork can rely on is
 * `NEUTRAL`, which `crossValidate` requires every pack to declare. Nothing in `src/` reads
 * `Faction.TEAM_KERNEL`, `Faction.TEAM_TENSOR` or `Faction.TEAM_SILICON` — checked, not
 * assumed — and the three exist only because `tests/` still names them. They should go when
 * those tests move to reading the pack, and until then they are the last event-specific strings
 * left in `src/`.
 *
 * Reading this enum as the set of valid factions is what broke forks: `GymSchema` used to
 * validate `controllingFaction` against `Object.values(Faction)`, which rejected any faction a
 * pack declared that was not one of these three. See the comment on that field.
 *
 * A volunteer's allegiance is bound on their first non-neutral battle and locked thereafter, so
 * one account cannot reinforce as an ally and attack as a rival.
 *
 * Ids only. **Colours, labels and HQ venues live in the pack**, which is what the map, the HUD
 * and the sticker tints read. These comments used to carry hex values and had gone stale — they
 * still named the pre-redesign palette (`#00F2FE`/`#FF007F`/`#FFB300`) while everything that
 * renders used the pack's. Duplicating a pack value in a source comment makes it a second source
 * of truth that nothing checks, so the theme is named here and the value is not.
 */
export enum Faction {
  TEAM_KERNEL = 'TEAM_KERNEL',   // Systems & Infrastructure. Shipped pack only; see above.
  TEAM_TENSOR = 'TEAM_TENSOR',   // AI & ML. Shipped pack only.
  TEAM_SILICON = 'TEAM_SILICON', // Hardware & Robotics. Shipped pack only.
  NEUTRAL = 'NEUTRAL',           // Unclaimed. Required in every pack, per crossValidate.
}

/**
 * Someone holding a gym for their faction. `volunteerName` is denormalised so the map can
 * label a control point without a join per gym per frame.
 *
 * Worth knowing before building on it: the server writes this array in exactly one place —
 * the capture branch of `GymService.battleGym` — and always as a fresh one-element array
 * naming the captor, because the regime changed. Reinforcing does not append. So in practice
 * the length is 0 for a gym nobody has taken since the seed and 1 for every other, and the
 * dashboard's "N defending" reads that. A real defender roster means appending on reinforce
 * and bounding the array; nothing here does either yet.
 */
export interface IGymDefender {
  volunteerId: Types.ObjectId;
  volunteerName: string;
  contributedPower: number;
  assignedAt: Date;
}

/**
 * `controlPoints` against `maxControlPoints` is the whole state of a territory: reinforcing
 * adds, attacking subtracts, and a strike that meets or exceeds what is left flips the
 * faction rather than leaving it at zero for the next passer-by.
 *
 * `leaderVolunteerId` / `leaderName` are the last person to take or decisively reinforce it,
 * kept denormalised for the same reason as `volunteerName` above.
 *
 * `isShielded` and `shieldExpiresAt` are set together by a power-up in `hackstop.service` and
 * are never cleared: expiry is decided by comparing `shieldExpiresAt` at the moment somebody
 * contests the gym, so a lapsed shield stops protecting it immediately and no sweeper job has
 * to notice. A stale `isShielded: true` on a document whose expiry has passed is therefore
 * normal, not drift.
 *
 * `level` is written by the seed and by nothing else. The dashboard renders it, so it is a
 * fixed label on each landmark rather than something a gym earns.
 */
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
    // Unique, although nothing looks a gym up by name. It is a de-duplication guard: the seed
    // reads `pack.territories` and *inserts*, it does not upsert, so a second seed against a
    // database that was not cleared, or a hand-inserted territory, would otherwise produce two
    // documents for one landmark — two pins on the map at the same coordinates, each capturable
    // independently, with a player's karma spent on whichever one their client happened to
    // render. It is also, incidentally, the only thing stopping a pack that lists the same
    // territory name twice; `crossValidate` checks beacon ids for duplicates but not territory
    // names, so this index is where that would surface, as a seed failure.
    name: { type: String, required: true, trim: true, unique: true },
    locationName: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    controllingFaction: {
      type: String,
      /*
       * The pack's faction ids, not this file's enum — and this was a real wall, not a tidy-up.
       *
       * `enum: Object.values(Faction)` hardcoded HackIllinois's three team ids, so two
       * validators disagreed about the same value. `crossValidate` checks every territory's
       * faction against `factions.json` and passes anything the pack declares; Mongoose then
       * rejected anything that was not one of the three compiled in. A fork naming its own
       * sides — which every fork does, because `factions.json` is pack-owned — got a green
       * `npm run content:validate` and then `Gym validation failed … kind: 'enum', value:
       * 'TEAM_RED'` the moment it seeded.
       *
       * That was demonstrated rather than reasoned about: `content/example-campus`, the
       * template `docs/FORK_GUIDE.md` tells you to copy, declares TEAM_RED and TEAM_BLUE. It
       * only seeded at all because its single territory happens to be NEUTRAL, which is the one
       * id both lists share. Setting that territory to TEAM_RED — a faction its own pack
       * declares — reproduced the failure exactly.
       *
       * `crossValidate` requires a NEUTRAL faction in every pack, so the default below is
       * always a member of this list.
       */
      enum: pack.factions.map((faction) => faction.id),
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

/**
 * A plain compound index on the two coordinate fields, and it is honest to say what that is
 * and is not. It is **not** a `2dsphere` index, so it cannot answer "which gyms are within
 * 100 m of here" — that is not a query this index can serve, and no code asks it. Today the
 * board is read whole (`Gym.find().sort({ name: 1 })`, fourteen documents) and individual
 * gyms by `_id`, so nothing in the server filters on either field and this index is unused.
 *
 * Left in place rather than dropped because the proximity query it gestures at is a plausible
 * next feature; if that arrives, this wants replacing with a `2dsphere` on a GeoJSON point
 * rather than extending.
 */
GymSchema.index({ latitude: 1, longitude: 1 });

export const Gym = mongoose.model<IGym>('Gym', GymSchema);
