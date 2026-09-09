/**
 * OpenAPI 3 specification, served by Swagger UI at `/docs`.
 *
 * Written by hand rather than generated from decorators, so it is a *description* of the
 * API and not a guarantee: nothing in the build fails when it drifts from the routers.
 * When adding or changing an endpoint, update this file in the same commit — and prefer
 * copying the bounds straight from the matching Zod schema in `src/schemas/`, since those
 * are what actually reject a request at runtime.
 *
 * Every mounted route is now represented here, and nothing is documented that is not
 * mounted: `/adonix/events` was described but never routed, so it was removed rather than
 * implemented, and `/volunteers`, `/announcements`, `/avatars`, `/presence` and `/game`
 * were routed but undescribed, so they were written up. Three endpoints intentionally leave
 * the `{success, data}` envelope and say so on their own entries: `/auth/claim-codes/bulk`
 * under `Accept: text/csv` (raw CSV for badge printing), `GET /avatars/{hash}` (raw
 * `image/png` with an ETag), and `GET /stats/events` (an SSE stream). The
 * `/health` and `/ready` probes sit at the server root rather than under `/api/v1`, so
 * they carry an operation-level `servers` override. It is relative (`/`) rather than an
 * absolute host, so the spec stays correct wherever it is deployed instead of pointing
 * every reader at localhost.
 */
