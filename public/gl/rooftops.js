/**
 * rooftops — deterministic plant, vents and railings for flat campus roofs.
 *
 * Seen from the orbit camera this campus is nine thousand buildings presented
 * top-down, and the flat ones are the single largest expanse of nothing in the
 * scene: a slate membrane cap and no incident on it at all. Every real flat
 * roof carries packaged air handling, flues, a stair head, a dish or two and a
 * railing round the edge, and that clutter is what makes a roof read as a roof
 * rather than as a coloured polygon. This module manufactures it.
 *
 * WHY THE CHOICES ARE HASHED AND NOT RANDOM. Every position, size, yaw and kind
 * comes from a hash of the building id and the placement index. Math.random was
 * rejected outright. The bake runs on each client's own worker thread, so a
 * random roof would be a different roof on every machine: two players standing
 * side by side on the Quad, looking at the same building, would see different
 * plant on top of it, and a screenshot or a landmark description ("the one with
 * the water tank") would stop meaning anything. Hashing also makes the bake
 * reproducible across rebuilds, so a pipeline change that shifts a roof is
 * visible in a diff rather than lost in noise. The same reasoning is why the
 * geometry is one canonical mesh per kind: per-placement geometry variation was
 * rejected because it would defeat the caller's ability to build ten meshes
 * once and reuse them for every roof on the campus.
 *
 * WHERE IT RUNS. Imports are limited to glx-geometry.js, which never touches a
 * WebGL context, so this is safe inside bake-worker.js alongside tile-bake.js.
 * Nothing here allocates a GL resource or reads the DOM.
 *
 * THE CONTRACT. `rooftopClutter` returns placements in the world XZ frame with
 * no y: the caller already knows the roof height and adds it, exactly as
 * tile-bake.js does when it caps a roof at h + 0.015. Each geometry sits on
 * y = 0 and grows upward, so a placement becomes a mergeStatic item as
 * { geo, x: p.x, z: p.z, y: roofY, ry: p.r, sx: p.s, sy: p.s, sz: p.s }.
 *
 * SCALE. The frame is metric divided by metersPerUnit, ten for this pack, so a
 * 1.2 m tall air handler is 0.12 world units tall. Props are small; every size
 * below is written in metres and converted once, so the figures stay readable
 * and stay checkable against a real roof.
 */

import {
  mergeStatic, boxGeometry, prismGeometry, domeGeometry, ringGeometry, offsetRing,
} from './glx-geometry.js';

/** The ten things that can appear on a flat roof. PICK_ORDER holds the fallback order. */
export const ROOFTOP_KINDS = [
  'hvac', 'ductRun', 'vent', 'stackPipe', 'dish',
  'skylight', 'railing', 'waterTank', 'solarPanel', 'stairHead',
];

/* ------------------------------------------------------------------ *
 * Frame and thresholds
 * ------------------------------------------------------------------ */

/** Ten metres to the world unit, matching index.json meta.metersPerUnit. */
const DEFAULT_MPU = 10;

/**
 * A roof under about 300 m² is a porch, a lift overrun or a garage. Real plant
 * needs a plant room under it and a route up to it, and a 300 m² roof is the
 * point below which a campus building has neither.
 */
const MIN_AREA_M2 = 300;

/**
 * One unit of plant per 250 m². Counted off the roofs of the engineering
 * quad: a 2,000 m² laboratory roof carries seven or eight visible objects,
 * which is what this ratio produces.
 */
const AREA_PER_UNIT_M2 = 250;

/**
 * A hard ceiling of twenty-four. The largest footprints in the pack run past
 * 20,000 m², which the ratio alone would turn into eighty placements and some
 * four thousand triangles on a single roof that is usually seen from 400 m up.
 * Twenty-four still reads as a busy roof at close range.
 */
const CLUTTER_CAP = 24;

/**
 * Two metres of clear roof between any placement and the edge. Below that a
 * unit reads as hanging off the side of the building, which is the single
 * ugliest failure this module can produce, and it is also where the real
 * fall-arrest setback sits.
 */
const EDGE_INSET_M = 2;

