/**
 * Express application assembly.
 *
 * This file is deliberately transport-only: it wires middleware and mounts routers, and
 * contains no business logic. The layering is Router → Controller → Service → Model, and
 * the rule is that each layer may only call downward. Controllers translate HTTP to
 * service calls and never touch Mongoose; services own invariants and never see `req`.
 * That separation is what lets the test suite drive services directly.
 *
 * **Middleware order is load-bearing.** Express runs these in registration order, so:
 *
 *  1. `helmet` first — security headers must be set before any handler can respond.
 *  2. `cors`, then body parsing — a request must be parsed before validation can read it.
 *  3. Static assets and Swagger before the API, so they never consume the rate budget.
 *  4. `apiRateLimiter` **before** `mutationAuth` — cheap rejection precedes expensive
 *     comparison, so an unauthenticated flood is dropped without doing crypto work.
 *  5. The JSON 404 after all real routes, so it only catches genuine misses.
 *  6. `errorHandler` **last**. Express identifies an error handler by its four-argument
 *     signature and only reaches it via `next(err)`; registered any earlier, the routes
 *     defined after it would bypass it entirely.
 *
 * One consequence of the CSP worth knowing when editing the dashboard: Helmet's default
 * directives include `script-src-attr 'none'`, which this file does not override. Inline
 * `onclick=` attributes are therefore inert regardless of `'unsafe-inline'` on
 * `script-src` — the two directives govern different things. Every control in the shell
 * is wired through the delegated `data-action` map in `public/app.js`; keep it that way.
 */
import express, { Application, Request, Response } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { REPO_ROOT } from './common/utils/repoRoot';
import swaggerUi from 'swagger-ui-express';
import { v1Router } from './routes/v1';
import { errorHandler } from './middleware/errorHandler';
import { apiRateLimiter, mutationLimiter, ipCeilingLimiter } from './middleware/rateLimiter';
import { requireOrganizerAuth } from './middleware/requireAuth';
import { attachIdentity, enforceAuthMode, requireCsrf } from './middleware/identity';
import { streamEventsHandler } from './routes/v1/stats.routes';
import { isProvenLead } from './common/types/account';
import { eventHub } from './common/sse/eventHub';
import { presenceService } from './presence/service';
import { presenceStore } from './presence/store';
import { schedulerStats } from './scheduler';
import { mountPluginAssets } from './plugins';
import { pluginRegistry } from './plugins/registry';
import { swaggerDocument } from './config/swagger';
import { env } from './config/env';
import { pack } from './content/loader';

/**
 * The assembled application, with no listener bound to it.
 *
 * Binding a port is `src/index.ts`'s job (via `createServer`), and keeping the two apart is
 * what lets the suite `import { app }` and drive it through supertest in-process — no port,
 * no teardown race between parallel suites. Importing this module is not free of side
 * effects, though: the content pack and the rate limiters are both built at module scope by
 * the imports above, so a pack that does not validate takes the process down at import time
 * (`process.exit(1)` in `content/loader`, a throw under `NODE_ENV=test`) rather than failing
 * on the first request that needs a venue.
 */
export const app: Application = express();

// Client-IP resolution for the rate limiter. Behind a proxy or load balancer every
// request arrives from the proxy's address, so without this the entire event shares one
// rate-limit bucket. Set TRUST_PROXY_HOPS to the actual number of hops — a hop count is
// used rather than `true` because trusting every proxy lets a client forge
// X-Forwarded-For and evade the limit outright.
app.set('trust proxy', env.TRUST_PROXY_HOPS);

