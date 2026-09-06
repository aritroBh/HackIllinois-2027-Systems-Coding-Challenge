/**
 * Shift-swap contracts.
 *
 * `targetVolunteerId` is optional, and that optionality is the whole design: supplying
 * it creates a bilateral proposal aimed at one person, omitting it creates an open offer
 * that the cycle finder can weave into a multi-party rotation. `desiredShiftIds` carries
 * the outgoing edges of that graph.
 *
 * The acting volunteer (proposer or acceptor) is the session account, resolved by
 * `resolveActorId`; the body ids below are legacy-mode fallbacks only and are ignored when
 * a session is present, so nobody can act as someone else by naming them.
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
