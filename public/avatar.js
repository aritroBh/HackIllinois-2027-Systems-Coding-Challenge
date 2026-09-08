/**
 * avatar — turn a photo into a retro pixel-art player sprite.
 *
 * Pipeline: capture (camera or file) → face-safe square crop → area-averaged
 * downsample to 32×32 → auto-levels + saturation lift → palette quantisation
 * in OKLab (optionally Bayer-dithered) → chibi body composite → 4-frame walk
 * cycle sheet the 3D renderer can billboard.
 *
 * Dependency-free ES module: the dashboard's CSP is 'self'-only.
 */

/* ------------------------------------------------------------------ *
 * Palettes — every colour is from the official Illini set or a tone
 * needed to make a face read (skin, hair, cream, black).
 * ------------------------------------------------------------------ */

const P = (hex) => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

/** Four-tone handheld ramp on Illini navy. Darkest → lightest. */
export const GAMEBOY = {
  name: 'GAMEBOY',
  colors: ['#0B1220', '#13294B', '#5F7091', '#C6C7C6'].map(P),
  transparentIndex: -1,
};

/** Sixteen colours: the brand set plus what a portrait needs. */
export const SNES16 = {
  name: 'SNES16',
  colors: [
    '#0B0D14', '#13294B', '#FF5F05', '#009FD4', '#007E8E', '#FCB316', '#006230', '#7D3E13',
    '#707372', '#8E9090', '#C6C7C6', '#F4EDE1', // cream
    '#F1C9A5', '#B57A4B',                       // two skin tones
    '#3B2A1E', '#D8B26A',                       // two hair tones
  ].map(P),
};

/** Twelve flat saturated colours — the neo-retro look. */
export const NEORETRO = {
  name: 'NEORETRO',
  colors: [
    '#13294B', '#1F3D6E', '#FF5F05', '#FFB38A', '#009FD4', '#007E8E',
    '#FCB316', '#006230', '#7D3E13', '#F4EDE1', '#E8A87C', '#2B1B12',
  ].map(P),
};

export const PALETTES = { GAMEBOY, SNES16, NEORETRO };

/* ------------------------------------------------------------------ *
 * Colour maths — OKLab, so "nearest colour" matches what eyes see.
 * ------------------------------------------------------------------ */

const toLinear = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function rgbToOklab(r, g, b) {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Per-palette OKLab cache so quantising 1024 pixels is a handful of adds. */
const labCache = new WeakMap();
function paletteLab(palette) {
  let lab = labCache.get(palette);
  if (!lab) {
    lab = palette.colors.map(([r, g, b]) => rgbToOklab(r, g, b));
    labCache.set(palette, lab);
  }
  return lab;
}

// Lightness is weighted above chroma: a face is recognised by its value
// structure, and a hue-accurate but flat match reads as a blob.
const L_WEIGHT = 2.2;

function nearest(lab, palLab) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palLab.length; i++) {
    const p = palLab[i];
    const dl = (lab[0] - p[0]) * L_WEIGHT, da = lab[1] - p[1], db = lab[2] - p[2];
    const d = dl * dl + da * da + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 4×4 Bayer threshold, centred on zero. */
const BAYER = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
].map((row) => row.map((v) => v / 16 - 0.5));

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

export class CameraError extends Error {
  constructor(message, reason) { super(message); this.reason = reason; }
}

/**
 * Opens the front camera into `videoEl`, counts down, and returns a frame.
 * `onTick(n)` fires each second of the countdown. Rejects with a CameraError
 * whose `reason` is 'denied' | 'unavailable' | 'insecure' so the UI can offer
 * the file fallback with the right copy.
 */
