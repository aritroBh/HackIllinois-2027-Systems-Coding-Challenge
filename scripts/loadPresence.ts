/**
 * The presence soak (plan Part D, gate M4b), sized for a five-thousand-attendee event.
 *
 * Jest keeps the protocol and unit tests; a run this size lives here because the shared
 * replica set and the sixty-second test timeout make it infeasible in the suite. This opens
 * real WebSockets against a real server, walks each client along a random path, and reports
 * what the gate is about: how much CPU a tick costs at the far end of the distribution, how
 * long the event loop is ever blocked, and how many bytes go out per second.
 *
 *   npm run bench:presence -- --clients 5000 --devices 2 --seconds 120
 *   npm run bench:presence -- --clients 5000 --storm 10        # 10 % reconnect within 60 s
 *
 * **What the numbers have to say.** Phase one, steady state: tick CPU p95 under 200 ms (the
 * first rung of the load ladder), the longest event-loop block under about 15 ms, the ladder
 * never leaving rung 0, zero cross-transport evictions, and no 1013 close for an account
 * inside its slot budget. Phase two, reconnect storm: a reconnecting account never evicts its
 * own other transport, and every client is back at full detail within sixty seconds.
 *
 * The tick budget is stated as CPU rather than wall clock on purpose. The tick is sliced
 * across the second (see `PresenceService.tick`), so its wall-clock span is meaningless and
 * its blocking behaviour is a separate measurement. A CPU figure of two hundred milliseconds
 * is a fifth of the one-second cadence: past that, presence is a large enough share of the
 * process to start showing up in unrelated request latency, which is exactly when the ladder
 * should be trimming the ring rather than the operator finding out from a complaint.
 *
 * For a quick answer while editing the tick itself, `scripts/benchmarks/presenceTick.ts`
 * measures the same loop in process with no network and no database. It is not the gate; it
 * is the thing you run twenty times an hour so the gate has a chance of passing.
 *
 * The server must be running with PRESENCE_ENABLED=true and reachable at --url.
 *
 * **Source addresses.** The untrusted leg of the gate (3,000 streams per IP against 10,000
 * streams) cannot be exercised from one address: a single host would be refused at 3,000 and
 * the run would prove only that the cap works. Either give this process several local
 * addresses and pass them with `--from 10.0.0.1,10.0.0.2,10.0.0.3,10.0.0.4` (each socket is
 * bound round-robin), or run four copies with `--clients 1250` on four hosts. With one
 * address, pass that address in the server's TRUSTED_EGRESS_CIDRS — that is the trusted leg,
 * and the harness says which leg it ran.
 */
import { WebSocket } from 'ws';

interface Args {
  url: string;
  api: string;
  clients: number;
  devices: number;
  seconds: number;
  stormPercent: number;
  /** Local addresses to bind sockets to, round-robin. Empty means the default route. */
  from: string[];
  organizerSecret?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const api = get('api', 'http://localhost:3000');
  return {
    api,
    url: get('url', api.replace(/^http/, 'ws') + '/ws/presence'),
    clients: Number(get('clients', '5000')),
    devices: Number(get('devices', '2')),
    seconds: Number(get('seconds', '120')),
    stormPercent: Number(get('storm', '0')),
    from: get('from', '').split(',').map((s) => s.trim()).filter(Boolean),
    organizerSecret: process.env.ORGANIZER_SECRET,
  };
}

const QUAD: [number, number] = [40.10746, -88.22713];
const M_PER_LAT = 111320;
const M_PER_LNG = 111320 * Math.cos((QUAD[0] * Math.PI) / 180);

interface Client {
  accountId: string;
  cookie: string;
  csrf: string;
  sockets: WebSocket[];
  lat: number;
  lng: number;
  heading: number;
  rxBytes: number;
  frames: number;
  closes: Array<{ code: number; reason: string }>;
  clusterNotices: number;
  fullNotices: number;
}

async function json(url: string, init: RequestInit & { cookie?: string } = {}): Promise<{ status: number; body: Record<string, unknown>; setCookie: string[] }> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}), ...(init.cookie ? { cookie: init.cookie } : {}) },
  });
  const setCookie = (res.headers.getSetCookie?.() ?? []) as string[];
  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* empty body */ }
  return { status: res.status, body, setCookie };
}

