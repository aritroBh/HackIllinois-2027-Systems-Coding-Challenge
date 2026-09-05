/**
 * Material/lighting preview harness for the WebGL2 campus renderer.
 *
 * Extracted from an inline `<script type="module">` so the app-wide
 * Content-Security-Policy can ship `script-src 'self'` with no `'unsafe-inline'`.
 * This and avatar-demo.js were the last two inline scripts in `public/`.
 *
 * Not linked from the war room — open /dashboard/gl/materials-demo.html directly.
 */
import { m4, program, mesh, boxGeometry, domeGeometry, prismGeometry, planeGeometry } from './glx.js';
import { MATERIALS, MATERIAL_GLSL, MATERIAL_NAMES } from './materials.js';

const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl2', { antialias: true });
if (!gl) throw new Error('WebGL2 required');

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
uniform mat4 uProj, uView, uModel;
uniform vec3 uInvScaleSq;
out vec3 vN, vW;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(uModel) * (aNrm * uInvScaleSq));
  gl_Position = uProj * uView * w;
}`;

// The campus renderer's lighting model (two keys + fresnel rim), driven by
// the material library instead of a flat colour. This is the integration the
// header comment of materials.js describes.
const FS = `#version 300 es
precision highp float;
in vec3 vN, vW;
uniform vec3 uCamPos;
uniform float uTime, uNight;
uniform int uMat;
uniform vec2 uExtra;      // .x = pad centre world x, .y = 1 when the pad supplies an across coordinate
out vec4 frag;
${MATERIAL_GLSL}
void main() {
  vec3 n0 = normalize(vN);
  // Pads synthesise the across-ribbon metre coordinate from world x so the
  // line and rail materials have something to draw against.
  vec2 extra = vec2((vW.x - uExtra.x) * uMetersPerUnit * uExtra.y, 0.0);
  Surface s = material(uMat, vW, n0, uTime, extra);
  vec3 N = normalize(n0 + s.nrm);
  vec3 V = normalize(uCamPos - vW);
  vec3 L1 = normalize(vec3(0.4, 0.9, 0.35));
  vec3 L2 = normalize(vec3(-0.6, 0.35, -0.5));
  float d = max(dot(N, L1), 0.0) * 0.75 + max(dot(N, L2), 0.0) * 0.28;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6) * (1.0 - s.rough * 0.6);
  // Night: cool ambient, dimmer keys, emissive unchanged. Day: neutral.
  vec3 ambient = mix(vec3(0.16), vec3(0.06, 0.08, 0.13), uNight);
  float keys = mix(1.0, 0.45, uNight);
  vec3 col = s.albedo * (ambient + d * keys) + s.albedo * rim * 0.45 + s.emissive;
  col = col / (col + 0.8) * 1.4; // gentle tonemap
  frag = vec4(col, 1.0);
}`;

const prog = program(gl, VS, FS);
const build = (g) => mesh(gl, [{ loc: 0, size: 3, data: g.positions }, { loc: 1, size: 3, data: g.normals }], g.indices);
const MESH = { box: build(boxGeometry()), dome: build(domeGeometry(40, 18)), prism: build(prismGeometry(32)), plane: build(planeGeometry(1)) };

// One swatch per material. Shape picks the geometry that shows the material
// best: walls for masonry, a dome for ribbed/verdigris, a flat pad for ground.
const SHAPE = {
  brick: 'box', limestoneGrey: 'box', limestoneBuff: 'box', verdigris: 'prism', verdigrisDome: 'dome',
  slate: 'box', terracotta: 'box', glass: 'box', concreteRibbed: 'dome', asphalt: 'pad', asphaltLine: 'pad',
  walk: 'pad', lawn: 'pad', canopy: 'dome', water: 'pad', ballast: 'pad', bronze: 'prism', bronzePatina: 'prism',
  granite: 'box', whiteTrim: 'box', concreteGrey: 'box', field: 'pad',
};
const names = Object.keys(MATERIALS);
const COLS = 6, GAP = 4.2;
const items = names.map((name, i) => ({
  name, id: MATERIALS[name].id, shape: SHAPE[name] || 'box',
  x: (i % COLS - (COLS - 1) / 2) * GAP,
  z: (Math.floor(i / COLS) - 1.5) * GAP,
}));

const cam = { yaw: 0.6, pitch: 0.55, dist: 20, tYaw: 0.6, tPitch: 0.55, tDist: 20 };
let night = 1, dragging = false, lx = 0, ly = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.tYaw += (e.clientX - lx) * 0.006; cam.tPitch = Math.max(0.1, Math.min(1.45, cam.tPitch + (e.clientY - ly) * 0.005));
  lx = e.clientX; ly = e.clientY;
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.tDist = Math.max(3, Math.min(400, cam.tDist * (1 + e.deltaY * 0.0015))); }, { passive: false });
window.addEventListener('keydown', (e) => {
  const snap = (dist, pitch) => { cam.tDist = cam.dist = dist; cam.tPitch = cam.pitch = pitch; };
  if (e.key === '1') snap(7, 0.35);
  if (e.key === '2') snap(22, 0.55);
  if (e.key === '3') snap(160, 0.62);
  if (e.key.toLowerCase() === 'n') night = 1 - night;
});
window.demoView = (preset) => window.dispatchEvent(new KeyboardEvent('keydown', { key: String(preset) }));
const q = new URLSearchParams(location.search);
if (q.get('view')) window.demoView(q.get('view'));
if (q.get('day') === '1') night = 0;

const proj = m4.create(), view = m4.create(), vp = m4.create(), model = m4.create();
const eye = [0, 0, 0];
const labels = document.getElementById('labels');
const nodes = items.map((it) => { const d = document.createElement('div'); d.className = 'lbl'; d.innerHTML = `${it.name} <i>#${it.id}</i>`; labels.appendChild(d); return d; });

