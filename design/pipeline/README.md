# Campus pipeline (`design/pipeline`)

Bakes a campus into the tiled model the dashboard streams. Plan Part B §B1/§B3.

```
pip install -r design/pipeline/requirements.txt        # shapely, numpy (a venv is fine: design/.venv)
python3 -m design.pipeline fetch --pack content/hackillinois-2027    # Overpass, 4×4 sub-boxes, cached under design/osm/cache/
python3 -m design.pipeline build --pack content/hackillinois-2027    # → <pack>/campus/index.json + tiles/, and <pack>/campus.json (core, schema 1)
python3 -m design.pipeline check --ci --pack content/hackillinois-2027   # offline: schema, tile sha256, monument ids, index hash
python3 -m design.pipeline check --pack content/hackillinois-2027        # + rebuild from the cache and compare hashes
python3 -m design.pipeline stats --pack content/hackillinois-2027
```

`design/build-campus.py` is a shim that maps the old flags (`--check`, `--fetch`, `--core-only`) onto these commands.

## Modules

| module | job |
|---|---|
| `config.py` | frame (origin, bbox, coreBbox, detailBbox, metersPerUnit, vscale) from `event.json`; massing, road, facade and material tables |
| `fetch.py` | Overpass per sub-box with retry/backoff, cache + `design/osm/manifest.json` (url, query hash, sha256, fetchedAt) |
| `geom.py` | local frame, simplify, winding, ring assembly for multipolygon relations, tile clipping (runs + Sutherland–Hodgman) |
| `footprints.py` | `building=*` ways and relations (holes kept), `building:part` attached to its footprint, stadium rings, IoU dedupe, neighbour AO |
| `heights.py` | fusion: `height` tag → lidar → `building:levels` → type default; records `hsrc` and `lv` |
| `lidar.py` | consumes `design/osm/lidar/{grid.json,dsm.npy,dtm.npy}` when present (see below) |
| `roofs.py` | roof code `r` (tag → lidar ratio → type rules) and ridge line `rr` from the minimum-area rectangle |
| `facade.py` | material `m` and colour `c` (tag → era/height → type table) |
| `detail.py` | roads, lawns (lawn/field/wood/farm), generated elm rows + scatter, lamps, water, rail, parking, fountains |
| `monuments.py` | resolves pack monuments to footprints (largest footprint per name; `at` proximity; `synth`), `height` overrides, crown recipes |
| `bake.py` | assembles the model, tiles it (500 m), writes content-addressed tile files, the index and the legacy core bake |
| `schema.py` | offline validation used by `check --ci` (mirrored by `scripts/checkCampus.ts` in Zod) |

## Schema 2

`index.json`: `meta {schema:2, pack, origin, metersPerUnit, vscale, tileUnits, bbox, coreBbox, coreOnly, sources[], heights{tag,levels,default,lidar}, counts, hash, builtAt}`, `monuments[]` (with `crown` when a recipe exists in `design/hand/crowns/<id>.json` or `monuments.json`), `tiles[{x,z,bbox,maxH,counts,bytes,sha256,file,core}]`.

`tiles/<x>_<z>.<sha8>.json`: `buildings[{id,n,t,h,hsrc,lv,r,rr?,m,c?,ao,par,p,holes?,parts?,ps?}]`, `roads`, `lawns`, `trees[[x,z,s]]`, `lamps`, `fountains`, `water`, `rail`, `parking`. Buildings are assigned by centroid and never clipped; everything else is clipped to the tile box. Coordinates are world units (10 m), `+x` east, `+z` south, origin at the pack's `campus.origin`. The whole UIUC frame is 5 × 5 km, within the ±6.5 km the presence protocol's 0.2 m `i16` rows can carry.

Determinism: inputs sorted by OSM id, floats rounded to 2 dp, tile files content-addressed, `meta.hash` = sha256 over the tile hashes, the monuments and the frame. Two builds from the same cache produce the same hash (`check` proves it).

## Lidar (optional, manual)

The production height path samples the public USGS QL1 lidar (`IL_8County_PlusChampaign_B3_QL1_2019`, public domain). It is a 1–2 GB download and is never run in CI. Recipe:

1. Download the LAZ tiles intersecting `campus.bbox` from `https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/IL_8County_PlusChampaign_B3_2019/` into `design/osm/lidar/laz/`.
2. `pip install "laspy[lazrs]"` and rasterise at 1 m in the pack's world frame:
   first-return maximum → `dsm.npy`, class-2 minimum → `dtm.npy`, plus `grid.json` `{"x0","z0","res","w","h"}` (world-unit origin of cell (0,0), cell size in metres, dimensions).
3. Rebuild. `heights.lidar` in `index.meta` turns `true`, `hsrc:"lidar"` appears, and `ps` (P95/P50 roof ratio) feeds the roof classifier.
4. Record-then-freeze: on the first lidar run note Altgeld tower (expect 40 ± 4 m), Foellinger, Memorial Stadium and State Farm Center, review against `design/refs/`, then pin them as assertions in `tests/` before pinning the pack hash in CI.

Without the raster the pipeline reports `heights.lidar: false` and uses tag → levels → default. The 2026-09-06 UIUC bake is in that state: 292 tagged heights, 773 from levels, 8,136 defaults, plus hand heights for Altgeld, Foellinger and State Farm Center in `monuments.json`.


## The props pass

The pack already bakes the big shapes, namely buildings, roads, lawns, trees, lamps, water,
rail, parking, fountains and monuments. Rendered together those give a campus that reads as
buildings sitting on grass, because everything a person would actually stand next to is
missing. This file exists to fetch the human-scale clutter that makes the ground plane look
inhabited: seating and bins, cycle racks and shelters, the transit furniture along kerbs, the
fences and hedges that cut lawns into real quads, the row plantings, the picnic and play and
pitch surfaces, the artwork and memorials that anchor a plaza, and the tall thin man-made
verticals such as flagpoles and masts that give the skyline something other than roofs.

Each category earns its bytes differently. Benches, bins, drinking fountains, post boxes,
telephones and barbecues are single nodes and cost almost nothing per feature, yet they are
what the eye reads as "a place people use", so they are the cheapest realism in the whole
bake. Bus stops, platforms, crossings and traffic signals are likewise nodes and place the
props that make a road look like a street rather than a grey ribbon. Steps are pulled as ways
because a stair only means anything as a run with a direction, not as a dot. Fences, walls
and hedges are ways for the same reason and are the single highest-value class here: they
supply the edges that stop lawns bleeding into one another. Bollards and gates are the node
half of the same barrier family and mark thresholds. Tree rows are ways so a line of planting
can be instanced along its geometry instead of guessed. Picnic tables, playgrounds, pitches
and pools are the ground-cover detail that fills the leftover green, and pitches carry their
sport tag, which "out geom" returns for free alongside the geometry and lets the baker pick a
court colour and line pattern rather than painting every pitch the same green.

The deliberate choice throughout is per-feature node, way or nwr rather than a blanket nwr on
every tag. The rejected alternative was one convenient "nwr[amenity]"-style sweep over the
whole box: across roughly 25 km2 that pulls relation members and interior building parts for
tags where only the point or only the outline is ever drawn, and the response inflates by
roughly an order of magnitude for detail that never reaches a vertex. So nwr appears only
where a feature is genuinely mapped both ways in the wild, which is bicycle parking, shelters
and public transport platforms; everything else is pinned to the one geometry type that the
renderer can consume.

The template itself carries only per-block one-liners. `fetch.py` hashes the substituted query
text into `design/osm/manifest.json` and refetches any sub-box whose hash has moved, so a
reworded comment in a `.tpl` is sixteen fresh POSTs against a public, rate-limited endpoint.
The reasoning belongs here, where editing it is free.

Two rules keep the pass honest, and `npm run campus:check` asserts both. Every selector in
`props.overpass.tpl` must have a consumer in `props.py`, and every kind `props.py` can emit
must have a mesh in `public/gl/props.js`. Either half breaking is silent otherwise: a tag with
no consumer is downloaded and discarded, and a kind with no mesh is a prop the client answers
with `null` and simply never draws.
