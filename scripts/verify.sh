#!/usr/bin/env bash
# One-shot verification for the war-room frontend + backend.
#
#   scripts/verify.sh          full: typecheck, tests, geometry audit, model rebuild
#   scripts/verify.sh quick    typecheck + geometry audit only
#
# The geometry audit is the check that caught the inverted-winding bug: every
# generator's triangle winding must agree with its stored normals, or the
# renderer culls the wrong faces and draws building interiors.

set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-full}"
ROOT="$PWD"

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

step "typecheck"
npx tsc --noEmit

step "frontend syntax"
# Every browser script, found rather than listed.
#
# This was a hand-written enumeration and it fell behind the moment the dashboard was split
# into per-tab views: nine files — including views/sos.js, which owns the whole SOS
# lifecycle, and sw.js, which owns offline — were never added, so a syntax error in any of
# them passed this gate green. A list that has to be maintained to stay true is not a gate,
# it is a comment; the glob cannot fall behind because it has nothing to fall behind on.
#
# Null-delimited, because the checkout path may contain a space — this repository's does, and
# an unquoted `for f in $(find …)` split "HackIllinois 2027" into two nonexistent modules and
# failed the gate on every file.
FRONTEND_COUNT=0
while IFS= read -r -d '' f; do
  node --check "$f"
  FRONTEND_COUNT=$((FRONTEND_COUNT + 1))
done < <(find "$ROOT/public" -name '*.js' -not -path '*/node_modules/*' -print0 | sort -z)
echo "$FRONTEND_COUNT frontend files parse"
# `node --check` on a bare .js parses it as a script, which is NOT how the browser or the
# bake worker load these. Importing is the only check that catches a shader template closed
# early by a stray backtick in a GLSL comment — which is exactly how campus3d.js was broken
# while every check above it stayed green. stderr is deliberately NOT discarded: the reason
# the breakage survived a run of this script is that the error went to /dev/null and `set -e`
# exited without printing anything at all.
node --no-warnings -e "import('$ROOT/public/gl/campus3d.js').then(()=>console.log('campus3d.js parses'))"
node --no-warnings -e "import('$ROOT/public/gl/props.js').then(()=>console.log('props.js imports'))"
node --no-warnings -e "import('$ROOT/public/gl/decals.js').then(()=>console.log('decals.js imports'))"
node --no-warnings -e "import('$ROOT/public/gl/rooftops.js').then(()=>console.log('rooftops.js imports'))"
# The bake worker imports only pure modules: importing them under node proves no GL leaked in.
node --no-warnings -e "import('$ROOT/public/gl/tile-bake.js').then(m=>{const b=m.bakeTile({buildings:[{p:[[0,0],[2,0],[2,2],[0,2]],h:1.5,t:'university',r:'f',m:'brick',ao:0,par:1}],trees:[[1,1,1]],lamps:[[0,0]]},{vscale:2.6});if(!b.solid||b.solid.ranges.length!==3)process.exit(1);console.log('tile-bake.js is worker-safe')})"

step "design tokens (public/tokens.css is generated from design/tokens.mjs)"
if ! diff -u public/tokens.css <(node design/tokens.mjs --css); then
  echo "public/tokens.css is stale: run 'npm run tokens:build' and commit the result" >&2
  exit 1
fi
echo "tokens.css matches design/tokens.mjs"

