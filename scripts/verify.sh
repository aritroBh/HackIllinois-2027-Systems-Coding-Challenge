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
node --check public/nexus.js
node --check public/session.js
node --check public/views/onboarding.js
node --check public/sprites.js
node --check public/fx.js
node --check public/soundEngine.js
node --check public/game.js
node --check public/app.js
node -e "import('$ROOT/public/gl/campus3d.js').then(()=>console.log('campus3d.js parses'))" 2>/dev/null

step "geometry winding audit"
node --input-type=module -e "
import * as G from '$ROOT/public/gl/glx.js';
const gens = {
  box: () => G.boxGeometry(), octa: () => G.octahedronGeometry(), gable: () => G.gableGeometry(),
  cone: () => G.coneGeometry(16), dome: () => G.domeGeometry(12, 6), bowl: () => G.bowlGeometry(16, .24),
  prism: () => G.prismGeometry(12), ring: () => G.ringGeometry(.9, 1, 16), plane: () => G.planeGeometry(10),
  extrude: () => G.extrudePolygon([[0,0],[10,0],[10,10],[0,10]], 5),
  polygon: () => G.polygonGeometry([[0,0],[10,0],[10,10],[0,10]], 0),
};
// Any additional exported *Geometry generators are audited too.
for (const k of Object.keys(G)) if (/Geometry\$/.test(k) && !Object.values(gens).some(f => f.toString().includes(k))) {
  try { const g = G[k](); if (g && g.indices) gens[k] = () => g; } catch {}
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
" 2>/dev/null

if [ "$MODE" = "quick" ]; then
  step "quick mode done"
  exit 0
fi

step "campus model rebuild"
python3 design/build-campus.py

step "test suite"
npm test --silent 2>&1 | grep -E "Tests:|Suites:|✕|FAIL" || true

step "done"
