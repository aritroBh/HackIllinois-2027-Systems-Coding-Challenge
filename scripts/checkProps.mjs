/**
 * The props pass has three halves that must agree, and nothing else notices when they stop.
 *
 *   1. `design/pipeline/queries/props.overpass.tpl` says which OSM tags are fetched.
 *   2. `design/pipeline/props.py` says which of those become baked prop kinds.
 *   3. `public/gl/props.js` says which kinds have a mesh to draw.
 *
 * Each break is silent in a different way. A tag fetched with no consumer is bytes downloaded,
 * hashed into the manifest and thrown away, and it also makes every future fetch of that
 * sub-box larger for nothing. A kind baked with no mesh is a prop `buildProp` answers with
 * `null`, so it vanishes from the map with no error anywhere. A fence profile the baker emits
 * and the renderer has never heard of is drawn with whatever the fallback happens to be, which
 * is the worst of the three because it looks like a decision.
 *
 * This is the same discipline the material-id lockstep check applies, for the same reason: a
 * vocabulary shared across three languages needs something that fails when they diverge.
 *
 *   node scripts/checkProps.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const fail = [];

// --- 1. What the query asks for --------------------------------------------------------
const tpl = read('design/pipeline/queries/props.overpass.tpl');
/**
 * Every `key=value` and `key~"^(a|b)$"` selector in the template, flattened to `key=value`
 * pairs. Comment lines are stripped first so a tag named in prose is not read as a selector.
 */
const selectors = new Set();
for (const line of tpl.split('\n')) {
  if (line.trim().startsWith('//')) continue;
  for (const m of line.matchAll(/\["([a-z_:]+)"="([A-Za-z_:]+)"\]/g)) selectors.add(`${m[1]}=${m[2]}`);
  for (const m of line.matchAll(/\["([a-z_:]+)"~"\^\(([^)]+)\)\$"\]/g)) {
    for (const v of m[2].split('|')) selectors.add(`${m[1]}=${v}`);
  }
}

// --- 2. What the parser consumes -------------------------------------------------------
const py = read('design/pipeline/props.py');
/**
 * Consumed tags, read from the literal comparisons in `_kind_for` and from the two tables it
 * looks values up in. This is a text scan rather than an import because the checker has to run
 * from `npm` with no Python environment, and because a mismatch is a vocabulary question that
 * does not need the module to execute.
 */
const consumed = new Set();
const kindFor = py.slice(py.indexOf('def _kind_for'), py.indexOf('def _scale_for'));
for (const m of kindFor.matchAll(/(\w+)\s*=\s*tags\.get\("([a-z_:]+)"\)/g)) {
  const [, local, key] = m;
  for (const c of kindFor.matchAll(new RegExp(`${local}\\s*==\\s*"([A-Za-z_:]+)"`, 'g'))) consumed.add(`${key}=${c[1]}`);
  for (const c of kindFor.matchAll(new RegExp(`${local}\\s+in\\s+\\(([^)]+)\\)`, 'g'))) {
    for (const v of c[1].matchAll(/"([A-Za-z_:]+)"/g)) consumed.add(`${key}=${v[1]}`);
  }
}
for (const m of kindFor.matchAll(/tags\.get\("([a-z_:]+)"\)\s*==\s*"([A-Za-z_:]+)"/g)) consumed.add(`${m[1]}=${m[2]}`);
for (const table of ['BARRIER_KIND']) {
  const block = py.slice(py.indexOf(`${table} = {`), py.indexOf('}', py.indexOf(`${table} = {`)));
  for (const m of block.matchAll(/"([a-z_]+)":/g)) consumed.add(`barrier=${m[1]}`);
}
// Barrier point values and the linear ones are asked for under the same key.
for (const m of kindFor.matchAll(/barrier\s+in\s+\(([^)]+)\)/g)) {
  for (const v of m[1].matchAll(/"([a-z_]+)"/g)) consumed.add(`barrier=${v[1]}`);
}
// Layers that are not point props: these selectors are consumed by build_props directly.
for (const t of ['highway=steps', 'leisure=pitch', 'barrier=bollard']) consumed.add(t);

const orphanSelectors = [...selectors].filter((t) => !consumed.has(t));
if (orphanSelectors.length) {
  fail.push(`fetched with no consumer in props.py: ${orphanSelectors.sort().join(', ')}`);
}

// --- 3. Kinds against meshes -----------------------------------------------------------
const kindsBlock = py.slice(py.indexOf('PROP_KINDS = ('), py.indexOf(')', py.indexOf('PROP_KINDS = (')));
const kinds = [...kindsBlock.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);

const js = read('public/gl/props.js');
const buildersBlock = js.slice(js.indexOf('export const PROP_BUILDERS'), js.indexOf('};', js.indexOf('export const PROP_BUILDERS')));
const builders = new Set([...buildersBlock.matchAll(/\b([a-z]+)\b/g)].map((m) => m[1]));

const missingMesh = kinds.filter((k) => !builders.has(k));
if (missingMesh.length) fail.push(`baked kinds with no mesh in props.js: ${missingMesh.join(', ')}`);

// --- 4. Fence profiles -----------------------------------------------------------------
const fenceJs = js.slice(js.indexOf('const FENCE_KINDS = {'), js.indexOf('};', js.indexOf('const FENCE_KINDS = {')));
const profiles = new Set([...fenceJs.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]));
profiles.add('hedge'); // hedgeRun is its own export rather than a FENCE_KINDS entry
const emitted = new Set();
for (const table of ['BARRIER_KIND', 'FENCE_TYPE']) {
  const at = py.indexOf(`${table} = {`);
  const block = py.slice(at, py.indexOf('}', at));
  for (const m of block.matchAll(/:\s*"([a-z]+)"/g)) emitted.add(m[1]);
}
const unknownProfile = [...emitted].filter((k) => !profiles.has(k));
if (unknownProfile.length) fail.push(`fence profiles the renderer does not know: ${unknownProfile.join(', ')}`);

// --- 5. The renderer's metres-per-unit against the pack's -------------------------------
// `tile-bake.js` converts between metres and world units on the fence and rooftop paths and
// cannot read the content loader, so it states the scale as a constant. A pack whose
// `metersPerUnit` differs would render every fence and every rooftop unit at the wrong size,
// silently and uniformly — the kind of wrongness that looks like a style choice.
const packIndex = path.join(ROOT, 'content', process.env.CONTENT_PACK || 'hackillinois-2027', 'campus', 'index.json');
if (fs.existsSync(packIndex)) {
  const meta = JSON.parse(fs.readFileSync(packIndex, 'utf8')).meta ?? {};
  const bake = read('public/gl/tile-bake.js');
  const declared = Number((bake.match(/export const MPU = ([0-9.]+);/) ?? [])[1]);
  if (!Number.isFinite(declared)) fail.push('public/gl/tile-bake.js no longer declares MPU');
  else if (declared !== meta.metersPerUnit) {
    fail.push(`tile-bake MPU is ${declared} but the pack's metersPerUnit is ${meta.metersPerUnit}`);
  }
}

if (fail.length) {
  for (const f of fail) console.error('props lockstep: ' + f);
  process.exit(1);
}
console.log(`props lockstep: ${selectors.size} selectors, ${kinds.length} kinds, ${profiles.size} fence profiles, scale agrees — all paired`);
