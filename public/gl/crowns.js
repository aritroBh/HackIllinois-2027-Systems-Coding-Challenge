/**
 * crowns — data-driven monument crowns for the campus renderer.
 *
 * A crown is the landmark-specific mass that sits on top of an extruded
 * footprint: Altgeld's campanile, Foellinger's ribbed dome, the stadium
 * colonnades, the bronze group on the Alma Mater plinth. Until now that was a
 * switch over monument ids in campus3d.js with one `drawMesh` call per piece,
 * some 300 to 450 draw calls every frame. Here a recipe is interpreted once at
 * load into three merged static meshes, so a crown costs three draws however
 * many pieces it holds.
 *
 * Three meshes and not one because the pieces are lit differently. `stone`
 * carries real architectural materials and takes the faction colour as rim and
 * flood only. `warm` is the sodium spill from lamps, concourses and window
 * bands. `glow` is the faction's own light, and its vertex colours change when
 * a gym flips, which `recolorGlow` does in place.
 *
 * Imports are limited to glx-geometry.js and materials.js, neither of which
 * touches a GL context, so a crown can be baked inside bake-worker.js.
 *
 * ---------------------------------------------------------------------------
 * RECIPE FORMAT
 * ---------------------------------------------------------------------------
 *
 *   { "kind": "hall", "ops": [ { "op": "box", … }, … ] }
 *
 * `kind` names the monument kind from the content pack. It is only consulted
 * when an op's `mat` is a part name rather than a material name, so recipes
 * that name materials directly are independent of it.
 *
 * Positions are given in the monument's own frame, which makes a recipe
 * independent of the building's real size and rotation:
 *
 *   u, v      centre along the long and the short axis, −1..1, where ±1 is the
 *             footprint edge. u2, v2 give a second point.
 *   from      "roof" (default) measures y from the top of the extrusion;
 *             "ground" measures it from y = 0.
 *
 * Lengths (`y`, `w`, `d`, `h`, `r`, `size`, `ra`, `rb`) are world units when
 * written as a number, or a fraction of one of the monument's own dimensions
 * when written as a string: "0.94L" of the long span, "0.6S" of the short
 * span, "0.475R" of the radius, "0.95H" of the roof height. An array of such
 * terms is summed, so "y": [0.57, "0.475R"] is 0.57 above the dome springing.
 *
 *   w, d      plan size along the long and the short axis.
 *   r         radius: sets both plan dimensions to 2r. On colonnade and
 *             horseshoe it is the column radius instead.
 *   h         height. On dome it is the rise; the default is a hemisphere.
 *
 * Repetition:
 *
 *   count     copies. With u2/v2 they spread evenly along the line; with ra
 *             (and rb, defaulting to ra) they spread around an ellipse centred
 *             on u, v with those semi-axes.
 *   phase     rotates a ring, in turns.
 *   open      [start, end] in turns, an arc of the ring left empty. Wraps.
 *   face      true turns each copy of a ring outward.
 *
 * Surfaces:
 *
 *   mat       a materials.js material name ("limestoneGrey", "verdigrisDome"),
 *             or a KIND_PARTS part name resolved against the recipe's kind, or
 *             "lamp" for the warm mesh, or "faction" for the glow mesh.
 *   k         emissive strength, the static batch's per-vertex scalar.
 *
 * Op-specific: `arms` on figure (1 gives Alma Mater's outstretched arms),
 * `size` on lights (the globe), `ry` on any solid (extra yaw, radians).
 */

import {
  boxGeometry, octahedronGeometry, prismGeometry, spireGeometry,
  domeGeometry, ringGeometry, mergeStatic,
} from './glx-geometry.js';
import { MATERIALS, MATERIAL_NAMES, materialFor } from './materials.js';

const TAU = Math.PI * 2;

/** Harvest sodium, the campus night lamp. Overridden by deps.lamp. */
const DEFAULT_LAMP = [0.99, 0.70, 0.09];

/** Neutral territory blue, until setFactions supplies the real colour. */
const DEFAULT_FACTION = [0.365, 0.439, 0.588];

/**
 * MATERIALS carries daylight albedos and the renderer's night palette lives in
 * campus3d.js. When a caller passes no palette, dim the daylight value so a
 * stand-alone bake still reads as night rather than as noon.
 */
const NIGHT = 0.55;

/* ------------------------------------------------------------------ *
 * Shared geometry — built once, copied into every merge.
 * ------------------------------------------------------------------ */

