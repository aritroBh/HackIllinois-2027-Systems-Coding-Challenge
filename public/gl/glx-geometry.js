/**
 * glx-geometry — pure geometry for the campus renderer.
 *
 * No WebGL here: this module is importable from the bake worker
 * (public/gl/bake-worker.js) as well as the main thread. Every generator
 * returns { positions, normals, indices } (+ optional extras) as typed arrays.
 * The GL plumbing (programs, VAOs, framebuffers, instancing) lives in glx-gl.js;
 * glx.js re-exports both for callers that predate the split.
 */
/* ------------------------------------------------------------------ *
 * mat4 / vec3 — column-major, same memory layout GLSL expects.
 * ------------------------------------------------------------------ */

export const m4 = {
  create: () => new Float32Array(16),

  identity(o = m4.create()) {
    o.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    return o;
  },

  perspective(fovy, aspect, near, far, o = m4.create()) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    o.set([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
    return o;
  },

  lookAt(eye, center, up, o = m4.create()) {
    const z = v3.norm(v3.sub(eye, center));
    const x = v3.norm(v3.cross(up, z));
    const y = v3.cross(z, x);
    o.set([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1,
    ]);
    return o;
  },

  multiply(a, b, o = m4.create()) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  },

  /** Compose translate → rotateY → scale directly; cheaper than three matmuls. */
  trs(tx, ty, tz, ry, sx, sy, sz, o = m4.create()) {
    const c = Math.cos(ry), s = Math.sin(ry);
    o[0] = c * sx;  o[1] = 0;   o[2] = -s * sx; o[3] = 0;
    o[4] = 0;       o[5] = sy;  o[6] = 0;       o[7] = 0;
    o[8] = s * sz;  o[9] = 0;   o[10] = c * sz; o[11] = 0;
    o[12] = tx;     o[13] = ty; o[14] = tz;     o[15] = 1;
    return o;
  },
};

export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** "#22E8FF" → [0.13, 0.91, 1.0]. Accepts 3- and 6-digit hex. */
export function hexRGB(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/* ------------------------------------------------------------------ *
 * Geometry generators — position + normal, indexed.
 * ------------------------------------------------------------------ */

/** Unit box centred on X/Z, sitting on y=0, extending up to y=1. */
export function boxGeometry() {
  const p = [], n = [], idx = [];
  const faces = [
    { nrm: [0, 0, 1], v: [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]] },
    { nrm: [0, 0, -1], v: [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]] },
    { nrm: [1, 0, 0], v: [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]] },
    { nrm: [-1, 0, 0], v: [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]] },
    { nrm: [0, 1, 0], v: [[-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]] },
    { nrm: [0, -1, 0], v: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]] },
  ];
  for (const f of faces) {
    const base = p.length / 3;
    for (const vert of f.v) { p.push(...vert); n.push(...f.nrm); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/** Octahedron, radius 0.5, centred on the origin — the crystal glyph. */
export function octahedronGeometry() {
  const v = [[0, 0.5, 0], [0, -0.5, 0], [0.5, 0, 0], [-0.5, 0, 0], [0, 0, 0.5], [0, 0, -0.5]];
  const tris = [
    [0, 4, 2], [0, 2, 5], [0, 5, 3], [0, 3, 4],
    [1, 2, 4], [1, 5, 2], [1, 3, 5], [1, 4, 3],
  ];
  const p = [], n = [], idx = [];
  for (const t of tris) {
    const base = p.length / 3;
    const a = v[t[0]], b = v[t[1]], c = v[t[2]];
    const nrm = v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a)));
    for (const vert of [a, b, c]) { p.push(...vert); n.push(...nrm); }
    idx.push(base, base + 1, base + 2);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/** Cone pointing down (apex at y=0), base at y=1 — the SOS marker. */
export function coneGeometry(segments = 16) {
  const p = [0, 0, 0], n = [0, -1, 0], idx = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a) * 0.5, z = Math.sin(a) * 0.5;
    p.push(x, 1, z);
    // Apex is at y=0 and the base at y=1, so the outward side normal tilts
    // downward, not up.
    n.push(...v3.norm([x, -0.5, z]));
  }
  for (let i = 1; i <= segments; i++) idx.push(0, i, i + 1);
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/**
 * Spire: apex at y=1 over a base ring at y=0, unit diameter. Altgeld's turret
 * caps, the Union cupolas, and the Foellinger lantern.
 */
