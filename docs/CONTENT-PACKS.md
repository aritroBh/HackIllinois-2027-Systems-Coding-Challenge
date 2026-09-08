# Content packs

A pack is a directory of JSON files describing one event on one campus. The server reads
`${CONTENT_DIR}/${CONTENT_PACK}` once at import, validates it, and exports a typed `pack`
object, and `src/` hardcodes no building, faction or colour. That is now enforced rather than
asserted: `npm run pack:check` loads the active pack, takes every string that is that event's
content, and fails if any of it appears in `src/`.

Three exceptions used to be listed here and a fork met all three — the venue gazetteer in
`src/common/utils/geo.ts` that check-in geofencing read instead of the pack, `src/seed/seedData.ts`
seeding gyms and beacons from inline lists, and `src/services/hackstop.service.ts` rolling spins
against a literal drop table. All three are closed. `geo.ts` derives from `pack.venues`, the seed
reads `pack.territories` and `pack.beacons`, and `src/economy/lootTable.ts` builds the drop table
from `pack.loot`. What remains is enumerated with a reason each in
`scripts/pack-driven-baseline.json`, and the gate refuses anything new.

`CONTENT_DIR` defaults to `<repo>/content` and `CONTENT_PACK` to `hackillinois-2027`.

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
renders them into the DOM. `quests.json`, `booths.json`, `raids.json` and
`challenges.json` are optional as well and have their own sections below.
`campus.json` and `campus/` are built by the pipeline, not written by hand.

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
* `geofenceMeters` is the campus-wide capture radius (default `75`), and it **is** enforced:
  check-in and gym capture both measure against it, and the dashboard prints the same number,
  so the figure on the screen is the distance the server applies. A venue's own `radiusMeters`
  overrides it for that venue; gyms use the campus value, because a gym document stores
  coordinates and no venue key.

  It was declared and not enforced for a long time, with `checkin.service.ts` and
  `gym.service.ts` each carrying a hard-coded `75` while the dashboard read the pack — so
  setting it to anything else changed the number on the screen and not the distance enforced,
  which is worse than being ignored.

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

`gauntlet` is one flag and it defaults to **false**:

```json
"gauntlet": { "requiredForCapture": true }
```

Turn it on and control points alone stop being enough to take a *rival* gym: the last hit
floors that gym at 1 CP instead of flipping it, and the flip needs a challenge win spent
through `POST /api/v1/pokeshift/gauntlets/:attemptId/spend`, which needs a session. Reinforcing an ally, taking neutral
ground and every earlier strike are unchanged. Off by default because a pack that ships no
`challenges.json` would otherwise have every rival gym permanently uncapturable, and because
a fork pulling this in keeps the behaviour it already had until it opts in;
`GauntletService.requiredForCapture()` additionally refuses to honour a `true` when the pack
ships no challenges, so that combination plays as before rather than locking the board.
`content/hackillinois-2027` sets it to true and `content/example-campus` omits the block.

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
`radiusMeters` widens or narrows the geofence for one building, and it is read: check-in
resolves a shift's location to a venue key and measures against that venue's radius. Precedence
is venue, then `event.campus.geofenceMeters`, then 75 — specific beats general. Set it for the
arena you hold the opening ceremony in and leave the rest alone.

**What the client is handed.** `GET /api/v1/content` returns each venue with `radiusMeters`
exactly as you authored it — present on an override, absent otherwise — plus a resolved
`geofenceMeters` carrying the number that actually applies. The dashboard reads the resolved one
and does no arithmetic, so the precedence above is written down in exactly one place
(`geofenceMetersFor`) rather than reimplemented in the browser. If you are writing a client of
your own, read `geofenceMeters` for the same reason.

That is not a hypothetical worry: the dashboard gated its Spin buttons on a hard-coded `75` while
already holding `campus.geofenceMeters` for a label, so a pack widening to 120 m disabled a button
the server would have accepted, and narrowing to 50 m enabled one it would refuse.

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

**This file seeds the gyms.** `src/seed/seedData.ts` reads `pack.territories` and takes each
gym's coordinates from `pack.venues[venue]`, so editing this file is the whole job — there is no
second half. It did have one: the seed used to build the gyms from an inline `TERRITORIES` array
against a hard-coded gazetteer, and the shipped pack and the seed agreed only because both were
written by hand and kept in step, so a fork that edited this file got a validated pack and the
HackIllinois gyms anyway.

## beacons.json

`{ "beacons": [ … ] }`, the HackStops people spin. `id` is `SCREAMING_SNAKE_CASE` and must be
unique across the file, `venue` must exist, and `radiusMeters` overrides the radius for this
beacon alone — falling back to the venue's, then the campus default. The seed writes the
resolved number onto the HackStop document as `geofenceRadiusMeters`, which is what
`hackstop.service.ts` checks on every spin. `seedData.ts` creates one HackStop per entry here,
at the venue's coordinates.

