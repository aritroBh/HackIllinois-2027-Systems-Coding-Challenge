/**
 * tile-bake — pure CPU bake of one schema-2 campus tile into static batches.
 *
 * Runs identically inside bake-worker.js and on the main thread (the
 * `?worker=0` path). Output per tile:
 *
 *   solid  one interleaved static batch with three index RANGES — L0 (roofs,
 *          parapets, courtyards, parts, fountains), L1 (flat extrusion + cap),
 *          L2 (footprint decals) — so LOD is a drawElements offset, not a mesh swap
 *   decal  lawns, roads, lane dashes, lamp pools, parking, water, rail
 *   trees  Float32Array rows [x, z, scale, tone]  → one instanced draw
 *   lamps  Float32Array rows [x, z]               → one instanced draw
 *
 * Colours are the tuned night palette; the procedural material id comes from
 * the pipeline's facade classification (`m`), so a clapboard house and a
 * limestone hall differ in pattern as well as tone.
 */
import {
  hexRGB, mergeStatic, mergeStaticRanges, boxGeometry, octahedronGeometry, ringGeometry, prismGeometry, domeGeometry,
  extrudePolygon, extrudePolygonWithHoles, polygonGeometry, polygonGeometryWithHoles, parapetGeometry,
  gableRoofGeometry, hipRoofGeometry, mansardRoofGeometry, ribbonGeometry, dashedRibbonGeometry,
} from './glx-geometry.js';
import { MATERIALS } from './materials.js';

const hx = (h) => hexRGB(h);
const MID = Object.fromEntries(Object.entries(MATERIALS).map(([k, v]) => [k, v.id]));
const ALBEDO_BY_ID = Object.fromEntries(Object.values(MATERIALS).map((v) => [v.id, v.albedo]));
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export const LAMP = [0.99, 0.70, 0.09];
export const PAL = {
  slate: hx('#3B3F47').map((v) => v * 0.55),
  metalRoof: hx('#5C6470').map((v) => v * 0.7),
  membrane: hx('#4A4C52').map((v) => v * 0.5),
  copper: hx('#5E9A8C'),
  limestone: hx('#D9D2C2'),
  water: [0.05, 0.12, 0.22],
  asphalt: hx('#2B2D33').map((v) => v * 0.45),
  rail: hx('#8E9090'),
  tie: [0.16, 0.12, 0.08],
  bark: [0.16, 0.11, 0.07],
  leaf: [0.11, 0.30, 0.15],
  leafDark: [0.07, 0.20, 0.11],
  pole: [0.10, 0.11, 0.13],
};
export const MASS = {
  university: hx('#8E3B2C').map((v) => v * 0.62),
  glassy: [0.11, 0.19, 0.30],
  civic: [0.27, 0.24, 0.21],
  house: [0.10, 0.11, 0.17],
  roof: [0.09, 0.10, 0.14],
  road: [0.062, 0.078, 0.128],
  roadMajor: [0.085, 0.108, 0.170],
  walk: [0.36, 0.34, 0.30],
  lane: [0.99, 0.72, 0.15],
  lawn: [0.02, 0.384, 0.188].map((v) => v * 0.42),
  field: [0.18, 0.49, 0.24].map((v) => v * 0.42),
  wood: [0.05, 0.22, 0.12].map((v) => v * 0.42),
  farm: [0.30, 0.26, 0.14].map((v) => v * 0.42),
};
const GLASSY = new Set(['commercial', 'retail', 'stadium', 'office', 'hotel']);
const HOUSING = new Set(['house', 'detached', 'semidetached_house', 'apartments', 'residential', 'dormitory', 'garage', 'shed']);

const tintCache = new Map();
function tintFor(color, id) {
  const key = color.join(',') + ':' + id;
  let t = tintCache.get(key);
  if (t === undefined) {
    t = Math.min(1.0, lum(color) / Math.max(lum(ALBEDO_BY_ID[id]), 0.02));
    tintCache.set(key, t);
  }
  return t;
}
export function matItem(color, name) {
  const id = MID[name] || MID.brick;
  return { color, mat: id, tint: tintFor(color, id) };
}
export function massColour(type) {
  if (HOUSING.has(type)) return MASS.house;
  if (type === 'university') return MASS.university;
  if (GLASSY.has(type)) return MASS.glassy;
  return MASS.civic;
}

/** Per-vertex colour darkened by the pipeline's neighbour-occlusion value. */
const shadeAO = (c, ao) => (ao ? c.map((v) => v * (1 - 0.28 * ao)) : c);

