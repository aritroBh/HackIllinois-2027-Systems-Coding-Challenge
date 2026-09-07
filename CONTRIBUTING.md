# Contributing

Thanks for looking. This is a working event system rather than a demo, so the bar is
"would you run this during the night shift", not "does it compile".

## Getting set up

```sh
npm install
npm run demo          # in-memory Mongo, seeded, http://localhost:3000/dashboard/
```

Node 20 or newer. Nothing else is required for backend or frontend work. The 3D pipeline
additionally needs Python 3.10+ and `pip install -r design/pipeline/requirements.txt`.

## Before you open a pull request

```sh
npm run lint              # tsc --noEmit
npm test
npm run content:validate  # every pack under content/
scripts/verify.sh         # typecheck, frontend syntax, tests, model checks
npm run csp:audit
```

Add or update tests for the behaviour you touched. A change to a concurrency path without a
test that races it is not finished.

## House style

Read the neighbouring file first. The conventions are consistent and the code is written to
be read.

* **Comments explain why, never what.** A comment that restates the line below it will be
  removed. Module headers say what the file is for and which decision it encodes. Prose in
  comments and documentation is plain and short.
* Validation is Zod, in `src/schemas/`. Routers are `src/routes/v1/*.routes.ts`.
  Controllers are static classes returning `{ success: true, data }`. Services own the
  logic, throw `ApiError`, and broadcast through `eventHub` **after** the database write.
* Configuration is read through `src/config/env.ts` and nowhere else. Reading
  `process.env` directly bypasses both the schema and the production boot guards.
* Colours, labels, venues and landmarks belong in a content pack rather than in `src/`. See
  [docs/CONTENT-PACKS.md](docs/CONTENT-PACKS.md). This is checked, not just asked for:
  `npm run pack:check` reads the active pack and fails if any of that event's content strings
  appear in `src/`. What is still there is enumerated with a reason each in
  `scripts/pack-driven-baseline.json`, and the gate refuses anything new.

  Two exceptions used to be named here — a closed faction enum, and a second copy of the venue
  gazetteer that the check-in geofence and SOS dispatch measured from while the client read the
  pack's. Both are closed: the schema validator reads `pack.factions`, and `geo.ts` derives from
  `pack.venues`.
* Frontend files under `public/` are plain browser scripts served under
  `script-src 'self'`. No build step, no inline handlers, no external origins. Register
  actions with `Nexus.registerAction` and tabs with `Nexus.registerTab`, and escape
  everything you inject into HTML.
* Generated files are committed and checked: `public/tokens.css` comes from
  `design/tokens.mjs`, and the campus bake comes from `design/pipeline`. Regenerate them
  rather than hand-editing, or the drift check fails.

## Pull requests

One change per pull request, with a description that says what failure it prevents. If it
changes a security boundary, an invariant or the identity model, say so in the description
and update the doc in `docs/` that covers it in the same change.

If you are adding behaviour specific to one event, it probably belongs in a plugin or a
content pack rather than in a service. [docs/EXTENDING.md](docs/EXTENDING.md) lists the six
seams in order of blast radius; work down it and stop at the first that fits.

## Reporting a vulnerability

Do not open an issue. See [SECURITY.md](SECURITY.md).
