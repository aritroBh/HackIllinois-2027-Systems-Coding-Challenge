/**
 * props — the small repeated furniture of the campus, plus the handful of tall
 * landmarks that behave like furniture because there are dozens of them and
 * none of them is worth a footprint in the content pack.
 *
 * WHY THIS FILE EXISTS. A campus tile already bakes its buildings, roads and
 * lawns into one static batch (tile-bake.js), and the obvious thing to do with
 * a bench is to bake it there too. That was tried and rejected: a tile holds a
 * few hundred benches, bins and bollards, so baking them costs vertices in
 * proportion to the count, re-runs on every tile rebuild, and makes the merged
 * buffer large enough to stall the upload. Props are instead built ONCE per
 * kind here and drawn instanced, so a thousand bollards cost one mesh plus a
 * transform each. The second rejected alternative was authored meshes loaded as
 * glTF: the dashboard's CSP is 'self'-only, an asset pipeline for a bench is
 * absurd, and a bench is four boxes anyway.
 *
 * THE TRIANGLE BUDGET IS THE POINT. Every builder here stays under roughly 120
 * triangles. These are drawn as instances, thousands at a time, so a
 * 400-triangle bench costs more than the entire building it sits next to — the
 * building is one instance of a few hundred triangles, the bench is nine
 * hundred instances. Where a piece has faces that can never be seen (the
 * underside of a leg, the top of a post buried in a slab) it is emitted with
 * `postGeometry`, which drops the two end caps and saves four triangles a time.
 * That sounds like pennies until it is multiplied by the instance count.
 *
 * SIZE IS THE OTHER POINT. World units are metres divided by ten, so a park
 * bench 1.7 m long is 0.17 units and a 0.45 m seat is 0.045 units. Props are
 * genuinely tiny, and a bench accidentally built at the scale of a car is the
 * single most obvious way for this renderer to look wrong. Every dimension
 * below is therefore written in metres, passed through `metres()` exactly once,
 * and carries the real-world figure it came from in a comment, so any of them
 * can be argued with against a tape measure rather than against a magic number.
 *
 * THE FRAME. Each prop is built at the origin, standing on y = 0, facing +X:
 * the front of a bench, the glazed opening of a bus shelter and the face of a
 * sign all look down +X, which means their long axes run along Z. Placement
 * code turns the whole instance about Y, and mergeStatic's `ry` is the only
 * rotation available, so nothing here relies on a tilt about X or Z.
 *
 * WHAT A BUILDER RETURNS. The merged output of `mergeStatic` — positions,
 * normals, colors, emissives, matTint, extras and indices — which is what the
 * instanced draw path and the tile baker both consume. Two traps come with
 * that. First, the colours and material ids are already baked per vertex, so
 * feeding the result back into `mergeStatic` as another item's `geo` would
 * overwrite them with that item's single colour; place a prop with an instance
 * transform, not by re-merging. Second, no finished prop is memoised, and that
 * is deliberate: this module runs inside bake-worker.js, whose reply transfers
 * the underlying ArrayBuffers, so a cached mesh handed out twice would come
 * back neutered the second time. The unit primitives below are cached, which is
 * safe for the opposite reason — mergeStatic copies out of them and they are
 * never handed to a caller.
 *
 * This file imports only glx-geometry.js and materials.js, neither of which
 * touches a WebGL context, so it is safe on the worker thread.
 */

import {
  boxGeometry, prismGeometry, spireGeometry, coneGeometry, octahedronGeometry,
  ringGeometry, hipRoofGeometry, mergeStatic, v3,
} from './glx-geometry.js';
import { MATERIALS } from './materials.js';

/**
 * Materials borrowed rather than added. materials.js is not edited from here,
 * so each prop uses the closest existing id and lives with the mismatch. The
 * ids worth adding, in the order they would help most: a `paintedWood` for
 * bench and picnic slats, since `clapboard` is a 0.15 m lap siding and its
 * shadow line lands roughly right on a 0.04 m slat only by luck; a `castIron`
 * for bench frames, bike hoops and railings, where `metalPanel` supplies the
 * tone but its 0.30 m corrugation is meaningless across a 0.048 m tube; a
 * `hedge` whose foliage frequency is tuned to a 0.7 m clipped face rather than
 * `canopy`, which is tuned to a 6 m tree crown; a `safetyRed` for hydrants,
 * currently `terracotta` with its roof-tile courses; and a translucent
 * polycarbonate for shelter roofs, where `glass` is close in tone but carries a
 * 1.5 m mullion grid across a 1.7 m panel.
 */

/** Metres per world unit for this pack; the bake and materials.js agree on 10. */
const METERS_PER_UNIT = 10;

/** metres(0.45) reads as "zero point four five metres" and returns world units. */
const metres = (v) => v / METERS_PER_UNIT;

/**
 * MATERIALS holds daylight albedos and the renderer's night palette lives in
 * campus3d.js, so a prop baked with no palette is dimmed to match crowns.js
 * rather than glowing like noon in the middle of a night scene.
 */
const NIGHT = 0.55;

/* ------------------------------------------------------------------ *
 * Surfaces and placement
 * ------------------------------------------------------------------ */

/**
 * Item fields for a materials.js material name. An unknown name falls back to
 * grey concrete instead of throwing, because a prop with the wrong tone is a
 * far better failure than a tile that fails to bake.
 */
function surface(name, dim = NIGHT, emissive = 0, tint = 1) {
  const mat = MATERIALS[name] || MATERIALS.concreteGrey;
  return {
    color: [mat.albedo[0] * dim, mat.albedo[1] * dim, mat.albedo[2] * dim],
    mat: mat.id,
    tint,
    emissive,
  };
}

/**
 * Places one primitive into an item list. `w`, `h` and `d` are FULL sizes along
 * x, y and z, and `y` is the base of the piece rather than its centre, because
 * every generator in glx-geometry.js stands on y = 0 and is centred on x and z.
 * The octahedron is the one exception and is documented where it is used.
 */
