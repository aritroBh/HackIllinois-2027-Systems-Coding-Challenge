/**
 * campus3d — a live WebGL2 model of the UIUC campus at night.
 *
 * The city comes from real OpenStreetMap footprints (design/build-campus.py →
 * the content pack's campus.json, served at /dashboard/content/): ~900 building outlines with OSM height/level tags, the
 * street network, the Quad lawns, and — derived from the footways and lawns —
 * the elm rows and street lamps. Fourteen landmarks are promoted to territory
 * gyms and drawn with their real materials and silhouettes: the Union's brick
 * and twin cupolas, Altgeld's sandstone campanile, Foellinger's copper dome
 * over a limestone rotunda, Alma Mater in patinated bronze, Memorial Stadium's
 * colonnades. Faction control shows as *light on* the building — a tinted rim,
 * the aura, the crown crystal, the beacon column — never as plastic paint.
 *
 * Palette is Illini: the night is Illini Blue, and every warm source (sodium
 * lamps, windows, the statue) leans Illini Orange.
 *
 * Passes: sky → ground → three static batches (decals, buildings, greenery)
 * → monuments → actors → additive light → bloom → ACES composite. Everything
 * static is merged into a single draw per batch; only the fourteen monuments
 * and the live actors are drawn individually.
 */

import {
  m4, hexRGB, mergeStatic,
  boxGeometry, octahedronGeometry, coneGeometry, ringGeometry, quadGeometry,
  planeGeometry, prismGeometry, domeGeometry, bowlGeometry, spireGeometry,
  extrudePolygon, polygonGeometry, ribbonGeometry, dashedRibbonGeometry,
} from './glx-geometry.js';
import { program, mesh, framebuffer, disposeFramebuffer, instancedMesh, drawInstanced } from './glx-gl.js';
import { MATERIAL_GLSL, MATERIALS } from './materials.js';
import { createTileManager } from './tiles.js';
import { createPlayerLayer, PLAYER_VS, PLAYER_FS, SLOT_W, SLOT_H } from './players.js';
import { bakeTile, treeTemplate, lampTemplate } from './tile-bake.js';

/* ------------------------------------------------------------------ *
 * Palette — Illini Blue #13294B, Illini Orange #FF5F05
 * ------------------------------------------------------------------ */

// Night sky runs Illini Blue at the zenith toward Industrial at the horizon.
const SKY_ZENITH = new Float32Array([0.022, 0.040, 0.095]);
const SKY_HORIZON = new Float32Array([0.062, 0.105, 0.215]);
const FOG = new Float32Array([0.060, 0.100, 0.205]);
const GROUND = new Float32Array([0.030, 0.052, 0.112]);
const LAMP = [0.99, 0.70, 0.09]; // Harvest — warm sodium/LED spill

/** Official Illinois brand palette (brand.illinois.edu), as linear-ish RGB. */
const hx = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const BRAND = {
  orange: hx('#FF5F05'), blue: hx('#13294B'), storm: hx('#707372'), storm80: hx('#C6C7C6'),
  industrial: hx('#1D58A7'), arches: hx('#009FD4'), patina: hx('#007E8E'),
  harvest: hx('#FCB316'), prairie: hx('#006230'), earth: hx('#7D3E13'),
};

/**
 * Daylight albedos read off the reference photographs (design/refs/MATERIALS.md);
 * the shaders light them for night.
 */
const MAT = {
  brick: hx('#8E3B2C'),        // Foellinger / Union / Grainger red brick
  brickDark: hx('#6E3325'),    // Krannert
  brickBuff: hx('#B39A78').map((v) => v * 0.75),    // DCL
  limestone: hx('#D9D2C2'),    // Indiana limestone trim
  limestoneGrey: hx('#8C8578'), // Altgeld's rusticated ashlar
  archStone: hx('#A89F8E'),
  trim: hx('#E9E6DC'),         // the Union's painted wood
  bronze: hx('#5A4A32'),       // Alma Mater, dark bronze since 2014
  bronzeLit: hx('#6F8A78'),
  bronzeFlood: hx('#5A4A32').map((v) => v * 1.75), // Alma Mater under floodlight (stable ref: material lookup keys on identity)
  granite: hx('#3F4045'),
  copper: hx('#5E9A8C'),       // verdigris: Foellinger dome, Siebel drum
  copperDark: hx('#2E4A46'),
  tile: [0.62, 0.17, 0.09],    // Altgeld's terracotta tile spire, deepened for night
  slate: hx('#3B3F47').map((v) => v * 0.55),
  metalRoof: hx('#5C6470').map((v) => v * 0.7),    // Grainger's standing-seam hip
  glass: hx('#7A9DB0').map((v) => v * 0.42),   // dark at night; lit by its floor bands
  glassGreen: hx('#8FB8AE').map((v) => v * 0.5),   // Beckman
  concrete: hx('#D6D5CF').map((v) => v * 0.8),     // State Farm Center
  concreteGrey: hx('#8E9096').map((v) => v * 0.8),
  buff: hx('#CFC7B3').map((v) => v * 0.7),         // Beckman precast
  terracotta: hx('#B65C3A'),   // ECEB fins
  steel: hx('#5A5F66'),
  field: hx('#2E7D3E'),
  bark: [0.16, 0.11, 0.07],
  leaf: [0.11, 0.30, 0.15],
  leafDark: [0.07, 0.20, 0.11],
  pole: [0.10, 0.11, 0.13],
  water: [0.05, 0.12, 0.22],
  asphalt: hx('#2B2D33').map((v) => v * 0.45),
  rail: hx('#8E9090'),
  tie: [0.16, 0.12, 0.08],
};

/* ------------------------------------------------------------------ *
 * Procedural materials (materials.js)
 *
 * Every MAT.* albedo above maps onto a procedural surface. The tuned night
 * colour stays authoritative for brightness: the shader draws the material's
 * pattern and chroma, scaled so its mean luminance equals the vertex/uniform
 * colour it replaces. That is what keeps the scene's lighting balance intact
 * while brick gains coursing and limestone gains its blocks.
 * ------------------------------------------------------------------ */

const MID = Object.fromEntries(Object.entries(MATERIALS).map(([k, v]) => [k, v.id]));
const ALBEDO_BY_ID = Object.fromEntries(Object.values(MATERIALS).map((v) => [v.id, v.albedo]));

/** MAT colour reference → material name. */
const MAT_OF = new Map([
  [MAT.brick, 'brick'], [MAT.brickDark, 'brick'], [MAT.brickBuff, 'limestoneBuff'],
  [MAT.limestone, 'limestoneBuff'], [MAT.limestoneGrey, 'limestoneGrey'], [MAT.archStone, 'limestoneBuff'],
  [MAT.trim, 'whiteTrim'], [MAT.bronze, 'bronze'], [MAT.bronzeLit, 'bronze'], [MAT.bronzeFlood, 'bronze'], [MAT.granite, 'granite'],
  [MAT.copper, 'verdigris'], [MAT.copperDark, 'verdigris'], [MAT.tile, 'terracotta'],
  [MAT.slate, 'slate'], [MAT.metalRoof, 'slate'], [MAT.glass, 'glass'], [MAT.glassGreen, 'glass'],
  [MAT.concrete, 'concreteRibbed'], [MAT.concreteGrey, 'concreteGrey'], [MAT.buff, 'limestoneBuff'],
  [MAT.terracotta, 'terracotta'], [MAT.steel, 'concreteGrey'], [MAT.field, 'field'],
]);

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Night tint: scales the daylight material so its mean matches `color`. */
const tintCache = new WeakMap();
function tintFor(color, id) {
  let byId = tintCache.get(color);
  if (!byId) { byId = new Map(); tintCache.set(color, byId); }
  let t = byId.get(id);
  if (t === undefined) {
    // Never brighter than daylight. Some crown pieces pass a deliberately
    // lifted colour (Alma Mater's floodlit bronze) and rely on the flood term
    // for brightness; scaling the daylight albedo up as well blew the bronze
    // out to cream. The pattern keeps its chroma; the flood does the lifting.
    t = Math.min(1.0, lum(color) / Math.max(lum(ALBEDO_BY_ID[id]), 0.02));
    byId.set(id, t);
  }
  return t;
}

/** Material id for a MAT colour reference (0 = none). */
const matIdFor = (color) => { const n = MAT_OF.get(color); return n ? MID[n] : 0; };

/** Static-batch item fields for a colour and a material name. */
function matItem(color, name) {
  const id = MID[name];
  return { color, mat: id, tint: tintFor(color, id) };
}

/** Ambient massing — brick campus, slate-blue town, glass labs. */
const MASS = {
  university: hx('#8E3B2C').map((v) => v * 0.62),
  glassy: [0.11, 0.19, 0.30],
  civic: [0.27, 0.24, 0.21],
  house: [0.10, 0.11, 0.17],
  roof: [0.09, 0.10, 0.14],
  road: [0.062, 0.078, 0.128],
  roadMajor: [0.085, 0.108, 0.170],
  walk: [0.36, 0.34, 0.30],              // pale concrete, lighter than lawn
  lane: [0.99, 0.72, 0.15],
  lawn: [0.02, 0.384, 0.188].map((v) => v * 0.42),   // Prairie, at night
  field: [0.18, 0.49, 0.24].map((v) => v * 0.42),
};

const GLASSY = new Set(['commercial', 'retail', 'stadium']);
const HOUSING = new Set(['house', 'detached', 'semidetached_house', 'apartments', 'residential', 'dormitory', 'garage']);

function massColour(type) {
  if (HOUSING.has(type)) return MASS.house;
  if (type === 'university') return MASS.university;
  if (GLASSY.has(type)) return MASS.glassy;
  return MASS.civic;
}

/**
 * Vertical exaggeration. True scale (a 15 m hall is 1.5 world units against a
 * 240-unit-wide campus) renders as a flat relief map; 2.6x is where UIUC's
 * silhouette reads without the towers looking like skyscrapers.
 */
const VSCALE = 2.6;
const BLOOM_DIV = 2;

/* ------------------------------------------------------------------ *
 * Shaders
 * ------------------------------------------------------------------ */

const FOG_GLSL = `
uniform vec3 uCamPos, uFogColor;
uniform float uFogNear, uFogFar;
// Distance fog plus a shallow ground layer that pools in the streets. The
// height term only starts a little way out so nearby geometry stays crisp.
float fogAmount(vec3 w) {
  float dist = length(w - uCamPos);
  float fd = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  float near = clamp(dist / (uFogNear * 1.2), 0.0, 1.0);
  // The ground layer only exists at campus-wide zoom (uFogNear scales with
  // camera distance). Up close it washed every material Illini-blue —
  // bronze read as patina, brick as slate.
  float wide = smoothstep(14.0, 55.0, uFogNear);
  float fh = exp(-max(w.y, 0.0) * 0.55) * 0.22 * near * wide;
  return clamp(fd + fh, 0.0, 1.0);
}`;

const SCENE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform mat4 uProj, uView, uModel;
uniform vec3 uInvScaleSq;
out vec3 vN, vW;
out float vY;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz;
  // mat3(uModel) is R*S; S^-2 on the normal yields R*S^-1*n, the normal matrix.
  vN = normalize(mat3(uModel) * (aNrm * uInvScaleSq));
  vY = aPos.y;
  gl_Position = uProj * uView * w;
}`;

const SCENE_FS = `#version 300 es
precision highp float;
in vec3 vN, vW;
in float vY;
uniform vec3 uColor, uEmissive;
uniform float uEmissiveK, uAlpha, uRim, uFadeTop, uTime, uAlbedoK, uFogMode, uFlood, uTintK;
uniform int uMat;
${FOG_GLSL}
${MATERIAL_GLSL}
out vec4 frag;

void main() {
  vec3 N0 = normalize(vN);
  vec3 V = normalize(uCamPos - vW);

  // Procedural surface for architectural pieces (uMat > 0); crystals, rings
  // and light columns pass 0 and keep their flat colour.
  Surface s = material(uMat, vW, N0, uTime);
  float hasMat = uMat > 0 ? 1.0 : 0.0;
  vec3 alb = mix(uColor, s.albedo * uTintK, hasMat);
  vec3 N = normalize(N0 + s.nrm * hasMat);

  // Moonlight key from the north-east, a cool Illini-blue ambient, and a
  // faint warm bounce from the street lamps below.
  vec3 L1 = normalize(vec3(0.45, 0.85, 0.30));
  vec3 L2 = normalize(vec3(-0.6, 0.30, -0.55));
  float d1 = max(dot(N, L1), 0.0);
  float d2 = max(dot(N, L2), 0.0);
  vec3 ambient = vec3(0.13, 0.17, 0.27);
  vec3 bounce = vec3(0.22, 0.10, 0.03) * max(-N.y, 0.0);
  vec3 lit = ambient + vec3(0.95, 0.92, 0.86) * d1 * 0.85 + vec3(0.55, 0.62, 0.80) * d2 * 0.30 + bounce;

  // Architectural floodlighting: monuments are lit from the ground on the
  // side you are looking at. Without this the camera-facing faces only ever
  // see the blue sky ambient, and bronze or brick reads as slate.
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 F = normalize(V - up * 0.55);
  float df = max(dot(N, F), 0.0) * (1.0 - 0.6 * max(N.y, 0.0));
  lit += vec3(1.0, 0.78, 0.50) * df * uFlood;

  // Fresnel rim in the faction colour — the light the territory casts.
  // Faction rim light. On textured architecture it is cut hard: at grazing
  // angles a neutral (slate-blue) faction's rim washed every roof and the
  // bronze of Alma Mater to pale grey, hiding the material it sits on.
  // Crystals, beacons and light columns (uMat == 0) keep the full rim.
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.8) * uRim
            * mix(1.0, 0.32 * (1.0 - s.rough * 0.4), hasMat);

  // Optional energy gradient for crystals and columns (uFadeTop = 1).
  float y = clamp(vY, 0.0, 1.0);
  float grad = mix(0.10, 2.8, y * y) * uFadeTop + (1.0 - uFadeTop);
  float bands = uFadeTop * pow(max(sin(vW.y * 1.1 - uTime * 1.9), 0.0), 6.0) * 0.8;

  vec3 col = alb * lit * uAlbedoK + s.emissive * hasMat * uAlbedoK + uEmissive * (uEmissiveK * (grad + bands) + rim);

  float f = fogAmount(vW);
  // Additive geometry attenuates; opaque geometry blends toward the fog.
  col = mix(mix(col, uFogColor, f), col * (1.0 - f), uFogMode);
  frag = vec4(col, uAlpha);
}`;

/* The baked campus: per-vertex colour and emissive, one draw call per batch. */
const STATIC_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in float aEmis;
layout(location=4) in vec2 aMatTint;   // [material id, night tint]
layout(location=5) in vec2 aExtra;     // [across, along] surface coords, world units
uniform mat4 uProj, uView;
out vec3 vN, vW, vC;
out float vE, vTint;
out vec2 vX;
flat out int vMat;
void main() {
  vW = aPos; vN = aNrm; vC = aCol; vE = aEmis;
  vMat = int(aMatTint.x + 0.5); vTint = aMatTint.y; vX = aExtra;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const STATIC_FS = `#version 300 es
