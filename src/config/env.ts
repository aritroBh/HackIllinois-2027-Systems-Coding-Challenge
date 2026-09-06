/**
 * Environment contract — parsed once, validated at boot, exported as a typed object.
 *
 * Configuration is read through this module and nowhere else. Reading `process.env`
 * directly elsewhere would bypass both the schema and the production guards below, so
 * the rest of the codebase imports `env` instead.
 *
 * The design principle is **fail fast at boot, never at 3 a.m.** A misconfigured secret
 * should stop the process on startup, where it is obvious, rather than silently minting
 * forgeable tokens under load — hence the production refusal when `QR_HMAC_SECRET` is
 * still the committed default.
 *
 * Defaults let a fresh clone run with zero setup (in-memory Mongo, open CORS, auth off).
 * That is right for a demo and wrong for an event; see the hardening flags in the README.
 */
import dotenv from 'dotenv';
import crypto from 'crypto';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MONGODB_URI: z.string().optional(),
  QR_HMAC_SECRET: z.string().default('hackillinois_waveshift_secret_key_2027'),
  CORS_ORIGIN: z.string().default('*'),
  // When true, gym battles reject requests that omit GPS coordinates, closing the
  // remote-capture bypass. Default false preserves the open-demo behaviour.
  //
  // Scope note, because the name over-promises: this flag governs `GymService` only.
  // Attendance check-in does NOT consult it — `verifyCheckInSchema` makes coordinates
  // unconditionally required, in every environment, so check-in is already closed and
  // needs no flag.
  REQUIRE_GEOFENCE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // When true, all mutating API routes require the organizer secret in the
  // X-Organizer-Secret header. Default false preserves the open-demo contract.
  REQUIRE_AUTH: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  ORGANIZER_SECRET: z.string().default('waveshift_change_me_in_production'),

  // --- identity (plan M1) ---------------------------------------------------
  // `legacy` keeps the open-demo contract: mutations may name a `volunteerId` in the body
  // and it is believed. `required` makes the session cookie the only identity and turns
  // every unauthenticated non-allow-listed API request into a 401. Production forces
  // `required` (guard below). `REQUIRE_AUTH=true` is accepted as a deprecated alias.
  AUTH_MODE: z.enum(['legacy', 'required']).optional(),
  // HMAC key for the session cookie. Like QR_HMAC_SECRET: ephemeral per boot outside
  // production, refused on the committed default in production.
  SESSION_SECRET: z.string().default('nexus_session_change_me'),
  // Origin the browser sees, e.g. https://nexus.hackillinois.org. Used for the WebSocket
  // Origin check, the Adonix redirect and magic-link URLs. Defaults to the local demo.
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  // Magic-link mail. Unset → the provider is reported disabled and dev prints the link.
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Nexus Quest <no-reply@nexus.local>'),
  // Adonix (HackIllinois SSO). ADONIX_URL is env-only, never pack-configurable (SSRF).
  ADONIX_URL: z.string().url().default('https://adonix.hackillinois.org'),
  ADONIX_JWT_SECRET: z.string().optional(),
  ADONIX_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Comma-separated IPv4 CIDRs of the venue's NAT egress; per-IP anti-abuse ceilings do
  // not apply to them (capacity is controlled per account).
  TRUSTED_EGRESS_CIDRS: z.string().default(''),
  /** Content pack directory name under CONTENT_DIR — a bare name, never a path. */
  CONTENT_PACK: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'CONTENT_PACK must be a bare lowercase directory name').default('hackillinois-2027'),
  CONTENT_DIR: z.string().min(1).optional(),
  /** Live multiplayer presence (WebSocket + SSE fallback). */
  PRESENCE_ENABLED: z.string().default('true').transform((v) => v !== 'false' && v !== '0'),
  /**
   * Which plugins are activated at boot, comma-separated. Every plugin in the tree is
   * statically imported so `tsc` sees it; this decides which of them actually run, so
   * shipping a plugin and enabling it are two separate decisions.
   */
  PLUGINS: z.string().default(''),

  // --- capacity -------------------------------------------------------------
  // The per-IP rate limit must be tunable at deploy time. It was previously a
  // hardcoded 300/min whose only escape hatch was NODE_ENV=test — an env under
  // which index.ts deliberately never starts a listener, so no running server
  // could ever raise it. For an event expecting thousands of concurrent users
  // behind shared campus NAT, that ceiling is the binding constraint.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /**
   * The stream table's three ceilings, sized for the event you are actually running.
   *
   * The defaults carry five thousand attendees on two devices each with a thousand slots of
   * headroom, which is the attendance this system is now built for. They are configuration
   * rather than constants because the numbers that matter are a property of the venue: how
   * many people, behind how many egress addresses. An operator running a two-hundred-person
   * hackathon on one uplink wants smaller numbers, and one running a conference behind a
   * single carrier-grade NAT wants a larger per-IP ceiling, not a smaller one.
   */
  STREAM_TOTAL_SLOTS: z.coerce.number().int().positive().default(11_000),
  STREAM_PER_IP: z.coerce.number().int().positive().default(3_000),
  STREAM_ANON_SLOTS: z.coerce.number().int().positive().default(800),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Number of proxy hops to trust for client-IP resolution (0 = trust none).
  // Without this, every client behind a load balancer resolves to the proxy's
  // address and shares a single rate-limit bucket. Set it to the real hop count;
  // do not set it blindly, since an over-large value lets clients spoof
  // X-Forwarded-For and evade the limit entirely.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  // --- HTTP socket timeouts -------------------------------------------------
  // Node's defaults are permissive enough to be a slowloris invitation: a client can
  // announce a large Content-Length, send nothing, and pin a connection for 300 s.
  // These bounds are configuration rather than constants because the correct value for
  // KEEP_ALIVE depends entirely on what sits in front of the process.
  //
  // Two invariants the defaults satisfy and any override must preserve:
  //
  //   REQUEST_TIMEOUT_MS > HEADERS_TIMEOUT_MS > KEEP_ALIVE_TIMEOUT_MS
  //
  // The second half is Node's own requirement. If `headersTimeout` were the shorter of
  // the two, a keep-alive socket could be reaped mid-request.
  //
  // **Deploying behind a load balancer:** AWS ALB, GCP LB and nginx all default to a
  // 60 s upstream idle timeout. If this process closes an idle socket first, the proxy
  // will still consider it reusable, send a request into a closing connection, and
  // return 502 to the user. The standard remedy is to make the backend outlive the
  // proxy — KEEP_ALIVE_TIMEOUT_MS=65000 and HEADERS_TIMEOUT_MS=70000 against a 60 s
  // proxy. The 10 s default here is correct for a directly-exposed process and wrong
  // behind a proxy, which is exactly why it is not hardcoded.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HEADERS_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

