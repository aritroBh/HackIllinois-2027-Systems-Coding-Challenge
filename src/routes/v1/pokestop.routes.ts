import { Router } from 'express';
import { GymController } from '../../controllers/gym.controller';
import { HackStopController } from '../../controllers/hackstop.controller';

export const pokeShiftRouter = Router();

// Gym endpoints
pokeShiftRouter.get('/gyms', GymController.listGyms);
pokeShiftRouter.post('/gyms/:id/battle', GymController.battleOrContribute);

// HackStop supply beacon endpoints
pokeShiftRouter.get('/hackstops', HackStopController.listBeacons);
pokeShiftRouter.post('/hackstops/:beaconId/spin', HackStopController.spinBeacon);

// Inventory endpoints
pokeShiftRouter.get('/inventory/:volunteerId', HackStopController.getInventory);
pokeShiftRouter.post('/inventory/use', HackStopController.usePowerUp);
