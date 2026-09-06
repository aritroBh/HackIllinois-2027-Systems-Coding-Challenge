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
import { SwapStatus } from '../models/swap.model';

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

/**
 * The list filter.
 *
 * `GET /swaps` was the one list route with no `validate()`, so Express's extended query
 * parser turned `?status[$regex]=.*` into `{ status: { $regex: '.*' } }` and handed it
 * straight to `ShiftSwap.find`. Nothing is disclosed that the unfiltered list does not
 * already show, so this is a server-side regex CPU vector rather than a read bypass — but
 * every comparable route (`GET /sos/tickets`, `GET /registrations`) is validated, and a
 * guard that is present everywhere except one place is the one that gets forgotten again.
 */
export const listSwapsQuerySchema = z.object({
  query: z.object({
    status: z.nativeEnum(SwapStatus).optional(),
  }),
});
