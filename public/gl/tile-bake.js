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
 * Street furniture rides in `solid` rather than in an instanced buffer of its own. That is a
 * deliberate reversal of the argument that made trees instanced: there are nine thousand trees
 * of one shape, and two thousand props of nineteen shapes spread over a hundred and twenty-four
 * tiles, so a tile holds a couple of dozen props across a handful of kinds. Instancing that
 * would mean a draw call per kind per tile — more calls than the props have triangles — while
 * merging them into the tile's existing batch costs no calls at all. The meshes are small
 * enough (twenty to a hundred and twenty triangles) that the vertex duplication is a rounding
 * error against the buildings they stand beside.
 *
 * Rooftop clutter is generated here, on the client, from the building record and a hash of its
 * id. It is deterministic, so every player sees the same roofs, and it costs the pack nothing:
 * a flat roof described by its footprint is the only input the generator needs.
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
import { buildProp, fenceRun, hedgeRun } from './props.js';
import { crosswalkDecal, parkingStalls, pitchMarkings, pathEdging, manholes } from './decals.js';
import { rooftopClutter, rooftopGeometry } from './rooftops.js';

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
/**
 * How each prop kind is coloured and shaded.
 *
 * A prop carries no material of its own in the pack — that would be four more bytes per
 * record for a value that is a property of the kind, not of the instance — so the mapping
 * lives here, beside the rest of the palette, where the night look is tuned as a whole.
 */
export const PROP_TINT = {
  bench: [0.28, 0.20, 0.13], picnic: [0.30, 0.22, 0.14],
  bin: [0.16, 0.17, 0.19], bikerack: [0.20, 0.22, 0.25], bollard: [0.18, 0.19, 0.21],
  hydrant: [0.62, 0.10, 0.09], postbox: [0.24, 0.12, 0.12],
  flag: [0.72, 0.72, 0.70], mast: [0.24, 0.25, 0.28], watertower: [0.42, 0.44, 0.46],
  chimney: [0.34, 0.26, 0.22], shelter: [0.20, 0.23, 0.27], busstop: [0.22, 0.25, 0.29],
  artwork: [0.46, 0.42, 0.32], sign: [0.30, 0.32, 0.34], planter: [0.26, 0.22, 0.18],
  drinkfountain: [0.28, 0.30, 0.32], playground: [0.36, 0.26, 0.18], gate: [0.20, 0.21, 0.23],
};
export const PROP_MAT = {
  bench: 'clapboard', picnic: 'clapboard', planter: 'precast', playground: 'clapboard',
  artwork: 'limestoneBuff', watertower: 'metalPanel', chimney: 'brick',
  shelter: 'glassDark', busstop: 'glassDark', sign: 'whiteTrim',
};
/** The few props that carry their own light at night: a shelter, a stop, a lit sign. */
export const PROP_GLOW = { shelter: 0.28, busstop: 0.24, sign: 0.14, drinkfountain: 0.06 };
/** The props that are worth drawing even on the lowest tier, because they read from far away. */
export const LANDMARK_PROPS = new Set(['watertower', 'mast', 'flag', 'chimney', 'artwork', 'shelter', 'busstop']);

/**
 * Metres per world unit for this pack.
 *
 * The pack declares it and the bake worker has no access to the loader, so it is stated here
 * and asserted against the index by `npm run campus:check`. Every metre-to-unit conversion on
 * this path goes through it rather than through a literal ten.
 */
export const MPU = 10;

/** Which surface each rooftop kind is shaded as. */
export const ROOFTOP_MAT = {
  hvac: 'metalPanel', ductRun: 'metalPanel', vent: 'metalPanel', stackPipe: 'metalPanel',
  dish: 'whiteTrim', skylight: 'glassDark', railing: 'metalPanel', waterTank: 'metalPanel',
  solarPanel: 'glassDark', stairHead: 'precast',
};

