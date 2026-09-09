/**
 * Content pack (plan M2): the active pack loads, cross-references are enforced, and the
 * server's local frame agrees with the pipeline's baked model.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { app } from '../src/app';
import { pack, loadPack, ContentPackError, toLocal, fromLocal, inBbox } from '../src/content/loader';
import { env } from '../src/config/env';
import { KARMA_SOURCES } from '../src/common/karmaSources';

function copyPack(mutate: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  for (const f of fs.readdirSync(pack.dir)) {
    if (f === 'campus.json') continue; // keep the fixture small; the id cross-check is tested separately
    if (fs.statSync(path.join(pack.dir, f)).isDirectory()) continue; // the tiled campus/ bake
    fs.copyFileSync(path.join(pack.dir, f), path.join(dir, f));
  }
  mutate(dir);
  return dir;
}

function rewrite(dir: string, file: string, fn: (doc: Record<string, unknown>) => void): void {
  const full = path.join(dir, file);
  const doc = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>;
  fn(doc);
  fs.writeFileSync(full, JSON.stringify(doc));
}

describe('content pack', () => {
  it('the active pack loads with the UIUC content and the baked model agrees on monument ids', () => {
    expect(pack.event.id).toBe('hackillinois-2027');
    expect(Object.keys(pack.venues)).toHaveLength(23);
    expect(pack.monuments).toHaveLength(14);
    expect(pack.territories).toHaveLength(14);
    expect(pack.beacons).toHaveLength(20);
    expect(pack.factionIds.has('NEUTRAL')).toBe(true);
    expect(pack.campusMonumentIds).toHaveLength(14);
  });

  it('a territory pointing at an unknown venue fails at the right path', () => {
    const dir = copyPack((d) =>
      rewrite(d, 'territories.json', (doc) => {
        (doc.territories as Array<{ venue: string }>)[0].venue = 'NOWHERE';
      })
    );
    let err: unknown;
    try {
      loadPack(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentPackError);
    expect((err as ContentPackError).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ file: 'territories.json', path: 'territories[0].venue' })])
    );
  });

  it('a karma source with no daily cap refuses to load, because unpriced means unlimited', () => {
    // `KarmaService.capFor` returns null for a source the pack does not mention, and null
    // routes the award to `spendUncapped`. So an omitted ceiling is not a missing tuning
    // value that falls back to something sensible — it is an economy with no limit on that
    // source, indistinguishable from a configured one until somebody reads the leaderboard.
    // `POWERUP`, `CHECKOUT` and `BOOTH` were all missing, and they are the three highest-
    // yield paths in the game.
    for (const source of KARMA_SOURCES) {
      const dir = copyPack((d) =>
        rewrite(d, 'event.json', (doc) => {
          const caps = doc.karmaCaps as Record<string, number>;
          delete caps[source];
        })
      );
      let err: unknown;
      try {
        loadPack(dir);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ContentPackError);
      expect((err as ContentPackError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ file: 'event.json', path: `karmaCaps.${source}` }),
        ])
      );
    }
  });

  it('both shipped packs price every karma source the code mints against', () => {
    for (const dir of ['content/hackillinois-2027', 'content/example-campus']) {
      const event = JSON.parse(fs.readFileSync(path.join(dir, 'event.json'), 'utf8')) as {
        karmaCaps?: Record<string, number>;
      };
      expect({ dir, missing: KARMA_SOURCES.filter((s) => !(s in (event.karmaCaps ?? {}))) }).toEqual({
        dir,
        missing: [],
      });
    }
  });

  it('a missing NEUTRAL faction is a cross-reference error; a bad venue key is a file error', () => {
    const noNeutral = copyPack((d) =>
      rewrite(d, 'factions.json', (doc) => {
        doc.factions = (doc.factions as Array<{ id: string }>).filter((f) => f.id !== 'NEUTRAL');
      })
    );
    expect(() => loadPack(noNeutral)).toThrow(/NEUTRAL faction is required/);

    const badKey = copyPack((d) =>
      rewrite(d, 'venues.json', (doc) => {
        doc['bad-key'] = doc.SIEBEL_ATRIUM;
      })
    );
    expect(() => loadPack(badKey)).toThrow(/venues.json bad-key/);
  });

  it('the local frame round-trips and matches the baked model within 5 m', () => {
    const [lat0, lng0] = pack.event.campus.origin;
    const origin = toLocal(lat0, lng0);
    expect(Math.abs(origin.x)).toBeLessThan(1e-9);
    expect(Math.abs(origin.z)).toBeLessThan(1e-9);
    const back = fromLocal(12.5, -7.25);
    const again = toLocal(back.latitude, back.longitude);
    expect(again.x).toBeCloseTo(12.5, 6);
    expect(again.z).toBeCloseTo(-7.25, 6);

    const alma = pack.monuments.find((m) => m.id === 'alma-mater')!;
    const baked = (JSON.parse(fs.readFileSync(path.join(pack.dir, 'campus.json'), 'utf8')) as { monuments: Array<{ id: string; c: [number, number] }> })
      .monuments.find((m) => m.id === 'alma-mater')!;
    const local = toLocal(alma.at![0], alma.at![1]);
    const metres = Math.hypot(local.x - baked.c[0], local.z - baked.c[1]) * pack.event.campus.metersPerUnit;
    expect(metres).toBeLessThan(5);

    expect(inBbox(40.1075, -88.2271)).toBe(true);
    expect(inBbox(41.88, -87.63)).toBe(false); // Chicago
  });

  it('GET /api/v1/content is public and points at the pack files under /dashboard/content', async () => {
    const res = await request(app).get('/api/v1/content');
    expect(res.status).toBe(200);
    expect(res.body.data.pack).toBe('hackillinois-2027');
    expect(res.body.data.files.campus).toBe('/dashboard/content/campus.json');
    expect(res.body.data.factions.some((f: { id: string }) => f.id === 'NEUTRAL')).toBe(true);
    const file = await request(app).get('/dashboard/content/venues.json');
    expect(file.status).toBe(200);
    expect(file.body.SIEBEL_ATRIUM.latitude).toBeCloseTo(40.1138, 3);
  });

  it('GET /api/v1/content stays anonymous in required mode and sits behind the limiter stack', async () => {
    const original = env.AUTH_MODE;
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required';
    try {
      const res = await request(app).get('/api/v1/content');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit'] ?? res.headers['x-ratelimit-limit']).toBeDefined();
      const gated = await request(app).get('/api/v1/shifts');
      expect(gated.status).toBe(401);
    } finally {
      (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    }
  });

  it('the second pack (content/example-campus) loads, so a fork with no UIUC content boots', () => {
    const second = loadPack(path.resolve(__dirname, '../content/example-campus'));
    expect(second.event.id).not.toBe('hackillinois-2027');
    expect(second.factionIds.has('NEUTRAL')).toBe(true);
    expect(second.campusMonumentIds).toBeNull();
  });

  it('optional pack files are validated when present: a malformed sticker grid fails at the right path', () => {
    const dir = copyPack((d) =>
      rewrite(d, 'memorabilia.json', (doc) => {
        (doc.items as Array<{ pixel: string[] }>)[0].pixel = ['<script>'];
      })
    );
    let err: unknown;
    try {
      loadPack(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ContentPackError);
    expect((err as ContentPackError).issues).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'memorabilia.json' })]));
  });
});
