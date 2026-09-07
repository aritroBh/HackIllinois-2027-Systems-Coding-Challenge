# Content packs

A pack is a directory of JSON files describing one event on one campus. The server reads
`${CONTENT_DIR}/${CONTENT_PACK}` once at import, validates it, and exports a typed `pack`
object; most of `src/` hardcodes no building, faction or colour. There are three exceptions,
and a fork meets all three: the venue gazetteer in `src/common/utils/geo.ts`, which check-in
geofencing reads instead of the pack (see docs/FORK_GUIDE.md); `src/seed/seedData.ts`, which
seeds the territory gyms and the HackStop beacons from its own inline lists rather than from
`territories.json` and `beacons.json`; and `src/services/hackstop.service.ts`, which rolls
spins against a literal drop table rather than `loot.json`. Each is flagged again beside the
file it shadows. `CONTENT_DIR` defaults to `<repo>/content` and `CONTENT_PACK` to
`hackillinois-2027`.

The contract is `src/content/schema.ts`. This page explains it. Where the two disagree, the
schema is right.

## The rule that shapes everything else

**A pack that does not validate does not boot.** The loader collects every issue in every
file and prints them all, then exits. There is no partial load and no warning mode. The
reason is narrow and specific: a wrong venue key is a geofence anchored to the wrong
building, which looks like working software and behaves like broken software, at 3 a.m.,
during the event.

Validate without booting:

```sh
npm run content:validate                      # every directory under content/
npm run content:validate -- content/my-event  # one pack
```

## Which files are required

`event.json`, `venues.json`, `monuments.json`, `factions.json`, `territories.json`,
`beacons.json` and `loot.json` must all be present and valid. `memorabilia.json` and
`monuments-info.json` are optional but are validated when present, because the client
renders them into the DOM. `campus.json` and `campus/` are built by the pipeline, not
written by hand.

The whole pack directory is served to browsers under `/dashboard/content/` — `src/app.ts`
mounts `express.static(pack.dir)` over it, so a `.md` note or a spreadsheet is as public as
the JSON. Only the `.json` files are *announced*, in the descriptor the client boots from,
which is not the same as being private. Do not keep drafts, notes or anything unpublished in
there.

## event.json

The event itself, the world frame and the branding.

| Field | Meaning |
|---|---|
| `packVersion` | must be `1`; the format version, not your event's version |
| `minServerVersion` | the oldest server this pack expects |
| `id` | lowercase and hyphens, used in URLs and telemetry |
| `name`, `eventName`, `tagline` | shown in the shell |
| `timezone`, `startsAt`, `endsAt` | the event window |
| `hqVenue` | a key in `venues.json` |

`campus` is the world frame, and the renderer, the pipeline and the presence protocol all
work in it:

* `origin` is the `[lat, lng]` that becomes world `(0, 0)`.
* `bbox` is `[south, west, north, east]`. It is also the presence geofence: a GPS fix
  outside it is refused, so nobody appears from another city.
* `coreBbox` is the academic core, and `detailBbox` is where pedestrian-scale detail
  (footways, lamps) is baked. Both are optional; `detailBbox` defaults to `coreBbox`.
* `metersPerUnit` is the world scale. `10` is what the renderer is tuned for.
* `vscale` exaggerates height (default `2.6`).
* `geofenceMeters` is the default capture radius (default `75`). **Declared but not
  enforced:** the check-in geofence (`checkin.service.ts`) and gym capture (`gym.service.ts`)
  both use a hard-coded `75`. The one thing that does read it is the dashboard, which prints
  it as the campus geofence figure, so setting it to anything but `75` today changes the
  number on the screen and not the distance the server enforces — which is worse than being
  ignored.

`branding.palette` is a map of names to `#rrggbb`. Five keys reach the UI: `orange`,
`blue`, `patina`, `harvest` and `prairie`; `orangeDk` is derived from `orange` unless you
set it. `branding.fonts` names the `hud`, `numbers`, `headings` and `body` families, which
must already be served from `public/fonts/` because the page allows no external origins.