function place(items, geo, s, { x = 0, y = 0, z = 0, w = 1, h = 1, d = 1, ry = 0 }) {
  items.push({ geo, color: s.color, mat: s.mat, tint: s.tint, emissive: s.emissive, x, y, z, sx: w, sy: h, sz: d, ry });
}

/* ------------------------------------------------------------------ *
 * Shared primitives — built once, copied into every merge.
 * ------------------------------------------------------------------ */

const CACHE = new Map();
function cached(key, make) {
  let g = CACHE.get(key);
  if (!g) { g = make(); CACHE.set(key, g); }
  return g;
}

const BOX = () => cached('box', boxGeometry);
const POST = () => cached('post', postGeometry);
const OCTA = () => cached('octa', octahedronGeometry);
const PRISM = (sides, capped = true) => cached(`prism${sides}${capped ? 'c' : 'o'}`, () => prismGeometry(sides, capped));
const SPIRE = (seg) => cached(`spire${seg}`, () => spireGeometry(seg));
const CONE = (seg) => cached(`cone${seg}`, () => coneGeometry(seg));
const RING = (inner, seg) => cached(`ring${inner}:${seg}`, () => ringGeometry(inner, 1, seg));

const addBox = (items, s, dims) => place(items, BOX(), s, dims);
const addPost = (items, s, dims) => place(items, POST(), s, dims);
const addOcta = (items, s, dims) => place(items, OCTA(), s, dims);
const addPrism = (items, s, sides, capped, dims) => place(items, PRISM(sides, capped), s, dims);
const addSpire = (items, s, seg, dims) => place(items, SPIRE(seg), s, dims);
const addCone = (items, s, seg, dims) => place(items, CONE(seg), s, dims);
const addRing = (items, s, inner, seg, dims) => place(items, RING(inner, seg), s, dims);

/* ------------------------------------------------------------------ *
 * Face emission — the winding safety net
 * ------------------------------------------------------------------ */

const triNormal = (a, b, c) => v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));

/**
 * Emits one flat-shaded convex face with `nrm` on every vertex, fanned from the
 * first corner. The winding is derived from the supplied normal rather than
 * trusted from the caller: the repository's winding audit compares each
 * triangle's geometric normal against its stored normals and fails the build on
 * disagreement, and hand-ordering four corners correctly on both sides of a
 * swept bar is exactly the kind of thing that is wrong once in twenty. Deriving
 * it costs one cross product per face at bake time and cannot be got wrong.
 */
function face(p, n, idx, verts, nrm) {
  const base = p.length / 3;
  for (const v of verts) { p.push(v[0], v[1], v[2]); n.push(nrm[0], nrm[1], nrm[2]); }
  const flip = v3.dot(triNormal(verts[0], verts[1], verts[2]), nrm) < 0;
  for (let i = 1; i < verts.length - 1; i++) {
    if (flip) idx.push(base, base + i + 1, base + i);
    else idx.push(base, base + i, base + i + 1);
  }
}

const finish = (p, n, idx) => ({
  positions: new Float32Array(p),
  normals: new Float32Array(n),
  indices: new Uint32Array(idx),
});

/**
 * A unit box with no top and no bottom face: eight triangles instead of twelve.
 * Every slender vertical in this file — bench legs, sign posts, swing legs,
 * gate bars — either stands on the ground or dies into a slab, so both caps are
 * hidden. A third off the triangle count of the commonest piece in the file is
 * worth the separate generator.
 */
export function postGeometry() {
  const p = [], n = [], idx = [];
  const h = 0.5;
  face(p, n, idx, [[-h, 0, h], [h, 0, h], [h, 1, h], [-h, 1, h]], [0, 0, 1]);
  face(p, n, idx, [[h, 0, -h], [-h, 0, -h], [-h, 1, -h], [h, 1, -h]], [0, 0, -1]);
  face(p, n, idx, [[h, 0, h], [h, 0, -h], [h, 1, -h], [h, 1, h]], [1, 0, 0]);
  face(p, n, idx, [[-h, 0, -h], [-h, 0, h], [-h, 1, h], [-h, 1, -h]], [-1, 0, 0]);
  return finish(p, n, idx);
}

/**
 * Sweeps a rectangular cross-section along a polyline drawn in the XY plane and
 * extruded in Z — the shape of a bent tube seen from the side, which is what a
 * bike hoop and a railing are.
 *
 * The station normal is averaged from the previous and next segments, the same
 * trick ribbonGeometry uses, and it is what makes a right-angled corner come
 * out as a 45-degree mitre rather than as a spike. That mitre also narrows the
 * bar to about seven tenths of its thickness across the corner, which is left
 * alone: on a 48 mm tube the error is 14 mm, well under a pixel at any distance
 * where a bike rack is more than a smudge, and correcting it would mean
 * dividing by the cosine of the half angle and blowing up on a fold-back.
 */
export function sweepXY(path = [[-0.03, 0], [-0.03, 0.075], [0.03, 0.075], [0.03, 0]], halfT = 0.0024, halfZ = 0.0024, z0 = 0) {
  const p = [], n = [], idx = [];
  if (!path || path.length < 2) return finish(p, n, idx);

  const st = [];
  for (let i = 0; i < path.length; i++) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(path.length - 1, i + 1)];
    let dx = next[0] - prev[0], dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    st.push({ x: path[i][0], y: path[i][1], nx: -dy, ny: dx });
  }

  const zf = z0 + halfZ, zb = z0 - halfZ;
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    const off = (s, k) => [s.x + s.nx * halfT * k, s.y + s.ny * halfT * k];
    const aL = off(a, 1), aR = off(a, -1), bL = off(b, 1), bR = off(b, -1);
    // The face normals come from this segment's own direction, not from the
    // averaged station normals, so a mitred corner still lights as two flats.
    let ex = b.x - a.x, ey = b.y - a.y;
    const l = Math.hypot(ex, ey);
    // A repeated path point would otherwise slip past a "|| 1" fallback and
    // emit four degenerate faces, which cost vertices and draw nothing.
    if (l < 1e-9) continue;
    ex /= l; ey /= l;
    const sx = -ey, sy = ex;
    face(p, n, idx, [[aL[0], aL[1], zb], [bL[0], bL[1], zb], [bL[0], bL[1], zf], [aL[0], aL[1], zf]], [sx, sy, 0]);
    face(p, n, idx, [[aR[0], aR[1], zf], [bR[0], bR[1], zf], [bR[0], bR[1], zb], [aR[0], aR[1], zb]], [-sx, -sy, 0]);
    face(p, n, idx, [[aL[0], aL[1], zf], [bL[0], bL[1], zf], [bR[0], bR[1], zf], [aR[0], aR[1], zf]], [0, 0, 1]);
    face(p, n, idx, [[aR[0], aR[1], zb], [bR[0], bR[1], zb], [bL[0], bL[1], zb], [aL[0], aL[1], zb]], [0, 0, -1]);
  }
  return finish(p, n, idx);
}