step "material ids in lockstep (materials.js ⇔ design/pipeline/config.py ⇔ scripts/materialIds.ts)"
node --input-type=module -e "
import { MATERIALS } from '$ROOT/public/gl/materials.js';
import fs from 'fs';
const js = Object.fromEntries(Object.entries(MATERIALS).map(([k, v]) => [k, v.id]));
const py = Object.fromEntries([...fs.readFileSync('$ROOT/design/pipeline/config.py', 'utf8').matchAll(/\"([A-Za-z]+)\": (\d+)/g)].map((m) => [m[1], +m[2]]));
const ts = Object.fromEntries([...fs.readFileSync('$ROOT/scripts/materialIds.ts', 'utf8').matchAll(/([A-Za-z]+): (\d+)/g)].map((m) => [m[1], +m[2]]));
const pyIds = Object.fromEntries(Object.entries(py).filter(([k]) => k in js || k in ts));
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
if (!same(js, pyIds) || !same(js, ts)) { console.error('material id tables differ', { js, py: pyIds, ts }); process.exit(1); }
const glsl = (await import('$ROOT/public/gl/materials.js')).MATERIAL_GLSL;
for (const [k, id] of Object.entries(js)) if (!new RegExp('#define MAT_[A-Z_]+ +' + id + '(?![0-9])').test(glsl)) { console.error('no #define for material', k, id); process.exit(1); }
console.log(Object.keys(js).length + ' material ids agree across JS, Python and TS');
"

step "plugin asset digests are SRI-usable"
node --input-type=module -e "
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
// The manifest publishes hex, because that is what sha256sum prints and what an operator
// compares against. Subresource Integrity wants base64. Handing the browser the hex string
// is not a soft failure — the digest never matches, every plugin script is refused, and the
// only symptom is a plugin that silently does not load. This asserts the loader still
// converts, and that the conversion lands on the real file.
const loader = fs.readFileSync('$ROOT/public/plugins.js', 'utf8');
if (!/hexToBase64/.test(loader) || !/btoa\(/.test(loader)) {
  console.error('public/plugins.js no longer converts the hex digest to base64 for integrity=');
  process.exit(1);
}
const root = '$ROOT/plugins';
let checked = 0;
for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  const pub = path.join(root, name, 'public');
  if (!fs.existsSync(pub)) continue;
  for (const file of fs.readdirSync(pub)) {
    const bytes = fs.readFileSync(path.join(pub, file));
    const hex = crypto.createHash('sha256').update(bytes).digest('hex');
    const viaHex = Buffer.from(hex, 'hex').toString('base64');
    const direct = crypto.createHash('sha256').update(bytes).digest('base64');
    if (viaHex !== direct) { console.error('digest conversion disagrees for', name, file); process.exit(1); }
    checked++;
  }
}
console.log(checked + ' plugin asset digest(s) convert cleanly from hex to SRI base64');
"

step "offline shell in lockstep (index.html ⇔ sw.js SHELL)"
node scripts/checkShell.mjs

step "props vocabulary in lockstep (props.overpass.tpl ⇔ props.py ⇔ props.js)"
node scripts/checkProps.mjs

step "geometry winding audit"
node --input-type=module -e "
import * as G0 from '$ROOT/public/gl/glx.js';
import * as P from '$ROOT/public/gl/props.js';
import * as D from '$ROOT/public/gl/decals.js';
import * as R from '$ROOT/public/gl/rooftops.js';
// Everything that produces triangles is audited, not just the base layer. The props, decal
// and rooftop modules are where most of the map's geometry now comes from, and an inverted
// face there is exactly as invisible-until-it-is-not as it was in the base generators.
const G = { ...G0, ...P, ...D, ...R };
const gens = {
  box: () => G.boxGeometry(), octa: () => G.octahedronGeometry(), gable: () => G.gableGeometry(),
  cone: () => G.coneGeometry(16), dome: () => G.domeGeometry(12, 6), bowl: () => G.bowlGeometry(16, .24),
  prism: () => G.prismGeometry(12), ring: () => G.ringGeometry(.9, 1, 16), plane: () => G.planeGeometry(10),
  extrude: () => G.extrudePolygon([[0,0],[10,0],[10,10],[0,10]], 5),
  polygon: () => G.polygonGeometry([[0,0],[10,0],[10,10],[0,10]], 0),
};
// Any additional exported generator is audited too. The name filter is deliberately wide:
// props and decals are named for what they are (bench, crosswalkDecal, rooftopGeometry), not
// for the suffix the base layer happens to use, and a generator that escapes the audit
// because of its name is the one that will ship inside out.
for (const k of Object.keys(G)) {
  if (typeof G[k] !== 'function' || gens[k]) continue;
  if (!/Geometry\$|Decal\$|^bench\$|^bin\$|^bikerack\$|^hydrant\$|^bollard\$|^picnic\$|^flag\$|^shelter\$|^busstop\$|^artwork\$|^postbox\$|^sign\$|^planter\$|^drinkfountain\$|^playground\$|^watertower\$|^chimney\$|^mast\$|^gate\$|Run\$|Stalls\$|Markings\$|Edging\$|^manholes\$|^rooftopGeometry\$/.test(k)) continue;
  try { const g = G[k](); if (g && g.indices && g.indices.length) gens[k] = () => g; } catch {}
}
// Every rooftop kind, since one function covers ten different meshes.
for (const kind of (R.ROOFTOP_KINDS || [])) {
  try { const g = R.rooftopGeometry(kind); if (g && g.indices && g.indices.length) gens['roof:' + kind] = () => g; } catch {}
}
// Every prop kind, for the same reason.
for (const kind of Object.keys(P.PROP_BUILDERS || {})) {
  try { const g = P.buildProp(kind); if (g && g.indices && g.indices.length) gens['prop:' + kind] = () => g; } catch {}
}
// Every sport the pitch markings know about.
for (const sport of ['soccer', 'basketball', 'tennis', 'running', 'unknown']) {
  try { const g = D.pitchMarkings(undefined, sport); if (g && g.indices && g.indices.length) gens['pitch:' + sport] = () => g; } catch {}
}
let failed = 0;
for (const [name, make] of Object.entries(gens)) {
  const { positions: p, normals: n, indices: idx } = make();
  let inv = 0, ok = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a,b,c] = [idx[i], idx[i+1], idx[i+2]];
    const P = k => [p[k*3], p[k*3+1], p[k*3+2]];
    const [ax,ay,az]=P(a),[bx,by,bz]=P(b),[cx,cy,cz]=P(c);
    const ux=bx-ax,uy=by-ay,uz=bz-az, vx=cx-ax,vy=cy-ay,vz=cz-az;
    const gx=uy*vz-uz*vy, gy=uz*vx-ux*vz, gz=ux*vy-uy*vx;
    const gl=Math.hypot(gx,gy,gz); if (gl<1e-9) continue;
    const sx=(n[a*3]+n[b*3]+n[c*3])/3, sy=(n[a*3+1]+n[b*3+1]+n[c*3+1])/3, sz=(n[a*3+2]+n[b*3+2]+n[c*3+2])/3;
    const d=(gx/gl)*sx+(gy/gl)*sy+(gz/gl)*sz;
    if (d < -0.05) inv++; else if (d > 0.05) ok++;
  }
  const bad = inv > 0;
  if (bad) failed++;
  console.log((bad ? 'FAIL ' : 'ok   ') + name.padEnd(12) + ' ok=' + ok + ' inverted=' + inv);
}
if (failed) { console.error(failed + ' generator(s) have inverted winding'); process.exit(1); }
"

if [ "$MODE" = "quick" ]; then
  step "quick mode done"
  exit 0
fi

step "campus pack check (schema, tile hashes, monument ids)"
PY=python3; [ -x design/.venv/bin/python ] && PY=design/.venv/bin/python
$PY -m design.pipeline check --ci --pack content/hackillinois-2027
npx tsx scripts/checkCampus.ts content/hackillinois-2027

step "campus model rebuild (needs the OSM cache; skipped when absent)"
if [ -d design/osm/cache ] && $PY -c "import shapely" 2>/dev/null; then
  $PY -m design.pipeline check --pack content/hackillinois-2027
else
  echo "  (no design/osm/cache or no shapely in $PY — run: python3 -m design.pipeline fetch, pip install -r design/pipeline/requirements.txt)"
fi

step "test suite"
npm test --silent 2>&1 | grep -E "Tests:|Suites:|✕|FAIL" || true

step "done"
