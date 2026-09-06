/**
 * bake-worker — turns a campus tile's JSON into vertex buffers off the main
 * thread. Pure geometry only (glx-geometry.js + tile-bake.js); the renderer
 * uploads the returned typed arrays with one bufferData each.
 */
import { bakeTile } from './tile-bake.js';

self.onmessage = ({ data }) => {
  try {
    const baked = bakeTile(data.tile, data.opts);
    const transfer = [];
    for (const g of [baked.solid, baked.decal]) {
      if (!g) continue;
      for (const k of ['positions', 'normals', 'colors', 'emissives', 'matTint', 'extras', 'indices']) if (g[k]) transfer.push(g[k].buffer);
    }
    transfer.push(baked.trees.buffer, baked.lamps.buffer);
    self.postMessage({ id: data.id, baked }, transfer);
  } catch (err) {
    self.postMessage({ id: data.id, error: err.message || String(err) });
  }
};