/**
 * The same hash materials.js uses in GLSL, so jitter chosen on the CPU has the
 * same character as noise chosen on the GPU and a hedge does not read as two
 * different kinds of randomness stitched together.
 */
function hash11(i) {
  const s = Math.sin(i * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/* ------------------------------------------------------------------ *
 * Street and park furniture
 * ------------------------------------------------------------------ */

/**
 * Park bench, 56 triangles. 1.7 m long seats three adults; the 6 ft (1.83 m)
 * bench is the other common size and is a `length` away. The 0.45 m seat is the
 * comfortable dining-chair height councils specify, and the 0.85 m back top is
 * where a seated shoulder blade lands.
 */
export function bench(opts = {}) {
  const { dim = NIGHT, length = 1.7 } = opts;
  const wood = surface('clapboard', dim);
  const iron = surface('metalPanel', dim);
  const items = [];

  const L = metres(length);      // 1.70 m along Z, the seating direction
  const D = metres(0.55);        // 0.55 m seat depth, front edge to back plank
  const SEAT = metres(0.45);     // 0.45 m to the top of the seat
  const BACK = metres(0.85);     // 0.85 m to the top of the backrest
  const SLAT = metres(0.04);     // 40 mm slats, a plausible hardwood section
  const FRAME = metres(0.06);    // 60 mm cast-iron end frame

  // End frames: full-depth plates rather than shaped castings, since the
  // scrollwork of a real frame is sub-pixel past about fifteen metres.
  for (const s of [-1, 1]) {
    addPost(items, iron, { z: s * (L / 2 - FRAME / 2), w: D, h: SEAT, d: FRAME });
    // The stub that carries the backrest, standing on the frame below it.
    addPost(items, iron, { x: -(D / 2 - FRAME / 2), y: SEAT, z: s * (L / 2 - FRAME / 2), w: FRAME, h: BACK - SEAT, d: FRAME });
  }
  addBox(items, wood, { y: SEAT - SLAT, w: D, h: SLAT, d: L });
  // Backrest plank, 0.28 m deep, hung at the rear of the seat: front is +X, so
  // the back of the bench is the -X side.
  addBox(items, wood, { x: -(D / 2 - SLAT / 2), y: BACK - metres(0.28), w: SLAT, h: metres(0.28), d: L });
  return mergeStatic(items);
}

/**
 * Litter bin, 50 triangles. 0.9 m tall and 0.45 m across is the 120 litre
 * street bin; ten sides read as round from any distance a bin is legible at,
 * and the body's top cap is dropped because the lid covers it.
 */
export function bin(opts = {}) {
  const { dim = NIGHT } = opts;
  const body = surface('metalPanel', dim);
  const lid = surface('slate', dim);
  const items = [];

  const H = metres(0.90);        // 0.90 m overall, kerbside bin height
  const D = metres(0.45);        // 0.45 m body diameter, roughly 120 litres
  const LID_D = metres(0.50);    // 0.50 m lid, a 25 mm overhang all round
  const LID_H = metres(0.07);

  addPrism(items, body, 10, false, { w: D, h: H - LID_H, d: D });
  addPrism(items, lid, 10, true, { y: H - LID_H, w: LID_D, h: LID_H, d: LID_D });
  return mergeStatic(items);
}

/**
 * Bike rack, 120 triangles: five inverted-U hoops 0.75 m tall spread over 3 m.
 * The hoops are on 0.75 m centres, which is the spacing that lets two bikes
 * share a hoop without their handlebars fouling the next. The tube is 48 mm,
 * the outside diameter of the schedule-40 pipe these are actually welded from.
 * This is the most expensive prop in the file and it is right at the ceiling:
 * adding a bend radius at the two corners would double it for nothing.
 */
export function bikerack(opts = {}) {
  const { dim = NIGHT, hoops = 5, span = 3.0 } = opts;
  const steel = surface('metalPanel', dim);
  const items = [];

  const H = metres(0.75);        // 0.75 m hoop height, the standard staple rack
  const W = metres(0.60);        // 0.60 m clear width between the legs
  const T = metres(0.048) / 2;   // 48 mm tube, halved for the sweep

  const path = [[-W / 2, 0], [-W / 2, H], [W / 2, H], [W / 2, 0]];
  const step = hoops > 1 ? metres(span) / (hoops - 1) : 0;
  for (let i = 0; i < hoops; i++) {
    // A single hoop sits on the origin. Starting the run at minus half the span
    // is right for two or more, and for one it would push the only hoop a metre
    // and a half off its own placement, which is the sort of thing that looks
    // like a bad position in the data rather than a bug in the mesh.
    const z = hoops > 1 ? -metres(span) / 2 + i * step : 0;
    place(items, sweepXY(path, T, T, z), steel, {});
  }
  return mergeStatic(items);
}

/**
 * Fire hydrant, 80 triangles. 0.75 m to the top of the bonnet is the exposed
 * height of a dry-barrel hydrant; the barrel is 0.18 m across and the two
 * 0.14 m side nozzles are kept even though they are small, because they are the
 * silhouette everyone recognises a hydrant by.
 */
export function hydrant(opts = {}) {
  const { dim = NIGHT } = opts;
  const paint = surface('terracotta', dim);
  const items = [];

  const TOP = metres(0.75);      // 0.75 m above the ground line
  const BARREL = metres(0.18);   // 0.18 m barrel
  const FLANGE_Y = metres(0.50); // the bonnet flange sits at 0.50 m
  const FLANGE_H = metres(0.05);

  addPrism(items, paint, 8, false, { w: BARREL, h: FLANGE_Y, d: BARREL });
  addPrism(items, paint, 8, true, { y: FLANGE_Y, w: metres(0.26), h: FLANGE_H, d: metres(0.26) });
  addSpire(items, paint, 8, { y: FLANGE_Y + FLANGE_H, w: metres(0.22), h: TOP - FLANGE_Y - FLANGE_H, d: metres(0.22) });
  // Nozzles: boxes rather than short cylinders, because a cylinder laid on its
  // side would need a tilt about X and mergeStatic carries yaw only.
  for (const s of [-1, 1]) {
    addBox(items, paint, { y: metres(0.38), z: s * metres(0.13), w: metres(0.14), h: metres(0.14), d: metres(0.08) });
  }
  return mergeStatic(items);
}

/**
 * Bollard, 40 triangles. 0.90 m tall and 0.15 m across matches the removable
 * steel bollard used across this campus: a 114 mm pipe inside a decorative
 * sleeve. Ten sides plus a domed cap; the dome is a spire with almost no rise,
 * which is cheaper than a hemisphere and identical at this size.
 */
export function bollard(opts = {}) {
  const { dim = NIGHT, height = 0.9 } = opts;
  const iron = surface('metalPanel', dim);
  const items = [];

  const H = metres(height);      // 0.90 m, the height that stops a vehicle
  const D = metres(0.15);        // 0.15 m across the sleeve
  const CAP = metres(0.05);      // 50 mm domed head

  addPrism(items, iron, 10, false, { w: D, h: H - CAP, d: D });
  addSpire(items, iron, 10, { y: H - CAP, w: D, h: CAP, d: D });
  return mergeStatic(items);
}

/**
 * Picnic table, 52 triangles. The 6 ft (1.83 m) table with attached benches is
 * the one on every quad: top at 0.75 m, benches at 0.45 m and 0.60 m either
 * side of the centre line, 1.5 m across overall.
 *
 * The legs are trestles rather than the splayed A-frames of the real thing,
 * because a splayed leg needs a tilt about Z that the instance transform cannot
 * express, and baking the splay into custom geometry would cost more triangles
 * than the tables are worth.
 */
export function picnic(opts = {}) {
  const { dim = NIGHT } = opts;
  const wood = surface('clapboard', dim);
  const items = [];

  const L = metres(1.83);        // 1.83 m long, the 6 ft table
  const TOP_H = metres(0.75);    // 0.75 m to the table top
  const TOP_W = metres(0.75);    // 0.75 m wide top
  const SEAT_H = metres(0.45);   // 0.45 m to the bench seats
  const SEAT_W = metres(0.30);   // 0.30 m wide seats
  const SEAT_OFF = metres(0.60); // seat centres 0.60 m from the table centre
  const SLAB = metres(0.05);     // 50 mm boards
  const LEG = metres(0.06);

  addBox(items, wood, { y: TOP_H - SLAB, w: TOP_W, h: SLAB, d: L });
  for (const s of [-1, 1]) {
    addBox(items, wood, { x: s * SEAT_OFF, y: SEAT_H - SLAB, w: SEAT_W, h: SLAB, d: L });
    addPost(items, wood, { z: s * (L / 2 - metres(0.25)), w: SEAT_OFF * 2 + SEAT_W, h: TOP_H - SLAB, d: LEG });
  }
  return mergeStatic(items);
}

/**
 * Flagpole, 32 triangles. Nine metres is the tallest pole that goes up without
 * a foundation engineer, and the 1.8 m by 1.2 m flag is the 4 by 6 ft cloth
 * that suits it — flags are sized at roughly a fifth of the pole.
 *
 * The cloth is a thin box rather than a single quad because a quad has one
 * front face and the renderer culls back faces, so half the orbit would show
 * nothing at all. It is plain pale cloth: there is no texture path in this
 * renderer, and a flag painted in vertex colour at this size would be three
 * coloured pixels arguing with each other.
 */
export function flag(opts = {}) {
  const { dim = NIGHT, height = 9.0 } = opts;
  const pole = surface('whiteTrim', dim);
  const cloth = surface('whiteTrim', dim, 0.05);
  const items = [];

  const H = metres(height);      // 9.00 m pole
  const D = metres(0.12);        // 0.12 m butt diameter
  const FLY = metres(1.80);      // 1.80 m along the fly
  const HOIST = metres(1.20);    // 1.20 m deep at the hoist
  const HEAD = metres(0.40);     // the halyard truck keeps the flag 0.40 m down

  addPrism(items, pole, 6, false, { w: D, h: H, d: D });
  // The finial is centred on its own origin, unlike everything else here, so
  // its y is the centre of the ball and not its base.
  addOcta(items, pole, { y: H + metres(0.08), w: metres(0.16), h: metres(0.16), d: metres(0.16) });
  addBox(items, cloth, { y: H - HEAD - HOIST, z: D / 2 + FLY / 2, w: metres(0.01), h: HOIST, d: FLY });
  return mergeStatic(items);
}

/**
 * Park shelter, 50 triangles: a 4 m square open pavilion on four posts, eaves
 * at 2.4 m and a hipped roof rising 0.9 m, which is the 1-in-4 pitch these are
 * framed at. The roof deck is a separate slab so that the shelter still reads
 * as roofed from a low camera — the hip faces are one-sided and the underside
 * of a hip is culled away.
 */
export function shelter(opts = {}) {
  const { dim = NIGHT, size = 4.0 } = opts;
  const postMat = surface('clapboard', dim);
  const roof = surface('standingSeam', dim);
  const items = [];

  const S = metres(size);        // 4.00 m square
  const EAVE = metres(2.40);     // 2.40 m headroom under the eaves
  const RISE = metres(0.90);     // 0.90 m rise, a 1-in-4 pitch
  const POST = metres(0.15);     // 150 mm timber posts
  const DECK = metres(0.10);
  const OVER = metres(0.20);     // 0.20 m eaves overhang

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addPost(items, postMat, { x: sx * (S / 2 - POST), z: sz * (S / 2 - POST), w: POST, h: EAVE, d: POST });
    }
  }
  addBox(items, roof, { y: EAVE, w: S + OVER * 2, h: DECK, d: S + OVER * 2 });
  const half = S / 2 + OVER;
  const ring = [[-half, -half], [half, -half], [half, half], [-half, half]];
  place(items, hipRoofGeometry(ring, EAVE + DECK, [[-half, 0], [half, 0]], RISE), roof, {});
  return mergeStatic(items);
}