export function spireGeometry(segments = 8) {
  const p = [0, 1, 0], n = [0, 1, 0], idx = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a) * 0.5, z = Math.sin(a) * 0.5;
    p.push(x, 0, z);
    n.push(...v3.norm([x, 0.5, z]));
  }
  // Apex first, then base ring counter-clockwise seen from above.
  for (let i = 1; i <= segments; i++) idx.push(0, i + 1, i);
  // Base cap facing down, on its OWN ring of vertices.
  //
  // The cap used to reuse the side wall's ring, and a shared vertex can only
  // carry one normal. Those normals point outward and slightly up, because that
  // is what the cone flank needs; averaged with the centre's -Y they gave every
  // cap triangle a normal pointing sideways, which agrees with no winding at
  // all. Duplicating the ring is what a hard edge always needs, and it is eight
  // extra vertices on a mesh that is instanced thousands of times but shares one
  // buffer, so it costs nothing that matters.
  //
  // The fan then runs the opposite way round from the flank's: seen from above
  // the flank is counter-clockwise, and a face whose normal points at -Y has to
  // be clockwise from that same viewpoint. None of this is visible today —
  // a spire's underside is always buried in whatever it caps — which is exactly
  // why it survived until the audit was pointed at the props built on it.
  const base = p.length / 3;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    p.push(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
    n.push(0, -1, 0);
  }
  const c = p.length / 3;
  p.push(0, 0, 0); n.push(0, -1, 0);
  for (let i = 0; i < segments; i++) idx.push(c, base + i, base + i + 1);
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/**
 * Dashed centre line along a polyline: a run of short ribbons. `dash` and
 * `gap` are world units.
 *
 * `carry` is how far into the current dash/gap cycle the previous segment
 * ended. Without it every vertex of the road would restart the pattern, and
 * road vertices cluster at bends, so the dashes would bunch up at every corner.
 */
export function dashedRibbonGeometry(points, width, dash = 1.2, gap = 1.6, y = 0.045) {
  const segs = [];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, z0] = points[i], [x1, z1] = points[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-6) continue;
    const tx = (x1 - x0) / len, tz = (z1 - z0) / len;
    let d = carry;
    while (d < len) {
      const e = Math.min(len, d + dash);
      if (e - d > 0.2) segs.push([[x0 + tx * d, z0 + tz * d], [x0 + tx * e, z0 + tz * e]]);
      d += dash + gap;
    }
    carry = d - len;
  }
  return mergeStatic(segs.map((pts) => ({ geo: ribbonGeometry(pts, width, y), color: [1, 1, 1], emissive: 0 })));
}

