/**
 * materials — procedural surfaces for the campus renderer.
 *
 * No textures (the dashboard's CSP is 'self'-only, and a texture atlas would be
 * the wrong tool anyway): every material is a pure GLSL function of world
 * position, world normal and time. Albedos come from the reference photographs
 * in design/refs (see MATERIALS.md there) and are daylight values — the caller
 * lights them for night.
 *
 * ---------------------------------------------------------------------------
 * INTEGRATION (fragment shader)
 * ---------------------------------------------------------------------------
 *
 *   1. Append `MATERIAL_GLSL` to the fragment shader source AFTER the
 *      `precision` line and any `uniform`/`in` declarations, BEFORE `main()`:
 *
 *        const FS = `#version 300 es
 *        precision highp float;
 *        in vec3 vN, vW;
 *        flat in int vMat;               // or a uniform int uMat
 *        uniform float uTime;
 *        ${MATERIAL_GLSL}
 *        void main() { ... }`;
 *
 *   2. Set the metric uniforms once per program (they never change):
 *
 *        gl.uniform1f(p.u.uMetersPerUnit, 10.0);   // world unit → metres
 *        gl.uniform1f(p.u.uVScale, 2.6);           // vertical exaggeration
 *
 *      Optional per-draw: `uRibCenter` (vec2 world xz) for radially ribbed
 *      surfaces (domes, the State Farm saucer); defaults to the origin.
 *
 *   3. In `main()`, replace the flat-colour lighting input:
 *
 *        Surface s = material(vMat, vW, normalize(vN), uTime);
 *        vec3 N = normalize(normalize(vN) + s.nrm);       // perturbed normal
 *        vec3 col = s.albedo * (ambient + diffuse(N)) + s.emissive;
 *        // s.rough (0 = mirror, 1 = matte) can scale the rim/spec term.
 *
 *      Five-line version:
 *
 *        Surface s = material(uMat, vW, normalize(vN), uTime);
 *        vec3 N = normalize(normalize(vN) + s.nrm);
 *        float d = max(dot(N, L1), 0.0) * 0.75 + max(dot(N, L2), 0.0) * 0.28;
 *        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6) * (1.0 - s.rough * 0.6);
 *        frag = vec4(s.albedo * (0.12 + d) + s.albedo * rim * 0.4 + s.emissive, 1.0);
 *
 *   The `extra` argument (5-arg overload) carries surface-local data a pattern
 *   cannot derive from world space: for MAT_ASPHALT_LINE, `extra.x` is the
 *   signed across-ribbon distance in metres (0 at the centre line). Pass
 *   vec2(0.0) or use the 4-arg overload when you have nothing.
 *
 * ---------------------------------------------------------------------------
 * DERIVATIVES
 * ---------------------------------------------------------------------------
 * Every fwidth() is evaluated at the top of material(), unconditionally, on the
 * two base parameterisations (wall metres, ground metres). Per-pattern
 * footprints are derived from those by multiplication — fwidth is linear in
 * scale — so no derivative ever sits inside the material branch. Each pattern
 * fades to its flat albedo once a cell drops below ~1 px, which is what keeps
 * the campus-wide view free of shimmer.
 */

/* ------------------------------------------------------------------ *
 * Material table — ids must match the #defines in MATERIAL_GLSL.
 * ------------------------------------------------------------------ */

