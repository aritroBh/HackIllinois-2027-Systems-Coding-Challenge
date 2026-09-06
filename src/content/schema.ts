/**
 * Content pack contract.
 *
 * A pack is a directory of JSON files describing one event on one campus: the gazetteer,
 * the landmark gyms, factions, seed territories and beacons, loot, memorabilia, branding
 * and the baked 3D model. Everything HackIllinois/UIUC-specific lives in
 * `content/hackillinois-2027/`; the code reads the pack and never a literal.
 *
 * Validation is Zod per file plus cross-references in `validatePack()`: every venue key a
 * territory, beacon or monument names must exist, every faction a territory names must
 * exist, and the monument ids must equal the ids baked into `campus.json`. A typo here is
 * a geofence anchored to the wrong building, which is exactly the class of bug the
 * original `resolveVenue` rewrite existed to prevent — so the pack fails at boot, loudly.
 */
import { z } from 'zod';
import { KARMA_SOURCES } from '../common/karmaSources';

const latLng = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]); // south, west, north, east
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const eventSchema = z.object({
  packVersion: z.literal(1),
  minServerVersion: z.string(),
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  eventName: z.string().min(1),
  tagline: z.string().default(''),
  timezone: z.string().min(1),
  startsAt: z.string(),
  endsAt: z.string(),
  hqVenue: z.string().min(1),
  campus: z.object({
    label: z.string().min(1),
    origin: latLng,
    bbox,
    coreBbox: bbox.optional(),
    /** Where pedestrian-scale detail (footways, lamps) is baked; defaults to coreBbox. */
    detailBbox: bbox.optional(),
    metersPerUnit: z.number().positive(),
    vscale: z.number().positive().default(2.6),
    geofenceMeters: z.number().positive().default(75),
  }),
  branding: z.object({
    palette: z.record(hex),
    fonts: z.object({ hud: z.string(), numbers: z.string(), headings: z.string(), body: z.string() }),
    mascot: z.string().default(''),
    stickerBookTitle: z.string().default('Memorabilia'),
  }),
  presence: z
    .object({
      maxAccuracyMeters: z.number().positive().default(50),
      maxSpeedMps: z.number().positive().default(15),
      fuzzGridMeters: z.number().positive().default(20),
      interestRadiusMeters: z.number().positive().default(300),
      cellMeters: z.number().positive().default(50),
      maxDetail: z.number().int().positive().default(60),
    })
    .default({}),
  karmaCaps: z.record(z.number().int().nonnegative()).default({}),
  bountyCap: z.record(z.number().int().positive()).default({}),
  hackerBountyBudgetPerDay: z.number().int().nonnegative().default(600),
  plugins: z.array(z.string()).default([]),
});

export const venueSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  hints: z.array(z.string().min(1)).default([]),
  radiusMeters: z.number().positive().optional(),
});
export const venuesSchema = z
  .record(z.string(), z.union([venueSchema, z.string()]))
  .superRefine((rec, ctx) => {
    for (const [k, v] of Object.entries(rec)) {
      if (k.startsWith('_')) {
        if (typeof v !== 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'documentation keys must be strings' });
        continue;
      }
      if (!/^[A-Z0-9_]+$/.test(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'venue keys are SCREAMING_SNAKE_CASE' });
      if (typeof v === 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'venue entries must be objects' });
    }
  })
  .transform((rec) => {
    // Drop the `_about` documentation key and keep the venue entries.
    const out: Record<string, z.infer<typeof venueSchema>> = {};
    for (const [k, v] of Object.entries(rec)) if (!k.startsWith('_') && typeof v !== 'string') out[k] = v;
    return out;
  });

export const monumentSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    short: z.string().min(1),
    name: z.string().min(1),
    mat: z.string().min(1),
    kind: z.string().min(1),
    venue: z.string().min(1),
    venueKey: z.string().min(1),
    blurb: z.string().default(''),
    match: z.string().optional(),
    at: latLng.optional(),
    synth: z.tuple([z.number(), z.number(), z.number()]).optional(),
    /** Hand-verified height in metres, overriding OSM/lidar (e.g. a dome OSM tags as one level). */
    height: z.number().positive().max(200).optional(),
    crown: z.object({ kind: z.string(), ops: z.array(z.record(z.unknown())) }).optional(),
  })
  .refine((m) => !!m.match || !!m.at, { message: 'a monument needs `match` (OSM name) or `at` (centroid)' });
