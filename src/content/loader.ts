/**
 * Content pack loader — read once at import, fail fast, export a typed `pack`.
 *
 * The pack directory is `${CONTENT_DIR}/${CONTENT_PACK}` (defaults: `<repo>/content`,
 * `hackillinois-2027`). Like `config/env.ts`, a broken pack stops the process at boot
 * with every issue listed, rather than surfacing at 3 a.m. as a geofence on the wrong
 * building.
 *
 * `toLocal`/`fromLocal` implement the same equirectangular frame as
 * `design/pipeline/config.py` (`Frame.to_world`) and `public/app.js` (`toWorld`): +x east, +z south,
 * in world units of `metersPerUnit`. All three must agree or a presence dot lands on the
 * wrong lawn; the content test asserts the pack's Alma Mater against the baked model.
 */
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../common/utils/repoRoot';
import { geofenceMetersFor } from '../common/utils/geofence';
import { ZodError, ZodTypeAny } from 'zod';
import { env } from '../config/env';
import {
  ContentPack,
  PackIssue,
  beaconsSchema,
  crossValidate,
  eventSchema,
  factionsSchema,
  lootSchema,
  memorabiliaSchema,
  monumentsInfoSchema,
  monumentsSchema,
  territoriesSchema,
  venuesSchema,
} from './schema';
import { boothsSchema } from './booths.schema';
import { raidsSchema } from './raids.schema';
import { questsSchema } from './quests.schema';
import { DOMAIN_EVENT_NAMES } from '../common/events/domainEvents';

/**
 * Carries **every** issue, not the first one. A pack is edited by hand and a fork's first
 * validation run typically fails a dozen ways at once; reporting one issue per run turns
 * bringing up a new campus into a dozen boot cycles. The message is pre-rendered in the
 * constructor so a plain `console.error(err.message)` prints the whole list, and `issues`
 * stays structured for `content:validate` and the tests.
 */
export class ContentPackError extends Error {
  constructor(public readonly issues: PackIssue[]) {
    super(`Content pack invalid:\n${issues.map((i) => `  - ${i.file} ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'ContentPackError';
  }
}

/**
 * Read one file, parse it, and *collect* whatever went wrong instead of throwing.
 *
 * Returning `null` on failure is what lets `loadPack` keep going and report the whole pack at
 * once — a throw here would stop at the first broken file. The three failure kinds are kept
 * distinct in the issue list (missing, unparseable, schema-invalid) because they need three
 * different fixes, and "invalid JSON: Unexpected token } at position 412" is the only one of
 * the three that names a character.
 *
 * Zod issues are flattened with their path joined by dots, so a nested failure reads
 * `monuments.3.venueKey` rather than an array a human has to reassemble.
 */
function readJson<T extends ZodTypeAny>(dir: string, file: string, schema: T, issues: PackIssue[]): ReturnType<T['parse']> | null {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) {
    issues.push({ file, path: '', message: 'file missing' });
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    issues.push({ file, path: '', message: `invalid JSON: ${(err as Error).message}` });
    return null;
  }
  try {
    return schema.parse(raw) as ReturnType<T['parse']>;
  } catch (err) {
    if (err instanceof ZodError) {
      for (const e of err.errors) issues.push({ file, path: e.path.join('.'), message: e.message });
    } else {
      issues.push({ file, path: '', message: String(err) });
    }
    return null;
  }
}