const CACHE = new Map();
function cached(key, make) {
  let g = CACHE.get(key);
  if (!g) { g = make(); CACHE.set(key, g); }
  return g;
}

const boxGeo = () => cached('box', boxGeometry);
const octaGeo = () => cached('octa', octahedronGeometry);
const prismGeo = (sides) => cached(`prism${sides}`, () => prismGeometry(sides));
const spireGeo = (seg) => cached(`spire${seg}`, () => spireGeometry(seg));
const domeGeo = () => cached('dome', () => domeGeometry(30, 14));
const bandGeo = () => cached('band', () => ringGeometry(0.9, 1.0, 72));

/** Copy of `geo` turned about Y and stretched in the XZ plane. */
function transformed(geo, angle, kx, kz) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const src = geo.positions, srcN = geo.normals;
  const positions = new Float32Array(src.length);
  const normals = new Float32Array(srcN.length);
  for (let i = 0; i < src.length; i += 3) {
    positions[i] = (src[i] * c + src[i + 2] * s) * kx;
    positions[i + 1] = src[i + 1];
    positions[i + 2] = (-src[i] * s + src[i + 2] * c) * kz;
    // Inverse-scale the normal, the same correction mergeStatic applies.
    const nx = (srcN[i] * c + srcN[i + 2] * s) / kx;
    const ny = srcN[i + 1];
    const nz = (-srcN[i] * s + srcN[i + 2] * c) / kz;
    const l = Math.hypot(nx, ny, nz) || 1;
    normals[i] = nx / l; normals[i + 1] = ny / l; normals[i + 2] = nz / l;
  }
  return { positions, normals, indices: geo.indices };
}

/**
 * A pyramid over a unit square, which is what roofs a rectangular block.
 *
 * spireGeometry(4) gives a diamond: its base vertices sit on the axes, not on
 * the corners. The quarter turn that squares it up cannot be instance yaw,
 * because yaw is applied after scaling and would skew the roof on any oblong
 * footprint; and the turn alone leaves the square inscribed in the diamond, a
 * factor of root two too small. Turn and stretch it once, here.
 */
const spire4Geo = () => cached('spire4', () => transformed(spireGeometry(4), Math.PI / 4, Math.SQRT2, Math.SQRT2));

/**
 * Columns are drawn twelve-sided rather than the twenty-eight the dynamic path
 * used. A stadium colonnade is sixty of them and they are thumb-thick on
 * screen; twelve reads round and keeps the merged buffer small.
 */
const COLUMN_SIDES = 12;

/* ------------------------------------------------------------------ *
 * The monument's own frame.
 * ------------------------------------------------------------------ */

function frameOf(mo) {
  const spanX = mo.spanX || 1, spanZ = mo.spanZ || 1;
  const L = Math.max(spanX, spanZ), S = Math.min(spanX, spanZ);
  const ry = mo.ry || 0;
  return {
    L, S, R: mo.radius ?? L / 2, base: mo.h || 0, ry,
    c: Math.cos(ry), s: Math.sin(ry), cx: mo.cx || 0, cz: mo.cz || 0,
  };
}

/** Local metric offsets along the long and short axes, into world x/z. */
function metric(f, du, dv) {
  return { x: f.cx + du * f.c + dv * f.s, z: f.cz - du * f.s + dv * f.c };
}

/** A normalised −1..1 position, into world x/z. */
const local = (f, u, v) => metric(f, u * f.L / 2, v * f.S / 2);

const LENGTH = /^([+-]?\d*\.?\d+)\s*([LSRH])$/;

function len(spec, ctx, fallback = 0) {
  if (spec === undefined || spec === null) return fallback;
  if (typeof spec === 'number') return spec;
  if (Array.isArray(spec)) {
    let total = 0;
    for (const term of spec) total += len(term, ctx, 0);
    return total;
  }
  const m = LENGTH.exec(String(spec).trim());
  if (!m) { ctx.warnings.push(`bad length ${JSON.stringify(spec)}`); return fallback; }
  const k = parseFloat(m[1]);
  const f = ctx.f;
  return k * (m[2] === 'L' ? f.L : m[2] === 'S' ? f.S : m[2] === 'R' ? f.R : f.base);
}

/* ------------------------------------------------------------------ *
 * Surfaces.
 * ------------------------------------------------------------------ */

/** Material id for a material name, a part name, or nothing. */
function materialId(name, ctx) {
  if (!name) return materialFor(ctx.kind);
  if (MATERIALS[name]) return MATERIALS[name].id;
  return materialFor(ctx.kind, name);
}

