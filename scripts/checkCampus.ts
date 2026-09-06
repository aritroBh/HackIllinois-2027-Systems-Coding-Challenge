/**
 * checkCampus — validates a pack's tiled campus bake (schema 2) with Zod, the
 * TypeScript mirror of design/pipeline/schema.py. Run by scripts/verify.sh and
 * CI; needs no network and no Python.
 *
 *   npx tsx scripts/checkCampus.ts [content/<pack>]
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { MATERIAL_IDS } from './materialIds';

const ring = z.array(z.tuple([z.number(), z.number()])).min(3);
const building = z.object({
  id: z.string().regex(/^[wr]\d+(\.\d+)?$/),
  n: z.string().nullable().optional(),
  t: z.string(),
  h: z.number().gt(0.2).lte(15),
  hsrc: z.enum(['tag', 'lidar', 'levels', 'default', 'hand']),
  lv: z.number().int().positive(),
  r: z.enum(['f', 'g', 'h', 'm', 'd', 's']),
  rr: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]).optional(),
  m: z.string().refine((m) => m in MATERIAL_IDS, 'unknown material'),
  c: z.string().regex(/^#[0-9a-f]{6}$/).optional(),
  ao: z.number().min(0).max(1),
  par: z.union([z.literal(0), z.literal(1)]),
  ps: z.number().optional(),
  p: ring,
  holes: z.array(ring).optional(),
  parts: z.array(z.object({ p: ring, h: z.number(), min: z.number() })).optional(),
});
const tileSchema = z.object({
  schema: z.literal(2),
  x: z.number().int(),
  z: z.number().int(),
  buildings: z.array(building),
  roads: z.array(z.object({ id: z.string(), w: z.number().positive(), m: z.number(), f: z.number(), p: z.array(z.tuple([z.number(), z.number()])).min(2) })),
  lawns: z.array(z.object({ id: z.string(), k: z.enum(['lawn', 'field', 'wood', 'farm']), n: z.string().nullable().optional(), p: ring })),
  trees: z.array(z.tuple([z.number(), z.number(), z.number()])),
  lamps: z.array(z.tuple([z.number(), z.number()])),
  fountains: z.array(z.tuple([z.number(), z.number(), z.number()])),
  water: z.array(z.object({ k: z.enum(['line', 'poly']), p: z.array(z.tuple([z.number(), z.number()])).min(2) })),
  rail: z.array(z.array(z.tuple([z.number(), z.number()])).min(2)),
  parking: z.array(ring),
});
const indexSchema = z.object({
  meta: z.object({
    schema: z.literal(2),
    pack: z.string(),
    origin: z.tuple([z.number(), z.number()]),
    metersPerUnit: z.number().positive(),
    vscale: z.number().positive(),
    tileUnits: z.number().positive(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    coreBbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    sources: z.array(z.object({ name: z.string(), licence: z.string() }).passthrough()).min(1),
    heights: z.record(z.union([z.number(), z.boolean()])),
    counts: z.record(z.number()),
    hash: z.string().length(64),
    builtAt: z.string(),
  }).passthrough(),
  monuments: z.array(z.object({ id: z.string(), kind: z.string().min(1), poly: ring, c: z.tuple([z.number(), z.number()]), h: z.number(), crown: z.object({ kind: z.string(), ops: z.array(z.record(z.unknown())) }).optional() }).passthrough()),
  tiles: z.array(z.object({ x: z.number().int(), z: z.number().int(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), maxH: z.number(), counts: z.record(z.number()), bytes: z.number().int(), sha256: z.string().length(64), file: z.string(), core: z.number() })),
});

function signedArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const [x0, z0] = r[i]; const [x1, z1] = r[(i + 1) % r.length]; a += x0 * z1 - x1 * z0; }
  return a / 2;
}

function main(): number {
  const packDir = path.resolve(process.argv[2] || 'content/hackillinois-2027');
  const dir = path.join(packDir, 'campus');
  const errors: string[] = [];
  const indexPath = path.join(dir, 'index.json');
  if (!fs.existsSync(indexPath)) { console.error(`checkCampus: missing ${indexPath}`); return 1; }
  const parsedIndex = indexSchema.safeParse(JSON.parse(fs.readFileSync(indexPath, 'utf8')));
  if (!parsedIndex.success) { for (const e of parsedIndex.error.errors) errors.push(`index.json ${e.path.join('.')}: ${e.message}`); }
  else {
    const index = parsedIndex.data;
    const packMonuments = new Set((JSON.parse(fs.readFileSync(path.join(packDir, 'monuments.json'), 'utf8')) as { monuments: { id: string }[] }).monuments.map((m) => m.id));
    const baked = new Set(index.monuments.map((m) => m.id));
    for (const id of packMonuments) if (!baked.has(id)) errors.push(`monument ${id} missing from the bake`);
    for (const id of baked) if (!packMonuments.has(id)) errors.push(`baked monument ${id} not declared in monuments.json`);
    let tiles = 0, buildings = 0;
    const range = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
    for (const t of index.tiles) {
      const file = path.join(dir, t.file);
      if (!fs.existsSync(file)) { errors.push(`tile missing: ${t.file}`); continue; }
      const body = fs.readFileSync(file);
      if (crypto.createHash('sha256').update(body).digest('hex') !== t.sha256) errors.push(`tile sha256 mismatch: ${t.file}`);
      const parsed = tileSchema.safeParse(JSON.parse(body.toString('utf8')));
      if (!parsed.success) { for (const e of parsed.error.errors.slice(0, 5)) errors.push(`${t.file} ${e.path.join('.')}: ${e.message}`); continue; }
      tiles++;
      for (const b of parsed.data.buildings) {
        buildings++;
        if (signedArea(b.p) <= 0) errors.push(`${t.file}: ${b.id} ring not CCW`);
        for (const hole of b.holes || []) if (signedArea(hole) >= 0) errors.push(`${t.file}: ${b.id} hole not CW`);
        const cx = b.p.reduce((s, q) => s + q[0], 0) / b.p.length, cz = b.p.reduce((s, q) => s + q[1], 0) / b.p.length;
        if (!range(cx, t.bbox[0] - 1e-6, t.bbox[2] + 1e-6) || !range(cz, t.bbox[1] - 1e-6, t.bbox[3] + 1e-6)) errors.push(`${t.file}: ${b.id} centroid outside its tile`);
      }
    }
    if (!errors.length) console.log(`checkCampus: OK — ${tiles} tiles, ${buildings} buildings, ${index.monuments.length} monuments, hash ${index.meta.hash.slice(0, 12)}`);
  }
  for (const e of errors.slice(0, 40)) console.error(`checkCampus: ${e}`);
  if (errors.length > 40) console.error(`checkCampus: … ${errors.length - 40} more`);
  return errors.length ? 1 : 0;
}

process.exit(main());
