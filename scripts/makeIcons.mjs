/*
 * Produce the two PWA install icons `public/manifest.webmanifest` names.
 *
 * The manifest declared `/dashboard/icon-192.png` and `/dashboard/icon-512.png` and neither
 * file existed — there was no `.png` anywhere under `public/` — so installing the app to a
 * home screen failed on its icons. Nothing caught it, because nothing read the manifest: the
 * `href=` scan in `scripts/checkShell.mjs` does match `<link rel="manifest">` in index.html
 * (so the manifest file itself was covered, and it is in sw.js's `SHELL`), but it stopped at
 * the file's existence and never opened it to look at what the icons key pointed at. That is
 * the gap `checkShell.mjs`'s manifest-icon block closes: it now resolves every `icons[].src`
 * on disk and checks the PNG's real IHDR dimensions against the declared `sizes`.
 *
 * Drawn rather than committed as opaque binary, so the mark is reviewable as code. `npm run
 * icons` rewrites both. The output is deterministic — regenerating this file's PNGs and
 * comparing them byte-for-byte against the committed `public/icon-192.png` and
 * `public/icon-512.png` reproduces them exactly — so a rerun is a no-op in `git status`, and
 * a rerun that is *not* a no-op means somebody edited the grid or the palette below.
 *
 * WHAT NOTHING ENFORCES, so it is written down instead: this script is not part of any gate.
 * `scripts/verify.sh` does not run it, and `checkShell.mjs` only asks whether the two PNGs
 * exist and are the size they claim — not whether they are still what this file would draw.
 * Edit the grid without running `npm run icons` and the committed icons stay stale, silently.
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

/*
 * The palette, as literals. Two of the three are the shipped tokens; one is not.
 *
 * There is no import from `design/tokens.mjs` here, and these are hex literals repeating
 * values that live there — which is the drift risk, not a defence against it, and it has
 * already happened once:
 *
 *   NAVY   #13294B  == `C.ground` in design/tokens.mjs (`--ground` in public/tokens.css)
 *   ORANGE #FF5F05  == `C.orange` (`--orange`)
 *   CREAM  #F5F0E6  != `C.cream`, which is #FFF3E0 (`--cream`)
 *
 * CREAM is the odd one out and is off-theme by a visible amount. It is left as-is rather than
 * "corrected" in a docs pass, because changing it changes the committed PNG bytes and so the
 * shell hash `checkShell.mjs` guards — a palette fix is a code change that has to come with
 * `npm run icons` and a `VERSION` bump in `public/sw.js` (the icons are in `SHELL_OPTIONAL`,
 * and the hash covers optional entries too).
 *
 * Each entry is [r, g, b]; alpha is added in `render()` and is always opaque.
 */
const NAVY = [0x13, 0x29, 0x4b];
const ORANGE = [0xff, 0x5f, 0x05];
const CREAM = [0xf5, 0xf0, 0xe6];

/**
 * The mark, as a 16x16 grid of one character per logical pixel:
 *
 *   `.` navy field    `C` cream    `O` orange
 *
 * A chunky orange "N" for Nexus inside a closed cream rectangle — all four sides, not just a
 * bar top and bottom — on a navy field, with a navy margin outside the frame (two rows above,
 * three below, two columns either side) so the mark does not touch the edge of a rounded
 * home-screen tile.
 *
 * 16x16 scaled up by a whole number, so every logical pixel becomes an exact square of device
 * pixels and no interpolation softens the edges — this is a pixel-art product and a blurry
 * icon would be the one place that stopped being true.
 *
 * `render()` indexes this grid unguarded, so it must stay 16 rows of 16 characters. Fewer than
 * 16 rows throws a TypeError; a row shorter than 16 does not throw — the missing cells read as
 * `undefined`, fall through to the `NAVY` default, and quietly erase part of the mark.
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

/**
 * Draw `G` at `size`x`size` and return the encoded PNG as a Buffer.
 *
 * Nearest-neighbour by construction: each device pixel looks up its own grid cell with integer
 * division, so nothing is averaged and no anti-aliased edge appears. That only holds when the
 * scale factor is a whole number, which is what the guard is for — 16 does not divide 180, and
 * a fractional `cell` would put grid boundaries inside device pixels and give the mark ragged
 * edges of differing widths. It throws rather than rounding, because a silently uneven icon is
 * exactly the kind of thing nobody re-measures.
 *
 * Every pixel is written with alpha 255. The icons are fully opaque squares, which is why the
 * manifest declares `"purpose": "any"` for both and not `"maskable"`: there is no transparency
 * and no safe-zone padding, so a platform that mask-crops a maskable icon would cut into the
 * frame.
 */
function render(size) {
  const cell = size / 16;
  if (!Number.isInteger(cell)) throw new Error(`${size} is not a whole multiple of the 16px grid`);
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ch = G[Math.floor(y / cell)][Math.floor(x / cell)];
      // Any character that is not 'O' or 'C' is field, so '.' needs no case of its own.
      const [r, g, b] = ch === 'O' ? ORANGE : ch === 'C' ? CREAM : NAVY;
      // RGBA, so four bytes per pixel: `<< 2` is `* 4` on the pixel index.
      const i = (size * y + x) << 2;
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

// 192 and 512 because those are the two `icons[].sizes` in public/manifest.webmanifest, and
// `checkShell.mjs` fails if a declared size and the file's real IHDR dimensions disagree.
// Adding a size here without adding it to the manifest produces a PNG nothing references;
// adding one to the manifest without adding it here fails that gate on a missing file.
for (const size of [192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, render(size));
  console.log(`icon-${size}.png written`);
}
