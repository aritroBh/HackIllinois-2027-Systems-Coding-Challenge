/**
 * glx — compatibility barrel. The layer is split into glx-geometry.js (pure,
 * worker-safe) and glx-gl.js (WebGL2 plumbing); import those directly in new
 * code. This file keeps `import ... from './glx.js'` working.
 */
export * from './glx-geometry.js';
export * from './glx-gl.js';
