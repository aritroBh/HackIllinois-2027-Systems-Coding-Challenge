# Campus model pipeline

`design/build-campus.py` bakes OpenStreetMap extracts into the compact model the
WebGL renderer (`public/gl/campus3d.js`) loads at runtime. Its inputs are a
**content pack** (`content/<event>/event.json` + `monuments.json`) and the
Overpass extracts cached under `design/osm/`; its output is
`content/<event>/campus.json`, which is committed and shipped.

## Commands

```sh
# Refresh the OSM cache (one Overpass request per design/osm/*.overpass), then build
python3 design/build-campus.py --pack content/hackillinois-2027 --fetch

# Build from the cache (the default --pack is content/hackillinois-2027, so `npm run campus` is the same)
python3 design/build-campus.py --pack content/hackillinois-2027

# CI / pre-commit: rebuild to a temp file and compare meta.hash with the committed campus.json.
# Exits 1 on drift, on a hand-edited file, or if any monument in monuments.json fails to resolve.
python3 design/build-campus.py --pack content/hackillinois-2027 --check

# Preview of the academic core only (campus.coreBbox) -> <pack>/campus.core.json; never overwrites the shipped model
python3 design/build-campus.py --pack content/hackillinois-2027 --core-only
```

The build is deterministic: Overpass elements are sorted by id before processing,
every coordinate is rounded to 0.01 units (10 cm), and `meta.hash` is the sha256
of the document with `meta.builtAt` and `meta.hash` removed. Building twice from
the same cache gives the same hash; `builtAt` is informational only.

Requirements: Python 3.10+ (standard library only) and `curl` for `--fetch`.

## What the queries pull

All three live in `design/osm/*.overpass` and use a bounding box a little larger
than the pack's `campus.bbox`, so buildings on the frame edge are not clipped.
Each is one POST to `https://overpass-api.de/api/interpreter` with
`[timeout:180]`; `--fetch` runs them sequentially and writes
`design/osm/manifest.json` (`{file, url, query, query_sha256, fetched_at, bytes,
sha256, elements}` per file). The cache and the manifest are gitignored
(`design/osm/*.json`); the newest `fetched_at` is copied into
`meta.sources[].fetchedAt` of the built model so provenance survives in git.

| Query | Pulls | Feeds |
| --- | --- | --- |
| `buildings.overpass` | `nwr["building"]` with `out geom` — every building **way** and every building **multipolygon relation**, the latter with member-way geometry inline | `buildings[]`, monument footprints |
| `extra.overpass` | `leisure` stadium/pitch/park/garden, `landuse` grass/recreation/forest, `highway` primary…path (inner box), artwork/historic nodes, libraries | `roads[]`, `lawns[]`, the stadium ring for monument matching, generated tree rows and lamps |
| `detail.overpass` | surveyed `natural=tree` nodes, street lamps, fountains, parking, pitches/tracks, waterways, `natural=water`, railways, plus building ways that carry roof/colour/material tags | `trees[]`, `lamps[]`, `fountains[]`, `water[]`, `rail[]`, `parking[]` |

Why `nwr` and not `way`: the large campus halls — Main Library (relation
1860882), ECEB (8840902), Holonyak MNTL (8840903) — are multipolygon relations
whose outer boundary is one or more *untagged* ways. A `way["building"]` query
never returns them, which is why the earlier model had to fake ECEB and the
Library from hand-measured boxes. The script now chains each relation's `outer`
members into closed rings (`assemble_rings`) and emits one footprint per ring
carrying the relation's tags, largest first so a name match lands on the main
mass. Inner rings (courtyards) are ignored for now; ways that are members of a
building relation are not emitted a second time as standalone buildings.

## Monuments

`monuments.json` lists the landmark buildings that become territory gyms. Each
entry resolves to a footprint one of three ways, in this order:

- `match` — the OSM `name` of a building way or relation (prefix match tolerated,
  so `"Altgeld Hall"` also claims `"Altgeld Hall Annex"` if nothing better exists).
- `at` — a verified `[lat, lng]`; the nearest unclaimed footprint over 400 m²
  within 55 m wins. Also the fallback when `match` finds nothing.
- `synth` — `[length, width, height]` in metres, massed from `at` and never
  matched against OSM. Only Alma Mater (a statue node) still uses this.

The printed table after a build shows `src: osm` or `src: synth` per monument
together with the footprint span in metres; anything unresolved aborts the build.
`src/content/schema.ts` cross-checks that the ids baked into `campus.json` equal
the ids in `monuments.json`, so a new gym needs both a `monuments.json` entry and
a rebuild.

## Pointing a fork at its own campus

1. Create `content/<your-event>/` with an `event.json` whose `campus` block
   carries `origin` (the `[lat, lng]` that becomes world `(0, 0)`), `bbox` and
   `coreBbox` (`[south, west, north, east]`) and `metersPerUnit` (keep `10`
   unless the renderer is retuned).
2. Write `monuments.json` with your landmarks (`match` the OSM name where it
   exists, otherwise `at` + `synth`).
3. Edit the bounding boxes in `design/osm/*.overpass` to cover your `bbox` with a
   small margin, then run `--fetch`. The script does not rewrite the queries
   from `event.json`, so this step is manual and visible in the diff.
4. `python3 design/build-campus.py --pack content/<your-event>` and commit the
   resulting `campus.json`. Wire `CONTENT_PACK` so the server serves that pack.

The module constants at the top of `build-campus.py` are only defaults for the
UIUC pack; a pack's `event.json` overrides them, so forks do not edit the script.

## Attribution

The model is derived from **OpenStreetMap** data, © OpenStreetMap contributors,
licensed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Any redistribution of `campus.json` (or anything derived from it) must keep that
credit and share the derived database under the same licence. The requirement is
recorded in `meta.source` and `meta.sources[]` of every built file; keep it
visible in the UI wherever the map is shown.


## Campus pipeline

The bake moved to the `design/pipeline` package (see `design/pipeline/README.md`): whole-campus Overpass fetch in sub-boxes, height/roof/facade classification, and a 500 m tiled output the renderer streams. `design/build-campus.py` remains as a flag-compatible shim.
