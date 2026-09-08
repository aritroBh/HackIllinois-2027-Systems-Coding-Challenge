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
import type { Challenge } from './challenges.schema';
import fs from 'fs';
import path from 'path';
import { KARMA_SOURCES } from '../common/karmaSources';
import { POWER_UP_CATALOG } from '../models/powerup.model';
import { REPO_ROOT } from '../common/utils/repoRoot';

/**
 * The running server's version, read from `package.json` once at import.
 *
 * Read rather than hard-coded so it cannot drift from the number a release actually ships as —
 * a version gate whose idea of "this server" is a stale literal is worse than no gate. Falls
 * back to `0.0.0` if the file cannot be read, which fails *closed*: every pack then looks newer
 * and is refused, loudly, rather than every pack silently passing.
 */
export const SERVER_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// A tuple rather than `{ lat, lng }` because that is how these appear in the JSON and in the
// baked model, and because a tuple cannot be silently transposed by a key typo the way an
// object can — `[lng, lat]` is a mistake a reviewer sees, `{ latitude: <a longitude> }` is not.
const latLng = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
// Order is south, west, north, east — GeoJSON's is west, south, east, north, so do not assume.
// Deliberately unbounded: `inBbox` treats it as an inclusive rectangle and a pack with an
// inverted or absurd box fails the campus bake long before it fails a comparison here.
const bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]); // south, west, north, east
// Six-digit hex only. Shorthand and `rgba()` are refused because these strings are written
// straight into CSS custom properties and into the renderer's material colours, and the two
// do not accept the same set.
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * `event.json` — the one required file, and the pack's own header.
 *
 * `packVersion: z.literal(1)` is the compatibility gate and it works: a pack declaring
 * anything else fails to parse and the server refuses to boot, rather than reading a future
 * format with today's field names.
 *
 * `minServerVersion` **is** a gate. `crossValidate` compares it against the server's own version
 * from `package.json` and refuses a pack that demands a newer server than the one about to run
 * it. It was not a gate for a long time — required, shaped as a string, and compared to nothing,
 * so a pack could demand a server it would then happily run against an older one, which is the
 * one kind of mismatch on this page that failed silently instead of at boot.
 *
 * Most of the nested defaults exist so `example-campus` — a fork's starting point — is short.
 * The two blocks where a default is a *decision* rather than a convenience are `presence`
 * (accuracy, speed and fuzz limits, which are privacy and anti-spoof settings) and
 * `karmaCaps` / `bountyCap` / `hackerBountyBudgetPerDay`, which are the economy's ceilings.
 * Note that `karmaCaps` defaults to `{}` and an empty map means *uncapped* — which is why
 * `crossValidate` below refuses a pack that leaves any source unpriced rather than letting the
 * default stand.
 */
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
  /**
   * The gauntlet: whether taking a rival gym requires winning its coding challenge.
   *
   * Defaulted rather than required, and off by default, for two reasons. A pack that ships no
   * `challenges.json` — `content/example-campus` does not — would otherwise make every rival
   * gym permanently uncapturable, which is a dead mechanic that boots green. And a fork
   * pulling this commit keeps the behaviour it already had until it opts in.
   *
   * `GauntletService.requiredForCapture()` additionally refuses to honour a `true` here when
   * the pack ships no challenges, so the flag cannot lock a board it has nothing to unlock.
   */
  gauntlet: z
    .object({ requiredForCapture: z.boolean().default(false) })
    .default({}),
  karmaCaps: z.record(z.number().int().nonnegative()).default({}),
  bountyCap: z.record(z.number().int().positive()).default({}),
  hackerBountyBudgetPerDay: z.number().int().nonnegative().default(600),
  plugins: z.array(z.string()).default([]),
});

/**
 * One entry in the gazetteer. `hints` is the free-text matcher's vocabulary — the phrases an
 * organiser might type into a shift's `location` that should resolve here — and
 * `radiusMeters` overrides the campus-wide geofence for a venue that needs a different one.
 */