// 1. Security & Core Middlewares
//
// The script policy is a bare `'self'`: no `'unsafe-inline'`, no CDN. Every script in
// the app is an external file — every module `public/index.html` loads, Swagger UI's own
// bundles, and the avatar preview harness — so nothing legitimate needs the inline allowance,
// and without it an injected `<script>` in any dashboard render simply does not run.
// That is defence in depth behind `esc()`, not a replacement for it.
//
// `styleSrc` still permits inline styles because the dashboard sets element styles
// directly (wave meters, faction colours) and Swagger UI ships inline CSS. Inline style
// is a far weaker primitive than inline script, so this is a deliberate asymmetry.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Stated explicitly even though Helmet 8 already defaults to it: this is the
        // directive that makes inline `onclick=` inert — which is *why* every control
        // in the shell goes through the delegated `data-action` map — and a framework
        // default is not a contract across major versions.
        scriptSrcAttr: ["'none'"],
        // No remote stylesheets: fonts are vendored under /dashboard/fonts and Swagger UI ships
        // its own CSS. `'unsafe-inline'` stays for Swagger's inline styles and the dashboard's
        // CSSOM-driven element styles (see the note above).
        styleSrc: ["'self'", "'unsafe-inline'"],
        // `blob:` is required: the avatar builder loads a user-picked file through
        // `URL.createObjectURL` (public/avatar.js), which yields a blob: URL. Without
        // the scheme listed, that fallback path is blocked with no visible error.
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    frameguard: { action: 'sameorigin' },
  })
);
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (env.NODE_ENV !== 'test') {
  // Same shape as morgan's `dev` format, with one redaction: the Adonix landing page may be
  // reached with the SSO token in the query string (`?token=…`) before the page can move it
  // into the fragment, and a credential must never land in an access log.
  morgan.token('safe-url', (req) => {
    const url = (req as Request).originalUrl ?? req.url ?? '';
    return url.startsWith('/dashboard/auth/adonix') ? url.split('?')[0] + '?<redacted>' : url;
  });
  app.use(morgan(':method :safe-url :status :response-time ms - :res[content-length]'));
}

// 2. Swagger OpenAPI Documentation at /docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// 3. Static Assets for Live War-Room Dashboard at /dashboard, and the active content pack
// (campus model, memorabilia, monument dossiers) at /dashboard/content. The pack is
// served from its own directory so a fork only changes CONTENT_PACK, never a client path.
// Resolved by walking up to the repository root, not by counting `..` from this file. In the
// compiled build this module lives one level deeper (`dist/src/app.js`), so `../public`
// pointed at `dist/public`, which does not exist — and the whole dashboard was a 404 in the
// production image while every API route worked perfectly.
const publicDir = path.join(REPO_ROOT, 'public');
app.use('/dashboard/content', express.static(pack.dir, { maxAge: '1h', etag: true, index: false }));

/**
 * Where HackIllinois SSO comes back to.
 *
 * `adonixStartUrl()` sends the browser to Adonix with `redirect=<PUBLIC_URL>/dashboard/auth/adonix`,
 * and nothing served that path: the static handler missed, the request fell through to the
 * 404, and Adonix sign-in ended on an error page for everybody who used it. It is the
 * hackers' natural way in, so that is most of the event.
 *
 * The shell itself is served here — the same `index.html`, whose asset paths are all absolute
 * — because `session.js` already knows what to do on this path: it lifts the token out of the
 * query string into a fragment with `history.replaceState` before anything can log or cache
 * it, then exchanges it. Serving the shell rather than redirecting keeps that in one place.
 *
 * `no-store` matters here and nowhere else under `/dashboard`: this URL carries a credential
 * in its query string for the few milliseconds before the page rewrites it, and a cached copy
 * of that is a credential sitting in the browser's disk cache. The morgan configuration
 * redacts the query for this path for the same reason.
 */
app.get('/dashboard/auth/adonix', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use('/dashboard', express.static(publicDir));
// Plugin client assets: one explicit route per declared file, each behind the same
// enabled-guard as the plugin's API routes, so a disabled plugin's JS is a 404 too.
mountPluginAssets(app);
app.get('/favicon.ico', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'icon-192.png'));
});
app.get('/', (_req: Request, res: Response) => {
  res.redirect('/dashboard');
});