export async function captureFromCamera(videoEl, { countdown = 3, onTick } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('Camera API unavailable — use a photo instead.', window.isSecureContext ? 'unavailable' : 'insecure');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } },
      audio: false,
    });
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    throw new CameraError(
      denied ? 'Camera permission was declined — upload a photo instead.' : 'No camera found — upload a photo instead.',
      denied ? 'denied' : 'unavailable'
    );
  }
  try {
    videoEl.srcObject = stream;
    await videoEl.play();
    for (let n = countdown; n > 0; n--) {
      onTick?.(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    onTick?.(0);
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth || 640;
    c.height = videoEl.videoHeight || 480;
    const ctx = c.getContext('2d');
    // Mirror so the capture matches what the user saw in the preview.
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, 0, 0);
    return c;
  } finally {
    stream.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }
}

/**
 * Loads a File/Blob into a drawable. createImageBitmap decodes straight from
 * the blob (and honours EXIF orientation, which matters for phone photos);
 * the object-URL Image route is the fallback for browsers without it.
 */
export async function fromImageFile(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall through to the Image route */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image the browser can read.')); };
    img.src = url;
  });
}

/* ------------------------------------------------------------------ *
 * Pixelate
 * ------------------------------------------------------------------ */

function sourceSize(src) {
  return {
    w: src.videoWidth || src.naturalWidth || src.width,
    h: src.videoHeight || src.naturalHeight || src.height,
  };
}

/**
 * Photo → palette-quantised ImageData of `size`×`size`.
 *
 * Options: palette (default SNES16), dither (default true), size (32),
 * faceBias (0..1, how far above centre the square crop sits; 0.3 keeps a
 * standing person's head in frame), contrast (auto-levels strength 0..1),
 * saturation (chroma multiplier, 1.25 keeps skin from going grey).
 */
export function pixelate(source, opts = {}) {
  const {
    palette = SNES16, dither = true, size = 32,
    faceBias = 0.3, contrast = 1, saturation = 1.25, ditherStrength = 0.07,
  } = opts;

  const { w, h } = sourceSize(source);
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = (h - side) * Math.max(0, Math.min(1, 0.5 - faceBias * 0.5));

  // Read the crop at native resolution; every target pixel then averages
  // its whole source block. Nearest-neighbour here is what makes photo
  // pixel-art look like static.
  const work = document.createElement('canvas');
  work.width = side; work.height = side;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  wctx.drawImage(source, sx, sy, side, side, 0, 0, side, side);
  const src = wctx.getImageData(0, 0, side, side).data;

  const n = size * size;
  const lab = new Float32Array(n * 3);
  const block = side / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * block), y1 = Math.max(y0 + 1, Math.floor((y + 1) * block));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * block), x1 = Math.max(x0 + 1, Math.floor((x + 1) * block));
      let r = 0, g = 0, b = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * side + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) { r += src[i]; g += src[i + 1]; b += src[i + 2]; c++; }
      }
      const o = (y * size + x) * 3;
      const l = rgbToOklab(r / c, g / c, b / c);
      lab[o] = l[0]; lab[o + 1] = l[1]; lab[o + 2] = l[2];
    }
  }

  // Auto-levels on lightness: stretch the 2nd–98th percentile across most of
  // the range. Photos of faces cluster in the midtones, and a palette with
  // four or twelve entries needs the structure pulled apart first.
  if (contrast > 0) {
    const Ls = Array.from({ length: n }, (_, i) => lab[i * 3]).sort((a, b) => a - b);
    const lo = Ls[Math.floor(n * 0.02)], hi = Ls[Math.floor(n * 0.98)];
    const span = Math.max(1e-3, hi - lo);
    for (let i = 0; i < n; i++) {
      const L = lab[i * 3];
      const stretched = 0.08 + ((L - lo) / span) * 0.88;
      lab[i * 3] = L + (Math.max(0, Math.min(1, stretched)) - L) * contrast;
      lab[i * 3 + 1] *= saturation;
      lab[i * 3 + 2] *= saturation;
    }
  }

  const palLab = paletteLab(palette);
  const out = new ImageData(size, size);
  const px = out.data;
  const tmp = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      tmp[0] = lab[i * 3]; tmp[1] = lab[i * 3 + 1]; tmp[2] = lab[i * 3 + 2];
      if (dither) tmp[0] += BAYER[y & 3][x & 3] * ditherStrength;
      const [r, g, b] = palette.colors[nearest(tmp, palLab)];
      const o = i * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }

  return out;
}

