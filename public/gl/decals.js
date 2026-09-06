/**
 * decals — the paint on the ground.
 *
 * Empty tarmac and empty grass are what make a baked city read as a model
 * rather than a place. This module supplies the missing signal: zebra crossings
 * on the carriageways, bays on the car parks, sport-correct lines on the
 * pitches, kerbs beside the footpaths and drain covers scattered over the
 * asphalt. Every generator returns a flat, +Y-facing mesh in world units,
 * ready to go into `mergeStatic` as a `{ geo, color, mat }` item.
 *
 * The rejected alternative was to paint all of this procedurally in the
 * fragment shader, the way materials.js already paints a dashed centre line
 * from MAT_ASPHALT_LINE. That works for markings which are a pure function of
 * world position, and it fails for everything here: where a car park's bays
 * land depends on the car park's polygon, where a crosswalk sits depends on
 * two kerb points the bake knows and the shader does not, and a pitch's key
 * and three-point arc depend on which end of which rectangle you are standing
 * at. Feeding all of that to the shader means feeding it the polygons, which
 * is just geometry with extra steps. A decal atlas was the other option and is
 * a non-starter: the dashboard's CSP is 'self'-only and the renderer carries no
 * textures at all. Geometry is also simply cheap here — a full pitch is a few
 * hundred triangles that merge into the same static batch as everything else,
 * so the whole ground layer still costs one draw call.
 *
 * This module never touches a WebGL context. It runs on the bake worker thread
 * alongside the rest of glx-geometry, and imports the ribbon generator the
 * roads already use rather than growing a second, subtly different one.
 *
 * Return shape is the plain `{ positions, normals, indices }` triple that every
 * other generator in glx-geometry returns, not the coloured record `mergeStatic`
 * produces. Decals are single-material by nature — a set of stripes is one
 * colour — so the colour and material id belong to the caller's batch item, and
 * keeping the plain triple lets a decal be transformed, instanced or re-tinted
 * like any other piece of campus geometry.
 */

import { ribbonGeometry, polygonGeometry } from './glx-geometry.js';

/* ------------------------------------------------------------------ *
 * Scale and lift
 * ------------------------------------------------------------------ */

/**
 * One metre, in world units. The pack bakes at metersPerUnit = 10, so every
 * regulation figure below can be written as the number the rulebook prints
 * multiplied by M, and the code reads as the rulebook does.
 */
const M = 0.1;

/**
 * Height every decal is laid at, in world units.
 *
 * Decals are coplanar with the surface they sit on, and coplanar geometry
 * z-fights: the depth values interleave from pixel to pixel and the stripe
 * dissolves into a shimmering stipple as the camera moves. Lifting the decal
 * clear of the surface is the fix; the only question is by how much.
 *
 * The floor is not depth precision. It is the ground stack this pack actually
 * bakes, which sits higher than it looks. From `tile-bake.js`: lawns and pitch
 * surfaces at 0.020, car-park pads at 0.025, water at 0.035, rail ballast at
 * 0.036, roads at 0.040, sleepers at 0.046, the dashed lane line at 0.048, and
 * footways at 0.050. A decal has to clear the highest thing it is ever drawn
 * over, and a crosswalk is drawn over a road that already carries a lane line.
 * An earlier value of 0.03 was chosen against a remembered 0.02 and would have
 * buried every crosswalk and every path edging inside its own host surface.
 *
 * Depth precision then says the clearance is enough. Resolution falls off as the
 * square of distance — a 24-bit buffer with a half-unit near plane resolves
 * about 0.005 world units at 200 units out — and 200 units is roughly where a
 * 0.5 m stripe shrinks below a pixel and stops being drawn in any meaningful
 * sense. The 0.007 above the lane line wins out to that range with room to
 * spare, and sizing for the far horizon instead would demand a lift ten times
 * larger and buy nothing, because there is nothing left to look at.
 *
 * The ceiling comes from the grazing camera. Vertical exaggeration is 2.6, so
 * apparent height in metres is y * metersPerUnit / uVScale: 0.055 reads as about
 * 21 cm of real relief. With the camera 5 degrees above the horizon that offsets
 * a stripe from the tarmac by about two metres at the very edge of the frame,
 * which is within the camber and crown a real carriageway has and reads as paint
 * on a curved road rather than as a card hovering over one. Doubling it again
 * would make it read as the card.
 */