export const venueSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  hints: z.array(z.string().min(1)).default([]),
  radiusMeters: z.number().positive().optional(),
});
/**
 * The gazetteer as a whole, keyed by venue key.
 *
 * A record rather than an array because every cross-reference in the pack names a venue by
 * key, and a record makes "does this key exist" a lookup instead of a scan — `crossValidate`
 * checks it for monuments, territories, beacons, booths and raids.
 *
 * The `_`-prefix convention is why this needs a `superRefine` and a `transform` rather than a
 * plain record: a pack is hand-edited JSON with no room for comments, so `_about` carries the
 * documentation, and it must be a string, must be tolerated, and must not survive into the
 * loaded pack as a venue with no coordinates. Real keys are checked as SCREAMING_SNAKE_CASE
 * here, which is what stops a lowercase key silently failing every cross-reference later.
 */
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

/**
 * A landmark with hand-authored 3D detail, as opposed to the nine thousand buildings the
 * pipeline extrudes generically.
 *
 * The `.refine()` is the load-bearing part: a monument needs `match` (an OSM name the bake
 * resolves) or `at` (a centroid given outright), because without one the pipeline has nothing
 * to attach the silhouette to and the landmark would simply not appear — a failure that shows
 * up as a missing building on a map rather than as an error.
 *
 * `height` overrides whatever the bake inferred, and exists for the cases where OSM is
 * confidently wrong: a dome tagged as one storey. `crown` is the hand-written silhouette on
 * top.
 */
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

/**
 * A faction as the client renders it. The `color` lives here and **only** here — the server
 * enum in `gym.model.ts` carries ids and no hex, because a colour duplicated in a source
 * comment is a second source of truth that nothing checks, and this repository has already
 * shipped a stale copy of exactly this palette.
 */
export const factionSchema = z.object({
  id: z.string().regex(/^[A-Z0-9_]+$/),
  label: z.string().min(1),
  short: z.string().min(1),
  color: hex,
  hqVenue: z.string().optional(),
  theme: z.string().optional(),
});
/**
 * `min(2)` plus the NEUTRAL requirement in `crossValidate` means a pack ships at least one
 * contestable faction and the unclaimed state. A one-faction pack would be a territory game
 * that cannot be played.
 */
export const factionsSchema = z.object({ _about: z.string().optional(), factions: z.array(factionSchema).min(2) });

/**
 * The intended starting state of one gym — which faction holds it, at how many control points,
 * against which monument.
 *
 * `src/seed/seedData.ts` reads `pack.territories` and creates one gym per entry, taking each
 * one's coordinates from `pack.venues[venue]`. `crossValidate` is what makes that safe to do
 * without further checks: it has already confirmed that every territory names a real venue, a
 * real monument and a real faction, and that `cp <= max`.
 *
 * This comment used to say the answer was nothing, and it was right at the time — the seed built
 * fourteen gyms from a hard-coded array, so a fork could edit this file, watch it validate, and
 * get the shipped territories anyway. The fix landed and the sentence outlived it, which is the
 * defect this repository produces most; it was found by an external reviewer reading the fix and
 * the prose beside it in the same pass.
 */
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

/**
 * A HackStop's placement. Cross-referenced against the pack's venues and checked for a duplicate
 * id, and — like territories above — exactly what the seeder creates beacons from.
 */
export const beaconSchema = z.object({
  id: z.string().regex(/^[A-Z0-9_]+$/),
  name: z.string().min(1),
  where: z.string().min(1),
  venue: z.string().min(1),
  radiusMeters: z.number().positive().optional(),
});
export const beaconsSchema = z.object({ _about: z.string().optional(), beacons: z.array(beaconSchema) });

/**
 * The drop table the server actually rolls against.
 *
 * `src/economy/lootTable.ts` builds it from `pack.loot` at import and `HackStopService` calls
 * into that, so the weights here decide the odds and `karmaMin`/`karmaMax` decide the payout
 * band. Weights are relative and are normalised against their own total, so they need not sum
 * to any particular number.
 *
 * `crossValidate` checks `karmaMin <= karmaMax`; `lootTable.ts` additionally refuses to boot on
 * an item `type` that `POWER_UP_CATALOG` does not price, which used to be a crash inside one
 * unlucky player's spin instead.
 *
 * This said "declared, validated, and read by nothing" until the day it stopped being true.
 */
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

