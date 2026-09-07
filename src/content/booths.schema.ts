/**
 * Sponsor booths in a content pack (plan §A6).
 *
 * A booth is a table with a QR poster on it. Scanning it pays once per account, ever, which
 * is the whole mechanic: the reward is for having walked the row and talked to somebody, not
 * for having stood in front of the sign.
 *
 * **The code is deliberately not in this file.** A booth's scan code is derived by the
 * server from the booth id and `QR_HMAC_SECRET`, so a copy of the pack — which is public,
 * served to every browser under `/dashboard/content` — is a list of booths and not a list of
 * free karma. The pack decides which booths exist and what they pay; the deployment's secret
 * decides what unlocks them.
 *
 * `sticker` and `powerUp` are checked here for shape only. Their vocabularies live elsewhere
 * (`memorabilia.json` and the power-up catalog), and `BoothService` rejects an id neither
 * knows at catalog build, where the message can name the file that would have to change.
 *
 * Separate from `schema.ts` for the same reason `quests.schema.ts` is: it is new and
 * `schema.ts` is shared.
 */
import { z } from 'zod';

/** One sponsor table. `id` is the scan key and the HMAC input, so it is bounded to a URL-safe alphabet at 60 characters. */
export const boothSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(60),
  sponsor: z.string().min(1).max(60),
  name: z.string().min(1).max(60),
  blurb: z.string().max(200).default(''),
  /** A venue key from `venues.json`, so the map can put the booth somewhere. */
  venue: z.string().min(1),
  reward: z.object({
    karma: z.number().int().nonnegative().max(10000),
    /** An item id from the pack's `memorabilia.json`. */
    sticker: z.string().regex(/^[a-z0-9-]+$/).optional(),
    /** A `PowerUpType`, granted into the scanner's inventory. */
    powerUp: z.string().regex(/^[A-Z_]+$/).optional(),
  }),
});

/**
 * The file. Capped at 200 booths — a sponsor row, not a directory — and checked for duplicate
 * ids, which is the failure worth catching here because it is silent: two booths with one id
 * share one `boothScan` row per account, so the second is not mislabelled, it is unscannable.
 */
export const boothsSchema = z.object({
  _about: z.string().optional(),
  booths: z
    .array(boothSchema)
    .max(200)
    .superRefine((booths, ctx) => {
      // A duplicate id would give two booths one scan row, so the second would be
      // unscannable rather than merely mislabelled.
      const seen = new Set<string>();
      for (const [index, booth] of booths.entries()) {
        if (seen.has(booth.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: `duplicate booth id "${booth.id}"` });
        }
        seen.add(booth.id);
      }
    }),
});

/** Inferred rather than hand-written, so the type and the validator cannot drift. */
export type Booth = z.infer<typeof boothSchema>;
export type BoothsFile = z.infer<typeof boothsSchema>;