export const DECAL_LIFT = 0.055;

/* ------------------------------------------------------------------ *
 * Paint widths and fixed dimensions
 * ------------------------------------------------------------------ */

/**
 * All pitch markings are painted at 100 mm, the maximum IFAB allows for a
 * soccer touchline. Basketball and tennis are marked at 50 mm in the rulebooks,
 * but 50 mm is 0.005 world units — narrower than a pixel from any camera height
 * this scene allows — so a rulebook-accurate line would alias itself away and
 * the courts would look unmarked. Painting every sport at the soccer width is
 * the smaller lie.
 */
const LINE_W = 0.1 * M;

const STALL_LINE_W = 0.1 * M;   // 100 mm, the usual thermoplastic bay line
const STRIPE_W = 0.5 * M;       // zebra bar, 500 mm
const STRIPE_GAP = 0.5 * M;     // gap between bars, 500 mm; pitch is therefore 1 m
const AISLE_W = 6.0 * M;        // 6 m two-way drive aisle between opposing rows
const KERB_W = 0.15 * M;        // 150 mm kerb band each side of a footpath
const COVER_R = 0.3 * M;        // 600 mm manhole cover, so a 300 mm radius

/**
 * Chord tolerance for arcs, in world units: 0.01 is 10 cm on the ground. This
 * is what sets the segment count instead of a fixed 64, because a fixed count
 * is wrong at both ends — wasteful on a 1.8 m free-throw circle and coarse on a
 * 36.5 m track bend. At this tolerance a 6.75 m three-point arc resolves at 19
 * segments for a full turn and a 9.15 m centre circle at 22, which is the point
 * where the polygon stops being visible against the paint width.
 */
const ARC_TOL = 0.01;

/**
 * The running track gets its own, coarser tolerance. Nine 400 m lane lines at
 * the 10 cm tolerance cost about 830 triangles, over the 600-triangle budget a
 * pitch decal set is allowed. At 30 cm the same nine ovals cost about 540. A
 * 30 cm chord error on a 36.5 m radius is under one per cent of the radius and
 * is invisible well before the track itself is.
 */
const TRACK_ARC_TOL = 0.03;

/** Guard rails on the two generators whose output scales with the input polygon. */
const MAX_STALL_LINES = 600;
const MAX_COVERS = 64;

const TAU = Math.PI * 2;

/** Default footprints, so every export is callable with no arguments at all. */
const DEFAULT_LOT = [[0, 0], [4, 0], [4, 3], [0, 3]];              // a 40 m x 30 m car park
const DEFAULT_PITCH = [[0, 0], [10.5, 0], [10.5, 6.8], [0, 6.8]];  // a 105 m x 68 m pitch
const DEFAULT_PATH = [[0, 0], [1, 0], [2, 0.4]];                   // a 24 m footpath with one bend

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

function empty() {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(0),
  };
}

/**
 * Concatenates plain geometry triples into one mesh.
 *
 * This is deliberately not `mergeStatic`: that bakes a colour, a material id
 * and a transform per vertex and hands back a different record shape. A decal
 * set is one colour, so all we want is the index rebasing.
 *
 * The per-vertex `extras` that `ribbonGeometry` emits are dropped on the way
 * through. They describe a road — signed distance across the carriageway and
 * distance along it — and carrying them into a 0.5 m zebra bar would tell
 * MAT_ASPHALT_LINE to paint a dashed yellow centre line down the middle of
 * every stripe.
 */
function weld(parts) {
  let vc = 0, ic = 0;
  for (const g of parts) { vc += g.positions.length / 3; ic += g.indices.length; }
  if (!vc) return empty();

  const positions = new Float32Array(vc * 3);
  const normals = new Float32Array(vc * 3);
  const indices = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of parts) {
    positions.set(g.positions, vo * 3);
    normals.set(g.normals, vo * 3);
    for (let i = 0; i < g.indices.length; i++) indices[io + i] = g.indices[i] + vo;
    vo += g.positions.length / 3;
    io += g.indices.length;
  }
  return { positions, normals, indices };
}