export const monumentsSchema = z.object({ _about: z.string().optional(), monuments: z.array(monumentSchema).min(1) });

export const factionSchema = z.object({
  id: z.string().regex(/^[A-Z0-9_]+$/),
  label: z.string().min(1),
  short: z.string().min(1),
  color: hex,
  hqVenue: z.string().optional(),
  theme: z.string().optional(),
});
export const factionsSchema = z.object({ _about: z.string().optional(), factions: z.array(factionSchema).min(2) });

export const territorySchema = z.object({
  name: z.string().min(1),
  locationName: z.string().min(1),
  venue: z.string().min(1),
  monument: z.string().min(1),
  faction: z.string().min(1),
  cp: z.number().int().nonnegative(),
  max: z.number().int().positive(),
  level: z.number().int().positive(),
});
export const territoriesSchema = z.object({ _about: z.string().optional(), territories: z.array(territorySchema) });

export const beaconSchema = z.object({
  id: z.string().regex(/^[A-Z0-9_]+$/),
  name: z.string().min(1),
  where: z.string().min(1),
  venue: z.string().min(1),
  radiusMeters: z.number().positive().optional(),
});
export const beaconsSchema = z.object({ _about: z.string().optional(), beacons: z.array(beaconSchema) });

export const lootSchema = z.object({
  _about: z.string().optional(),
  karmaMin: z.number().int().nonnegative(),
  karmaMax: z.number().int().nonnegative(),
  items: z.array(z.object({ type: z.string().min(1), weight: z.number().positive() })).min(1),
});

/** Sticker book. Extra keys are allowed (the UI grows), but ids, names and the pixel grid are shaped. */
export const memorabiliaSchema = z.object({
  _about: z.string().optional(),
  palette_note: z.string().optional(),
  items: z
    .array(
      z
        .object({
          id: z.string().regex(/^[a-z0-9-]+$/),
          name: z.string().min(1).max(80),
          kind: z.string().min(1).max(40),
          rarity: z.string().regex(/^[A-Z_]+$/),
          drop: z.string().max(200).default(''),
          flavour: z.string().max(400).optional(),
          palette: z.array(hex).max(16).optional(),
          pixel: z.array(z.string().regex(/^[a-p-]{16}$/)).length(16).optional(),
        })
        .passthrough()
    )
    .min(1),
});

/** Monument dossiers keyed by monument id; `_`-prefixed keys are documentation. */
export const monumentsInfoSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z
      .object({
        title: z.string().min(1).max(120),
        year: z.number().int().optional(),
        architect: z.string().max(160).optional(),
        style: z.string().max(160).optional(),
        approximate: z.boolean().optional(),
        facts: z.array(z.string().max(400)).max(12).default([]),
      })
      .passthrough(),
  ])
);

export type EventConfig = z.infer<typeof eventSchema>;
export type Venue = z.infer<typeof venueSchema>;
export type Monument = z.infer<typeof monumentSchema>;
export type FactionDef = z.infer<typeof factionSchema>;
export type Territory = z.infer<typeof territorySchema>;
export type Beacon = z.infer<typeof beaconSchema>;
export type Loot = z.infer<typeof lootSchema>;

export interface ContentPack {
  dir: string;
  event: EventConfig;
  venues: Record<string, Venue>;
  monuments: Monument[];
  factions: FactionDef[];
  factionIds: Set<string>;
  territories: Territory[];
  beacons: Beacon[];
  loot: Loot;
  /** Monument ids baked into campus.json, when the file exists (null when it has not been built yet). */
  campusMonumentIds: string[] | null;
  /** Files present in the pack directory that the client may fetch under /dashboard/content/. */
  files: string[];
}