/** Loads and validates a pack directory. Throws `ContentPackError` listing every issue. */
export function loadPack(dir: string): ContentPack {
  const issues: PackIssue[] = [];
  const event = readJson(dir, 'event.json', eventSchema, issues);
  const venues = readJson(dir, 'venues.json', venuesSchema, issues);
  const monuments = readJson(dir, 'monuments.json', monumentsSchema, issues);
  const factions = readJson(dir, 'factions.json', factionsSchema, issues);
  const territories = readJson(dir, 'territories.json', territoriesSchema, issues);
  const beacons = readJson(dir, 'beacons.json', beaconsSchema, issues);
  const loot = readJson(dir, 'loot.json', lootSchema, issues);
  // Optional files the client renders from: validated when present so pack-driven DOM input
  // is shaped before it is served.
  if (fs.existsSync(path.join(dir, 'memorabilia.json'))) readJson(dir, 'memorabilia.json', memorabiliaSchema, issues);
  // The game files are optional — a pack with no booths simply has no booths — but a pack that
  // HAS them and has them wrong must fail here rather than at the first scan of the event. A
  // sponsor whose QR code 500s at nine in the morning is not a bug anyone gets to fix calmly.
  const booths = fs.existsSync(path.join(dir, 'booths.json')) ? readJson(dir, 'booths.json', boothsSchema, issues) : null;
  const raids = fs.existsSync(path.join(dir, 'raids.json')) ? readJson(dir, 'raids.json', raidsSchema, issues) : null;
  // `quests.json` was the one game file nobody read at boot, although its own schema says the
  // shapes that cannot advance "are rejected at load instead". They were not: a DISTINCT
  // quest with no `distinctBy`, a STREAK over the whole event, or a duplicate id all booted
  // cleanly and then sat at zero for the weekend — the invisible-dead-quest failure the
  // schema exists to prevent, with the schema present and unused.
  const quests = fs.existsSync(path.join(dir, 'quests.json')) ? readJson(dir, 'quests.json', questsSchema, issues) : null;
  const info = fs.existsSync(path.join(dir, 'monuments-info.json')) ? readJson(dir, 'monuments-info.json', monumentsInfoSchema, issues) : null;
  if (!event || !venues || !monuments || !factions || !territories || !beacons || !loot) throw new ContentPackError(issues);
  // Venue keys in the game files, checked here rather than in `crossValidate` because these
  // files are optional and the pack object it receives does not carry them.
  //
  // Both schemas say in as many words that `venue` is "a venue key from venues.json", and
  // neither checked. A booth or a raid pointing at a venue that does not exist boots without
  // complaint and shows up as a map pin that is not there — at the moment a sponsor asks why
  // nobody can find their table.
  if (venues) {
    const venueKeys = new Set(Object.keys(venues));
    booths?.booths.forEach((booth, i) => {
      if (!venueKeys.has(booth.venue)) {
        issues.push({ file: 'booths.json', path: `booths[${i}].venue`, message: `unknown venue ${booth.venue}` });
      }
    });
    raids?.raids.forEach((raid, i) => {
      if (!venueKeys.has(raid.venue)) {
        issues.push({ file: 'raids.json', path: `raids[${i}].venue`, message: `unknown venue ${raid.venue}` });
      }
    });
  }

  /*
   * A quest or a raid may only name a domain event that exists.
   *
   * Checked here for the same reason as the venue keys above: these files are optional and
   * `crossValidate` never sees them.
   *
   * Both schemas claimed this was already covered. `quests.schema.ts` said a quest naming an
   * event nothing emits was "a dead quest, which the wiring reports, not a broken pack", and
   * `docs/CONTENT-PACKS.md` said `npm run events:check` reported it. Neither was true:
   * `QuestService.advance` returns an empty array for an unlistened event with no log,
   * `RaidService` maps over a closed list and records nothing, and `checkEvents.mjs` checks the
   * *SSE* bridge — its name pattern cannot match a dotted event like `registration.created`, so
   * it never looked at either file. A typo produced a green boot and a quest sitting at zero for
   * the weekend, with no signal anywhere.
   *
   * This checks that the name exists, not that anything subscribes to it. A raid may name a real
   * event `RaidService` does not enrol on — `sos.resolved` is one — and that is reported at boot
   * by the service, which is where the list of what it listens for lives.
   */
  const knownEvents = new Set<string>(DOMAIN_EVENT_NAMES);
  quests?.quests.forEach((quest, i) => {
    if (quest.event && !knownEvents.has(quest.event)) {
      issues.push({
        file: 'quests.json',
        path: `quests[${i}].event`,
        message: `unknown domain event "${quest.event}"; known events are ${DOMAIN_EVENT_NAMES.join(', ')}`,
      });
    }
  });
  raids?.raids.forEach((raid, i) => {
    (raid.joinEvents ?? []).forEach((name, j) => {
      if (!knownEvents.has(name)) {
        issues.push({
          file: 'raids.json',
          path: `raids[${i}].joinEvents[${j}]`,
          message: `unknown domain event "${name}"; known events are ${DOMAIN_EVENT_NAMES.join(', ')}`,
        });
      }
    });
  });

  if (info) {
    const ids = new Set(monuments.monuments.map((m) => m.id));
    for (const key of Object.keys(info)) if (!key.startsWith('_') && !ids.has(key)) issues.push({ file: 'monuments-info.json', path: key, message: 'dossier for an undeclared monument' });
  }

  let campusMonumentIds: string[] | null = null;
  const campusFile = path.join(dir, 'campus.json');
  if (fs.existsSync(campusFile)) {
    try {
      const model = JSON.parse(fs.readFileSync(campusFile, 'utf8')) as { monuments?: Array<{ id: string }> };
      campusMonumentIds = (model.monuments ?? []).map((m) => m.id);
    } catch (err) {
      issues.push({ file: 'campus.json', path: '', message: `invalid JSON: ${(err as Error).message}` });
    }
  }

  const partial = {
    dir,
    event,
    venues,
    monuments: monuments.monuments,
    factions: factions.factions,
    territories: territories.territories,
    beacons: beacons.beacons,
    loot,
    campusMonumentIds,
  };
  issues.push(...crossValidate(partial));
  if (issues.length) throw new ContentPackError(issues);

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return { ...partial, factionIds: new Set(partial.factions.map((f) => f.id)), files };
}