/** Railing geometry: 1.1 m high, held 0.3 m in from the ring. */
const RAIL_HEIGHT_M = 1.1;
const RAIL_INSET_M = 0.3;

/**
 * A railing costs eight triangles per ring edge and nothing else, so the
 * per-placement budget of 150 triangles caps the ring at eighteen edges. Past
 * that the module says no: those are the fussy Victorian footprints with a
 * dozen small returns, where a hairline railing would be lost in the roof
 * detail anyway and the cost would be real.
 */
const RAIL_MAX_EDGES = 18;

/** Ring vertices closer together than 1.2 m are noise from the OSM trace. */
const RAIL_MIN_EDGE_M = 1.2;

/**
 * Building types whose roofs are modern enough for a photovoltaic array.
 * Brick university halls and houses are excluded deliberately: the campus does
 * have panels, but on the glass-and-panel science buildings and the retail
 * boxes, and putting an array on a 1900s slate-capped hall would be a lie the
 * viewer can check by walking past.
 */
const SOLAR_TYPES = new Set([
  'commercial', 'retail', 'office', 'industrial', 'warehouse',
  'hospital', 'supermarket', 'school', 'sports_centre',
]);

/**
 * Weights for the hashed kind choice, plus the constraints that make a roof
 * plausible. `cap` is per building. `minAreaM2` and `minHeightM` gate the
 * pieces that only exist on a building large or tall enough to need them: a
 * stair head needs a stair core, a tank needs the roof area to stand on, and a
 * dish wants a horizon, which on this campus means clearing the tree line.
 * `radiusM` is the plan half-diagonal, used both for spacing and to widen the
 * edge setback so a wide unit's corner cannot overhang.
 */
const KIND_RULES = {
  vent: { weight: 26, cap: 24, radiusM: 0.25 },
  hvac: { weight: 22, cap: 24, radiusM: 1.5 },
  stackPipe: { weight: 14, cap: 24, radiusM: 0.2 },
  ductRun: { weight: 12, cap: 3, radiusM: 2.1 },
  skylight: { weight: 10, cap: 24, radiusM: 0.85 },
  solarPanel: { weight: 8, cap: 6, radiusM: 2.7, solarOnly: true },
  dish: { weight: 4, cap: 2, radiusM: 0.8, minHeightM: 12 },
  waterTank: { weight: 2, cap: 1, radiusM: 1.4, minAreaM2: 400 },
  stairHead: { weight: 2, cap: 1, radiusM: 2.15, minAreaM2: 600 },
};

/** The order the fallback walks when a hashed pick is capped out or ineligible. */
const PICK_ORDER = ['vent', 'hvac', 'stackPipe', 'ductRun', 'skylight', 'solarPanel', 'dish', 'waterTank', 'stairHead'];

/**
 * A plausible flat roof, used when `rooftopClutter` is called with no argument.
 * The repository's winding audit calls every generator arglessly, so the
 * default has to be a building that actually produces placements rather than an
 * empty ring that would let a broken generator pass unexamined. Forty metres by
 * thirty is 1,200 m², five units of plant.
 */
const DEFAULT_BUILDING = {
  id: 'w0', t: 'university', m: 'brick', r: 'f', par: 0, h: 1.8,
  p: [[0, 0], [4, 0], [4, 3], [0, 3]],
};

/* ------------------------------------------------------------------ *
 * Deterministic hashing
 * ------------------------------------------------------------------ */

/** FNV-1a over the id, then an avalanche so neighbouring ids do not correlate. */
function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Mixes a building's seed with a placement index and a salt. The string hash
 * runs once per building and every draw after that is integer arithmetic,
 * which matters because the bake makes on the order of a million draws across
 * the campus. The two constants are the usual golden-ratio and murmur mixers;
 * they carry no meaning beyond decorrelating the low bits.
 */
