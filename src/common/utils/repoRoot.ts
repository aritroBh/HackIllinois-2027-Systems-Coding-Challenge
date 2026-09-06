/**
 * Where the repository root is, found rather than assumed.
 *
 * This file exists because three separate modules each counted `..` segments from their own
 * location, and all three counted for the `tsx` layout only. In the compiled build every file
 * sits one level deeper — `src/app.ts` becomes `dist/src/app.js` — so every one of those
 * paths pointed at a directory that does not exist. The symptoms were not obviously related
 * to each other: the content loader reported seven missing pack files that were sitting in
 * `/app/content`, and the dashboard returned a plain 404 for the entire product.
 *
 * Walking up to the nearest `package.json` gets it right in both layouts. The compiled tree
 * has no `package.json` of its own, so the walk passes straight through `dist/` and lands on
 * the real root.
 *
 * The depth bound is a guard against a symlink loop, not a real limit; eight levels is far
 * more than either layout needs. If the walk somehow finds nothing, the caller gets the
 * two-levels-up answer that was the old behaviour, which is wrong in the same way it always
 * was rather than wrong in a new way.
 */
import fs from 'fs';
import path from 'path';

export function findRepoRoot(from: string): string {
  let dir = from;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(from, '../..');
}

/** The root, resolved once from this file's own location. */
export const REPO_ROOT = findRepoRoot(__dirname);