/**
 * Stone item fields for a material name. Memoised per bake: the caller's tint
 * function keys its cache on the colour array's identity, so the same material
 * must hand back the same array every time.
 */
function stoneSurface(name, ctx) {
  const key = name || '';
  let s = ctx.surfaces.get(key);
  if (!s) {
    const id = materialId(name, ctx);
    const material = MATERIAL_NAMES[id];
    const color = ctx.colors[material] || MATERIALS[material].albedo.map((v) => v * NIGHT);
    s = { color, mat: id, tint: ctx.tint ? ctx.tint(color, id) : 1 };
    ctx.surfaces.set(key, s);
  }
  return s;
}

/** Which mesh an op lands in, and the vertex fields it contributes. */
function surfaceFor(op, ctx, fallbackMat) {
  const name = op.mat || fallbackMat;
  if (name === 'lamp' || name === 'warm') {
    return { bucket: 'warm', item: { color: ctx.lamp, mat: 0, emissive: op.k ?? 0.9 } };
  }
  if (name === 'faction' || name === 'glow') {
    return { bucket: 'glow', item: { color: ctx.faction, mat: 0, emissive: op.k ?? 1.6 } };
  }
  const s = stoneSurface(name, ctx);
  return { bucket: 'stone', item: { color: s.color, mat: s.mat, tint: s.tint, emissive: op.k ?? 0 } };
}

/* ------------------------------------------------------------------ *
 * Placement.
 * ------------------------------------------------------------------ */

/** True when `turn` falls inside the arc [a0, a1), which may wrap past 1. */
function inArc(turn, a0, a1) {
  const width = a1 - a0;
  if (width <= 0) return false;
  const d = ((turn - a0) % 1 + 1) % 1;
  return d < width || width >= 1;
}

/**
 * Every world position an op occupies, with the extra yaw a ring copy needs to
 * face outward. One point, a line between u,v and u2,v2, or a ring.
 */
function positions(op, ctx) {
  const f = ctx.f;
  const u0 = op.u ?? 0, v0 = op.v ?? 0;
  const out = [];

  if (op.ra !== undefined) {
    const n = Math.max(1, op.count || 1);
    const ra = len(op.ra, ctx, f.L / 2);
    const rb = len(op.rb ?? op.ra, ctx, ra);
    const cu = u0 * f.L / 2, cv = v0 * f.S / 2;
    for (let i = 0; i < n; i++) {
      const turn = i / n + (op.phase || 0);
      if (op.open && inArc(turn, op.open[0], op.open[1])) continue;
      const a = turn * TAU;
      const p = metric(f, cu + Math.cos(a) * ra, cv + Math.sin(a) * rb);
      // mergeStatic turns a piece by -ry, so the yaw that points its long side
      // along the tangent is -a. That is what stands the State Farm saucer's
      // folded plates square to the rim.
      out.push({ x: p.x, z: p.z, ry: op.face ? -a : 0 });
    }
    return out;
  }

  if (op.u2 === undefined && op.v2 === undefined) {
    const p = local(f, u0, v0);
    out.push({ x: p.x, z: p.z, ry: 0 });
    return out;
  }

  const n = Math.max(1, op.count || 1);
  const u1 = op.u2 ?? u0, v1 = op.v2 ?? v0;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const p = local(f, u0 + (u1 - u0) * t, v0 + (v1 - v0) * t);
    out.push({ x: p.x, z: p.z, ry: 0 });
  }
  return out;
}

/** Plan size: 2r when a radius is given, otherwise w along L and d along S. */
function plan(op, ctx) {
  if (op.r !== undefined) {
    const d = len(op.r, ctx, 0.5) * 2;
    return { sx: d, sz: d };
  }
  // The default depth keeps the piece as slender as the footprint is, so a box
  // with only `w` covers the same fraction of both axes.
  const sx = len(op.w, ctx, ctx.f.L);
  return { sx, sz: len(op.d, ctx, sx * ctx.f.S / ctx.f.L) };
}

const baseY = (op, ctx) => (op.from === 'ground' ? 0 : ctx.f.base) + len(op.y, ctx, 0);

function raise(ctx, y) { if (y > ctx.topY) ctx.topY = y; }

/* ------------------------------------------------------------------ *
 * Ops.
 * ------------------------------------------------------------------ */

