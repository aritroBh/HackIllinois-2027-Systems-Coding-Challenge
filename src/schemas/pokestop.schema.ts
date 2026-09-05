import { z } from 'zod';
import { Faction } from '../models/gym.model';
import { PowerUpType } from '../models/powerup.model';

export const battleGymSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Gym ObjectId'),
  }),
  body: z.object({
    volunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
    faction: z.nativeEnum(Faction),
    power: z.number().min(1, 'Power must be at least 1').max(500, 'Power cannot exceed 500 per strike'),
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
    volunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
    coordinates: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }),
  }),
});

export const getInventorySchema = z.object({
  params: z.object({
    volunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
  }),
});

export const usePowerUpSchema = z.object({
  body: z.object({
    volunteerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Volunteer ObjectId'),
    itemType: z.nativeEnum(PowerUpType),
    targetGymId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid Gym ObjectId').optional(),
  }),
});
