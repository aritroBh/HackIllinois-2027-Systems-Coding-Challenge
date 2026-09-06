# Forking this for your own hackathon

Nothing in `src/` names a building, a faction or an event. The campus, the landmarks, the
loot table, the palette and the fonts all live in a **content pack** under `content/`, and
the server reads the pack rather than a literal. Forking is therefore mostly writing your
own pack and baking your own campus. This page is the order to do it in.

`content/hackillinois-2027/` is the real HackIllinois pack, and
`content/example-campus/` is a two-venue minimum that CI boots. Copy the second, read the
first when you want to see what a finished one looks like.

## 1. Run the demo before you change anything

Node 20 or newer, then:

```sh
npm install
npm run demo          # http://localhost:3000/dashboard/
```

`npm run demo` starts an in-memory single-node Mongo replica set, seeds it, serves the
dashboard against that same database, and signs the browser in as the highest-ranked
seeded account. No `.env`, no Docker, no secrets. Everything you do next is a change from
a working baseline, which makes a broken step obvious.

If you plan to touch the 3D pipeline, get Python working too:

```sh
pip install -r design/pipeline/requirements.txt
python3 -m design.pipeline check --ci --pack content/hackillinois-2027
```

## 2. Copy the example pack

```sh
cp -r content/example-campus content/my-event
```

Then edit `content/my-event/event.json`: the `id`, the event name and dates, the timezone,
`hqVenue`, and the `campus` block. `campus.origin` is the `[lat, lng]` that becomes world
`(0, 0)`; `campus.bbox` is `[south, west, north, east]` and is the geofence for everything,
including presence, so draw it around the whole area people will walk. Leave
`metersPerUnit` at `10` unless you are also retuning the renderer.

Point the server at it and validate:

```sh
CONTENT_PACK=my-event npm run content:validate
CONTENT_PACK=my-event npm run demo
```

`content:validate` with no argument checks every directory under `content/`, so your pack
and the two shipped ones are all held to the same contract. Read
[CONTENT-PACKS.md](CONTENT-PACKS.md) for the file-by-file meaning of every field and the
list of cross-references the boot rejects.

A bad pack does not start the server. That is deliberate: a typo in a venue key is a
geofence anchored to the wrong building, and the class of bug is worth a loud failure at
boot instead of a quiet one at 3 a.m.

## 3. Bake your campus

The pipeline turns OpenStreetMap into the tiled model the dashboard streams. It reads the
bounding box from your `event.json`, so there are no query files to edit.

```sh
python3 -m design.pipeline fetch --pack content/my-event   # Overpass, 4x4 sub-boxes, cached
python3 -m design.pipeline build --pack content/my-event   # -> campus/index.json + tiles/
python3 -m design.pipeline check --ci --pack content/my-event
```

The fetch is polite and slow and is cached under `design/osm/`, which is gitignored. The
build is deterministic: two builds from the same cache produce the same hash, which is what
`check` proves. Commit `content/my-event/campus/` and `campus.json`.

Heights come from OSM tags, then storey counts, then a type default. Lidar is optional,
manual, and worth it only if your landmarks look wrong; `design/pipeline/README.md` has
the recipe. A 5 x 5 km frame is the tested size and fits the presence protocol's
coordinate range.

The baked model is a derivative database of OpenStreetMap under the ODbL. Keep the
`© OpenStreetMap contributors` credit visible wherever you show the map, and add your own
sources to `NOTICE`.

## 4. Set the secrets production refuses to boot without

Outside production the server invents ephemeral secrets per boot so a fresh clone runs with
zero setup. In production it refuses to start instead. Five refusals, all in
`src/config/env.ts`:

| Variable | Why the process stops |
|---|---|
| `MONGODB_URI` | there is no fallback in production; in-memory Mongo would lose every roster, karma total and ticket on restart |
| `QR_HMAC_SECRET` | the committed default mints forgeable attendance tokens |
| `SESSION_SECRET` | the committed default mints forgeable session cookies |
| `ORGANIZER_SECRET` | it is the bootstrap credential for printing badge claim codes |
| `AUTH_MODE` | must be `required`, or every mutating route is open to anyone on the venue Wi-Fi |

Generate each with `openssl rand -hex 32`. [DEPLOYMENT.md](DEPLOYMENT.md) is the rest of
the production checklist, including the proxy and TLS settings the session cookie assumes.

## 5. Choose an identity adapter

Three ship, and all three end in the same HttpOnly cookie:

* **Badge claim codes** are always on and need no configuration. Print a CSV before the
  event and put the code in the badge QR. This is the fallback that works when your SSO
  does not.
* **Email magic links** turn on when `SMTP_URL` is set.
* **Adonix**, the HackIllinois SSO, turns on with `ADONIX_ENABLED=true`. If you are not
  HackIllinois this one is not for you.

[IDENTITY.md](IDENTITY.md) has the trust boundaries, the claim-code CSV command and the
account model. Read the Adonix section before writing an adapter of your own: the rule that
only the SSO *subject* identifies an account, and that an unknown subject creates a hacker
account whatever role the upstream claims, is the part that stops a spoofed login from
taking over a staff account.

## 6. What you will have to write yourself

The pack is data, but somebody has to author it.

**The gazetteer.** `venues.json` is every place a shift can be at, with coordinates and the
`hints` that let free-text venue names resolve. Nothing else in the pack is valid until
these keys exist.

**Landmarks.** `monuments.json` is the list of buildings that become territory gyms. Each
one needs an OSM `name` to match or a verified centroid. Expect to iterate: the build
prints what each monument resolved to and how big it is, and a wrong match is visible in
the model immediately.

**The game layer.** Factions, seed territories, beacons and the loot table are yours to
balance. The example pack has the minimum that validates, not a good game.

**Art.** `memorabilia.json` carries 16 x 16 pixel grids and a palette per sticker. The
fonts named in `branding.fonts` must be families already served from `public/fonts/`,
because the page is under a `script-src 'self'` and `style-src 'self'` policy with no
external origins at all. Adding a font means adding the woff2 file, a `@font-face` rule and
its licence to `public/fonts/LICENSES.md`. `theme.js` maps five palette keys
(`orange`, `blue`, `patina`, `harvest`, `prairie`) onto CSS custom properties at runtime;
anything else in `palette` is carried but not applied.

**Your own SSO, if you have one.** Adapters live beside the others in
`src/services/auth.service.ts` and are small. Copy the Adonix one and keep its trust
boundary.

**Event-specific rules.** Anything that is behaviour rather than data belongs in a plugin
rather than a fork of the services. See [PLUGINS.md](PLUGINS.md).

**Attribution.** Add your map, image and font sources to `NOTICE`. If you redistribute the
baked model you are redistributing an ODbL database.

## 7. Before the doors open

Run the full check (`scripts/verify.sh`), boot once against real Mongo with
`AUTH_MODE=required`, print the claim-code CSV, and walk the venue with a phone to confirm
the geofence radii are generous enough for indoor GPS. Then read the last section of
[DEPLOYMENT.md](DEPLOYMENT.md), which is what to watch while the event is running.