/** A painted line along an open polyline, at the decal height. */
function stroke(points, width = LINE_W) {
  if (!points || points.length < 2) return empty();
  return ribbonGeometry(points, width, DECAL_LIFT);
}

/**
 * A painted line around a closed ring.
 *
 * `ribbonGeometry` mitres a joint from the average of the incoming and outgoing
 * tangents, which it can only do at interior vertices, so a ring passed as-is
 * would come out with a square butt end at the seam. Wrapping one vertex either
 * side turns the seam into an interior vertex; the price is one duplicated
 * segment of identical white paint, two triangles, which nothing can see.
 */
function strokeLoop(ring, width = LINE_W) {
  if (!ring || ring.length < 3) return stroke(ring, width);
  const n = ring.length;
  return stroke([ring[n - 1], ...ring, ring[0]], width);
}

/**
 * Segment count for an arc of the given radius and sweep.
 *
 * The chord of an arc subtending 2*pi/n on a circle of radius r misses the true
 * curve by a sagitta of r * (1 - cos(pi/n)). Setting that equal to the
 * tolerance and solving for n gives the count a full turn needs; an arc takes
 * its proportional share. Clamped to [8, 48]: below 8 a circle stops being a
 * circle whatever the radius says, and above 48 the extra vertices are spent on
 * curvature no camera in this scene can resolve.
 */
function arcSegments(radius, sweep = TAU, tol = ARC_TOL) {
  const r = Math.max(Math.abs(radius), 1e-6);
  const ratio = Math.min(Math.max(1 - tol / r, -1), 1);
  const full = Math.min(Math.max(Math.PI / Math.acos(ratio), 8), 48);
  return Math.max(1, Math.round((full * Math.abs(sweep)) / TAU));
}

/** Points along an arc, angle measured from +x toward +z. */
function arcPoints(cx, cz, r, a0, a1, segs) {
  const out = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + ((a1 - a0) * i) / segs;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/** A filled circle at the decal height — spots, manhole covers. */
function disc(cx, cz, r, tol = ARC_TOL) {
  const n = arcSegments(r, TAU, tol);
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    ring.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  // Increasing angle in (x, z) is the repository's counter-clockwise sense, and
  // polygonGeometry already reverses it so the +Y face is the front face.
  return polygonGeometry(ring, DECAL_LIFT);
}

/** Ray-cast containment test, used to clip generated paint to a real polygon. */
function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Offsets an open polyline sideways by `d`, on the same side `ribbonGeometry`
 * calls left, so a caller asking for a kerb on the left gets one there.
 *
 * The offset vertex is pushed along the bisector and lengthened by
 * 1/cos(half-turn), which is what keeps the offset line a constant distance
 * from the path through a bend rather than pinching in at every corner. The
 * clamp at 0.35 bounds that lengthening: past a 139 degree turn the miter runs
 * away toward infinity, and a blunt corner is a far better artefact than a
 * spike shooting across the campus.
 */
function offsetPolyline(points, d) {
  const n = points.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[i];
    const c = points[Math.min(n - 1, i + 1)];
    let e0x = b[0] - a[0], e0z = b[1] - a[1];
    let e1x = c[0] - b[0], e1z = c[1] - b[1];
    const l0 = Math.hypot(e0x, e0z), l1 = Math.hypot(e1x, e1z);
    // At the two ends one of the edges is degenerate; reuse the other so the
    // bisector collapses to the single edge normal.
    if (l0 < 1e-9) { e0x = e1x; e0z = e1z; } else { e0x /= l0; e0z /= l0; }
    if (l1 < 1e-9) { e1x = e0x; e1z = e0z; } else { e1x /= l1; e1z /= l1; }
    const n0x = -e0z, n0z = e0x;
    const n1x = -e1z, n1z = e1x;
    let mx = n0x + n1x, mz = n0z + n1z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = n1x; mz = n1z; } else { mx /= ml; mz /= ml; }
    const cosHalf = Math.max(0.35, mx * n1x + mz * n1z);
    out.push([b[0] + (mx * d) / cosHalf, b[1] + (mz * d) / cosHalf]);
  }
  return out;
}

