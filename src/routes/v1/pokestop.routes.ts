/**
 * PokéShift routes — `/api/v1/pokeshift`. The turf-war half of the game layer: territory gyms
 * on campus landmarks, supply beacons you have to physically stand next to, and the power-ups
 * that come out of them.
 *
 *   GET  /gyms                      no gate      the board
 *   POST /gyms/:id/battle           no gate      contest or reinforce a gym
 *   GET  /hackstops                 no gate      the beacon list
 *   POST /hackstops/:beaconId/spin  no gate      spin a beacon you are standing at
 *   GET  /inventory/:volunteerId    requireSession, requireAccount
 *   POST /inventory/use             no gate      spend a power-up
 *
 * "No gate" here means no identity middleware on the route, not no authorisation. Four things
 * are doing that work instead, and a new route needs all four considered:
 *
 *  1. `enforceAuthMode` upstream has already refused anonymous callers in `required` mode, so
 *     the open rows are open only in the `legacy` demo posture.
 *  2. Every write resolves its actor with `resolveActorId`, which returns the session's id
 *     when there is one and falls back to a body field only in `legacy`. A body id therefore
 *     never overrides a session, and none of these controllers reads `volunteerId` directly.
 *  3. The mutating gym and beacon routes require GPS coordinates at the schema level, so the
 *     geofence cannot be skipped by omitting a field.
 *  4. Disclosure is decided per response rather than per route: `listBeacons` is handed the
 *     caller's `source`, and only a *proved* session gets its own per-beacon cooldown back.
 *     A claimed identity gets the bare list, because "when did this account last spin" is a
 *     position history when the account id came out of the query string.
 *
 * The inventory read is the exception that proves the rule, and the comment on it explains
 * why it needed a gate of its own: it names its subject in the path, which is what let the
 * earlier round of `requireSession` fixes on the `/me` reads miss it entirely.
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
