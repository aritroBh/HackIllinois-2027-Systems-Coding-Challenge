#!/usr/bin/env bash
#
# The plan's exit gates, checked one by one.
#
#   bash scripts/checkPlanGates.sh
#
# The plan in .claude/plans/ names an exit gate for every milestone, and those gates were
# checked by hand as each one landed. Checking them by hand is how a gate quietly stops being
# true: the milestone is finished, attention moves on, and six commits later a refactor removes
# the thing the gate was about with nothing to notice.
#
# This is deliberately shallow. It asserts that each gate's *mechanism* is present and, where
# cheap, that it runs — not that it is correct, which is what the test suite is for. A green
# run here means nothing that was built has been silently removed; it does not mean the system
# works, and it is not a substitute for `npm test` or `scripts/verify.sh`.
#
# Two of its own checks were wrong on the first run: one grep matched a CDN named in a licence
# file's refetch instructions, and one looked for the tile table under `meta` rather than at the
# top level. Both are recorded in the comments beside them, because a checklist that reports a
# failure the code does not have trains its reader to ignore it.
# Relative to this script, not to an absolute path baked in on one machine.
cd "$(dirname "$0")/.."
pass=0; fail=0
check() { # name, command
  if eval "$2" >/dev/null 2>&1; then printf '  ok    %s\n' "$1"; pass=$((pass+1));
  else printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); fi
}

echo "M0 — commit baseline, legal, prod boot guards, compose"
check "LICENSE present"                 "test -f LICENSE"
check "NOTICE present"                  "test -f NOTICE"
check "CONTRIBUTING / SECURITY / CoC"   "test -f CONTRIBUTING.md -a -f SECURITY.md -a -f CODE_OF_CONDUCT.md"
check ".nvmrc pins Node"                "test -f .nvmrc"
check "engines in package.json"         "node -e \"process.exit(require('./package.json').engines?.node?0:1)\""
check "compose runs a replica set"      "grep -q 'replSet' docker-compose.yml"
check "compose ships no default secret" "grep -q ':?set ' docker-compose.yml"
check "Dockerfile copies content/"      "grep -q 'COPY content/' Dockerfile"
check "prod refuses without MONGODB_URI" "grep -q 'MONGODB_URI is required in production' src/config/env.ts"
check "prod refuses AUTH_MODE != required" "grep -q 'AUTH_MODE' src/config/env.ts"
check "fresh clone can build"           "npm run build"

echo "M1 — identity, hub v2, limits, server.ts, CSP"
check "three auth adapters"             "test -f src/auth/adonix.ts && grep -q 'magic-link' src/routes/v1/auth.routes.ts && grep -q 'claim' src/routes/v1/auth.routes.ts"
check "cookie-only session"             "grep -q '__Host-nexus' src/common/utils/sessionToken.ts"
check "one CSRF mechanism"              "grep -q 'X-CSRF-Token' src/middleware/identity.ts && ! grep -rq 'X-Requested-With' src/"
check "hub has seven channels"          "grep -q \"'presence:exact'\" src/common/sse/eventHub.ts"
check "replay ring"                     "grep -q 'REPLAY_MAX_EVENTS' src/common/sse/eventHub.ts"
check "one stream-limit table"          "test -f src/common/streamLimits.ts && ! grep -q 'MAX_CLIENTS' src/common/sse/eventHub.ts"
check "trust proxy wired"               "grep -q \"trust proxy\" src/app.ts"
check "createServer factory"            "test -f src/server.ts"
check "CSP scriptSrc is self only"      "node scripts/cspAudit.mjs"
check "worker-src and manifest-src"     "grep -q workerSrc src/app.ts && grep -q manifestSrc src/app.ts"
# Only the files a browser actually loads. `public/fonts/LICENSES.md` names the CDN in its
# instructions for refetching the files, which is documentation rather than a runtime request.
check "fonts vendored, none external"   "test -d public/fonts && test \$(for e in html css js; do find public -name \"*.\$e\" -exec grep -hoE 'https?://[a-zA-Z0-9.-]+' {} \\; ; done 2>/dev/null | grep -vE 'localhost|127\\.0\\.0\\.1|example\\.com|w3\\.org|schema\\.org|creativecommons|opensource\\.org|openstreetmap|scripts\\.sil\\.org' | wc -l) -eq 0"

