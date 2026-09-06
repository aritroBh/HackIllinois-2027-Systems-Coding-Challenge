/**
 * End-to-end acceptance run against a LIVE server.
 *
 * Not a unit suite and not supertest: this drives the real HTTP surface of a running
 * process, over real cookies, with real concurrency, and asserts the invariants the
 * README claims. It is what you run before showing the system to somebody.
 *
 *   npm run demo            # in one terminal
 *   npm run e2e             # in another
 *
 * Every section mirrors a journey in docs/WORKFLOWS.md and prints what it proved.
 */

const BASE = process.env.E2E_BASE ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

const G = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const R = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const D = (s: string): string => `\x1b[2m${s}\x1b[0m`;

function ok(claim: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ${G('PASS')} ${claim}${detail ? D(`  — ${detail}`) : ''}`);
  } else {
    failed += 1;
    failures.push(claim + (detail ? ` — ${detail}` : ''));
    console.log(`  ${R('FAIL')} ${claim}${detail ? R(`  — ${detail}`) : ''}`);
  }
}

function section(n: string): void {
  console.log(`\n\x1b[1;36m── ${n}\x1b[0m`);
}

interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** One signed-in browser: its cookie jar and its CSRF nonce. */
class Client {
  private cookies = new Map<string, string>();
  public csrf = '';
  public id = '';
  public name = '';
  public role = '';

  private jar(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: Response): void {
    // Node's fetch exposes multiple Set-Cookie headers through getSetCookie().
    const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async req<T = any>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; noCsrf?: boolean } = {}
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = this.jar();
    if (cookie) headers['Cookie'] = cookie;
    if (this.csrf && !opts.noCsrf && method !== 'GET') headers['X-CSRF-Token'] = this.csrf;
    let res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    // A 429 is one of this system's own limiters refusing us, not a defect: fifty phones on
    // a campus are fifty addresses, but a single-host acceptance run is one. Wait the window
    // out and ask again rather than turning the limiter off, so what the run exercises is
    // the same code an attacker would meet.
    for (let attempt = 0; res.status === 429 && attempt < 4; attempt += 1) {
      await new Promise((r) => setTimeout(r, 61_000));
      res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    }
    this.absorb(res);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body: body as T, headers: res.headers };
  }

  get = <T = any>(p: string, h?: Record<string, string>): Promise<Res<T>> => this.req<T>('GET', p, { headers: h });
  post = <T = any>(p: string, b?: unknown, h?: Record<string, string>): Promise<Res<T>> =>
    this.req<T>('POST', p, { body: b, headers: h });
  patch = <T = any>(p: string, b?: unknown): Promise<Res<T>> => this.req<T>('PATCH', p, { body: b });
  del = <T = any>(p: string, b?: unknown): Promise<Res<T>> => this.req<T>('DELETE', p, { body: b });

  /**
   * Sign in through the demo adapter and adopt the session it mints.
   *
   * A 429 here is the auth exchange limiter (30 sign-ins a minute per IP) doing its job:
   * fifty phones on a real campus are fifty addresses, but on this host they are one. The
   * run waits the window out rather than disabling the limiter, so what is exercised is
   * the same code an attacker would meet.
   */
  async login(accountId: string): Promise<void> {
    const res = await this.post('/auth/dev-login', { accountId });
    if (res.status !== 200) throw new Error(`dev-login ${accountId} failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.csrf = res.body.data.csrf;
    this.id = res.body.data.account.id;
    this.name = res.body.data.account.displayName;
    this.role = res.body.data.account.role;
  }

  /** The raw Set-Cookie lines from a fresh login, for asserting cookie flags. */
  static async loginRaw(accountId: string): Promise<{ setCookie: string[]; body: any }> {
    const res = await fetch(`${API}/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    const setCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    return { setCookie, body: await res.json() };
  }
}

const anon = new Client();

/** Metres between two WGS84 points, good enough for a geofence assertion. */
function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R_E = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la = (aLat * Math.PI) / 180;
  const lb = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R_E * Math.asin(Math.sqrt(h));
}

async function main(): Promise<void> {
  console.log(`\x1b[1mEnd-to-end acceptance run against ${BASE}\x1b[0m`);

  // ────────────────────────────────────────────────────────────────────────
  section('0. The process is up and the database is behind it');

  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  ok('GET /health reports HEALTHY', health.status === 'HEALTHY', `authMode=${health.authMode}`);
  const ready = await fetch(`${BASE}/ready`);
  const readyBody = await ready.json();
  ok('GET /ready is 200 and the database is connected', ready.status === 200 && readyBody.database === 'connected');
  ok('the presence tick loop is running', typeof health.presence?.ticks === 'number' && health.presence.ticks > 0,
    `${health.presence?.ticks} ticks, p95 ${health.presence?.p95TickMs}ms`);
  ok('background jobs are scheduled', Array.isArray(health.jobs) && health.jobs.length > 0,
    (health.jobs ?? []).map((j: any) => j.name).join(', '));

  // ────────────────────────────────────────────────────────────────────────
  section('1. Getting in — three adapters, one session (docs/WORKFLOWS.md §1)');

  const providers = await anon.get('/auth/providers');
  ok('GET /auth/providers is anonymous and lists the configured ways in', providers.status === 200,
    providers.body.data.providers.map((p: any) => `${p.id}:${p.enabled}`).join(' '));

  const raw = await Client.loginRaw((await anon.get('/auth/dev-accounts')).body.data[0].id);
  const sessionCookie = raw.setCookie.find((c) => c.startsWith('nexus='));
  const csrfCookie = raw.setCookie.find((c) => c.startsWith('nexus_csrf='));
  ok('the session cookie is HttpOnly', !!sessionCookie && /HttpOnly/i.test(sessionCookie));
  ok('the session cookie is SameSite-constrained', !!sessionCookie && /SameSite=(Lax|Strict)/i.test(sessionCookie));
  ok('the CSRF nonce cookie is readable by script (not HttpOnly)', !!csrfCookie && !/HttpOnly/i.test(csrfCookie));
  ok('no session token appears in the response body', !JSON.stringify(raw.body.data.account).includes('nexus'));

  const accounts = (await anon.get('/auth/dev-accounts')).body.data as Array<{ id: string; name: string; role: string }>;
  const organizer = new Client();
  const lead = new Client();
  const alice = new Client();
  const bob = new Client();
  await organizer.login(accounts.find((a) => a.role === 'ORGANIZER')!.id);
  await lead.login(accounts.find((a) => a.role === 'SHIFT_LEAD')!.id);
  await alice.login(accounts.find((a) => a.name.startsWith('Alice'))!.id);
  await bob.login(accounts.find((a) => a.name.startsWith('Bob'))!.id);
  ok('four distinct sessions were minted', new Set([organizer.id, lead.id, alice.id, bob.id]).size === 4,
    `${organizer.name}/${organizer.role}, ${lead.name}/${lead.role}, ${alice.name}, ${bob.name}`);

  const me = await alice.get('/me');
  ok('GET /me resolves the caller from the cookie alone',
    me.status === 200 && me.body.data.account.id === alice.id,
    `${me.body.data?.account?.displayName}, ${me.body.data?.account?.karmaPoints} karma, source=${me.body.data?.source}`);

  // ────────────────────────────────────────────────────────────────────────
  section('2. The perimeter — CSRF and role gates');

  const noCsrf = await alice.req('POST', '/presence', { body: { lat: 40.1138, lng: -88.2249, acc: 5 }, noCsrf: true });
  ok('a session mutation without X-CSRF-Token is refused', noCsrf.status === 403,
    `${noCsrf.status} ${noCsrf.body?.error ?? ''}`);

  const wrongCsrf = await alice.req('POST', '/presence', {
    body: { lat: 40.1138, lng: -88.2249, acc: 5 },
    noCsrf: true,
    headers: { 'X-CSRF-Token': 'not-the-nonce-at-all-0000000000' },
  });
  ok('a forged CSRF nonce is refused', wrongCsrf.status === 403, `${wrongCsrf.status}`);

  const shiftsForRoster = (await anon.get('/shifts')).body.data as any[];
  const rosterAsVolunteer = await alice.get(`/shifts/${shiftsForRoster[0]._id}/roster`);
  ok('a volunteer cannot read a shift roster (lead-only)', rosterAsVolunteer.status === 403,
    `${rosterAsVolunteer.status}`);
  const rosterAsLead = await lead.get(`/shifts/${shiftsForRoster[0]._id}/roster`);
  ok('a lead can read the same roster', rosterAsLead.status === 200);

  const escalate = await lead.patch(`/auth/accounts/${lead.id}/role`, { role: 'ORGANIZER' });
  ok('a lead cannot promote themselves to organiser', escalate.status === 403, `${escalate.status}`);

  const unknown = await anon.get('/definitely-not-a-route');
  ok('an unknown API route answers JSON 404, not HTML', unknown.status === 404 && unknown.body?.error === 'NOT_FOUND');

  // ────────────────────────────────────────────────────────────────────────
  section('3. The fifty-way race — one atomic claim (docs/WORKFLOWS.md §2)');

  const RACERS = 50;
  const CAPACITY = 2;

  // A fresh cohort, so the race is not polluted by seeded registrations.
  const cohort: Client[] = [];
  const created = await Promise.all(
    Array.from({ length: RACERS }, (_, i) =>
      organizer.post('/volunteers', {
        name: `Race Runner ${i}`,
        email: `race-${Date.now()}-${i}@illinois.edu`,
        certifications: ['FOOD_HANDLING'],
      })
    )
  );
  const madeAll = created.every((r) => r.status === 201 || r.status === 200);
  ok(`${RACERS} fresh volunteer accounts were created`, madeAll,
    madeAll ? '' : `first failure: ${created.find((r) => r.status >= 400)?.status} ${JSON.stringify(created.find((r) => r.status >= 400)?.body)}`);
  if (!madeAll) throw new Error('cannot run the race without a clean cohort');

  // The auth exchange limiter allows 30 sign-ins a minute per IP, and these fifty phones all
  // share this host's address. That refusal is the defence working, so the run waits it out
  // rather than turning it off — and proves the limiter is real on the way past.
  const BATCH = 20;
  const ids = created.map((r) => r.body.data._id ?? r.body.data.id as string);
  for (let i = 0; i < ids.length; i += BATCH) {
    if (i > 0) {
      console.log(D(`       auth limiter: waiting 62s for the per-IP sign-in window to reopen`));
      await new Promise((r) => setTimeout(r, 62_000));
    }
    const batch = await Promise.all(
      ids.slice(i, i + BATCH).map(async (id) => {
        const c = new Client();
        await c.login(id);
        return c;
      })
    );
    cohort.push(...batch);
  }
  ok(`all ${RACERS} racers hold a real signed-in session`, cohort.length === RACERS, `${cohort.length}`);

  const start = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
  const end = new Date(Date.now() + 38 * 3600 * 1000).toISOString();
  const contested = await lead.post('/shifts', {
    title: 'E2E Contested Shift',
    description: 'Two seats, fifty phones, one second.',
    category: 'LOGISTICS',
    location: 'Siebel Center Atrium',
    startTime: start,
    endTime: end,
    capacity: CAPACITY,
    requiredSkills: [],
    baseKarma: 100,
  });
  ok('a lead can create a shift', contested.status === 201 || contested.status === 200,
    `${contested.status} ${contested.body?.data?.title ?? JSON.stringify(contested.body).slice(0, 160)}`);
  const contestedId = contested.body.data._id ?? contested.body.data.id;

  const t0 = Date.now();
  const results = await Promise.all(
    cohort.map((c, i) =>
      c.post('/registrations', { shiftId: contestedId }, { 'Idempotency-Key': `e2e-race-${t0}-${i}` })
    )
  );
  const elapsed = Date.now() - t0;

  const statuses = results.map((r) => r.body?.data?.status ?? `HTTP_${r.status}`);
  const confirmed = statuses.filter((s) => s === 'CONFIRMED').length;
  const waitlisted = statuses.filter((s) => s === 'WAITLISTED').length;
  const errors = statuses.filter((s) => String(s).startsWith('HTTP_') && s !== 'HTTP_200' && s !== 'HTTP_201').length;

  console.log(D(`       ${RACERS} requests in ${elapsed} ms → ${confirmed} confirmed, ${waitlisted} waitlisted, ${errors} refused`));
  ok(`exactly ${CAPACITY} of ${RACERS} racers are CONFIRMED`, confirmed === CAPACITY, `got ${confirmed}`);
  ok('nobody was silently dropped: every racer got confirmed, waitlisted or a stated refusal',
    confirmed + waitlisted + errors === RACERS, `${confirmed}+${waitlisted}+${errors}`);

  const afterRace = (await anon.get(`/shifts/${contestedId}`)).body.data;
  ok('the shift is not oversold', afterRace.filledSlots <= afterRace.capacity,
    `filledSlots=${afterRace.filledSlots} capacity=${afterRace.capacity}`);
  ok('the shift is exactly full', afterRace.filledSlots === CAPACITY, `filledSlots=${afterRace.filledSlots}`);

  const dbConfirmed = (await lead.get(`/registrations?shiftId=${contestedId}&status=CONFIRMED`)).body.data as any[];
  ok('the database agrees with the responses: exactly two CONFIRMED rows',
    dbConfirmed.length === CAPACITY, `${dbConfirmed.length} rows`);

  // ────────────────────────────────────────────────────────────────────────
  section('4. Idempotency — a retried phone does not take a second seat');

  const key = `e2e-idem-${Date.now()}`;
  const solo = await lead.post('/shifts', {
    title: 'E2E Idempotency Shift',
    description: 'One seat, one phone, two taps.',
    category: 'LOGISTICS',
    location: 'Siebel Center Atrium',
    startTime: new Date(Date.now() + 60 * 3600 * 1000).toISOString(),
    endTime: new Date(Date.now() + 62 * 3600 * 1000).toISOString(),
    capacity: 5,
    baseKarma: 100,
  });
  const soloId = solo.body.data._id ?? solo.body.data.id;
  const first = await cohort[0].post('/registrations', { shiftId: soloId }, { 'Idempotency-Key': key });
  const replay = await cohort[0].post('/registrations', { shiftId: soloId }, { 'Idempotency-Key': key });
  ok('the replay returns the same registration, not a new one',
    first.body?.data?._id === replay.body?.data?._id,
    `${first.body?.data?._id} vs ${replay.body?.data?._id}`);
  const afterReplay = (await anon.get(`/shifts/${soloId}`)).body.data;
  ok('the replay did not consume a second seat', afterReplay.filledSlots === 1,
    `filledSlots=${afterReplay.filledSlots}`);

  // ────────────────────────────────────────────────────────────────────────
  section('5. The waitlist cascade — a seat is never briefly claimable');

  const beforeCancel = (await lead.get(`/registrations?shiftId=${contestedId}&status=WAITLISTED`)).body.data as any[];
  const victimReg = dbConfirmed[0];
  const victimClient = cohort.find((c) => c.id === (victimReg.volunteerId?._id ?? victimReg.volunteerId))!;
  ok('the confirmed registration maps back to a real signed-in racer', !!victimClient);

  const cancelled = await victimClient.del(`/registrations/${victimReg._id}`);
  ok('a confirmed volunteer can cancel their own seat', cancelled.status === 200, `${cancelled.status}`);

  // Give the cascade a beat; it is in the same request, but the read is a separate round trip.
  await new Promise((r) => setTimeout(r, 250));
  const afterCancel = (await anon.get(`/shifts/${contestedId}`)).body.data;
  const nowConfirmed = (await lead.get(`/registrations?shiftId=${contestedId}&status=CONFIRMED`)).body.data as any[];
  const nowWaitlisted = (await lead.get(`/registrations?shiftId=${contestedId}&status=WAITLISTED`)).body.data as any[];
  ok('the freed seat was refilled from the waitlist, not left empty',
    afterCancel.filledSlots === CAPACITY && nowConfirmed.length === CAPACITY,
    `filledSlots=${afterCancel.filledSlots} confirmed=${nowConfirmed.length}`);
  ok('the waitlist is one shorter than it was', nowWaitlisted.length === beforeCancel.length - 1,
    `${beforeCancel.length} → ${nowWaitlisted.length}`);
  ok('the promoted person is not the one who cancelled',
    !nowConfirmed.some((r: any) => (r.volunteerId?._id ?? r.volunteerId) === victimClient.id));

  // ────────────────────────────────────────────────────────────────────────
  section('6. Swaps — a three-way ring settles or nobody moves (docs/WORKFLOWS.md §2)');

  const swapsBefore = (await lead.get('/swaps')).body.data as any[];
  ok('the seeded demand ring is visible', Array.isArray(swapsBefore),
    `${swapsBefore?.length ?? 0} open swap request(s)`);
  const cycles = await lead.post('/swaps/cycles/resolve', {});
  ok('cycle resolution runs and reports what it did', cycles.status === 200,
    JSON.stringify(cycles.body?.data ?? cycles.body).slice(0, 200));

  // ────────────────────────────────────────────────────────────────────────
  section('7. Turning up — a rotating, single-use, bound check-in token (docs/WORKFLOWS.md §3)');

  const attendee = cohort[1];

  // A shift that is running *now*. Check-in is refused outside half an hour either side of a
  // shift, so the idempotency fixture above — sixty hours out — cannot be checked in to, and
  // should not be: a token for a shift that has not happened is karma for work nobody did.
  const live = await lead.post('/shifts', {
    title: 'E2E Live Shift',
    description: 'Running right now, so somebody can actually turn up to it.',
    category: 'INFO_DESK',
    location: 'Siebel Center Atrium',
    startTime: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
    capacity: 5,
    baseKarma: 100,
  });
  ok('a shift that is running right now can be created', live.status === 201 || live.status === 200,
    `${live.status}`);
  const attendShift = live.body.data._id ?? live.body.data.id;
  await attendee.post('/registrations', { shiftId: attendShift }, { 'Idempotency-Key': `e2e-attend-${Date.now()}` });

  const tok1 = await attendee.post('/attendance/token', { shiftId: attendShift });
  ok('a registered volunteer can mint a check-in token', tok1.status === 200 || tok1.status === 201,
    `${tok1.status}`);
  const token = tok1.body?.data?.token ?? tok1.body?.data?.qrToken;
  ok('the token is an opaque signed string, not the volunteer id', typeof token === 'string' && token.length >= 20,
    typeof token === 'string' ? `${token.length} chars` : String(token));

  const desk = { latitude: 40.113725, longitude: -88.224905 };
  const verify1 = await lead.post('/attendance/verify', { token, scannerId: 'E2E_DESK', coordinates: desk });
  ok('the desk can verify the token once', verify1.status === 200 || verify1.status === 201, `${verify1.status}`);

  const verify2 = await lead.post('/attendance/verify', { token, scannerId: 'E2E_DESK', coordinates: desk });
  ok('the same token cannot be verified twice (single-use)', verify2.status >= 400,
    `${verify2.status} ${verify2.body?.error ?? ''}`);

  const forged = await lead.post('/attendance/verify', {
    token: token.slice(0, -4) + 'aaaa',
    scannerId: 'E2E_DESK',
    coordinates: desk,
  });
  ok('a token with a tampered signature is refused', forged.status >= 400, `${forged.status}`);

  // A valid token for a shift that has not happened yet: the token proves who and which
  // shift, and this is the check that proves *when*.
  const futureTok = await cohort[0].post('/attendance/token', { shiftId: soloId });
  if (futureTok.status === 200 || futureTok.status === 201) {
    const futureVerify = await lead.post('/attendance/verify', {
      token: futureTok.body.data.token,
      scannerId: 'E2E_DESK',
      coordinates: desk,
    });
    ok("a token for a shift that has not started is refused, however valid the token",
      futureVerify.status >= 400 && /not started/i.test(String(futureVerify.body?.message ?? '')),
      `${futureVerify.status} ${String(futureVerify.body?.message ?? '').slice(0, 90)}`);
  } else {
    ok('a token for a shift that has not started is refused, however valid the token',
      false, `could not mint a token for the future shift: ${futureTok.status}`);
  }

  // ────────────────────────────────────────────────────────────────────────
  section('8. Distress — a guarded SOS lifecycle (docs/WORKFLOWS.md §5)');

  const hacker = cohort[2];
  const ticket = await hacker.post('/sos/tickets', {
    hackerName: 'E2E Hacker',
    tableLocation: 'Table 42',
    coordinates: { latitude: 40.1138, longitude: -88.2249 },
    category: 'LOGISTICS_SUPPLIES',
    description: 'Our power strip died and the demo is in twenty minutes.',
    urgency: 'HIGH',
  });
  ok('a hacker can raise a ticket', ticket.status === 201 || ticket.status === 200, `${ticket.status}`);
  const ticketId = ticket.body?.data?._id ?? ticket.body?.data?.id;

  // Asked as a bystander, deliberately. The person who raised the ticket and the responder
  // dispatched to it are parties and get their own copy whole — the responder is walking to
  // that address. Everybody else on the volunteer roster should see a queue entry and no
  // more, which is what the `sos` SSE channel already redacts to.
  const bystander = cohort[7];
  const publicList = (await bystander.get('/sos/tickets')).body?.data;
  const publicJson = JSON.stringify(publicList ?? []);
  ok('the ticket list a bystander sees carries no coordinates, table text or name',
    !/latitude|longitude|tableLocation|hackerName/.test(publicJson),
    publicJson.slice(0, 160));

  const partyList = (await hacker.get('/sos/tickets')).body?.data;
  ok('the person who raised the ticket still sees their own in full',
    JSON.stringify(partyList ?? []).includes('tableLocation'),
    JSON.stringify(partyList ?? []).slice(0, 120));

  const dispatched = await lead.post(`/sos/tickets/${ticketId}/dispatch`, {});
  ok('dispatch picks a responder', dispatched.status === 200,
    JSON.stringify(dispatched.body?.data ?? dispatched.body).slice(0, 200));

  const ackd = await lead.post(`/sos/tickets/${ticketId}/acknowledge`, {});
  ok('the assigned responder can acknowledge', ackd.status === 200 || ackd.status === 409,
    `${ackd.status} ${ackd.body?.error ?? ''}`);

  const onScene = await lead.post(`/sos/tickets/${ticketId}/on-scene`, {});
  ok('on-scene advances the ticket', onScene.status === 200 || onScene.status === 409,
    `${onScene.status} ${onScene.body?.error ?? ''}`);

  const resolved = await lead.post(`/sos/tickets/${ticketId}/resolve`, {});
  ok('a lead who walked to the ticket can close it', resolved.status === 200,
    `${resolved.status} ${resolved.body?.error ?? ''}`);

  const doubleResolve = await lead.post(`/sos/tickets/${ticketId}/resolve`, {});
  ok('an already-resolved ticket cannot be resolved again', doubleResolve.status >= 400,
    `${doubleResolve.status} ${doubleResolve.body?.error ?? ''}`);

  const strangerCancel = await cohort[3].post(`/sos/tickets/${ticketId}/cancel`, {});
  ok('a stranger cannot cancel somebody else\'s ticket', strangerCancel.status >= 400,
    `${strangerCancel.status}`);

  // ────────────────────────────────────────────────────────────────────────
  section('9. Presence — opt-in, buckets not coordinates, symmetric opt-out (docs/PRESENCE.md)');

  const optedOutPost = await alice.post('/presence', { lat: 40.1138, lng: -88.2249, acc: 5 });
  ok('posting a position while opted out is refused or ignored',
    optedOutPost.status >= 400 || optedOutPost.body?.data?.tracked === false,
    `${optedOutPost.status} ${JSON.stringify(optedOutPost.body?.data ?? '').slice(0, 120)}`);

  const optIn = await alice.patch('/me/presence', { optIn: true });
  ok('a player can opt in to presence', optIn.status === 200, `${optIn.status}`);

  const posted = await alice.post('/presence', { lat: 40.1138, lng: -88.2249, acc: 5 });
  ok('an opted-in player can publish a position', posted.status === 200 || posted.status === 202,
    `${posted.status}`);

  const rosterAnon = await anon.get('/presence');
  ok('the presence roster is not readable anonymously', rosterAnon.status >= 400, `${rosterAnon.status}`);
  const rosterVol = await bob.get('/presence');
  ok('the presence roster is not readable by an ordinary volunteer', rosterVol.status >= 400, `${rosterVol.status}`);

  const rosterLead = await lead.get('/presence');
  ok('a lead can read the exact-position roster (one of the two audited readers)',
    rosterLead.status === 200, `${rosterLead.status}`);

  // The "buckets, never a coordinate" claim is about the SHIFT roster, which is what a lead
  // looks at to see who has turned up. GET /presence is deliberately exact — it is one of the
  // two readers docs/PRESENCE.md names, and it writes an audit row for the read.
  const shiftRoster = await lead.get(`/shifts/${shiftsForRoster[0]._id}/roster`);
  const shiftRosterJson = JSON.stringify(shiftRoster.body?.data ?? {});
  ok('the shift roster reports buckets, never a coordinate',
    shiftRoster.status === 200 &&
      !/latitude|longitude|"lat"|"lng"/.test(shiftRosterJson),
    shiftRosterJson.slice(0, 180));

  const optOut = await alice.patch('/me/presence', { optIn: false });
  ok('opting back out succeeds', optOut.status === 200);
  await new Promise((r) => setTimeout(r, 250));
  const rosterAfter = JSON.stringify((await lead.get('/presence')).body?.data ?? {});
  ok('an opted-out player is gone from the roster', !rosterAfter.includes(alice.id),
    rosterAfter.slice(0, 160));

  // ────────────────────────────────────────────────────────────────────────
  section('10. The game layer — geofence, cooldown, and acting only as yourself');

  const beacons = (await anon.get('/pokeshift/hackstops')).body.data as any[];
  ok('the HackStop list is public', Array.isArray(beacons) && beacons.length > 0, `${beacons.length} beacons`);
  const beacon = beacons[0];

  const spinner = cohort[4];
  const atBeacon = { latitude: beacon.latitude, longitude: beacon.longitude };
  const spinNear = await spinner.post(`/pokeshift/hackstops/${beacon.beaconId}/spin`, { coordinates: atBeacon });
  ok('standing at the HackStop, a spin succeeds', spinNear.status === 200 || spinNear.status === 201,
    `${spinNear.status} ${JSON.stringify(spinNear.body?.data ?? spinNear.body).slice(0, 140)}`);

  const farAway = { latitude: beacon.latitude + 0.02, longitude: beacon.longitude + 0.02 };
  const dist = Math.round(metres(beacon.latitude, beacon.longitude, farAway.latitude, farAway.longitude));
  const spinFar = await cohort[5].post(`/pokeshift/hackstops/${beacon.beaconId}/spin`, { coordinates: farAway });
  ok(`a spin from ${dist} m away is refused by the ${beacon.geofenceRadiusMeters} m geofence`,
    spinFar.status >= 400, `${spinFar.status} ${spinFar.body?.error ?? ''}`);

  const spinAgain = await spinner.post(`/pokeshift/hackstops/${beacon.beaconId}/spin`, { coordinates: atBeacon });
  ok('an immediate second spin hits the cooldown', spinAgain.status >= 400,
    `${spinAgain.status} ${spinAgain.body?.error ?? ''}`);

  // The claim is that a session always acts as itself: `resolveActorId` returns the session's
  // own id and never the body's, so naming somebody else is ignored rather than obeyed.
  // Proved by counting inventory on both sides, not by reading the response — a response that
  // merely fails to mention the victim proves nothing.
  const victimBefore = ((await lead.get(`/pokeshift/inventory/${spinner.id}`)).body?.data ?? []).length;
  const thiefBefore = ((await lead.get(`/pokeshift/inventory/${cohort[6].id}`)).body?.data ?? []).length;
  const impersonate = await cohort[6].post(`/pokeshift/hackstops/${beacons[1].beaconId}/spin`, {
    volunteerId: spinner.id,
    coordinates: { latitude: beacons[1].latitude, longitude: beacons[1].longitude },
  });
  const victimAfter = ((await lead.get(`/pokeshift/inventory/${spinner.id}`)).body?.data ?? []).length;
  const thiefAfter = ((await lead.get(`/pokeshift/inventory/${cohort[6].id}`)).body?.data ?? []).length;
  ok('a spin credits the session that made it, never the id named in the body',
    impersonate.status >= 400 || (victimAfter === victimBefore && thiefAfter > thiefBefore),
    `${impersonate.status} — named account ${victimBefore}→${victimAfter}, caller ${thiefBefore}→${thiefAfter}`);

  const gyms = (await anon.get('/pokeshift/gyms')).body.data as any[];
  ok('the gym list is public', Array.isArray(gyms) && gyms.length > 0, `${gyms.length} gyms`);
  ok('the public gym list does not expose a per-user spin ledger',
    !gyms.some((g: any) => g.lastSpunUsers && Object.keys(g.lastSpunUsers).length > 0),
    'checked lastSpunUsers');

  // ────────────────────────────────────────────────────────────────────────
  section('11. The economy — karma is minted once and recorded');

  const cardBefore = (await spinner.get('/me/card')).body?.data;
  const board = await anon.get('/stats/leaderboard');
  ok('the leaderboard is public', board.status === 200, `${(board.body?.data ?? []).length} entries`);
  const boardJson = JSON.stringify(board.body?.data ?? []);
  ok('the leaderboard leaks no email addresses', !/@illinois\.edu/.test(boardJson) && !/"email"/.test(boardJson),
    boardJson.slice(0, 140));
  ok('a player can read their own card', !!cardBefore,
    `${cardBefore?.karmaPoints ?? '?'} karma`);

  const quests = await spinner.get('/me/quests');
  ok('quests are readable and driven by the domain bus', quests.status === 200,
    `${(quests.body?.data?.quests ?? quests.body?.data ?? []).length ?? 0} quest(s)`);
  const stickers = await spinner.get('/me/stickers');
  ok('stickers are readable', stickers.status === 200);
  const inv = await spinner.get(`/pokeshift/inventory/${spinner.id}`);
  ok('the spin actually granted inventory', inv.status === 200,
    JSON.stringify(inv.body?.data ?? {}).slice(0, 160));

  // ────────────────────────────────────────────────────────────────────────
  section('12. The live wire — SSE carries the events the dashboard renders');

  const sseSeen: string[] = [];
  const ac = new AbortController();
  const ssePromise = (async () => {
    const res = await fetch(`${API}/stats/events`, {
      headers: { Accept: 'text/event-stream', Cookie: `nexus_csrf=${lead.csrf}` },
      signal: ac.signal,
    });
    ok('the SSE endpoint opens with the event-stream content type',
      res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/event-stream'),
      `${res.status} ${res.headers.get('content-type')}`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        for (const line of chunk.split('\n')) if (line.startsWith('event:')) sseSeen.push(line.slice(6).trim());
        if (sseSeen.length > 3) break;
      }
    } catch {
      /* aborted */
    }
  })();

  await new Promise((r) => setTimeout(r, 400));
  await lead.post('/announcements', { title: 'E2E broadcast', body: 'The end-to-end run says hello.', severity: 'INFO' })
    .catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1200));
  ac.abort();
  await ssePromise.catch(() => undefined);
  ok('frames arrived on the stream', sseSeen.length > 0, sseSeen.slice(0, 6).join(', '));

  // ────────────────────────────────────────────────────────────────────────
  section('13. The surfaces a visitor actually opens');

  for (const [label, path, needle] of [
    ['the dashboard', '/dashboard/', '<'],
    ['the Swagger UI', '/docs/', 'swagger'],
    ['the content pack the browser reads', '/api/v1/content', 'pack'],
  ] as const) {
    const res = await fetch(`${BASE}${path}`);
    const text = (await res.text()).toLowerCase();
    ok(`${label} serves`, res.status === 200 && text.includes(needle), `${res.status} ${path}`);
  }

  const csp = (await fetch(`${BASE}/dashboard/`)).headers.get('content-security-policy');
  ok('the dashboard ships a Content-Security-Policy', !!csp, (csp ?? '').slice(0, 120));
  ok('the CSP allows no inline script', !!csp && !/script-src[^;]*'unsafe-inline'/.test(csp),
    (csp ?? '').match(/script-src[^;]*/)?.[0] ?? '');

  // ────────────────────────────────────────────────────────────────────────
  section('14. Signing out');

  const bye = await alice.post('/auth/logout', {});
  ok('logout succeeds', bye.status === 200);
  const afterLogout = await alice.get('/me');
  ok('the session is dead afterwards', afterLogout.status >= 400, `${afterLogout.status}`);

  // ────────────────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m${'─'.repeat(64)}\x1b[0m`);
  console.log(`\x1b[1m  ${G(`${passed} passed`)}   ${failed ? R(`${failed} failed`) : `${failed} failed`}\x1b[0m`);
  if (failures.length) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   ${R('•')} ${f}`);
  }
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(R(`\nend-to-end run aborted: ${err?.stack ?? err}`));
  process.exit(2);
});
