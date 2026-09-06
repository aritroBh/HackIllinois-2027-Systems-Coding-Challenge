/**
 * PokéShift contracts — gym battles, beacon spins, inventory.
 *
 * `power` is bounded (10..500) so a single strike cannot capture or fully fortify a
 * control point; territory has to be contested over multiple actions by multiple people,
 * which is the point of the mechanic.
 *
 * `coordinates` is required on both battle and spin. The service additionally consults
 * `REQUIRE_GEOFENCE` for gyms, but because Zod rejects a missing pair first, that flag
 * cannot loosen this schema — coordinates are mandatory over HTTP in every posture.
 */
import { z } from 'zod';
import { objectId } from './common';
import { Faction } from '../models/gym.model';
import { PowerUpType } from '../models/powerup.model';

export const battleGymSchema = z.object({
  params: z.object({
    id: objectId('Invalid Gym ObjectId'),
  }),
  body: z.object({
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the actor
    faction: z.nativeEnum(Faction),
    power: z.number().min(10, 'Power must be at least 10').max(500, 'Power cannot exceed 500 per strike'),
    coordinates: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }),
  }),
});

export const spinBeaconSchema = z.object({
  params: z.object({
    beaconId: z.string().min(1, 'Beacon ID is required'),
  }),
  body: z.object({
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the actor
    coordinates: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }),
  }),
});

export const getInventorySchema = z.object({
  params: z.object({
    volunteerId: objectId('Invalid Volunteer ObjectId'), // path segment, always present — required so a malformed id is a clean 400
  }),
});

export const usePowerUpSchema = z.object({
  body: z.object({
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the actor
    itemType: z.nativeEnum(PowerUpType),
    targetGymId: objectId('Invalid Gym ObjectId').optional(),
  }),
});
