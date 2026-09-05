/**
 * Shift CRUD contracts.
 *
 * `createShiftSchema` carries a `.refine()` asserting `startTime < endTime` — a
 * cross-field rule Zod cannot express in a single field validator.
 *
 * `updateShiftSchema` carries the same refine, but note its guard clause: it passes when
 * *either* bound is absent, because a PATCH is partial and Zod only sees the submitted
 * fields. So it catches an inverted pair sent together, and cannot catch a single-bound
 * PATCH that inverts the interval against the value already stored. Validating that
 * requires reading the current document, so it belongs in `ShiftService.updateShift`
 * alongside the existing capacity-below-`filledSlots` guard — not here.
 *
 * `listShiftsQuerySchema` coerces and clamps pagination (`limit` positive, max 100,
 * default 50) rather than trusting the query string: an unbounded or NaN limit would
 * otherwise reach Mongo and turn a list call into a full collection scan.
 */
import { z } from 'zod';
import { objectId } from './common';
import { ShiftCategory } from '../models/shift.model';

export const createShiftSchema = z.object({
  body: z.object({
    title: z.string().min(3, 'Title must be at least 3 characters long'),
    description: z.string().min(5, 'Description must be at least 5 characters long'),
    category: z.nativeEnum(ShiftCategory).default(ShiftCategory.LOGISTICS),
    location: z.string().min(2, 'Location is required').max(120),
    startTime: z.string().datetime({ message: 'startTime must be a valid ISO 8601 string' }),
    endTime: z.string().datetime({ message: 'endTime must be a valid ISO 8601 string' }),
    // ponytail: upper bounds — shift creation is open, so uncapped capacity/karma mint farmable rewards.
    capacity: z.number().int().positive('Capacity must be at least 1').max(500),
    requiredSkills: z.array(z.string()).default([]),
    baseKarma: z.number().int().min(10).max(2000).default(100),
    manualSurgeMultiplier: z.number().min(1.0).max(5.0).default(1.0),
  }).refine((data) => new Date(data.startTime) < new Date(data.endTime), {
    message: 'startTime must occur before endTime',
    path: ['endTime'],
  }),
});

export const updateShiftSchema = z.object({
  params: z.object({
    id: objectId('Invalid Shift ObjectId'),
  }),
  body: z.object({
    title: z.string().min(3).optional(),
    description: z.string().min(5).optional(),
    category: z.nativeEnum(ShiftCategory).optional(),
    location: z.string().min(2).max(120).optional(),
    startTime: z.string().datetime().optional(),
    endTime: z.string().datetime().optional(),
    capacity: z.number().int().positive().max(500).optional(),
    requiredSkills: z.array(z.string()).optional(),
    baseKarma: z.number().int().min(10).max(2000).optional(),
    manualSurgeMultiplier: z.number().min(1.0).max(5.0).optional(),
    isActive: z.boolean().optional(),
  }).refine(
    (data) =>
      data.startTime === undefined ||
      data.endTime === undefined ||
      new Date(data.startTime) < new Date(data.endTime),
    { message: 'startTime must occur before endTime', path: ['endTime'] }
  ),
});

export const getShiftParamsSchema = z.object({
  params: z.object({
    id: objectId('Invalid Shift ObjectId'),
  }),
});

export const listShiftsQuerySchema = z.object({
  query: z.object({
    category: z.nativeEnum(ShiftCategory).optional(),
    location: z.string().optional(),
    availableOnly: z.enum(['true', 'false']).optional(),
    surgeOnly: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
});
