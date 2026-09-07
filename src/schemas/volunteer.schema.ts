/**
 * Volunteer contracts.
 *
 * The create schema accepts only `{ name, email, phone, kind, certifications }` — `role` is
 * deliberately not among them, so the ladder cannot be climbed at signup — and the
 * controller narrows further by constructing the document explicitly rather than
 * spreading the request body — so `karmaPoints`, `prestigeTier` and `badges` cannot be
 * set by a client. Those are earned server-side or not at all.
 *
 * Caveat worth stating plainly: `certifications` is self-declared at signup and is what
 * the shift skill gate checks. Until certifications are issued by an organiser rather
 * than asserted by the applicant, that gate documents intent rather than enforcing it.
 */
import { z } from 'zod';
import { objectId } from './common';

export const createVolunteerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    phone: z.string().optional(),
    // ponytail: `role` deliberately not client-writable; server forces VOLUNTEER (privilege-escalation fix).
    /**
     * The registration desk creating a hacker account. Honoured only for a signed-in lead+
     * (the controller checks); anyone else gets a VOLUNTEER regardless of what they send,
     * so this can never be a self-service route to a different account class.
     */
    kind: z.enum(['VOLUNTEER', 'HACKER']).optional(),
    certifications: z.array(z.string()).default([]),
  }),
});

export const getVolunteerParamsSchema = z.object({
  params: z.object({
    id: objectId('Invalid Volunteer ObjectId'),
  }),
});

/**
 * `PATCH /me/faction` — choosing a side, once.
 *
 * The id is deliberately *not* validated against the pack here. Zod would have to be rebuilt
 * per pack to do it, and the real check belongs next to the rule anyway: `assertPlayable` in
 * `faction.service.ts` reads `pack.factions` and refuses NEUTRAL with a message that lists what
 * this event's sides actually are. This schema only guarantees the field is a plausible id, so
 * a malformed body is a 400 before it reaches a database lookup.
 */
export const chooseFactionSchema = z.object({
  body: z.object({
    faction: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Z][A-Z0-9_]*$/, 'A faction id is SCREAMING_SNAKE_CASE, as declared in factions.json'),
  }),
});