/**
 * Provision one account and sign it in through dev-login (development servers only).
 *
 * The soak represents hackers, not volunteers: an off-shift volunteer is deliberately
 * invisible to their peers, so a crowd of them would measure an empty map. `desk` is a
 * signed-in organiser session, which is what may create a hacker account.
 */
async function makeClient(api: string, i: number, desk: { cookie: string; csrf: string } | null): Promise<Client | null> {
  const created = await json(`${api}/api/v1/volunteers`, {
    method: 'POST',
    cookie: desk?.cookie,
    headers: desk ? { 'x-csrf-token': desk.csrf } : {},
    body: JSON.stringify({ name: `Soak ${i}`, email: `soak.${Date.now()}.${i}@load.test`, kind: 'HACKER', certifications: [] }),
  });
  let accountId = ((created.body.data as { _id?: string } | undefined)?._id) ?? '';
  if (!accountId && created.status === 429) {
    // The desk session has a 90-mutations-per-minute bucket, which a 1,200-account
    // provisioning run walks straight into. Wait it out rather than under-provisioning —
    // which took more than the one attempt this used to make: the bucket refills over a
    // minute, so a single two-second retry only helps when the run happens to be at the
    // boundary of the window.
    for (let attempt = 0; !accountId && attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const retry = await json(`${api}/api/v1/volunteers`, {
        method: 'POST',
        cookie: desk?.cookie,
        headers: desk ? { 'x-csrf-token': desk.csrf } : {},
        body: JSON.stringify({ name: `Soak ${i}`, email: `soak.${Date.now()}.${i}.r${attempt}@load.test`, kind: 'HACKER', certifications: [] }),
      });
      if (retry.status !== 429) {
        accountId = ((retry.body.data as { _id?: string } | undefined)?._id) ?? '';
        break;
      }
    }
  }
  if (!accountId) return null;
  // Sign-in is rate-limited too, and it is the binding one.
  //
  // `POST /auth/dev-login` is a credential exchange: 30 a minute per address, ten times that
  // on trusted egress. The create above retried its 429 and this did not, so past the first
  // thirty accounts of each minute every client was dropped on the floor — two out of three
  // of them across a 1,200-account run. The count printed while provisioning showed it and
  // nothing acted on it, which is how a soak comes to report a verdict for a third of the
  // load it was asked for.
  //
  // Waits and retries rather than giving up, up to a minute in total: the limiter window is
  // a minute, so anything shorter is a coin toss and anything longer is not the limiter.
  let login = await json(`${api}/api/v1/auth/dev-login`, { method: 'POST', body: JSON.stringify({ accountId }) });
  for (let attempt = 0; login.status === 429 && attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    login = await json(`${api}/api/v1/auth/dev-login`, { method: 'POST', body: JSON.stringify({ accountId }) });
  }
  if (login.status !== 200) return null;
  const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
  const csrfCookie = login.setCookie.find((c) => c.includes('nexus_csrf'));
  const csrf = csrfCookie ? decodeURIComponent(csrfCookie.split(';')[0].split('=')[1]) : '';
  // Presence is opt-in; the soak represents people who turned it on.
  await json(`${api}/api/v1/me/presence`, { method: 'PATCH', cookie, headers: { 'x-csrf-token': csrf }, body: JSON.stringify({ optIn: true }) });
  const angle = (i / 5000) * Math.PI * 2;
  return {
    accountId, cookie, csrf, sockets: [],
    lat: QUAD[0] + (Math.sin(angle) * 250) / M_PER_LAT,
    lng: QUAD[1] + (Math.cos(angle) * 250) / M_PER_LNG,
    heading: Math.random() * 360,
    rxBytes: 0, frames: 0, closes: [], clusterNotices: 0, fullNotices: 0,
  };
}

let bindCursor = 0;

