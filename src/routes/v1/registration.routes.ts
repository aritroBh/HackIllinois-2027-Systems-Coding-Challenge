/**
 * Registration routes — `/api/v1/registrations`.
 *
 * `POST /` honours an optional `Idempotency-Key` header: a replayed key returns the
 * stored response with `200` rather than creating a second booking.
 *
 * `DELETE /:id` requires the owning volunteer's id, accepted from either the JSON body
 * or the query string — the dashboard sends a bodyless DELETE with a query parameter.
 */
import { Router } from 'express';
import { RegistrationController } from '../../controllers/registration.controller';
import { validate } from '../../middleware/validate';
import { requireVolunteerKind } from '../../middleware/identity';
import {
  reserveShiftSchema,
  cancelRegistrationSchema,
  listRegistrationsQuerySchema,
} from '../../schemas/registration.schema';

export const registrationRouter = Router();

// Shifts are staff work: a signed-in hacker is refused (legacy anonymous callers pass).
registrationRouter.post('/', requireVolunteerKind, validate(reserveShiftSchema), RegistrationController.reserveShift);
registrationRouter.delete('/:id', requireVolunteerKind, validate(cancelRegistrationSchema), RegistrationController.cancelRegistration);
registrationRouter.get('/', validate(listRegistrationsQuerySchema), RegistrationController.listRegistrations);