function mix(seed, index, salt) {
  let h = seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Hashed value in [0, 1). Never Math.random: see the file header. */
const rnd = (seed, index, salt) => mix(seed, index, salt) / 4294967296;

/* ------------------------------------------------------------------ *
 * Footprint predicates
 * ------------------------------------------------------------------ */

/** Twice the signed area; positive for the CCW rings the pipeline guarantees. */
function shoelace(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    a += x0 * z1 - x1 * z0;
  }
  return a;
}

/** Ray-crossing test in XZ. Winding-agnostic, so it reads holes as well as outers. */
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    // The half-open comparison on z is what keeps a point level with a vertex
    // from being counted twice; without it a placement on a horizontal edge
    // flips to "outside" and the roof develops a bald stripe.
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a point to a ring's edges, in world units. */
function distanceToRing(x, z, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    // Degenerate edges appear in traced footprints; fall back to the vertex.
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
    const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * The real test the brief asks for: inside the footprint, `clear` units from
 * the outer ring, and outside every courtyard by the same margin. A bounding
 * box would have been half the code and would have dropped plant into the
 * courtyards of the L-shaped and doughnut-shaped halls, which is exactly the
 * case a campus footprint set is full of.
 */
function insideWithClearance(x, z, ring, holes, clear) {
  if (!pointInRing(x, z, ring)) return false;
  if (distanceToRing(x, z, ring) < clear) return false;
  for (const hole of holes) {
    if (pointInRing(x, z, hole)) return false;
    if (distanceToRing(x, z, hole) < clear) return false;
  }
  return true;
}

/**
 * Yaw of the longest edge, as mergeStatic wants it. That transform sends local
 * +X to (cos ry, 0, -sin ry), so recovering a yaw from a world direction needs
 * the negated z, which is the trap this helper exists to contain.
 */
function dominantYaw(ring) {
  let bestLen = -1, ry = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az;
    const len = dx * dx + dz * dz;
    if (len > bestLen) { bestLen = len; ry = Math.atan2(-dz, dx); }
  }
  return ry;
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

/**
 * Rooftop clutter for one baked building record.
 *
 * Returns an array of { kind, x, z, r, s } in world coordinates, where `r` is
 * the yaw in radians for mergeStatic and `s` a uniform scale on the canonical
 * mesh. The railing placement additionally carries `ring`, its inset ring
 * expressed relative to the placement origin, because a railing is the one
 * kind whose shape is the building's rather than a template's; the caller
 * passes it straight back as rooftopGeometry('railing', { ring }).
 *
 * Returns an empty array, and says so cheaply, when the roof is not flat, is
 * too small to carry plant, or belongs to a monument whose crown is written by
 * hand in design/hand/crowns.
 */
export function rooftopClutter(building = DEFAULT_BUILDING, opts = {}) {
  const b = building || DEFAULT_BUILDING;
  const mpu = opts.metersPerUnit || DEFAULT_MPU;
  const ring = Array.isArray(b.p) ? b.p : [];
  if (ring.length < 3) return [];

  // Only flat roofs. A gable, hip, mansard, dome or skillion already has a
  // silhouette of its own and plant would sit on a slope, floating.
  if ((b.r || 'f') !== 'f') return [];

  // Monuments keep their hand-written crowns. crowns.js places Altgeld's
  // campanile and Foellinger's lantern to the metre; generated vents on top of
  // that would be vandalism, so the caller passes the crowned ids through.
  const crowned = opts.crownIds;
  if (opts.hasCrown === true) return [];
  if (crowned && typeof crowned.has === 'function' && crowned.has(b.id)) return [];

  const holes = Array.isArray(b.holes) ? b.holes : [];
  let areaUnits = Math.abs(shoelace(ring)) / 2;
  for (const hole of holes) areaUnits -= Math.abs(shoelace(hole)) / 2;
  const areaM2 = areaUnits * mpu * mpu;
  if (!(areaM2 > MIN_AREA_M2)) return [];

  const seed = hashString(String(b.id ?? 'w0'));
  const heightM = (b.h || 0) * mpu;
  const toUnits = (metres) => metres / mpu;
  const out = [];

  // --- railing ---------------------------------------------------------
  // Only when the building has no parapet of its own. tile-bake.js already
  // raises a 0.7-unit parapet band on every `par` roof, and a railing standing
  // on the same edge would read as a double wall, which is the kind of doubled
  // detail that looks like a bug rather than like architecture.
  if (!b.par) {
    const railRing = railingRing(ring, toUnits(RAIL_INSET_M), toUnits(RAIL_MIN_EDGE_M));
    if (railRing && railRing.length >= 3 && railRing.length <= RAIL_MAX_EDGES) {
      // Centroid of the inset ring becomes the placement origin, so the ring
      // handed back is local and the geometry still sits at the origin.
      let cx = 0, cz = 0;
      for (const [x, z] of railRing) { cx += x; cz += z; }
      cx /= railRing.length; cz /= railRing.length;
      out.push({
        kind: 'railing', x: cx, z: cz, r: 0, s: 1,
        ring: railRing.map(([x, z]) => [x - cx, z - cz]),
      });
    }
  }

  // --- how much plant ---------------------------------------------------
  //
  // `density` scales the count without changing which building gets what: the placement
  // lattice and the weighted pick are both driven by the building's id hash, so a roof at
  // 0.4 density is the same roof with the last few units left off rather than a different
  // roof. That matters because the renderer re-bakes the resident ring when the quality tier
  // moves, and a player who dips to the middle tier for a few seconds should not watch their
  // rooftops rearrange themselves.
  //
  // A density of zero still leaves the railing: an edge is a silhouette, and the silhouette
  // is what a roof reads as from any distance where the plant on it has stopped mattering.
  const density = typeof opts.density === 'number' ? Math.max(0, Math.min(1, opts.density)) : 1;
  if (density === 0) return out;
  const target = Math.max(1, Math.round(density * Math.min(CLUTTER_CAP, Math.round(areaM2 / AREA_PER_UNIT_M2))));

  // Which kinds this particular building may carry at all.
  const eligible = PICK_ORDER.filter((k) => {
    const rule = KIND_RULES[k];
    if (rule.solarOnly && !SOLAR_TYPES.has(b.t)) return false;
    if (rule.minAreaM2 && areaM2 < rule.minAreaM2) return false;
    if (rule.minHeightM && heightM < rule.minHeightM) return false;
    return true;
  });
  if (!eligible.length) return out;
  const totalWeight = eligible.reduce((sum, k) => sum + KIND_RULES[k].weight, 0);

  // --- candidate lattice -------------------------------------------------
  // Rejection-sampled grid rather than a clever offset-polygon layout: the
  // footprints here are concave, courtyarded and occasionally self-touching,
  // and a grid tested against the real polygon handles all three without a
  // special case. The cost is a few rejected cells per roof, which is nothing
  // next to the triangles the results save from looking empty.
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x; if (z < z0) z0 = z;
    if (x > x1) x1 = x; if (z > z1) z1 = z;
  }
  // Four cells per wanted placement: enough slack that rejection near the edges
  // and in the courtyards still leaves a full set, without scanning the roof to
  // no purpose.
  let step = Math.sqrt(areaUnits / (target * 4));
  const minStep = toUnits(1.5);
  if (!(step > minStep)) step = minStep;
  const cols = Math.max(1, Math.floor((x1 - x0) / step));
  const rows = Math.max(1, Math.floor((z1 - z0) / step));
  // A pathological ring could otherwise ask for a very large scan; 4,000 cells
  // is about forty times the busiest legitimate roof and bounds the worst case.
  if (cols * rows > 4000) return out;

  const candidates = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      // Jitter stays inside 70% of the cell so cells never trade places and the
      // lattice keeps its own minimum spacing for free.
      const jx = (rnd(seed, i, 1) - 0.5) * step * 0.7;
      const jz = (rnd(seed, i, 2) - 0.5) * step * 0.7;
      candidates.push({
        x: x0 + (c + 0.5) * step + jx,
        z: z0 + (r + 0.5) * step + jz,
        // A hashed rank, sorted on below, so that taking the first `target`
        // candidates spreads them over the whole roof. Taking them in row order
        // would pile every placement along the northern edge.
        rank: rnd(seed, i, 3),
        i,
      });
    }
  }
  candidates.sort((a, c) => (a.rank - c.rank) || (a.i - c.i));

  // --- accept ------------------------------------------------------------
  const used = Object.create(null);
  let placed = 0;
  for (const cand of candidates) {
    if (placed >= target) break;

    // Kind first, because the setback and the spacing both depend on how wide
    // the unit is. A 5.3 m solar array needs more clear roof than a flue.
    const kind = pickKind(eligible, totalWeight, used, rnd(seed, cand.i, 4));
    if (!kind) break;
    const rule = KIND_RULES[kind];
    const radius = toUnits(rule.radiusM);

    // The 2 m rule is a rule about the unit's edge, not its centre, so the
    // setback grows with the footprint of what is being placed.
    if (!insideWithClearance(cand.x, cand.z, ring, holes, toUnits(EDGE_INSET_M) + radius)) continue;

    // Keep a metre of walking room between units; a roof with plant welded
    // together reads as one lumpy mass instead of as separate machines.
    let clash = false;
    for (const p of out) {
      if (p.kind === 'railing') continue;
      const need = radius + toUnits(KIND_RULES[p.kind].radiusM) + toUnits(1);
      if (Math.hypot(p.x - cand.x, p.z - cand.z) < need) { clash = true; break; }
    }
    if (clash) continue;

    out.push({
      kind,
      x: cand.x,
      z: cand.z,
      r: yawFor(kind, ring, seed, cand.i),
      s: scaleFor(kind, seed, cand.i),
    });
    used[kind] = (used[kind] || 0) + 1;
    placed++;
  }

  return out;
}

