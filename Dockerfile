# Production image for Nexus Quest.
#
# Two stages: one that compiles TypeScript and one that runs the result with only the
# production dependencies installed. The build stage is discarded, so `tsx`, Jest and the
# type definitions never reach the deployed image.
#
# Three things this deliberately copies that an earlier version did not, each of which was a
# broken image rather than a missing nicety:
#
#   tsconfig.build.json — `npm run build` is `tsc -p tsconfig.build.json`. Copying only
#     tsconfig.json meant the build stage failed outright.
#   content/ — the server loads a content pack at boot and calls `process.exit(1)` when it
#     cannot find one, by design: a typo in a venue key should fail loudly at start rather
#     than quietly at three in the morning. Without the pack the image starts and immediately
#     stops, which reads as a crash loop rather than as a missing file.
#   plugins/ — the plugin registry imports the bundled example statically, so that `tsc` can
#     see it and a broken plugin is a compile error rather than a runtime surprise. A build
#     without the directory therefore does not compile at all. That same static import is why
#     the entry point is `dist/src/index.js` and not `dist/index.js`: the compile root has to
#     cover both directories. See tsconfig.build.json.
#
# design/tokens.mjs is NOT copied, and does not need to be: public/tokens.css is generated,
# committed and diffed by scripts/verify.sh, so the runtime never regenerates it.
#
# The image ships no secrets. SESSION_SECRET, QR_HMAC_SECRET and ORGANIZER_SECRET have no
# defaults and the server refuses to boot in production without them; MONGODB_URI likewise,
# with no in-memory escape hatch outside development and test.

# --- build ---------------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src/ ./src
COPY plugins/ ./plugins
RUN npm run build

# --- runtime -------------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# Static shell and the campus model. Read-only at runtime.
COPY public/ ./public
COPY content/ ./content
# Plugin client assets are served from here by path; the compiled hooks are already in dist.
COPY plugins/ ./plugins

# Run as the image's own unprivileged user rather than as root. Nothing here writes to disk.
USER node

EXPOSE 3000
# The container orchestrator's health probe should use /ready, which pings Mongo, rather than
# /health, which answers from memory and would report healthy with no database behind it.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