echo "M2 — content pack + config"
check "pack loads and validates"        "npm run content:validate"
check "second pack boots in CI"         "test -d content/example-campus"
check "geo/seed read the pack"          "grep -q 'content/loader' src/seed/seedData.ts || grep -q 'pack' src/seed/seedData.ts"

echo "M3 — whole-campus pipeline, tiles, worker, instancing, tiers"
# The tile table is `index.tiles`, not `index.meta.tiles`; `meta` carries `tileUnits`.
check "schema 2 with tiles"             "node -e \"const i=require('./content/hackillinois-2027/campus/index.json'); process.exit(i.meta.schema===2 && Array.isArray(i.tiles) && i.tiles.length>100 && i.meta.tileUnits?0:1)\""
check "campus check passes"             "npm run campus:check"
check "bake worker is worker-safe"      "node -e \"import('./public/gl/tile-bake.js').then(()=>0)\""
check "quality tiers exist"             "grep -q 'setQuality' public/gl/campus3d.js"

echo "M4/M4b — presence, avatars, scale"
check "ws + sse transports"             "test -f src/presence/wsTransport.ts -a -f src/presence/sseTransport.ts"
check "binary rows"                     "grep -q 'encodeRows' src/presence/protocol.ts"
check "presence audit model"            "test -f src/models/presenceAudit.model.ts"
check "mutes in a TTL collection"       "test -f src/models/presenceMute.model.ts"
check "soak harness"                    "test -f scripts/loadPresence.ts"
check "in-process tick benchmark"       "test -f scripts/benchmarks/presenceTick.ts"

echo "M5 — ops surfaces"
check "SOS five-state lifecycle"        "grep -q 'ON_SCENE' src/models/sosTicket.model.ts && grep -q 'ACKNOWLEDGED' src/models/sosTicket.model.ts"
check "transition table guards edges"   "grep -q 'canTransition' src/models/sosTicket.model.ts"
check "announcements with audience"     "test -f src/models/announcement.model.ts && grep -q 'audienceOf' src/common/sse/eventHub.ts"
check "me + lead + sos views"           "test -f public/views/me.js -a -f public/views/lead.js -a -f public/views/sos.js"
check "lite mode and a11y"              "test -f public/lite.js -a -f public/a11y.js"

echo "M6 — economy"
check "karma is the one writer"         "test -f src/services/karma.service.ts && test \$(grep -rc 'inc: { karmaPoints' src/services/ | grep -v ':0' | grep -v karma.service | wc -l) -eq 0"
check "domain bus has call sites"       "test \$(grep -rl 'domainEvents.emit' src/services/ | wc -l) -ge 4"
check "quests, stickers, raids, booths" "test -f src/services/quest.service.ts -a -f src/services/sticker.service.ts -a -f src/services/raid.service.ts -a -f src/services/booth.service.ts"
check "game router mounted"             "grep -q \"'/game'\" src/routes/v1/index.ts"
check "raid multiplier applied"         "grep -q 'RaidService.multiplierAt' src/services/karma.service.ts"
check "scheduler runs the tickers"      "test -f src/scheduler.ts"

echo "M7 — renderer fidelity"
check "crown recipes data-driven"       "test -d design/hand/crowns && test \$(ls design/hand/crowns/*.json | wc -l) -ge 14"
check "geometry winding audit clean"    "bash scripts/verify.sh quick"

echo "M8 — plugins, docs, CI"
check "plugin registry + guard"         "test -f src/plugins/registry.ts -a -f src/plugins/index.ts"
check "client plugin loader"            "test -f public/plugins.js"
check "example plugin"                  "test -d plugins/hello-nexus"
check "fork guide + pack docs"          "test -f docs/FORK_GUIDE.md -a -f docs/CONTENT-PACKS.md"
check "identity + presence + plugins docs" "test -f docs/IDENTITY.md -a -f docs/PRESENCE.md -a -f docs/PLUGINS.md"
check "deployment + drills + reviews"   "test -f docs/DEPLOYMENT.md -a -f docs/DRILLS.md -a -f docs/REVIEWS.md"
check "workflows guide"                 "test -f docs/WORKFLOWS.md"
check "CI runs the gates"               "grep -q 'campus:check' .github/workflows/ci.yml && grep -q 'csp:audit' .github/workflows/ci.yml"

echo
echo "  $pass passed, $fail failed"
exit $fail