/**
 * Bus shelter, 76 triangles. 4 m by 1.5 m with a 2.4 m roof is the standard
 * three-bay transit shelter; the glazing stops 0.3 m short of the ground so the
 * sweepings blow through, and the roof is translucent, which is why it carries
 * a small emissive rather than sitting as a black lid over the lit interior.
 */
export function busstop(opts = {}) {
  const { dim = NIGHT, length = 4.0 } = opts;
  const glassMat = surface('glass', dim, 0.12);
  const frame = surface('metalPanel', dim);
  const roof = surface('glass', dim, 0.18);
  const items = [];

  const L = metres(length);      // 4.00 m along the kerb
  const D = metres(1.50);        // 1.50 m deep, the minimum for a seated queue
  const H = metres(2.40);        // 2.40 m to the underside of the roof
  const SILL = metres(0.30);     // glazing starts 0.30 m up
  const GLASS = metres(0.02);
  const SEAT = metres(0.45);     // perch seat at the usual 0.45 m
  const POST = metres(0.08);

  // Back wall on the -X side, since the opening faces +X.
  addBox(items, glassMat, { x: -(D / 2 - GLASS / 2), y: SILL, w: GLASS, h: H - SILL, d: L });
  for (const s of [-1, 1]) {
    addBox(items, glassMat, { z: s * (L / 2 - GLASS / 2), y: SILL, w: D, h: H - SILL, d: GLASS });
    addPost(items, frame, { x: D / 2 - POST / 2, z: s * (L / 2 - POST / 2), w: POST, h: H, d: POST });
  }
  addBox(items, frame, { x: -(D / 2 - metres(0.18)), y: SEAT - metres(0.05), w: metres(0.36), h: metres(0.05), d: L - metres(0.6) });
  addBox(items, roof, { y: H, w: D + metres(0.2), h: metres(0.08), d: L + metres(0.2) });
  return mergeStatic(items);
}

