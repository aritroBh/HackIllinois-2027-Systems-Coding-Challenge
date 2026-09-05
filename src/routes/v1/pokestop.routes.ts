import { Router } from 'express';
import { GymController } from '../../controllers/gym.controller';
import { HackStopController } from '../../controllers/hackstop.controller';
import { validate } from '../../middleware/validate';
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
pokeShiftRouter.get('/inventory/:volunteerId', validate(getInventorySchema), HackStopController.getInventory);
pokeShiftRouter.post('/inventory/use', validate(usePowerUpSchema), HackStopController.usePowerUp);