export const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'HackIllinois 2027 API',
    version: '1.0.0',
    description:
      'Volunteer scheduling, SOS spatial dispatch and PokéShift operations engine. Identity (plan M1): cookie sessions with badge-code, magic-link and Adonix adapters; in AUTH_MODE=required every mutation acts as the signed-in account and any body volunteerId is a legacy-mode fallback only. Features atomic WiredTiger CAS guarantees, autonomous waitlist cascades, fatigue rest buffers, bounded elementary-cycle swap discovery, dynamic 30s HMAC-SHA256 attendance tokens, 75m geodesic geofencing, spatial SOS dispatch, campus Gym turf wars, and HackStop supply beacons.',
    contact: {
      name: 'HackIllinois Systems Team Candidate',
      url: 'https://github.com/HackIllinois/adonix',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000/api/v1',
      description: 'Local Development Server',
    },
  ],
  tags: [
    { name: 'Shifts', description: 'Volunteer shift management & dynamic surge pricing' },
    { name: 'Registrations', description: 'Atomic CAS slot reservation & waitlist cascade engine' },
    { name: 'Swaps', description: 'Bilateral atomic swaps & bounded elementary-cycle trade discovery' },
    { name: 'Attendance', description: 'Dynamic 30s HMAC-SHA256 tokens & geofenced check-in' },
    { name: 'SOS', description: 'Hacker emergency distress tickets & spatial nearest-volunteer dispatch' },
    { name: 'PokéShift', description: 'UIUC campus Gym turf wars, HackStop supply beacons & power-up inventory' },
    { name: 'Adonix', description: 'Official HackIllinois Adonix backend event synchronization' },
    { name: 'Stats', description: 'Real-time telemetry, leaderboards & Server-Sent Events (SSE)' },
    { name: 'Volunteers', description: 'Volunteer records, certifications & faction allegiance' },
    { name: 'Operations', description: 'Liveness and readiness probes for orchestrators' },
    { name: 'Identity', description: 'Cookie sessions: badge claim codes, email magic links, Adonix SSO, revocation (docs/IDENTITY.md)' },
    { name: 'Content', description: 'The active content pack: branding, venues, factions, monuments and pack file URLs' },
    { name: 'Announcements', description: 'Lead broadcasts to the floor, filtered server-side by audience' },
    { name: 'Avatars', description: 'Player sprite-sheet upload, lead moderation queue and content-addressed PNG serving' },
    { name: 'Presence', description: 'HTTP mirror of the map presence protocol (the SSE fallback path)' },
    { name: 'Game', description: 'Raid board, faction objectives, karma leaderboard and booth scans' },
  ],
  paths: {
    '/auth/providers': {
      get: {
        summary: 'Sign-in providers enabled on this deployment and the current AUTH_MODE',
        tags: ['Identity'],
        responses: { 200: { description: '{ mode, providers:[{id, enabled, label, startUrl?}] }' } },
      },
    },
    '/auth/claim': {
      post: {
        summary: 'Redeem a badge claim code (single use) — sets the session and CSRF cookies',
        description: '30/min per IP (300/min for TRUSTED_EGRESS_CIDRS). The session token is only ever in the HttpOnly cookie; the body carries the public account and the CSRF nonce.',
        tags: ['Identity'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 10, maxLength: 16 } } } } } },
        responses: { 200: { description: 'Signed in' }, 401: { description: 'CREDENTIAL_INVALID — unknown, expired or used code' } },
      },
    },
    '/auth/magic-link': {
      post: {
        summary: 'Request an email sign-in link (always 202; identical body whether or not the address exists)',
        tags: ['Identity'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } } },
        responses: { 202: { description: 'Accepted' }, 403: { description: 'PROVIDER_DISABLED (no SMTP_URL in production)' } },
      },
    },
    '/auth/magic': {
      post: {
        summary: 'Redeem a magic-link token (#magic= fragment; 15 min; single use)',
        tags: ['Identity'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } } },
        responses: { 200: { description: 'Signed in' }, 401: { description: 'CREDENTIAL_INVALID' } },
      },
    },
    '/auth/adonix': {
      post: {
        summary: 'Sign in (or, from a signed-in session, link) with an Adonix token',
        description: 'Matches on the Adonix subject only. New subjects become HACKER accounts. A subject whose email matches an existing account is refused with 409 ACCOUNT_LINK_REQUIRED; link from a signed-in session instead.',
        tags: ['Identity'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } } },
        responses: { 200: { description: 'Signed in / linked' }, 401: { description: 'Invalid or expired token' }, 403: { description: 'PROVIDER_DISABLED or unmapped roles' }, 409: { description: 'ACCOUNT_LINK_REQUIRED' } },
      },
    },
    '/auth/dev-login': {
      post: {
        summary: 'Development only — mint a session for any account (route is not registered in production)',
        tags: ['Identity'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } } } } } },
        responses: { 200: { description: 'Signed in' }, 404: { description: 'Production' } },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Sign out everywhere: bumps sessionVersion (revokes every cookie for the account) and clears cookies',
        tags: ['Identity'],
        responses: { 200: { description: 'Signed out' } },
      },
    },
    '/auth/claim-codes': {
      post: {
        summary: 'Issue a badge claim code for one account (organiser session or X-Organizer-Secret)',
        tags: ['Identity'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { accountId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' }, email: { type: 'string', format: 'email' }, ttlHours: { type: 'integer', minimum: 1, maximum: 336 } } } } } },
        responses: { 201: { description: '{ code, accountId, expiresAt }' }, 401: { description: 'No credential' }, 403: { description: 'Wrong secret / role' } },
      },
    },
    '/auth/claim-codes/bulk': {
      post: {
        summary: 'Issue one claim code per account, as JSON rows or CSV (Accept: text/csv) for badge printing',
        tags: ['Identity'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { kind: { type: 'string', enum: ['VOLUNTEER', 'HACKER'] }, ttlHours: { type: 'integer' } } } } } },
        responses: { 201: { description: 'Rows or CSV' } },
      },
    },
    '/auth/revoke/{id}': {
      post: {
        summary: 'Revoke every session of an account (lead or above)',
        tags: ['Identity'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } }],
        responses: { 200: { description: '{ accountId, sessionVersion }' }, 403: { description: 'INSUFFICIENT_PERMISSIONS' } },
      },
    },
    '/auth/accounts/{id}/role': {
      patch: {
        summary: 'Change a volunteer account role (organiser)',
        tags: ['Identity'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['VOLUNTEER', 'SHIFT_LEAD', 'ORGANIZER', 'ADMIN'] } } } } } },
        responses: { 200: { description: 'Public account' } },
      },
    },
    '/me': {
      get: {
        summary: 'The signed-in account (401 without a session)',
        tags: ['Identity'],
        responses: { 200: { description: '{ account, source }' }, 401: { description: 'UNAUTHORIZED' } },
      },
    },
    '/content': {
      get: {
        summary: 'Active content pack descriptor: event branding, venues, factions, monuments and pack file URLs',
        tags: ['Content'],
        responses: { 200: { description: 'Content descriptor (public, cacheable 60 s)' } },
      },
    },
    '/announcements': {
      post: {
        summary: 'Broadcast a banner to the floor (lead or above)',
        description: 'Fans out on the `announce` SSE channel as ANNOUNCEMENT. Audience is delivery filtering, not presentation: the GET below never returns a message the caller is not part of.',
        tags: ['Announcements'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: 280 }, audience: { type: 'string', enum: ['ALL', 'VOLUNTEERS', 'HACKERS', 'STAFF'], default: 'ALL' }, tone: { type: 'string', enum: ['INFO', 'WARNING', 'URGENT'], default: 'INFO' }, venueKey: { type: 'string', maxLength: 64 }, minutes: { type: 'integer', minimum: 1, maximum: 240, default: 10 } } } } } },
        responses: { 201: { description: 'Announcement created' }, 401: { description: 'No credential' }, 403: { description: 'Below SHIFT_LEAD' } },
      },
      get: {
        summary: 'Live announcements for the caller\u2019s audience (newest first, at most 50)',
        description: 'Open to anonymous callers, who see only ALL-audience messages. Filtering happens here, never in the client.',
        tags: ['Announcements'],
        responses: { 200: { description: '{ id, message, audience, tone, venueKey, authorName, createdAt, expiresAt }[] (no-store)' } },
      },
    },
    '/announcements/{id}': {
      delete: {
        summary: 'Take an announcement down early (lead or above)',
        description: 'Fans out ANNOUNCEMENT_CLEARED on the `announce` channel so banners vanish without a refresh.',
        tags: ['Announcements'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } }],
        responses: { 200: { description: '{ id, cleared: true }' }, 404: { description: 'NOT_FOUND — already expired or never existed' } },
      },
    },
    '/avatars': {
      post: {
        summary: 'Upload a player sprite sheet for review (raw PNG body)',
        description: 'The body is the PNG bytes (`image/png` or `application/octet-stream`), not JSON. Must be one of 128x48, 128x32, 32x32 or 32x48; it is re-encoded server-side (killing polyglots and ancillary chunks) and content-addressed by sha256. `?share=1` opts in to the public leaderboard face; without it the sheet stays visible only to the owner and leads. Bodies over 64 KB never reach the service — Express answers 413 at the parser limit.',
        tags: ['Avatars'],
        parameters: [{ name: 'share', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1', 'true', 'false'] } }],
        requestBody: { required: true, content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
        responses: { 201: { description: '{ hash, width, height, status, shareOptIn, url }' }, 400: { description: 'Empty, unreadable or wrong-sized PNG' }, 401: { description: 'No credential' }, 413: { description: 'Over the 64 KB parser limit' }, 429: { description: 'Over 20 uploads/hour for this account' } },
      },
    },
    '/avatars/queue': {
      get: {
        summary: 'Pending avatar moderation queue (lead or above)',
        description: 'Returns `ownerId` beside every row: moderation acts on the (hash, ownerId) pair, never on a hash alone, so two uploaders of the same sheet cannot clear each other.',
        tags: ['Avatars'],
        responses: { 200: { description: '{ hash, width, height, ownerId, flags, createdAt }[] (no-store)' } },
      },
    },
    '/avatars/{hash}': {
      get: {
        summary: 'Serve one avatar as raw image/png (no envelope)',
        description: 'Public URL — the hash travels on the presence wire. Honors If-None-Match with a 304. A published, share-opted-in avatar is `private, max-age=60, must-revalidate` (and vanishes by AVATAR_UNPUBLISHED event rather than expiry); anything unpublished is `no-store`, because a cached face photo would outlive its takedown. Unpublished avatars are visible only to the owner and to leads.',
        tags: ['Avatars'],
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }],
        responses: { 200: { description: 'Raw PNG bytes' }, 304: { description: 'ETag matches' }, 404: { description: 'Unknown hash, or unpublished and not yours to see' } },
      },
    },
    '/avatars/{hash}/review': {
      post: {
        summary: 'Approve or reject an avatar (lead or above)',
        tags: ['Avatars'],
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ownerId'], properties: { ownerId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' }, approve: { type: 'boolean', default: true } } } } } },
        responses: { 200: { description: '{ hash, status }' }, 404: { description: 'No row for that (hash, ownerId) pair' } },
      },
    },
    '/avatars/{hash}/flag': {
      post: {
        summary: 'Report an avatar (signed-in session; a lead\u2019s flag unpublishes on its own, three ordinary ones do)',
        description: 'Deliberately session-only: on a claimed legacy identity any `?volunteerId=` was enough to censor a stranger\u2019s photo and to walk past the per-reporter hourly cap.',
        tags: ['Avatars'],
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ownerId'], properties: { ownerId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' }, reason: { type: 'string', minLength: 1, maxLength: 120, default: 'REPORTED' } } } } } },
        responses: { 200: { description: '{ hash, status, unpublished, flags }' } },
      },
    },
    '/presence': {
      post: {
        summary: 'Publish one position sample (the SSE fallback\u2019s input)',
        description: 'Session-only: on a claimed identity this published a position *as* the victim. 202 with accepted:false (never a 4xx) means the sample was refused for a stated reason — OPT_OUT, MUTED, SPEED_STRIKE or a validation reason — so the map client keeps its retry loop simple.',
        tags: ['Presence'],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' }, acc: { type: 'number' }, h: { type: 'number' }, spd: { type: 'number' } } } } } },
        responses: { 202: { description: '{ accepted: true, tick } or { accepted: false, reason }' }, 403: { description: 'OPT_OUT — presence disabled on the account' }, 429: { description: 'MUTED or SPEED_STRIKE' } },
      },
      get: {
        summary: 'Exact positions of everyone publishing (lead or above, one call per 5 s)',
        description: 'Optional centre/radius filter (radiusMeters, default 300). Audited as ONE PresenceAudit document per call, never one per row. Rate-limited per lead, not per IP.',
        tags: ['Presence'],
        parameters: [{ name: 'lat', in: 'query', required: false, schema: { type: 'number' } }, { name: 'lng', in: 'query', required: false, schema: { type: 'number' } }, { name: 'radiusMeters', in: 'query', required: false, schema: { type: 'number', default: 300 } }],
        responses: { 200: { description: '{ count, players: [{ accountId, name, kind, role, faction, onDuty, latitude, longitude, x, z, accuracyMeters, ageMs, stale }], tick } (no-store)' }, 429: { description: 'RATE_LIMITED — one listing per five seconds' } },
      },
      delete: {
        summary: 'Stop publishing and drop the SSE session',
        description: 'Session-only, like the POST beside it: taking a named person off the map must take a session, not a query parameter.',
        tags: ['Presence'],
        responses: { 200: { description: '{ published: false }' } },
      },
    },
    '/shifts': {
      get: {
        summary: 'List shifts with dynamic Karma surge pricing',
        tags: ['Shifts'],
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'location', in: 'query', schema: { type: 'string' } },
          { name: 'availableOnly', in: 'query', schema: { type: 'boolean' } },
          { name: 'surgeOnly', in: 'query', schema: { type: 'boolean' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          200: { description: 'List of enriched shifts' },
        },
      },
      post: {
        summary: 'Create a new shift',
        tags: ['Shifts'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'description', 'category', 'location', 'startTime', 'endTime', 'capacity'],
                properties: {
                  title: { type: 'string', example: 'Siebel Midnight Pizza Distribution' },
                  description: { type: 'string', example: 'Coordinate food distribution for 1,200 hackers' },
                  category: { type: 'string', enum: ['FOOD', 'LOGISTICS', 'SPONSOR_RELATIONS', 'INFO_DESK', 'HARDWARE_LAB', 'MENTOR_SUPPORT', 'CLEANUP'] },
                  location: { type: 'string', example: 'Siebel Center Atrium' },
                  startTime: { type: 'string', format: 'date-time' },
                  endTime: { type: 'string', format: 'date-time' },
                  capacity: { type: 'integer', example: 5 },
                  requiredSkills: { type: 'array', items: { type: 'string' }, example: ['FOOD_HANDLING'] },
                  baseKarma: { type: 'integer', example: 120 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Shift created successfully' },
        },
      },
    },
    '/shifts/{id}': {
      get: {
        summary: 'Get shift details with confirmed and waitlisted roster',
        tags: ['Shifts'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Shift details' },
          404: { description: 'Shift not found' },
        },
      },
      patch: {
        summary: 'Update shift details',
        tags: ['Shifts'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Shift updated' },
        },
      },
      delete: {
        summary: 'Soft-delete a shift',
        tags: ['Shifts'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Shift deactivated' },
        },
      },
    },
    '/registrations': {
      get: {
        summary: 'List registrations, optionally filtered',
        description:
          'Filters are ANDed. `status` accepts every member of RegistrationStatus. Note that SWAP_PENDING is queryable but never currently written — swaps rewrite the registration in place — so it will match nothing until that changes.',
        tags: ['Registrations'],
        parameters: [
          {
            name: 'shiftId',
            in: 'query',
            schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
          },
          {
            name: 'volunteerId',
            in: 'query',
            schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
          },
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: [
                'CONFIRMED',
                'WAITLISTED',
                'CANCELLED',
                'CHECKED_IN',
                'COMPLETED',
                'SWAP_PENDING',
              ],
            },
          },
        ],
        responses: {
          200: { description: 'Matching registrations' },
          400: { description: 'Validation failed' },
        },
      },
      post: {
        summary: 'Atomically reserve a shift slot or join FIFO waitlist',
        tags: ['Registrations'],
        parameters: [
          {
            name: 'idempotency-key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Client UUID preventing duplicate signups on network retries',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['shiftId'], // volunteerId is a legacy-mode fallback; the session is the actor
                properties: {
                  shiftId: { type: 'string', example: '65e7a9b0c123456789abcdef' },
                  volunteerId: { type: 'string', example: '65e7a9b0c123456789abcde0' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Registration confirmed or placed on waitlist' },
          400: { description: 'Validation failed or missing certification' },
          409: { description: 'Schedule conflict, rest buffer violation, or daily fatigue limit reached' },
        },
      },
    },
    '/registrations/{id}': {
      delete: {
        summary: 'Cancel registration and trigger autonomous FIFO waitlist cascade',
        tags: ['Registrations'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Registration cancelled; candidate #1 promoted if waitlist exists' },
        },
      },
    },
    '/swaps': {
      post: {
        summary: 'Propose a shift swap into the escrow engine',
        tags: ['Swaps'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sourceRegistrationId', 'targetShiftId'],
                properties: {
                  sourceRegistrationId: { type: 'string' },
                  targetShiftId: { type: 'string' },
                  targetVolunteerId: { type: 'string' },
                  preferredCategories: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Swap proposed' } },
      },
      get: {
        summary: 'List shift swap proposals',
        tags: ['Swaps'],
        responses: { 200: { description: 'List of swaps' } },
      },
    },
    '/swaps/{id}/accept': {
      post: {
        summary: 'Accept a bilateral shift swap with mutual conflict verification',
        tags: ['Swaps'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Swap executed atomically' } },
      },
    },
    '/swaps/cycles/resolve': {
      post: {
        summary: 'Discover and resolve multi-party directed cycle trades (e.g. A->B->C->A)',
        tags: ['Swaps'],
        responses: { 200: { description: 'Cycles discovered and executed via bounded elementary-cycle rotation' } },
      },
    },
    '/attendance/token': {
      post: {
        summary: 'Generate a dynamic 30s rotating HMAC QR code token',
        tags: ['Attendance'],
        responses: { 200: { description: 'Token generated with 30s TTL' } },
      },
    },
    '/attendance/verify': {
      post: {
        summary: 'Verify dynamic QR code and mark check-in with geodesic geofencing',
        tags: ['Attendance'],
        responses: {
          200: { description: 'Check-in verified and marked' },
          400: { description: 'Token expired or malformed' },
          403: { description: 'Outside 75m geofence radius' },
          409: { description: 'Replay attack detected' },
        },
      },
    },
    '/attendance/{id}/checkout': {
      post: {
        summary: 'Check out and award surge-multiplied Karma points',
        tags: ['Attendance'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Checked out; karma and hours updated' } },
      },
    },
    '/sos/tickets': {
      post: {
        summary: 'File a real-time hacker distress ticket with spatial coordinates',
        tags: ['SOS'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['hackerName', 'tableLocation', 'coordinates', 'description'],
                properties: {
                  hackerName: { type: 'string', example: 'Alex Turing' },
                  tableLocation: { type: 'string', example: 'Siebel Basement Lab 0220' },
                  coordinates: {
                    type: 'object',
                    required: ['latitude', 'longitude'],
                    properties: {
                      latitude: { type: 'number', example: 40.1138 },
                      longitude: { type: 'number', example: -88.2249 },
                    },
                  },
                  category: { type: 'string', enum: ['HARDWARE_MALFUNCTION', 'SPILL_CLEANUP', 'POWER_OUTAGE', 'MEDICAL_FIRST_AID', 'LOGISTICS_SUPPLIES'] },
                  description: { type: 'string', example: 'FPGA development board power rail failure.' },
                  urgency: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
                  requiredSkill: { type: 'string', example: 'HARDWARE' },
                  karmaBounty: { type: 'number', example: 250 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'SOS ticket filed and broadcast via SSE' },
        },
      },
      get: {
        summary: 'List active or past SOS tickets',
        tags: ['SOS'],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['OPEN', 'DISPATCHED', 'RESOLVED', 'CANCELLED'] } },
        ],
        responses: {
          200: { description: 'List of tickets' },
        },
      },
    },
    '/sos/tickets/{id}/dispatch': {
      post: {
        summary: 'Dispatch nearest available on-duty volunteer using spatial Euclidean search',
        tags: ['SOS'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Volunteer dispatched with telemetry vector' },
          404: { description: 'Ticket not found or no on-duty volunteers available' },
        },
      },
    },
    '/sos/tickets/{id}/resolve': {
      post: {
        summary: 'Resolve SOS ticket and award Karma bounty + First Responder badge',
        tags: ['SOS'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  volunteerId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Ticket marked resolved; karma credited' },
          409: { description: 'Ticket already resolved' },
        },
      },
    },
    '/pokeshift/gyms': {
      get: {
        summary: 'List campus PokéShift Gyms and faction dominance status',
        tags: ['PokéShift'],
        responses: {
          200: { description: 'Campus Gyms list' },
        },
      },
    },
    '/pokeshift/gyms/{id}/battle': {
      post: {
        summary: 'Reinforce friendly Gym or battle opposing faction for territorial conquest',
        tags: ['PokéShift'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['faction', 'power'],
                properties: {
                  volunteerId: { type: 'string' },
                  faction: { type: 'string', enum: ['TEAM_KERNEL', 'TEAM_TENSOR', 'TEAM_SILICON'] },
                  power: { type: 'number', minimum: 10, maximum: 500, example: 100 },
                  coordinates: {
                    type: 'object',
                    properties: {
                      latitude: { type: 'number' },
                      longitude: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Battle or reinforcement executed with OCC version guard' },
          403: { description: 'Outside 75m Gym geofence perimeter or gym is shielded' },
        },
      },
    },
    '/pokeshift/hackstops': {
      get: {
        summary: 'List all physical HackStop supply beacons on UIUC campus',
        tags: ['PokéShift'],
        responses: {
          200: { description: 'List of HackStops' },
        },
      },
    },
    '/pokeshift/hackstops/{beaconId}/spin': {
      post: {
        summary: 'Spin a HackStop beacon within 75m for randomized power-up drops and Karma',
        tags: ['PokéShift'],
        parameters: [{ name: 'beaconId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['coordinates'],
                properties: {
                  volunteerId: { type: 'string' },
                  coordinates: {
                    type: 'object',
                    required: ['latitude', 'longitude'],
                    properties: {
                      latitude: { type: 'number' },
                      longitude: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Beacon spun; item awarded to inventory' },
          403: { description: 'Outside 75m geofence radius' },
          409: { description: 'Beacon cooling down (5-minute cooldown)' },
        },
      },
    },
    '/pokeshift/inventory/{volunteerId}': {
      get: {
        summary: 'Get volunteer item backpack and power-up inventory',
        tags: ['PokéShift'],
        parameters: [{ name: 'volunteerId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Volunteer power-up inventory' },
        },
      },
    },
    '/pokeshift/inventory/use': {
      post: {
        summary: 'Activate a power-up from inventory (atomic decrement CAS)',
        tags: ['PokéShift'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['itemType'],
                properties: {
                  volunteerId: { type: 'string' },
                  itemType: { type: 'string', enum: ['COLD_BREW_ELIXIR', 'INSOMNIA_COOKIE_SHIELD', 'OVERCLOCK_SOLDER_CORE', 'RUBBER_DUCK_OMNISCIENCE', 'ANKER_GAUNTLET'] },
                  targetGymId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Power-up activated' },
          400: { description: 'Insufficient inventory or item not found' },
        },
      },
    },
    '/game/raids': {
      get: {
        summary: 'Raid schedule, the window open now, and who is on its roster',
        tags: ['Game'],
        responses: { 200: { description: 'Raid board (no-store)' }, 401: { description: 'AUTH_MODE=required and anonymous' } },
      },
    },
    '/game/objectives': {
      get: {
        summary: 'Faction bar: each faction\u2019s share of who actually turned up',
        tags: ['Game'],
        responses: { 200: { description: 'Objectives board (no-store)' }, 401: { description: 'AUTH_MODE=required and anonymous' } },
      },
    },
    '/game/leaderboard': {
      get: {
        summary: 'Karma ranking, tie-broken by reliability then name so the order is total',
        description: 'The clamp is the point: `limit` tops out at 100, so this stays a leaderboard and never becomes a whole-roster export.',
        tags: ['Game'],
        parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }],
        responses: { 200: { description: 'Leaderboard entries (no-store)' }, 401: { description: 'AUTH_MODE=required and anonymous' } },
      },
    },
    '/game/booths/{id}/scan': {
      post: {
        summary: 'Scan a sponsor booth (once per account per booth, ever)',
        description: 'The code is verified against the deployment secret, not against the pack; the service normalises separators and casing, so a hyphen off a tired hand is still a scan. Both account kinds are accepted on purpose — the sponsor row is the part of the weekend that is for hackers.',
        tags: ['Game'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9-]{1,60}$' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 4, maxLength: 64 } } } } } },
        responses: { 201: { description: 'Scan recorded' }, 401: { description: 'No credential' }, 403: { description: 'Code does not belong to this booth (timing-safe compare)' }, 404: { description: 'No such booth in this content pack' }, 409: { description: 'DUPLICATE_RESOURCE — already scanned (unique index wins the race)' } },
      },
    },
    '/adonix/sync': {
      post: {
        summary: 'Synchronize official HackIllinois Adonix events and synthesize shifts',
        tags: ['Adonix'],
        responses: {
          200: { description: 'Synchronization completed with count of shifts synthesized' },
        },
      },
    },
    '/stats/leaderboard': {
      get: {
        summary: 'Get volunteer leaderboard ranked by Karma points and prestige tier',
        tags: ['Stats'],
        responses: { 200: { description: 'Leaderboard rankings' } },
      },
    },
    '/stats/operations': {
      get: {
        summary: 'Get real-time operational telemetry for hackathon organizers',
        tags: ['Stats'],
        responses: { 200: { description: 'Operations statistics' } },
      },
    },
    '/stats/events': {
      get: {
        summary: 'Real-time Server-Sent Events (SSE) stream for War Room dashboard',
        tags: ['Stats'],
        responses: { 200: { description: 'SSE event stream' } },
      },
    },
    '/volunteers': {
      get: {
        summary: 'List volunteers',
        description:
          'Unprojected and unpaginated — acceptable for the demo dataset, but it must gain both before it carries real attendee records.',
        tags: ['Volunteers'],
        responses: { 200: { description: 'All volunteers' } },
      },
      post: {
        summary: 'Create a volunteer',
        description:
          'Certifications are self-declared at signup; there is no organiser issuance step, so the skill gate documents intent rather than enforcing it.',
        tags: ['Volunteers'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email'],
                properties: {
                  name: { type: 'string', minLength: 2, maxLength: 100 },
                  email: { type: 'string', format: 'email' },
                  phone: { type: 'string' },
                  certifications: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'DRIVERS_LICENSE',
                        'FOOD_HANDLING',
                        'FIRST_AID',
                        'TECHNICAL_MENTOR',
                        'CROWD_CONTROL',
                      ],
                    },
                  },
                  faction: { type: 'string', enum: ['ORANGE', 'BLUE', 'NEUTRAL'] },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Volunteer created' },
          409: { description: 'Email already registered' },
          400: { description: 'Validation failed' },
        },
      },
    },
    '/volunteers/{id}': {
      get: {
        summary: 'Get one volunteer by id',
        tags: ['Volunteers'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
          },
        ],
        responses: {
          200: { description: 'Volunteer record' },
          404: { description: 'Not found' },
        },
      },
    },
    // The two probes live at the server root, not under /api/v1, so they carry their own
    // `servers` override. Without it Swagger UI would render them as /api/v1/health.
    '/health': {
      get: {
        summary: 'Liveness probe',
        description:
          'Is the process up? Never touches the database, so it cannot be made to fail by a slow query. Always 200 while the event loop is responsive.',
        tags: ['Operations'],
        servers: [{ url: '/', description: 'Server root (relative to this host)' }],
        responses: { 200: { description: 'Process is alive' } },
      },
    },
    '/ready': {
      get: {
        summary: 'Readiness probe',
        description:
          'Can this instance serve traffic? Reports the Mongoose connection state and returns 503 when it is not connected, so an orchestrator drains this pod during a database outage rather than routing requests that will hang.',
        tags: ['Operations'],
        servers: [{ url: '/', description: 'Server root (relative to this host)' }],
        responses: {
          200: { description: 'Connected and serving' },
          503: { description: 'Database not connected — do not route traffic here' },
        },
      },
    },
  },
};
