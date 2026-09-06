/**
 * `npm run content:validate [-- <packDir>]` — validate a content pack without booting.
 *
 * Exit 0 when the pack loads and every cross-reference resolves; exit 1 with the issue
 * list otherwise. CI runs it for the active pack and for every directory under content/.
 */
import path from 'path';
import fs from 'fs';
import { loadPack, ContentPackError } from './loader';

const target = process.argv[2];
const dirs = target
  ? [path.resolve(target)]
  : fs
      .readdirSync(path.resolve(__dirname, '../../content'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.resolve(__dirname, '../../content', d.name));

let failed = false;
for (const dir of dirs) {
  try {
    const pack = loadPack(dir);
    console.log(`✓ ${path.basename(dir)}: ${Object.keys(pack.venues).length} venues, ${pack.monuments.length} monuments, ${pack.territories.length} territories, ${pack.beacons.length} beacons${pack.campusMonumentIds ? `, campus.json with ${pack.campusMonumentIds.length} baked monuments` : ' (no campus.json yet)'}`);
  } catch (err) {
    failed = true;
    console.error(`✗ ${path.basename(dir)}`);
    console.error(err instanceof ContentPackError ? err.message : err);
  }
}
process.exit(failed ? 1 : 0);