function spans(ring) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) { if (x < x0) x0 = x; if (z < z0) z0 = z; if (x > x1) x1 = x; if (z > z1) z1 = z; }
  return { x0, z0, x1, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

const GEO = { box: boxGeometry(), octa: octahedronGeometry(), prism8: prismGeometry(8), dome: domeGeometry(16, 7), pool: ringGeometry(0, 1, 12) };

/** The elm every tree instance shares (scale/tone come from the instance row). */
export function treeTemplate() {
  const s = 1;
  return mergeStatic([
    { geo: GEO.prism8, x: 0, z: 0, y: 0, sx: 0.13 * s, sy: 0.85 * s, sz: 0.13 * s, color: PAL.bark, emissive: 0 },
    { geo: GEO.octa, x: 0, z: 0, y: 1.25 * s, sx: 1.55 * s, sy: 1.1 * s, sz: 1.45 * s, ...matItem(PAL.leaf, 'canopy'), emissive: 0.015 },
    { geo: GEO.octa, x: 0.18 * s, z: -0.14 * s, y: 1.65 * s, ry: 0.7, sx: 1.0 * s, sy: 0.85 * s, sz: 0.95 * s, ...matItem(PAL.leafDark, 'canopy'), emissive: 0.01 },
    { geo: GEO.octa, x: -0.3 * s, z: 0.22 * s, y: 1.1 * s, ry: 2.1, sx: 0.9 * s, sy: 0.7 * s, sz: 0.9 * s, ...matItem(PAL.leafDark, 'canopy'), emissive: 0.01 },
  ]);
}
export function lampTemplate() {
  return mergeStatic([
    { geo: GEO.prism8, x: 0, z: 0, y: 0, sx: 0.045, sy: 0.95, sz: 0.045, color: PAL.pole, emissive: 0 },
    { geo: GEO.box, x: 0, z: 0, y: 0.92, sx: 0.13, sy: 0.11, sz: 0.13, color: LAMP, emissive: 1.5 },
  ]);
}

function roofItems(b, ring, h, holes, vscale) {
  const items = [];
  const r = b.r || 'f';
  const sp = spans(ring);
  const short = Math.min(sp.w, sp.d);
  const rise = Math.min(1.2, short * 0.25 * vscale);
  const roofMat = HOUSING.has(b.t) ? matItem(PAL.slate, 'slate') : b.m === 'metalPanel' ? matItem(PAL.metalRoof, 'standingSeam') : matItem(PAL.membrane, 'roofMembrane');
  if ((r === 'g' || r === 'h' || r === 'm') && b.rr && short > 0.4) {
    if (r === 'g') items.push({ geo: gableRoofGeometry(ring, h + 0.01, b.rr, rise), ...matItem(PAL.slate, 'slate'), emissive: 0 });
    else if (r === 'h') items.push({ geo: hipRoofGeometry(ring, h + 0.01, b.rr, rise * 0.85), ...matItem(PAL.slate, 'slate'), emissive: 0 });
    else items.push({ geo: mansardRoofGeometry(ring, h + 0.01, rise * 0.7), ...matItem(PAL.slate, 'slate'), emissive: 0 });
    // The rectangle roof leaves L-shaped corners open; cap the footprint under it.
    items.push({ geo: polygonGeometryWithHoles(ring, h + 0.012, holes), ...roofMat, emissive: 0 });
    return items;
  }
  if (r === 'd') {
    const rad = short / 2;
    items.push({ geo: polygonGeometryWithHoles(ring, h + 0.012, holes), ...roofMat, emissive: 0 });
    items.push({ geo: GEO.dome, x: sp.cx, z: sp.cz, y: h, sx: rad, sy: rad * 0.55 * vscale / 2.6, sz: rad, ...matItem(PAL.copper, 'verdigrisDome'), emissive: 0.02 });
    return items;
  }
  items.push({ geo: polygonGeometryWithHoles(ring, h + 0.015, holes), ...roofMat, emissive: 0 });
  if (b.par) items.push({ geo: parapetGeometry(ring, h + 0.015, Math.min(0.06, short * 0.08), 0.07), ...matItem(massColour(b.t), b.m || 'brick'), emissive: 0 });
  return items;
}

/**
 * Bake one tile. `opts.vscale` is the vertical exaggeration; `opts.lod` false
 * skips L1/L2 (tests). Returns typed arrays only — no DOM, no GL.
 */
export function bakeTile(tile, opts = {}) {
  const vscale = opts.vscale ?? 2.6;
  const L0 = [], L1 = [], L2 = [];
  for (const b of tile.buildings || []) {
    const ring = b.p;
    if (!ring || ring.length < 3) continue;
    const holes = b.holes || [];
    const h = b.h * vscale;
    const body = { ...matItem(shadeAO(massColour(b.t), b.ao), b.m || (b.t === 'university' || HOUSING.has(b.t) ? 'brick' : GLASSY.has(b.t) ? 'concreteGrey' : 'limestoneBuff')), emissive: HOUSING.has(b.t) ? 0.012 : 0.03 };
    L0.push({ geo: extrudePolygonWithHoles(ring, h, 0, holes), ...body });
    for (const part of b.parts || []) {
      if (!part.p || part.p.length < 3) continue;
      const ph = part.h * vscale, pm = (part.min || 0) * vscale;
      if (ph <= h + 0.05 && pm === 0) continue;   // hidden inside the body
      L0.push({ geo: extrudePolygon(part.p, ph, pm), ...body });
      L0.push({ geo: polygonGeometry(part.p, ph + 0.012), ...matItem(PAL.membrane, 'roofMembrane'), emissive: 0 });
    }
    L0.push(...roofItems(b, ring, h, holes, vscale));
    L1.push({ geo: extrudePolygon(ring, h), ...body });
    L1.push({ geo: polygonGeometry(ring, h + 0.015), ...matItem(PAL.membrane, 'roofMembrane'), emissive: 0 });
    L2.push({ geo: polygonGeometry(ring, 0.03), ...matItem(massColour(b.t), b.m || 'brick'), emissive: 0.02 });
  }
  for (const [x, z, sc] of tile.fountains || []) {
    L0.push(
      { geo: GEO.prism8, x, z, y: 0, sx: 1.6 * sc, sy: 0.22, sz: 1.6 * sc, ...matItem(PAL.limestone, 'limestoneBuff'), emissive: 0.02 },
      { geo: GEO.prism8, x, z, y: 0.22, sx: 1.35 * sc, sy: 0.04, sz: 1.35 * sc, color: [0.35, 0.65, 0.95], emissive: 0.45 },
      { geo: GEO.octa, x, z, y: 0.35, sx: 0.18 * sc, sy: 0.6 * sc, sz: 0.18 * sc, color: [0.6, 0.85, 1.0], emissive: 0.9 },
    );
  }
  const solid = (L0.length || L1.length || L2.length) ? mergeStaticRanges([L0, L1, L2]) : null;

  const decals = [];
  for (const l of tile.lawns || []) {
    if (!l.p || l.p.length < 3) continue;
    const k = l.k === 'field' ? ['field', 'field'] : l.k === 'wood' ? ['wood', 'lawn'] : l.k === 'farm' ? ['farm', 'field'] : ['lawn', 'lawn'];
    decals.push({ geo: polygonGeometry(l.p, 0.02), ...matItem(MASS[k[0]], k[1]), emissive: 0.05 });
  }
  for (const r of tile.roads || []) {
    if (!r.p || r.p.length < 2) continue;
    decals.push({
      geo: ribbonGeometry(r.p, r.w, r.f ? 0.05 : 0.04),
      ...matItem(r.f ? MASS.walk : (r.m ? MASS.roadMajor : MASS.road), r.f ? 'walk' : (r.m ? 'asphaltLine' : 'asphalt')),
      emissive: r.f ? 0.14 : (r.m ? 0.08 : 0.04),
    });
    if (r.m) decals.push({ geo: dashedRibbonGeometry(r.p, 0.07, 1.1, 1.5, 0.048), color: MASS.lane, emissive: 0.30 });
  }
  for (const [x, z] of tile.lamps || []) decals.push({ geo: GEO.pool, x, z, y: 0.062, sx: 0.42, sy: 1, sz: 0.42, color: LAMP, emissive: 0.16 });
  for (const ring of tile.parking || []) if (ring.length >= 3) decals.push({ geo: polygonGeometry(ring, 0.025), ...matItem(PAL.asphalt, 'asphalt'), emissive: 0.0 });
  for (const w of tile.water || []) {
    if (w.k === 'line' && w.p.length >= 2) decals.push({ geo: ribbonGeometry(w.p, 0.55, 0.035), ...matItem(PAL.water, 'water'), emissive: 0.10 });
    else if (w.k === 'poly' && w.p.length >= 3) decals.push({ geo: polygonGeometry(w.p, 0.035), ...matItem(PAL.water, 'water'), emissive: 0.10 });
  }
  for (const r of tile.rail || []) {
    if (r.length < 2) continue;
    decals.push({ geo: ribbonGeometry(r, 0.34, 0.036), ...matItem(PAL.rail, 'ballast'), emissive: 0.03 });
    decals.push({ geo: dashedRibbonGeometry(r, 0.42, 0.22, 0.32, 0.046), color: PAL.tie, emissive: 0 });
  }
  const decal = decals.length ? mergeStatic(decals) : null;

  const tr = tile.trees || [];
  const trees = new Float32Array(tr.length * 4);
  for (let i = 0; i < tr.length; i++) {
    const [x, z, s] = tr[i];
    trees[i * 4] = x; trees[i * 4 + 1] = z; trees[i * 4 + 2] = s;
    trees[i * 4 + 3] = 0.85 + ((((x * 7.3 + z * 3.1) % 1) + 1) % 1) * 0.3;
  }
  const la = tile.lamps || [];
  const lamps = new Float32Array(la.length * 2);
  for (let i = 0; i < la.length; i++) { lamps[i * 2] = la[i][0]; lamps[i * 2 + 1] = la[i][1]; }

  return {
    solid, decal, trees, lamps,
    counts: { buildings: (tile.buildings || []).length, trees: tr.length, lamps: la.length, verts: solid ? solid.positions.length / 3 : 0 },
  };
}
