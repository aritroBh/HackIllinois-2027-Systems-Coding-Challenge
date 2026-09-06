/**
 * tiles — streaming, culling and LOD for the schema-2 campus (plan §B3).
 *
 * The index lists 500 m tiles with an AABB and a content-addressed file. The
 * manager keeps a resident set around the camera target and the player (a
 * 5×5 ring each), fetches missing tiles nearest-first with at most three in
 * flight, bakes them (in the worker when available), and unloads tiles that
 * have sat outside a 7×7 ring for ten seconds. Each frame `select()` returns
 * the visible resident tiles with a LOD picked by distance with 10 %
 * hysteresis: L0 < 100 units (full roofs, parapets, holes), L1 < 250 (flat
 * extrusion + cap), L2 beyond (footprint decals).
 */
import { frustumPlanes, aabbVisible } from './glx-geometry.js';

const LOD_NEAR = 100, LOD_MID = 250, HYST = 0.1;
/**
 * 3×3 resident around each centre, a prefetch ring beyond it, and a 7×7 keep ring before
 * anything is unloaded (plan §B3). RING_LOAD 1 is the 3×3; RING_PREFETCH fetches the next
 * ring at low priority so walking into it is not a stall.
 */
const RING_LOAD = 1, RING_PREFETCH = 2, RING_KEEP = 3, UNLOAD_MS = 10000, MAX_INFLIGHT = 3;
/** Past this, camera and player are looking at different places (plan §B3). */
const SPLIT_VIEW_UNITS = 100;