// 4. API v1 Routes.
//
// Order: identity first (so the limiter can key by account), then the rate limiter, then
// the auth-mode gate (anonymous requests outside the allow-list → 401 in `required`), then
// CSRF for cookie-authenticated mutations, then the routers.
//
// `AUTH_MODE=legacy` keeps the original open-demo contract: `attachIdentity` accepts a
// body/query `volunteerId` as a legacy identity, `enforceAuthMode` passes everything, and
// the organizer-secret gate below still applies to mutations when REQUIRE_AUTH=true — the
// pre-M1 production posture, kept so existing deployments do not change behaviour until
// they opt into `required`.
//
// Read that last clause narrowly. `REQUIRE_AUTH=true` on its own is a deprecated alias that
// resolves AUTH_MODE to `required` (config/env.ts), and the first branch below then skips
// the organizer-secret gate entirely. Both variables have to be set explicitly —
// `AUTH_MODE=legacy REQUIRE_AUTH=true` — for that gate to demand the header from anybody.
const legacyMutationAuth: typeof requireOrganizerAuth = (req, res, next) => {
  if (env.AUTH_MODE === 'required' || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  requireOrganizerAuth(req, res, next);
};

// The live event stream is mounted BEFORE the API limiter: an open SSE connection is not
// an API call and must never consume (or be refused by) the request budget. Identity still
// runs first so the hub can authorise channels per account; per-channel auth and the
// stream-slot table live inside the hub.
app.get('/api/v1/stats/events', attachIdentity, streamEventsHandler);

// Limiter stack (identity-first, see rateLimiter.ts): anonymous traffic is bounded by the
// per-IP sum ceiling and the anonymous bucket; authenticated traffic only by its account
// bucket, plus the tighter mutation bucket for writes.
app.use(
  '/api/v1',
  attachIdentity,
  ipCeilingLimiter,
  apiRateLimiter,
  mutationLimiter,
  enforceAuthMode,
  requireCsrf,
  legacyMutationAuth,
  v1Router
);

// 5. Health checks.
//
// Two endpoints, because liveness and readiness answer different questions and a load
// balancer needs the second one:
//
//   /health  — liveness. Is the process up? Never touches the database, so it stays
//              cheap and cannot be made to fail by a slow query.
//   /ready   — readiness. Can this instance actually serve traffic? Reports the Mongoose
//              connection state and returns 503 when it is not connected, so an
//              orchestrator drains this pod during a database outage instead of routing
//              requests that will hang.
/**
 * Liveness for anyone; telemetry for a proved lead.
 *
 * This used to return the whole operational picture to any anonymous caller, and it has to
 * stay reachable without a cookie because an orchestrator's probe has none. Note where that
 * reachability actually comes from: this route is mounted at the server root, not under
 * `/api/v1`, so `enforceAuthMode` and every rate limiter are mounted past it and none of them
 * runs here. It is not on `ANONYMOUS_ALLOW` — that set only governs paths inside `/api/v1` —
 * and an earlier version of this comment said it was.
 *
 * On a laptop an open telemetry endpoint is a debugging convenience. On a public URL it is a
 * surveillance endpoint: connected stream counts and the exact number of tracked people (how
 * busy is the event, right now), the slot ceilings (how much load it takes to exhaust them),
 * presence tick timings, the plugin list, and `jobs[].lastError` — a background job's error
 * text, which is the one field here that can carry an internal detail nobody chose to publish.
 *
 * A health check needs to say "the process is alive", and that is what an anonymous caller
 * gets now. Everything a human actually debugs with is still here for a lead who has proved
 * it, which is the same rule the roster and the SOS list draw.
 *
 * `attachIdentity` is mounted on this route specifically: it is otherwise scoped to `/api/v1`,
 * so without it `req.account` here is always undefined and the lead branch would be dead code
 * that reads as a working gate. `GET /api/v1/stats/events` mounts it the same way.
 */
app.get('/health', attachIdentity, (req: Request, res: Response) => {
  const base = {
    status: 'HEALTHY',
    service: 'HackIllinois 2027',
    authMode: env.AUTH_MODE,
    timestamp: new Date().toISOString(),
  };
  if (!isProvenLead(req.account)) {
    res.status(200).json(base);
    return;
  }
  res.status(200).json({
    ...base,
    streams: eventHub.stats(),
    presence: { enabled: env.PRESENCE_ENABLED, ...presenceService.stats, tracked: presenceStore.size() },
    jobs: schedulerStats(),
    plugins: pluginRegistry.stats(),
  });
});

app.get('/ready', (_req: Request, res: Response) => {
  // 1 === connected. 0 disconnected, 2 connecting, 3 disconnecting.
  const dbState = mongoose.connection.readyState;
  const ready = dbState === 1;
  res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'READY' : 'NOT_READY',
    service: 'HackIllinois 2027',
    database: ['disconnected', 'connected', 'connecting', 'disconnecting'][dbState] ?? 'unknown',
    timestamp: new Date().toISOString(),
  });
});

// 6. JSON 404 for unknown API routes (Express HTML broke the error contract).
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: 'API route not found.',
    statusCode: 404,
  });
});

// 7. Centralized Error Handler (Must be registered last)
app.use(errorHandler);