/** Anything that stands on its base and rises by `sy`. */
function solid(op, ctx, geo, sy, fallbackMat) {
  const { bucket, item } = surfaceFor(op, ctx, fallbackMat);
  const { sx, sz } = plan(op, ctx);
  const y = baseY(op, ctx);
  for (const p of positions(op, ctx)) {
    ctx[bucket].push({ geo, x: p.x, y, z: p.z, ry: ctx.f.ry + p.ry + (op.ry || 0), sx, sy, sz, ...item });
  }
  return y;
}

const OPS = {
  box(op, ctx) {
    const h = len(op.h, ctx, 0.2);
    raise(ctx, solid(op, ctx, boxGeo(), h, 'body') + h);
  },

  prism(op, ctx) {
    const h = len(op.h, ctx, 0.2);
    raise(ctx, solid(op, ctx, prismGeo(28), h, 'body') + h);
  },

  prism8(op, ctx) {
    const h = len(op.h, ctx, 0.2);
    raise(ctx, solid(op, ctx, prismGeo(8), h, 'body') + h);
  },

  spire(op, ctx) {
    const h = len(op.h, ctx, 0.5);
    raise(ctx, solid(op, ctx, spireGeo(12), h, 'roof') + h);
  },

  spire4(op, ctx) {
    const h = len(op.h, ctx, 0.5);
    raise(ctx, solid(op, ctx, spire4Geo(), h, 'roof') + h);
  },

  dome(op, ctx) {
    const { sx } = plan(op, ctx);
    const rise = len(op.h, ctx, sx * 0.5);
    raise(ctx, solid(op, ctx, domeGeo(), rise * 2, 'dome') + rise);
  },

  // A flat band: the lit rim under a saucer, a tier line around a bowl. The
  // ring generator has unit radius, so w and d are halved into semi-axes.
  ring(op, ctx) {
    const { bucket, item } = surfaceFor(op, ctx, 'trim');
    const size = plan(op, ctx);
    const sx = size.sx / 2, sz = size.sz / 2;
    const y = baseY(op, ctx);
    for (const p of positions(op, ctx)) {
      ctx[bucket].push({ geo: bandGeo(), x: p.x, y, z: p.z, ry: ctx.f.ry + p.ry, sx, sy: 1, sz, ...item });
    }
    raise(ctx, y);
  },

  colonnade(op, ctx) {
    const { bucket, item } = surfaceFor(op, ctx, 'column');
    const r = len(op.r, ctx, 0.11);
    const h = len(op.h, ctx, 1);
    const y = baseY(op, ctx);
    const pts = positions(op, ctx);
    for (const p of pts) {
      ctx[bucket].push({
        geo: prismGeo(COLUMN_SIDES), x: p.x, y, z: p.z, ry: ctx.f.ry,
        sx: r * 2, sy: h, sz: r * 2, ...item,
      });
    }
    // A colonnade is washed from below at both ends, which is what separates it
    // from the dark mass of the building behind it.
    if (op.lights !== false && pts.length) {
      const ends = pts.length === 1 ? pts : [pts[0], pts[pts.length - 1]];
      for (const p of ends) {
        ctx.warm.push({
          geo: octaGeo(), x: p.x, y: y + 0.15, z: p.z,
          sx: 0.16, sy: 0.16, sz: 0.16, color: ctx.lamp, mat: 0, emissive: 1.2,
        });
      }
    }
    raise(ctx, y + h);
  },

  lights(op, ctx) {
    const size = len(op.size, ctx, 0.1);
    const y = baseY(op, ctx);
    const k = op.k ?? 1.2;
    for (const p of positions(op, ctx)) {
      ctx.warm.push({
        geo: octaGeo(), x: p.x, y, z: p.z,
        sx: size, sy: size, sz: size, color: ctx.lamp, mat: 0, emissive: k,
      });
    }
    raise(ctx, y + size / 2);
  },

  /**
   * A standing figure: robe, torso, head, and optionally the outstretched arms
   * that make Alma Mater herself read as Alma Mater. Proportions are fractions
   * of `h`, the figure's full height, taken off the bronze group's real
   * measurements so a small statue and a large one share a silhouette.
   */
  figure(op, ctx) {
    const { bucket, item } = surfaceFor(op, ctx, 'figure');
    const h = len(op.h, ctx, 2);
    const y = baseY(op, ctx);
    const geo8 = prismGeo(8);
    for (const p of positions(op, ctx)) {
      const ry = ctx.f.ry + p.ry + (op.ry || 0);
      const at = (yy, sx, sy, sz, geo) => ctx[bucket].push({ geo, x: p.x, y: y + yy, z: p.z, ry, sx, sy, sz, ...item });
      at(0, h * 0.248, h * 0.569, h * 0.208, geo8);
      at(h * 0.545, h * 0.188, h * 0.272, h * 0.158, geo8);
      at(h * 0.926, h * 0.109, h * 0.148, h * 0.109, octaGeo());
      if (op.arms) {
        // Offset along the frame's long axis in world space, so a repeated
        // figure carries its own arms rather than the first one's.
        for (const side of [-1, 1]) {
          const reach = side * h * 0.272;
          ctx[bucket].push({
            geo: boxGeo(), x: p.x + reach * ctx.f.c, y: y + h * 0.718, z: p.z - reach * ctx.f.s,
            ry: ry - side * 0.15, sx: h * 0.495, sy: h * 0.059, sz: h * 0.069, ...item,
          });
        }
      }
    }
    raise(ctx, y + h);
  },

  /**
   * A colonnade bent around an ellipse and left open along one arc: the
   * stadium's horseshoe. The default opening faces the +u end, which is where
   * Memorial Stadium's brick end pavilions stand.
   */
  horseshoe(op, ctx) {
    const ring = {
      ...op,
      ra: op.ra ?? '0.5L',
      rb: op.rb ?? '0.5S',
      open: op.open ?? [0.87, 1.13],
      count: op.count ?? 24,
    };
    const { bucket, item } = surfaceFor(op, ctx, 'colonnade');
    const r = len(op.r, ctx, 0.12);
    const h = len(op.h, ctx, 1);
    const y = baseY(op, ctx);
    for (const p of positions(ring, ctx)) {
      ctx[bucket].push({
        geo: prismGeo(COLUMN_SIDES), x: p.x, y, z: p.z, ry: ctx.f.ry + p.ry,
        sx: r * 2, sy: h, sz: r * 2, ...item,
      });
    }
    raise(ctx, y + h);
  },
};