/**
 * Public artwork, 28 triangles: a granite plinth 1.2 m square and 0.6 m tall
 * carrying an abstract bronze mass about 1.8 m across.
 *
 * Deliberately abstract. Every campus has sculpture and none of it looks like
 * any other, so a specific figure would be wrong everywhere; two crossed
 * octahedra read as "a thing on a plinth" at the distance these are seen from,
 * and a named piece belongs in the monument crowns, not here.
 */
export function artwork(opts = {}) {
  const { dim = NIGHT } = opts;
  const stone = surface('granite', dim);
  const metal = surface('bronzePatina', dim);
  const items = [];

  const PLINTH = metres(1.20);   // 1.20 m square plinth
  const PLINTH_H = metres(0.60); // 0.60 m tall, about seat height
  const MASS = metres(1.80);     // 1.80 m across the bronze

  addBox(items, stone, { w: PLINTH, h: PLINTH_H, d: PLINTH });
  // Octahedra are centred on their own origin, so these y values are centres.
  addOcta(items, metal, { y: PLINTH_H + MASS * 0.42, w: MASS, h: MASS * 0.9, d: MASS * 0.6 });
  addOcta(items, metal, { y: PLINTH_H + MASS * 0.78, w: MASS * 0.5, h: MASS * 0.6, d: MASS * 0.5, ry: Math.PI / 4 });
  return mergeStatic(items);
}

/**
 * Collection box, 40 triangles. The blue USPS box is 0.66 m wide and 0.47 m
 * deep, and its body sits 0.35 m up on two legs for a total of about 1.35 m —
 * the height a hand reaches from a car window.
 */
export function postbox(opts = {}) {
  const { dim = NIGHT } = opts;
  const paint = surface('metalPanel', dim);
  const items = [];

  const W = metres(0.66);        // 0.66 m across the front
  const D = metres(0.47);        // 0.47 m deep
  const LEG = metres(0.35);      // body starts 0.35 m up
  const BODY = metres(0.72);     // 0.72 m of body, 1.35 m to the top of the hood
  const HOOD = metres(0.28);

  for (const s of [-1, 1]) {
    addPost(items, paint, { z: s * (W / 2 - metres(0.09)), w: metres(0.10), h: LEG, d: metres(0.10) });
  }
  addBox(items, paint, { y: LEG, w: D, h: BODY, d: W });
  // The hood of a real box is a quarter cylinder; a shallower box loses nothing
  // at this size and keeps the whole prop under a dozen quads.
  addBox(items, paint, { x: metres(0.03), y: LEG + BODY, w: D * 0.88, h: HOOD, d: W * 0.94 });
  return mergeStatic(items);
}

/**
 * Wayfinding sign, 20 triangles. A 0.9 m by 0.6 m panel with its top at 2.3 m
 * clears a walking head by the 2.1 m the accessibility guidance asks for. This
 * is the cheapest prop in the file and intentionally so: signs outnumber every
 * other kind on a campus by a wide margin.
 */