export function createTileManager({ index, baseUrl, bake, upload, dispose, onTile, useWorker = true, workerUrl = '/dashboard/gl/bake-worker.js' }) {
  const tileUnits = index.meta.tileUnits || 50;
  const vscale = index.meta.vscale || 2.6;
  const byKey = new Map(index.tiles.map((t) => [`${t.x},${t.z}`, t]));
  const resident = new Map();   // key → { entry, meshes, trees, lamps, lod, lastWanted }
  const inflight = new Map();   // key → AbortController
  let worker = null, nextJob = 1;
  const jobs = new Map();
  let setVersion = 0;           // bumps whenever the resident set changes (instance buffers rebuild)
  const stats = { resident: 0, inflight: 0, drawn: 0, tris: 0, worker: false };

  if (useWorker && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(workerUrl, { type: 'module' });
      worker.onmessage = ({ data }) => {
        const job = jobs.get(data.id);
        if (!job) return;
        jobs.delete(data.id);
        if (data.error) job.reject(new Error(data.error)); else job.resolve(data.baked);
      };
      worker.onerror = (e) => { console.warn('[tiles] worker failed, baking on the main thread', e.message); worker = null; };
      stats.worker = true;
    } catch (err) {
      console.warn('[tiles] no worker:', err.message);
      worker = null;
    }
  }

  function bakeAsync(tile, opts) {
    if (!worker) return Promise.resolve(bake(tile, opts));
    return new Promise((resolve, reject) => {
      const id = nextJob++;
      jobs.set(id, { resolve, reject });
      worker.postMessage({ id, tile, opts });
    });
  }

  const keyOf = (x, z) => `${Math.floor(x / tileUnits)},${Math.floor(z / tileUnits)}`;
  const parseKey = (k) => k.split(',').map(Number);

  function wantedSet(centres, ring) {
    const out = new Map();
    for (const [cx, cz] of centres) {
      const [tx, tz] = parseKey(keyOf(cx, cz));
      for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++) {
        const k = `${tx + dx},${tz + dz}`;
        const entry = byKey.get(k);
        if (!entry || !entry.bytes) continue;
        const ex = (entry.bbox[0] + entry.bbox[2]) / 2, ez = (entry.bbox[1] + entry.bbox[3]) / 2;
        const d = Math.hypot(ex - cx, ez - cz);
        const prev = out.get(k);
        if (!prev || d < prev.d) out.set(k, { entry, d });
      }
    }
    return out;
  }

  async function fetchTile(k, entry, opts) {
    const ctrl = new AbortController();
    inflight.set(k, ctrl);
    stats.inflight = inflight.size;
    try {
      const res = await fetch(`${baseUrl}/${entry.file}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`tile ${entry.file} ${res.status}`);
      const tile = await res.json();
      const baked = await bakeAsync(tile, opts);
      if (ctrl.signal.aborted) return;
      const meshes = upload(baked);
      resident.set(k, { entry, tile, meshes, trees: baked.trees, lamps: baked.lamps, lod: 2, lastWanted: performance.now(), bounds: [entry.bbox[0], 0, entry.bbox[1], entry.bbox[2], entry.maxH * vscale + 6, entry.bbox[3]] });
      setVersion++;
      stats.resident = resident.size;
      if (onTile) onTile(tile, entry);
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('[tiles]', err.message);
    } finally {
      inflight.delete(k);
      stats.inflight = inflight.size;
    }
  }

  function update({ target, player, now, opts }) {
    const centres = [target];
    if (player) centres.push(player);
    const wanted = wantedSet(centres, RING_LOAD);
    const prefetch = wantedSet(centres, RING_PREFETCH);
    const keep = wantedSet(centres, RING_KEEP);
    for (const k of wanted.keys()) { const r = resident.get(k); if (r) r.lastWanted = now; }
    // Fetch missing, nearest first, bounded in-flight. The 3×3 goes first; the prefetch
    // ring fills whatever budget is left over.
    const missing = [...wanted.entries(), ...[...prefetch.entries()].filter(([k]) => !wanted.has(k))]
      .filter(([k]) => !resident.has(k) && !inflight.has(k))
      .sort((a, b) => a[1].d - b[1].d);
    for (const [k, { entry }] of missing) {
      if (inflight.size >= MAX_INFLIGHT) break;
      fetchTile(k, entry, opts);
    }
    // Cancel fetches that are no longer wanted.
    for (const [k, ctrl] of inflight) if (!keep.has(k)) { ctrl.abort(); inflight.delete(k); }
    // Unload after a grace period.
    for (const [k, r] of resident) {
      if (keep.has(k)) { r.lastWanted = now; continue; }
      if (now - r.lastWanted > UNLOAD_MS) { dispose(r.meshes); resident.delete(k); setVersion++; }
    }
    stats.resident = resident.size;
  }

  function select(viewProj, target, player) {
    const planes = frustumPlanes(viewProj);
    const out = [];
    let tris = 0;
    // Orbiting far from the player would otherwise hold two full L0 rings — one around the
    // camera, one around the sprite — and blow the vertex budget. The player's ring is
    // capped at L1 whenever the two are far apart.
    const split = player ? Math.hypot(player[0] - target[0], player[1] - target[1]) > SPLIT_VIEW_UNITS : false;
    for (const r of resident.values()) {
      const b = r.bounds;
      if (!aabbVisible(planes, [b[0], b[1], b[2]], [b[3], b[4], b[5]])) continue;
      const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
      const d = Math.hypot(cx - target[0], cz - target[1]);
      // Hysteresis: only cross a threshold once well past it.
      let lod = r.lod;
      if (lod === 0 && d > LOD_NEAR * (1 + HYST)) lod = 1;
      else if (lod === 1 && d < LOD_NEAR * (1 - HYST)) lod = 0;
      if (lod === 1 && d > LOD_MID * (1 + HYST)) lod = 2;
      else if (lod === 2 && d < LOD_MID * (1 - HYST)) lod = 1;
      if (r.lod === 2 && d < LOD_NEAR * (1 - HYST)) lod = 0;
      if (split && lod === 0) {
        const dp = Math.hypot(cx - player[0], cz - player[1]);
        if (dp < d) lod = 1; // this tile is the player's, not the camera's
      }
      r.lod = lod;
      const range = r.meshes.solid ? r.meshes.solid.ranges[lod] : null;
      if (range) tris += range.count / 3;
      out.push({ resident: r, lod, distance: d });
    }
    stats.drawn = out.length;
    stats.tris = tris;
    return out;
  }

  /** Concatenated instance rows for the visible tiles (trees: 4 floats, lamps: 2). */
  function instances(selected, { treeMaxDist = Infinity, target = [0, 0] } = {}) {
    let nT = 0, nL = 0;
    for (const s of selected) { nT += s.resident.trees.length / 4; nL += s.resident.lamps.length / 2; }
    const trees = new Float32Array(nT * 4), lamps = new Float32Array(nL * 2);
    let oT = 0, oL = 0;
    for (const s of selected) {
      const tr = s.resident.trees;
      if (s.lod === 2 && treeMaxDist < Infinity) continue;   // far tiles: no greenery on low tiers
      for (let i = 0; i < tr.length; i += 4) {
        if (treeMaxDist < Infinity && Math.hypot(tr[i] - target[0], tr[i + 1] - target[1]) > treeMaxDist) continue;
        trees[oT++] = tr[i]; trees[oT++] = tr[i + 1]; trees[oT++] = tr[i + 2]; trees[oT++] = tr[i + 3];
      }
      const la = s.resident.lamps;
      if (s.lod > 1) continue;
      for (let i = 0; i < la.length; i += 2) { lamps[oL++] = la[i]; lamps[oL++] = la[i + 1]; }
    }
    return { trees: trees.subarray(0, oT), lamps: lamps.subarray(0, oL) };
  }

  function destroy() {
    for (const ctrl of inflight.values()) ctrl.abort();
    inflight.clear();
    for (const r of resident.values()) dispose(r.meshes);
    resident.clear();
    if (worker) worker.terminate();
  }

  return { update, select, instances, destroy, stats, get version() { return setVersion; }, resident, index };
}