export const MATERIALS = {
  brick:          { id: 1,  albedo: [0.545, 0.231, 0.173], roughness: 0.85, emissive: 0 },
  limestoneGrey:  { id: 2,  albedo: [0.549, 0.522, 0.471], roughness: 0.90, emissive: 0 },
  limestoneBuff:  { id: 3,  albedo: [0.812, 0.780, 0.702], roughness: 0.70, emissive: 0 },
  verdigris:      { id: 4,  albedo: [0.369, 0.604, 0.549], roughness: 0.55, emissive: 0 },
  verdigrisDome:  { id: 5,  albedo: [0.369, 0.604, 0.549], roughness: 0.50, emissive: 0.05 },
  slate:          { id: 6,  albedo: [0.290, 0.306, 0.337], roughness: 0.60, emissive: 0 },
  terracotta:     { id: 7,  albedo: [0.722, 0.255, 0.165], roughness: 0.75, emissive: 0 },
  glass:          { id: 8,  albedo: [0.478, 0.616, 0.690], roughness: 0.15, emissive: 0.3 },
  concreteRibbed: { id: 9,  albedo: [0.839, 0.835, 0.812], roughness: 0.80, emissive: 0 },
  asphalt:        { id: 10, albedo: [0.169, 0.176, 0.200], roughness: 0.95, emissive: 0 },
  asphaltLine:    { id: 11, albedo: [0.169, 0.176, 0.200], roughness: 0.95, emissive: 0.02 },
  walk:           { id: 12, albedo: [0.784, 0.761, 0.706], roughness: 0.90, emissive: 0 },
  lawn:           { id: 13, albedo: [0.306, 0.541, 0.247], roughness: 1.00, emissive: 0 },
  canopy:         { id: 14, albedo: [0.180, 0.360, 0.170], roughness: 1.00, emissive: 0 },
  water:          { id: 15, albedo: [0.055, 0.090, 0.130], roughness: 0.05, emissive: 0 },
  ballast:        { id: 16, albedo: [0.420, 0.410, 0.390], roughness: 1.00, emissive: 0 },
  bronze:         { id: 17, albedo: [0.353, 0.290, 0.196], roughness: 0.45, emissive: 0 },
  bronzePatina:   { id: 18, albedo: [0.435, 0.541, 0.471], roughness: 0.65, emissive: 0 },
  granite:        { id: 19, albedo: [0.247, 0.251, 0.271], roughness: 0.40, emissive: 0 },
  whiteTrim:      { id: 20, albedo: [0.914, 0.902, 0.863], roughness: 0.60, emissive: 0 },
  concreteGrey:   { id: 21, albedo: [0.557, 0.565, 0.588], roughness: 0.90, emissive: 0 },
  field:          { id: 22, albedo: [0.180, 0.490, 0.243], roughness: 1.00, emissive: 0 },
  // Whole-campus facades (plan §B2): the classifier in design/pipeline/facade.py emits these.
  clapboard:      { id: 23, albedo: [0.760, 0.720, 0.640], roughness: 0.85, emissive: 0 },
  precast:        { id: 24, albedo: [0.700, 0.680, 0.640], roughness: 0.80, emissive: 0 },
  metalPanel:     { id: 25, albedo: [0.520, 0.540, 0.570], roughness: 0.45, emissive: 0 },
  glassDark:      { id: 26, albedo: [0.300, 0.400, 0.470], roughness: 0.12, emissive: 0.2 },
  roofMembrane:   { id: 27, albedo: [0.330, 0.340, 0.360], roughness: 0.95, emissive: 0 },
  standingSeam:   { id: 28, albedo: [0.400, 0.430, 0.470], roughness: 0.40, emissive: 0 },
};

/**
 * Monument kind / part → material id. Parts are free-form strings the
 * renderer already uses ('dome', 'tower', 'trim', 'roof', …); unknown parts
 * fall back to the kind's primary surface, and unknown kinds to red brick,
 * which is what most of this campus is.
 */