/** The directory packs live in, absolute. Also the containment boundary the check below tests against. */
export const CONTENT_DIR = path.resolve(env.CONTENT_DIR ?? path.join(REPO_ROOT, 'content'));

/** Which pack this process is running. A bare directory name — the env schema's regex enforces that. */
export const CONTENT_PACK = env.CONTENT_PACK;

/**
 * Resolve, contain, load, and refuse to boot on anything else.
 *
 * The `NODE_ENV === 'test'` branch rethrows instead of exiting, which is not a loophole in the
 * fail-fast rule: a suite that asserts a bad pack is rejected cannot do so if the assertion
 * kills the runner. Every other environment exits, because a server running on a pack that did
 * not validate is a server with a geofence pointing at the wrong building.
 */
function loadActivePack(): ContentPack {
  const dir = path.resolve(CONTENT_DIR, CONTENT_PACK);
  // Belt and braces on top of the env regex: the pack directory must sit inside CONTENT_DIR,
  // because `pack.dir` is served statically at /dashboard/content.
  if (!dir.startsWith(CONTENT_DIR + path.sep)) {
    console.error(`❌ Refusing to boot: CONTENT_PACK "${CONTENT_PACK}" resolves outside ${CONTENT_DIR}.`);
    process.exit(1);
  }
  try {
    return loadPack(dir);
  } catch (err) {
    console.error(`❌ Refusing to boot: content pack "${CONTENT_PACK}" at ${dir} is invalid.`);
    console.error(err instanceof Error ? err.message : err);
    if (env.NODE_ENV === 'test') throw err;
    process.exit(1);
  }
}

/**
 * The active pack, loaded at import.
 *
 * Everything downstream imports this as a plain object and reads it synchronously, which is
 * only safe because it cannot be half-loaded: the module either has a validated pack by the
 * time anything else imports it, or the process is already gone.
 */
export const pack: ContentPack = loadActivePack();

// --- local frame -----------------------------------------------------------------------
//
// An equirectangular projection about the campus origin, with the longitude scale frozen at
// the origin's latitude rather than recomputed per point. That is an approximation, and the
// property that matters is not its accuracy against the geoid but that all three
// implementations make the *same* approximation: this file, `design/pipeline/config.py`'s
// `Frame.to_world`, and `public/app.js`'s `toWorld`. The baked buildings, the presence dots and the
// server's own distance maths are computed independently, and they only line up because the
// three agree constant for constant. Change one and a player stands inside a wall.
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((pack.event.campus.origin[0] * Math.PI) / 180);