export function sign(opts = {}) {
  const { dim = NIGHT } = opts;
  const postMat = surface('metalPanel', dim);
  const panel = surface('whiteTrim', dim, 0.06);
  const items = [];

  // The underside of the panel is what has to clear a walker, so the post and the
  // panel top are both sized from it: 2.10 m of headroom is the figure signage
  // guidance uses, and a 0.60 m panel above it puts the top at 2.70 m.
  const H = metres(2.80);        // 2.80 m post
  const PW = metres(0.90);       // 0.90 m panel width
  const PH = metres(0.60);       // 0.60 m panel height
  const TOP = metres(2.70);      // panel top at 2.70 m, underside at 2.10 m
  const POST = metres(0.10);

  addPost(items, postMat, { w: POST, h: H, d: POST });
  addBox(items, panel, { x: metres(0.03), y: TOP - PH, w: metres(0.05), h: PH, d: PW });
  return mergeStatic(items);
}

/**
 * Planter, 40 triangles. 1.2 m across and 0.6 m tall is the precast octagon
 * that gets used as much for stopping vehicles as for growing anything, which
 * is why it is squat and wide rather than tall.
 */
export function planter(opts = {}) {
  const { dim = NIGHT } = opts;
  const shell = surface('precast', dim);
  const soil = surface('lawn', dim * 0.6);
  const green = surface('canopy', dim);
  const items = [];

  const D = metres(1.20);        // 1.20 m across the flats
  const H = metres(0.60);        // 0.60 m tall
  const SOIL = metres(0.52);     // soil surface 80 mm below the rim

  addPrism(items, shell, 8, false, { w: D, h: H, d: D });
  // ringGeometry is unit-RADIUS where the prisms are unit-diameter, so the soil
  // disc scales by the radius and not by the width. The tiny inner radius keeps
  // the fan away from a degenerate centre vertex.
  addRing(items, soil, 0.04, 8, { y: SOIL, w: D * 0.45, d: D * 0.45 });
  addOcta(items, green, { y: SOIL + metres(0.22), w: D * 0.8, h: metres(0.5), d: D * 0.8 });
  return mergeStatic(items);
}

/**
 * Drinking fountain, 28 triangles. The accessible bowl rim is 0.86 m, so 0.90 m
 * overall with the bubbler on top; the pedestal is 0.35 m by 0.30 m, the size of
 * the cast base these are bolted to.
 */
export function drinkfountain(opts = {}) {
  const { dim = NIGHT } = opts;
  const body = surface('precast', dim);
  const metal = surface('metalPanel', dim);
  const items = [];

  const RIM = metres(0.86);      // 0.86 m rim, the accessible maximum
  const PW = metres(0.30);       // 0.30 m pedestal, front to back
  const PD = metres(0.35);       // 0.35 m across
  const BOWL = metres(0.12);

  addPost(items, body, { w: PW, h: RIM - BOWL, d: PD });
  addBox(items, body, { y: RIM - BOWL, w: PW * 1.35, h: BOWL, d: PD * 1.2 });
  addPost(items, metal, { x: -metres(0.08), y: RIM, w: metres(0.06), h: metres(0.10), d: metres(0.06) });
  return mergeStatic(items);
}

/**
 * Playground, 84 triangles: a swing set, because that is the piece of play
 * equipment whose silhouette survives being 30 m away. The top bar is at 2.4 m
 * over a 3.5 m span, the seats hang at 0.45 m, and the legs stand 1.4 m apart
 * at the base — vertical rather than splayed, for the same reason the picnic
 * table has trestles.
 */
export function playground(opts = {}) {
  const { dim = NIGHT } = opts;
  const frame = surface('metalPanel', dim);
  const seat = surface('clapboard', dim);
  const items = [];

  const BAR = metres(2.40);      // 2.40 m to the top bar
  const SPAN = metres(3.50);     // 3.50 m between the end frames
  const FOOT = metres(1.40);     // legs 1.40 m apart front to back
  const SEAT_H = metres(0.45);   // seats at 0.45 m, a child's sitting height
  const LEG = metres(0.09);

  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      addPost(items, frame, { x: sx * FOOT / 2, z: sz * SPAN / 2, w: LEG, h: BAR, d: LEG });
    }
  }
  addBox(items, frame, { y: BAR - metres(0.09), w: metres(0.09), h: metres(0.09), d: SPAN + metres(0.2) });
  for (const sz of [-1, 1]) {
    addPost(items, frame, { z: sz * metres(0.7), y: SEAT_H, w: metres(0.03), h: BAR - metres(0.09) - SEAT_H, d: metres(0.03) });
    addBox(items, seat, { z: sz * metres(0.7), y: SEAT_H, w: metres(0.20), h: metres(0.04), d: metres(0.44) });
  }
  return mergeStatic(items);
}

/* ------------------------------------------------------------------ *
 * Tall landmarks — furniture in everything but height
 * ------------------------------------------------------------------ */

/**
 * Water tower, 92 triangles. An 11 m by 9 m tank on legs, 38 m to the top: the
 * multi-column tank that stands over most midwestern campuses, sized from the
 * usual half-million-gallon capacity. It is in this file rather than in the
 * monument crowns because there is nothing landmark-specific about it — the
 * lettering is what distinguishes one from another and the lettering is a
 * texture this renderer does not have.
 */
export function watertower(opts = {}) {
  const { dim = NIGHT } = opts;
  const steel = surface('metalPanel', dim);
  const items = [];

  const TOP = metres(38.0);      // 38 m overall
  const TANK_D = metres(11.0);   // 11 m tank diameter
  const TANK_H = metres(9.0);    // 9 m of cylindrical shell
  const CONE = metres(2.5);      // 2.5 m conical bottom
  const DOME = metres(2.5);      // 2.5 m domed top
  const LEG = metres(0.40);      // 0.40 m columns
  const tankBase = TOP - DOME - TANK_H;

  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    addPost(items, steel, {
      x: Math.cos(a) * TANK_D * 0.34, z: Math.sin(a) * TANK_D * 0.34,
      h: tankBase, w: LEG, d: LEG,
    });
  }
  // coneGeometry has its apex at y = 0 and its base at y = 1, which is already
  // the point-down hopper this needs; no flip.
  addCone(items, steel, 12, { y: tankBase - CONE, w: TANK_D, h: CONE, d: TANK_D });
  addPrism(items, steel, 12, false, { y: tankBase, w: TANK_D, h: TANK_H, d: TANK_D });
  addSpire(items, steel, 12, { y: tankBase + TANK_H, w: TANK_D, h: DOME, d: TANK_D });
  return mergeStatic(items);
}

