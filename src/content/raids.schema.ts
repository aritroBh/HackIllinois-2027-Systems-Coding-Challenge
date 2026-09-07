/**
 * Raid windows in a content pack (plan §A6).
 *
 * A raid is one hour of the weekend the whole event is pointed at: a name, a place it is
 * called from, and a karma multiplier for as long as it is open. The window is two absolute
 * instants rather than a recurrence rule, because the organiser writing the schedule
 * already knows when 2 a.m. Saturday is, and a recurrence would only add a way to be wrong
 * about it across a daylight-saving boundary.
 *
 * `joinEvents` is what counts as taking part. Naming the events rather than hard-coding
 * them is what lets one pack run a beacon raid on Friday and a gym raid on Saturday with no
 * server change. The names are checked twice beyond their shape: `content/loader.ts` refuses one
 * that is not a real domain event, and `RaidService.subscribe` warns at boot for one that is real
 * but carries no account to enrol — `sos.resolved` is the example, and it is why that distinction
 * needs two checks rather than one.
 *
 * This comment used to say a raid listening for an event nothing emits was "an empty roster,
 * which the service reports". The service reported nothing; it mapped over a closed list and
 * recorded silence for the whole window.
 *
 * Windows are allowed to overlap. Two open raids is a legitimate schedule (a sponsor hour
 * inside a longer teardown), and the multiplier that applies is the larger one — decided in
 * `RaidService`, not here, because it is a rule about the economy rather than about JSON.
 *
 * This file is separate from `schema.ts` for the same reason `quests.schema.ts` is: it is
 * new and `schema.ts` is shared. Folding it in is a two-line change.
 */
import { z } from 'zod';

export const raidSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1).max(60),
    blurb: z.string().max(200).default(''),
    /** A venue key from `venues.json`. Where the raid is announced; a raid is not geofenced. */
    venue: z.string().min(1),
    /** ISO 8601 with an explicit offset, so the window means one instant and not three. */
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    /** What karma earned inside the window is worth. 1 is a raid with a roster and no bonus. */
    karmaMultiplier: z.number().min(1).max(5),
    /** Domain events that enrol an account in this raid, as `noun.verb`. */
    joinEvents: z.array(z.string().regex(/^[a-z]+\.[a-z]+$/)).min(1).max(8),
  })
  .superRefine((raid, ctx) => {
    if (Date.parse(raid.endsAt) <= Date.parse(raid.startsAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'a raid window must end after it starts' });
    }
  });

/** The file. The `.superRefine()` on the array catches duplicate ids; the one on each raid catches a window that ends before it starts. */
export const raidsSchema = z.object({
  _about: z.string().optional(),
  raids: z
    .array(raidSchema)
    .max(100)
    .superRefine((raids, ctx) => {
      // A duplicate id would give two raids one roster, because the join row is keyed by it.
      const seen = new Set<string>();
      for (const [index, raid] of raids.entries()) {
        if (seen.has(raid.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: `duplicate raid id "${raid.id}"` });
        }
        seen.add(raid.id);
      }
    }),
});

export type Raid = z.infer<typeof raidSchema>;
export type RaidsFile = z.infer<typeof raidsSchema>;
