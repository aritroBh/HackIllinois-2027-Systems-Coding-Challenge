/**
 * PowerUp inventory — consumable items won from HackStop beacons.
 *
 * Items are stacked, not row-per-item: one document per (volunteer, itemType) with a
 * `quantity`, enforced by the compound unique index at the bottom. Awarding is an
 * upsert with `$inc`, and consumption is a conditional decrement:
 *
 *   findOneAndUpdate({ volunteerId, itemType, quantity: { $gte: 1 } }, { $inc: { quantity: -1 } })
 *
 * The `quantity: { $gte: 1 }` predicate is the guard — it makes "spend an item" atomic,
 * so two concurrent uses of a single remaining item cannot both succeed. A `null`
 * result means the caller had none left.
 */
import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * The five items, in ascending rarity. The member name is the storage key — it is what
 * `itemType` holds, what the compound unique index groups a stack by, and what a booth's
 * `reward.powerUp` names in the content pack — so renaming one orphans every existing stack.
 * Add members; do not rename them.
 *
 * **Only two of the five do anything beyond paying karma**, and the trailing comments below say
 * exactly which. They used to advertise "+35% speed", "fatigue immunity & priority waitlist
 * pass", "auto-resolve SOS ticket" and "2x territorial multiplier" — none of which exists
 * anywhere in this codebase — under a header calling them "the flavour, not the rule". A player
 * does not read an item description as flavour: they burn a Mythic expecting a doubled territory
 * or an SOS closed, and get the karma bonus only.
 *
 * The karma each one pays lives in `POWER_UP_CATALOG` below; the two real gym effects live in
 * `hackstop.service`. If a fork wants the other three to mean something, that is a service
 * change, not a rename here.
 */
export enum PowerUpType {
  // Karma only. The "+35% speed" it used to advertise does not exist.
  COLD_BREW_ELIXIR = 'COLD_BREW_ELIXIR',
  // Karma, plus a two-hour gym shield when deployed at a gym. No fatigue or waitlist effect.
  INSOMNIA_COOKIE_SHIELD = 'INSOMNIA_COOKIE_SHIELD',
  // Karma, plus +250 control points when deployed at a gym. The one item that does what it says.
  OVERCLOCK_SOLDER_CORE = 'OVERCLOCK_SOLDER_CORE',
  // Karma only. Nothing auto-resolves an SOS ticket.
  RUBBER_DUCK_OMNISCIENCE = 'RUBBER_DUCK_OMNISCIENCE',
  // Karma only. There is no territorial multiplier.
  ANKER_GAUNTLET = 'ANKER_GAUNTLET',
}

/** The catalogue entry for one item: what it is called, how rare it is, and what it pays. */
export interface IPowerUpItemMeta {
  type: PowerUpType;
  name: string;
  rarity: 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'MYTHIC';
  description: string;
  karmaBonus: number;
}

/**
 * Item definitions, in code rather than in the content pack — the one part of the game layer
 * that is not pack-driven.
 *
 * The reason is that `karmaBonus` is money, and a pack is public — served to every browser under
 * `/dashboard/content`. So the split is: the pack chooses the **odds** (`loot.json`, read by
 * `src/economy/lootTable.ts`), and this file chooses the **prices**. The join between them is
 * the `type` string, and a pack naming a type this catalogue does not hold refuses the boot.
 *
 * That split was not always a decision. Until recently `pack.loot` was validated and read by
 * nothing while `HackStopService` rolled against a literal array holding the same five items at
 * the same five weights — odds and prices both in code, with a pack file that looked like it was
 * in charge of one of them.
 *
 * `Record<PowerUpType, …>` is load-bearing: a new member of the enum fails the build here
 * until it is priced, so an item cannot reach a player's inventory with no definition behind
 * it.
 */
export const POWER_UP_CATALOG: Record<PowerUpType, IPowerUpItemMeta> = {
  [PowerUpType.COLD_BREW_ELIXIR]: {
    type: PowerUpType.COLD_BREW_ELIXIR,
    name: 'Cold Brew Elixir of Haste',
    rarity: 'UNCOMMON',
    description: 'Pressurized with Loomis Lab liquid nitrogen. Grants +50 Karma instantly.',
    karmaBonus: 50,
  },
  [PowerUpType.INSOMNIA_COOKIE_SHIELD]: {
    type: PowerUpType.INSOMNIA_COOKIE_SHIELD,
    name: "Insomnia S'mores Cookie Shield",
    rarity: 'RARE',
    description: 'Caramelized marshmallow core forms an impervious psychic barrier.',
    karmaBonus: 100,
  },
  [PowerUpType.OVERCLOCK_SOLDER_CORE]: {
    type: PowerUpType.OVERCLOCK_SOLDER_CORE,
    name: 'Overclocked Solder Core',
    rarity: 'EPIC',
    description: 'A 60/40 rosin-core spool that overcharges Gym influence by +250 CP.',
    karmaBonus: 150,
  },
  [PowerUpType.RUBBER_DUCK_OMNISCIENCE]: {
    type: PowerUpType.RUBBER_DUCK_OMNISCIENCE,
    name: 'Rubber Duck of Debugging Omniscience',
    rarity: 'LEGENDARY',
    description: 'Rubber-duck clarity when nothing else works. Grants +200 Karma instantly.',
    karmaBonus: 200,
  },
  [PowerUpType.ANKER_GAUNTLET]: {
    type: PowerUpType.ANKER_GAUNTLET,
    name: 'The Forbidden 100W Anker Gauntlet',
    rarity: 'MYTHIC',
    description: 'Six USB-C PD ports, zero voltage sag. Undisputed deity of Siebel.',
    karmaBonus: 300,
  },
};

/**
 * One stack. `name` and `rarity` are copied from the catalogue at award time so the inventory
 * renders without a lookup; the catalogue stays the source of truth, and a row whose copy has
 * gone stale after a rename is cosmetic rather than a payout error, because `karmaBonus` is
 * never copied here and is always read from the catalogue when an item is spent.
 *
 * `obtainedFrom` records the mechanic that granted it — a beacon spin, a booth — which is the
 * only trace of provenance an item carries.
 */
export interface IPowerUpInventory extends Document {
  volunteerId: Types.ObjectId;
  itemType: PowerUpType;
  name: string;
  rarity: string;
  quantity: number;
  obtainedFrom: string;
  createdAt: Date;
  updatedAt: Date;
}

const PowerUpInventorySchema = new Schema<IPowerUpInventory>(
  {
    volunteerId: { type: Schema.Types.ObjectId, ref: 'Volunteer', required: true, index: true },
    itemType: { type: String, enum: Object.values(PowerUpType), required: true },
    name: { type: String, required: true },
    rarity: { type: String, required: true, default: 'UNCOMMON' },
    quantity: { type: Number, required: true, default: 1, min: 0 },
    obtainedFrom: { type: String, default: 'HACKSTOP_SPIN' },
  },
  { timestamps: true }
);

/** One stack per (volunteer, item). Makes the award upsert safe under concurrent spins. */
PowerUpInventorySchema.index({ volunteerId: 1, itemType: 1 }, { unique: true });

export const PowerUpInventory = mongoose.model<IPowerUpInventory>('PowerUpInventory', PowerUpInventorySchema);