/**
 * Smallest useful oriented frame for a pitch polygon: the long axis is taken
 * from the ring's longest edge, and the extents are measured in that frame.
 *
 * A pitch is a rectangle in the world but never quite a rectangle in the bake —
 * traced footprints are a degree or two off square and a few centimetres out on
 * every side. Taking the longest edge as the axis recovers the intended
 * orientation from that noise far more reliably than a principal-axis fit,
 * which a single stray vertex can swing.
 */
function orientedBox(ring) {
  let bx = 1, bz = 0, best = -1;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [cx, cz] = ring[(i + 1) % ring.length];
    const ex = cx - ax, ez = cz - az;
    const len = Math.hypot(ex, ez);
    if (len > best) { best = len; bx = ex / len; bz = ez / len; }
  }
  let px = -bz, pz = bx;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, z] of ring) {
    const u = x * bx + z * bz, v = x * px + z * pz;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  const cx = cu * bx + cv * px, cz = cu * bz + cv * pz;
  let halfU = (maxU - minU) / 2, halfV = (maxV - minV) / 2;

  // The longest edge can be the short side of the rectangle on a ring whose
  // long sides were split into several segments by the tracer. Rotating the
  // frame a quarter turn fixes that; taking p as the new axis and -b as the new
  // cross axis keeps the frame's handedness, so ring winding is preserved.
  if (halfV > halfU) {
    const nbx = px, nbz = pz;
    px = -bx; pz = -bz;
    bx = nbx; bz = nbz;
    const t = halfU; halfU = halfV; halfV = t;
  }
  return {
    halfU,
    halfV,
    at: (u, v) => [cx + bx * u + px * v, cz + bz * u + pz * v],
  };
}

/* ------------------------------------------------------------------ *
 * Crossings
 * ------------------------------------------------------------------ */

/**
 * Zebra bars across a carriageway. `a` and `b` are the two kerb ends of the
 * crossing, so each bar runs the full width of the road from a to b, and the
 * bars repeat at right angles to that. `width` is how much of the road's length
 * the crossing band occupies and `stripes` how many bars to paint.
 *
 * Bar pitch is fixed at 1 m (a 500 mm bar and a 500 mm gap) because that is
 * what the marking is; `width` therefore only decides how many bars fit and
 * where the band is centred, and an explicit `stripes` overrides it. Painting
 * the bars to fill an arbitrary width instead would give crossings with
 * 300 mm bars on narrow roads and metre-wide bars on wide ones, and the eye
 * reads that spacing as wrongly-scaled before it reads anything else.
 */
export function crosswalkDecal(a = [-0.4, 0], b = [0.4, 0], width = 0.4, stripes = 0) {
  let dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return empty();
  dx /= len; dz /= len;

  const pitch = STRIPE_W + STRIPE_GAP;
  // A band of `width` holds n bars when n bars and n-1 gaps fit inside it.
  const count = stripes > 0
    ? Math.floor(stripes)
    : Math.max(1, Math.floor((Math.abs(width) + STRIPE_GAP) / pitch));

  // Across-road direction: the left normal of a -> b in the XZ plane.
  const px = -dz, pz = dx;
  const parts = [];
  for (let i = 0; i < count; i++) {
    // Centred on the midpoint of the band, so a crossing stays put when the
    // caller adds or removes a bar.
    const t = (i - (count - 1) / 2) * pitch;
    parts.push(stroke([
      [a[0] + px * t, a[1] + pz * t],
      [b[0] + px * t, b[1] + pz * t],
    ], STRIPE_W));
  }
  return weld(parts);
}

/* ------------------------------------------------------------------ *
 * Car parks
 * ------------------------------------------------------------------ */