precision highp float;
in vec3 vN, vW, vC;
in float vE, vTint;
in vec2 vX;
flat in int vMat;
uniform float uTime, uSweep, uWindows, uSweepK;
${FOG_GLSL}
${MATERIAL_GLSL}
out vec4 frag;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 N0 = normalize(vN);
  vec3 V = normalize(uCamPos - vW);

  // Procedural surface. Evaluated for every fragment (its derivatives live at
  // the top of material(), outside all branches); id 0 falls back to the flat
  // vertex colour. The tint scales the daylight albedo down to the night
  // brightness the vertex colour was tuned to.
  Surface s = material(vMat, vW, N0, uTime, vX * uMetersPerUnit);
  float hasMat = vMat > 0 ? 1.0 : 0.0;
  vec3 alb = mix(vC, s.albedo * vTint, hasMat);
  vec3 N = normalize(N0 + s.nrm * hasMat);

  vec3 L1 = normalize(vec3(0.45, 0.85, 0.30));
  vec3 L2 = normalize(vec3(-0.6, 0.30, -0.55));
  float d1 = max(dot(N, L1), 0.0);
  float d2 = max(dot(N, L2), 0.0);
  vec3 ambient = vec3(0.12, 0.16, 0.26);
  vec3 bounce = vec3(0.20, 0.09, 0.03) * max(-N.y, 0.0);
  vec3 lit = ambient + vec3(0.95, 0.92, 0.86) * d1 * 0.80 + vec3(0.55, 0.62, 0.80) * d2 * 0.28 + bounce;

  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.2) * 0.30 * (1.0 - s.rough * 0.5 * hasMat);
  vec3 col = alb * lit + alb * rim + alb * vE * 2.6 + s.emissive * hasMat * 0.9;

  // Every derivative below is evaluated unconditionally: fwidth() inside
  // divergent control flow is undefined, and facade edges do diverge.
  vec2 wall = vec2(vW.x * N.z - vW.z * N.x, vW.y);
  vec2 cell = vec2(wall.x * 1.15, wall.y * 1.7);
  vec2 cellF = fract(cell);
  float footprint = max(fwidth(cell.x), fwidth(cell.y));
  float lod = 1.0 - smoothstep(0.22, 0.75, footprint);
  vec2 e = fwidth(cell) * 1.5 + 0.02;

  float onFacade = uWindows * step(abs(N.y), 0.4) * step(0.35, vW.y);
  vec2 id = floor(cell);
  float h = hash21(id);
  float occupied = step(0.60, h);
  float flick = 0.78 + 0.22 * sin(uTime * 0.7 + hash21(id + 7.1) * 30.0);
  vec2 pane = smoothstep(0.22 - e, 0.22 + e, cellF) * (1.0 - smoothstep(0.78 - e, 0.78 + e, cellF));
  // Mostly warm incandescent, a few cool fluorescent labs.
  vec3 glow = mix(vec3(1.0, 0.62, 0.28), vec3(0.72, 0.84, 1.0), step(0.86, hash21(id + 2.3)));
  col += glow * onFacade * occupied * pane.x * pane.y * flick * lod * 0.75;

  // The radar sweep grazes the city, briefly lighting whatever it crosses.
  float ang = atan(vW.z, vW.x);
  float delta = mod(uSweep - ang, 6.28318);
  col += vec3(0.25, 0.55, 0.80) * alb * pow(clamp(1.0 - delta / 0.85, 0.0, 1.0), 3.0) * 2.2 * uSweepK;

  frag = vec4(mix(col, uFogColor, fogAmount(vW)), 1.0);
}`;

/**
 * Instanced variant of STATIC_VS: the template (an elm, a lamp) is placed per
 * instance from a vec4 row [x, z, scale, tone]. Trees across the whole campus
 * become one draw call instead of a 19 MB merged mesh.
 */
const INST_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in float aEmis;
layout(location=4) in vec2 aMatTint;
layout(location=5) in vec2 aExtra;
layout(location=6) in vec4 aInst;      // x, z, scale, tone
uniform mat4 uProj, uView;
out vec3 vN, vW, vC;
out float vE, vTint;
out vec2 vX;
flat out int vMat;
void main() {
  vec3 p = vec3(aPos.x * aInst.z + aInst.x, aPos.y * aInst.z, aPos.z * aInst.z + aInst.y);
  vW = p; vN = aNrm; vC = aCol * aInst.w; vE = aEmis;
  vMat = int(aMatTint.x + 0.5); vTint = aMatTint.y * aInst.w; vX = aExtra;
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;

const GROUND_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uProj, uView;
out vec3 vW;
void main() { vW = aPos; gl_Position = uProj * uView * vec4(aPos, 1.0); }`;

const GROUND_FS = `#version 300 es
precision highp float;
in vec3 vW;
uniform float uTime, uSweep, uGridScale;
uniform vec3 uGrid, uAccent, uBase, uHorizon;
${FOG_GLSL}
out vec4 frag;

float gridLine(vec2 p, float scale, float thickness) {
  vec2 c = p * scale;
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-5));
  return 1.0 - min(min(g.x, g.y) / thickness, 1.0);
}

void main() {
  vec2 p = vW.xz;
  float r = length(p);

  float fine  = gridLine(p, uGridScale, 1.5) * 0.22;
  float major = gridLine(p, uGridScale * 0.2, 1.2) * 0.42;
  float rings = (1.0 - smoothstep(0.0, 0.05, abs(fract(r * 0.02) - 0.5) - 0.47)) * 0.18;
  float pulse = smoothstep(0.92, 1.0, 1.0 - abs(fract(r * 0.008 - uTime * 0.05) - 0.5) * 2.0) * 0.30;

  float ang = atan(p.y, p.x);
  float delta = mod(uSweep - ang, 6.28318);
  float sweep = pow(clamp(1.0 - delta / 1.0, 0.0, 1.0), 2.6) * 0.22;

  float falloff = clamp(1.0 - r / 300.0, 0.0, 1.0);
  falloff *= falloff;

  vec3 col = uBase + uGrid * (fine + major) * falloff + uAccent * (rings + pulse + sweep) * falloff;
  // Far edge dissolves into the horizon so the plane never shows a rim.
  col = mix(col, uHorizon, smoothstep(170.0, 320.0, r));
  frag = vec4(mix(col, uFogColor, fogAmount(vW) * 0.8), 1.0);
}`;

const POST_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
out vec2 vUV;
void main() { vUV = aPos.xy * 0.5 + 0.5; gl_Position = vec4(aPos.xy, 0.0, 1.0); }`;

/* Starfield and horizon glow behind everything. */
const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform float uYaw, uPitch, uTime;
uniform vec2 uRes;
uniform vec3 uZenith, uHorizon;
out vec4 frag;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float stars(vec2 uv, float scale, float density, float size) {
  vec2 sp = uv * scale;
  vec2 id = floor(sp);
  vec2 f = fract(sp) - 0.5;
  float h = hash21(id);
  vec2 off = (vec2(hash21(id + 1.7), hash21(id + 3.1)) - 0.5) * 0.8;
  float d = length(f - off);
  float twinkle = 0.65 + 0.35 * sin(uTime * 1.6 + h * 60.0);
  return (1.0 - smoothstep(0.0, size, d)) * step(1.0 - density, h) * twinkle;
}

void main() {
  vec2 uv = vUV;
  float aspect = uRes.x / uRes.y;
  // Sky slides with the camera so the stars parallax as you orbit.
  vec2 sky = vec2(uv.x * aspect + uYaw * 0.55, uv.y * 0.9 + uPitch * 0.35);

  float t = pow(uv.y, 0.85);
  vec3 col = mix(uHorizon, uZenith, t);

  float s = stars(sky, 60.0, 0.07, 0.07) * 1.4
          + stars(sky + 11.3, 130.0, 0.12, 0.05) * 0.8
          + stars(sky + 5.7, 260.0, 0.20, 0.035) * 0.35;
  col += vec3(0.85, 0.92, 1.0) * s * t;

  // A faint Illini-orange skyglow from the town along the horizon.
  col += vec3(1.0, 0.42, 0.12) * 0.07 * pow(1.0 - uv.y, 4.0);
  frag = vec4(col, 1.0);
}`;