// Resolve the identity mode once. Explicit AUTH_MODE wins; the deprecated REQUIRE_AUTH
// alias maps true → required; otherwise legacy (the zero-setup demo).
const resolvedAuthMode: 'legacy' | 'required' =
  parsedEnv.data.AUTH_MODE ?? (parsedEnv.data.REQUIRE_AUTH ? 'required' : 'legacy');
// Written back so anything that (defensively) reads process.env agrees with `env` — the
// SSE hub once read process.env.AUTH_MODE and silently stayed in legacy under the
// REQUIRE_AUTH alias.
process.env.AUTH_MODE = resolvedAuthMode;

// Fail fast in production: the committed HMAC default mints forgeable attendance
// tokens (proven live), and the organizer default neuters REQUIRE_AUTH.
if (parsedEnv.data.NODE_ENV === 'production') {
  if (parsedEnv.data.QR_HMAC_SECRET === 'hackillinois_waveshift_secret_key_2027') {
    console.error('❌ Refusing to boot: QR_HMAC_SECRET is the committed default. Set a strong secret.');
    process.exit(1);
  }
  // Always in production (not only under REQUIRE_AUTH): the secret is also the bootstrap
  // credential for printing badge claim codes.
  if (parsedEnv.data.ORGANIZER_SECRET === 'waveshift_change_me_in_production') {
    console.error('❌ Refusing to boot: ORGANIZER_SECRET is the committed default. Set a strong secret.');
    process.exit(1);
  }
  // A production process with no database URI would boot on mongodb-memory-server and
  // lose every roster, karma total and ticket the moment it restarts — mid-event, that is
  // the worst possible failure, and it used to be only a warning. There is deliberately
  // no escape hatch: in-memory Mongo is for `development` and `test` only.
  if (!parsedEnv.data.MONGODB_URI) {
    console.error('❌ Refusing to boot: MONGODB_URI is required in production (in-memory Mongo loses all data on restart).');
    process.exit(1);
  }
  // Every mutating route is otherwise open to anyone on the venue Wi-Fi. The mode stays
  // optional for demos; production must opt in explicitly so the choice is visible.
  if (resolvedAuthMode !== 'required') {
    console.error('❌ Refusing to boot: AUTH_MODE must be "required" in production (set AUTH_MODE=required or REQUIRE_AUTH=true).');
    process.exit(1);
  }
  if (parsedEnv.data.SESSION_SECRET === 'nexus_session_change_me') {
    console.error('❌ Refusing to boot: SESSION_SECRET is the committed default. Set a strong secret.');
    process.exit(1);
  }
}

export const env = { ...parsedEnv.data, AUTH_MODE: resolvedAuthMode };

if (env.NODE_ENV !== 'production' && env.SESSION_SECRET === 'nexus_session_change_me') {
  env.SESSION_SECRET = `ephemeral_dev_${crypto.randomBytes(24).toString('hex')}`;
  if (env.NODE_ENV !== 'test') console.warn('⚠️  SESSION_SECRET not set: using an ephemeral per-boot secret (sessions invalidate on restart).');
}

// ponytail: outside production, a committed-default secret is swapped for an ephemeral
// random one per boot — offline forgery with the public string then fails even in demos
// (previously proven live), at zero demo cost. Production refuses to boot instead (above).
if (env.NODE_ENV !== 'production' && env.QR_HMAC_SECRET === 'hackillinois_waveshift_secret_key_2027') {
  env.QR_HMAC_SECRET = `ephemeral_dev_${crypto.randomBytes(24).toString('hex')}`;
  if (env.NODE_ENV !== 'test') console.warn('⚠️  QR_HMAC_SECRET not set: using an ephemeral per-boot secret (tokens invalidate on restart).');
}