Note the consequence of the radius being *seeded* rather than read live: changing it in the pack
takes effect on the next seed, not on the next spin.

## loot.json

The spin table. `karmaMin` and `karmaMax` are checked for `karmaMin <= karmaMax`, and `items`
must hold at least one `{type, weight}`.

**This is the table the server rolls against.** `src/economy/lootTable.ts` builds it from
`pack.loot` at boot and `HackStopService.spinBeacon` calls into it, so the weights here decide
the odds and `karmaMin`/`karmaMax` decide the payout band. Weights are **relative** — they are
normalised against their own total, so they need not add to 100 and any set of positive numbers
is a valid table.

An item `type` the power-up catalogue does not price **refuses the boot**, naming the unknown
type and listing the known ones. It used to be shape-checked only, which made a misspelt item a
clean boot and a crash inside one unlucky player's spin.

The pack chooses the odds; `POWER_UP_CATALOG` in `src/models/powerup.model.ts` chooses what each
item is called and what it pays. That split is deliberate: a pack is public, served to every
browser under `/dashboard/content`, and `karmaBonus` is money.

This file used to be read by nobody while the service rolled against a literal array holding the
same five items at the same five weights — the two agreed by coincidence, so the gap was
invisible until a fork changed one.

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

A quest naming a domain event the server does not have **is** a pack error: `npm run
content:validate` refuses it and lists the known event names. The same check covers a raid's
`joinEvents`.

That sentence used to say the opposite — that it was not a pack error, and that `npm run
events:check` reported it. `events:check` inspects the SSE bridge between the server and the
browser; it never opens `quests.json`, and its name pattern cannot match a dotted event like
`registration.created`. So nothing reported it, and a typo produced a green boot and a quest that
sat at zero for the weekend.

One case the pack check cannot catch, because the name is real: a raid may join on an event that
carries no account to enrol on — `sos.resolved` is the only one today. `RaidService` warns about
that at boot, naming the raid.

## challenges.json

Optional, and the file the gauntlet is authored in: the coding challenge a player has to win,
standing inside a rival gym's geofence, before they can take that gym. A pack without this
file has no gauntlet at all — `content/example-campus` ships none — and
`event.gauntlet.requiredForCapture` above is what turns the requirement on.

**Two files, and only one of them is the pack.** Answers live in the clear in
`design/challenges/<pack>.json`, which is not served and is not copied into the Docker image
(the `COPY` lines take `content/` and `public/`, not `design/`).
`npm run gauntlet:hashes -- <pack>` reads that file and writes
`content/<pack>/challenges.json`, which carries the same challenges with every answer replaced
by a digest:

```sh
$EDITOR design/challenges/hackillinois-2027.json
npm run gauntlet:hashes -- hackillinois-2027
npm run content:validate -- content/hackillinois-2027
```

Never hand-edit the generated file. Each `hash` is an HMAC over the challenge id, the case
index and the normalised answer, keyed on the file's `answerSalt` — so changing the salt, a
challenge id, the order of the cases or a `normalise` rule invalidates every digest in the
file, and regenerating is the only way back. `scripts/gauntletHashes.ts` validates what it is
about to write with the same schema the server loads it through, so a broken pack is refused
at authoring time rather than at somebody else's boot.

**Why an answer can never be plaintext here.** The whole pack directory is served to browsers
under `/dashboard/content/`, so an answer written into `content/` is a download — the answer
key, one guessed filename away. `challengeCaseSchema` is therefore `.strict()`: a case that
still carries `answer` fails validation instead of being quietly dropped, because a field that
is silently ignored is a field somebody will believe was honoured. `gauntlet:hashes` checks the
same thing from the other side before it writes. For `PREDICT_OUTPUT` it refuses if the answer
text appears anywhere a player can read — title, prompt, choices or case inputs. For
`MULTIPLE_CHOICE` it cannot: the options have to be rendered, so the answer text is public by
construction and the secret is *which* option is right. That kind gets the check it can pass
instead — the answer must be one of the choices, or the question is unanswerable and would
only be discovered by a player standing at the gym.

**What `answerSalt` buys, exactly.** It is a per-pack string of 16 to 200 characters (`openssl
rand -hex 16` is a fine source) and it is not a secret in the sense of being unguessable. It
stops one pack's digests being reusable against another, and it stops an answer being read
straight off the file. **It does not stop an answer being guessed.** The answer space for
"what does this print" is small, and anyone who downloads the pack can hash candidates against
the salt offline until one matches. Every player of a given challenge also sees the same
input, so a correct answer is a constant and can be shared. What actually bounds cheating is
physical and temporal, not cryptographic: the geofence is checked when the attempt starts
**and** again when it is submitted, the attempt carries a server-side deadline, one submission
ends it, and a partial unique index allows one open attempt per account at a time. Author on
that basis — assume the answers will circulate, and let the walk be the cost.

