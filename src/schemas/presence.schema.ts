/**
 * Presence HTTP mirror contracts. `POST /presence` is the SSE fallback's input; the
 * WebSocket carries the same fields in its `pos` frame.
 */
import { z } from 'zod';

export const postPresenceSchema = z.object({
  body: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    acc: z.number().nonnegative().max(10000),
    h: z.number().optional(),
    spd: z.number().nonnegative().optional(),
  }),
});

export const patchPresencePrefSchema = z.object({
  body: z.object({ optIn: z.boolean() }),
});

export const listPresenceSchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusMeters: z.coerce.number().positive().max(5000).optional(),
  }),
});
