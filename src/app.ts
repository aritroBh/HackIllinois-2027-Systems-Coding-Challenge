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
import swaggerUi from 'swagger-ui-express';
import { v1Router } from './routes/v1';
import { errorHandler } from './middleware/errorHandler';
import { apiRateLimiter, mutationLimiter, ipCeilingLimiter } from './middleware/rateLimiter';
import { requireOrganizerAuth } from './middleware/requireAuth';
import { attachIdentity, enforceAuthMode, requireCsrf } from './middleware/identity';
import { streamEventsHandler } from './routes/v1/stats.routes';
import { eventHub } from './common/sse/eventHub';
import { swaggerDocument } from './config/swagger';
import { env } from './config/env';

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
// the app is an external file — the five dashboard modules, Swagger UI's own bundles,
// and the avatar preview harness — so nothing legitimate needs the inline allowance,
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
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        // `blob:` is required: the avatar builder loads a user-picked file through
        // `URL.createObjectURL` (public/avatar.js), which yields a blob: URL. Without
        // the scheme listed, that fallback path is blocked with no visible error.
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
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
  app.use(morgan('dev'));
}

// 2. Swagger OpenAPI Documentation at /docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// 3. Static Assets for Live War-Room Dashboard at /dashboard
const publicDir = path.join(__dirname, '../public');
app.use('/dashboard', express.static(publicDir));
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
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'HEALTHY',
    service: 'WaveShift Nexus',
    authMode: env.AUTH_MODE,
    streams: eventHub.stats(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/ready', (_req: Request, res: Response) => {
  // 1 === connected. 0 disconnected, 2 connecting, 3 disconnecting.
  const dbState = mongoose.connection.readyState;
  const ready = dbState === 1;
  res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? 'READY' : 'NOT_READY',
    service: 'WaveShift Nexus',
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