export function ringGeometry(inner = 0.86, outer = 1, segments = 72) {
  const p = [], n = [], idx = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    p.push(c * inner, 0, s * inner, c * outer, 0, s * outer);
    n.push(0, 1, 0, 0, 1, 0);
  }
  for (let i = 0; i < segments; i++) {
    const b = i * 2;
    idx.push(b, b + 3, b + 1, b, b + 2, b + 3);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/** Screen-filling triangle pair in clip space, for post passes. */
export function quadGeometry() {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

/** Large ground plane on XZ, centred at the origin. */
export function planeGeometry(size = 1) {
  const h = size / 2;
  return {
    positions: new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    // Wound so the +Y face is front-facing under the default CCW/BACK cull.
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
  };
}

/**
 * Radial prism, unit diameter, standing on y=0 up to y=1. `sides` selects the
 * silhouette: 4 is a rotated box, 8 an octagonal tower, 32+ reads as a cylinder.
 */
export function prismGeometry(sides = 24, capped = true) {
  const p = [], n = [], idx = [];
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const c0 = Math.cos(a0) * 0.5, s0 = Math.sin(a0) * 0.5;
    const c1 = Math.cos(a1) * 0.5, s1 = Math.sin(a1) * 0.5;
    const nrm = v3.norm([Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)]);
    const base = p.length / 3;
    p.push(c0, 0, s0, c1, 0, s1, c1, 1, s1, c0, 1, s0);
    for (let k = 0; k < 4; k++) n.push(...nrm);
    // Reversed so the outward face is the front face.
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  if (capped) {
    const top = p.length / 3;
    p.push(0, 1, 0); n.push(0, 1, 0);
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      p.push(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5);
      n.push(0, 1, 0);
    }
    for (let i = 1; i <= sides; i++) idx.push(top, top + i + 1, top + i);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/** Hemisphere of radius 0.5 sitting on y=0 — Foellinger and the Assembly Hall. */
export function domeGeometry(seg = 28, rings = 12) {
  const p = [], n = [], idx = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI / 2);
    const y = Math.sin(phi) * 0.5, rad = Math.cos(phi) * 0.5;
    for (let s = 0; s <= seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      const x = Math.cos(th) * rad, z = Math.sin(th) * rad;
      p.push(x, y, z);
      n.push(...v3.norm([x, y, z]));
    }
  }
  const row = seg + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * row + s, b = a + row;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/**
 * Stadium bowl: an elliptical ring whose inner wall slopes down to the field.
 * Unit footprint (x/z in [-0.5, 0.5]), rim at y=1.
 */
export function bowlGeometry(seg = 56, thickness = 0.14, floor = 0.62) {
  const p = [], n = [], idx = [];
  const inner = 0.5 - thickness;
  const push = (x, y, z, nx, ny, nz) => { p.push(x, y, z); n.push(nx, ny, nz); };

  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // Four rings per column: outer base, outer rim, inner rim, inner field edge.
    push(c * 0.5, 0, s * 0.5, c, 0.15, s);
    push(c * 0.5, 1, s * 0.5, c, 0.15, s);
    push(c * inner, 1, s * inner, 0, 1, 0);
    push(c * inner * floor, 0.12, s * inner * floor, -c * 0.6, 0.8, -s * 0.6);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 4, b = (i + 1) * 4;
    for (let k = 0; k < 3; k++) {
      idx.push(a + k, b + k + 1, b + k, a + k, a + k + 1, b + k + 1);
    }
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/**
 * Gable-roofed block: a box with a pitched roof, walls included.
 *
 * Superseded for buildings by gableRoofGeometry, which sits on a real footprint
 * instead of a unit box. Kept because the winding audit in scripts/verify.sh
 * calls every exported generator with no arguments, and because a crown recipe
 * or a fork may still want a whole gabled block in one piece.
 */
export function gableGeometry(pitch = 0.35) {
  const b = 1 - pitch;
  const p = [], n = [], idx = [];
  const quad = (v0, v1, v2, v3) => {
    const nrm = v3n(v0, v1, v2);
    const base = p.length / 3;
    for (const v of [v0, v1, v2, v3]) { p.push(...v); n.push(...nrm); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const tri = (v0, v1, v2) => {
    const nrm = v3n(v0, v1, v2);
    const base = p.length / 3;
    for (const v of [v0, v1, v2]) { p.push(...v); n.push(...nrm); }
    idx.push(base, base + 1, base + 2);
  };
  function v3n(a, b, c) { return v3.norm(v3.cross(v3.sub(b, a), v3.sub(c, a))); }

  // Walls.
  quad([-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, b, 0.5], [-0.5, b, 0.5]);
  quad([0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, b, -0.5], [0.5, b, -0.5]);
  quad([0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, b, -0.5], [0.5, b, 0.5]);
  quad([-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, b, 0.5], [-0.5, b, -0.5]);
  // Roof planes meeting at a ridge running along X.
  quad([-0.5, b, 0.5], [0.5, b, 0.5], [0.5, 1, 0], [-0.5, 1, 0]);
  quad([0.5, b, -0.5], [-0.5, b, -0.5], [-0.5, 1, 0], [0.5, 1, 0]);
  // Gable ends.
  tri([0.5, b, 0.5], [0.5, b, -0.5], [0.5, 1, 0]);
  tri([-0.5, b, -0.5], [-0.5, b, 0.5], [-0.5, 1, 0]);

  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/* ------------------------------------------------------------------ *
 * Footprint extrusion — real OSM building outlines into solids.
 * ------------------------------------------------------------------ */

const cross2 = (ax, az, bx, bz) => ax * bz - az * bx;

function pointInTriangle(px, pz, ax, az, bx, bz, cx, cz) {
  const d1 = cross2(px - ax, pz - az, bx - ax, bz - az);
  const d2 = cross2(px - bx, pz - bz, cx - bx, cz - bz);
  const d3 = cross2(px - cx, pz - cz, ax - cx, az - cz);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation of a simple CCW ring of [x, z] pairs.
 * Returns index triples into the input ring.
 *
 * Ear clipping is enough because a footprint is a simple polygon and it keeps
 * the renderer free of a triangulation dependency. Courtyards do not break
 * that: triangulateWithHoles below bridges each hole into the outer ring first
 * and hands the result here as one simple ring.
 */
export function triangulateRing(ring) {
  const n = ring.length;
  if (n < 3) return [];

  let signed = 0;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = ring[i];
    const [x1, z1] = ring[(i + 1) % n];
    signed += x0 * z1 - x1 * z0;
  }
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  if (signed < 0) idx.reverse();

  const out = [];
  let guard = idx.length * 3;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const [ax, az] = ring[ia], [bx, bz] = ring[ib], [cx, cz] = ring[ic];

      // Reflex vertices cannot be ears.
      if (cross2(bx - ax, bz - az, cx - ax, cz - az) <= 0) continue;

      let contains = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const [px, pz] = ring[j];
        // A bridged hole repeats vertices; a point that coincides with one of
        // the ear's corners is that corner, not an interior point.
        if ((px === ax && pz === az) || (px === bx && pz === bz) || (px === cx && pz === cz)) continue;
        if (pointInTriangle(px, pz, ax, az, bx, bz, cx, cz)) { contains = true; break; }
      }
      if (contains) continue;

      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    // Degenerate ring (collinear or self-touching): fan it and move on.
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/**
 * Extrudes a footprint ring into a solid: flat roof at `height`, vertical
 * walls down to `base`. Wall vertices are duplicated per edge so each face
 * gets a flat normal and the buildings read as faceted, not smooth.
 */
export function extrudePolygon(ring, height, base = 0) {
  const n = ring.length;
  const p = [], nrm = [], idx = [];

  // Roof cap.
  const tris = triangulateRing(ring);
  for (const i of [...Array(n).keys()]) {
    p.push(ring[i][0], height, ring[i][1]);
    nrm.push(0, 1, 0);
  }
  // Ear clipping emits CCW-in-XZ triples; reversed here so the roof's +Y
  // normal is the front face rather than the underside.
  for (let i = 0; i < tris.length; i += 3) idx.push(tris[i], tris[i + 2], tris[i + 1]);

  // Walls.
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    let ex = bx - ax, ez = bz - az;
    const len = Math.hypot(ex, ez) || 1;
    ex /= len; ez /= len;
    const nx = ez, nz = -ex; // outward for CCW rings
    const b = p.length / 3;
    p.push(ax, base, az, bx, base, bz, bx, height, bz, ax, height, az);
    for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }

  return { positions: new Float32Array(p), normals: new Float32Array(nrm), indices: new Uint32Array(idx) };
}

/** Flat filled ring on the XZ plane at height y — lawns, plazas, road pads. */
export function polygonGeometry(ring, y = 0) {
  const tris = triangulateRing(ring);
  const p = [], n = [];
  for (const [x, z] of ring) { p.push(x, y, z); n.push(0, 1, 0); }
  const idx = new Uint32Array(tris.length);
  // Reversed for the same reason as extrudePolygon's roof cap.
  for (let i = 0; i < tris.length; i += 3) {
    idx[i] = tris[i]; idx[i + 1] = tris[i + 2]; idx[i + 2] = tris[i + 1];
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: idx };
}

/* ------------------------------------------------------------------ *
 * Static batching
 * ------------------------------------------------------------------ */

/**
 * Bakes a list of `{ geo, x, y, z, ry, sx, sy, sz, color, emissive }` into one
 * interleaved static mesh with per-vertex colour and emissive strength.
 *
 * A tile is thousands of pieces that never move, and a crown is dozens. Merging
 * them means one bind and one drawElements for the lot, which is the difference
 * between a smooth orbit and a stuttering one on integrated GPUs. It also means
 * every per-piece value (colour, material, tint) has to travel per vertex,
 * which is why the layout is as wide as it is.
 */
export function mergeStatic(items) {
  let vertexCount = 0, indexCount = 0;
  for (const it of items) {
    vertexCount += it.geo.positions.length / 3;
    indexCount += it.geo.indices.length;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const emissives = new Float32Array(vertexCount);
  // Per-vertex [material id, night tint] and [across, along] surface
  // coordinates for materials.js. Items without `mat` get id 0, which the
  // shader treats as "flat vertex colour", so old callers are unaffected.
  const matTint = new Float32Array(vertexCount * 2);
  const extras = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(indexCount);

  let vo = 0, io = 0;
  for (const it of items) {
    const { geo } = it;
    const n = geo.positions.length / 3;
    const ry = it.ry || 0;
    const c = Math.cos(ry), s = Math.sin(ry);
    const sx = it.sx ?? 1, sy = it.sy ?? 1, sz = it.sz ?? 1;
    const tx = it.x || 0, ty = it.y || 0, tz = it.z || 0;
    const col = it.color;
    const em = it.emissive ?? 0;
    const mat = it.mat ?? 0;
    const tint = it.tint ?? 1;
    const ex = geo.extras || null;

    for (let i = 0; i < n; i++) {
      const px = geo.positions[i * 3] * sx;
      const py = geo.positions[i * 3 + 1] * sy;
      const pz = geo.positions[i * 3 + 2] * sz;
      positions[(vo + i) * 3] = px * c + pz * s + tx;
      positions[(vo + i) * 3 + 1] = py + ty;
      positions[(vo + i) * 3 + 2] = -px * s + pz * c + tz;

      // Inverse-scale the normal so non-uniform stretching stays lit correctly.
      let nx = geo.normals[i * 3] / sx;
      let ny = geo.normals[i * 3 + 1] / sy;
      let nz = geo.normals[i * 3 + 2] / sz;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      normals[(vo + i) * 3] = nx * c + nz * s;
      normals[(vo + i) * 3 + 1] = ny;
      normals[(vo + i) * 3 + 2] = -nx * s + nz * c;

      colors[(vo + i) * 3] = col[0];
      colors[(vo + i) * 3 + 1] = col[1];
      colors[(vo + i) * 3 + 2] = col[2];
      emissives[vo + i] = em;
      matTint[(vo + i) * 2] = mat;
      matTint[(vo + i) * 2 + 1] = tint;
      if (ex) {
        extras[(vo + i) * 2] = ex[i * 2];
        extras[(vo + i) * 2 + 1] = ex[i * 2 + 1];
      }
    }

    for (let i = 0; i < geo.indices.length; i++) indices[io + i] = geo.indices[i] + vo;
    vo += n;
    io += geo.indices.length;
  }

  return { positions, normals, colors, emissives, matTint, extras, indices };
}

/**
 * Flat ribbon along an XZ polyline — the street network. Vertices are already
 * in world space, so ribbons go into `mergeStatic` with an identity transform.
 */
export function ribbonGeometry(points, width, y = 0.02) {
  const half = width / 2;
  const p = [], n = [], idx = [], ex = [];
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let dx = next[0] - prev[0], dz = next[1] - prev[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    if (i > 0) along += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    // Left normal in the XZ plane.
    const nx = -dz * half, nz = dx * half;
    p.push(points[i][0] + nx, y, points[i][1] + nz, points[i][0] - nx, y, points[i][1] - nz);
    n.push(0, 1, 0, 0, 1, 0);
    // Surface coordinates for materials.js: signed across-ribbon offset (0 at
    // the centre line) and distance along it, both in world units.
    ex.push(half, along, -half, along);
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    // Wound so the +Y face is the front face (matches planeGeometry).
    idx.push(a, a + 3, a + 1, a, a + 2, a + 3);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n), extras: new Float32Array(ex), indices: new Uint32Array(idx) };
}

/* ------------------------------------------------------------------ *
 * Holes, roofs, parapets — schema-2 buildings (plan Part B §B2)
 * ------------------------------------------------------------------ */

function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = cross2(dx - cx, dz - cz, ax - cx, az - cz);
  const d2 = cross2(dx - cx, dz - cz, bx - cx, bz - cz);
  const d3 = cross2(bx - ax, bz - az, cx - ax, cz - az);
  const d4 = cross2(bx - ax, bz - az, dx - ax, dz - az);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/**
 * Ear-clips a ring with holes (courtyards) by bridging each hole into the outer
 * ring: the hole's rightmost vertex is joined to the nearest outer vertex whose
 * bridge crosses no edge, then the merged simple polygon is clipped as usual.
 * Returns { points, indices } where points = outer ⧺ holes (flat [x, z] list)
 * and indices refer into it. Outer must be CCW, holes CW (the pipeline
 * guarantees both).
 */
export function triangulateWithHoles(outer, holes = []) {
  if (!holes || !holes.length) return { points: outer.slice(), indices: triangulateRing(outer) };
  const points = outer.slice();
  // Merged ring holds indices into `points`.
  let merged = outer.map((_, i) => i);
  const holeIdx = holes.map((h) => {
    const base = points.length;
    for (const p of h) points.push(p);
    return h.map((_, i) => base + i);
  });
  const allEdges = () => {
    const e = [];
    for (let i = 0; i < merged.length; i++) e.push([merged[i], merged[(i + 1) % merged.length]]);
    return e;
  };
  // Bridge holes from the rightmost inward so bridges never cross each other.
  const order = holeIdx.map((h, k) => ({ k, mx: Math.max(...h.map((i) => points[i][0])) })).sort((a, b) => b.mx - a.mx);
  for (const { k } of order) {
    const hi = holeIdx[k];
    let m = 0;
    for (let i = 1; i < hi.length; i++) if (points[hi[i]][0] > points[hi[m]][0]) m = i;
    const M = hi[m];
    const [mx, mz] = points[M];
    const edges = allEdges();
    const cands = merged.map((pi, slot) => ({ slot, pi, d: (points[pi][0] - mx) ** 2 + (points[pi][1] - mz) ** 2 })).sort((a, b) => a.d - b.d);
    let chosen = null;
    for (const c of cands) {
      const [px, pz] = points[c.pi];
      let blocked = false;
      for (const [a, b] of edges) {
        if (a === c.pi || b === c.pi) continue;
        if (segmentsIntersect(mx, mz, px, pz, points[a][0], points[a][1], points[b][0], points[b][1])) { blocked = true; break; }
      }
      if (!blocked) { chosen = c; break; }
    }
    if (!chosen) chosen = cands[0];
    const rotated = hi.slice(m).concat(hi.slice(0, m)); // starts at M
    merged = merged.slice(0, chosen.slot + 1).concat(rotated, [M, chosen.pi]).concat(merged.slice(chosen.slot + 1));
  }
  const ring = merged.map((i) => points[i]);
  const tris = triangulateRing(ring);
  const indices = tris.map((t) => merged[t]);
  return { points, indices };
}

/** Extrudes a footprint with optional courtyard holes; walls on both the outer ring and each hole. */
export function extrudePolygonWithHoles(ring, height, base = 0, holes = []) {
  if (!holes || !holes.length) return extrudePolygon(ring, height, base);
  const { points, indices: tris } = triangulateWithHoles(ring, holes);
  const p = [], nrm = [], idx = [];
  for (const [x, z] of points) { p.push(x, height, z); nrm.push(0, 1, 0); }
  for (let i = 0; i < tris.length; i += 3) idx.push(tris[i], tris[i + 2], tris[i + 1]);
  const walls = (r) => {
    const n = r.length;
    for (let i = 0; i < n; i++) {
      const [ax, az] = r[i];
      const [bx, bz] = r[(i + 1) % n];
      let ex = bx - ax, ez = bz - az;
      const len = Math.hypot(ex, ez) || 1;
      ex /= len; ez /= len;
      const nx = ez, nz = -ex;
      const b = p.length / 3;
      p.push(ax, base, az, bx, base, bz, bx, height, bz, ax, height, az);
      for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
  };
  walls(ring);
  for (const h of holes) walls(h);
  return { positions: new Float32Array(p), normals: new Float32Array(nrm), indices: new Uint32Array(idx) };
}

/** Flat polygon with holes at height y (roof caps, courtyard-aware decals). */
export function polygonGeometryWithHoles(ring, y = 0, holes = []) {
  if (!holes || !holes.length) return polygonGeometry(ring, y);
  const { points, indices: tris } = triangulateWithHoles(ring, holes);
  const p = [], n = [];
  for (const [x, z] of points) { p.push(x, y, z); n.push(0, 1, 0); }
  const idx = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) { idx[i] = tris[i]; idx[i + 1] = tris[i + 2]; idx[i + 2] = tris[i + 1]; }
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: idx };
}

/** Offsets a ring along its vertex normals; negative `d` moves inward on a CCW ring. */
export function offsetRing(ring, d) {
  const n = ring.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const [px, pz] = ring[(i + n - 1) % n], [cx, cz] = ring[i], [nx, nz] = ring[(i + 1) % n];
    let e0x = cx - px, e0z = cz - pz, e1x = nx - cx, e1z = nz - cz;
    const l0 = Math.hypot(e0x, e0z) || 1, l1 = Math.hypot(e1x, e1z) || 1;
    e0x /= l0; e0z /= l0; e1x /= l1; e1z /= l1;
    // Outward normals for CCW (x east, z south) rings: (ez, -ex).
    const n0x = e0z, n0z = -e0x, n1x = e1z, n1z = -e1x;
    // Bisector of the two edge normals. Collinear edges cancel, so fall back to
    // one of them.
    let mx = n0x + n1x, mz = n0z + n1z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = n1x; mz = n1z; } else { mx /= ml; mz /= ml; }
    // Dividing by the half-angle cosine keeps the offset edge parallel to the
    // original. The floor is a miter limit: at a near-reversal that cosine goes
    // to zero and the corner would shoot off to infinity, which on the parapets
    // showed up as a spike across half a tile.
    const cosHalf = Math.max(0.35, mx * n1x + mz * n1z);
    out.push([cx + (mx * d) / cosHalf, cz + (mz * d) / cosHalf]);
  }
  return out;
}

/** A parapet band around a flat roof: outer wall, inner wall, top cap. */
export function parapetGeometry(ring = [[0, 0], [10, 0], [10, 10], [0, 10]], roofY = 1, thickness = 0.06, height = 0.08) {
  const inner = offsetRing(ring, -thickness);
  const n = ring.length;
  const p = [], nrm = [], idx = [];
  const top = roofY + height;
  const wall = (r, flip) => {
    for (let i = 0; i < n; i++) {
      const [ax, az] = r[i];
      const [bx, bz] = r[(i + 1) % n];
      let ex = bx - ax, ez = bz - az;
      const len = Math.hypot(ex, ez) || 1;
      ex /= len; ez /= len;
      const nx = flip ? -ez : ez, nz = flip ? ex : -ex;
      const b = p.length / 3;
      p.push(ax, roofY, az, bx, roofY, bz, bx, top, bz, ax, top, az);
      for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);
      if (flip) idx.push(b, b + 1, b + 2, b, b + 2, b + 3); else idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
  };
  wall(ring, false);
  wall(inner, true);
  // Top cap: quads between outer and inner rings, +Y normal.
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n];
    const [cx, cz] = inner[(i + 1) % n], [dx, dz] = inner[i];
    const b = p.length / 3;
    p.push(ax, top, az, bx, top, bz, cx, top, cz, dx, top, dz);
    for (let k = 0; k < 4; k++) nrm.push(0, 1, 0);
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  return { positions: new Float32Array(p), normals: new Float32Array(nrm), indices: new Uint32Array(idx) };
}

