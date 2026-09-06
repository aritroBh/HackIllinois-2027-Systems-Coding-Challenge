/**
 * Attendance routes — `/api/v1/attendance`.
 *
 * `POST /token` mints a 30-second rotating HMAC token, `POST /verify` is the desk
 * scanner endpoint, and `POST /:id/checkout` closes the shift and pays karma.
 *
 * Verification requires GPS coordinates at the schema level, so the 75 m geofence cannot
 * be skipped by omitting the field.
 */
import { Router } from 'express';
import { CheckInController } from '../../controllers/checkin.controller';
import { validate } from '../../middleware/validate';
import { requireVolunteerKind } from '../../middleware/identity';
import {
  generateQrTokenSchema,
  verifyCheckInSchema,
  checkOutSchema,
} from '../../schemas/checkin.schema';

export const checkinRouter = Router();

checkinRouter.post('/token', requireVolunteerKind, validate(generateQrTokenSchema), CheckInController.generateToken);
checkinRouter.post('/verify', requireVolunteerKind, validate(verifyCheckInSchema), CheckInController.verifyCheckIn);
checkinRouter.post('/:id/checkout', requireVolunteerKind, validate(checkOutSchema), CheckInController.checkOut);
