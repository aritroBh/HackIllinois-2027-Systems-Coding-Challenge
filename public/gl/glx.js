/**
 * glx — the small WebGL2 layer the campus renderer sits on.
 *
 * Deliberately dependency-free: the dashboard is served under a CSP that only
 * allows 'self' scripts, so a CDN three.js build would be blocked outright.
 * Everything here is the minimum needed for a lit, bloomed, instanced scene.
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
 * Program / buffer plumbing
 * ------------------------------------------------------------------ */

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

/**
 * Links a program and eagerly caches every active uniform location, so draw
 * loops can do `p.u.uModel` instead of a getUniformLocation call per frame.
 */
export function program(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }

  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { handle: p, u, use: () => gl.useProgram(p) };
}

/**
 * Uploads an indexed mesh into a VAO.
 * `attrs` is [{ loc, size, data }]; each becomes its own static ARRAY_BUFFER.
 */
export function mesh(gl, attrs, indices) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [];
  for (const a of attrs) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(a.loc);
    gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
    buffers.push(b);
  }
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: indices.length, buffers, ib };
}

/** Half-float colour target + depth renderbuffer. Half-float keeps bloom clean. */
export function framebuffer(gl, w, h, { depth = false } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  let rbo = null;
  if (depth) {
    rbo = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbo);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, rbo, w, h };
}

export function disposeFramebuffer(gl, f) {
  if (!f) return;
  gl.deleteTexture(f.tex);
  gl.deleteFramebuffer(f.fbo);
  if (f.rbo) gl.deleteRenderbuffer(f.rbo);
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
  // Base cap facing down.
  const c = p.length / 3;
  p.push(0, 0, 0); n.push(0, -1, 0);
  for (let i = 1; i <= segments; i++) idx.push(c, i + 1, i);
  return { positions: new Float32Array(p), normals: new Float32Array(n), indices: new Uint32Array(idx) };
}

/**
 * Dashed centre line along a polyline: a run of short ribbons. `dash` and
 * `gap` are world units.
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
 * Gable-roofed block: a box with a pitched roof. The default silhouette for
 * the older stone buildings around the Quad.
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
 * OSM footprints are simple polygons (no holes, no self-intersection), which is
 * exactly the case ear clipping handles well, and it keeps the renderer free of
 * a triangulation dependency.
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
 * Static batching — the whole ambient campus in one draw call.
 * ------------------------------------------------------------------ */

/**
 * Bakes a list of `{ geo, x, y, z, ry, sx, sy, sz, color, emissive }` into one
 * interleaved static mesh with per-vertex colour and emissive strength.
 *
 * The ambient campus is ~250 pieces that never move; merging them means one
 * bind and one drawElements instead of 250 of each, which is the difference
 * between a smooth orbit and a stuttering one on integrated GPUs.
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