/**
 * Bay lines over a car-park polygon. `angle` is the bearing the rows run at,
 * `stallW` and `stallL` the bay size — 2.6 m by 5.4 m by default, the standard
 * perpendicular bay.
 *
 * Rows are laid out in double-loaded bands: a row of bays, a 6 m two-way aisle,
 * a second row facing it, then the next band starts immediately, so consecutive
 * bands share a back-to-back kerb line with no aisle wasted between them. That
 * is how real lots are set out, and it is also what makes the aisles legible
 * from above — a lot striped edge to edge with no gaps reads as a barcode.
 *
 * Only the dividing lines between bays are painted, not the head line closing
 * the far end of each row. Most lots do not paint one, and at this scale the
 * head line would double the triangle count to add a rectangle the eye already
 * infers from the ends of the dividers.
 *
 * Clipping to the polygon is by endpoint containment rather than true polygon
 * clipping: a divider is painted only if both its ends are inside the ring.
 * Real clipping would cost a segment-polygon intersection per divider to
 * recover the odd half-bay along a skewed boundary, which is exactly the bay
 * that would not be marked out on the ground either.
 */
export function parkingStalls(ring = DEFAULT_LOT, angle = 0, stallW = 2.6 * M, stallL = 5.4 * M) {
  if (!ring || ring.length < 3 || stallW <= 0 || stallL <= 0) return empty();

  const ca = Math.cos(angle), sa = Math.sin(angle);
  const toLocal = (x, z) => [x * ca + z * sa, -x * sa + z * ca];
  const toWorld = (u, v) => [u * ca - v * sa, u * sa + v * ca];

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, z] of ring) {
    const [u, v] = toLocal(x, z);
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const period = stallL * 2 + AISLE_W;
  const parts = [];
  let painted = 0;

  for (let band = minV; band < maxV && painted < MAX_STALL_LINES; band += period) {
    const rows = [
      [band, band + stallL],
      [band + stallL + AISLE_W, band + period],
    ];
    for (const [v0, vEnd] of rows) {
      if (v0 >= maxV) continue;
      const v1 = Math.min(vEnd, maxV);
      // A stub of tarmac shorter than half a bay cannot be parked in, so
      // striping it would only draw lines across a verge.
      if (v1 - v0 < stallL * 0.5) continue;

      for (let u = minU; u <= maxU + 1e-9 && painted < MAX_STALL_LINES; u += stallW) {
        const p0 = toWorld(u, v0);
        const p1 = toWorld(u, v1);
        if (!pointInRing(ring, p0[0], p0[1])) continue;
        if (!pointInRing(ring, p1[0], p1[1])) continue;
        parts.push(stroke([p0, p1], STALL_LINE_W));
        painted++;
      }
    }
  }
  return weld(parts);
}

/* ------------------------------------------------------------------ *
 * Pitches
 * ------------------------------------------------------------------ */

/**
 * Sport-correct markings inside a pitch polygon.
 *
 * The regulation layout is inscribed in the polygon's oriented box at a single
 * uniform scale, never stretched to fill it. Baked pitch outlines come from
 * traced imagery and are routinely a few per cent off the regulation aspect
 * ratio; stretching to fit would turn a centre circle into an ellipse and put
 * the three-point arc at a different distance down each sideline, which is the
 * one thing a viewer who knows the sport will notice immediately. Inscribing
 * keeps every circle round and every distance in proportion, and leaves a
 * sliver of unmarked turf along one pair of sides, which is what a pitch mown
 * inside a larger field actually looks like.
 *
 * An unrecognised sport gets the touchline and nothing else — a rectangle
 * inscribed in the polygon — because a wrong marking set is worse than none.
 *
 * The whole of any one set stays under about 600 triangles: soccer costs 122,
 * basketball 132 on a court-shaped polygon, tennis 20, and the eight-lane
 * track — the only expensive one, and the reason the budget is 600 rather than
 * 200 — about 525.
 */
