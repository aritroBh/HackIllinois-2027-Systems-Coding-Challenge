/**
 * PokéShift routes — `/api/v1/pokeshift`.
 *
 * Gym contests, geofenced beacon spins, and power-up inventory. Both mutating gym and
 * beacon routes require GPS coordinates at the schema level.
 */
import { Router } from 'express';
import { GymController } from '../../controllers/gym.controller';
import { HackStopController } from '../../controllers/hackstop.controller';
import { validate } from '../../middleware/validate';
import { requireAccount, requireSession } from '../../middleware/identity';
import {
  battleGymSchema,
  spinBeaconSchema,
  getInventorySchema,
  usePowerUpSchema,
} from '../../schemas/pokestop.schema';

export const pokeShiftRouter = Router();

// Gym endpoints
pokeShiftRouter.get('/gyms', GymController.listGyms);
pokeShiftRouter.post('/gyms/:id/battle', validate(battleGymSchema), GymController.battleOrContribute);

// HackStop supply beacon endpoints
pokeShiftRouter.get('/hackstops', HackStopController.listBeacons);
pokeShiftRouter.post('/hackstops/:beaconId/spin', validate(spinBeaconSchema), HackStopController.spinBeacon);

// Inventory endpoints
/*
 * `requireSession`, like the three `/me` reads that answer the same question.
 *
 * "What is in that named person's bag" is a disclosure, and this route took the account id as a
 * **path parameter** — which is why the round that put `requireSession` on `GET /me/inventory`,
 * `/quests` and `/stickers` never reached it. Two holes, not one: in `legacy` the controller's
 * ownership check was switched off entirely, and in `required` it read
 * `env.AUTH_MODE === 'required' && req.account && …`, so an **anonymous** caller short-circuited
 * the whole condition and read any inventory in the mode that exists to refuse them.
 */
pokeShiftRouter.get('/inventory/:volunteerId', requireSession, requireAccount, validate(getInventorySchema), HackStopController.getInventory);
pokeShiftRouter.post('/inventory/use', validate(usePowerUpSchema), HackStopController.usePowerUp);
