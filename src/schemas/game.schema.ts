/**
 * Game board contracts — the leaderboard page and the booth scan.
 *
 * The booth id is a path segment matched against the pack, so it is shaped here to the same
 * `[a-z0-9-]` alphabet `booths.json` uses. That is not decoration: the value goes into a
 * Mongo query and into an HMAC input, and a bounded alphabet at the boundary means neither
 * call site has to think about what else a URL segment can contain.
 *
 * `code` is bounded but not shaped. It is typed off a sign by someone who has been awake for
 * a day and a half, so separators and casing reach the service, which normalises them; a
 * strict pattern here would turn a hyphen into a 400 instead of a scan.
 */
import { z } from 'zod';
import { objectId } from './common';

export const scanBoothSchema = z.object({
  params: z.object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/, 'Invalid booth id'),
  }),
  body: z.object({
    volunteerId: objectId('Invalid Volunteer ObjectId').optional(), // legacy-mode fallback only; the session is the actor
    code: z.string().trim().min(4, 'Booth code is required').max(64),
  }),
});

/**
 * `limit` is coerced from the query string and clamped to 100 with a default of 25. The clamp
 * is the point: this route sorts on an indexed field and returns names and karma totals, so an
 * unbounded limit is a whole-roster export dressed up as a leaderboard.
 */
export const leaderboardQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
  }),
});