export function pitchMarkings(ring = DEFAULT_PITCH, sport = 'soccer') {
  if (!ring || ring.length < 3) return empty();
  const box = orientedBox(ring);
  const parts = [];

  // Fits the regulation rectangle inside the box and returns a mapper from
  // regulation coordinates (written below as metres times M) into world space.
  const frame = (lengthM, widthM) => {
    const s = Math.min(box.halfU / ((lengthM * M) / 2), box.halfV / ((widthM * M) / 2));
    return {
      s,
      at: (u, v) => box.at(u * s, v * s),
      rect: (halfLen, halfWid) => [
        box.at(-halfLen * s, -halfWid * s),
        box.at(halfLen * s, -halfWid * s),
        box.at(halfLen * s, halfWid * s),
        box.at(-halfLen * s, halfWid * s),
      ],
    };
  };
  const map = (f, pts) => pts.map(([u, v]) => f.at(u, v));

  switch (sport) {
    // OSM tags this pitch sport=soccer; 'football' is accepted because the
    // upstream extract occasionally carries the British tag instead.
    case 'soccer':
    case 'football': {
      // 105 m x 68 m, the FIFA-preferred pitch.
      const f = frame(105, 68);
      const HL = 52.5 * M, HW = 34 * M;
      parts.push(strokeLoop(f.rect(HL, HW)));
      parts.push(stroke(map(f, [[0, -HW], [0, HW]])));

      // Centre circle, 9.15 m radius; centre spot, 220 mm across.
      const R_CENTRE = 9.15 * M;
      parts.push(strokeLoop(map(f, arcPoints(0, 0, R_CENTRE, 0, TAU, arcSegments(R_CENTRE * f.s)).slice(0, -1))));
      const spot = f.at(0, 0);
      parts.push(disc(spot[0], spot[1], 0.11 * M));

      for (const e of [-1, 1]) {
        // Penalty area 40.32 m x 16.5 m, goal area 18.32 m x 5.5 m, penalty
        // mark 11 m from the goal line. Each box is drawn as the three lines
        // that are actually painted; the fourth side is the goal line.
        const pa = 16.5 * M, paHalf = 20.16 * M;
        parts.push(stroke(map(f, [
          [e * HL, -paHalf], [e * (HL - pa), -paHalf], [e * (HL - pa), paHalf], [e * HL, paHalf],
        ])));
        const ga = 5.5 * M, gaHalf = 9.16 * M;
        parts.push(stroke(map(f, [
          [e * HL, -gaHalf], [e * (HL - ga), -gaHalf], [e * (HL - ga), gaHalf], [e * HL, gaHalf],
        ])));

        const mark = e * (HL - 11 * M);
        const p = f.at(mark, 0);
        parts.push(disc(p[0], p[1], 0.11 * M));

        // The "D": the part of a 9.15 m circle about the penalty mark that
        // falls outside the penalty area. The area line is 5.5 m from the mark,
        // so the arc is the sweep either side of acos(5.5 / 9.15).
        const half = Math.acos(5.5 / 9.15);
        const base = e > 0 ? Math.PI : 0;
        parts.push(stroke(map(f, arcPoints(
          mark, 0, R_CENTRE, base - half, base + half, arcSegments(R_CENTRE * f.s, half * 2),
        ))));
      }
      break;
    }

    case 'basketball': {
      // 28 m x 15 m, the FIBA and NCAA court.
      const f = frame(28, 15);
      const HL = 14 * M, HW = 7.5 * M;
      parts.push(strokeLoop(f.rect(HL, HW)));
      parts.push(stroke(map(f, [[0, -HW], [0, HW]])));

      // Centre and free-throw circles are both 1.8 m radius.
      const R_SMALL = 1.8 * M;
      const smallSegs = arcSegments(R_SMALL * f.s);
      parts.push(strokeLoop(map(f, arcPoints(0, 0, R_SMALL, 0, TAU, smallSegs).slice(0, -1))));

      // Three-point line: a 6.75 m arc about the basket, which sits 1.575 m in
      // from the baseline, closed off by straights 0.9 m in from each sideline.
      const R3 = 6.75 * M;
      const CORNER = HW - 0.9 * M;
      const half = Math.asin(CORNER / R3);

      for (const e of [-1, 1]) {
        // The key: 4.9 m wide, free-throw line 5.79 m from the baseline.
        const keyHalf = 2.45 * M, ft = e * (HL - 5.79 * M);
        parts.push(strokeLoop(map(f, [
          [e * HL, -keyHalf], [ft, -keyHalf], [ft, keyHalf], [e * HL, keyHalf],
        ])));
        // Drawn as a full circle. The half behind the free-throw line is dashed
        // in the rulebook, and a dash pattern at 1.8 m radius would be four
        // sub-pixel segments and a lot of extra vertices for nothing.
        parts.push(strokeLoop(map(f, arcPoints(ft, 0, R_SMALL, 0, TAU, smallSegs).slice(0, -1))));

        const cu = e * (HL - 1.575 * M);
        const base = e > 0 ? Math.PI : 0;
        const arc = arcPoints(cu, 0, R3, base - half, base + half, arcSegments(R3 * f.s, half * 2));
        // The arc already lands exactly on +/- CORNER; the tails just run from
        // there back to the baseline.
        const startsPositive = arc[0][1] > 0;
        parts.push(stroke(map(f, [
          [e * HL, startsPositive ? CORNER : -CORNER],
          ...arc,
          [e * HL, startsPositive ? -CORNER : CORNER],
        ])));
      }
      break;
    }

    case 'tennis': {
      // 23.77 m x 10.97 m doubles court.
      const f = frame(23.77, 10.97);
      const HL = 11.885 * M, HW = 5.485 * M;
      const SINGLES = 4.115 * M;   // singles sideline, 8.23 m apart
      const SERVICE = 6.4 * M;     // service line, 6.4 m from the net
      parts.push(strokeLoop(f.rect(HL, HW)));
      for (const e of [-1, 1]) {
        parts.push(stroke(map(f, [[-HL, e * SINGLES], [HL, e * SINGLES]])));
        parts.push(stroke(map(f, [[e * SERVICE, -SINGLES], [e * SERVICE, SINGLES]])));
      }
      // Centre service line, splitting the two service boxes each side.
      parts.push(stroke(map(f, [[-SERVICE, 0], [SERVICE, 0]])));
      // The 100 mm centre marks on the baselines are omitted: at 0.01 world
      // units long they are shorter than the line painting them is wide.
      break;
    }

    case 'track':
    case 'athletics': {
      // A 400 m track: 84.39 m straights and 36.5 m bends, which measured 30 cm
      // out from the kerb give 2 * 84.39 + 2 * pi * 36.8 = 400.00 m. Eight
      // 1.22 m lanes, so nine painted lines.
      const R0 = 36.5 * M, LANE = 1.22 * M, STRAIGHT = 84.39 * M;
      const LANES = 8;
      const outer = R0 + LANES * LANE;
      // The footprint the layout has to fit inside, bend to bend and side to side.
      const f = frame((STRAIGHT + 2 * outer) / M, (2 * outer) / M);
      const hs = STRAIGHT / 2;

      for (let k = 0; k <= LANES; k++) {
        const r = R0 + k * LANE;
        const n = arcSegments(r * f.s, Math.PI, TRACK_ARC_TOL);
        const loop = [[-hs, -r]];
        // Right bend, from (hs, -r) round to (hs, +r).
        loop.push(...arcPoints(hs, 0, r, -Math.PI / 2, Math.PI / 2, n));
        loop.push([-hs, r]);
        // Left bend; the endpoints duplicate the two straight ends already
        // pushed, and a repeated vertex gives ribbonGeometry a zero tangent.
        loop.push(...arcPoints(-hs, 0, r, Math.PI / 2, (3 * Math.PI) / 2, n).slice(1, -1));
        parts.push(strokeLoop(map(f, loop)));
      }
      // Finish line, across all eight lanes at the end of the home straight.
      parts.push(stroke(map(f, [[hs, R0], [hs, outer]])));
      break;
    }

    default: {
      // Unknown sport: the touchline only, taken as the polygon's own oriented
      // rectangle since there is no regulation shape to inscribe.
      parts.push(strokeLoop([
        box.at(-box.halfU, -box.halfV),
        box.at(box.halfU, -box.halfV),
        box.at(box.halfU, box.halfV),
        box.at(-box.halfU, box.halfV),
      ]));
      break;
    }
  }
  return weld(parts);
}

