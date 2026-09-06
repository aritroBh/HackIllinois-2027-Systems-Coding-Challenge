/**
 * Attendance contracts — QR token issuance, desk verification, and check-out.
 *
 * `coordinates` on `verifyCheckInSchema` is **required**, and deliberately so: making it
 * optional would let a scanner omit the field and skip the 75 m geofence entirely, which
 * is a fail-open bypass of the whole anti-fraud path. Latitude and longitude are bounded
 * to real values so a malformed pair is a 400 rather than a NaN distance downstream.
 *
 * Checkout is bound to the caller: the controller derives the actor from the session
 * (`resolveActorId`), and the service compares it to the check-in's owner so one volunteer
 * cannot close another's shift and collect their karma. `volunteerId` in the body is only a
 * legacy-mode fallback (AUTH_MODE=legacy).
 */
import { z } from 'zod';
import { objectId } from './common';

export const generateQrTokenSchema = z.object({
  body: z.object({
    shiftId: objectId('Invalid Shift ObjectId'),
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the actor
  }),
});

export const verifyCheckInSchema = z.object({
  body: z.object({
    token: z.string().min(20, 'Malformed token string'),
    scannerId: z.string().default('DESK_SCANNER_MAIN'),
    // ponytail: required — optional coords used to skip the geofence (remote check-in fraud).
    coordinates: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }),
  }),
});

export const checkOutSchema = z.object({
  params: z.object({
    id: objectId('Invalid CheckIn ObjectId'),
  }),
  // ponytail: owner proof — only the checked-in volunteer may check out.
  body: z.object({
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the actor
  }),
});
