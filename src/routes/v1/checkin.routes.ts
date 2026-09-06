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
import { requireVolunteerKind, requireRole } from '../../middleware/identity';
import {
  generateQrTokenSchema,
  verifyCheckInSchema,
  checkOutSchema,
} from '../../schemas/checkin.schema';

export const checkinRouter = Router();

checkinRouter.post('/token', requireVolunteerKind, validate(generateQrTokenSchema), CheckInController.generateToken);
/**
 * The desk, not the volunteer standing at it.
 *
 * `/token` and `/verify` were both gated the same way, so the person being checked in could
 * mint their own token and then scan it themselves: attendance and the karma that follows
 * from it, from a phone, without anybody at a desk. The geofence is no help — the position
 * is whatever the client sends — and neither is the token, which is doing its job perfectly
 * by proving the holder minted it. Nothing separated "who is being checked in" from "who is
 * doing the checking" until this line.
 *
 * `requireRole('SHIFT_LEAD')` accepts lead-or-above. In `legacy` mode this passes an
 * anonymous caller, as every role gate does — that is the open-demo contract, and the demo
 * dashboard's desk-scan button runs as the signed-in organiser either way.
 */
checkinRouter.post('/verify', requireVolunteerKind, requireRole('SHIFT_LEAD'), validate(verifyCheckInSchema), CheckInController.verifyCheckIn);
checkinRouter.post('/:id/checkout', requireVolunteerKind, validate(checkOutSchema), CheckInController.checkOut);