/* ------------------------------------------------------------------ *
 * Footpaths and services
 * ------------------------------------------------------------------ */

/**
 * A pale kerb band down each side of a footpath. `points` is the path centre
 * line and `width` the paved width, so the kerbs sit flush with the path edge
 * and read as the edge itself catching the light rather than as two stripes
 * painted near it.
 *
 * 150 mm is the width of the concrete edging strip laid beside a campus asphalt
 * path. It is deliberately wider than the pitch line width: a kerb is a real
 * object with a real width, and thinning it to a marking line would make the
 * paths look striped instead of edged.
 *
 * The band is generated as a ribbon down an offset copy of the centre line
 * rather than as the outer half of a wider ribbon, because the offset copy
 * carries the path's own mitres through every bend and so the two kerbs stay
 * parallel to the path instead of pinching at corners.
 */
export function pathEdging(points = DEFAULT_PATH, width = 0.25) {
  if (!points || points.length < 2) return empty();
  // Half the paved width less half the kerb, so the kerb's outer edge lands on
  // the path's edge exactly.
  const d = Math.abs(width) / 2 - KERB_W / 2;
  if (d <= 0) return empty();
  return weld([
    stroke(offsetPolyline(points, d), KERB_W),
    stroke(offsetPolyline(points, -d), KERB_W),
  ]);
}

