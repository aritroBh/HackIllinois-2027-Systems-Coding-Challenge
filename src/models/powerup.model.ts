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

export enum PowerUpType {
  COLD_BREW_ELIXIR = 'COLD_BREW_ELIXIR',             // Uncommon: +35% speed & +50 Karma
  INSOMNIA_COOKIE_SHIELD = 'INSOMNIA_COOKIE_SHIELD', // Rare: Fatigue immunity & priority waitlist pass
  OVERCLOCK_SOLDER_CORE = 'OVERCLOCK_SOLDER_CORE',   // Epic: +150 Karma & +250 Gym CP
  RUBBER_DUCK_OMNISCIENCE = 'RUBBER_DUCK_OMNISCIENCE', // Legendary: Auto-resolve SOS ticket & +200 Karma
  ANKER_GAUNTLET = 'ANKER_GAUNTLET',                 // Mythic: 2x territorial multiplier & +300 Karma
}

export interface IPowerUpItemMeta {
  type: PowerUpType;
  name: string;
  rarity: 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'MYTHIC';
  description: string;
  karmaBonus: number;
}

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
    description: 'Eliminates one SOS incident instantly with +200 bonus Karma.',
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
