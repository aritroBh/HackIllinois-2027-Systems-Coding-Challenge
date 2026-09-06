/**
 * Tiled campus bake (plan M3): the committed pack is internally consistent and
 * agrees with the content pack, without Python or the OSM cache. The deeper
 * schema check lives in scripts/checkCampus.ts (run by verify.sh and CI).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pack } from '../src/content/loader';

const dir = path.join(pack.dir, 'campus');
const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as {
  meta: { schema: number; tileUnits: number; bbox: number[]; coreBbox: number[]; hash: string; counts: Record<string, number>; heights: Record<string, unknown> };
  monuments: Array<{ id: string; poly: number[][]; c: number[]; h: number }>;
  tiles: Array<{ x: number; z: number; bbox: number[]; file: string; sha256: string; bytes: number; core: number; maxH: number }>;
};

describe('tiled campus bake', () => {
  it('is schema 2, covers the whole UIUC frame, and lists the 14 monuments the pack declares', () => {
    expect(index.meta.schema).toBe(2);
    expect(index.meta.bbox).toEqual(pack.event.campus.bbox);
    expect(index.meta.coreBbox).toEqual(pack.event.campus.coreBbox);
    expect(new Set(index.monuments.map((m) => m.id))).toEqual(new Set(pack.monuments.map((m) => m.id)));
    expect(index.tiles.length).toBeGreaterThan(50);
    expect(index.meta.counts.buildings).toBeGreaterThan(5000);
    expect(index.tiles.some((t) => t.core === 1)).toBe(true);
  });

  it('every tile file exists, matches its sha256 and byte count, and keeps its buildings inside its box', () => {
    for (const t of index.tiles) {
      const body = fs.readFileSync(path.join(dir, t.file));
      expect(body.length).toBe(t.bytes);
      expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(t.sha256);
      const doc = JSON.parse(body.toString('utf8')) as { x: number; z: number; buildings: Array<{ p: number[][]; h: number }> };
      expect([doc.x, doc.z]).toEqual([t.x, t.z]);
      let maxH = 0;
      for (const b of doc.buildings) {
        const cx = b.p.reduce((s, q) => s + q[0], 0) / b.p.length;
        const cz = b.p.reduce((s, q) => s + q[1], 0) / b.p.length;
        expect(cx).toBeGreaterThanOrEqual(t.bbox[0] - 1e-6);
        expect(cx).toBeLessThanOrEqual(t.bbox[2] + 1e-6);
        expect(cz).toBeGreaterThanOrEqual(t.bbox[1] - 1e-6);
        expect(cz).toBeLessThanOrEqual(t.bbox[3] + 1e-6);
        if (b.h > maxH) maxH = b.h;
      }
      expect(maxH).toBeCloseTo(t.maxH, 3);
    }
  });

  it('the index hash is a pure function of its content (edits by hand are detected)', () => {
    const meta = { ...index.meta } as Record<string, unknown>;
    delete meta.hash; delete meta.builtAt;
    // Mirrors design/pipeline/bake.py _canon: sorted keys, no spaces, UTF-8, integral floats as ints.
    const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
    const body = JSON.stringify(sortKeys({ meta, monuments: index.monuments, tiles: index.tiles.map((t) => t.sha256) }));
    expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(index.meta.hash);
  });

  it('the legacy core bake still carries the same monuments for the content loader cross-check', () => {
    expect(pack.campusMonumentIds).toEqual(expect.arrayContaining(index.monuments.map((m) => m.id)));
    expect(index.meta.counts.tiles).toBe(index.tiles.length);
  });
});
