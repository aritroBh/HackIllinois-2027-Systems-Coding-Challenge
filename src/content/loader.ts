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
 *
 * `loadPack` has two callers and they want different things from a failure. `loadActivePack()`
 * below runs at import for the process's own pack and ends the process. `src/content/validate.ts`
 * (`npm run content:validate`) runs it over every directory under `content/` without booting a
 * server, which is why the issue list is a returned structure rather than only a printed message.
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
import { challengesSchema } from './challenges.schema';
import { DOMAIN_EVENT_NAMES } from '../common/events/domainEvents';

/**
 * Carries **every** issue, not the first one. A pack is edited by hand and a fork's first
 * validation run typically fails a dozen ways at once; reporting one issue per run turns
 * bringing up a new campus into a dozen boot cycles. The message is pre-rendered in the
 * constructor so a plain `console.error(err.message)` prints the whole list, and `issues`
 * stays structured for `content:validate` and the tests.
 */
export class ContentPackError extends Error {
  /** Keeps every issue structured (for `content:validate`) while the message stays printable. */
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

/**
 * Loads and validates a pack directory. Throws `ContentPackError` listing every issue.
 *
 * Seven files are required — `event.json`, `venues.json`, `monuments.json`, `factions.json`,
 * `territories.json`, `beacons.json`, `loot.json` — and everything else is optional: a pack
 * with no `booths.json` simply has no booths. Optional does not mean unchecked. A file that is
 * present is parsed against its schema here, because what an absent check produces is not a
 * crash but a mechanic that boots green and does nothing all weekend.
 *
 * The order below is deliberate:
 *
 *   1. read and parse every file, *collecting* issues instead of throwing (`readJson`);
 *   2. assert the required seven — the only early exit in this function, and it exists because
 *      `crossValidate` dereferences all seven. Continuing past a missing one would throw a
 *      TypeError over the issue list the caller was about to be shown;
 *   3. run the checks that need two optional files at once (venue keys and domain event names
 *      in the game files, monument dossiers against the monument ids), which `crossValidate`
 *      cannot do because it is handed a pack object that does not carry those files;
 *   4. hand the rest to `crossValidate` and throw once, with everything.
 *
 * `challenges.json` is optional in the same way, and carries the gauntlet's questions. Its
 * answers are sha256 HMAC digests rather than plaintext, and the reason is visible three
 * screens down: `publicContent()` maps *every* JSON file in this directory into a URL under
 * /dashboard/content. `src/content/challenges.schema.ts` writes out that trade and its limits.
 */
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
  // The gauntlet's questions. Absent is a legitimate pack — `content/example-campus` ships none
  // — and it is not the same as an empty list: `GauntletService.requiredForCapture()` reads the
  // difference and refuses to gate captures behind a question set that does not exist. Present
  // and wrong fails here, where an author is still editing, rather than in front of a player
  // standing at a gym with a challenge that will not open.
  const challenges = fs.existsSync(path.join(dir, 'challenges.json')) ? readJson(dir, 'challenges.json', challengesSchema, issues) : null;
  // The only early exit. Everything above collects; from here on the code dereferences these
  // seven, so a missing one has to stop the run — and it stops it carrying the whole issue list,
  // not just "event.json: file missing".
  if (!event || !venues || !monuments || !factions || !territories || !beacons || !loot) throw new ContentPackError(issues);
  // Venue keys in the game files, checked here rather than in `crossValidate` because these
  // files are optional and the pack object it receives does not carry them.
  //
  // Both schemas say in as many words that `venue` is "a venue key from venues.json", and
  // neither checked. A booth or a raid pointing at a venue that does not exist boots without
  // complaint and shows up as a map pin that is not there — at the moment a sponsor asks why
  // nobody can find their table.
  //
  // The `if (venues)` is redundant — the throw above has already established it — and is kept
  // only because it costs nothing and reads as a guard rather than as a narrowing. Do not read
  // it as a check that can fire; a pack with no venues never reaches this line.
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

  // Dossiers are checked in one direction only, on purpose. A dossier keyed to a monument that
  // does not exist is a typo — the text is written and will never appear — so it is reported. A
  // monument with no dossier is not: the panel simply has no history section, which is the
  // ordinary state of a pack whose prose is still being written. `_`-prefixed keys carry the
  // file's own documentation (a pack is hand-edited JSON with nowhere to put a comment) and are
  // skipped here rather than tested against the monument ids.
  if (info) {
    const ids = new Set(monuments.monuments.map((m) => m.id));
    for (const key of Object.keys(info)) if (!key.startsWith('_') && !ids.has(key)) issues.push({ file: 'monuments-info.json', path: key, message: 'dossier for an undeclared monument' });
  }

  /*
   * The baked model, read for one field and no more.
   *
   * `campus.json` is pipeline output, not hand-authored content: it can be megabytes of geometry
   * and its shape is owned by `design/pipeline/`, so there is no Zod schema here and there should
   * not be one — a schema for it would be a second definition of the pipeline's output format,
   * kept in step by memory. All this needs is the monument ids, which `crossValidate` compares
   * against `monuments.json` in both directions.
   *
   * Unparseable JSON is an issue; an absent file is not. `null` rather than `[]` is the load-
   * bearing part of that: a pack whose campus has not been baked yet is a normal state a fork
   * lives in for days, and `[]` would tell `crossValidate` the bake ran and produced nothing,
   * turning every monument in the pack into a reported error.
   */
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

  /*
   * The pack as the rest of the server reads it: one level flatter than the files are, so a
   * caller writes `pack.monuments` rather than `pack.monuments.monuments`, and the per-file
   * `_about` documentation keys are gone.
   *
   * `challenges` and `challengesSalt` are lifted out of the same file and are null together:
   * the salt is meaningless without the digests it keyed, and a digest cannot be checked
   * without the salt, so nothing downstream has to handle one arriving without the other.
   *
   * `crossValidate` is given this object rather than a finished `ContentPack` because it runs
   * before `factionIds` and `files` exist — hence the `Omit` in its signature.
   */
  const partial = {
    dir,
    event,
    venues,
    monuments: monuments.monuments,
    factions: factions.factions,
    territories: territories.territories,
    beacons: beacons.beacons,
    loot,
    challenges: challenges?.challenges ?? null,
    challengesSalt: challenges?.answerSalt ?? null,
    campusMonumentIds,
  };
  issues.push(...crossValidate(partial));
  if (issues.length) throw new ContentPackError(issues);

  // The pack's own JSON files, listed only after it has validated — an invalid pack never gets
  // as far as publishing a file list. This is the top level only and not recursive, which is why
  // the tiled bake under `campus/` needs the separate existence check in `publicContent()`.
  // Sorted so the descriptor the client fetches is byte-stable between boots on the same pack;
  // directory order is not.
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

/**
 * What the client needs to boot: branding, venues, factions, monuments and file URLs.
 *
 * **Everything this returns is public, and so is everything it links to.** `src/app.ts` serves
 * the whole pack directory with `express.static(pack.dir)` at /dashboard/content, and `files`
 * below turns each entry of `pack.files` into a URL under it. There is no filter and there is no
 * session check: a pack file is a download for anyone who asks.
 *
 * That is the constraint every pack file is authored under, and `challenges.json` is where it
 * bites hardest — a plaintext answer written into a challenge would be the answer key, served.
 * Hence the digests, `scripts/gauntletHashes.ts`, and the plaintext originals living in
 * `design/challenges/`, which is neither served nor copied into the image. Anything genuinely
 * secret does not belong in a pack at all.
 */
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