function project(x, y, z) {
  const cx = vp[0]*x + vp[4]*y + vp[8]*z + vp[12], cy = vp[1]*x + vp[5]*y + vp[9]*z + vp[13], cw = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
  if (cw <= 0) return null;
  return { x: (cx / cw * 0.5 + 0.5) * canvas.clientWidth, y: (-cy / cw * 0.5 + 0.5) * canvas.clientHeight };
}

let frames = 0, last = performance.now(), fps = 0;
const t0 = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  gl.viewport(0, 0, W, H);

  cam.yaw += (cam.tYaw - cam.yaw) * 0.1; cam.pitch += (cam.tPitch - cam.pitch) * 0.1; cam.dist += (cam.tDist - cam.dist) * 0.1;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  eye[0] = Math.sin(cam.yaw) * cp * cam.dist; eye[1] = sp * cam.dist; eye[2] = Math.cos(cam.yaw) * cp * cam.dist;
  m4.perspective(0.8, W / H, 0.1, 1000, proj);
  m4.lookAt(eye, [0, 0.8, 0], [0, 1, 0], view);
  m4.multiply(proj, view, vp);

  gl.clearColor(0.043, 0.07, 0.125, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);

  const t = (now - t0) / 1000;
  prog.use();
  gl.uniformMatrix4fv(prog.u.uProj, false, proj);
  gl.uniformMatrix4fv(prog.u.uView, false, view);
  gl.uniform3fv(prog.u.uCamPos, eye);
  gl.uniform1f(prog.u.uTime, t);
  gl.uniform1f(prog.u.uNight, night);
  gl.uniform1f(prog.u.uMetersPerUnit, 10.0);
  gl.uniform1f(prog.u.uVScale, 2.6);

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let m, sx, sy, sz, y = 0;
    if (it.shape === 'box')   { m = MESH.box;   sx = 1.6; sy = 2.6;  sz = 1.6; }      // 16 m × 10 m tall
    if (it.shape === 'prism') { m = MESH.prism; sx = 1.5; sy = 2.6;  sz = 1.5; }
    if (it.shape === 'dome')  { m = MESH.dome;  sx = 3.0; sy = 1.6;  sz = 3.0; }
    if (it.shape === 'pad')   { m = MESH.plane; sx = 3.4; sy = 1;    sz = 3.4; y = 0.01; }
    m4.trs(it.x, y, it.z, 0, sx, sy, sz, model);
    gl.uniformMatrix4fv(prog.u.uModel, false, model);
    gl.uniform3f(prog.u.uInvScaleSq, 1 / (sx * sx), 1 / (sy * sy), 1 / (sz * sz));
    gl.uniform1i(prog.u.uMat, it.id);
    gl.uniform2f(prog.u.uRibCenter, it.x, it.z);
    gl.uniform2f(prog.u.uExtra, it.x, it.shape === 'pad' ? 1 : 0);
    if (it.shape === 'pad') gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);

    const s = project(it.x, it.shape === 'pad' ? 0 : (it.shape === 'dome' ? 1.7 : 2.7), it.z + (it.shape === 'pad' ? 1.9 : 0));
    const n = nodes[i];
    if (s && cam.dist < 60) { n.style.display = ''; n.style.left = s.x + 'px'; n.style.top = s.y + 'px'; } else n.style.display = 'none';
  }

  frames++;
  if (now - last > 1000) { fps = frames; frames = 0; last = now; document.getElementById('stat').textContent = `${fps} fps · dist ${cam.dist.toFixed(0)} · ${night ? 'night' : 'day'}`; }
}
requestAnimationFrame(frame);