`presence` overrides the movement gates (`maxAccuracyMeters`, `maxSpeedMps`,
`fuzzGridMeters`, `interestRadiusMeters`, `cellMeters`, `maxDetail`); the defaults are the
ones [PRESENCE.md](PRESENCE.md) explains, and they are defaults because a different campus
has different indoor GPS. `karmaCaps`, `bountyCap` and `hackerBountyBudgetPerDay` bound the
economy. `plugins` lists the plugins this pack activates, by name; see
[PLUGINS.md](PLUGINS.md).

## venues.json

A flat map of venue key to venue. This is the gazetteer, and every other file refers to it.

```json
{
  "_about": "Notes live in underscore keys and are dropped after validation.",
  "MAIN_HALL": { "name": "Main Hall", "latitude": 51.5007, "longitude": -0.1246, "hints": ["MAIN HALL", "HALL"] }
}
```

Keys are `SCREAMING_SNAKE_CASE`. `hints` are the uppercase fragments that let a free-text
venue name resolve to this key, so put the abbreviations people actually type in there.
`radiusMeters` is declared for a large or awkward building, but **nothing reads it yet** —
see the note on `geofenceMeters` above.

Rejected: a key that is not `SCREAMING_SNAKE_CASE`, a venue entry that is a string rather
than an object, an underscore key whose value is not a string, a latitude or longitude out
of range.

## monuments.json

`{ "monuments": [ … ] }`. These are the landmark buildings that become territory gyms, and
the same list drives the 3D bake.

`id` is lowercase and hyphens and is the join key with `campus.json`, `territories.json`
and `monuments-info.json`. `short` and `name` are display text, `blurb` is a sentence.
`venue` and `venueKey` tie the monument to the gazetteer. `mat` and `kind` steer the
renderer.

A monument needs a way to find its footprint: `match` is an OSM building name (prefix
matches are tolerated), and `at` is a verified `[lat, lng]` used when the name finds
nothing. **One of the two is required.** `synth` is a hand-measured
`[length, width, height]` for something OSM has no footprint for, such as a statue.
`height` overrides the derived height in metres when OSM or lidar is wrong, which happens
for domes and towers. `crown` is the data-driven roof recipe.

## factions.json

`{ "factions": [ … ] }`, at least two, and **one of them must have the id `NEUTRAL`**.
Uncaptured territory belongs to it. Ids are `SCREAMING_SNAKE_CASE`, `color` is `#rrggbb`,
and `hqVenue` is optional but must exist when present.

## territories.json

`{ "territories": [ … ] }`, what the map is *meant* to start as. Each entry names a `venue`, a
`monument` and the `faction` that starts holding it, plus `cp` (current control points),
`max` and `level`. `cp` may not exceed `max`.

**Nothing seeds from this file.** `src/seed/seedData.ts` builds the gyms from an inline
`TERRITORIES` array against the hard-coded gazetteer in `src/common/utils/geo.ts`, and never
imports the pack. The shipped pack and the seed agree only because both were written by hand
and kept in step; a fork that edits this file gets a validated pack and the HackIllinois gyms.
Editing the seed is the second half of the job.

## beacons.json

`{ "beacons": [ … ] }`, the HackStops people spin. `id` is `SCREAMING_SNAKE_CASE` and must be
unique across the file, `venue` must exist, and `radiusMeters` is declared here too and is
**not read at all**; seeded HackStops carry a hard-coded 75 m radius on the document, which is
what `hackstop.service.ts` checks. The same caveat as `territories.json` applies to the list
itself: `seedData.ts` has its own `BEACONS` array, so this file is validated and then unused.

## loot.json

The spin table the server does not roll against. `karmaMin` and `karmaMax` are checked for
`karmaMin <= karmaMax`, `items` must hold at least one `{type, weight}`, and `type` is checked
for shape only — nothing compares it with the power-up enum, so a misspelt item is a clean
boot.

