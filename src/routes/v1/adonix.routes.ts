/**
 * Adonix integration route — `/api/v1/adonix`.
 *
 * `POST /sync` ingests the official HackIllinois schedule and upserts synthesised shifts
 * keyed on title, which **rewrites the start/end times of existing shifts**. That is a
 * destructive organiser operation, not a read, so it is gated `requireRole('ORGANIZER')`:
 * in `AUTH_MODE=required` a signed-in hacker (or any non-organiser) is refused, and the
 * legacy open-demo contract is preserved because `requireRole` passes anonymous callers
 * through in `legacy` mode. Without this gate any authenticated account could re-time the
 * whole schedule out from under the volunteers registered against it.
 */
import { Router } from 'express';
import { AdonixController } from '../../controllers/adonix.controller';
import { requireRole } from '../../middleware/identity';

export const adonixRouter = Router();

adonixRouter.post('/sync', requireRole('ORGANIZER'), AdonixController.syncOfficialEvents);