const KIND_PARTS = {
  foellinger:  { body: 'brick', trim: 'limestoneBuff', column: 'limestoneBuff', dome: 'verdigrisDome', cornice: 'verdigris' },
  altgeld:     { body: 'limestoneGrey', tower: 'limestoneGrey', trim: 'limestoneBuff', roof: 'terracotta', hallRoof: 'slate', turret: 'terracotta' },
  'alma-mater':{ body: 'bronze', figure: 'bronze', plinth: 'granite', throne: 'bronze' },
  union:       { body: 'brick', trim: 'whiteTrim', column: 'whiteTrim', roof: 'slate', cupola: 'whiteTrim', chimney: 'brick' },
  stadium:     { body: 'brick', colonnade: 'limestoneBuff', stands: 'concreteGrey', field: 'field', mast: 'concreteGrey' },
  'state-farm':{ body: 'concreteRibbed', dome: 'concreteRibbed', base: 'concreteGrey' },
  krannert:    { body: 'brick', glass: 'glass', stairs: 'limestoneBuff', tower: 'brick' },
  beckman:     { body: 'limestoneBuff', band: 'granite', glass: 'glass', wing: 'brick' },
  grainger:    { body: 'brick', trim: 'limestoneBuff', roof: 'slate', chimney: 'brick' },
  siebel:      { body: 'glass', base: 'brick', drum: 'verdigris', fin: 'concreteGrey' },
  eceb:        { body: 'glass', fin: 'terracotta', trim: 'concreteGrey' },
  library:     { body: 'brick', trim: 'limestoneBuff', roof: 'slate' },
  dcl:         { body: 'limestoneBuff', trim: 'concreteGrey' },
  kenney:      { body: 'brick', trim: 'limestoneBuff', roof: 'slate' },
  // Generic renderer kinds.
  hall:        { body: 'brick', trim: 'limestoneBuff', roof: 'slate' },
  tower:       { body: 'glass', base: 'brick' },
  dome:        { body: 'brick', dome: 'verdigrisDome', column: 'limestoneBuff' },
  bowl:        { body: 'concreteGrey', colonnade: 'limestoneBuff', field: 'field' },
  belltower:   { body: 'limestoneGrey', roof: 'terracotta' },
  statue:      { body: 'bronze', plinth: 'granite' },
  // Ground layers.
  road:        { body: 'asphalt', major: 'asphaltLine' },
  walk:        { body: 'walk' },
  lawn:        { body: 'lawn' },
  tree:        { body: 'canopy' },
  water:       { body: 'water' },
  rail:        { body: 'ballast' },
  parking:     { body: 'asphalt' },
  ambient:     { body: 'brick', glass: 'glass', house: 'brick', roof: 'slate' },
};

/** Material id for a monument/layer `kind` and an optional `part`. */
export function materialFor(kind, part = 'body') {
  const table = KIND_PARTS[kind] || KIND_PARTS.ambient;
  const name = table[part] || table.body || 'brick';
  return MATERIALS[name].id;
}

/** Reverse lookup, for labels and debugging. */
export const MATERIAL_NAMES = Object.fromEntries(
  Object.entries(MATERIALS).map(([name, m]) => [m.id, name])
);

/* ------------------------------------------------------------------ *
 * GLSL
 * ------------------------------------------------------------------ */