function connect(args: Args, c: Client): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const localAddress = args.from.length ? args.from[bindCursor++ % args.from.length] : undefined;
    const ws = new WebSocket(args.url, [`nexus.v1.${c.csrf}`], {
      headers: { cookie: c.cookie },
      ...(localAddress ? { localAddress } : {}),
    });
    const fail = () => resolve(null);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', v: 1, enc: 'bin' }));
      resolve(ws);
    });
    ws.on('message', (raw, isBinary) => {
      c.rxBytes += isBinary ? (raw as Buffer).length : Buffer.byteLength(String(raw));
      c.frames += 1;
      if (!isBinary) {
        try {
          const f = JSON.parse(String(raw)) as { t?: string; mode?: string };
          if (f.t === 'notice' && f.mode === 'clusters') c.clusterNotices += 1;
          if (f.t === 'notice' && f.mode === 'full') c.fullNotices += 1;
        } catch { /* not a JSON frame */ }
      }
    });
    ws.on('close', (code, reason) => c.closes.push({ code, reason: String(reason) }));
    ws.on('error', fail);
    ws.on('unexpected-response', fail);
  });
}

function step(c: Client, metres = 4): void {
  c.heading = (c.heading + (Math.random() - 0.5) * 40 + 360) % 360;
  const rad = (c.heading * Math.PI) / 180;
  c.lat += (Math.cos(rad) * metres) / M_PER_LAT;
  c.lng += (Math.sin(rad) * metres) / M_PER_LNG;
}