/**
 * Boiler-house chimney, 40 triangles. 24 m of brick stack, 2.4 m across: the
 * old heating-plant flue, not a domestic pot. The top is left open — a prism
 * with no cap and a ring for the wall thickness — because a capped stack reads
 * as a pillar, and the dark hole is most of what says "chimney" from the air.
 */
export function chimney(opts = {}) {
  const { dim = NIGHT, height = 24.0 } = opts;
  const brickMat = surface('brick', dim);
  const capMat = surface('concreteGrey', dim);
  const items = [];

  const H = metres(height);      // 24 m stack
  const D = metres(2.40);        // 2.40 m outer diameter
  const WALL = metres(0.30);     // 0.30 m of brickwork at the rim

  addPrism(items, brickMat, 10, false, { w: D, h: H, d: D });
  addRing(items, capMat, (D / 2 - WALL) / (D / 2), 10, { y: H, w: D / 2, d: D / 2 });
  return mergeStatic(items);
}

/**
 * Floodlight mast, 48 triangles. 25 m is the mast height that lights a practice
 * field without lighting the dormitories behind it, and the head carries two
 * banks rather than the real four, since the far pair is hidden behind the near
 * pair from every angle the camera can reach.
 */
export function mast(opts = {}) {
  const { dim = NIGHT, height = 25.0 } = opts;
  const pole = surface('concreteGrey', dim);
  const lamp = surface('whiteTrim', dim, 1.4);
  const items = [];

  const H = metres(height);      // 25 m mast
  const D = metres(0.35);        // 0.35 m at the base
  const HEAD_W = metres(2.40);   // 2.40 m head frame
  const BANK = metres(0.90);

  addPrism(items, pole, 6, false, { w: D, h: H, d: D });
  addBox(items, pole, { y: H, w: metres(0.30), h: metres(0.20), d: HEAD_W });
  for (const s of [-1, 1]) {
    addBox(items, lamp, { x: metres(0.10), y: H - metres(0.30), z: s * metres(0.70), w: metres(0.24), h: metres(0.30), d: BANK });
  }
  return mergeStatic(items);
}

/**
 * Gate, 104 triangles: two 0.6 m stone piers 2.4 m tall with a 3 m opening and
 * a barred leaf 1.8 m high between them.
 *
 * Seven bars over that opening puts them on 0.43 m centres, which is far wider
 * than the 100 mm gap a real guarded balustrade is held to. That is a rendering
 * decision and not a mistake: bars at 100 mm are a third of a pixel apart at any
 * distance a gate is visible from, so they would alias into a grey haze while
 * costing eight times the triangles. Seven bars is the most that still reads as
 * separate bars.
 */
export function gate(opts = {}) {
  const { dim = NIGHT, opening = 3.0 } = opts;
  const stone = surface('limestoneGrey', dim);
  const iron = surface('metalPanel', dim);
  const items = [];

  const PIER = metres(0.60);     // 0.60 m square piers
  const PIER_H = metres(2.40);   // 2.40 m tall
  const OPEN = metres(opening);  // 3.00 m clear opening
  const LEAF = metres(1.80);     // 1.80 m to the top rail
  const RAIL = metres(0.08);
  const BAR = metres(0.04);
  const BARS = 7;

  for (const s of [-1, 1]) {
    addBox(items, stone, { z: s * (OPEN / 2 + PIER / 2), w: PIER, h: PIER_H, d: PIER });
  }
  // Rails run along Z, so their hidden faces are the ends buried in the piers,
  // not the top and bottom: full boxes here, posts for the verticals.
  addBox(items, iron, { y: metres(0.15), w: BAR, h: RAIL, d: OPEN });
  addBox(items, iron, { y: LEAF - RAIL, w: BAR, h: RAIL, d: OPEN });
  for (let i = 0; i < BARS; i++) {
    const z = -OPEN / 2 + (OPEN * (i + 0.5)) / BARS;
    addPost(items, iron, { z, y: metres(0.15), w: BAR, h: LEAF - metres(0.15), d: BAR });
  }
  return mergeStatic(items);
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

export const PROP_BUILDERS = {
  bench, bin, bikerack, hydrant, bollard, picnic, flag,
  shelter, busstop, artwork, postbox, sign, planter, drinkfountain, playground,
  watertower, chimney, mast, gate,
};

/**
 * Builds one prop by name, or null when the name is not one of ours.
 *
 * The own-property check is not defensive noise: PROP_BUILDERS is an object
 * literal and therefore inherits from Object.prototype, so a kind of
 * "constructor" or "toString" coming out of a content pack would otherwise
 * resolve to a function and be called. Own properties only.
 */
export function buildProp(kind, opts = {}) {
  if (!Object.prototype.hasOwnProperty.call(PROP_BUILDERS, kind)) return null;
  return PROP_BUILDERS[kind](opts);
}

/* ------------------------------------------------------------------ *
 * Runs — fences and hedges along a polyline
 * ------------------------------------------------------------------ */

/**
 * Kind → the material, the thickness in metres and the default height in
 * metres. A chain-link fence is given a real thickness rather than a single
 * plane so that it is lit from both sides, and a masonry wall is thick enough
 * for its top to catch light, which is what separates it from a fence at a
 * glance.
 */
const FENCE_KINDS = {
  iron:  { mat: 'metalPanel',    thickness: 0.04, height: 1.20 },
  rail:  { mat: 'whiteTrim',     thickness: 0.06, height: 0.90 },
  wood:  { mat: 'clapboard',     thickness: 0.05, height: 1.10 },
  chain: { mat: 'metalPanel',    thickness: 0.02, height: 1.80 },
  wall:  { mat: 'limestoneGrey', thickness: 0.30, height: 1.00 },
};

/**
 * A short dog-leg in world units — 80 m of fence — so that every export in this
 * file is callable with no arguments, which the repository's winding audit
 * relies on when it walks the module's generators.
 */
const DEFAULT_RUN = [[0, 0], [4, 0], [8, 2]];

/**
 * Stations along an XZ polyline: the world position and the unit left normal,
 * averaged across the corner exactly as ribbonGeometry does it.
 */
function stations(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0], dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    out.push({ x: points[i][0], z: points[i][1], nx: -dz, nz: dx });
  }
  return out;
}