/* ------------------------------------------------------------------ *
 * Public API.
 * ------------------------------------------------------------------ */

/**
 * Interprets a crown recipe into merged static meshes.
 *
 * `monument` is the renderer's monument record: cx, cz, h, ry, spanX, spanZ,
 * radius, and colour for the faction glow. `deps` supplies what lives in the
 * renderer rather than in geometry or materials, and every field is optional:
 *
 *   colors  material name → night-tuned RGB, the palette campus3d.js tunes
 *   lamp    the warm lamp colour
 *   tint    (color, materialId) → the scale that brings the daylight albedo
 *           down to the brightness the palette colour was tuned to
 *
 * Returns `{ stone, warm, glow, topY, pieces, warnings }`. Each mesh is a
 * mergeStatic result ready for the static vertex layout, or null when the
 * recipe emits nothing into it. `topY` is the highest point the crown reaches,
 * which is where the faction crystal belongs.
 */
export function bakeCrown(monument, recipe, deps = {}) {
  const ctx = {
    f: frameOf(monument),
    kind: recipe.kind || monument.kind || 'hall',
    colors: deps.colors || {},
    lamp: deps.lamp || DEFAULT_LAMP,
    tint: deps.tint || null,
    faction: monument.colour || DEFAULT_FACTION,
    surfaces: new Map(),
    stone: [], warm: [], glow: [],
    topY: monument.h || 0,
    warnings: [],
  };

  for (const op of recipe.ops || []) {
    const handler = OPS[op && op.op];
    if (!handler) { ctx.warnings.push(`unknown op ${JSON.stringify(op && op.op)}`); continue; }
    handler(op, ctx);
  }

  return {
    stone: ctx.stone.length ? mergeStatic(ctx.stone) : null,
    warm: ctx.warm.length ? mergeStatic(ctx.warm) : null,
    glow: ctx.glow.length ? mergeStatic(ctx.glow) : null,
    topY: ctx.topY,
    pieces: ctx.stone.length + ctx.warm.length + ctx.glow.length,
    warnings: ctx.warnings,
  };
}

/**
 * Rewrites the glow mesh's vertex colours in place for a new faction, so a
 * captured gym is a buffer update rather than a rebake. Returns the colour
 * array the caller uploads, or null when the crown has no glow mesh.
 */
export function recolorGlow(baked, colour) {
  const glow = baked && baked.glow;
  if (!glow) return null;
  const c = glow.colors;
  for (let i = 0; i < c.length; i += 3) {
    c[i] = colour[0]; c[i + 1] = colour[1]; c[i + 2] = colour[2];
  }
  return c;
}

/** Op names a recipe may use, for validation in checkCampus and the pipeline. */
export const CROWN_OPS = Object.keys(OPS);