/**
 * Weighted hashed choice, then a walk down PICK_ORDER when the chosen kind has
 * hit its cap. Walking rather than re-drawing keeps the function total: a roof
 * that has already used its one stair head still gets a vent in that slot
 * instead of silently losing a placement.
 */
function pickKind(eligible, totalWeight, used, u) {
  let acc = u * totalWeight;
  let chosen = eligible[eligible.length - 1];
  for (const k of eligible) {
    acc -= KIND_RULES[k].weight;
    if (acc <= 0) { chosen = k; break; }
  }
  const start = eligible.indexOf(chosen);
  for (let n = 0; n < eligible.length; n++) {
    const k = eligible[(start + n) % eligible.length];
    if ((used[k] || 0) < KIND_RULES[k].cap) return k;
  }
  return null;
}

/**
 * Plant is bolted to the building's grid, so most kinds take the yaw of the
 * longest footprint edge with a couple of degrees of hashed slop, which is
 * about the tolerance a real installation is set out to. The two exceptions
 * point at the sky rather than at the building: a dish has to look at the same
 * patch of the southern sky whatever the roof below it is doing, and a solar
 * array faces south for the same reason. Round objects take a free yaw because
 * there is no edge to line up.
 */
function yawFor(kind, ring, seed, index) {
  const jitter = (rnd(seed, index, 5) - 0.5) * 0.12;
  if (kind === 'dish' || kind === 'solarPanel') return jitter * 0.5;
  if (kind === 'vent' || kind === 'stackPipe' || kind === 'waterTank') return rnd(seed, index, 6) * Math.PI * 2;
  // A quarter turn about a third of the time: plant rooms are laid out along
  // either building axis, not all facing the same way.
  const quarter = rnd(seed, index, 7) < 0.34 ? Math.PI / 2 : 0;
  return dominantYaw(ring) + quarter + jitter;
}