/* Player: an upright billboard sprite, alpha-tested so it needs no sorting. */
const SPRITE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;          // clip-space quad, -1..1
uniform mat4 uProj, uView;
uniform vec3 uCenter, uRight;             // ground point; camera right, flattened
uniform vec2 uSize;                       // half width, full height (world units)
uniform float uFrame, uFrames, uFlip;
out vec2 vUV;
void main() {
  vec3 w = uCenter + uRight * (aPos.x * uSize.x) + vec3(0.0, (aPos.y + 1.0) * 0.5 * uSize.y, 0.0);
  float u = aPos.x * 0.5 + 0.5;
  u = mix(u, 1.0 - u, uFlip);
  vUV = vec2((uFrame + u) / uFrames, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = uProj * uView * vec4(w, 1.0);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uGlow;
out vec4 frag;
void main() {
  vec4 c = texture(uTex, vUV);
  if (c.a < 0.5) discard;
  // Lift the sprite above the night ambient so it reads at campus zoom.
  frag = vec4(c.rgb * (1.15 + uGlow), 1.0);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uThreshold;
out vec4 frag;
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = clamp((l - uThreshold) / max(l, 1e-4), 0.0, 1.0);
  frag = vec4(c * k * k, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 frag;
const float W[5] = float[](0.227027, 0.194594, 0.121621, 0.054054, 0.016216);
void main() {
  vec3 sum = texture(uTex, vUV).rgb * W[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i);
    sum += texture(uTex, vUV + o).rgb * W[i];
    sum += texture(uTex, vUV - o).rgb * W[i];
  }
  frag = vec4(sum, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uScene, uBloom;
uniform float uBloomK, uTime;
uniform vec2 uRes;
// Retro post: uPixel = block size in device px (1 = off), uPosterize = colour
// levels per channel (0 = off), uScanlines = 1/0.
uniform float uPixel, uPosterize, uScanlines;
out vec4 frag;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUV;
  // Pixelation: snap the sample to the centre of a block of uPixel device px.
  if (uPixel > 1.0) uv = (floor(vUV * uRes / uPixel) + 0.5) * uPixel / uRes;
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);
  float ca = r2 * 0.0028 * step(uPixel, 1.0);   // no chromatic split on a pixelated frame
  vec3 scene = vec3(
    texture(uScene, uv - d * ca).r,
    texture(uScene, uv).g,
    texture(uScene, uv + d * ca).b
  );
  vec3 col = scene + texture(uBloom, uv).rgb * uBloomK;
  col = aces(col);
  // Gentle lift in the shadows keeps the blue night from crushing to black.
  col = pow(col, vec3(0.94));
  // Posterize in a gamma-ish space so the dark blues keep their steps and the
  // bloom highlights still band cleanly instead of collapsing to white.
  if (uPosterize > 0.5) {
    vec3 g = pow(col, vec3(1.0 / 2.2));
    g = floor(g * uPosterize + 0.5) / uPosterize;
    col = pow(g, vec3(2.2));
  }
  col *= 1.0 - 0.04 * uScanlines * step(1.0, mod(gl_FragCoord.y, 2.0));
  col *= 1.0 - smoothstep(0.20, 0.82, r2) * 0.62;
  col += (hash(uv * uRes + fract(uTime)) - 0.5) * 0.018 * (1.0 - step(0.5, uPosterize));
  frag = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export function createCampusRenderer(canvas, opts = {}) {
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, powerPreference: 'high-performance',
  });
  if (!gl) return null;
  if (!gl.getExtension('EXT_color_buffer_float')) return null;

  const progScene = program(gl, SCENE_VS, SCENE_FS);
  const progStatic = program(gl, STATIC_VS, STATIC_FS);
  const progInst = program(gl, INST_VS, STATIC_FS);
  const progPlayers = program(gl, PLAYER_VS, PLAYER_FS);
  const progGround = program(gl, GROUND_VS, GROUND_FS);
  const progSky = program(gl, POST_VS, SKY_FS);
  const progBright = program(gl, POST_VS, BRIGHT_FS);
  const progBlur = program(gl, POST_VS, BLUR_FS);
  const progComposite = program(gl, POST_VS, COMPOSITE_FS);

  const build = (geo) => mesh(gl, [
    { loc: 0, size: 3, data: geo.positions },
    { loc: 1, size: 3, data: geo.normals },
  ], geo.indices);

  const GEO = {
    box: boxGeometry(),
    octa: octahedronGeometry(),
    prism8: prismGeometry(8),
    spire8: spireGeometry(8),
  };

  const MESH = {
    box: build(GEO.box),
    octa: build(GEO.octa),
    cone: build(coneGeometry(20)),
    ring: build(ringGeometry(0.92, 1.0, 96)),
    disc: build(ringGeometry(0.0, 1.0, 72)),
    quad: build(quadGeometry()),
    plane: build(planeGeometry(900)),
    prism: build(prismGeometry(28)),
    prism8: build(GEO.prism8),
    spire: build(spireGeometry(12)),
    spire4: build(spireGeometry(4)),
    dome: build(domeGeometry(30, 14)),
    bowl: build(bowlGeometry(64, 0.14, 0.62)),
  };

  const monumentMeshes = new Map();
  let staticMesh = null, decalMesh = null, greenMesh = null;

  /* ----------------------------- tiles + quality ------------------------ */

  let tiles = null, treeInst = null, lampInst = null, instVersion = -1, instAt = 0;
  /** Remote trainers (plan §B4): one instanced draw, built lazily on the first setPlayers. */
  let playerLayer = null;
  let factionColours = {};
  const bakeOpts = { vscale: VSCALE };
  const LEVEL_NAMES = ['low', 'med', 'high'];
  const quality = { tier: 'auto', level: 2, dprCap: 2, bloomW: 480, windows: true, treeDist: Infinity, sweepK: 1, ema: 16, lastUp: 0, reduced: false };
  function applyLevel(level) {
    quality.level = level;
    quality.dprCap = level === 0 ? 1 : level === 1 ? 1.5 : 2;
    quality.windows = level > 0;
    quality.treeDist = level === 0 ? 150 : level === 1 ? 400 : Infinity;
    quality.bloomW = level === 0 ? 320 : 480;
    W = 0; H = 0; // force resize() to rebuild the targets at the new DPR/bloom size
    instVersion = -1;
  }
  const frameStats = { tris: 0, tilesDrawn: 0, draws: 0 };
  let probeRun = null;

  /* -------------------------------- player ------------------------------ */

  const progSprite = program(gl, SPRITE_VS, SPRITE_FS);
  const SPRITE_PX = 32, SPRITE_FRAMES = 4;
  // Current sheet geometry: the default is 32×32 frames; the avatar creator
  // supplies 32×48 frames (128×48 sheet). Height on the map is fixed; width
  // follows the frame aspect so nothing stretches.
  const sprite = { fw: 32, fh: 32 };

  /**
   * Draws a 4-frame walk cycle into a 128×32 sheet: Illini-orange cap, a
   * jacket in the faction colour, a 1-px navy outline. Procedural so the
   * default avatar needs no asset; the creator replaces it via setPlayerSprite.
   */
  function drawDefaultSprite(jacketHex = '#22d3ee') {
    const sheet = document.createElement('canvas');
    sheet.width = SPRITE_PX * SPRITE_FRAMES; sheet.height = SPRITE_PX;
    const ctx = sheet.getContext('2d');
    const P = { cap: '#ff5f05', capDk: '#c2410c', skin: '#f2c9a0', skinDk: '#d9a577',
                jkt: jacketHex, jktDk: shade(jacketHex, 0.62), pants: '#2a3a5c', shoe: '#1a1f2e', eye: '#13294b', bag: '#7d3e13' };
    const legs = [[0, 0], [2, -2], [0, 0], [-2, 2]];
    const arms = [[0, 0], [1, -1], [0, 0], [-1, 1]];
    for (let f = 0; f < SPRITE_FRAMES; f++) {
      const ox = f * SPRITE_PX;
      const bob = (f === 1 || f === 3) ? 1 : 0;
      const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(ox + x, y - bob, w, h); };
      px(11, 3, 10, 2, P.cap); px(10, 5, 12, 3, P.cap); px(9, 8, 15, 1, P.capDk);
      px(11, 9, 10, 6, P.skin); px(11, 9, 2, 6, P.skinDk); px(13, 11, 1, 1, P.eye); px(17, 11, 1, 1, P.eye);
      px(12, 14, 8, 1, P.skinDk);
      px(9, 15, 14, 8, P.jkt); px(9, 15, 2, 8, P.jktDk); px(14, 15, 4, 8, P.jktDk);
      px(7, 16 + arms[f][0], 2, 6, P.jkt); px(23, 16 + arms[f][1], 2, 6, P.jkt);
      px(7, 21 + arms[f][0], 2, 2, P.skin); px(23, 21 + arms[f][1], 2, 2, P.skin);
      px(19, 15, 2, 8, P.bag);
      px(11, 23, 4, 5 + legs[f][0], P.pants); px(17, 23, 4, 5 + legs[f][1], P.pants);
      px(10, 28 + legs[f][0], 5, 2, P.shoe); px(17, 28 + legs[f][1], 5, 2, P.shoe);
    }
    outlineSheet(ctx, sheet.width, sheet.height, '#0b1220');
    return sheet;
  }

  function shade(hex, k) {
    const [r, g, b] = hexRGB(hex);
    return `rgb(${(r * k * 255) | 0},${(g * k * 255) | 0},${(b * k * 255) | 0})`;
  }

  /** 1-px outline: any transparent pixel touching an opaque one is painted. */
  function outlineSheet(ctx, w, h, colour) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data, out = new Uint8ClampedArray(d);
    const [cr, cg, cb] = hexRGB(colour).map((v) => (v * 255) | 0);
    const opaque = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 127;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] > 127) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
        out[i] = cr; out[i + 1] = cg; out[i + 2] = cb; out[i + 3] = 255;
      }
    }
    img.data.set(out);
    ctx.putImageData(img, 0, 0);
  }

  const spriteTex = gl.createTexture();
  function uploadSprite(source) {
    sprite.fw = source.width / SPRITE_FRAMES; sprite.fh = source.height;
    gl.bindTexture(gl.TEXTURE_2D, spriteTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  uploadSprite(drawDefaultSprite());

  const player = {
    active: false,
    x: 0, z: 0,            // world units (10 m each)
    tx: 0, tz: 0,          // smoothing target (geolocation)
    smooth: false,
    facing: 1,             // +1 right, -1 left (sheet is drawn facing right)
    moving: false,
    speed: 4.2,            // m/s — a brisk campus walk
    frame: 0,
    controls: true,
    name: '',
  };
  const keys = new Set();
  let cameraMode = 'orbit';
  const FOLLOW = { dist: 26, pitch: 0.55 };

  const isTyping = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  };
  const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
  // (keyboard listeners are registered after the AbortController below)

  /* proximity bookkeeping (the Pokémon-Go loop) */
  const inside = new Map();
  let proximityRadiusM = 75;
  let proxTick = 0;

  /* minimap base: building footprints rasterised once at bake */
  let miniBase = null, miniBox = null;
  function buildMinimapBase(model) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const b of model.buildings) for (const [x, z] of b.p) { if (x < x0) x0 = x; if (z < z0) z0 = z; if (x > x1) x1 = x; if (z > z1) z1 = z; }
    miniBox = { x0, z0, x1, z1, w: x1 - x0, h: z1 - z0 };
    const size = 320;
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, size, size);
    // Uniform scale, letterboxed: the campus is wider than tall, and a
    // per-axis scale turned circles into ellipses against the 3D view.
    const s = size / Math.max(miniBox.w, miniBox.h);
    const sx = s, sz = s;
    Object.assign(miniBox, { s, size, ox: (size - miniBox.w * s) / 2, oz: (size - miniBox.h * s) / 2 });
    const path = (pts) => { ctx.beginPath(); pts.forEach(([x, z], i) => i ? ctx.lineTo((x - x0) * sx + miniBox.ox, (z - z0) * sz + miniBox.oz) : ctx.moveTo((x - x0) * sx + miniBox.ox, (z - z0) * sz + miniBox.oz)); };
    ctx.fillStyle = '#12301e';
    for (const l of model.lawns || []) { path(l.p); ctx.fill(); }
    ctx.strokeStyle = '#1f2d47'; ctx.lineWidth = 1;
    for (const r of model.roads || []) { if (!r.m) continue; path(r.p); ctx.stroke(); }
    ctx.fillStyle = '#3d4d70';
    for (const b of model.buildings) { path(b.p); ctx.fill(); }
    miniBase = c;
  }

  function disposeMesh(m) {
    if (!m) return;
    gl.deleteVertexArray(m.vao);
    m.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteBuffer(m.ib);
  }

  const buildStatic = (baked) => mesh(gl, [
    { loc: 0, size: 3, data: baked.positions },
    { loc: 1, size: 3, data: baked.normals },
    { loc: 2, size: 3, data: baked.colors },
    { loc: 3, size: 1, data: baked.emissives },
    { loc: 4, size: 2, data: baked.matTint },
    { loc: 5, size: 2, data: baked.extras },
  ], baked.indices);

  // Metric uniforms for materials.js: set once, never change. World units are
  // 10 m; height carries the renderer's vertical exaggeration.
  for (const prog of [progStatic, progInst, progScene]) {
    prog.use();
    gl.uniform1f(prog.u.uMetersPerUnit, 10.0);
    gl.uniform1f(prog.u.uVScale, VSCALE);
    gl.uniform2f(prog.u.uRibCenter, 0, 0);
  }

  /* ------------------------------- targets ------------------------------ */

  let sceneFB = null, bloomA = null, bloomB = null;
  let W = 0, H = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, quality.dprCap);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = W;
    canvas.height = H;
    disposeFramebuffer(gl, sceneFB);
    disposeFramebuffer(gl, bloomA);
    disposeFramebuffer(gl, bloomB);
    sceneFB = framebuffer(gl, W, H, { depth: true });
    // Bloom is capped at a fixed width (≤ 480 px) so its eight passes cost the
    // same on a 4K laptop as on a phone.
    const bScale = Math.min(1 / BLOOM_DIV, quality.bloomW / W);
    const bw = Math.max(1, (W * bScale) | 0);
    const bh = Math.max(1, (H * bScale) | 0);
    bloomA = framebuffer(gl, bw, bh);
    bloomB = framebuffer(gl, bw, bh);
  }

  /* ------------------------------- camera ------------------------------- */

  const cam = {
    yaw: -0.5, pitch: 0.62, dist: 148,
    targetYaw: -0.5, targetPitch: 0.62, targetDist: 148,
    cx: 0, cz: 0, targetCx: 0, targetCz: 0,
    autoSpin: true,
  };
  const MIN_DIST = 14, MAX_DIST = 330;

  const eye = [0, 0, 0];
  const proj = m4.create();
  const view = m4.create();
  const viewProj = m4.create();

  let dragging = false, panning = false;
  let lastX = 0, lastY = 0, idleAt = performance.now();
  const pointer = { x: -1, y: -1 };

  const markInteraction = () => { idleAt = performance.now(); cam.autoSpin = false; };

  // One controller for every canvas listener, so destroy() detaches the lot.
  const listeners = new AbortController();
  const on = (type, fn, o) => canvas.addEventListener(type, fn, { ...o, signal: listeners.signal });

  on('contextmenu', (e) => e.preventDefault());
  on('pointerdown', (e) => {
    dragging = true;
    panning = e.button === 2 || e.shiftKey;
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    markInteraction();
  });
  on('pointerup', (e) => {
    dragging = false; panning = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  });
  on('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    if (panning) {
      const k = cam.dist * 0.0016;
      const s = Math.sin(cam.yaw), c = Math.cos(cam.yaw);
      cam.targetCx -= (dx * c - dy * s) * k;
      cam.targetCz -= (dx * -s - dy * c) * k;
    } else {
      cam.targetYaw += dx * 0.006;
      cam.targetPitch = Math.max(0.13, Math.min(1.4, cam.targetPitch + dy * 0.005));
    }
    lastX = e.clientX; lastY = e.clientY;
    markInteraction();
  });
  on('pointerleave', () => { pointer.x = -1; pointer.y = -1; });
  on('wheel', (e) => {
    e.preventDefault();
    cam.targetDist = Math.max(MIN_DIST, Math.min(MAX_DIST, cam.targetDist * (1 + e.deltaY * 0.0012)));
    markInteraction();
  }, { passive: false });
  on('click', () => { if (hovered && opts.onSelect) opts.onSelect(hovered); });

  // Player keyboard: document-level so the canvas need not hold focus, but
  // ignored while the user is typing in a field.
  document.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.code];
    if (!k || !player.active || !player.controls || isTyping()) return;
    keys.add(k);
    if (e.code.startsWith('Arrow')) e.preventDefault();
  }, { signal: listeners.signal });
  document.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); }, { signal: listeners.signal });
  window.addEventListener('blur', () => keys.clear(), { signal: listeners.signal });

  /* -------------------------------- state ------------------------------- */

  let campus = null;
  let monuments = [];
  let orbiters = [], beacons = [], distress = [];
  const shockwaves = [];
  let hovered = null;
  const BLACK3 = [0, 0, 0];
  // Retro post-process state; see setRetro().
  const retro = { pixelBlock: 1, levels: 0, scanlines: true };

  /* ---------------------------- model assembly -------------------------- */

  /** A low-poly elm: dark trunk and a two-lobe canopy. */
  function treeParts(x, z, s) {
    const tone = 0.85 + ((x * 7.3 + z * 3.1) % 1 + 1) % 1 * 0.3;
    const leaf = MAT.leaf.map((v) => v * tone);
    return [
      { geo: GEO.prism8, x, z, y: 0, sx: 0.13 * s, sy: 0.85 * s, sz: 0.13 * s, color: MAT.bark, emissive: 0 },
      { geo: GEO.octa, x, z, y: 0.7 * s + 0.55 * s, ry: x, sx: 1.55 * s, sy: 1.1 * s, sz: 1.45 * s, ...matItem(leaf, 'canopy'), emissive: 0.015 },
      { geo: GEO.octa, x: x + 0.18 * s, z: z - 0.14 * s, y: 0.7 * s + 0.95 * s, ry: z, sx: 1.0 * s, sy: 0.85 * s, sz: 0.95 * s, ...matItem(MAT.leafDark, 'canopy'), emissive: 0.01 },
      { geo: GEO.octa, x: x - 0.3 * s, z: z + 0.22 * s, y: 0.7 * s + 0.4 * s, ry: x + z, sx: 0.9 * s, sy: 0.7 * s, sz: 0.9 * s, ...matItem(MAT.leafDark, 'canopy'), emissive: 0.01 },
    ];
  }

  /** A sodium street lamp: thin pole, hot head, and a warm pool at its foot. */
  function lampParts(x, z) {
    return [
      { geo: GEO.prism8, x, z, y: 0, sx: 0.045, sy: 0.95, sz: 0.045, color: MAT.pole, emissive: 0 },
      { geo: GEO.box, x, z, y: 0.92, sx: 0.13, sy: 0.11, sz: 0.13, color: LAMP, emissive: 1.5 },
    ];
  }

  function bakeCampus(model) {
    disposeMesh(staticMesh); disposeMesh(decalMesh); disposeMesh(greenMesh);
    monumentMeshes.forEach(disposeMesh);
    monumentMeshes.clear();

    // --- buildings ---
    const solids = [];
    for (const b of model.buildings) {
      if (b.p.length < 3) continue;
      solids.push({
        geo: extrudePolygon(b.p, b.h * VSCALE),
        // Brick for the campus and the town's houses, ashlar for civic mass,
        // concrete for the commercial boxes. Glass is deliberately not used on
        // ambient buildings: the window pass below is their light source.
        ...matItem(massColour(b.t), b.t === 'university' || HOUSING.has(b.t) ? 'brick'
          : GLASSY.has(b.t) ? 'concreteGrey' : 'limestoneBuff'),
        emissive: HOUSING.has(b.t) ? 0.012 : 0.03,
      });
    }
    // Roof caps: a dark slate skin just above every roof, plus a ridge on the
    // few footprints OSM tags as gabled or hipped.
    for (const b of model.buildings) {
      if (b.p.length < 3) continue;
      const h = b.h * VSCALE;
      solids.push({ geo: polygonGeometry(b.p, h + 0.015), ...matItem(MASS.roof, 'slate'), emissive: 0.0 });
      if (b.r) {
        const xs = b.p.map((q) => q[0]), zs = b.p.map((q) => q[1]);
        const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...zs) - Math.min(...zs);
        solids.push({
          geo: GEO.box, x: (Math.max(...xs) + Math.min(...xs)) / 2, z: (Math.max(...zs) + Math.min(...zs)) / 2, y: h,
          sx: w > d ? w * 0.9 : Math.max(0.3, w * 0.2), sy: Math.min(w, d) * 0.35, sz: w > d ? Math.max(0.3, d * 0.2) : d * 0.9,
          ...matItem(MAT.slate, 'slate'), emissive: 0,
        });
      }
    }
    // Slate caps over the monument footprints, too. Their extrusions are drawn
    // dynamically in the body material so the faction can light them, but a
    // brick or glass roof seen from above reads as a pale slab; every real
    // roof on this campus is slate or metal. The stadium bowl and the Alma
    // Mater pad have no roof to cap.
    for (const mo of model.monuments) {
      if (mo.poly.length < 3 || mo.kind === 'bowl' || mo.id === 'alma-mater') continue;
      const hh = Math.max(mo.h * VSCALE, 2.4);
      solids.push({ geo: polygonGeometry(mo.poly, hh + 0.02), ...matItem(MAT.slate, 'slate'), emissive: 0.0 });
    }
    staticMesh = buildStatic(mergeStatic(solids));

    // --- ground decals: lawns, streets, lane lines, lamp pools ---
    const decals = [];
    for (const l of model.lawns) {
      if (l.p.length < 3) continue;
      decals.push({ geo: polygonGeometry(l.p, 0.02), ...matItem(l.k === 'field' ? MASS.field : MASS.lawn, l.k === 'field' ? 'field' : 'lawn'), emissive: 0.05 });
    }
    for (const r of model.roads) {
      if (r.p.length < 2) continue;
      decals.push({
        geo: ribbonGeometry(r.p, r.w, r.f ? 0.05 : 0.04),
        // Major roads get the dashed centre line from the material (across-
        // ribbon coordinate in extras); walks get expansion joints.
        ...matItem(r.f ? MASS.walk : (r.m ? MASS.roadMajor : MASS.road), r.f ? 'walk' : (r.m ? 'asphaltLine' : 'asphalt')),
        emissive: r.f ? 0.14 : (r.m ? 0.08 : 0.04),
      });
      if (r.m) {
        const dashes = dashedRibbonGeometry(r.p, 0.07, 1.1, 1.5, 0.048);
        decals.push({ geo: dashes, color: MASS.lane, emissive: 0.30 });
      }
    }
    for (const [x, z] of model.lamps || []) {
      decals.push({ geo: ringGeometry(0, 1, 12), x, z, y: 0.062, sx: 0.42, sy: 1, sz: 0.42, color: LAMP, emissive: 0.16 });
    }
    // Parking lots as near-black asphalt pads.
    for (const ring of model.parking || []) {
      if (ring.length >= 3) decals.push({ geo: polygonGeometry(ring, 0.025), ...matItem(MAT.asphalt, 'asphalt'), emissive: 0.0 });
    }
    // Boneyard Creek and the ponds: dark, faintly reflective blue.
    for (const w of model.water || []) {
      if (w.k === 'line' && w.p.length >= 2) decals.push({ geo: ribbonGeometry(w.p, 0.55, 0.035), ...matItem(MAT.water, 'water'), emissive: 0.10 });
      else if (w.k === 'poly' && w.p.length >= 3) decals.push({ geo: polygonGeometry(w.p, 0.035), ...matItem(MAT.water, 'water'), emissive: 0.10 });
    }
    // The Illinois Central line: steel rails over dark ties.
    for (const r of model.rail || []) {
      if (r.length < 2) continue;
      decals.push({ geo: ribbonGeometry(r, 0.34, 0.036), ...matItem(MAT.rail, 'ballast'), emissive: 0.03 });
      decals.push({ geo: dashedRibbonGeometry(r, 0.42, 0.22, 0.32, 0.046), color: MAT.tie, emissive: 0 });
    }
    decalMesh = buildStatic(mergeStatic(decals));

    // --- greenery and lamps ---
    const green = [];
    for (const [x, z, s] of model.trees || []) green.push(...treeParts(x, z, s));
    for (const [x, z] of model.lamps || []) green.push(...lampParts(x, z));
    // Fountains: limestone basin, a lit water disc, and a small jet.
    for (const [x, z, sc] of model.fountains || []) {
      green.push(
        { geo: GEO.prism8, x, z, y: 0, sx: 1.6 * sc, sy: 0.22, sz: 1.6 * sc, ...matItem(MAT.limestone, 'limestoneBuff'), emissive: 0.02 },
        { geo: GEO.prism8, x, z, y: 0.22, sx: 1.35 * sc, sy: 0.04, sz: 1.35 * sc, color: [0.35, 0.65, 0.95], emissive: 0.45 },
        { geo: GEO.octa, x, z, y: 0.35, sx: 0.18 * sc, sy: 0.6 * sc, sz: 0.18 * sc, color: [0.6, 0.85, 1.0], emissive: 0.9 },
      );
    }
    greenMesh = green.length ? buildStatic(mergeStatic(green)) : null;

    for (const mo of model.monuments) {
      if (mo.poly.length < 3) continue;
      const hh = mo.kind === 'statue' ? mo.h * VSCALE : Math.max(mo.h * VSCALE, 2.4);
      monumentMeshes.set(mo.id, build(extrudePolygon(mo.poly, hh)));
    }
  }

  /* ------------------------------ tiled campus -------------------------- */

  const buildStaticRanged = (baked) => ({ ...buildStatic(baked), ranges: baked.ranges });

  function uploadTile(baked) {
    return {
      solid: baked.solid ? buildStaticRanged(baked.solid) : null,
      decal: baked.decal ? buildStatic(baked.decal) : null,
    };
  }
  function disposeTile(meshes) { disposeMesh(meshes.solid); disposeMesh(meshes.decal); }

  /** Minimap frame from the index's core bbox; tiles paint themselves in as they arrive. */
  function initMinimapFromIndex(index) {
    const [lat0, lng0] = index.meta.origin;
    const mpu = index.meta.metersPerUnit || 10;
    const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const [s, w, n, e] = index.meta.coreBbox || index.meta.bbox;
    const x0 = ((w - lng0) * mLng) / mpu, x1 = ((e - lng0) * mLng) / mpu;
    const z0 = -((n - lat0) * mLat) / mpu, z1 = -((s - lat0) * mLat) / mpu;
    miniBox = { x0, z0, x1, z1, w: x1 - x0, h: z1 - z0 };
    const size = 320;
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, size, size);
    const sc = size / Math.max(miniBox.w, miniBox.h);
    Object.assign(miniBox, { s: sc, size, ox: (size - miniBox.w * sc) / 2, oz: (size - miniBox.h * sc) / 2 });
    miniBase = c;
  }
  function paintTileOnMinimap(tile) {
    if (!miniBase || !miniBox) return;
    const ctx = miniBase.getContext('2d');
    const { x0, z0, s: sc, ox, oz } = miniBox;
    const path = (pts) => { ctx.beginPath(); pts.forEach(([x, z], i) => i ? ctx.lineTo((x - x0) * sc + ox, (z - z0) * sc + oz) : ctx.moveTo((x - x0) * sc + ox, (z - z0) * sc + oz)); };
    ctx.fillStyle = '#12301e';
    for (const l of tile.lawns || []) { path(l.p); ctx.fill(); }
    ctx.strokeStyle = '#1f2d47'; ctx.lineWidth = 1;
    for (const r of tile.roads || []) { if (!r.m) continue; path(r.p); ctx.stroke(); }
    ctx.fillStyle = '#3d4d70';
    for (const b of tile.buildings || []) { path(b.p); ctx.fill(); }
  }

  function initTiled(index, url) {
    disposeMesh(staticMesh); disposeMesh(decalMesh); disposeMesh(greenMesh);
    staticMesh = decalMesh = greenMesh = null;
    monumentMeshes.forEach(disposeMesh);
    monumentMeshes.clear();
    if (tiles) tiles.destroy();
    const baseUrl = url.replace(/\/index\.json(\?.*)?$/, '');
    const useWorker = !/[?&]worker=0/.test(location.search) && !opts.noWorker;
    tiles = createTileManager({
      index, baseUrl, useWorker,
      bake: bakeTile, upload: uploadTile, dispose: disposeTile,
      onTile: (tile) => paintTileOnMinimap(tile),
    });
    initMinimapFromIndex(index);
    // Trees and lamps: one instanced template each, instances rebuilt when the resident set changes.
    const instAttrs = [{ loc: 6, size: 4 }];
    const mk = (tpl) => instancedMesh(gl, [
      { loc: 0, size: 3, data: tpl.positions }, { loc: 1, size: 3, data: tpl.normals }, { loc: 2, size: 3, data: tpl.colors },
      { loc: 3, size: 1, data: tpl.emissives }, { loc: 4, size: 2, data: tpl.matTint }, { loc: 5, size: 2, data: tpl.extras },
    ], tpl.indices, instAttrs);
    if (!treeInst) treeInst = mk(treeTemplate());
    if (!lampInst) lampInst = mk(lampTemplate());
    instVersion = -1;
    for (const mo of index.monuments) {
      if (mo.poly.length < 3) continue;
      const hh = mo.kind === 'statue' ? mo.h * VSCALE : Math.max(mo.h * VSCALE, 2.4);
      monumentMeshes.set(mo.id, build(extrudePolygon(mo.poly, hh)));
    }
  }

  function setStaticUniforms(prog, proj, view, t, sweep, fogNear, fogFar) {
    prog.use();
    gl.uniformMatrix4fv(prog.u.uProj, false, proj);
    gl.uniformMatrix4fv(prog.u.uView, false, view);
    gl.uniform1f(prog.u.uTime, t);
    gl.uniform1f(prog.u.uSweep, sweep);
    gl.uniform1f(prog.u.uSweepK, quality.sweepK);
    setFog(prog, fogNear, fogFar);
  }

  function drawTiles(proj, view, t, sweep, fogNear, fogFar, now) {
    tiles.update({ target: [cam.cx, cam.cz], player: player.active ? [player.x, player.z] : null, now, opts: bakeOpts });
    const selected = tiles.select(viewProj, [cam.cx, cam.cz], player.active ? [player.x, player.z] : null);
    frameStats.tilesDrawn = selected.length;
    frameStats.tris = tiles.stats.tris;
    let draws = 0;

    setStaticUniforms(progStatic, proj, view, t, sweep, fogNear, fogFar);
    gl.disable(gl.CULL_FACE);
    gl.uniform1f(progStatic.u.uWindows, 0);
    for (const s of selected) {
      const d = s.resident.meshes.decal;
      if (!d) continue;
      gl.bindVertexArray(d.vao);
      gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, 0);
      draws++;
    }
    gl.enable(gl.CULL_FACE);
    gl.uniform1f(progStatic.u.uWindows, quality.windows ? 1 : 0);
    for (const s of selected) {
      const m = s.resident.meshes.solid;
      if (!m) continue;
      const range = m.ranges[s.lod];
      if (!range || !range.count) continue;
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.first * 4);
      draws++;
    }

    // Greenery instances follow the resident set (not the frustum: the GPU culls
    // cheaply); on the low/med tiers they are re-filtered by distance every 250 ms.
    const filtered = quality.treeDist < Infinity;
    if (tiles.version !== instVersion || (filtered && now - instAt > 250)) {
      const all = [...tiles.resident.values()].map((r) => ({ resident: r, lod: r.lod }));
      const inst = tiles.instances(all, { treeMaxDist: quality.treeDist, target: [cam.cx, cam.cz] });
      treeInst.setInstances(inst.trees, inst.trees.length / 4);
      lampInst.setInstances(inst.lamps.length ? (() => { const rows = new Float32Array((inst.lamps.length / 2) * 4); for (let i = 0, j = 0; i < inst.lamps.length; i += 2, j += 4) { rows[j] = inst.lamps[i]; rows[j + 1] = inst.lamps[i + 1]; rows[j + 2] = 1; rows[j + 3] = 1; } return rows; })() : new Float32Array(0), inst.lamps.length / 2);
      instVersion = tiles.version; instAt = now;
    }
    setStaticUniforms(progInst, proj, view, t, sweep, fogNear, fogFar);
    gl.uniform1f(progInst.u.uWindows, 0);
    drawInstanced(gl, treeInst); draws++;
    drawInstanced(gl, lampInst); draws++;
    frameStats.draws = draws;
  }

  /* ------------------------------ draw utils ---------------------------- */

  const model = m4.create();

  function drawMesh(m, o) {
    const sx = o.sx || 1e-4, sy = o.sy || 1e-4, sz = o.sz || 1e-4;
    m4.trs(o.x || 0, o.y || 0, o.z || 0, o.ry || 0, sx, sy, sz, model);
    gl.uniformMatrix4fv(progScene.u.uModel, false, model);
    gl.uniform3f(progScene.u.uInvScaleSq, 1 / (sx * sx), 1 / (sy * sy), 1 / (sz * sz));
    gl.uniform3fv(progScene.u.uColor, o.color);
    gl.uniform3fv(progScene.u.uEmissive, o.emissive || o.color);
    gl.uniform1f(progScene.u.uEmissiveK, o.emissiveK ?? 1);
    gl.uniform1f(progScene.u.uAlpha, o.alpha ?? 1);
    gl.uniform1f(progScene.u.uRim, o.rim ?? 0.8);
    gl.uniform1f(progScene.u.uFadeTop, o.fadeTop ?? 0);
    gl.uniform1f(progScene.u.uAlbedoK, o.albedoK ?? 0.0);
    gl.uniform1f(progScene.u.uFlood, o.flood ?? 0.0);
    // Procedural material: explicit `mat`, else inferred from the MAT colour
    // reference, else none. Tint keeps the tuned night brightness.
    const mid = o.mat ?? (o.color ? matIdFor(o.color) : 0);
    gl.uniform1i(progScene.u.uMat, mid);
    if (mid) gl.uniform1f(progScene.u.uTintK, o.tint ?? tintFor(o.color, mid));
    gl.uniform2f(progScene.u.uRibCenter, o.ribX ?? 0, o.ribZ ?? 0);
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
  }

  function blit(prog, srcTex, dst, setup) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, dst ? dst.w : W, dst ? dst.h : H);
    prog.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    if (setup) setup();
    gl.bindVertexArray(MESH.quad.vao);
    gl.drawElements(gl.TRIANGLES, MESH.quad.count, gl.UNSIGNED_INT, 0);
  }

  function projectToScreen(x, y, z) {
    const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (cw <= 0) return null;
    return { x: (cx / cw * 0.5 + 0.5) * canvas.clientWidth, y: (-cy / cw * 0.5 + 0.5) * canvas.clientHeight, w: cw };
  }

  /** Footprint body material per monument, from design/refs/MATERIALS.md. */
  const BODY = {
    'alma-mater': MAT.granite, 'illini-union': MAT.brick, foellinger: MAT.brick,
    altgeld: MAT.limestoneGrey, siebel: MAT.glass, eceb: MAT.glass, grainger: MAT.brick,
    dcl: MAT.brickBuff, kenney: MAT.brick, stadium: MAT.concreteGrey, 'state-farm': MAT.concrete,
    'main-library': MAT.brick, beckman: MAT.buff, krannert: MAT.brickDark,
  };

  /* --------------------------- monument silhouettes --------------------- */

  /** Solid architectural piece: real albedo, faction as rim light only. */
  const stone = (mat, mo, hot) => ({
    color: mat, emissive: mo.colour, emissiveK: hot ? 0.10 : 0.04, rim: hot ? 1.1 : 0.7, albedoK: 0.95, flood: 0.45,
  });

  /** Glowing faction element: crystals, lanterns, energy. */
  const glow = (mo, k) => ({ color: mo.colour, emissive: mo.colour, emissiveK: k, rim: 2.4, albedoK: 0 });

  /** Warm architectural lighting: uplights on columns, window strips. */
  const warm = (k) => ({ color: LAMP, emissive: LAMP, emissiveK: k, rim: 0, albedoK: 0 });

  /** Position along the building's long axis, in world space. */
  function along(mo, u, v) {
    const c = Math.cos(mo.ry), s = Math.sin(mo.ry);
    return { x: mo.cx + u * c + v * s, z: mo.cz - u * s + v * c };
  }

  /** A row of columns between two local points, uplit from below. */
  function colonnade(mo, hot, count, u0, v0, u1, v1, h, r = 0.11, mat = MAT.limestone) {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const { x, z } = along(mo, u0 + (u1 - u0) * t, v0 + (v1 - v0) * t);
      drawMesh(MESH.prism, { x, y: 0, z, sx: r * 2, sy: h, sz: r * 2, ...stone(mat, mo, hot) });
    }
    // Uplight wash at each end of the row.
    const a = along(mo, u0, v0), b = along(mo, u1, v1);
    drawMesh(MESH.octa, { x: a.x, y: 0.15, z: a.z, sx: 0.16, sy: 0.16, sz: 0.16, ...warm(2.2) });
    drawMesh(MESH.octa, { x: b.x, y: 0.15, z: b.z, sx: 0.16, sy: 0.16, sz: 0.16, ...warm(2.2) });
  }

  function crownCrystal(mo, t, hot, lift) {
    const k = hot ? 1.7 : 1.0;
    drawMesh(MESH.octa, {
      x: mo.cx, y: mo.h + lift + Math.sin(t * 1.2 + mo.phase) * 0.18, z: mo.cz, ry: -t * 0.8,
      sx: 0.72, sy: 1.1, sz: 0.72, ...glow(mo, 3.3 * k),
    });
  }

  /**
   * Landmark-specific mass on top of the extruded footprint. Every piece uses
   * the building's real material; the faction shows as light on it.
   */
  function drawMonumentCrown(mo, t, hot) {
    const { cx, cz } = mo;
    const base = mo.h;
    const L = Math.max(mo.spanX, mo.spanZ), S = Math.min(mo.spanX, mo.spanZ);

    switch (mo.id) {
      case 'alma-mater': {
        // Polished granite base, then the bronze group: Alma standing before
        // her throne with arms outstretched, Learning and Labor behind the
        // throne clasping hands over its back. Restored to bare bronze in
        // 2014, so no green patina.
        // Warm bronze, lifted for the floodlights. Deliberately no green: the
        // 2014 restoration stripped the patina, and the faction aura already
        // throws a cool cast the eye would read as verdigris.
        const B = MAT.bronzeFlood;
        const K = 1.5; // the group is 13 ft; at map scale it needs presence
        drawMesh(MESH.box, { x: cx, y: 0, z: cz, sx: 2.1, sy: 0.6, sz: 1.5, ...stone(MAT.granite, mo, hot) });
        drawMesh(MESH.box, { x: cx, y: 0.6, z: cz, sx: 1.55, sy: 0.32, sz: 1.05, ...stone(MAT.granite, mo, hot) });
        const top = 0.92;
        // Throne behind Alma.
        drawMesh(MESH.box, { x: cx, y: top, z: cz + 0.32 * K, sx: 0.9 * K, sy: 0.75 * K, sz: 0.28 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        drawMesh(MESH.box, { x: cx, y: top + 0.75 * K, z: cz + 0.36 * K, sx: 0.98 * K, sy: 0.12 * K, sz: 0.2 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        // Alma: robe, torso, head.
        drawMesh(MESH.prism8, { x: cx, y: top, z: cz - 0.05 * K, sx: 0.5 * K, sy: 1.15 * K, sz: 0.42 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        drawMesh(MESH.prism8, { x: cx, y: top + 1.1 * K, z: cz - 0.05 * K, sx: 0.38 * K, sy: 0.55 * K, sz: 0.32 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        drawMesh(MESH.octa, { x: cx, y: top + 1.87 * K, z: cz - 0.05 * K, sx: 0.22 * K, sy: 0.30 * K, sz: 0.22 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        drawMesh(MESH.box, { x: cx - 0.55 * K, y: top + 1.45 * K, z: cz - 0.05 * K, ry: 0.15, sx: 1.0 * K, sy: 0.12 * K, sz: 0.14 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        drawMesh(MESH.box, { x: cx + 0.55 * K, y: top + 1.45 * K, z: cz - 0.05 * K, ry: -0.15, sx: 1.0 * K, sy: 0.12 * K, sz: 0.14 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        // Learning (left) and Labor (right) standing behind the throne.
        for (const side of [-1, 1]) {
          drawMesh(MESH.prism8, { x: cx + side * 0.62 * K, y: top, z: cz + 0.45 * K, sx: 0.42 * K, sy: 1.05 * K, sz: 0.36 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
          drawMesh(MESH.prism8, { x: cx + side * 0.62 * K, y: top + 1.0 * K, z: cz + 0.45 * K, sx: 0.34 * K, sy: 0.5 * K, sz: 0.28 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
          drawMesh(MESH.octa, { x: cx + side * 0.62 * K, y: top + 1.72 * K, z: cz + 0.45 * K, sx: 0.2 * K, sy: 0.27 * K, sz: 0.2 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        }
        // Clasped hands over the throne back.
        drawMesh(MESH.box, { x: cx, y: top + 1.15 * K, z: cz + 0.42 * K, sx: 1.2 * K, sy: 0.1 * K, sz: 0.12 * K, ...stone(B, mo, hot), rim: 0.25, albedoK: 1.25, flood: 0.9 });
        // Floodlit at night from the plinth corners.
        for (const [dx, dz] of [[-1.25, 0.95], [1.25, 0.95], [-1.25, -0.95], [1.25, -0.95]]) {
          drawMesh(MESH.octa, { x: cx + dx, y: 0.1, z: cz + dz, sx: 0.14, sy: 0.14, sz: 0.14, ...warm(2.8) });
        }
        crownCrystal(mo, t, hot, 5.0);
        break;
      }

      case 'illini-union': {
        // Georgian brick under a slate roof: white cornice and pediment, brick
        // chimneys, and the white clock cupola with its dark cap.
        drawMesh(MESH.box, { x: cx, y: base, z: cz, ry: mo.ry, sx: L * 1.0, sy: 0.14, sz: S * 1.0, ...stone(MAT.trim, mo, hot) });
        drawMesh(MESH.box, { x: cx, y: base + 0.14, z: cz, ry: mo.ry, sx: L * 0.94, sy: 0.55, sz: S * 0.6, ...stone(MAT.slate, mo, hot) });
        for (const u of [-L * 0.33, -L * 0.11, L * 0.11, L * 0.33]) {
          const { x, z } = along(mo, u, S * 0.12);
          drawMesh(MESH.box, { x, y: base + 0.5, z, ry: mo.ry, sx: 0.22, sy: 0.55, sz: 0.22, ...stone(MAT.brick, mo, hot) });
        }
        drawMesh(MESH.prism8, { x: cx, y: base + 0.69, z: cz, sx: 0.7, sy: 0.9, sz: 0.7, ...stone(MAT.trim, mo, hot) });
        drawMesh(MESH.octa, { x: cx, y: base + 1.15, z: cz, sx: 0.3, sy: 0.32, sz: 0.3, ...warm(1.6) });
        drawMesh(MESH.spire, { x: cx, y: base + 1.59, z: cz, sx: 0.78, sy: 0.7, sz: 0.78, ...stone(MAT.slate, mo, hot) });
        // Pediment and portico columns on the Quad face.
        const face = S * 0.5 + 0.3;
        const pc = along(mo, 0, face);
        drawMesh(MESH.spire4, { x: pc.x, y: base * 0.98, z: pc.z, ry: mo.ry + Math.PI / 4, sx: L * 0.22, sy: 0.35, sz: 0.9, ...stone(MAT.trim, mo, hot) });
        colonnade(mo, hot, 6, -L * 0.14, face, L * 0.14, face, base * 0.95, 0.1, MAT.trim);
        crownCrystal(mo, t, hot, 2.8);
        break;
      }

      case 'altgeld': {
        // Romanesque sandstone; the square campanile stands at the Green &
        // Wright corner with four turrets around a pyramidal cap.
        const tw = along(mo, L * 0.34, -S * 0.32);
        const th = 3.4;
        drawMesh(MESH.box, { x: tw.x, y: base * 0.3, z: tw.z, ry: mo.ry, sx: 1.25, sy: th, sz: 1.25, ...stone(MAT.limestoneGrey, mo, hot) });
        drawMesh(MESH.box, { x: tw.x, y: base * 0.3 + th, z: tw.z, ry: mo.ry, sx: 1.45, sy: 0.18, sz: 1.45, ...stone(MAT.archStone, mo, hot) });
        for (const [du, dv] of [[-0.55, -0.55], [0.55, -0.55], [0.55, 0.55], [-0.55, 0.55]]) {
          const c = Math.cos(mo.ry), s = Math.sin(mo.ry);
          const x = tw.x + du * c + dv * s, z = tw.z - du * s + dv * c;
          drawMesh(MESH.prism8, { x, y: base * 0.3 + th + 0.18, z, sx: 0.26, sy: 0.55, sz: 0.26, ...stone(MAT.limestoneGrey, mo, hot) });
          drawMesh(MESH.spire, { x, y: base * 0.3 + th + 0.73, z, sx: 0.30, sy: 0.42, sz: 0.30, ...stone(MAT.slate, mo, hot) });
        }
        drawMesh(MESH.spire4, { x: tw.x, y: base * 0.3 + th + 0.18, z: tw.z, ry: mo.ry + Math.PI / 4, sx: 1.2, sy: 1.4, sz: 1.2, ...stone(MAT.tile, mo, hot) });
        // Belfry openings glow — the chimes' loft.
        drawMesh(MESH.box, { x: tw.x, y: base * 0.3 + th - 0.9, z: tw.z, ry: mo.ry, sx: 1.28, sy: 0.3, sz: 1.28, ...warm(0.4) });
        // Gabled hall roof in orange tile.
        drawMesh(MESH.spire4, { x: cx, y: base, z: cz, ry: mo.ry + Math.PI / 4, sx: L * 0.98, sy: 0.32, sz: S * 0.98, ...stone(MAT.slate, mo, hot) });
        crownCrystal(mo, t, hot, 2.4);
        break;
      }

      case 'foellinger': {
        // Limestone rotunda with a green copper dome, a lantern, and the
        // north portico facing the Quad.
        const r = mo.radius;
        drawMesh(MESH.prism, { x: cx, y: base, z: cz, sx: r * 1.9, sy: 0.22, sz: r * 1.9, ...stone(MAT.limestone, mo, hot) });
        drawMesh(MESH.prism, { x: cx, y: base + 0.22, z: cz, sx: r * 1.55, sy: 0.35, sz: r * 1.55, ...stone(MAT.brick, mo, hot) });
        drawMesh(MESH.dome, { x: cx, y: base + 0.57, z: cz, sx: r * 1.55, sy: r * 0.95, sz: r * 1.55, ...stone(MAT.copper, mo, hot), mat: MID.verdigrisDome, ribX: cx, ribZ: cz });
        // The dome carries 396 embedded lights — rings of warm points.
        for (let ring = 0; ring < 3; ring++) {
          const phi = 0.35 + ring * 0.42;
          const rr = r * 0.775 * Math.cos(phi), yy = base + 0.57 + r * 0.475 * Math.sin(phi);
          const n = 18 - ring * 4;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + ring * 0.2;
            drawMesh(MESH.octa, { x: cx + Math.cos(a) * rr, y: yy, z: cz + Math.sin(a) * rr, sx: 0.09, sy: 0.09, sz: 0.09, ...warm(2.4) });
          }
        }
        const cap = base + 0.57 + r * 0.475;
        drawMesh(MESH.prism8, { x: cx, y: cap, z: cz, sx: 0.55, sy: 0.55, sz: 0.55, ...stone(MAT.copper, mo, hot) });
        drawMesh(MESH.spire, { x: cx, y: cap + 0.55, z: cz, sx: 0.5, sy: 0.5, sz: 0.5, ...stone(MAT.copper, mo, hot) });
        drawMesh(MESH.octa, { x: cx, y: cap + 0.3, z: cz, sx: 0.3, sy: 0.3, sz: 0.3, ...warm(1.8) });
        // Portico on the north face (toward the Quad, -z).
        colonnade(mo, hot, 6, -r * 0.55, -r * 0.98 - 0.35, r * 0.55, -r * 0.98 - 0.35, base * 0.9, 0.11);
        drawMesh(MESH.box, { x: cx, y: base * 0.9, z: cz - r * 0.98 - 0.35, sx: r * 1.3, sy: 0.22, sz: 0.9, ...stone(MAT.limestone, mo, hot) });
        crownCrystal(mo, t, hot, r * 0.475 + 2.4);
        break;
      }

      case 'state-farm': {
        // The folded-edge saucer: a low concrete drum, a scalloped rim of
        // tilted plates, and the shallow white dome.
        const r = mo.radius;
        drawMesh(MESH.prism, { x: cx, y: 0, z: cz, sx: r * 1.2, sy: base * 0.55, sz: r * 1.2, ...stone(MAT.concrete, mo, hot), ribX: cx, ribZ: cz });
        drawMesh(MESH.prism, { x: cx, y: base * 0.55, z: cz, sx: r * 2.05, sy: 0.3, sz: r * 2.05, ...stone(MAT.concrete, mo, hot), ribX: cx, ribZ: cz });
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          drawMesh(MESH.box, {
            x: cx + Math.cos(a) * r * 0.98, y: base * 0.55 + 0.3, z: cz + Math.sin(a) * r * 0.98, ry: -a,
            sx: 0.32, sy: 0.55, sz: r * 0.27, ...stone(MAT.concrete, mo, hot),
          });
        }
        drawMesh(MESH.dome, { x: cx, y: base * 0.55 + 0.3, z: cz, sx: r * 1.95, sy: r * 0.55, sz: r * 1.95, ...stone(MAT.concrete, mo, hot), ribX: cx, ribZ: cz });
        // The whole rim reads as a lit band at night: warm concourse light
        // spills up under the folded edge.
        drawMesh(MESH.ring, { x: cx, y: base * 0.55 + 0.02, z: cz, sx: r * 1.02, sy: 1, sz: r * 1.02, color: LAMP, emissive: LAMP, emissiveK: 1.4, rim: 0, albedoK: 0 });
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + 0.2;
          drawMesh(MESH.octa, { x: cx + Math.cos(a) * r * 0.9, y: base * 0.3, z: cz + Math.sin(a) * r * 0.9, sx: 0.22, sy: 0.22, sz: 0.22, ...warm(2.4) });
        }
        crownCrystal(mo, t, hot, r * 0.3 + 2.4);
        break;
      }

      case 'stadium': {
        // Limestone bowl with the colonnades along both long sides, and the
        // floodlight masts.
        // Real height is ~35 m; the vertical exaggeration would make it a wall.
        const bh = Math.max(base * 0.5, 2.6);
        drawMesh(MESH.bowl, { x: cx, y: 0, z: cz, ry: mo.ry, sx: mo.spanX, sy: bh, sz: mo.spanZ, ...stone(MAT.concreteGrey, mo, hot) });
        for (let tier = 1; tier <= 4; tier++) {
          const k = 0.36 * 0.62 + (0.36 - 0.36 * 0.62) * (tier / 5);
          drawMesh(MESH.ring, { x: cx, y: 0.12 + (bh - 0.12) * (tier / 5), z: cz, ry: mo.ry, sx: mo.spanX * k * 2, sy: 1, sz: mo.spanZ * k * 2, ...stone(MAT.limestone, mo, hot), albedoK: 0.5 });
        }
        drawMesh(MESH.ring, { x: cx, y: bh + 0.02, z: cz, ry: mo.ry, sx: mo.spanX * 0.98, sy: 1, sz: mo.spanZ * 0.98, ...warm(0.55) });
        drawMesh(MESH.box, { x: cx, y: 0.1, z: cz, ry: mo.ry, sx: L * 0.44, sy: 0.05, sz: S * 0.44, ...stone(MAT.field, mo, hot), albedoK: 1.6 });
        for (const u of [-L * 0.19, L * 0.19]) {
          const e = along(mo, u, 0);
          drawMesh(MESH.box, { x: e.x, y: 0.11, z: e.z, ry: mo.ry, sx: L * 0.04, sy: 0.05, sz: S * 0.3, color: BRAND.orange, emissive: BRAND.orange, emissiveK: 0.35, rim: 0, albedoK: 1.2 });
        }
        const half = L * 0.4, side = S * 0.53;
        // East and west colonnades stand proud of the bowl — some 200 columns
        // in the real thing, on brick-and-stone great halls.
        for (const v of [-side, side]) {
          const c = along(mo, 0, v);
          drawMesh(MESH.box, { x: c.x, y: 0, z: c.z, ry: mo.ry, sx: L * 0.84, sy: bh * 0.55, sz: 0.9, ...stone(MAT.brick, mo, hot) });
          colonnade(mo, hot, 20, -half, v + (v > 0 ? 0.5 : -0.5), half, v + (v > 0 ? 0.5 : -0.5), bh * 0.9, 0.12);
        }
        // The horseshoe closes at the south end (local -u is +z here) and opens
        // north, where the brick end pavilions stand.
        const nEnd = along(mo, -L * 0.52, 0);
        drawMesh(MESH.box, { x: nEnd.x, y: 0, z: nEnd.z, ry: mo.ry, sx: 1.8, sy: bh * 1.1, sz: S * 0.7, ...stone(MAT.brick, mo, hot) });
        for (const v of [-S * 0.5, S * 0.5]) {
          const c = along(mo, L * 0.5, v);
          drawMesh(MESH.box, { x: c.x, y: 0, z: c.z, ry: mo.ry, sx: 1.6, sy: bh * 0.95, sz: 1.6, ...stone(MAT.brick, mo, hot) });
        }
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          const x = cx + Math.cos(a) * mo.spanX * 0.56, z = cz + Math.sin(a) * mo.spanZ * 0.56;
          drawMesh(MESH.prism8, { x, y: 0, z, sx: 0.14, sy: bh + 2.0, sz: 0.14, ...stone(MAT.pole, mo, hot) });
          drawMesh(MESH.box, { x, y: bh + 2.0, z, sx: 0.55, sy: 0.22, sz: 0.18, ...warm(2.8) });
        }
        crownCrystal(mo, t, hot, bh - base + 4.6);
        break;
      }

      case 'eceb': {
        // Glass box wrapped in vertical terracotta fins; a rooftop solar array.
        const n = Math.max(6, Math.round(L * 1.6));
        for (let i = 0; i < n; i++) {
          const u = -L * 0.48 + (L * 0.96) * (i / (n - 1));
          for (const v of [-S * 0.5 - 0.05, S * 0.5 + 0.05]) {
            const { x, z } = along(mo, u, v);
            drawMesh(MESH.box, { x, y: 0.2, z, ry: mo.ry, sx: 0.12, sy: base - 0.3, sz: 0.28, ...stone(MAT.terracotta, mo, hot) });
          }
        }
        for (let f = 1; f <= 4; f++) {
          drawMesh(MESH.box, { x: cx, y: base * (f / 5) - 0.04, z: cz, ry: mo.ry, sx: L * 0.98, sy: 0.07, sz: S * 1.005, color: [0.72, 0.84, 1.0], emissive: [0.72, 0.84, 1.0], emissiveK: 0.3, rim: 0, albedoK: 0 });
        }
        drawMesh(MESH.box, { x: cx, y: base, z: cz, ry: mo.ry, sx: L * 0.8, sy: 0.12, sz: S * 0.7, ...stone(MAT.steel, mo, hot) });
        drawMesh(MESH.box, { x: cx, y: base + 0.12, z: cz, ry: mo.ry, sx: L * 0.5, sy: 0.05, sz: S * 0.5, ...glow(mo, 0.35) });
        crownCrystal(mo, t, hot, 2.2);
        break;
      }

      case 'beckman': {
        // Glass block with a lit crown band and a rooftop lantern.
        for (const yy of [base * 0.33, base * 0.66]) {
          drawMesh(MESH.box, { x: cx, y: yy, z: cz, ry: mo.ry, sx: L * 1.01, sy: 0.08, sz: S * 1.01, ...stone(MAT.granite, mo, hot) });
        }
        drawMesh(MESH.box, { x: cx, y: base, z: cz, ry: mo.ry, sx: L * 0.5, sy: 1.1, sz: S * 0.5, ...stone(MAT.glassGreen, mo, hot) });
        drawMesh(MESH.box, { x: cx, y: base + 1.1, z: cz, ry: mo.ry, sx: L * 0.5, sy: 0.05, sz: S * 0.5, ...warm(0.5) });
        // The arched limestone gateway with its lantern posts on the south approach.
        const g = along(mo, 0, S * 0.5 + 0.9);
        drawMesh(MESH.box, { x: g.x, y: 0, z: g.z, ry: mo.ry, sx: 1.6, sy: 1.2, sz: 0.5, ...stone(MAT.buff, mo, hot) });
        for (const u of [-0.95, 0.95]) {
          const q = along(mo, u, S * 0.5 + 0.9);
          drawMesh(MESH.box, { x: q.x, y: 0, z: q.z, sx: 0.28, sy: 1.0, sz: 0.28, ...stone(MAT.granite, mo, hot) });
          drawMesh(MESH.octa, { x: q.x, y: 1.1, z: q.z, sx: 0.16, sy: 0.2, sz: 0.16, ...warm(2.2) });
        }
        crownCrystal(mo, t, hot, 2.4);
        break;
      }

      case 'krannert': {
        const ft = along(mo, L * 0.28, -S * 0.1);
        drawMesh(MESH.box, { x: ft.x, y: base, z: ft.z, ry: mo.ry, sx: L * 0.3, sy: 1.6, sz: S * 0.45, ...stone(MAT.brickDark, mo, hot) });
        const gp = along(mo, -L * 0.25, 0);
        drawMesh(MESH.box, { x: gp.x, y: base, z: gp.z, ry: mo.ry, sx: L * 0.3, sy: 0.5, sz: S * 0.5, ...stone(MAT.glass, mo, hot) });
        drawMesh(MESH.box, { x: gp.x, y: base + 0.5, z: gp.z, ry: mo.ry, sx: L * 0.28, sy: 0.05, sz: S * 0.48, ...warm(0.6) });
        const st = along(mo, 0, S * 0.5 + 0.6);
        drawMesh(MESH.box, { x: st.x, y: 0, z: st.z, ry: mo.ry, sx: L * 0.7, sy: 0.35, sz: 1.2, ...stone(MAT.limestone, mo, hot) });
        crownCrystal(mo, t, hot, 3.2);
        break;
      }

      default: {
        // Brick halls and towers: limestone parapet, rooftop plant, and a
        // glass atrium block on Siebel.
        drawMesh(MESH.box, { x: cx, y: base, z: cz, ry: mo.ry, sx: L * 1.0, sy: 0.12, sz: S * 1.0, ...stone(MAT.limestone, mo, hot) });
        drawMesh(MESH.box, { x: cx + 0.2, y: base + 0.12, z: cz - 0.1, ry: mo.ry, sx: Math.min(L * 0.32, 2.4), sy: 0.36, sz: Math.min(S * 0.3, 1.8), ...stone(MAT.granite, mo, hot) });
        if (mo.id === 'siebel' || mo.id === 'dcl') {
          for (let f = 1; f <= 3; f++) {
            drawMesh(MESH.box, { x: cx, y: base * (f / 4) - 0.04, z: cz, ry: mo.ry, sx: L * 1.005, sy: 0.08, sz: S * 1.005, ...warm(mo.id === 'siebel' ? 0.42 : 0.22) });
          }
        }
        if (mo.id === 'siebel') {
          // Glass upper storey and the verdigris copper drum over the atrium.
          const { x, z } = along(mo, L * 0.22, S * 0.15);
          drawMesh(MESH.box, { x, y: base + 0.12, z, ry: mo.ry, sx: Math.min(L * 0.5, 4.0), sy: 0.7, sz: Math.min(S * 0.5, 2.4), ...stone(MAT.glass, mo, hot) });
          drawMesh(MESH.box, { x, y: base + 0.12, z, ry: mo.ry, sx: Math.min(L * 0.5, 4.0) - 0.1, sy: 0.05, sz: Math.min(S * 0.5, 2.4) - 0.1, ...warm(0.7) });
          const d = along(mo, -L * 0.1, 0);
          drawMesh(MESH.prism, { x: d.x, y: base * 0.55, z: d.z, sx: 2.8, sy: base * 0.45 + 0.9, sz: 2.8, ...stone(MAT.copper, mo, hot) });
        }
        if (mo.id === 'grainger') {
          // Slate hipped roof with the two brick chimneys.
          drawMesh(MESH.spire4, { x: cx, y: base + 0.12, z: cz, ry: mo.ry + Math.PI / 4, sx: L * 0.96, sy: 0.9, sz: S * 0.96, ...stone(MAT.metalRoof, mo, hot) });
          drawMesh(MESH.box, { x: cx, y: base + 0.5, z: cz, ry: mo.ry, sx: L * 0.6, sy: 0.06, sz: 0.5, ...glow(mo, 0.25) });
          for (const u of [-L * 0.36, L * 0.36]) {
            const c = along(mo, u, 0);
            drawMesh(MESH.box, { x: c.x, y: base + 0.5, z: c.z, ry: mo.ry, sx: 0.3, sy: 0.7, sz: 0.3, ...stone(MAT.brick, mo, hot) });
          }
        }
        // Entrance uplights along the long facade.
        colonnade(mo, hot, 1, -L * 0.3, S * 0.5 + 0.2, L * 0.3, S * 0.5 + 0.2, 0.01, 0.01, MAT.pole);
        crownCrystal(mo, t, hot, 2.3);
      }
    }
  }

  /* ------------------------------- the frame ---------------------------- */

  // Reused payload objects: onFrame runs 60×/s and must not allocate.
  const playerPayload = { x: 0, z: 0, facing: 1, moving: false, screen: null, name: '' };
  const framePayload = { projectToScreen, hovered: null, monuments: null, time: 0, dist: 0, cameraMode: 'orbit', player: null };

  let raf = 0;
  const t0 = performance.now();
  let lastNow = t0;

  function setFog(prog, near, far) {
    gl.uniform3fv(prog.u.uCamPos, eye);
    gl.uniform3fv(prog.u.uFogColor, FOG);
    gl.uniform1f(prog.u.uFogNear, near);
    gl.uniform1f(prog.u.uFogFar, far);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    resize();
    if (!W || !H) return;

    const t = (now - t0) / 1000;

    const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now;

    // Player: keyboard walk in camera space, or geolocation smoothing.
    if (player.active) {
      let mx = 0, mz = 0;
      if (player.controls && keys.size) {
        const f = (keys.has('up') ? 1 : 0) - (keys.has('down') ? 1 : 0);
        const r = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
        if (f || r) {
          // Forward is away from the camera; right is the camera's right.
          const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
          const fx = -sy, fz = -cy, rx = cy, rz = -sy;
          const len = Math.hypot(f, r) || 1;
          const step = (player.speed / 10) * dt / len;
          mx = (fx * f + rx * r) * step; mz = (fz * f + rz * r) * step;
        }
      }
      // A keyboard step also moves the smoothing target; otherwise the next
      // frame's GPS easing pulls the player straight back to the last fix.
      if (mx || mz) { player.tx = player.x + mx; player.tz = player.z + mz; }
      if (player.smooth && !(mx || mz)) {
        mx += (player.tx - player.x) * Math.min(1, dt * 4);
        mz += (player.tz - player.z) * Math.min(1, dt * 4);
      }
      player.moving = Math.hypot(mx, mz) > 1e-4;
      if (player.moving) {
        player.x += mx; player.z += mz;
        const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
        const screenX = mx * cy - mz * sy;
        if (Math.abs(screenX) > 1e-5) player.facing = screenX > 0 ? 1 : -1;
        player.frame = Math.floor(t * 8) % SPRITE_FRAMES;
      } else {
        player.frame = 0;
      }
      if (cameraMode === 'follow') {
        cam.targetCx = player.x; cam.targetCz = player.z;
        cam.targetDist = FOLLOW.dist; cam.targetPitch = FOLLOW.pitch;
        cam.autoSpin = false; idleAt = now;
      }
      // Proximity, every 6th frame — the enter/leave edge is what the UI needs.
      if ((proxTick++ % 6) === 0 && opts.onProximity) checkProximity();
    }

    if (!dragging && now - idleAt > 5000 && cameraMode !== 'follow') cam.autoSpin = true;
    if (cam.autoSpin) cam.targetYaw += 0.0007;

    cam.yaw += (cam.targetYaw - cam.yaw) * 0.09;
    cam.pitch += (cam.targetPitch - cam.pitch) * 0.09;
    cam.dist += (cam.targetDist - cam.dist) * 0.09;
    cam.cx += (cam.targetCx - cam.cx) * 0.1;
    cam.cz += (cam.targetCz - cam.cz) * 0.1;

    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    eye[0] = cam.cx + Math.sin(cam.yaw) * cp * cam.dist;
    eye[1] = sp * cam.dist;
    eye[2] = cam.cz + Math.cos(cam.yaw) * cp * cam.dist;

    m4.perspective(0.78, W / H, 0.5, 1400, proj);
    m4.lookAt(eye, [cam.cx, cam.dist * 0.035, cam.cz], [0, 1, 0], view);
    m4.multiply(proj, view, viewProj);

    const sweep = (-t * 0.55) % (Math.PI * 2);
    const fogNear = cam.dist * 0.55;
    const fogFar = cam.dist * 3.2;

    /* ---- pass 1: scene into the HDR target ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFB.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(SKY_HORIZON[0], SKY_HORIZON[1], SKY_HORIZON[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Sky: no depth, everything else paints over it.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    progSky.use();
    gl.uniform1f(progSky.u.uYaw, cam.yaw);
    gl.uniform1f(progSky.u.uPitch, cam.pitch);
    gl.uniform1f(progSky.u.uTime, t);
    gl.uniform2f(progSky.u.uRes, W, H);
    gl.uniform3fv(progSky.u.uZenith, SKY_ZENITH);
    gl.uniform3fv(progSky.u.uHorizon, SKY_HORIZON);
    gl.bindVertexArray(MESH.quad.vao);
    gl.drawElements(gl.TRIANGLES, MESH.quad.count, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Ground: two-sided so the plane survives any orbit angle.
    gl.disable(gl.CULL_FACE);
    progGround.use();
    gl.uniformMatrix4fv(progGround.u.uProj, false, proj);
    gl.uniformMatrix4fv(progGround.u.uView, false, view);
    gl.uniform1f(progGround.u.uTime, t);
    gl.uniform1f(progGround.u.uSweep, sweep);
    gl.uniform1f(progGround.u.uGridScale, 0.1);
    gl.uniform3f(progGround.u.uGrid, 0.10, 0.17, 0.34);
    gl.uniform3f(progGround.u.uAccent, 0.10, 0.40, 0.62);
    gl.uniform3fv(progGround.u.uBase, GROUND);
    gl.uniform3fv(progGround.u.uHorizon, SKY_HORIZON);
    setFog(progGround, fogNear, fogFar);
    gl.bindVertexArray(MESH.plane.vao);
    gl.drawElements(gl.TRIANGLES, MESH.plane.count, gl.UNSIGNED_INT, 0);

    if (staticMesh) {
      progStatic.use();
      gl.uniformMatrix4fv(progStatic.u.uProj, false, proj);
      gl.uniformMatrix4fv(progStatic.u.uView, false, view);
      gl.uniform1f(progStatic.u.uTime, t);
      gl.uniform1f(progStatic.u.uSweep, sweep);
      gl.uniform1f(progStatic.u.uSweepK, quality.sweepK);
      setFog(progStatic, fogNear, fogFar);

      gl.uniform1f(progStatic.u.uWindows, 0);
      gl.bindVertexArray(decalMesh.vao);
      gl.drawElements(gl.TRIANGLES, decalMesh.count, gl.UNSIGNED_INT, 0);

      gl.enable(gl.CULL_FACE);
      gl.uniform1f(progStatic.u.uWindows, quality.windows ? 1 : 0);
      gl.bindVertexArray(staticMesh.vao);
      gl.drawElements(gl.TRIANGLES, staticMesh.count, gl.UNSIGNED_INT, 0);

      if (greenMesh) {
        gl.uniform1f(progStatic.u.uWindows, 0);
        gl.bindVertexArray(greenMesh.vao);
        gl.drawElements(gl.TRIANGLES, greenMesh.count, gl.UNSIGNED_INT, 0);
      }
    }

    if (!staticMesh && tiles) drawTiles(proj, view, t, sweep, fogNear, fogFar, now);

    gl.enable(gl.CULL_FACE);
    progScene.use();
    gl.uniformMatrix4fv(progScene.u.uProj, false, proj);
    gl.uniformMatrix4fv(progScene.u.uView, false, view);
    gl.uniform1f(progScene.u.uTime, t);
    gl.uniform1f(progScene.u.uFogMode, 0);
    setFog(progScene, fogNear, fogFar);

    hovered = null;
    if (pointer.x >= 0) {
      let best = 52;
      for (const mo of monuments) {
        const s = projectToScreen(mo.cx, mo.h + 1.6, mo.cz);
        if (!s) continue;
        const d = Math.hypot(s.x - pointer.x, s.y - pointer.y);
        if (d < best) { best = d; hovered = mo; }
      }
    }
    canvas.style.cursor = hovered ? 'pointer' : (dragging ? 'grabbing' : 'grab');

    /* ---- monuments: real footprint in its material + landmark crown ---- */
    for (const mo of monuments) {
      const hot = hovered === mo;
      const fm = monumentMeshes.get(mo.id);
      if (fm && mo.kind === 'bowl') {
        // The bowl replaces the outline; extruding it would hide the field.
      } else if (fm && mo.id !== 'alma-mater') {
        drawMesh(fm, stone(BODY[mo.id] || MAT[mo.mat] || MAT.brick, mo, hot));
      } else if (fm) {
        // Alma Mater's plinth footprint is granite paving.
        drawMesh(fm, { ...stone(MAT.granite, mo, hot), albedoK: 0.9 });
      }
      drawMonumentCrown(mo, t, hot);
    }

    for (const o of orbiters) {
      const a = t * o.speed + o.phase;
      drawMesh(MESH.octa, {
        x: o.cx + Math.cos(a) * o.radius, y: o.baseY + Math.sin(t * 2.1 + o.phase) * 0.16, z: o.cz + Math.sin(a) * o.radius,
        ry: t * 1.6 + o.phase, sx: 0.3, sy: 0.45, sz: 0.3,
        color: o.color, emissive: o.color, emissiveK: 3.4, rim: 2.0, albedoK: 0,
      });
    }
    for (const b of beacons) {
      drawMesh(MESH.octa, {
        x: b.x, y: b.y + Math.sin(t * 1.5 + b.phase) * 0.14, z: b.z, ry: t * 1.4 + b.phase,
        sx: 0.34, sy: 0.55, sz: 0.34,
        color: b.color, emissive: b.color, emissiveK: b.inRange ? 3.4 : 1.2, rim: 2.2, albedoK: 0,
      });
    }
    for (const s of distress) {
      drawMesh(MESH.cone, {
        x: s.x, y: s.y + Math.abs(Math.sin(t * 2.4 + s.phase)) * 0.4, z: s.z, ry: t * 1.1,
        sx: 0.7, sy: 1.0, sz: 0.7,
        color: s.color, emissive: s.color, emissiveK: 3.4, rim: 2.0, albedoK: 0,
      });
    }

    /* ---- remote trainers: one instanced, depth-tested draw ---- */
    if (playerLayer && playerLayer.count()) {
      const rx0 = view[0], rz0 = view[8];
      const rl0 = Math.hypot(rx0, rz0) || 1;
      playerLayer.update({ x: cam.cx, z: cam.cz }, (f) => factionColours[f] || '#5d7096', now, t);
      playerLayer.draw(proj, view, new Float32Array([rx0 / rl0, 0, rz0 / rl0]));
      progScene.use();
    }

    /* ---- player: ground shadow, then the billboard sprite ---- */
    if (player.active) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      drawMesh(MESH.disc, { x: player.x, y: 0.07, z: player.z, sx: 0.55, sy: 1, sz: 0.42,
        color: BLACK3, emissive: BLACK3, emissiveK: 0, rim: 0, alpha: 0.42, mat: 0, albedoK: 0 });
      gl.disable(gl.BLEND);
      gl.depthMask(true);

      // The sprite is a marker: drawn over everything so the Quad elms and
      // building corners can never hide the player. The shadow above stays
      // depth-tested, which keeps the figure visually anchored to the ground.
      gl.disable(gl.DEPTH_TEST);
      progSprite.use();
      gl.uniformMatrix4fv(progSprite.u.uProj, false, proj);
      gl.uniformMatrix4fv(progSprite.u.uView, false, view);
      // Camera right in world space, flattened so the sprite stays upright.
      const rx = view[0], rz = view[8];
      const rl = Math.hypot(rx, rz) || 1;
      gl.uniform3f(progSprite.u.uRight, rx / rl, 0, rz / rl);
      gl.uniform3f(progSprite.u.uCenter, player.x, 0.06, player.z);
      // Height tracks frame height; half-width follows the frame's own aspect,
      // so a 32x48 avatar is 1.5x taller than a 32x32 one, not 1.5x thinner.
      const spriteH = 1.3 * (sprite.fh / 32);
      gl.uniform2f(progSprite.u.uSize, 0.5 * spriteH * (sprite.fw / sprite.fh), spriteH);
      gl.uniform1f(progSprite.u.uFrame, player.frame);
      gl.uniform1f(progSprite.u.uFrames, SPRITE_FRAMES);
      gl.uniform1f(progSprite.u.uFlip, player.facing < 0 ? 1 : 0);
      gl.uniform1f(progSprite.u.uGlow, 0.3);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, spriteTex);
      gl.uniform1i(progSprite.u.uTex, 0);
      gl.bindVertexArray(MESH.quad.vao);
      gl.drawElements(gl.TRIANGLES, MESH.quad.count, gl.UNSIGNED_INT, 0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.enable(gl.DEPTH_TEST);
      progScene.use();
      gl.enable(gl.CULL_FACE);
    }

    /* ---- additive light: auras, rings, columns, shockwaves ---- */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.uniform1f(progScene.u.uFogMode, 1);

    for (const mo of monuments) {
      const r = mo.auraR;
      drawMesh(MESH.disc, { x: mo.cx, y: 0.09, z: mo.cz, sx: r, sy: 1, sz: r, color: mo.colour, emissiveK: 0.12, alpha: 0.5, rim: 0 });
      for (let i = 0; i < 2; i++) {
        const rr = r * (0.72 + i * 0.22);
        drawMesh(MESH.ring, { x: mo.cx, y: 0.11 + i * 0.01, z: mo.cz, ry: t * (i ? -0.3 : 0.42), sx: rr, sy: 1, sz: rr, color: mo.colour, emissiveK: 0.85 - i * 0.32, alpha: 0.8, rim: 0 });
      }
      // The beacon starts above the crown so it never overlays the building
      // itself — on the statue it was passing straight through the figures
      // and tinting the bronze.
      const beaconBase = mo.kind === 'statue' ? mo.h + 5.2 : mo.h + 1.2;
      drawMesh(MESH.prism8, { x: mo.cx, y: beaconBase, z: mo.cz, ry: t * 0.1, sx: 0.34, sy: 40, sz: 0.34, color: mo.colour, emissiveK: 0.05, alpha: 0.15, rim: 0 });
    }
    for (const b of beacons) {
      const r = b.radius * (1 + Math.sin(t * 1.4 + b.phase) * 0.03);
      drawMesh(MESH.ring, { x: b.x, y: 0.1, z: b.z, ry: t * 0.5, sx: r, sy: 1, sz: r, color: b.color, emissiveK: b.inRange ? 0.9 : 0.32, alpha: 0.8, rim: 0 });
    }
    for (const s of distress) {
      for (let i = 0; i < 3; i++) {
        const ph = (t * 0.6 + i / 3 + s.phase) % 1;
        const r = 0.8 + ph * 4.2;
        drawMesh(MESH.ring, { x: s.x, y: 0.12, z: s.z, sx: r, sy: 1, sz: r, color: s.color, emissiveK: 1.6 * (1 - ph), alpha: 1 - ph, rim: 0 });
      }
    }
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const s = shockwaves[i];
      const age = (now - s.born) / s.life;
      if (age >= 1) { shockwaves.splice(i, 1); continue; }
      const r = 0.8 + age * s.reach;
      drawMesh(MESH.ring, { x: s.x, y: 0.15, z: s.z, sx: r, sy: 1, sz: r, color: s.color, emissiveK: 2.8 * (1 - age), alpha: 1 - age, rim: 0 });
    }

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);

    /* ---- pass 2: bloom ---- */
    gl.disable(gl.DEPTH_TEST);
    blit(progBright, sceneFB.tex, bloomA, () => {
      gl.uniform1i(progBright.u.uTex, 0);
      gl.uniform1f(progBright.u.uThreshold, 0.62);
    });
    for (let i = 0; i < 3; i++) {
      blit(progBlur, bloomA.tex, bloomB, () => { gl.uniform1i(progBlur.u.uTex, 0); gl.uniform2f(progBlur.u.uDir, 1.3 / bloomA.w, 0); });
      blit(progBlur, bloomB.tex, bloomA, () => { gl.uniform1i(progBlur.u.uTex, 0); gl.uniform2f(progBlur.u.uDir, 0, 1.3 / bloomA.h); });
    }

    /* ---- pass 3: composite ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    progComposite.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneFB.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
    gl.uniform1i(progComposite.u.uScene, 0);
    gl.uniform1i(progComposite.u.uBloom, 1);
    gl.uniform1f(progComposite.u.uBloomK, 0.95);
    gl.uniform1f(progComposite.u.uPixel, retro.blockCss > 1 ? retro.blockCss * Math.min(window.devicePixelRatio || 1, 2) : 1);
    gl.uniform1f(progComposite.u.uPosterize, retro.levels);
    gl.uniform1f(progComposite.u.uScanlines, retro.scanlines ? 1 : 0);
    gl.uniform1f(progComposite.u.uTime, t);
    gl.uniform2f(progComposite.u.uRes, W, H);
    gl.bindVertexArray(MESH.quad.vao);
    gl.drawElements(gl.TRIANGLES, MESH.quad.count, gl.UNSIGNED_INT, 0);
    // Release the samplers: sceneFB.tex becomes next frame's render target.
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Frame-time EMA drives the auto tier: step down past 22 ms, up again after
    // 5 s under 12 ms. A probe run records raw samples for p50/p95.
    // A hidden tab or a clamped (≥ 100 ms) frame says nothing about the GPU:
    // rAF is throttled there, and reacting would drop the tier for no reason.
    const dtMs = dt * 1000;
    const measurable = !document.hidden && dtMs < 99 && W > 8 && H > 8;
    if (measurable) quality.ema = quality.ema * 0.95 + dtMs * 0.05;
    if (measurable && quality.tier === 'auto' && !quality.reduced) {
      if (quality.ema > 22 && quality.level > 0) { applyLevel(quality.level - 1); quality.lastUp = now; }
      else if (quality.ema < 12 && quality.level < 2 && now - quality.lastUp > 5000) { applyLevel(quality.level + 1); quality.lastUp = now; }
    }
    if (probeRun) {
      if (measurable) probeRun.samples.push(dtMs);
      cam.targetYaw += 0.012;
      cam.targetDist = 60 + 90 * (0.5 + 0.5 * Math.sin((now - probeRun.start) / 1600));
      if (now - probeRun.start >= probeRun.ms) {
        const sorted = probeRun.samples.slice(1).sort((a, b) => a - b);
        const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
        const result = { p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), fps: +(1000 / Math.max(0.1, pct(0.5))).toFixed(1), frames: sorted.length, ...api.getStats() };
        const { resolve } = probeRun; probeRun = null; resolve(result);
      }
    }

    if (opts.onFrame) {
      framePayload.time = t; framePayload.dist = cam.dist; framePayload.hovered = hovered;
      framePayload.monuments = monuments; framePayload.cameraMode = cameraMode;
      if (player.active) {
        playerPayload.x = player.x; playerPayload.z = player.z;
        playerPayload.facing = player.facing; playerPayload.moving = player.moving;
        playerPayload.screen = projectToScreen(player.x, 1.35, player.z);
        framePayload.player = playerPayload;
      } else framePayload.player = null;
      opts.onFrame(framePayload);
    }
  }

  /* ------------------------------ proximity ---------------------------- */

  function nearbyList(radiusM) {
    const out = [];
    const r2 = (radiusM / 10) ** 2;
    const push = (kind, id, x, z, ref) => {
      const d2 = (x - player.x) ** 2 + (z - player.z) ** 2;
      if (d2 <= r2) out.push({ kind, id, distanceMeters: Math.sqrt(d2) * 10, ref });
    };
    for (const mo of monuments) push('monument', mo.id, mo.cx, mo.cz, mo);
    if (playerLayer) for (const p of playerLayer.list()) push('player', p.id, p.x, p.z, p);
    beacons.forEach((b, i) => push('beacon', b.id ?? `beacon-${i}`, b.x, b.z, b));
    distress.forEach((d, i) => push('distress', d.id ?? `sos-${i}`, d.x, d.z, d));
    out.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return out;
  }

  /** Enter at ≤ r, leave at > 1.25 r — hysteresis so a boundary walk does not flicker. */
  function checkProximity() {
    const enterR = proximityRadiusM, leaveR = proximityRadiusM * 1.25;
    const seen = nearbyList(leaveR);
    const nowInside = new Set();
    for (const n of seen) {
      const key = `${n.kind}:${n.id}`;
      if (!inside.has(key) && n.distanceMeters <= enterR) {
        inside.set(key, n);
        try { opts.onProximity({ kind: n.kind, id: n.id, distanceMeters: n.distanceMeters, entered: true, target: n.ref }); }
        catch (err) { console.error('onProximity', err); }
      }
      if (inside.has(key)) nowInside.add(key);
    }
    for (const [key, n] of [...inside]) {
      if (!nowInside.has(key)) {
        inside.delete(key);
        try { opts.onProximity({ kind: n.kind, id: n.id, distanceMeters: n.distanceMeters, entered: false, target: n.ref }); }
        catch (err) { console.error('onProximity', err); }
      }
    }
  }

  /* ------------------------------- public API --------------------------- */

  const api = {
    /**
     * Loads and bakes a campus model. The default is the active content pack's
     * bake as served by the server (`/dashboard/content/`); app.js passes
     * `Nexus.contentUrl('campus')`, which reads the same path from the pack
     * descriptor when it is available.
     */
    async loadCampus(url = '/dashboard/content/campus.json') {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`campus model ${res.status}`);
      campus = await res.json();
      if (campus.meta && campus.meta.schema === 2) {
        // Tiled whole-campus bake: streamed by tiles.js, baked in the worker.
        initTiled(campus, url);
      } else {
        bakeCampus(campus);
        buildMinimapBase(campus);
      }

      monuments = campus.monuments.map((mo, i) => {
        const xs = mo.poly.map((p) => p[0]);
        const zs = mo.poly.map((p) => p[1]);
        const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs));
        const spanZ = Math.max(1, Math.max(...zs) - Math.min(...zs));
        return {
          ...mo,
          h: mo.kind === 'statue' ? mo.h * VSCALE : Math.max(mo.h * VSCALE, 2.4),
          cx: mo.c[0], cz: mo.c[1],
          spanX, spanZ,
          radius: Math.max(spanX, spanZ) / 2,
          auraR: Math.max(spanX, spanZ) * 0.62 + 1.2,
          ry: spanZ > spanX ? Math.PI / 2 : 0,
          phase: i * 1.31,
          colour: hexRGB('#5d7096'),
          deep: hexRGB('#5d7096').map((v) => v * 0.16),
          faction: 'NEUTRAL',
          cp: 0,
        };
      });
      if (opts.onReady) opts.onReady(monuments, campus.meta);
      return { monuments, meta: campus.meta };
    },

    getMonuments: () => monuments,

    setFactions(map) {
      for (const mo of monuments) {
        const s = map[mo.id] || map[mo.venue];
        if (!s) continue;
        mo.colour = typeof s.color === 'string' ? hexRGB(s.color) : s.color;
        mo.deep = mo.colour.map((v) => v * 0.16);
        mo.faction = s.faction || mo.faction;
        mo.cp = s.cp ?? mo.cp;
      }
    },

    setActors({ orbiters: o = [], beacons: b = [], distress: d = [] }) {
      const conv = (c) => (typeof c === 'string' ? hexRGB(c) : c);
      orbiters = o.map((v, i) => ({ baseY: 0.5, speed: 0.5, radius: 3, ...v, color: conv(v.color), phase: v.phase ?? i * 0.9 }));
      beacons = b.map((v, i) => ({ y: 1.0, radius: 2.2, ...v, color: conv(v.color), phase: v.phase ?? i * 1.3 }));
      distress = d.map((v, i) => ({ y: 0.5, ...v, color: conv(v.color), phase: v.phase ?? i * 0.7 }));
    },

    pulse(x, z, color = '#22E8FF', { reach = 9, life = 1300 } = {}) {
      shockwaves.push({ x, z, color: hexRGB(color), born: performance.now(), reach, life });
    },

    /**
     * Ease the camera onto a monument. `immediate` snaps instead — useful for
     * deep links and for capturing a frame from a background tab, where
     * requestAnimationFrame is paused and the easing never runs.
     */
    focus(id, { dist = 46, pitch = 0.5, yaw, immediate = false } = {}) {
      const mo = monuments.find((m) => m.id === id || m.venue === id);
      if (!mo) return false;
      cam.targetCx = mo.cx;
      cam.targetCz = mo.cz;
      cam.targetDist = dist;
      cam.targetPitch = pitch;
      if (yaw !== undefined) cam.targetYaw = yaw;
      if (immediate) {
        cam.cx = cam.targetCx; cam.cz = cam.targetCz;
        cam.dist = cam.targetDist; cam.pitch = cam.targetPitch; cam.yaw = cam.targetYaw;
      }
      markInteraction();
      return true;
    },

    resetView() {
      cam.targetCx = 0; cam.targetCz = 0;
      cam.targetDist = 148; cam.targetPitch = 0.62; cam.targetYaw = -0.5;
      markInteraction();
    },

    getHovered: () => hovered,
    project: projectToScreen,

    /* ------------------------------ player API ----------------------------- */

    /** Place (and show) the player at world coordinates. */
    setPlayer({ x = 0, z = 0, name, faction } = {}) {
      player.x = player.tx = x; player.z = player.tz = z;
      player.active = true;
      if (name !== undefined) { player.name = name; playerPayload.name = name; }
      if (faction) uploadSprite(drawDefaultSprite(faction));
      return true;
    },
    hidePlayer() { player.active = false; keys.clear(); inside.clear(); },
    getPlayer: () => (player.active ? { x: player.x, z: player.z, facing: player.facing, moving: player.moving } : null),

    /** Nudge by world units (10 m each); for click-to-move or joystick UIs. */
    movePlayer(dx, dz) {
      if (!player.active) return;
      player.x += dx; player.z += dz; player.tx = player.x; player.tz = player.z;
      if (Math.abs(dx) > 1e-6) player.facing = dx > 0 ? 1 : -1;
      player.moving = true; player.frame = (player.frame + 1) % SPRITE_FRAMES;
    },
    setPlayerControls(enabled) { player.controls = !!enabled; if (!enabled) keys.clear(); },
    setPlayerSpeed(mps) { player.speed = Math.max(0.5, mps); },

    /**
     * Replace the avatar. Accepts a 32×32 canvas/ImageData/Image (one frame,
     * replicated into a 4-frame cycle with a 1-px bob) or a 128×32 sheet.
     */
    setPlayerSprite(source) {
      const w = source.width, h = source.height;
      const frameOK = (h === 32 || h === 48);
      // Full sheet: 4 frames side by side (128×32 or 128×48), frames = stand /
      // left step / stand / right step.
      if (frameOK && w === SPRITE_PX * SPRITE_FRAMES) { uploadSprite(source); return true; }
      if (!frameOK || w !== SPRITE_PX) return false;
      const sheet = document.createElement('canvas');
      sheet.width = SPRITE_PX * SPRITE_FRAMES; sheet.height = h;
      const ctx = sheet.getContext('2d');
      let src = source;
      if (source instanceof ImageData) {
        src = document.createElement('canvas'); src.width = w; src.height = h;
        src.getContext('2d').putImageData(source, 0, 0);
      }
      for (let f = 0; f < SPRITE_FRAMES; f++) ctx.drawImage(src, f * SPRITE_PX, (f === 1 || f === 3) ? -1 : 0);
      uploadSprite(sheet);
      return true;
    },

    /**
     * Drive the player from GPS. Same frame as build-campus.py: origin at the
     * Main Quad, +x east, +z south, 10 m per unit. Positions outside the model
     * clamp to its bbox, so an off-campus phone still shows a sprite at the edge.
     */
    setPlayerLatLng(lat, lng) {
      if (!campus) return null;
      const [lat0, lng0] = campus.meta.origin;
      const mpu = campus.meta.metersPerUnit || 10;
      const mLat = 111320, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
      let x = ((lng - lng0) * mLng) / mpu;
      let z = -((lat - lat0) * mLat) / mpu;
      const [s, w, n, e] = campus.meta.bbox;
      const onCampus = lat >= s && lat <= n && lng >= w && lng <= e;
      if (!onCampus) {
        const xw = ((w - lng0) * mLng) / mpu, xe = ((e - lng0) * mLng) / mpu;
        const zn = -((n - lat0) * mLat) / mpu, zs = -((s - lat0) * mLat) / mpu;
        x = Math.max(xw, Math.min(xe, x)); z = Math.max(zn, Math.min(zs, z));
      }
      if (!player.active) { player.x = x; player.z = z; player.active = true; }
      player.tx = x; player.tz = z; player.smooth = true;
      return { x, z, onCampus };
    },

    setCameraMode(mode, { immediate = false } = {}) {
      cameraMode = mode === 'follow' ? 'follow' : 'orbit';
      if (cameraMode === 'follow' && !player.active) api.setPlayer({});
      if (cameraMode === 'follow' && immediate) {
        cam.cx = cam.targetCx = player.x; cam.cz = cam.targetCz = player.z;
        cam.dist = cam.targetDist = FOLLOW.dist; cam.pitch = cam.targetPitch = FOLLOW.pitch;
      }
      markInteraction();
    },

    /**
     * Retro post-process. pixelation 0..1 → block size 1..4 CSS px (scaled by
     * DPR so the blocks are square on screen); posterize 0..1 → 0 (off) to
     * 5 levels per channel at 1; scanlines on/off. Default: off, off, on.
     */
    setRetro({ pixelation = 0, posterize = 0, scanlines = retro.scanlines } = {}) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const block = 1 + Math.round(Math.max(0, Math.min(1, pixelation)) * 3);
      retro.blockCss = block;
      retro.pixelBlock = block > 1 ? block * dpr : 1;
      const px = Math.max(0, Math.min(1, posterize));
      retro.levels = px > 0 ? Math.round(24 - px * 19) : 0;   // 24 levels at 0.05 … 5 at 1
      retro.scanlines = !!scanlines;
    },
    getRetro: () => ({ ...retro }),
    getCameraMode: () => cameraMode,

    /* --------------------------- multiplayer (B4) ------------------------- */

    /**
     * Replace the set of remote trainers. Each entry: `{ id, x, z, h, faction, name,
     * avatarHash, kind, stale }` in world units. Positions are snapshots — the layer
     * interpolates between them and renders 1 s behind, which matches the 1 Hz deltas.
     */
    setPlayers(list) {
      if (!playerLayer) playerLayer = createPlayerLayer(gl, { program: progPlayers });
      playerLayer.setPlayers(Array.isArray(list) ? list : []);
      return playerLayer.count();
    },

    /** Upload a peer's 128×48 walk sheet into the atlas, keyed by hash. */
    registerAvatar(hash, image) {
      if (!playerLayer) playerLayer = createPlayerLayer(gl, { program: progPlayers });
      if (!image || image.width !== SLOT_W || image.height !== SLOT_H) return -1;
      return playerLayer.registerAvatar(hash, image);
    },

    /** A takedown: drop the texture so nobody keeps drawing it. */
    forgetAvatar(hash) {
      return playerLayer ? playerLayer.forgetAvatar(hash) : false;
    },

    hasAvatar: (hash) => (playerLayer ? playerLayer.knownAvatar(hash) : false),
    getPlayers: () => (playerLayer ? playerLayer.list() : []),
    getPlayerStats: () => (playerLayer ? { ...playerLayer.stats } : { drawn: 0, sprites: 0, pills: 0, clusters: 0, slots: 0 }),

    /** Faction id → hex, so remote pills and clusters match the map's colours. */
    setFactionColours(map) {
      factionColours = { ...map };
    },

    setProximityRadius(m) { proximityRadiusM = Math.max(5, m); },
    getNearby: (radiusM = proximityRadiusM) => (player.active ? nearbyList(radiusM) : []),

    /** Top-down pixel map into a caller-owned 2D canvas. One drawImage + a few rects. */
    renderMinimap(c2d) {
      if (!miniBase || !c2d) return false;
      const ctx = c2d.getContext('2d');
      const W2 = c2d.width, H2 = c2d.height;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(miniBase, 0, 0, W2, H2);
      const px = (x) => (((x - miniBox.x0) * miniBox.s + miniBox.ox) / miniBox.size) * W2;
      const pz = (z) => (((z - miniBox.z0) * miniBox.s + miniBox.oz) / miniBox.size) * H2;
      for (const mo of monuments) {
        const [r, g, b] = mo.colour;
        ctx.fillStyle = `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
        ctx.fillRect(Math.round(px(mo.cx)) - 3, Math.round(pz(mo.cz)) - 3, 6, 6);
      }
      ctx.fillStyle = '#a78bfa';
      for (const b of beacons) ctx.fillRect(Math.round(px(b.x)) - 1, Math.round(pz(b.z)) - 1, 3, 3);
      ctx.fillStyle = '#ff4d6a';
      for (const d of distress) ctx.fillRect(Math.round(px(d.x)) - 2, Math.round(pz(d.z)) - 2, 4, 4);
      if (player.active) {
        const x = Math.round(px(player.x)), z = Math.round(pz(player.z));
        ctx.fillStyle = '#0b1220'; ctx.fillRect(x - 4, z - 4, 8, 8);
        ctx.fillStyle = '#ff5f05'; ctx.fillRect(x - 3, z - 3, 6, 6);
      }
      return true;
    },

    /**
     * Quality tiers (plan §B3). 'low' = DPR 1, windows off, near trees only,
     * 320 px bloom; 'med' = DPR 1.5; 'high' = DPR 2; 'auto' steps by frame
     * time. An object form turns individual effects off: { bloom, grain,
     * scanlines, chroma, targetFps } — used by the reduced-motion path.
     */
    setQuality(tier) {
      if (tier && typeof tier === 'object') {
        if (tier.scanlines === false) retro.scanlines = false;
        if (tier.bloom === false || tier.sweep === false) quality.sweepK = 0;
        if (tier.targetFps && tier.targetFps <= 30) { quality.tier = 'low'; applyLevel(0); }
        quality.reduced = true;
        return api.getQuality();
      }
      const name = String(tier || 'auto');
      quality.tier = LEVEL_NAMES.includes(name) ? name : 'auto';
      quality.reduced = false;
      if (quality.tier !== 'auto') applyLevel(LEVEL_NAMES.indexOf(quality.tier));
      else applyLevel(2);
      return api.getQuality();
    },
    getQuality: () => ({ tier: quality.tier, level: LEVEL_NAMES[quality.level], dprCap: quality.dprCap, windows: quality.windows, treeDist: quality.treeDist }),
    getStats: () => ({
      fps: +(1000 / Math.max(0.1, quality.ema)).toFixed(1), frameMs: +quality.ema.toFixed(2),
      tris: Math.round(frameStats.tris), tilesDrawn: frameStats.tilesDrawn, tilesResident: tiles ? tiles.resident.size : 0,
      draws: frameStats.draws, quality: LEVEL_NAMES[quality.level], tier: quality.tier, worker: tiles ? tiles.stats.worker : false, tiled: !!tiles,
      players: playerLayer ? playerLayer.count() : 0, playerDraws: playerLayer ? playerLayer.stats.drawn : 0,
    }),
    /** `?probe=1`: a scripted 10 s orbit that resolves with p50/p95 frame ms and the draw stats. */
    probe(seconds = 10) {
      return new Promise((resolve) => {
        markInteraction();
        cam.autoSpin = false;
        probeRun = { start: performance.now(), ms: seconds * 1000, samples: [], resolve };
      });
    },

    destroy() {
      cancelAnimationFrame(raf);
      listeners.abort();
      disposeFramebuffer(gl, sceneFB);
      disposeFramebuffer(gl, bloomA);
      disposeFramebuffer(gl, bloomB);
      Object.values(MESH).forEach(disposeMesh);
      monumentMeshes.forEach(disposeMesh);
      monumentMeshes.clear();
      disposeMesh(staticMesh);
      disposeMesh(decalMesh);
      disposeMesh(greenMesh);
      if (tiles) tiles.destroy();
      if (playerLayer) playerLayer.destroy();
      if (treeInst) { disposeMesh(treeInst); gl.deleteBuffer(treeInst.instanceBuffer); }
      if (lampInst) { disposeMesh(lampInst); gl.deleteBuffer(lampInst.instanceBuffer); }
      gl.deleteTexture(spriteTex);
      for (const p of [progScene, progStatic, progInst, progPlayers, progGround, progSky, progBright, progBlur, progComposite, progSprite]) {
        gl.deleteProgram(p.handle);
      }
    },
  };

  // Reduced motion: a static-friendly tier, no sweep, no scanlines.
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq && mq.matches) api.setQuality({ bloom: false, grain: false, scanlines: false, chroma: false, targetFps: 30 });
  } catch { /* no matchMedia */ }

  raf = requestAnimationFrame(frame);
  return api;
}