The digests are keyed on this salt rather than on `QR_HMAC_SECRET` deliberately. Keying on the
server secret would be stronger and would also mean that rotating it silently invalidated every
answer in every pack; outside production that secret is replaced with an ephemeral per-boot
value whenever it is left at the committed default, so a pack keyed on it would stop judging
after a restart.

**Nothing is executed.** The judge is normalise, HMAC, `timingSafeEqual`, and that is the whole
of it: no `vm`, no worker, no container, no sandbox, no new dependency. It verifies answers,
not programs. Write challenges that can be answered by reading, and do not describe the
mechanic to players as a code runner.

The file:

| Field | Meaning |
|---|---|
| `_about` | optional note; `gauntlet:hashes` writes one if the source has none |
| `answerSalt` | 16–200 characters, copied through from the source file |
| `challenges` | 1 to 200 challenges |

Each challenge:

| Field | Meaning |
|---|---|
| `id` | lowercase, digits and dashes; unique within the file |
| `title` | 1–80 characters |
| `prompt` | 1–4000 characters, plain text — the client renders it in a `<pre>`, not as HTML |
| `kind` | `PREDICT_OUTPUT` or `MULTIPLE_CHOICE` |
| `difficulty` | `EASY`, `MEDIUM` or `HARD`; display only, shown in the challenge header |
| `choices` | 2 to 6 strings of 1–120 characters, `MULTIPLE_CHOICE` only |
| `cases` | 1 to 8 of `{input, hash}`; `input` is 1–400 characters and is the label the player answers against, `hash` is 64 hex characters |
| `normalise` | what counts as the same answer: `trim` (default true), `collapseWhitespace` (true), `caseInsensitive` (false) |
| `timeLimitSeconds` | 30 to 1800, default 300; the server's deadline, and what the client counts down from |
| `rewardKarma` | 0 to 500, default 0 |
| `capturePower` | 10 to 500, default 250 |

In the source file under `design/challenges/` you write the same fields, except that each case
carries `answer` in plaintext where the generated file carries `hash`.

**The two kinds, and the rules that separate them.** A `MULTIPLE_CHOICE` challenge must list
its `choices` and must have exactly one case: the player picks an option and the option string
itself is what gets judged. A `PREDICT_OUTPUT` challenge must not carry `choices`, and may ask
up to eight cases, each with its own input and its own typed answer. Both are judged by the
same path — the difference is what the client renders and how many cases are meaningful. There
is no partial credit: every case must pass, because reporting "three of four" would invite a
player to brute-force the fourth one case at a time. Both mistakes — a `MULTIPLE_CHOICE` with
no options, a `PREDICT_OUTPUT` with them — are refused at load rather than at play, for the
same reason `quests.schema.ts` refuses a quest that cannot advance: they boot cleanly and fail
only when somebody walks to that gym.

**Which challenge a gym asks is not something you author.** `GauntletService` picks
deterministically from a sha256 over the gym id, modulo the list, so a gym always asks the same
question and a player cannot reroll by re-opening it until they get one they know. Nothing pins a challenge
to a particular gym and no cross-check ties the two, so a short list spread over more gyms will
repeat, and nothing guarantees every challenge you write is ever used. Write a set that is fair
at any gym.

**Karma and control points.** `capturePower` is the CP a spent win hits with, bounded to the
same 10–500 the ordinary battle route accepts for `power`, so a won gauntlet cannot express a
battle that route would refuse. `rewardKarma` is validated and returned to the client in the
submit response, and nothing mints it: the karma a capture pays is the gym-capture award
`GymService` already made, under the existing `GYM` source. Raising it does not change what a
player earns today. The gauntlet adds no karma source of its own on purpose — a new key in
`KARMA_SOURCES` has to be priced by every pack (see the `karmaCaps` bullet below), so adding
one would break the boot of every fork that had not come back to add a cap for it.

**What is checked, and what is not.** Zod validates this file at boot and under
`npm run content:validate`, the same as every other file: an unknown `kind`, a
`MULTIPLE_CHOICE` with no choices or with more than one case, a `PREDICT_OUTPUT` that carries
choices, a `hash` that is not 64 hex characters, a duplicate challenge id, a salt shorter than
16 characters. The
cross-validation below adds nothing for this file, because nothing in it names a venue, a
monument or a faction. Nothing checks that a digest is the hash of the answer you meant — that
is what regenerating from `design/challenges/<pack>.json` is for.

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