/**
 * The pack as the rest of the server sees it: parsed, cross-checked, and flattened so a caller
 * reads `pack.monuments` rather than `pack.monuments.monuments`.
 *
 * `factionIds` is a `Set` of the same ids `factions` already carries, built once at load for
 * membership tests, and nothing in `src/` reads it today — only `tests/content.test.ts`. It is a
 * convenience waiting for a caller rather than a live index.
 *
 * The reason it has no caller is *not* the one this comment used to give. It said the gym battle
 * path validated against the `Faction` enum in `gym.model.ts` via `pokestop.schema.ts`, which
 * stopped being true when that schema moved to a shape-only check and `faction.service.ts` took
 * over the real validation — reading `pack.factions` directly and building its own list. So the
 * pack *is* the authority now; `factionIds` is simply not the object it reads.
 * `campusMonumentIds` is null rather than empty when `campus.json` has not been built
 * — the two mean different things, and treating "not baked yet" as "baked with no monuments"
 * would make every monument look missing.
 */
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
  /**
   * Coding challenges, when the pack ships `challenges.json`. Null means this event has none,
   * which is different from having an empty list: null is "no such file", and the gauntlet
   * requirement refuses to engage without challenges to serve.
   */
  challenges: Challenge[] | null;
  /** The salt this pack's answer digests were generated with. Null when it ships no challenges. */
  challengesSalt: string | null;
  /** Monument ids baked into campus.json, when the file exists (null when it has not been built yet). */
  campusMonumentIds: string[] | null;
  /** Files present in the pack directory that the client may fetch under /dashboard/content/. */
  files: string[];
}

/** One complaint, addressed well enough to fix: which file, which path inside it, what is wrong. */
export interface PackIssue {
  file: string;
  path: string;
  message: string;
}

/** Cross-reference checks that Zod cannot express file-by-file. */
export function crossValidate(pack: Omit<ContentPack, 'factionIds' | 'files'>): PackIssue[] {
  const issues: PackIssue[] = [];

  /*
   * The version gate.
   *
   * Compared numerically, field by field, rather than with `localeCompare` — "1.10.0" sorts
   * before "1.9.0" as a string, which would let a pack needing 1.10 boot on 1.9 while refusing
   * the reverse. Missing fields read as 0, so "2" and "2.0.0" are the same demand.
   *
   * Only a pack demanding something *newer* is refused. A pack that asks for an older server
   * than the one running it is fine and says nothing: that is the ordinary case of a pack
   * outliving a release.
   */
  const asParts = (version: string): number[] => version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const demanded = asParts(pack.event.minServerVersion);
  const running = asParts(SERVER_VERSION);
  for (let i = 0; i < Math.max(demanded.length, running.length); i += 1) {
    const want = demanded[i] ?? 0;
    const have = running[i] ?? 0;
    if (want === have) continue;
    if (want > have) {
      issues.push({
        file: 'event.json',
        path: 'minServerVersion',
        message: `pack needs server ${pack.event.minServerVersion}; this server is ${SERVER_VERSION}`,
      });
    }
    break;
  }

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
  /*
   * Every loot item must be something the catalogue prices.
   *
   * The pack chooses the odds and `POWER_UP_CATALOG` chooses the payouts, so the `type` string is
   * the join between them; a typo there used to be a clean `content:validate`, a clean boot, and
   * then a crash inside one unlucky player's spin when `POWER_UP_CATALOG[awarded]` came back
   * undefined.
   *
   * `lootTable.ts` also throws on this at import, and that guard stays — but it fires at *server
   * boot*, and `npm run content:validate` never imports that module. So the one command a fork
   * runs before deploying passed a pack the server would later refuse. Checking it here is what
   * makes the failure arrive when somebody is still editing the file.
   *
   * Two comments elsewhere already claimed `crossValidate` did this. They were wrong when
   * written; this is the line that makes them true.
   */
  for (const [i, item] of pack.loot.items.entries()) {
    if (!Object.prototype.hasOwnProperty.call(POWER_UP_CATALOG, item.type)) {
      issues.push({
        file: 'loot.json',
        path: `items[${i}].type`,
        message: `unknown power-up "${item.type}"; known types are ${Object.keys(POWER_UP_CATALOG).join(', ')}`,
      });
    }
  }
  if (pack.campusMonumentIds) {
    const baked = new Set(pack.campusMonumentIds);
    for (const id of monumentIds) if (!baked.has(id)) issues.push({ file: 'campus.json', path: id, message: 'monument missing from the baked model — rebuild with npm run campus' });
    for (const id of baked) if (!monumentIds.has(id)) issues.push({ file: 'campus.json', path: id, message: 'baked monument not declared in monuments.json' });
  }
  return issues;
}