/**
 * A fence, wall or railing as an extruded ribbon along a polyline: two vertical
 * faces and a top, six triangles per segment, with the vertices already in
 * world space the way ribbonGeometry leaves them.
 *
 * There are no posts. Posting a run at 2.5 m centres would roughly triple its
 * triangle count, and a fence line is one of the longest polylines on the map;
 * the post rhythm is better delivered by the material's pattern than by
 * geometry nobody can resolve.
 *
 * The units are mixed on purpose. `points` are world-unit [x, z] pairs, because
 * that is what comes out of the baked JSON and converting a polyline on the way
 * in would only invite a double conversion later. `height` is in metres, like
 * every other dimension a human types in this file, and defaults to whatever
 * the kind is usually built at.
 */
export function fenceRun(points = DEFAULT_RUN, kind = 'iron', height = null, dim = NIGHT) {
  const spec = FENCE_KINDS[kind] || FENCE_KINDS.iron;
  const h = metres(height == null ? spec.height : height);
  const half = metres(spec.thickness) / 2;
  const p = [], n = [], idx = [];
  if (!points || points.length < 2) return mergeStatic([]);

  const st = stations(points);
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    // Face normals come from the segment, not the averaged station normal, so
    // each panel lights as a flat and the corner shows as a crease.
    let ex = b.x - a.x, ez = b.z - a.z;
    // Guard before normalising: baked polylines do repeat a point occasionally,
    // and a "|| 1" fallback would wave the degenerate segment through.
    const l = Math.hypot(ex, ez);
    if (l < 1e-9) continue;
    ex /= l; ez /= l;
    const lx = -ez, lz = ex;
    const A = (s, k) => [s.x + s.nx * half * k, s.z + s.nz * half * k];
    const aL = A(a, 1), aR = A(a, -1), bL = A(b, 1), bR = A(b, -1);
    face(p, n, idx, [[aL[0], 0, aL[1]], [bL[0], 0, bL[1]], [bL[0], h, bL[1]], [aL[0], h, aL[1]]], [lx, 0, lz]);
    face(p, n, idx, [[aR[0], 0, aR[1]], [bR[0], 0, bR[1]], [bR[0], h, bR[1]], [aR[0], h, aR[1]]], [-lx, 0, -lz]);
    face(p, n, idx, [[aL[0], h, aL[1]], [bL[0], h, bL[1]], [bR[0], h, bR[1]], [aR[0], h, aR[1]]], [0, 1, 0]);
  }
  return mergeStatic([{ geo: finish(p, n, idx), ...surface(spec.mat, dim) }]);
}

/**
 * A clipped hedge along the same kind of polyline. Structurally this is
 * fenceRun with a wider section, but the top edge and the width are pushed
 * about by a hash of the vertex index, and that jitter is the whole point: a
 * hedge with a flat top and parallel sides reads as a painted wall, and no
 * amount of green fixes it. The two sides are jittered independently so the top
 * rolls rather than staying level across the section.
 *
 * The displacement is deterministic in the vertex index, so a hedge bakes the
 * same way in the worker and on the main thread and does not shimmer when a
 * tile is rebuilt.
 *
 * As in fenceRun, `points` are world units while `height` and `width` are
 * metres, and the trailing `dim` is the night dimming every builder here takes.
 */
export function hedgeRun(points = DEFAULT_RUN, height = 1.1, width = 0.7, dim = NIGHT) {
  const h = metres(height);       // 1.10 m, the height a hedge is clipped to
  const half = metres(width) / 2; // 0.70 m through the section, halved to offset
  const p = [], n = [], idx = [];
  if (!points || points.length < 2) return mergeStatic([]);

  const st = stations(points);
  // Roughly a sixth of the height either way: enough to break the line, not so
  // much that the hedge stops being a single clipped mass.
  const JITTER = h * 0.16;
  const top = (i, side) => h - JITTER * 0.5 + JITTER * hash11(i * 2 + side * 37 + 11);
  const wide = (i) => half * (0.86 + 0.28 * hash11(i * 3 + 5));

  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    let ex = b.x - a.x, ez = b.z - a.z;
    const l = Math.hypot(ex, ez);
    if (l < 1e-9) continue;
    ex /= l; ez /= l;
    const lx = -ez, lz = ex;
    const A = (s, j, k) => [s.x + s.nx * wide(j) * k, s.z + s.nz * wide(j) * k];
    const aL = A(a, i, 1), aR = A(a, i, -1), bL = A(b, i + 1, 1), bR = A(b, i + 1, -1);
    const aLy = top(i, 0), aRy = top(i, 1), bLy = top(i + 1, 0), bRy = top(i + 1, 1);
    face(p, n, idx, [[aL[0], 0, aL[1]], [bL[0], 0, bL[1]], [bL[0], bLy, bL[1]], [aL[0], aLy, aL[1]]], [lx, 0, lz]);
    face(p, n, idx, [[aR[0], 0, aR[1]], [bR[0], 0, bR[1]], [bR[0], bRy, bR[1]], [aR[0], aRy, aR[1]]], [-lx, 0, -lz]);
    // The top quad is no longer planar once its four corners are jittered, so
    // the normal is taken from three of them and forced upward; the tilt is a
    // few degrees and the fan stays consistent with it.
    const t0 = [aL[0], aLy, aL[1]], t1 = [bL[0], bLy, bL[1]], t2 = [bR[0], bRy, bR[1]], t3 = [aR[0], aRy, aR[1]];
    let tn = triNormal(t0, t1, t2);
    if (tn[1] < 0) tn = [-tn[0], -tn[1], -tn[2]];
    face(p, n, idx, [t0, t1, t2, t3], tn);
  }
  return mergeStatic([{ geo: finish(p, n, idx), ...surface('canopy', dim) }]);
}