/** Monument ids whose roofs are hand-written by crowns.js and must not be cluttered. */
export const CROWNED = new Set([
  'ALMA', 'UNION', 'FOELLINGER', 'ALTGELD', 'SIEBEL', 'ECEB', 'GRAINGER',
  'DCL', 'KENNEY', 'STADIUM', 'ASSEMBLY', 'LIBRARY', 'BECKMAN', 'KRANNERT',
]);

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
  /**
   * How much small detail this bake includes: 2 all of it, 1 half the rooftop plant, 0 none of
   * it and no ground furniture either.
   *
   * Rooftop clutter is forty per cent of the vertices on the densest core tile — two hundred
   * and eighty-eight units over eighty-two buildings — which is worth every byte on a laptop
   * and is the first thing that should go on a phone. Making it a bake option rather than a
   * draw-time range means the vertices are never uploaded at all on the low tier, which is the
   * budget that actually binds there: a 2020 phone runs out of resident memory long before it
   * runs out of triangles to rasterise.
   *
   * The cost is that changing tier has to re-bake the resident ring. That happens in the
   * worker, off the main thread, and only when the tier actually moves.
   */
  const detail = opts.detail ?? 2;
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
  // --- rooftop clutter -----------------------------------------------------------------
  // L0 only: at a hundred units out a plant unit is a couple of pixels, and the whole point of
  // L1 is that a distant building is one extrusion and a cap.
  for (const b of tile.buildings || []) {
    if (detail === 0 || !b.p || b.p.length < 3) continue;
    // `vscale` is not a rooftop option — the generator reads `metersPerUnit` and `heightScale`
    // — and passing it did nothing while the plant stayed metric on buildings exaggerated by
    // 2.6. The railing branch also needs the building's own ring, which arrives on the
    // placement rather than in a shared bag, so each placement carries its own options.
    const clutter = rooftopClutter(b, {
      metersPerUnit: MPU,
      density: detail === 1 ? 0.4 : 1,
      // Monuments keep their hand-written crowns; generated vents on top of Altgeld's
      // campanile would be vandalism.
      hasCrown: !!b.crown || CROWNED.has(b.id),
    });
    for (const c of clutter) {
      const geo = rooftopGeometry(c.kind, { metersPerUnit: MPU, heightScale: vscale, ring: c.ring });
      if (!geo) continue;
      L0.push({
        geo, x: c.x, z: c.z, y: b.h * vscale, ry: c.r,
        sx: c.s ?? 1, sy: c.s ?? 1, sz: c.s ?? 1,
        ...matItem(c.kind === 'solarPanel' ? PAL.slate : PAL.membrane, ROOFTOP_MAT[c.kind] || 'metalPanel'),
        emissive: c.kind === 'skylight' ? 0.22 : 0.02,
      });
    }
  }

  // --- surveyed and generated street furniture ------------------------------------------
  for (const pr of tile.props || []) {
    // On the low tier only the tall silhouettes survive: a flagpole or a water tower is a
    // landmark you navigate by, a bin is four hundred vertices nobody will look at.
    if (detail === 0 && !LANDMARK_PROPS.has(pr.k)) continue;
    const geo = buildProp(pr.k, { scale: pr.s });
    // A kind with no mesh is a pack built against a newer pipeline than this client. Skipping
    // it quietly is right: the campus is missing one bench, not broken.
    if (!geo) continue;
    L0.push({
      // `ry`, in RADIANS. `mergeStatic` reads `ry` and nothing reads `rot`, so every prop was
      // silently placed at zero rotation: benches sideways to the paths they serve, gates
      // parallel to the ways they close. The pack stores degrees because that is what a
      // human reads in a diff, so the conversion belongs here.
      geo, x: pr.x, z: pr.z, y: 0, ry: ((pr.r ?? 0) * Math.PI) / 180,
      sx: pr.s ?? 1, sy: pr.s ?? 1, sz: pr.s ?? 1,
      color: PROP_TINT[pr.k] || PAL.limestone,
      mat: MID[PROP_MAT[pr.k] || 'metalPanel'],
      emissive: PROP_GLOW[pr.k] || 0.02,
    });
  }
  for (const f of tile.fences || []) {
    if (!f.p || f.p.length < 2) continue;
    // The baked `h` is already in WORLD UNITS — props.py divides by metersPerUnit — and the
    // run builders take METRES and divide again. Passing the baked value straight through
    // rendered a 1.2 m railing at 12 cm and a hedge flatter than the grass it edges. Multiply
    // back so the builder's own conversion lands where it was meant to.
    const heightM = f.h * MPU;
    const geo = f.k === 'hedge' ? hedgeRun(f.p, heightM) : fenceRun(f.p, f.k, heightM);
    if (!geo) continue;
    // Fences read as edges from a long way off — they are what stops one lawn bleeding into
    // the next — so unlike the point props they survive into L1.
    const item = { geo, ...matItem(f.k === 'hedge' ? PAL.leafDark : f.k === 'wall' ? PAL.limestone : PAL.rail, f.k === 'hedge' ? 'canopy' : f.k === 'wall' ? 'limestoneGrey' : f.k === 'wood' ? 'clapboard' : 'metalPanel'), emissive: 0.01 };
    L0.push(item);
    L1.push(item);
  }
  for (const st of tile.steps || []) {
    if (!st.p || st.p.length < 2) continue;
    L0.push({ geo: ribbonGeometry(st.p, st.w, 0.06), ...matItem(PAL.limestone, 'limestoneGrey'), emissive: 0.02 });
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
  // --- painted ground ------------------------------------------------------------------
  // Empty asphalt is the largest featureless surface on the map after the lawns, and paint is
  // the cheapest thing that fixes it: a stall grid or a zebra is a handful of flat quads and
  // it is what makes a car park read as a car park rather than as a grey polygon.
  for (const ring of tile.parking || []) {
    if (ring.length < 3) continue;
    const stalls = parkingStalls(ring);
    if (stalls) decals.push({ geo: stalls, color: MASS.walk, mat: MID.asphalt, emissive: 0.06 });
    const covers = manholes(ring);
    if (covers) decals.push({ geo: covers, color: PAL.rail, mat: MID.metalPanel, emissive: 0 });
  }
  for (const pt of tile.pitches || []) {
    if (!pt.p || pt.p.length < 3) continue;
    const lines = pitchMarkings(pt.p, pt.sport);
    if (lines) decals.push({ geo: lines, color: [0.82, 0.84, 0.80], mat: MID.asphalt, emissive: 0.10 });
  }
  for (const r of tile.roads || []) {
    if (!r.p || r.p.length < 2) continue;
    if (r.f) {
      // A kerb either side of a footway. Paths are the thing players actually walk along, so
      // the edge is worth more here than anywhere else on the ground plane.
      const edge = pathEdging(r.p, r.w);
      if (edge) decals.push({ geo: edge, color: MASS.walk, mat: MID.limestoneGrey, emissive: 0.04 });
    } else if (r.m) {
      // Zebra crossings at the ends of a major road run, where it meets the next one.
      const a = r.p[0], b = r.p[1];
      const zebra = crosswalkDecal(a, b, r.w);
      if (zebra) decals.push({ geo: zebra, color: [0.86, 0.87, 0.84], mat: MID.asphalt, emissive: 0.12 });
    }
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
    counts: {
      buildings: (tile.buildings || []).length, trees: tr.length, lamps: la.length,
      props: (tile.props || []).length, fences: (tile.fences || []).length,
      pitches: (tile.pitches || []).length, steps: (tile.steps || []).length,
      verts: solid ? solid.positions.length / 3 : 0,
    },
  };
}