export const MATERIAL_GLSL = /* glsl */ `
// ---- materials.js : procedural surfaces -----------------------------------
#define MAT_BRICK            1
#define MAT_LIMESTONE_GREY   2
#define MAT_LIMESTONE_BUFF   3
#define MAT_VERDIGRIS        4
#define MAT_VERDIGRIS_DOME   5
#define MAT_SLATE            6
#define MAT_TERRACOTTA       7
#define MAT_GLASS            8
#define MAT_CONCRETE_RIBBED  9
#define MAT_ASPHALT         10
#define MAT_ASPHALT_LINE    11
#define MAT_WALK            12
#define MAT_LAWN            13
#define MAT_CANOPY          14
#define MAT_WATER           15
#define MAT_BALLAST         16
#define MAT_BRONZE          17
#define MAT_BRONZE_PATINA   18
#define MAT_GRANITE         19
#define MAT_WHITE_TRIM      20
#define MAT_CONCRETE_GREY   21
#define MAT_FIELD           22
#define MAT_CLAPBOARD       23
#define MAT_PRECAST         24
#define MAT_METAL_PANEL     25
#define MAT_GLASS_DARK      26
#define MAT_ROOF_MEMBRANE   27
#define MAT_STANDING_SEAM   28

uniform float uMetersPerUnit;   // world unit → metres (10)
uniform float uVScale;          // vertical exaggeration (2.6)
uniform vec2  uRibCenter;       // world xz of a radially ribbed surface

struct Surface {
  vec3  albedo;    // daylight base colour
  vec3  nrm;       // small world-space normal offset; add to N and renormalise
  float rough;     // 0 mirror … 1 matte
  vec3  emissive;  // self-illumination, already coloured
};

float matHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float matHash11(float p) { return fract(sin(p * 127.1) * 43758.5453); }

// Value noise, 2-D, smooth. Cheap enough to sample a few octaves per fragment.
float matNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = matHash21(i), b = matHash21(i + vec2(1, 0));
  float c = matHash21(i + vec2(0, 1)), d = matHash21(i + vec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float matFbm(vec2 p) {
  return matNoise(p) * 0.5 + matNoise(p * 2.03 + 7.1) * 0.25 + matNoise(p * 4.07 + 3.3) * 0.125;
}

// Anti-aliased mask of a joint of half-width \`w\` (in cell units) around each
// integer boundary of \`c\`. \`e\` is the per-cell pixel footprint. Returns 1 in
// the joint, 0 on the block, blending across ~1 px.
float matJoint(float c, float w, float e) {
  float d = abs(fract(c) - 0.5);          // 0 at the cell centre, 0.5 at the joint
  e = max(e, 1e-4); // equal edges are undefined
  return 1.0 - smoothstep(0.5 - w - e, 0.5 - w + e, d);
}

// Analytic LOD: 1 while a cell of frequency \`freq\` (cells per metre) spans
// well over a pixel, 0 once it is sub-pixel.
float matLod(float footprintPerMetre, float freq) {
  float px = footprintPerMetre * freq;
  return 1.0 - smoothstep(0.35, 1.1, px);
}

Surface material(int id, vec3 wp, vec3 n, float t, vec2 extra) {
  Surface s;
  s.nrm = vec3(0.0);
  s.rough = 0.9;
  s.emissive = vec3(0.0);
  s.albedo = vec3(0.5);

  // ---- base parameterisations, in metres ---------------------------------
  // Wall: distance along the facade tangent, and true height.
  vec2 wall = vec2(wp.x * n.z - wp.z * n.x, wp.y / uVScale) * uMetersPerUnit;
  // Ground / roof: plan position.
  vec2 ground = wp.xz * uMetersPerUnit;
  // Radial: angle and radius around uRibCenter, for domes and saucers.
  vec2 rel = (wp.xz - uRibCenter) * uMetersPerUnit;
  float ang = atan(rel.y, rel.x);

  // ---- every derivative, once, outside all branches ----------------------
  float dWall   = max(fwidth(wall.x), fwidth(wall.y));
  float dGround = max(fwidth(ground.x), fwidth(ground.y));
  // Angular footprint from the positional one: fwidth(atan) spikes at the
  // +/-pi seam and painted a blur line down every ribbed dome.
  float dAng    = length(fwidth(rel)) / max(length(rel), 1e-3);

  float vertical = 1.0 - smoothstep(0.35, 0.6, abs(n.y));   // 1 on walls
  vec2 uv = mix(ground, wall, vertical);                     // best-fit param
  float duv = mix(dGround, dWall, vertical);

  if (id == MAT_BRICK) {
    // Running bond: 0.2 m bricks on 0.065 m courses, mortar 10 mm.
    vec2 f = vec2(1.0 / 0.20, 1.0 / 0.065);
    float lod = matLod(duv, f.y);
    vec2 c = uv * f;
    float course = floor(c.y);
    c.x += 0.5 * mod(course, 2.0);
    vec2 cell = floor(c);
    float ex = duv * f.x, ey = duv * f.y;
    float joint = max(matJoint(c.x, 0.05, ex), matJoint(c.y, 0.14, ey));
    float tint = matHash21(cell) * 0.34 - 0.17;
    vec3 brick = vec3(0.545, 0.231, 0.173) * (1.0 + tint) + vec3(0.03) * matNoise(uv * 40.0);
    vec3 mortar = vec3(0.62, 0.58, 0.52);
    s.albedo = mix(brick, mortar, joint * lod);
    s.albedo = mix(vec3(0.545, 0.231, 0.173) * 0.97, s.albedo, max(lod, 0.35));
    s.nrm = vec3(0.0, -joint * lod * 0.12, 0.0);
    s.rough = 0.85;
  }
  else if (id == MAT_LIMESTONE_GREY) {
    // Rusticated: 1.0 m × 0.4 m blocks, deep raked joints, rough face.
    vec2 f = vec2(1.0 / 1.0, 1.0 / 0.4);
    float lod = matLod(duv, f.y);
    vec2 c = uv * f;
    c.x += 0.5 * mod(floor(c.y), 2.0);
    vec2 cell = floor(c);
    float joint = max(matJoint(c.x, 0.03, duv * f.x), matJoint(c.y, 0.06, duv * f.y));
    float face = matFbm(uv * 3.0 + cell * 9.1) * 0.5;
    float tint = matHash21(cell) * 0.16 - 0.08;
    vec3 stone = mix(vec3(0.549, 0.522, 0.471), vec3(0.43, 0.41, 0.36), face) * (1.0 + tint);
    s.albedo = mix(stone, vec3(0.30, 0.29, 0.26), joint * lod);
    s.nrm = vec3(0.0, -joint * lod * 0.18, 0.0);
    s.rough = 0.92;
  }
  else if (id == MAT_LIMESTONE_BUFF) {
    // Ashlar: 1.4 m × 0.5 m, tight joints, near-smooth face.
    vec2 f = vec2(1.0 / 1.4, 1.0 / 0.5);
    float lod = matLod(duv, f.y);
    vec2 c = uv * f;
    c.x += 0.5 * mod(floor(c.y), 2.0);
    vec2 cell = floor(c);
    float joint = max(matJoint(c.x, 0.012, duv * f.x), matJoint(c.y, 0.025, duv * f.y));
    float tint = matHash21(cell) * 0.08 - 0.04 + matNoise(uv * 6.0) * 0.06;
    s.albedo = vec3(0.812, 0.780, 0.702) * (1.0 + tint);
    s.albedo = mix(s.albedo, s.albedo * 0.72, joint * lod);
    s.rough = 0.7;
  }
  else if (id == MAT_VERDIGRIS || id == MAT_VERDIGRIS_DOME) {
    // Oxidised copper: streaks run with gravity (down the wall / down the dome).
    float streak = matFbm(vec2(uv.x * 2.5, uv.y * 0.35));
    float mottle = matFbm(uv * 1.2 + 13.0);
    vec3 pale = vec3(0.49, 0.71, 0.64);
    vec3 deep = vec3(0.22, 0.42, 0.40);
    vec3 dark = vec3(0.14, 0.25, 0.26);
    s.albedo = mix(mix(deep, pale, streak), dark, smoothstep(0.55, 0.9, mottle) * 0.6);
    s.rough = 0.55;
    if (id == MAT_VERDIGRIS_DOME) {
      // 24 radial ribs, plus glazed panels between them that glow at night —
      // Foellinger's 396 embedded lights.
      float ribs = 24.0;
      float rc = ang / 6.28318 * ribs;
      float lod = 1.0 - smoothstep(0.3, 1.0, dAng / 6.28318 * ribs);
      float rib = 1.0 - smoothstep(0.42, 0.5, abs(fract(rc) - 0.5)) ;
      rib *= lod;
      s.albedo = mix(s.albedo, dark, rib * 0.5);
      float panel = (1.0 - rib) * lod;
      s.emissive = vec3(1.0, 0.72, 0.42) * panel * 0.08 * (0.8 + 0.2 * sin(t * 0.6 + rc));
      s.nrm = vec3(cos(ang), 0.0, sin(ang)) * rib * 0.08;
      s.rough = 0.5;
    }
  }
  else if (id == MAT_SLATE) {
    // Standing-seam / slate: seams every 0.5 m along the slope, dark tones.
    float f = 1.0 / 0.5;
    float lod = matLod(duv, f);
    float c = uv.x * f;
    float seam = matJoint(c, 0.03, duv * f) * lod;
    float tone = matNoise(uv * 4.0) * 0.14 - 0.07;
    s.albedo = vec3(0.290, 0.306, 0.337) * (1.0 + tone);
    s.albedo = mix(s.albedo, s.albedo * 1.35, seam);
    s.nrm = vec3(0.0, seam * 0.1, 0.0);
    s.rough = 0.6;
  }
  else if (id == MAT_TERRACOTTA) {
    // Roman tile: 0.3 m courses, scalloped shading down each course.
    vec2 f = vec2(1.0 / 0.25, 1.0 / 0.3);
    float lod = matLod(duv, f.y);
    vec2 c = uv * f;
    c.x += 0.5 * mod(floor(c.y), 2.0);
    float scallop = 0.5 + 0.5 * cos(fract(c.x) * 6.28318);
    float shade = smoothstep(0.0, 0.25, fract(c.y));
    float tint = matHash21(floor(c)) * 0.2 - 0.1;
    vec3 tile = vec3(0.722, 0.255, 0.165) * (1.0 + tint);
    s.albedo = mix(tile, tile * mix(0.62, 1.0, scallop * shade), lod);
    s.rough = 0.75;
  }
  else if (id == MAT_GLASS) {
    // Curtain wall: 1.5 m bays, 3.6 m floors, reflective blue-green tint,
    // hashed lit windows behind. Same LOD discipline as the campus windows.
    vec2 f = vec2(1.0 / 1.5, 1.0 / 3.6);
    float lod = matLod(duv, f.x);
    vec2 c = uv * f;
    vec2 cell = floor(c);
    float mullion = max(matJoint(c.x, 0.03, duv * f.x), matJoint(c.y, 0.02, duv * f.y)) * lod;
    vec3 tint = vec3(0.478, 0.616, 0.690);
    vec3 dark = vec3(0.10, 0.14, 0.18);
    float lit = step(0.62, matHash21(cell));
    float flick = 0.8 + 0.2 * sin(t * 0.5 + matHash21(cell + 7.1) * 30.0);
    vec3 glow = mix(vec3(1.0, 0.68, 0.36), vec3(0.75, 0.86, 1.0), step(0.85, matHash21(cell + 2.3)));
    s.albedo = mix(mix(dark, tint, 0.55), vec3(0.62, 0.64, 0.66), mullion);
    s.emissive = glow * lit * flick * lod * 0.55 * (1.0 - mullion);
    s.rough = 0.15;
  }
  else if (id == MAT_CONCRETE_RIBBED) {
    // State Farm Center: 48 radial folds, pale concrete.
    float ribs = 48.0;
    float rc = ang / 6.28318 * ribs;
    float lod = 1.0 - smoothstep(0.3, 1.0, dAng / 6.28318 * ribs);
    float fold = abs(fract(rc) - 0.5) * 2.0;           // 0 at the crease, 1 at the ridge
    float grain = matNoise(uv * 3.0) * 0.06;
    s.albedo = vec3(0.839, 0.835, 0.812) * (1.0 + grain) * mix(1.0, 0.72 + 0.28 * fold, lod);
    s.nrm = vec3(cos(ang), 0.0, sin(ang)) * (fold - 0.5) * lod * 0.12;
    s.rough = 0.8;
  }
  else if (id == MAT_ASPHALT || id == MAT_ASPHALT_LINE) {
    float grain = matNoise(ground * 6.0) * 0.12 + matNoise(ground * 23.0) * 0.06;
    s.albedo = vec3(0.169, 0.176, 0.200) * (0.9 + grain);
    s.rough = 0.95;
    if (id == MAT_ASPHALT_LINE) {
      // Dashed yellow centre line: extra.x is the across-ribbon metre offset.
      float lineHalf = 0.06;
      float e = max(dGround, 1e-4);
      float line = 1.0 - smoothstep(lineHalf - e, lineHalf + e, abs(extra.x));
      float dash = step(0.5, fract(ground.x * 0.3 + ground.y * 0.3));
      float lod = 1.0 - smoothstep(0.2, 0.8, e / 0.12);
      s.albedo = mix(s.albedo, vec3(0.85, 0.72, 0.20), line * dash * lod);
      s.emissive = vec3(0.85, 0.72, 0.20) * line * dash * lod * 0.08;
    }
  }
  else if (id == MAT_WALK) {
    // Pale concrete with expansion joints every 1.5 m.
    float f = 1.0 / 1.5;
    float lod = matLod(dGround, f);
    vec2 c = ground * f;
    float joint = max(matJoint(c.x, 0.015, dGround * f), matJoint(c.y, 0.015, dGround * f)) * lod;
    float grain = matNoise(ground * 4.0) * 0.08;
    s.albedo = vec3(0.784, 0.761, 0.706) * (1.0 + grain);
    s.albedo = mix(s.albedo, s.albedo * 0.7, joint);
    s.rough = 0.9;
  }
  else if (id == MAT_LAWN || id == MAT_FIELD) {
    vec3 base = id == MAT_FIELD ? vec3(0.180, 0.490, 0.243) : vec3(0.306, 0.541, 0.247);
    float n1 = matFbm(ground * 0.8);
    float n2 = matNoise(ground * 9.0) * 0.5;
    // Faint mowing stripes, 4 m wide.
    float stripe = 0.5 + 0.5 * sin(ground.x * 6.28318 / 8.0);
    float lodS = 1.0 - smoothstep(0.3, 1.0, dGround / 4.0);
    s.albedo = base * (0.8 + n1 * 0.35 + n2 * 0.1) * mix(1.0, 0.92 + 0.08 * stripe, lodS);
    s.rough = 1.0;
  }
  else if (id == MAT_CANOPY) {
    // Dense foliage: dark, noisy, with an edge-darkening term from the normal.
    float leaf = matFbm(ground * 2.5 + wp.y * 3.0);
    float depth = matNoise(ground * 12.0 + wp.y * 7.0);
    vec3 dark = vec3(0.09, 0.17, 0.08);
    vec3 lit = vec3(0.24, 0.45, 0.20);
    s.albedo = mix(dark, lit, leaf * 0.7 + depth * 0.3);
    s.nrm = (vec3(depth, leaf, matNoise(ground * 5.0)) - 0.5) * 0.35;
    s.rough = 1.0;
  }
  else if (id == MAT_WATER) {
    // Dark water with a slow ripple sheen; the caller's rim/spec does the rest.
    // Two slow, low-frequency ripple fields; the sheen is a broad highlight
    // band, not per-texel sparkle, so it stays calm at every zoom.
    float r1 = matNoise(ground * 0.35 + vec2(t * 0.05, t * 0.03));
    float r2 = matNoise(ground * 0.9 - vec2(t * 0.04, -t * 0.05));
    s.albedo = vec3(0.055, 0.090, 0.130) * (0.9 + r1 * 0.25);
    s.nrm = vec3(r1 - 0.5, 0.0, r2 - 0.5) * 0.06;
    s.rough = 0.05;
    s.emissive = vec3(0.10, 0.16, 0.24) * smoothstep(0.55, 0.8, r2) * 0.35;
  }
  else if (id == MAT_BALLAST) {
    // Crushed stone bed with two rails 1.435 m apart along extra.x (across).
    float speck = matNoise(ground * 30.0) * 0.5 + matNoise(ground * 90.0) * 0.5;
    s.albedo = vec3(0.420, 0.410, 0.390) * (0.7 + speck * 0.6);
    float e = max(dGround, 1e-4);
    float rail = 1.0 - smoothstep(0.05 - e, 0.05 + e, abs(abs(extra.x) - 0.717));
    float lod = 1.0 - smoothstep(0.2, 0.8, e / 0.1);
    s.albedo = mix(s.albedo, vec3(0.55, 0.52, 0.48), rail * lod);
    // Sleepers every 0.6 m along the line (ground.x used as "along" proxy).
    float tie = matJoint(ground.x / 0.6, 0.2, e / 0.6) * lod * step(abs(extra.x), 1.2);
    s.albedo = mix(s.albedo, vec3(0.28, 0.22, 0.18), tie * 0.8);
    s.rough = 1.0;
  }
  else if (id == MAT_BRONZE || id == MAT_BRONZE_PATINA) {
    // Cast bronze; the patina variant is the pre-2014 green.
    float streak = matFbm(vec2(uv.x * 3.0, uv.y * 0.6));
    float wear = matNoise(uv * 8.0);
    vec3 bronze = vec3(0.353, 0.290, 0.196);
    vec3 hi = vec3(0.55, 0.45, 0.30);
    vec3 green = vec3(0.435, 0.541, 0.471);
    float patina = id == MAT_BRONZE_PATINA ? 0.85 : 0.18;
    s.albedo = mix(mix(bronze, hi, wear * 0.4), green, streak * patina);
    s.rough = id == MAT_BRONZE_PATINA ? 0.65 : 0.45;
  }
  else if (id == MAT_GRANITE) {
    float speck = matNoise(uv * 60.0) * 0.6 + matNoise(uv * 160.0) * 0.4;
    float lod = 1.0 - smoothstep(0.2, 0.8, duv * 60.0);
    s.albedo = vec3(0.247, 0.251, 0.271) * (0.8 + speck * 0.5 * lod + (1.0 - lod) * 0.2);
    s.rough = 0.4;
  }
  else if (id == MAT_WHITE_TRIM) {
    // Painted wood: near-flat white with a whisper of board grain.
    float grain = matNoise(uv * vec2(1.5, 25.0)) * 0.05;
    s.albedo = vec3(0.914, 0.902, 0.863) * (1.0 - grain);
    s.rough = 0.6;
  }
  else if (id == MAT_CONCRETE_GREY) {
    float f = 1.0 / 2.4;
    float lod = matLod(duv, f);
    vec2 c = uv * f;
    float joint = max(matJoint(c.x, 0.012, duv * f), matJoint(c.y, 0.012, duv * f)) * lod;
    float grain = matFbm(uv * 2.0) * 0.12;
    s.albedo = vec3(0.557, 0.565, 0.588) * (0.92 + grain);
    s.albedo = mix(s.albedo, s.albedo * 0.75, joint);
    s.rough = 0.9;
  }
  else if (id == MAT_CLAPBOARD) {
    // Horizontal siding: 0.15 m boards with a shadow line under each lap.
    float f = 1.0 / 0.15;
    float lod = matLod(duv, f);
    float lap = smoothstep(0.82, 0.97, fract(wall.y * f)) * lod;
    float grain = matNoise(uv * vec2(0.8, 12.0)) * 0.06;
    s.albedo = vec3(0.760, 0.720, 0.640) * (1.0 - grain) * (1.0 - lap * 0.35);
    s.rough = 0.85;
  }
  else if (id == MAT_PRECAST) {
    // Precast panels, 3 m × 1.5 m, with a soft reveal at every joint.
    vec2 f = vec2(1.0 / 3.0, 1.0 / 1.5);
    float lod = matLod(duv, f.y);
    vec2 c = uv * f;
    float joint = max(matJoint(c.x, 0.015, duv * f.x), matJoint(c.y, 0.02, duv * f.y)) * lod;
    float tone = matFbm(uv * 1.2) * 0.10;
    s.albedo = vec3(0.700, 0.680, 0.640) * (0.94 + tone);
    s.albedo = mix(s.albedo, s.albedo * 0.7, joint);
    s.rough = 0.8;
  }
  else if (id == MAT_METAL_PANEL) {
    // Corrugated / ribbed metal: a 0.3 m rib with a lit crest and a dark trough.
    float f = 1.0 / 0.30;
    float lod = matLod(duv, f);
    float rib = 0.5 + 0.5 * cos(wall.x * f * 6.28318);
    s.albedo = vec3(0.520, 0.540, 0.570) * (0.85 + rib * 0.25 * lod);
    s.nrm = vec3(0.0, 0.0, (rib - 0.5) * 0.25 * lod);
    s.rough = 0.45;
  }
  else if (id == MAT_GLASS_DARK) {
    // Curtain wall, unlit tint: 1.5 m mullions, faint sky reflection.
    vec2 f = vec2(1.0 / 1.5, 1.0 / 3.6);
    float lod = matLod(duv, f.x);
    vec2 c = uv * f;
    float mullion = max(matJoint(c.x, 0.02, duv * f.x), matJoint(c.y, 0.02, duv * f.y)) * lod;
    s.albedo = mix(vec3(0.300, 0.400, 0.470), vec3(0.18, 0.20, 0.24), mullion);
    s.rough = 0.12;
    s.emissive = vec3(0.02, 0.03, 0.05);
  }
  else if (id == MAT_ROOF_MEMBRANE) {
    // Single-ply roofing: matte, mottled, with gravel-ballast speckle when close.
    float speck = matNoise(uv * 40.0) * 0.5;
    float lod = 1.0 - smoothstep(0.2, 0.8, duv * 40.0);
    s.albedo = vec3(0.330, 0.340, 0.360) * (0.9 + speck * lod * 0.3 + matFbm(uv * 0.7) * 0.1);
    s.rough = 0.95;
  }
  else if (id == MAT_STANDING_SEAM) {
    // Standing-seam metal: 0.45 m pans, a raised seam every pan, low roughness.
    float f = 1.0 / 0.45;
    float lod = matLod(duv, f);
    float seam = matJoint(ground.x * f, 0.03, dGround * f) * lod;
    s.albedo = vec3(0.400, 0.430, 0.470) * (1.0 + seam * 0.35);
    s.nrm = vec3(seam * 0.3, 0.0, 0.0);
    s.rough = 0.4;
  }

  return s;
}

Surface material(int id, vec3 wp, vec3 n, float t) {
  return material(id, wp, n, t, vec2(0.0));
}
// ---- end materials.js -----------------------------------------------------
`;
