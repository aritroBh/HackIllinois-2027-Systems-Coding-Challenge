/**
 * Presence HTTP mirror contracts. `POST /presence` is the SSE fallback's input; the
 * WebSocket carries the same fields in its `pos` frame.
 */
import { z } from 'zod';

/**
 * One position sample over the SSE fallback.
 *
 * The bounds here are shape checks, not the privacy or anti-spoof gates — those live in
 * `PresenceStore` and are pack-configurable (`maxAccuracyMeters`, `maxSpeedMps`), because
 * they are judgements about a venue rather than about JSON. So `acc` is capped at 10 km here
 * only to keep a nonsense number out of the store, which then refuses anything worse than the
 * pack's accuracy limit; and `spd` is accepted unbounded-above because the store derives its
 * own speed from consecutive samples and mutes a sender whose *derived* speed is impossible
 * three times running. A client cannot buy leniency by lying in this field.
 *
 * `h` (heading) is optional and unbounded: the store normalises it into 0..360 rather than
 * rejecting, since a client reporting 370 means 10 and refusing the sample would drop a
 * position over a wrapped angle.
 */
export const postPresenceSchema = z.object({
  body: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    acc: z.number().nonnegative().max(10000),
    h: z.number().optional(),
    spd: z.number().nonnegative().optional(),
  }),
});

/**
 * The durable opt-in. This is the one that persists — `DELETE /presence` only clears the live
 * entry, and a socket that keeps publishing recreates it. Opting out is symmetric: it stops
 * you appearing to other players and stops you seeing them.
 */
export const patchPresencePrefSchema = z.object({
  body: z.object({ optIn: z.boolean() }),
});

/**
 * A lead's read of who is where. Every field is optional, so an unfiltered call is legal and
 * returns the whole board; the radius is capped at 5 km, which is the campus bounding box,
 * so asking for more is not a larger answer.
 *
 * This route is one of the three that see unfuzzed positions, and every call writes a
 * `presenceAudit` row. The gate is on the route, not here.
 */
export const listPresenceSchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusMeters: z.coerce.number().positive().max(5000).optional(),
  }),
});