/** ImageData → PNG data URL, for localStorage. */
export function toDataURL(imageData) {
  const c = document.createElement('canvas');
  c.width = imageData.width; c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return c.toDataURL('image/png');
}

/** data URL → ImageData (the inverse, for restoring a saved avatar). */
export function fromDataURL(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/** Crisp nearest-neighbour upscale into `canvas`. */
export function renderPreview(canvas, imageData, scale = 8) {
  canvas.width = imageData.width * scale;
  canvas.height = imageData.height * scale;
  const tmp = document.createElement('canvas');
  tmp.width = imageData.width; tmp.height = imageData.height;
  tmp.getContext('2d').putImageData(imageData, 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Sprite — chibi body under the pixel head, 4-frame walk cycle
 * ------------------------------------------------------------------ */

/**
 * Jacket colours for the shipped pack, and the fallback for anything else.
 *
 * These are ids this repository happens to ship. A fork's factions are not among them, so
 * `FACTION_COLORS[faction] || NEUTRAL` dressed **every** trainer in a fork in the unclaimed
 * grey — the one colour that means "on no side" — while the rest of that fork's UI drew their
 * team's real colour from the pack. `factionColour` below prefers the pack's own value and
 * keeps this table only as the pre-pack default.
 */
export const FACTION_COLORS = {
  TEAM_KERNEL: '#22D3EE',
  TEAM_TENSOR: '#A78BFA',
  TEAM_SILICON: '#FBBF24',
  NEUTRAL: '#8E9090',
};

/** The pack's colour for a faction id, else this file's default, else neutral grey. */
export function factionColour(id) {
  const list = globalThis.Nexus?.content?.factions;
  const fromPack = Array.isArray(list) ? list.find((f) => f && f.id === id)?.color : null;
  return fromPack || FACTION_COLORS[id] || FACTION_COLORS.NEUTRAL;
}

// 32 wide × 22 tall body, rows 26..47 of the frame. Legend:
// . transparent  O outline  J jacket  j jacket shade  S skin  P pants
// p pants shade  B boots    Z zip/trim
const BODY_FRAMES = [
  // frame 0 — standing
  [
    '..........OOOOOOOOOOOO..........',
    '.........OJJJJJJZZJJJJO.........',
    '........OJJJJJJJZZJJJJJO........',
    '.......OJJJJJJJJZZJJJJJJO.......',
    '.......OJJJJJJJJZZJJJJJJO.......',
    '......OSJJJJJJJJZZJJJJJJSO......',
    '......OSjJJJJJJJZZJJJJJJSO......',
    '......OOjjJJJJJJZZJJJJJjOO......',
    '.......OjjjjJJJJZZJJJjjjO.......',
    '........OjjjjjjjjjjjjjjO........',
    '.........OOOOOOOOOOOOOO.........',
    '.........OPPPPPPOPPPPPPO........',
    '.........OPPPPPPOPPPPPPO........',
    '.........OPPPPPpOpPPPPPO........',
    '.........OPPPPPpOpPPPPPO........',
    '.........OpPPPPpOpPPPPpO........',
    '.........OpppppOOOpppppO........',
    '.........OBBBBBO.OBBBBBO........',
    '.........OBBBBBO.OBBBBBO........',
    '.........OOOOOOO.OOOOOOO........',
    '................................',
    '................................',
  ],
  // frame 1 — left leg forward
  [
    '..........OOOOOOOOOOOO..........',
    '.........OJJJJJJZZJJJJO.........',
    '........OJJJJJJJZZJJJJJO........',
    '.......OJJJJJJJJZZJJJJJJO.......',
    '......OSJJJJJJJJZZJJJJJJO.......',
    '......OSJJJJJJJJZZJJJJJJSO......',
    '.......OjJJJJJJJZZJJJJJJSO......',
    '.......OjjJJJJJJZZJJJJJjOO......',
    '.......OjjjjJJJJZZJJJjjjO.......',
    '........OjjjjjjjjjjjjjjO........',
    '.........OOOOOOOOOOOOOO.........',
    '........OPPPPPPO.OPPPPPO........',
    '.......OPPPPPPO...OPPPPPO.......',
    '.......OPPPPPpO...OpPPPPO.......',
    '......OPPPPPpO.....OpPPPPO......',
    '......OpPPPpO.......OpPPpO......',
    '......OpppppO.......OppppO......',
    '......OBBBBBO.......OBBBBO......',
    '......OBBBBBO.......OBBBBO......',
    '......OOOOOOO.......OOOOOO......',
    '................................',
    '................................',
  ],
  // frame 2 — standing (bob)
  null,
  // frame 3 — right leg forward
  [
    '..........OOOOOOOOOOOO..........',
    '.........OJJJJJJZZJJJJO.........',
    '........OJJJJJJJZZJJJJJO........',
    '.......OJJJJJJJJZZJJJJJJO.......',
    '.......OJJJJJJJJZZJJJJJJSO......',
    '......OSJJJJJJJJZZJJJJJJSO......',
    '......OSJJJJJJJJZZJJJJJjO.......',
    '......OOjJJJJJJJZZJJJJjjO.......',
    '.......OjjjjJJJJZZJJJjjjO.......',
    '........OjjjjjjjjjjjjjjO........',
    '.........OOOOOOOOOOOOOO.........',
    '........OPPPPPO.OPPPPPPO........',
    '.......OPPPPPO...OPPPPPPO.......',
    '.......OPPPPpO...OpPPPPPO.......',
    '......OPPPPpO.....OpPPPPPO......',
    '......OpPPpO.......OpPPPpO......',
    '......OppppO.......OpppppO......',
    '......OBBBBO.......OBBBBBO......',
    '......OBBBBO.......OBBBBBO......',
    '......OOOOOO.......OOOOOOO......',
    '................................',
    '................................',
  ],
];
BODY_FRAMES[2] = BODY_FRAMES[0];

// Rows 0..5 of the frame when a cap is on: a flat-brim cap in Illini orange.
const CAP = [
  '............OOOOOOOO............',
  '..........OOCCCCCCCCOO..........',
  '.........OCCCCCCCCCCCCO.........',
  '........OCCCCCCcCCCCCCCO........',
  '........OCCCCCCcCCCCCCCO........',
  '......OOOCCCCCCCCCCCCCCOOO......',
];

function shade(hex, k) {
  const [r, g, b] = P(hex);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/**
 * Composes the 32×32 head onto a chibi body and returns a 4-frame walk cycle
 * as a single horizontal sheet (canvas, 128×48). Frames: stand, left step,
 * stand, right step. `frameAt(canvas, i)` returns the source rect.
 */
export function sprite(headImageData, { faction = 'NEUTRAL', cap = true, skin = '#F1C9A5' } = {}) {
  const jacket = factionColour(faction);
  const FW = 32, FH = 48, FRAMES = 4;

  const sheet = document.createElement('canvas');
  sheet.width = FW * FRAMES; sheet.height = FH;
  const ctx = sheet.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // The head at 26×26 with rounded corners, so a square photo crop reads as a
  // head rather than a tile. Shrunk with area averaging from the 32×32 source.
  const head = document.createElement('canvas');
  head.width = 26; head.height = 26;
  const hctx = head.getContext('2d');
  const src = document.createElement('canvas');
  src.width = headImageData.width; src.height = headImageData.height;
  src.getContext('2d').putImageData(headImageData, 0, 0);
  hctx.imageSmoothingEnabled = true;
  hctx.drawImage(src, 0, 0, 26, 26);
  // Re-quantise the shrunk head so smoothing did not reintroduce midtones.
  const hd = hctx.getImageData(0, 0, 26, 26);
  const palette = closestPalette(headImageData);
  const palLab = paletteLab(palette);
  for (let i = 0; i < hd.data.length; i += 4) {
    const [r, g, b] = palette.colors[nearest(rgbToOklab(hd.data[i], hd.data[i + 1], hd.data[i + 2]), palLab)];
    hd.data[i] = r; hd.data[i + 1] = g; hd.data[i + 2] = b;
    // Oval mask, slightly taller than wide: a square photo crop reads as a
    // head only once the background outside the face is gone.
    const x = (i / 4) % 26, y = Math.floor(i / 4 / 26);
    const dx = (x + 0.5 - 13) / 12.6, dy = (y + 0.5 - 13.4) / 13.3;
    if (dx * dx + dy * dy > 1) hd.data[i + 3] = 0;
  }
  hctx.putImageData(hd, 0, 0);

  const colors = {
    O: '#0B0D14', J: jacket, j: shade(jacket, 0.72), S: skin,
    P: '#13294B', p: '#0B1A33', B: '#2B1B12', Z: '#F4EDE1',
    C: '#FF5F05', c: '#C2410C',
  };

  for (let f = 0; f < FRAMES; f++) {
    const ox = f * FW;
    const bob = f % 2 === 1 ? 1 : 0; // head dips on the step frames
    // Head, with a 1px outline drawn from the mask.
    ctx.drawImage(head, ox + 3, 1 + bob);
    ctx.fillStyle = colors.O;
    const hd2 = hctx.getImageData(0, 0, 26, 26).data;
    for (let y = 0; y < 26; y++) for (let x = 0; x < 26; x++) {
      if (hd2[(y * 26 + x) * 4 + 3]) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const xx = x + dx, yy = y + dy;
        return xx >= 0 && yy >= 0 && xx < 26 && yy < 26 && hd2[(yy * 26 + xx) * 4 + 3];
      });
      if (n) ctx.fillRect(ox + 3 + x, 1 + bob + y, 1, 1);
    }
    if (cap) {
      for (let y = 0; y < CAP.length; y++) for (let x = 0; x < FW; x++) {
        const ch = CAP[y][x];
        if (ch === '.') continue;
        ctx.fillStyle = colors[ch];
        ctx.fillRect(ox + x, y + bob, 1, 1);
      }
    }
    const body = BODY_FRAMES[f];
    for (let y = 0; y < body.length; y++) for (let x = 0; x < FW; x++) {
      const ch = body[y][x];
      if (ch === '.') continue;
      ctx.fillStyle = colors[ch];
      ctx.fillRect(ox + x, 26 + y, 1, 1);
    }
  }

  sheet.frameWidth = FW;
  sheet.frameHeight = FH;
  sheet.frames = FRAMES;
  return sheet;
}

/** Source rect for frame `i` of a sheet from `sprite()`. */
export function frameAt(sheet, i) {
  return { x: (i % sheet.frames) * sheet.frameWidth, y: 0, w: sheet.frameWidth, h: sheet.frameHeight };
}

/** Picks the palette whose colours the image is actually made of. */
function closestPalette(imageData) {
  const seen = new Set();
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  let best = SNES16, bestHit = -1;
  for (const pal of Object.values(PALETTES)) {
    const keys = new Set(pal.colors.map(([r, g, b]) => (r << 16) | (g << 8) | b));
    let hit = 0;
    for (const k of seen) if (keys.has(k)) hit++;
    if (hit > bestHit) { bestHit = hit; best = pal; }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'nexus.avatar.v1';

export function saveAvatar({ head, faction, cap, palette }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      head: toDataURL(head), faction, cap, palette: palette?.name || 'SNES16', at: Date.now(),
    }));
    return true;
  } catch { return false; }
}

export async function loadAvatar() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return { ...saved, head: await fromDataURL(saved.head), palette: PALETTES[saved.palette] || SNES16 };
  } catch { return null; }
}
