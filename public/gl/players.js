/**
 * players — the multiplayer avatar layer (plan §B4).
 *
 * Every remote trainer is one instance in a single draw call: a billboarded quad sampling a
 * 1024² atlas of 128×48 walk sheets (168 slots). Joining a player uploads their sheet into a
 * slot with `texSubImage2D`; nothing else touches the texture per frame.
 *
 * Level of detail, by distance from the camera in world units (10 m each):
 *   < 6    full sprite, name label handled by the caller
 *   < 15   a tinted pill (faction colour, no sheet)
 *   ≥ 15   folded into 5-unit grid clusters drawn as dots scaled by log2(count + 1)
 *
 * Motion is interpolated: the layer keeps the last three snapshots of each player and
 * renders them at `now − 1000 ms`, which matches the 1 Hz delta cadence, then dead-reckons
 * for up to 3 s before holding position and greying the sprite.
 *
 * Remote avatars are depth-tested so buildings occlude a crowd; the local player stays a
 * separate depth-off draw on top (campus3d owns that), which is the marker semantics the
 * dashboard already had.
 */
import { instancedMesh, drawInstanced, disposeMesh } from './glx-gl.js';
import { quadGeometry } from './glx-geometry.js';

export const ATLAS_SIZE = 1024;
export const SLOT_W = 128;
export const SLOT_H = 48;
const COLS = ATLAS_SIZE / SLOT_W;            // 8
const ROWS = Math.floor(ATLAS_SIZE / SLOT_H); // 21
export const SLOTS = COLS * ROWS;             // 168
const FRAMES = 4;

const RENDER_DELAY_MS = 1000;
const DEAD_RECKON_MS = 3000;
const MAX_DR_SPEED = 0.2;   // world units per second (≈ 2 m/s)
const LOD_SPRITE = 6;
const LOD_PILL = 15;
const CLUSTER_CELL = 5;

export const PLAYER_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;          // unit quad, xy in [-0.5, 0.5]
layout(location=6) in vec4 aInst;         // x, z, heading (deg), slot (<0 = pill/dot)
layout(location=7) in vec4 aInst2;        // frame, factionR+G packed, scale, alpha
layout(location=8) in vec4 aTint;         // faction rgb + stale flag
uniform mat4 uProj, uView;
uniform vec3 uRight;
uniform vec2 uAtlas;                      // cols, rows
out vec2 vUv;
out vec4 vTint;
flat out int vSlot;
out float vAlpha;
void main() {
  float slot = aInst.w;
  float scale = aInst2.z;
  vec3 right = uRight * (aPos.x * scale);
  vec3 up = vec3(0.0, 1.0, 0.0) * ((aPos.y + 0.5) * scale * 1.3);
  vec3 world = vec3(aInst.x, 0.06, aInst.y) + right + up;
  gl_Position = uProj * uView * vec4(world, 1.0);

  // Atlas cell for this slot, then the walk frame inside it.
  float col = mod(max(slot, 0.0), uAtlas.x);
  float row = floor(max(slot, 0.0) / uAtlas.x);
  vec2 cell = vec2(1.0 / uAtlas.x, 1.0 / uAtlas.y);
  vec2 frameStep = vec2(cell.x / ${FRAMES}.0, cell.y);
  vec2 uv0 = vec2(col, row) * cell + vec2(aInst2.x * frameStep.x, 0.0);
  vec2 local = vec2(aPos.x + 0.5, 1.0 - (aPos.y + 0.5));
  // Heading decides which way the sheet faces; the sheets are drawn facing right.
  float flip = step(180.0, aInst.z);
  local.x = mix(local.x, 1.0 - local.x, flip);
  vUv = uv0 + local * vec2(frameStep.x, cell.y);
  vTint = aTint;
  vAlpha = aInst2.w;
  vSlot = int(slot);
}`;

export const PLAYER_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vTint;
in float vAlpha;
flat in int vSlot;
uniform sampler2D uAtlasTex;
out vec4 frag;
void main() {
  vec4 c;
  if (vSlot >= 0) {
    c = texture(uAtlasTex, vUv);
    if (c.a < 0.35) discard;
    // Stale players (no fix for 30 s) desaturate rather than vanish.
    c.rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.3, 0.6, 0.1))), vTint.a * 0.75);
  } else {
    // Pill / cluster dot: a soft round blob in the faction colour.
    vec2 d = vUv * 2.0 - 1.0;
    float r = dot(d, d);
    if (r > 1.0) discard;
    c = vec4(vTint.rgb, (1.0 - r) * 0.85);
  }
  frag = vec4(c.rgb, c.a * vAlpha);
}`;