/**
 * Site-built and improvised things vary in size; manufactured ones do not. A
 * skylight, a solar panel, a dish and a stair head all come out of a catalogue
 * and are left at their true size, so scaling them would only make the sizes
 * quoted in rooftopGeometry wrong.
 */
function scaleFor(kind, seed, index) {
  if (kind === 'skylight' || kind === 'solarPanel' || kind === 'dish' || kind === 'stairHead') return 1;
  return 0.88 + rnd(seed, index, 8) * 0.26;
}

/** Inset ring for the railing, with the traced micro-edges collapsed out. */
function railingRing(ring, inset, minEdge) {
  const pulled = offsetRing(ring, -inset);
  const simple = [];
  for (const point of pulled) {
    const last = simple[simple.length - 1];
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < minEdge) continue;
    simple.push(point);
  }
  // The closing edge is subject to the same rule as the rest.
  if (simple.length >= 2) {
    const first = simple[0], last = simple[simple.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < minEdge) simple.pop();
  }
  // offsetRing can invert a thin sliver of a ring; a railing whose winding has
  // flipped would face inward, so drop it rather than draw it backwards.
  if (simple.length < 3 || shoelace(simple) <= 0) return null;
  return simple;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * Composition goes through mergeStatic because it already gets the two hard
 * parts right: the inverse-scaled normals on non-uniformly stretched boxes,
 * and the yaw. Its per-vertex colour is discarded here — the caller re-merges
 * these meshes with its own matItem — so the placeholder white below never
 * reaches a shader.
 */