/**
 * Drain covers scattered over an asphalt polygon. `density` is covers per
 * square world unit, which at 10 m to the unit means covers per 100 square
 * metres; the default 0.3 is one per 330 square metres, roughly the gully
 * spacing of a car park drained at 18 m centres.
 *
 * Placement is a hash of a counter seeded from the ring's own vertices, not
 * Math.random. The bake has to be reproducible: a random scatter would move
 * every cover on every reload, which breaks the golden-image comparison the
 * renderer is tested with and makes any visual regression impossible to read.
 * Seeding from the vertices is what keeps two different car parks from getting
 * the same pattern.
 *
 * Rejection sampling inside the bounding box is fine here because car parks are
 * close to convex, so the accept rate is high; the attempt cap stops a pathological
 * L-shaped polygon from spinning.
 */
export function manholes(ring = DEFAULT_LOT, density = 0.3) {
  if (!ring || ring.length < 3 || density <= 0) return empty();

  let twiceArea = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let seed = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % ring.length];
    twiceArea += x0 * z1 - x1 * z0;
    if (x0 < minX) minX = x0;
    if (x0 > maxX) maxX = x0;
    if (z0 < minZ) minZ = z0;
    if (z0 > maxZ) maxZ = z0;
    // Millimetre-rounded coordinates so the seed survives the 3-decimal
    // rounding the baked JSON applies to every point.
    seed = (seed + Math.imul(Math.round(x0 * 1000), 73856093) + Math.imul(Math.round(z0 * 1000), 19349663)) | 0;
  }
  const count = Math.min(Math.round((Math.abs(twiceArea) / 2) * density), MAX_COVERS);
  if (count < 1) return empty();

  const parts = [];
  const limit = count * 40 + 200;
  for (let i = 0, placed = 0; placed < count && i < limit; i++) {
    const x = minX + rand01(seed + i * 2) * (maxX - minX);
    const z = minZ + rand01(seed + i * 2 + 1) * (maxZ - minZ);
    if (!pointInRing(ring, x, z)) continue;
    parts.push(disc(x, z, COVER_R));
    placed++;
  }
  return weld(parts);
}

/**
 * Integer hash to a unit float. Two multiply-xorshift rounds, the standard
 * 32-bit avalanche, so consecutive counters land nowhere near each other —
 * a plain `fract(sin(n))` correlates badly enough at small n to line the first
 * few covers up in a row.
 */
function rand01(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