export interface PackIssue {
  file: string;
  path: string;
  message: string;
}

/** Cross-reference checks that Zod cannot express file-by-file. */
export function crossValidate(pack: Omit<ContentPack, 'factionIds' | 'files'>): PackIssue[] {
  const issues: PackIssue[] = [];
  const venueKeys = new Set(Object.keys(pack.venues));
  const factionIds = new Set(pack.factions.map((f) => f.id));
  const monumentIds = new Set(pack.monuments.map((m) => m.id));

  if (!venueKeys.has(pack.event.hqVenue)) issues.push({ file: 'event.json', path: 'hqVenue', message: `unknown venue ${pack.event.hqVenue}` });

  // Every source this codebase mints against must carry a daily ceiling.
  //
  // `KarmaService.capFor` returns null for an unpriced source and null means *uncapped*, so
  // a missing key is not a missing tuning value — it is an economy with no limit, and it
  // looks identical to a correctly configured one from the outside. Three of the seven were
  // missing from the shipped pack and all seven were missing from `example-campus`, which
  // is a fork's starting point. Refusing to load is the same bargain the rest of this file
  // makes: a typo in a ceiling should stop the server at boot, not surface as a leaderboard
  // nobody can explain at three in the morning.
  for (const source of KARMA_SOURCES) {
    if (!Object.prototype.hasOwnProperty.call(pack.event.karmaCaps, source)) {
      issues.push({
        file: 'event.json',
        path: `karmaCaps.${source}`,
        message: `no daily cap for karma source ${source} (an unpriced source is minted without limit)`,
      });
    }
  }
  if (!factionIds.has('NEUTRAL')) issues.push({ file: 'factions.json', path: 'factions', message: 'a NEUTRAL faction is required' });
  pack.factions.forEach((f, i) => {
    if (f.hqVenue && !venueKeys.has(f.hqVenue)) issues.push({ file: 'factions.json', path: `factions[${i}].hqVenue`, message: `unknown venue ${f.hqVenue}` });
  });
  pack.monuments.forEach((m, i) => {
    if (!venueKeys.has(m.venueKey)) issues.push({ file: 'monuments.json', path: `monuments[${i}].venueKey`, message: `unknown venue ${m.venueKey}` });
  });
  pack.territories.forEach((t, i) => {
    if (!venueKeys.has(t.venue)) issues.push({ file: 'territories.json', path: `territories[${i}].venue`, message: `unknown venue ${t.venue}` });
    if (!monumentIds.has(t.monument)) issues.push({ file: 'territories.json', path: `territories[${i}].monument`, message: `unknown monument ${t.monument}` });
    if (!factionIds.has(t.faction)) issues.push({ file: 'territories.json', path: `territories[${i}].faction`, message: `unknown faction ${t.faction}` });
    if (t.cp > t.max) issues.push({ file: 'territories.json', path: `territories[${i}].cp`, message: 'cp exceeds max' });
  });
  pack.beacons.forEach((b, i) => {
    if (!venueKeys.has(b.venue)) issues.push({ file: 'beacons.json', path: `beacons[${i}].venue`, message: `unknown venue ${b.venue}` });
  });
  const seenBeacon = new Set<string>();
  for (const b of pack.beacons) {
    if (seenBeacon.has(b.id)) issues.push({ file: 'beacons.json', path: b.id, message: 'duplicate beacon id' });
    seenBeacon.add(b.id);
  }
  if (pack.loot.karmaMin > pack.loot.karmaMax) issues.push({ file: 'loot.json', path: 'karmaMin', message: 'karmaMin exceeds karmaMax' });
  if (pack.campusMonumentIds) {
    const baked = new Set(pack.campusMonumentIds);
    for (const id of monumentIds) if (!baked.has(id)) issues.push({ file: 'campus.json', path: id, message: 'monument missing from the baked model — rebuild with npm run campus' });
    for (const id of baked) if (!monumentIds.has(id)) issues.push({ file: 'campus.json', path: id, message: 'baked monument not declared in monuments.json' });
  }
  return issues;
}