function ridgeFrame(ring, ridge) {
  // Rectangle in the ridge frame: axis along the ridge, extent across it.
  const [a, b] = ridge;
  let ux = b[0] - a[0], uz = b[1] - a[1];
  const L = Math.hypot(ux, uz) || 1;
  ux /= L; uz /= L;
  const vx = -uz, vz = ux;
  const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, z] of ring) {
    const dx = x - cx, dz = z - cz;
    const u = dx * ux + dz * uz, v = dx * vx + dz * vz;
    if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const P = (u, v, y) => [cx + ux * u + vx * v, y, cz + uz * u + vz * v];
  return { P, minU, maxU, minV, maxV };
}

function faceNormal(p, i0, i1, i2) {
  const ax = p[i0 * 3], ay = p[i0 * 3 + 1], az = p[i0 * 3 + 2];
  const ux = p[i1 * 3] - ax, uy = p[i1 * 3 + 1] - ay, uz = p[i1 * 3 + 2] - az;
  const vx = p[i2 * 3] - ax, vy = p[i2 * 3 + 1] - ay, vz = p[i2 * 3 + 2] - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Emits one flat-shaded polygon face (fan) with its own normal; winding is fixed so the normal faces the given up hint. */
function pushFace(p, nrm, idx, verts) {
  const b = p.length / 3;
  for (const v of verts) p.push(v[0], v[1], v[2]);
  // Normal from the first three vertices; flip if it points down for a roof face.
  let n = faceNormal(p, b, b + 1, b + 2);
  let order = verts.map((_, i) => b + i);
  if (n[1] < 0) { order = order.reverse(); n = [-n[0], -n[1], -n[2]]; }
  for (let k = 0; k < verts.length; k++) nrm.push(n[0], n[1], n[2]);
  for (let i = 1; i < verts.length - 1; i++) idx.push(order[0], order[i], order[i + 1]);
}

/** Gabled roof over a footprint's ridge-aligned rectangle: two slopes + two gable ends. */
export function gableRoofGeometry(ring = [[0, 0], [10, 0], [10, 6], [0, 6]], roofY = 1, ridge = [[0, 3], [10, 3]], rise = 0.6) {
  const { P, minU, maxU, minV, maxV } = ridgeFrame(ring, ridge);
  const p = [], nrm = [], idx = [];
  const top = roofY + rise;
  pushFace(p, nrm, idx, [P(minU, minV, roofY), P(maxU, minV, roofY), P(maxU, 0, top), P(minU, 0, top)]);
  pushFace(p, nrm, idx, [P(minU, 0, top), P(maxU, 0, top), P(maxU, maxV, roofY), P(minU, maxV, roofY)]);
  // Gable ends (vertical triangles).
  const end = (u) => {
    const b = p.length / 3;
    const verts = [P(u, minV, roofY), P(u, maxV, roofY), P(u, 0, top)];
    for (const v of verts) p.push(v[0], v[1], v[2]);
    let n = faceNormal(p, b, b + 1, b + 2);
    const outward = u > 0 ? 1 : -1;
    const ux = P(1, 0, 0)[0] - P(0, 0, 0)[0], uz = P(1, 0, 0)[2] - P(0, 0, 0)[2];
    if ((n[0] * ux + n[2] * uz) * outward < 0) { n = [-n[0], -n[1], -n[2]]; idx.push(b, b + 2, b + 1); } else idx.push(b, b + 1, b + 2);
    for (let k = 0; k < 3; k++) nrm.push(n[0], n[1], n[2]);
  };
  end(minU); end(maxU);
  return { positions: new Float32Array(p), normals: new Float32Array(nrm), indices: new Uint32Array(idx) };
}

/** Hipped roof: the ridge is pulled in from both ends so all four faces slope. */
export function hipRoofGeometry(ring = [[0, 0], [10, 0], [10, 6], [0, 6]], roofY = 1, ridge = [[0, 3], [10, 3]], rise = 0.5) {
  const { P, minU, maxU, minV, maxV } = ridgeFrame(ring, ridge);
  const inset = Math.min((maxU - minU) * 0.25, (maxV - minV) * 0.5);
  const u0 = minU + inset, u1 = maxU - inset;
  const p = [], nrm = [], idx = [];
  const top = roofY + rise;
  pushFace(p, nrm, idx, [P(minU, minV, roofY), P(maxU, minV, roofY), P(u1, 0, top), P(u0, 0, top)]);
  pushFace(p, nrm, idx, [P(u0, 0, top), P(u1, 0, top), P(maxU, maxV, roofY), P(minU, maxV, roofY)]);
  pushFace(p, nrm, idx, [P(minU, minV, roofY), P(u0, 0, top), P(minU, maxV, roofY)]);
  pushFace(p, nrm, idx, [P(maxU, minV, roofY), P(maxU, maxV, roofY), P(u1, 0, top)]);
  return { positions: new Float32Array(p), normals: new Float32Array(nrm), indices: new Uint32Array(idx) };
}

/** Mansard: a steep lower slope to a flat top inset on every side. */
export function mansardRoofGeometry(ring = [[0, 0], [10, 0], [10, 6], [0, 6]], roofY = 1, rise = 0.4, insetK = 0.18) {
  const { P, minU, maxU, minV, maxV } = ridgeFrame(ring, [[ring[0][0], ring[0][1]], [ring[1][0], ring[1][1]]]);
  const iu = (maxU - minU) * insetK, iv = (maxV - minV) * insetK;
  const p = [], nrm = [], idx = [];
  const top = roofY + rise;
  const c = [P(minU, minV, roofY), P(maxU, minV, roofY), P(maxU, maxV, roofY), P(minU, maxV, roofY)];
  const t = [P(minU + iu, minV + iv, top), P(maxU - iu, minV + iv, top), P(maxU - iu, maxV - iv, top), P(minU + iu, maxV - iv, top)];
  for (let i = 0; i < 4; i++) pushFace(p, nrm, idx, [c[i], c[(i + 1) % 4], t[(i + 1) % 4], t[i]]);
  pushFace(p, nrm, idx, [t[0], t[1], t[2], t[3]]);
  return { positions: new Float32Array(p), normals: new Float32Array(nrm), indices: new Uint32Array(idx) };
}

/* ------------------------------------------------------------------ *
 * Culling + LOD ranges
 * ------------------------------------------------------------------ */

/**
 * Six frustum planes [a, b, c, d] from a column-major viewProj matrix
 * (Gribb/Hartmann).
 *
 * A point is inside the frustum when its clip coordinates satisfy -w <= x <= w
 * and so on. Each of those six inequalities is w +/- x >= 0, and w and x are
 * just rows of the matrix dotted with the world point, so the plane for each is
 * the row sum or difference below. Normalising divides out the row's length,
 * which turns the dot product into a signed distance in world units.
 */
export function frustumPlanes(m) {
  // Rows of the matrix; the storage is column-major, hence the stride of 4.
  const r = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = r(0), r1 = r(1), r2 = r(2), r3 = r(3);
  const planes = [
    [r3[0] + r0[0], r3[1] + r0[1], r3[2] + r0[2], r3[3] + r0[3]],
    [r3[0] - r0[0], r3[1] - r0[1], r3[2] - r0[2], r3[3] - r0[3]],
    [r3[0] + r1[0], r3[1] + r1[1], r3[2] + r1[2], r3[3] + r1[3]],
    [r3[0] - r1[0], r3[1] - r1[1], r3[2] - r1[2], r3[3] - r1[3]],
    [r3[0] + r2[0], r3[1] + r2[1], r3[2] + r2[2], r3[3] + r2[3]],
    [r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]],
  ];
  for (const pl of planes) {
    const l = Math.hypot(pl[0], pl[1], pl[2]) || 1;
    pl[0] /= l; pl[1] /= l; pl[2] /= l; pl[3] /= l;
  }
  return planes;
}

/**
 * Conservative AABB test: false only when the box is fully outside one plane.
 * A box straddling a corner can pass all six and still be off screen, which
 * costs one wasted tile draw and never a missing one.
 */
export function aabbVisible(planes, min, max) {
  for (const [a, b, c, d] of planes) {
    // The corner furthest along the plane normal. If even that one is behind
    // the plane, every other corner is too, so eight tests collapse to one.
    const px = a > 0 ? max[0] : min[0], py = b > 0 ? max[1] : min[1], pz = c > 0 ? max[2] : min[2];
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/**
 * Merges several item groups into ONE vertex/index buffer and reports each
 * group's index range, so a tile can hold its LOD levels as ranges over a
 * single VAO: draw L0 = ranges[0], L1 = ranges[1], L2 = ranges[2].
 */
export function mergeStaticRanges(groups) {
  const all = [];
  const counts = [];
  for (const g of groups) {
    let c = 0;
    for (const it of g) { all.push(it); c += it.geo.indices.length; }
    counts.push(c);
  }
  const merged = mergeStatic(all);
  const ranges = [];
  let first = 0;
  for (const c of counts) { ranges.push({ first, count: c }); first += c; }
  return { ...merged, ranges };
}