**Declared and read by nobody.** `HackStopService.spinBeacon` rolls against a literal weight
array in `src/services/hackstop.service.ts` and pays `25–49` karma plus the item's own bonus,
both written in code; `pack.loot` reaches only the `content:validate` summary line.
`src/models/powerup.model.ts` says the same thing beside the catalog it belongs to. The
shipped `loot.json` carries exactly the numbers the code uses, which is why the gap is
invisible until a fork changes one.

## memorabilia.json

The sticker book. Optional, but validated when present because it is drawn into the page.
Each item has an `id` (lowercase and hyphens), a `name`, a `kind`, a `rarity`
(`SCREAMING_SNAKE_CASE`), an optional `drop` and `flavour`, an optional `palette` of at
most 16 hex colours, and an optional `pixel`: exactly 16 rows of exactly 16 characters
drawn from `a`-`p` and `-`, where a letter indexes the palette and `-` is transparent.
Extra keys are allowed, so the UI can grow without a schema change.

## monuments-info.json

Optional dossiers keyed by monument id: `title`, `year`, `architect`, `style`, an
`approximate` flag and up to twelve `facts`. Underscore keys are documentation. **A key
that is not a declared monument id is an error**, because a dossier that never appears is a
typo, not a feature.

## campus.json and campus/

Built by `python3 -m design.pipeline build`, not written by hand. `campus/index.json` plus
`campus/tiles/<x>_<z>.<sha8>.json` are the tiled model the renderer streams;
`campus.json` is the older single-file core bake kept for the parts of the renderer that
have not migrated. Both are committed.

The loader reads the monument ids out of `campus.json` and requires them to **equal** the
ids in `monuments.json`, in both directions. Adding a gym means adding it to
`monuments.json` and rebuilding; the error tells you which.

## quests.json, booths.json and raids.json

All three are optional — a pack without them simply has no quests, no sponsor booths and no
raid windows — and all three are validated at boot when present. That paragraph used to say
they were reserved and ignored, which had not been true of booths and raids for two
milestones and was never true in the way it implied for quests: `quests.schema.ts` existed
and the loader did not call it, so a quest that could not advance booted cleanly and sat at
zero for the weekend.

What is checked, beyond each file's own shape:

* every `venue` in `booths.json` and `raids.json` is a key in `venues.json`;
* every `reward.sticker` in `booths.json` and `quests.json` is an item id in
  `memorabilia.json`, and every `reward.powerUp` is a type the power-up catalog defines;
* a `DISTINCT` quest names the field it collects, a `STREAK` quest has a window to be
  consecutive in, and no two quests share an id.

A quest naming a domain event the server does not emit is *not* a pack error — the pack is
not allowed to depend on the server's build — but `npm run events:check` reports it.

## What the boot-time cross-validation rejects

Zod checks each file on its own. `crossValidate()` then checks the references Zod cannot
see, and any one of these stops the boot:

* `event.hqVenue` is not a venue key.
* `event.karmaCaps` leaves any karma source unpriced. This is the one on the list a fork
  hits first, because `karmaCaps` defaults to `{}` and an absent cap means *uncapped*, not
  *unconfigured*: `KarmaService.capFor` returns null for a source it has no entry for and
  null mints without limit. The boot names every missing source, so the fix is mechanical.
* No faction has the id `NEUTRAL`.
* A faction's `hqVenue` is not a venue key.
* A monument's `venueKey` is not a venue key.
* A territory's `venue`, `monument` or `faction` does not exist, or its `cp` exceeds `max`.
* A beacon's `venue` does not exist, or two beacons share an id.
* `loot.karmaMin` exceeds `loot.karmaMax`.
* A monument in `monuments.json` is missing from the baked `campus.json`, or a baked
  monument is not declared. Rebuild with `npm run campus`.
* `monuments-info.json` has a dossier for a monument that does not exist.

Two more failures happen before any of that: a `CONTENT_PACK` that resolves outside
`CONTENT_DIR` is refused, because the pack directory is served statically, and a file that
is missing or is not JSON is reported as such rather than as a schema error.