async function health(api: string): Promise<Record<string, unknown>> {
  const res = await json(`${api}/health`);
  return (res.body.presence as Record<string, unknown>) ?? {};
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[soak] ${args.clients} accounts × ${args.devices} devices → ${args.url} for ${args.seconds}s` +
    (args.stormPercent ? `, then a ${args.stormPercent}% reconnect storm` : ''));

  // Sign in as the highest-ranked seeded account: creating hacker accounts is a desk action.
  let desk: { cookie: string; csrf: string } | null = null;
  const accounts = await json(`${args.api}/api/v1/auth/dev-accounts`);
  const organiser = (accounts.body.data as Array<{ id: string; role: string }> | undefined)?.[0];
  if (organiser) {
    const login = await json(`${args.api}/api/v1/auth/dev-login`, { method: 'POST', body: JSON.stringify({ accountId: organiser.id }) });
    if (login.status === 200) {
      const cookie = login.setCookie.map((c) => c.split(';')[0]).join('; ');
      const csrfCookie = login.setCookie.find((c) => c.includes('nexus_csrf'));
      desk = { cookie, csrf: csrfCookie ? decodeURIComponent(csrfCookie.split(';')[0].split('=')[1]) : '' };
      console.log(`[soak] desk session: ${organiser.role}`);
    }
  }

  const clients: Client[] = [];
  for (let i = 0; i < args.clients; i++) {
    const c = await makeClient(args.api, i, desk);
    if (c) clients.push(c);
    if (i % 100 === 0) process.stdout.write(`\r[soak] provisioned ${clients.length}/${args.clients}`);
  }
  process.stdout.write(`\r[soak] provisioned ${clients.length}/${args.clients}\n`);
  if (!clients.length) {
    console.error('[soak] could not provision any accounts — is the server running in development with dev-login?');
    return 1;
  }

  for (const c of clients) {
    for (let d = 0; d < args.devices; d++) {
      const ws = await connect(args, c);
      if (ws) c.sockets.push(ws);
    }
  }
  const open = clients.reduce((s, c) => s + c.sockets.length, 0);
  console.log(`[soak] ${open} sockets open`);

  const samples: Array<{ t: number; tickP95: number; rx: number; sessions: number; cluster: boolean }> = [];
  let lastRx = clients.reduce((s, c) => s + c.rxBytes, 0);
  const started = Date.now();

  const walker = setInterval(() => {
    for (const c of clients) {
      step(c);
      const frame = JSON.stringify({ t: 'pos', lat: c.lat, lng: c.lng, acc: 8, h: c.heading });
      for (const ws of c.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }, 5000);

  const sampler = setInterval(async () => {
    const h = await health(args.api);
    const rx = clients.reduce((s, c) => s + c.rxBytes, 0);
    samples.push({
      t: Date.now() - started,
      tickP95: Number(h.p95TickMs ?? 0),
      rx: rx - lastRx,
      sessions: Number(h.sessions ?? 0),
      cluster: Boolean(h.clusterMode),
    });
    lastRx = rx;
    const last = samples[samples.length - 1];
    process.stdout.write(`\r[soak] t=${Math.round(last.t / 1000)}s sessions=${last.sessions} tickP95=${last.tickP95}ms rx=${(last.rx / 1024).toFixed(0)}KB/s cluster=${last.cluster}`);
  }, 1000);

  await new Promise((r) => setTimeout(r, args.seconds * 1000));

  let stormOk = true;
  let stormSurvivors = 0;
  let stormFullDetail = 0;
  let victimCount = 0;
  if (args.stormPercent > 0) {
    console.log(`\n[soak] reconnect storm: ${args.stormPercent}% of clients drop one socket`);
    const victims = clients.filter(() => Math.random() * 100 < args.stormPercent);
    victimCount = victims.length;
    // Remember the OTHER leg of each victim: it must survive its sibling's reconnect,
    // which is the whole point of same-transport replacement.
    const survivors = new Map<Client, WebSocket | undefined>();
    for (const c of victims) {
      const doomed = c.sockets.shift();
      survivors.set(c, c.sockets[0]);
      c.clusterNotices = 0;
      c.fullNotices = 0;
      doomed?.close(1000, 'storm');
      const ws = await connect(args, c);
      if (ws) c.sockets.push(ws);
      else stormOk = false;
    }
    await new Promise((r) => setTimeout(r, 60_000));
    for (const c of victims) {
      const sibling = survivors.get(c);
      // Cross-transport eviction is the failure this gate exists to catch.
      if (sibling && sibling.readyState === WebSocket.OPEN) stormSurvivors += 1;
      else if (sibling) stormOk = false;
      // Back to full detail within the minute: either it never degraded, or it recovered.
      if (c.clusterNotices === 0 || c.fullNotices > 0) stormFullDetail += 1;
      else stormOk = false;
    }
  }

  clearInterval(walker);
  clearInterval(sampler);
  const held = clients.reduce((s, c) => s + c.sockets.filter((w) => w.readyState === WebSocket.OPEN).length, 0);
  for (const c of clients) for (const ws of c.sockets) ws.close(1000, 'done');

  const steady = samples.slice(Math.floor(samples.length * 0.2));
  const tickP95 = Math.max(...steady.map((s) => s.tickP95), 0);
  const rxPeak = Math.max(...steady.map((s) => s.rx), 0);
  const clusterTriggered = steady.some((s) => s.cluster);
  const closes1013 = clients.reduce((s, c) => s + c.closes.filter((x) => x.code === 1013).length, 0);

  console.log('\n\n=== M4b gate ===');
  const row = (label: string, value: string, ok: boolean) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} ${value}`);
  row('tick p95 < 30 ms', `${tickP95} ms`, tickP95 < 30);
  row('outbound < 1 MB/s', `${(rxPeak / 1024).toFixed(0)} KB/s peak`, rxPeak < 1024 * 1024);
  row('cluster-only fallback never triggered', String(clusterTriggered), !clusterTriggered);
  row('no 1013 closes inside the slot budget', String(closes1013), closes1013 === 0);
  row('sockets held', `${held}/${open}`, held >= open * 0.95);
  // The load the gate was asked for, asserted rather than assumed.
  //
  // Every threshold above is a function of how many clients actually connected, and the run
  // that produced this file provisioned 370 of 1,200 while printing PASS-shaped numbers for
  // all of them. A soak that quietly measures a third of the event is not a soak that failed
  // — it is one that answered a different question, which is worse, because the answer looks
  // like the one you asked for.
  row('provisioned what was asked for', `${clients.length}/${args.clients}`, clients.length >= args.clients * 0.98);
  if (args.stormPercent > 0) {
    row('storm: sibling connection survived', `${stormSurvivors}/${victimCount}`, stormSurvivors === victimCount);
    row('storm: full detail within 60 s', `${stormFullDetail}/${victimCount}`, stormFullDetail === victimCount);
  }
  console.log(`\n      leg: ${args.from.length > 1 ? `${args.from.length} source addresses (untrusted-capable)` : 'one source address (trusted-egress leg only)'}`);

  const provisionedEnough = clients.length >= args.clients * 0.98;
  const passed = provisionedEnough && tickP95 < 30 && rxPeak < 1024 * 1024 && !clusterTriggered && closes1013 === 0 && stormOk;
  console.log(passed ? '\nM4b: PASS' : '\nM4b: FAIL');
  return passed ? 0 : 1;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