const WHITE = [1, 1, 1];
const part = (geo, x, y, z, sx, sy, sz, ry = 0) => ({ geo, x, y, z, sx, sy, sz, ry, color: WHITE, emissive: 0 });
const assemble = (parts) => mergeStatic(parts);

/**
 * Rotates a mesh about +X. mergeStatic deliberately carries yaw only, because
 * every mass on this campus stands upright and a full matrix per item would
 * cost more than it earns. Two pieces here genuinely tilt — a dish and a solar
 * panel — so they are pitched before they are merged. A rotation has unit
 * determinant, so the winding survives untouched.
 */
function pitch(geo, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const p = new Float32Array(geo.positions);
  const n = new Float32Array(geo.normals);
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1], z = p[i + 2];
    p[i + 1] = y * c - z * s;
    p[i + 2] = y * s + z * c;
    const ny = n[i + 1], nz = n[i + 2];
    n[i + 1] = ny * c - nz * s;
    n[i + 2] = ny * s + nz * c;
  }
  return { positions: p, normals: n, indices: geo.indices };
}

// Shared primitives. Eight sides for a flue and ten or twelve for a cowl or a
// tank: at a 0.25 m diameter on a roof eighty metres away the silhouette is a
// couple of pixels wide, and going past twelve buys nothing but triangles.
const BOX = boxGeometry();
const PRISM8 = prismGeometry(8);
const PRISM10 = prismGeometry(10);
const PRISM12 = prismGeometry(12);
const PRISM6 = prismGeometry(6);
const DISC10 = ringGeometry(0, 1, 10);
// Three rings is the coarsest dome that still curves; the dish is 1.2 m across.
const BOWL = domeGeometry(12, 3);

/** A 10 m square, the argless default for the railing. */
const DEFAULT_RAIL_RING = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];

/**
 * One clutter mesh, at the origin, sitting on y = 0 and growing upward, at its
 * real size in world units. Every dimension in here is quoted in metres in the
 * comment beside it and divided by metersPerUnit once, so the figures can be
 * checked against a real roof rather than reverse-engineered from constants.
 *
 * `opts.heightScale` defaults to 1, which is metric truth. The massing pass
 * exaggerates building heights by vscale, so a caller who wants plant that
 * matches the exaggeration rather than the survey can pass that factor here;
 * it is opt-in because the brief's frame is the metric one.
 */
