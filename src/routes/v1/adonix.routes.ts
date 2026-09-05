/**
 * Adonix integration route — `/api/v1/adonix`.
 *
 * `POST /sync` ingests the official HackIllinois schedule and upserts synthesised shifts
 * keyed on title. It is currently unauthenticated and rewrites the times of existing
 * shifts, so it should sit behind organiser auth before real use.
 */
import { Router } from 'express';
import { AdonixController } from '../../controllers/adonix.controller';

export const adonixRouter = Router();

adonixRouter.post('/sync', AdonixController.syncOfficialEvents);
