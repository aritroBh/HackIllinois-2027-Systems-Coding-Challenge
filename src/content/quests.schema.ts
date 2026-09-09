/**
 * Quest definitions in a content pack (plan §A6).
 *
 * Quests are content. A pack decides what the event asks of its players, and the server
 * only knows three ways to count: increment, collect distinct things, or count consecutive
 * windows. That split is what lets a fork ship its own quest list without touching the
 * service, and it is why this schema is stricter than the JSON strictly needs to be — a
 * quest that cannot advance is invisible rather than loud, so the shapes that cannot
 * advance are rejected at load instead.
 *
 * Three of those shapes are worth naming. A DISTINCT quest without `distinctBy` has no
 * field to collect and would sit at zero forever. A STREAK over the whole event has no step
 * to be consecutive in, so it is restricted to hourly or daily. And a duplicate id would
 * give two quests the same progress row, which the unique index on
 * `(accountId, questId, windowKey)` would then merge into one silently.
 *
 * `event` is a domain event name from `src/common/events/domainEvents.ts`. Zod checks its shape
 * here, and `content/loader.ts` checks the name against `DOMAIN_EVENT_NAMES` — so a typo is
 * refused by `npm run content:validate` rather than becoming a quest that sits at zero all
 * weekend.
 *
 * This comment used to say the name was checked "only for shape, because the pack is not allowed
 * to depend on the server's build", and that a dead quest was something "the wiring reports, not
 * a broken pack". Neither half held. `QuestService.advance` returns an empty array for an event
 * nothing listens for, with no log, and `npm run events:check` — named in `docs/CONTENT-PACKS.md`
 * as the thing that reported it — inspects the SSE bridge and cannot even match a dotted name
 * like `registration.created`. Nothing reported anything.
 *
 * This file is separate from `schema.ts` for one reason: it is new and `schema.ts` is
 * shared. Folding it in is a two-line change described in the M6 wiring notes.
 */
import { z } from 'zod';

/** The three ways the server knows how to count. A pack may combine them; it may not add one. */
export const QUEST_KINDS = ['COUNT', 'STREAK', 'DISTINCT'] as const;
/** The three window shapes, which become the `windowKey` on a `questProgress` row — `YYYY-MM-DDTHH`, `YYYY-MM-DD`, or the literal `event`. */
export const QUEST_WINDOWS = ['HOURLY', 'DAILY', 'EVENT'] as const;

/** How progress accrues: a raw count, consecutive windows, or distinct targets. */
export type QuestKind = (typeof QUEST_KINDS)[number];
/** The bucket progress resets in: hourly, daily, or once for the whole event. */
export type QuestWindow = (typeof QUEST_WINDOWS)[number];

export const questSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1).max(60),
    blurb: z.string().max(200).default(''),
    kind: z.enum(QUEST_KINDS),
    /** How many increments, distinct values or consecutive windows finish it. */
    target: z.number().int().positive().max(1000),
    window: z.enum(QUEST_WINDOWS),
    /** The payload field a DISTINCT quest collects, such as `beaconId` or `shiftId`. */
    distinctBy: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).optional(),
    /** When true, progress counts only while the player is checked in to a shift. */
    anchoredToDuty: z.boolean().default(false),
    /** The domain event that advances this quest, as `noun.verb`. */
    event: z.string().regex(/^[a-z]+\.[a-z]+$/),
    reward: z.object({
      karma: z.number().int().nonnegative().max(10000),
      /** An item id from the pack's `memorabilia.json`; the sticker service rejects unknown ids. */
      sticker: z.string().regex(/^[a-z0-9-]+$/).optional(),
    }),
  })
  .superRefine((quest, ctx) => {
    if (quest.kind === 'DISTINCT' && !quest.distinctBy) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['distinctBy'], message: 'a DISTINCT quest must name the field it collects' });
    }
    if (quest.kind !== 'DISTINCT' && quest.distinctBy) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['distinctBy'], message: `distinctBy is only read for DISTINCT quests, not ${quest.kind}` });
    }
    if (quest.kind === 'STREAK' && quest.window === 'EVENT') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['window'], message: 'a STREAK counts consecutive windows, so it needs HOURLY or DAILY' });
    }
  });

/** The file, capped at 200 and rejected on a duplicate id — see the header for why a duplicate is worse than it looks. */
export const questsSchema = z.object({
  _about: z.string().optional(),
  quests: z
    .array(questSchema)
    .max(200)
    .superRefine((quests, ctx) => {
      const seen = new Set<string>();
      for (const [index, quest] of quests.entries()) {
        if (seen.has(quest.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: `duplicate quest id "${quest.id}"` });
        }
        seen.add(quest.id);
      }
    }),
});

/** A quest definition: what counts, in which window, and what it pays. */
export type Quest = z.infer<typeof questSchema>;
/** A parsed `quests.json`: every quest the event offers. */
export type QuestsFile = z.infer<typeof questsSchema>;
