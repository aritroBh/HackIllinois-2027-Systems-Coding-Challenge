/**
 * glx-gl — the WebGL2 plumbing the campus renderer sits on: shader programs
 * with cached uniform locations, indexed meshes in VAOs, half-float
 * framebuffers, and instanced meshes (vertexAttribDivisor). Geometry lives in
 * glx-geometry.js so it can run inside a worker.
 */
/* ------------------------------------------------------------------ *
 * Program / buffer plumbing
 * ------------------------------------------------------------------ */

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

/**
 * Links a program and eagerly caches every active uniform location, so draw
 * loops can do `p.u.uModel` instead of a getUniformLocation call per frame.
 */
export function program(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }

  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { handle: p, u, use: () => gl.useProgram(p) };
}

/**
 * Uploads an indexed mesh into a VAO.
 * `attrs` is [{ loc, size, data }]; each becomes its own static ARRAY_BUFFER.
 */
export function mesh(gl, attrs, indices) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [];
  for (const a of attrs) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(a.loc);
    gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
    buffers.push(b);
  }
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: indices.length, buffers, ib };
}

/** Half-float colour target + depth renderbuffer. Half-float keeps bloom clean. */
export function framebuffer(gl, w, h, { depth = false } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  let rbo = null;
  if (depth) {
    rbo = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rbo);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbo);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, rbo, w, h };
}

export function disposeFramebuffer(gl, f) {
  if (!f) return;
  gl.deleteTexture(f.tex);
  gl.deleteFramebuffer(f.fbo);
  if (f.rbo) gl.deleteRenderbuffer(f.rbo);
}


/* ------------------------------------------------------------------ *
 * Instancing
 * ------------------------------------------------------------------ */

/**
 * An indexed mesh drawn N times with per-instance attributes (divisor 1).
 * `instanceAttrs` is [{ loc, size }]; `setInstances(data, count)` uploads a
 * packed Float32Array of `count` rows (sum of sizes floats each). Trees: one
 * 4-float row [x, z, scale, tone] per elm instead of ~120 vertices.
 */
export function instancedMesh(gl, attrs, indices, instanceAttrs) {
  const base = mesh(gl, attrs, indices);
  gl.bindVertexArray(base.vao);
  const ibuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
  const stride = instanceAttrs.reduce((s, a) => s + a.size, 0) * 4;
  let off = 0;
  for (const a of instanceAttrs) {
    gl.enableVertexAttribArray(a.loc);
    gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, stride, off);
    gl.vertexAttribDivisor(a.loc, 1);
    off += a.size * 4;
  }
  gl.bindVertexArray(null);
  const m = { ...base, instanceBuffer: ibuf, instances: 0, stride };
  m.setInstances = (data, count) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    m.instances = count ?? (data.length * 4) / stride;
  };
  return m;
}

export function drawInstanced(gl, m) {
  if (!m.instances) return;
  gl.bindVertexArray(m.vao);
  gl.drawElementsInstanced(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0, m.instances);
}

export function disposeMesh(gl, m) {
  if (!m) return;
  gl.deleteVertexArray(m.vao);
  m.buffers.forEach((b) => gl.deleteBuffer(b));
  gl.deleteBuffer(m.ib);
  if (m.instanceBuffer) gl.deleteBuffer(m.instanceBuffer);
}
