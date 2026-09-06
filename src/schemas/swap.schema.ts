/**
 * Shift-swap contracts.
 *
 * `targetVolunteerId` is optional, and that optionality is the whole design: supplying
 * it creates a bilateral proposal aimed at one person, omitting it creates an open offer
 * that the cycle finder can weave into a multi-party rotation. `desiredShiftIds` carries
 * the outgoing edges of that graph.
 *
 * `acceptSwapSchema` takes the accepting volunteer's id in the body. The service checks
 * that this person actually holds the target shift, but the id is caller-asserted — so
 * this authorises by claim, not by authenticated identity. Binding it to a session is
 * the outstanding hardening step.
 */
import { z } from 'zod';
import { objectId } from './common';

export const createSwapRequestSchema = z.object({
  body: z.object({
    proposerVolunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the proposer
    proposerShiftId: objectId('Invalid Shift ObjectId'),
    targetVolunteerId: objectId('Invalid Volunteer ObjectId').optional(),
    targetShiftId: objectId('Invalid Shift ObjectId'),
    desiredShiftIds: z.array(objectId()).optional(),
  }),
});

export const acceptSwapSchema = z.object({
  params: z.object({
    id: objectId('Invalid Swap ObjectId'),
  }),
  body: z.object({
    targetVolunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the acceptor
  }),
});
