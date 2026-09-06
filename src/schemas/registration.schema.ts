/**
 * Reservation request contracts.
 *
 * Validation is contract-first: the `validate` middleware parses `body`, `query` and
 * `params` against these schemas *before* a controller runs, and replaces the raw
 * request fields with the parsed output. Two consequences worth knowing:
 *
 *  - Services can trust their inputs, so they carry invariant logic rather than shape
 *    checks. This is why a malformed ObjectId is a 400 from here and never reaches Mongo
 *    as a CastError.
 *  - Because the parsed result *replaces* `req.query`/`req.body`, unknown keys are
 *    stripped. That is the mass-assignment defence: a client cannot smuggle
 *    `karmaPoints` or `role` into a create call by adding fields.
 *
 * The 24-hex ObjectId pattern is case-insensitive (`[0-9a-fA-F]`), matching MongoDB,
 * which accepts either casing for the same id. Anything downstream that uses the raw
 * string as a *key* — a lock name, a Map entry, a hash input — must normalise it first,
 * or two spellings of one id become two identities.
 */
import { z } from 'zod';
import { objectId } from './common';

export const reserveShiftSchema = z.object({
  body: z.object({
    shiftId: objectId('Invalid Shift ObjectId'),
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the actor
  }),
  headers: z.object({
    'idempotency-key': z.string().min(8, 'idempotency-key header must be at least 8 characters').optional(),
  }).passthrough(),
});

export const cancelRegistrationSchema = z.object({
  params: z.object({
    id: objectId('Invalid Registration ObjectId'),
  }),
  // ponytail: owner proof — caller must name the owning volunteer (body preferred, query fallback for DELETE-without-body clients).
  body: z.object({
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(),
  }).optional(),
  query: z.object({
    volunteerId: objectId().optional(),
  }).optional(),
});

export const listRegistrationsQuerySchema = z.object({
  query: z.object({
    shiftId: objectId().optional(),
    volunteerId: objectId().optional(),
    // Every member of `RegistrationStatus`. SWAP_PENDING was missing, so filtering for
    // in-flight swaps returned a 400 for a status the model can genuinely hold.
    status: z
      .enum(['CONFIRMED', 'WAITLISTED', 'CANCELLED', 'CHECKED_IN', 'COMPLETED', 'SWAP_PENDING'])
      .optional(),
  }),
});