/**
 * @param {WebGL2RenderingContext} gl
 * @param {{ program: ReturnType<import('./glx-gl.js').program> }} deps
 */
export function createPlayerLayer(gl, { program }) {
  const geo = quadGeometry();
  const mesh = instancedMesh(
    gl,
    [{ loc: 0, size: 3, data: geo.positions }],
    geo.indices,
    [{ loc: 6, size: 4 }, { loc: 7, size: 4 }, { loc: 8, size: 4 }]
  );

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS_SIZE, ATLAS_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  /** hash → { slot, lastSeen } ; slot 0..SLOTS-1 */
  const slots = new Map();
  const freeSlots = Array.from({ length: SLOTS }, (_, i) => SLOTS - 1 - i);
  /** id → { x, z, h, faction, name, avatarHash, kind, stale, history: [{t,x,z}], lastT } */
  const players = new Map();
  let packed = new Float32Array(0);
  let count = 0;
  const stats = { drawn: 0, sprites: 0, pills: 0, clusters: 0, slots: 0 };

  function slotFor(hash, distance) {
    if (!hash) return -1;
    const have = slots.get(hash);
    if (have) { have.lastSeen = performance.now(); have.distance = distance; return have.slot; }
    return -1;
  }

  /**
   * Upload one player's sheet. `image` is anything texSubImage2D takes (a canvas, an
   * ImageBitmap, an HTMLImageElement) sized SLOT_W × SLOT_H. Evicts the furthest slot when
   * the atlas is full.
   */
  function registerAvatar(hash, image) {
    if (!hash || slots.has(hash)) return slots.get(hash)?.slot ?? -1;
    let slot = freeSlots.pop();
    if (slot === undefined) {
      // Evict the least recently used slot that no near player needs.
      let worst = null;
      for (const [h, rec] of slots) if (!worst || (rec.distance ?? 1e9) > (worst[1].distance ?? 1e9)) worst = [h, rec];
      if (!worst) return -1;
      slots.delete(worst[0]);
      slot = worst[1].slot;
    }
    const col = slot % COLS, row = Math.floor(slot / COLS);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    try {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, col * SLOT_W, row * SLOT_H, gl.RGBA, gl.UNSIGNED_BYTE, image);
    } catch (err) {
      gl.bindTexture(gl.TEXTURE_2D, null);
      freeSlots.push(slot);
      console.warn('[players] avatar upload failed', err.message);
      return -1;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    slots.set(hash, { slot, lastSeen: performance.now(), distance: 0 });
    stats.slots = slots.size;
    return slot;
  }

  /** Drop a taken-down avatar so nobody keeps drawing it (AVATAR_UNPUBLISHED). */
  function forgetAvatar(hash) {
    const rec = slots.get(hash);
    if (!rec) return false;
    slots.delete(hash);
    freeSlots.push(rec.slot);
    stats.slots = slots.size;
    for (const p of players.values()) if (p.avatarHash === hash) p.avatarHash = null;
    return true;
  }

  /**
   * Replace the visible set. Each entry: { id, x, z, facing|h, faction, avatarHash, name,
   * stale, kind, t }. Positions are snapshots; the layer interpolates between them.
   */
  function setPlayers(list, nowMs = performance.now()) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let rec = players.get(p.id);
      if (!rec) {
        rec = { id: p.id, history: [], x: p.x, z: p.z, h: p.h ?? p.facing ?? 0, faction: p.faction, name: p.name, avatarHash: p.avatarHash ?? null, kind: p.kind, stale: !!p.stale };
        players.set(p.id, rec);
      }
      rec.faction = p.faction ?? rec.faction;
      rec.name = p.name ?? rec.name;
      rec.avatarHash = p.avatarHash ?? rec.avatarHash;
      rec.kind = p.kind ?? rec.kind;
      rec.stale = !!p.stale;
      rec.h = p.h ?? p.facing ?? rec.h;
      const last = rec.history[rec.history.length - 1];
      if (!last || last.x !== p.x || last.z !== p.z) {
        rec.history.push({ t: nowMs, x: p.x, z: p.z });
        if (rec.history.length > 3) rec.history.shift();
      }
      rec.lastT = nowMs;
    }
    for (const id of [...players.keys()]) if (!seen.has(id)) players.delete(id);
  }

  function removePlayer(id) {
    return players.delete(id);
  }

  /** Hermite-free linear interpolation at `now − 1000 ms`, then dead reckoning. */
  function sample(rec, nowMs) {
    const target = nowMs - RENDER_DELAY_MS;
    const h = rec.history;
    if (!h.length) return { x: rec.x, z: rec.z, moving: false };
    if (h.length === 1 || target <= h[0].t) return { x: h[0].x, z: h[0].z, moving: false };
    for (let i = h.length - 1; i > 0; i--) {
      const b = h[i], a = h[i - 1];
      if (target >= a.t && target <= b.t) {
        const k = (target - a.t) / Math.max(1, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, moving: Math.hypot(b.x - a.x, b.z - a.z) > 1e-3 };
      }
    }
    // Past the newest snapshot: dead reckon along the last leg for up to 3 s, then hold.
    const b = h[h.length - 1], a = h[h.length - 2];
    const dt = Math.max(1, b.t - a.t);
    const vx = (b.x - a.x) / dt, vz = (b.z - a.z) / dt;
    const ahead = Math.min(target - b.t, DEAD_RECKON_MS);
    const speed = Math.hypot(vx, vz) * 1000;
    const k = speed > MAX_DR_SPEED ? MAX_DR_SPEED / speed : 1;
    return { x: b.x + vx * ahead * k, z: b.z + vz * ahead * k, moving: speed > 1e-4 };
  }

  const factionRGB = (hex) => {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return [0.55, 0.6, 0.72];
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  };

  /**
   * Rebuild the instance buffers for this frame.
   * @param {{x:number,z:number}} camera  camera target, for LOD
   * @param {(faction:string)=>string} colourOf  faction id → hex
   * @param {number} nowMs
   * @param {number} t  seconds, for the walk cycle
   */
  function update(camera, colourOf, nowMs, t) {
    const rows = [];
    const clusters = new Map();
    stats.sprites = 0; stats.pills = 0; stats.clusters = 0;

    for (const rec of players.values()) {
      const s = sample(rec, nowMs);
      rec.x = s.x; rec.z = s.z;
      const d = Math.hypot(s.x - camera.x, s.z - camera.z);
      if (d >= LOD_PILL) {
        const cx = Math.round(s.x / CLUSTER_CELL) * CLUSTER_CELL;
        const cz = Math.round(s.z / CLUSTER_CELL) * CLUSTER_CELL;
        const key = `${cx},${cz}`;
        const c = clusters.get(key) ?? { x: cx, z: cz, n: 0, faction: rec.faction };
        c.n += 1;
        clusters.set(key, c);
        continue;
      }
      const rgb = factionRGB(colourOf(rec.faction));
      const slot = d < LOD_SPRITE ? slotFor(rec.avatarHash, d) : -1;
      const frame = s.moving ? Math.floor(t * 8) % FRAMES : 0;
      rows.push([s.x, s.z, rec.h, slot, frame, 0, slot >= 0 ? 1.3 : 0.7, rec.stale ? 0.65 : 1, rgb[0], rgb[1], rgb[2], rec.stale ? 1 : 0]);
      if (slot >= 0) stats.sprites += 1; else stats.pills += 1;
    }
    for (const c of clusters.values()) {
      const rgb = factionRGB(colourOf(c.faction));
      const scale = 0.6 + Math.log2(c.n + 1) * 0.45;
      rows.push([c.x, c.z, 0, -1, 0, 0, scale, 0.9, rgb[0], rgb[1], rgb[2], 0]);
      stats.clusters += 1;
    }

    // One interleaved buffer, grown in place: 12 floats per instance, matching the three
    // vec4 attributes' combined 48-byte stride.
    count = rows.length;
    if (packed.length < count * 12) packed = new Float32Array((count + 64) * 12);
    for (let i = 0; i < count; i++) {
      const r = rows[i];
      const o = i * 12;
      for (let k = 0; k < 12; k++) packed[o + k] = r[k];
    }
    stats.drawn = count;
    return count;
  }

  /** One instanced draw, depth-tested so buildings occlude the crowd. */
  function draw(proj, view, right) {
    if (!count) return 0;
    program.use();
    gl.uniformMatrix4fv(program.u.uProj, false, proj);
    gl.uniformMatrix4fv(program.u.uView, false, view);
    gl.uniform3fv(program.u.uRight, right);
    gl.uniform2f(program.u.uAtlas, COLS, ROWS);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(program.u.uAtlasTex, 0);
    mesh.setInstances(packed.subarray(0, count * 12), count);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    drawInstanced(gl, mesh);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return 1;
  }

  function destroy() {
    disposeMesh(gl, mesh);
    gl.deleteTexture(tex);
    players.clear();
    slots.clear();
  }

  return {
    registerAvatar, forgetAvatar, setPlayers, removePlayer, update, draw, destroy, stats,
    knownAvatar: (hash) => slots.has(hash),
    count: () => players.size,
    list: () => [...players.values()],
    get: (id) => players.get(id),
  };
}