/**
 * Latitude and longitude to world units: +x east, +z **south**.
 *
 * The sign on `z` is the one thing to get right. It is negated because the renderer's ground
 * plane has +z running south while latitude runs north, so a missing minus does not produce a
 * small error — it mirrors the whole campus about its origin, which looks like a working map
 * of a place that does not exist.
 */
export function toLocal(latitude: number, longitude: number): { x: number; z: number } {
  const [lat0, lng0] = pack.event.campus.origin;
  const mpu = pack.event.campus.metersPerUnit;
  return { x: ((longitude - lng0) * M_PER_DEG_LNG) / mpu, z: (-(latitude - lat0) * M_PER_DEG_LAT) / mpu };
}

/**
 * The inverse, used where a world-space answer has to be handed back as coordinates — the
 * presence list turns stored world positions back into lat/lng for HTTP clients. Exactly
 * inverse to `toLocal` by construction, including the sign, so a round trip is lossless apart
 * from floating point.
 */
export function fromLocal(x: number, z: number): { latitude: number; longitude: number } {
  const [lat0, lng0] = pack.event.campus.origin;
  const mpu = pack.event.campus.metersPerUnit;
  return { latitude: lat0 - (z * mpu) / M_PER_DEG_LAT, longitude: lng0 + (x * mpu) / M_PER_DEG_LNG };
}

/**
 * Is this point on the campus at all?
 *
 * The presence store's first gate on the coordinates themselves — only the opt-in check runs
 * ahead of it — and it does more than reject nonsense. The spatial index
 * keys cells by rounded world coordinates and never deletes an emptied cell, so the size of
 * that map is the size of the coordinate space anything is allowed to occupy. This box is what
 * keeps that a few thousand cells rather than the whole globe — a single sample from the
 * middle of the Pacific would otherwise mint a cell that lives for the rest of the process.
 *
 * Inclusive on all four edges. A volunteer standing exactly on the boundary is on campus.
 */
export function inBbox(latitude: number, longitude: number): boolean {
  const [s, w, n, e] = pack.event.campus.bbox;
  return latitude >= s && latitude <= n && longitude >= w && longitude <= e;
}

/** What the client needs to boot: branding, venues, factions, monuments and file URLs. */
export function publicContent(): Record<string, unknown> {
  return {
    pack: pack.event.id,
    packVersion: pack.event.packVersion,
    event: pack.event,
    /*
     * Venues, each carrying the geofence radius **already resolved**.
     *
     * `radiusMeters` is kept as the pack declared it — present when a venue overrides, absent
     * when it does not — and `geofenceMeters` is added beside it as the number that actually
     * applies: the venue's, else `event.campus.geofenceMeters`, else 75.
     *
     * The added field exists so the precedence rule has one implementation. The client gates its
     * Spin buttons and writes its "walk closer" copy from this radius, and it could compute the
     * same answer from the two raw fields — which would make the ordering a rule living in two
     * languages, drifting the first time somebody changed it on one side. This repository spent a
     * day removing two instances of exactly that (a gazetteer duplicated between `src/` and the
     * pack, a loot table duplicated between a service and `loot.json`), and both had agreed by
     * coincidence until somebody looked.
     *
     * So: the server resolves, the client reads. `geofenceMetersFor` is the one place the
     * ordering is written down.
     */
    venues: Object.fromEntries(
      Object.entries(pack.venues).map(([key, venue]) => [key, { ...venue, geofenceMeters: geofenceMetersFor(key) }])
    ),
    factions: pack.factions,
    monuments: pack.monuments,
    contentBase: '/dashboard/content',
    files: {
      ...Object.fromEntries(pack.files.map((f) => [f.replace(/\.json$/, ''), `/dashboard/content/${f}`])),
      // The tiled whole-campus bake (schema 2), when the pipeline has produced it.
      ...(fs.existsSync(path.join(pack.dir, 'campus', 'index.json')) ? { campusIndex: '/dashboard/content/campus/index.json' } : {}),
    },
  };
}