export function rooftopGeometry(kind = 'hvac', opts = {}) {
  const mpu = opts.metersPerUnit || DEFAULT_MPU;
  const hs = opts.heightScale || 1;
  const u = (metres) => metres / mpu;          // plan dimension
  const uy = (metres) => (metres / mpu) * hs;  // vertical dimension

  switch (kind) {
    /**
     * Packaged rooftop air handler, 2.4 m by 1.5 m by 1.2 m, standing on a
     * 0.1 m kerb with a fan cowl 0.5 m across proud of the top. 54 triangles.
     */
    case 'hvac':
      return assemble([
        part(BOX, 0, 0, 0, u(2.6), uy(0.1), u(1.7)),
        part(BOX, 0, uy(0.1), 0, u(2.4), uy(1.2), u(1.5)),
        part(PRISM10, u(0.55), uy(1.3), 0, u(0.5), uy(0.18), u(0.5)),
      ]);

    /**
     * A 4 m run of insulated duct, 0.6 m square, carried 0.35 m off the roof on
     * two stands so it reads as pipework rather than as a low wall. 36 triangles.
     */
    case 'ductRun':
      return assemble([
        part(BOX, -u(1.5), 0, 0, u(0.18), uy(0.35), u(0.5)),
        part(BOX, u(1.5), 0, 0, u(0.18), uy(0.35), u(0.5)),
        part(BOX, 0, uy(0.35), 0, u(4.0), uy(0.6), u(0.6)),
      ]);

    /**
     * Mushroom extract vent: a 0.35 m pipe 0.4 m tall under a 0.6 m rain cap.
     * The commonest thing on any flat roof, and the cheapest here at 50
     * triangles, which is why it carries the largest weight in KIND_RULES.
     */
    case 'vent':
      return assemble([
        part(PRISM10, 0, 0, 0, u(0.35), uy(0.4), u(0.35)),
        part(DISC10, 0, uy(0.44), 0, u(0.3), 1, u(0.3)),
      ]);

    /**
     * Flue stack: 0.25 m across, 2.2 m tall, with a collar where it leaves the
     * roof. Slim and tall, so it catches the rim light and gives a flat roof a
     * vertical. 36 triangles.
     */
    case 'stackPipe':
      return assemble([
        part(BOX, 0, 0, 0, u(0.45), uy(0.12), u(0.45)),
        part(PRISM8, 0, 0, 0, u(0.25), uy(2.2), u(0.25)),
      ]);

    /**
     * Satellite dish, 1.2 m across on a 0.9 m mast. Champaign sits at 40° north,
     * so the arc of geostationary satellites is roughly 40° above the southern
     * horizon and the boresight tips 50° off vertical toward +Z, which is south
     * in this frame. A squashed dome stands in for the paraboloid: at 1.2 m
     * across, seen from a campus camera, the difference is sub-pixel and the
     * dome costs 72 triangles against the several hundred a real reflector with
     * a visible concave face would need. 102 triangles.
     */
    case 'dish': {
      const bowl = pitch(
        assemble([part(BOWL, 0, 0, 0, u(1.2), uy(0.3), u(1.2))]),
        (50 * Math.PI) / 180,
      );
      return assemble([
        part(PRISM6, 0, 0, 0, u(0.14), uy(0.9), u(0.14)),
        part(BOX, 0, uy(0.75), u(0.3), u(0.06), uy(0.06), u(0.6)),
        { geo: bowl, x: 0, y: uy(0.95), z: 0, sx: 1, sy: 1, sz: 1, color: WHITE, emissive: 0 },
      ]);
    }

    /**
     * Skylight, 1.2 m square and 0.3 m proud: an upstand kerb with the glazing
     * set 0.05 m in from its face, which is what gives the reveal that stops it
     * reading as a painted square. 24 triangles.
     */
    case 'skylight':
      return assemble([
        part(BOX, 0, 0, 0, u(1.2), uy(0.25), u(1.2)),
        part(BOX, 0, uy(0.25), 0, u(1.1), uy(0.05), u(1.1)),
      ]);

    /**
     * Rooftop railing following the building's own inset ring, 1.1 m high. Two
     * horizontal bands and no posts: a 0.05 m post is below a pixel at every
     * zoom this campus is viewed at, and posting a 60 m perimeter would triple
     * the cost of the single most common placement on the map. Eight triangles
     * per edge, capped at eighteen edges by RAIL_MAX_EDGES.
     */
    case 'railing':
      // Through `assemble` like every other kind. Returned raw, this one case
      // handed back the bare positions/normals/indices triple while the other
      // nine returned the merged seven-field record, so any caller reading
      // `.matTint` or `.colors` uniformly across kinds got undefined for the
      // single most common placement on the map.
      return assemble([
        part(railingBands(opts.ring && opts.ring.length >= 3 ? opts.ring : DEFAULT_RAIL_RING, uy(RAIL_HEIGHT_M)), 0, 0, 0, 1, 1, 1),
      ]);

    /**
     * Water tank: a 2.4 m drum 2.0 m tall on a 1.2 m four-legged stand. Rare by
     * weight, because on this campus it is a feature of the older heating
     * plant rather than of every roof. 84 triangles.
     */
    case 'waterTank': {
      const parts = [];
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          parts.push(part(BOX, sx * u(0.9), 0, sz * u(0.9), u(0.14), uy(1.2), u(0.14)));
        }
      }
      parts.push(part(PRISM12, 0, uy(1.2), 0, u(2.4), uy(2.0), u(2.4)));
      return assemble(parts);
    }

    /**
     * Photovoltaic array: three 1.7 m by 1.0 m panels on a 0.4 m rail, tilted
     * 20° so they face south (+Z here). Twenty degrees rather than the 40° that
     * would be optimal at this latitude because commercial flat-roof ballasted
     * arrays are laid shallow to cut wind uplift and row shading. 60 triangles.
     */
    case 'solarPanel': {
      const panel = pitch(
        assemble([part(BOX, 0, 0, 0, u(1.7), uy(0.06), u(1.0))]),
        (20 * Math.PI) / 180,
      );
      // The pitch raises the panel's -Z edge and lowers its +Z edge, so the TALL
      // rail belongs on -Z. Reversed, the south rail speared a quarter of a metre
      // through the panels while the north edge floated on nothing. The heights
      // are the panel's underside at each edge: 0.42 plus or minus 0.05 sin 20.
      const parts = [
        part(BOX, 0, 0, -u(0.45), u(5.3), uy(0.59), u(0.1)),
        part(BOX, 0, 0, u(0.45), u(5.3), uy(0.25), u(0.1)),
      ];
      for (const dx of [-1.8, 0, 1.8]) {
        parts.push({ geo: panel, x: u(dx), y: uy(0.42), z: 0, sx: 1, sy: 1, sz: 1, color: WHITE, emissive: 0 });
      }
      return assemble(parts);
    }

    /**
     * Stair head, 3 m by 3 m by 2.5 m, with a slab overhanging 0.15 m on every
     * side and a door face proud of the north elevation. The overhang is the
     * whole point: it throws the shadow line that tells the eye this is a small
     * building on a roof rather than a crate. 36 triangles.
     */
    case 'stairHead':
      return assemble([
        part(BOX, 0, 0, 0, u(3.0), uy(2.5), u(3.0)),
        part(BOX, 0, uy(2.5), 0, u(3.3), uy(0.12), u(3.3)),
        part(BOX, 0, uy(0.05), -u(1.52), u(1.0), uy(2.1), u(0.08)),
      ]);

    default:
      // An unknown kind is a caller bug, not a reason to throw inside a bake
      // worker where the exception would take the whole tile with it. A vent is
      // the least conspicuous thing to be wrong about.
      return rooftopGeometry('vent', opts);
  }
}

/**
 * Two horizontal bands round a ring given in the placement's local frame. Each
 * band edge is emitted twice with opposing normals and windings, because the
 * renderer culls back faces and a railing is seen from both sides as the camera
 * orbits. Winding matches extrudePolygon's walls, so outward is (ez, -ex) for
 * the counter-clockwise rings the pipeline guarantees.
 */
function railingBands(ring, height) {
  const p = [], n = [], idx = [];
  const rails = [
    [height * 0.94, height],        // top rail, a 0.07 m section at 1.1 m
    [height * 0.44, height * 0.50], // mid rail, at knee height
  ];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    let ex = bx - ax, ez = bz - az;
    const len = Math.hypot(ex, ez) || 1;
    ex /= len; ez /= len;
    const nx = ez, nz = -ex;
    for (const [y0, y1] of rails) {
      for (const side of [1, -1]) {
        const base = p.length / 3;
        p.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
        for (let k = 0; k < 4; k++) n.push(nx * side, 0, nz * side);
        if (side === 1) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
        else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}
