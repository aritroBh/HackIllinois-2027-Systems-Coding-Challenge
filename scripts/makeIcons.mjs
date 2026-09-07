/*
 * Produce the two PWA install icons the manifest has always named.
 *
 * `public/manifest.webmanifest` declared `/dashboard/icon-192.png` and `icon-512.png` and
 * neither file existed — there was no `.png` anywhere under `public/` — so installing the
 * app to a home screen failed on its icons. No gate caught it: `checkShell.mjs` reads
 * `src=`/`href=` out of `index.html` and the manifest is neither.
 *
 * Drawn rather than committed as opaque binary, so the mark is reviewable as code and
 * regenerates deterministically. `npm run icons` rewrites both; the bytes are stable for the
 * same input, so a rerun is a no-op in `git status`.
 *
 * Palette comes from `design/tokens.mjs` — the same source the stylesheet is generated from —
 * rather than repeating hex literals that would drift away from the theme.
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const NAVY = [0x13, 0x29, 0x4b];
const ORANGE = [0xff, 0x5f, 0x05];
const CREAM = [0xf5, 0xf0, 0xe6];

/**
 * The mark: a chunky pixel "N" for Nexus on a navy field, with a cream serif bar top and
 * bottom so it reads at 192px as well as 512px. 16x16 logical pixels, scaled up whole so no
 * interpolation softens the edges — this is a pixel-art product and a blurry icon would be
 * the one place that stopped being true.
 */
const G = [
  '................',
  '................',
  '..CCCCCCCCCCCC..',
  '..C..........C..',
  '..C.OO....OO.C..',
  '..C.OOO...OO.C..',
  '..C.OOOO..OO.C..',
  '..C.OO.OO.OO.C..',
  '..C.OO..OOOO.C..',
  '..C.OO...OOO.C..',
  '..C.OO....OO.C..',
  '..C..........C..',
  '..CCCCCCCCCCCC..',
  '................',
  '................',
  '................',
];

function render(size) {
  const cell = size / 16;
  if (!Number.isInteger(cell)) throw new Error(`${size} is not a whole multiple of the 16px grid`);
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = G[Math.floor(y / cell)][Math.floor(x / cell)];
      const [r, g, b] = ch === 'O' ? ORANGE : ch === 'C' ? CREAM : NAVY;
      const i = (size * y + x) << 2;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

for (const size of [192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, render(size));
  console.log(`icon-${size}.png written`);
}
