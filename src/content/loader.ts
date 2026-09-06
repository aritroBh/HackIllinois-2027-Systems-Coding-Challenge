/**
 * Content pack loader — read once at import, fail fast, export a typed `pack`.
 *
 * The pack directory is `${CONTENT_DIR}/${CONTENT_PACK}` (defaults: `<repo>/content`,
 * `hackillinois-2027`). Like `config/env.ts`, a broken pack stops the process at boot
 * with every issue listed, rather than surfacing at 3 a.m. as a geofence on the wrong
 * building.
 *
 * `toLocal`/`fromLocal` implement the same equirectangular frame as
 * `design/build-campus.py` (`to_world`) and `public/app.js` (`toWorld`): +x east, +z south,
 * in world units of `metersPerUnit`. All three must agree or a presence dot lands on the
 * wrong lawn; the content test asserts the pack's Alma Mater against the baked model.
 */
import fs from 'fs';
import path from 'path';
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
  monumentsSchema,
  territoriesSchema,
  venuesSchema,
} from './schema';

export class ContentPackError extends Error {
  constructor(public readonly issues: PackIssue[]) {
    super(`Content pack invalid:\n${issues.map((i) => `  - ${i.file} ${i.path}: ${i.message}`).join('\n')}`);
    this.name = 'ContentPackError';
  }
}

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
  if (!event || !venues || !monuments || !factions || !territories || !beacons || !loot) throw new ContentPackError(issues);

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

export const CONTENT_DIR = process.env.CONTENT_DIR ?? path.resolve(__dirname, '../../content');
export const CONTENT_PACK = process.env.CONTENT_PACK ?? 'hackillinois-2027';

function loadActivePack(): ContentPack {
  const dir = path.join(CONTENT_DIR, CONTENT_PACK);
  try {
    return loadPack(dir);
  } catch (err) {
    console.error(`❌ Refusing to boot: content pack "${CONTENT_PACK}" at ${dir} is invalid.`);
    console.error(err instanceof Error ? err.message : err);
    if (env.NODE_ENV === 'test') throw err;
    process.exit(1);
  }
}

export const pack: ContentPack = loadActivePack();

// --- local frame -----------------------------------------------------------------------
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((pack.event.campus.origin[0] * Math.PI) / 180);

export function toLocal(latitude: number, longitude: number): { x: number; z: number } {
  const [lat0, lng0] = pack.event.campus.origin;
  const mpu = pack.event.campus.metersPerUnit;
  return { x: ((longitude - lng0) * M_PER_DEG_LNG) / mpu, z: (-(latitude - lat0) * M_PER_DEG_LAT) / mpu };
}

export function fromLocal(x: number, z: number): { latitude: number; longitude: number } {
  const [lat0, lng0] = pack.event.campus.origin;
  const mpu = pack.event.campus.metersPerUnit;
  return { latitude: lat0 - (z * mpu) / M_PER_DEG_LAT, longitude: lng0 + (x * mpu) / M_PER_DEG_LNG };
}

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
    venues: pack.venues,
    factions: pack.factions,
    monuments: pack.monuments,
    contentBase: '/dashboard/content',
    files: Object.fromEntries(pack.files.map((f) => [f.replace(/\.json$/, ''), `/dashboard/content/${f}`])),
  };
}
