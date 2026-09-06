/**
 * SSE hub v2: channels, envelope, replay, redaction, slots, backpressure bookkeeping.
 *
 * Streams are opened with raw `http.request` against a tiny express app on an ephemeral
 * port rather than supertest, because supertest resolves on `end` and an SSE response
 * never ends. Identity is simulated by a test-only middleware that sets `req.account` —
 * these tests must not depend on the identity middleware being present or wired.
 */
import express, { Application } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { streamEventsHandler } from '../src/routes/v1/stats.routes';
import { eventHub, redactSos, channelOfType } from '../src/common/sse/eventHub';
import { streamLimits, StreamLimits } from '../src/common/streamLimits';
import { AccountContext } from '../src/common/types/account';

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

interface Stream {
  res: http.IncomingMessage;
  next: (match?: (f: Frame) => boolean, timeoutMs?: number) => Promise<Frame>;
  close: () => void;
  ended: Promise<void>;
}

function account(role: AccountContext['role'], id = `acct_${role.toLowerCase()}`): AccountContext {
  return {
    id,
    kind: role === 'HACKER' ? 'HACKER' : 'VOLUNTEER',
    role,
    faction: null,
    displayName: id,
    sessionVersion: 0,
    source: 'session',
  };
}

function makeApp(): Application {
  const app = express();
  // Test-only identity: `x-test-role` → req.account. Absent header → anonymous.
  app.use((req, _res, next) => {
    const role = req.header('x-test-role') as AccountContext['role'] | undefined;
    if (role) req.account = account(role, req.header('x-test-account') ?? undefined);
    next();
  });
  app.get('/events', streamEventsHandler);
  return app;
}

function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: Frame[] = [];
  for (const part of parts) {
    const frame: Frame = {};
    let hasField = false;
    for (const line of part.split('\n')) {
      if (line.startsWith(':') || line.trim() === '') continue;
      const idx = line.indexOf(':');
      const field = line.slice(0, idx);
      const value = line.slice(idx + 1).replace(/^ /, '');
      if (field === 'id' || field === 'event' || field === 'data') {
        frame[field] = value;
        hasField = true;
      }
    }
    if (hasField) frames.push(frame);
  }
  return { frames, rest };
}

function openStream(server: http.Server, path: string, headers: Record<string, string> = {}): Promise<Stream> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const queue: Frame[] = [];
      const waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        const parsed = parseFrames(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const i = waiters.findIndex((w) => w.match(frame));
          if (i >= 0) waiters.splice(i, 1)[0].resolve(frame);
          else queue.push(frame);
        }
      });
      const ended = new Promise<void>((done) => {
        res.on('end', () => done());
        res.on('close', () => done());
      });
      resolve({
        res,
        ended,
        close: () => req.destroy(),
        next: (match = () => true, timeoutMs = 3000) =>
          new Promise<Frame>((ok, fail) => {
            const i = queue.findIndex(match);
            if (i >= 0) {
              ok(queue.splice(i, 1)[0]);
              return;
            }
            const timer = setTimeout(() => fail(new Error(`No matching SSE frame within ${timeoutMs}ms`)), timeoutMs);
            waiters.push({
              match,
              resolve: (f) => {
                clearTimeout(timer);
                ok(f);
              },
            });
          }),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** A non-stream response (403/503/400) — collected in full. */
function requestJson(server: http.Server, path: string, headers: Record<string, string> = {}) {
  const { port } = server.address() as AddressInfo;
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject);
    req.end();
  });
}

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const isEvent = (frame: Frame) => frame.event !== 'CONNECTED';

describe('SSE hub v2', () => {
  let server: http.Server;
  const open: Stream[] = [];
  const originalAuthMode = process.env.AUTH_MODE;

  const stream = async (path: string, headers?: Record<string, string>) => {
    const s = await openStream(server, path, headers);
    open.push(s);
    await s.next((f) => f.event === 'CONNECTED');
    return s;
  };

  beforeAll(async () => {
    server = makeApp().listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
  });

  afterEach(async () => {
    for (const s of open.splice(0)) s.close();
    process.env.AUTH_MODE = originalAuthMode;
    await waitFor(() => eventHub.getConnectedCount() === 0);
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  describe('channel inference', () => {
    it.each([
      ['SHIFT_CREATED', 'ops'],
      ['SWAP_EXECUTED', 'ops'],
      ['VOLUNTEER_CHECKED_IN', 'ops'],
      ['SOS_TICKET_CREATED', 'sos'],
      ['GYM_CAPTURED', 'game'],
      ['HACKSTOP_SPUN', 'game'],
      ['PRESENCE_TICK', 'presence'],
      ['SOS_ESCALATED', 'announce'],
      ['CLAIM_BRUTE_FORCE', 'announce'],
      ['ANNOUNCEMENT', 'announce'],
      ['SOMETHING_NEW', 'ops'],
    ])('%s → %s', (type, channel) => {
      expect(channelOfType(type)).toBe(channel);
    });
  });

  describe('subscriptions and wire format', () => {
    it('default subscription receives ops events and not presence', async () => {
      const s = await stream('/events');
      eventHub.broadcast({ type: 'PRESENCE_TICK', data: { p: [] } });
      eventHub.broadcast({ type: 'SHIFT_CREATED', data: { shiftId: 's1' } });
      const frame = await s.next(isEvent);
      // Writes are ordered on one socket: had PRESENCE_TICK been sent it would arrive first.
      expect(frame.event).toBe('SHIFT_CREATED');
      expect(frame.id).toBeUndefined(); // v1 wire is unchanged
      expect(JSON.parse(frame.data!)).toEqual({ shiftId: 's1' });
    });

    it('channels=presence receives only presence', async () => {
      const s = await stream('/events?channels=presence');
      eventHub.broadcast({ type: 'SHIFT_CREATED', data: { shiftId: 's2' } });
      eventHub.broadcast({ type: 'PRESENCE_TICK', data: { p: [1] } });
      const frame = await s.next(isEvent);
      expect(frame.event).toBe('PRESENCE_TICK');
    });

    it('v=2 wraps the payload in {v, ts, ch, data} and carries an id line', async () => {
      const s = await stream('/events?v=2');
      eventHub.broadcast({ type: 'GYM_CAPTURED', data: { gymId: 'g1' } });
      const frame = await s.next(isEvent);
      expect(frame.event).toBe('GYM_CAPTURED');
      expect(Number(frame.id)).toBeGreaterThan(0);
      const body = JSON.parse(frame.data!);
      expect(body).toEqual({ v: 2, ts: expect.any(Number), ch: 'game', data: { gymId: 'g1' } });
    });

    it('rejects a channel list with no known channels', async () => {
      const r = await requestJson(server, '/events?channels=bogus');
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('BAD_REQUEST');
    });

    it('broadcastChannel and sendToAccount target the named channel / account', async () => {
      const mine = await stream('/events?channels=me,announce&v=2', { 'x-test-role': 'HACKER', 'x-test-account': 'h1' });
      const other = await stream('/events?channels=me,announce&v=2', { 'x-test-role': 'HACKER', 'x-test-account': 'h2' });
      eventHub.sendToAccount('h1', { type: 'SOS_TICKET_CREATED', data: { _id: 't9', hackerName: 'Me' } });
      eventHub.broadcastChannel('announce', { type: 'HELLO', data: { text: 'welcome' } });

      const targeted = await mine.next(isEvent);
      expect(targeted.event).toBe('SOS_TICKET_CREATED');
      expect(JSON.parse(targeted.data!)).toMatchObject({ ch: 'me', data: { _id: 't9', hackerName: 'Me' } });

      // h2 never saw the targeted frame: its first event is the announcement.
      const announced = await other.next(isEvent);
      expect(announced.event).toBe('HELLO');
      expect(JSON.parse(announced.data!).ch).toBe('announce');
    });
  });

  describe('authorisation (AUTH_MODE=required)', () => {
    beforeEach(() => {
      process.env.AUTH_MODE = 'required';
    });

    it('anonymous callers keep only announce; asking for nothing else yields 403', async () => {
      const r = await requestJson(server, '/events?channels=ops,sos');
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('FORBIDDEN');

      const s = await stream('/events?channels=ops,announce');
      eventHub.broadcast({ type: 'SHIFT_CREATED', data: {} });
      eventHub.broadcast({ type: 'ANNOUNCEMENT', data: { text: 'lunch' } });
      expect((await s.next(isEvent)).event).toBe('ANNOUNCEMENT');
    });

    it('presence:exact needs a lead; a hacker is silently dropped from it', async () => {
      const hacker = await stream('/events?channels=presence:exact,presence', { 'x-test-role': 'HACKER' });
      const lead = await stream('/events?channels=presence:exact', { 'x-test-role': 'SHIFT_LEAD' });
      eventHub.broadcastChannel('presence:exact', { type: 'PRESENCE_EXACT', data: { who: 'x' } });
      eventHub.broadcastChannel('presence', { type: 'PRESENCE_TICK', data: {} });
      expect((await lead.next(isEvent)).event).toBe('PRESENCE_EXACT');
      expect((await hacker.next(isEvent)).event).toBe('PRESENCE_TICK');
    });
  });

  describe('sos redaction', () => {
    const ticket = {
      _id: 't1',
      status: 'OPEN',
      venueKey: 'SIEBEL_ATRIUM',
      category: 'MEDICAL',
      urgency: 'HIGH',
      hackerName: 'Ada',
      tableLocation: 'Table 42',
      coordinates: { latitude: 40.1, longitude: -88.2 },
    };

    it('redactSos keeps only the five safe fields and accepts ticketId in place of _id', () => {
      expect(redactSos(ticket)).toEqual({
        ticketId: 't1',
        status: 'OPEN',
        venueKey: 'SIEBEL_ATRIUM',
        category: 'MEDICAL',
        urgency: 'HIGH',
      });
      expect(redactSos({ ticketId: 't2', status: 'RESOLVED' }).ticketId).toBe('t2');
      expect(redactSos(null).ticketId).toBeUndefined();
    });

    it('a non-lead account receives the redacted payload; a lead receives the full ticket', async () => {
      const hacker = await stream('/events?channels=sos', { 'x-test-role': 'HACKER' });
      const lead = await stream('/events?channels=sos', { 'x-test-role': 'SHIFT_LEAD' });
      eventHub.broadcast({ type: 'SOS_TICKET_CREATED', data: ticket });

      const redacted = JSON.parse((await hacker.next(isEvent)).data!);
      expect(redacted).toEqual({
        ticketId: 't1',
        status: 'OPEN',
        venueKey: 'SIEBEL_ATRIUM',
        category: 'MEDICAL',
        urgency: 'HIGH',
      });
      expect(redacted.hackerName).toBeUndefined();
      expect(redacted.coordinates).toBeUndefined();

      const full = JSON.parse((await lead.next(isEvent)).data!);
      expect(full).toEqual(ticket);
    });

    it('legacy mode keeps the anonymous stream open and unredacted, as today', async () => {
      const anon = await stream('/events?channels=sos');
      eventHub.broadcast({ type: 'SOS_TICKET_CREATED', data: ticket });
      expect(JSON.parse((await anon.next(isEvent)).data!)).toEqual(ticket);
    });
  });

  describe('replay', () => {
    it('replays events newer than Last-Event-ID, respecting channels and redaction', async () => {
      const first = await stream('/events?v=2&channels=ops,sos', { 'x-test-role': 'HACKER' });
      eventHub.broadcast({ type: 'SHIFT_CREATED', data: { n: 1 } });
      const seen = await first.next(isEvent);
      first.close();
      await waitFor(() => eventHub.getConnectedCount() === 0);

      eventHub.broadcast({ type: 'SHIFT_UPDATED', data: { n: 2 } });
      eventHub.broadcast({ type: 'GYM_CAPTURED', data: { n: 3 } }); // game: not subscribed
      eventHub.broadcast({ type: 'SOS_TICKET_CREATED', data: { _id: 't5', status: 'OPEN', hackerName: 'Bo' } });

      const second = await stream('/events?v=2&channels=ops,sos', {
        'x-test-role': 'HACKER',
        'Last-Event-ID': seen.id!,
      });
      const a = await second.next(isEvent);
      const b = await second.next(isEvent);
      expect(a.event).toBe('SHIFT_UPDATED');
      expect(JSON.parse(a.data!).data).toEqual({ n: 2 });
      expect(b.event).toBe('SOS_TICKET_CREATED');
      expect(JSON.parse(b.data!).data).toEqual({ ticketId: 't5', status: 'OPEN' });
      expect(Number(b.id)).toBeGreaterThan(Number(a.id));

      // Nothing else was replayed: the next frame is a live one.
      eventHub.broadcast({ type: 'SHIFT_DELETED', data: { n: 4 } });
      expect((await second.next(isEvent)).event).toBe('SHIFT_DELETED');
    });

    it('accepts ?lastEventId= as an alternative to the header', async () => {
      const probe = await stream('/events?v=2');
      eventHub.broadcast({ type: 'SHIFT_CREATED', data: { n: 1 } });
      const seen = await probe.next(isEvent);
      eventHub.broadcast({ type: 'SHIFT_CREATED', data: { n: 2 } });
      const s = await stream(`/events?v=2&lastEventId=${seen.id}`);
      expect(JSON.parse((await s.next(isEvent)).data!).data).toEqual({ n: 2 });
    });

    it('sends RESYNC when the id predates the 200-event ring buffer', async () => {
      const probe = await stream('/events?v=2&channels=ops');
      eventHub.broadcast({ type: 'SHIFT_CREATED', data: { n: 0 } });
      const oldest = await probe.next(isEvent);
      for (let i = 1; i <= 201; i++) eventHub.broadcast({ type: 'SHIFT_UPDATED', data: { i } });
      probe.close();
      await waitFor(() => eventHub.getConnectedCount() === 0);

      const s = await stream('/events?v=2&channels=ops', { 'Last-Event-ID': oldest.id! });
      const frame = await s.next(isEvent);
      expect(frame.event).toBe('RESYNC');
      expect(JSON.parse(frame.data!).data).toEqual({ reason: 'BUFFER_EXPIRED' });
    });

    it('sends RESYNC for an id from another process (ahead of the counter)', async () => {
      const s = await stream('/events?v=2', { 'Last-Event-ID': '999999999' });
      expect((await s.next(isEvent)).event).toBe('RESYNC');
    });
  });

  describe('slots and eviction', () => {
    it('a third SSE stream for one account evicts the oldest with a final EVICTED frame', async () => {
      const headers = { 'x-test-role': 'VOLUNTEER', 'x-test-account': 'v1' };
      const a = await stream('/events', headers);
      const b = await stream('/events', headers);
      const c = await stream('/events', headers);

      const evicted = await a.next(isEvent);
      expect(evicted.event).toBe('EVICTED');
      await a.ended;

      eventHub.broadcast({ type: 'SHIFT_CREATED', data: {} });
      expect((await b.next(isEvent)).event).toBe('SHIFT_CREATED');
      expect((await c.next(isEvent)).event).toBe('SHIFT_CREATED');
      expect(eventHub.stats().slots.byTransport.sse).toBe(2);
    });

    it('a destroyed socket is removed and its slot released', async () => {
      const before = streamLimits.stats().total;
      const s = await stream('/events');
      expect(eventHub.getConnectedCount()).toBe(1);
      expect(streamLimits.stats().total).toBe(before + 1);
      s.close();
      await waitFor(() => eventHub.getConnectedCount() === 0);
      expect(streamLimits.stats().total).toBe(before);
    });

    it('stats() reports clients per channel', async () => {
      await stream('/events?channels=ops,game');
      await stream('/events?channels=game');
      const stats = eventHub.stats();
      expect(stats.clients).toBe(2);
      expect(stats.byChannel.game).toBe(2);
      expect(stats.byChannel.ops).toBe(1);
      expect(stats.byChannel.presence).toBe(0);
    });
  });
});

describe('streamLimits table', () => {
  it('a third connection of the same transport replaces the oldest of that transport only', () => {
    const table = new StreamLimits();
    const sse1 = table.tryAcquire({ transport: 'sse', accountId: 'a', ip: '1.1.1.1' });
    const ws1 = table.tryAcquire({ transport: 'ws', accountId: 'a', ip: '1.1.1.1' });
    expect(sse1.ok && ws1.ok).toBe(true);

    const sse2 = table.tryAcquire({ transport: 'sse', accountId: 'a', ip: '1.1.1.1' });
    expect(sse2.ok).toBe(true);
    if (!sse2.ok || !sse1.ok) throw new Error('unreachable');
    expect(sse2.evict?.id).toBe(sse1.slot.id); // the SSE leg, never the WS leg
    expect(table.stats()).toMatchObject({ total: 2, byTransport: { sse: 1, ws: 1 } });

    const ws2 = table.tryAcquire({ transport: 'ws', accountId: 'a', ip: '1.1.1.1' });
    if (!ws2.ok || !ws1.ok) throw new Error('unreachable');
    expect(ws2.evict?.id).toBe(ws1.slot.id);
    expect(table.stats().byTransport).toEqual({ sse: 1, ws: 1 });
  });

  it('never evicts the other transport when the account holds no connection of the incoming one', () => {
    const table = new StreamLimits();
    table.tryAcquire({ transport: 'ws', accountId: 'a', ip: '1.1.1.1' });
    table.tryAcquire({ transport: 'ws', accountId: 'a', ip: '1.1.1.1' });
    const sse = table.tryAcquire({ transport: 'sse', accountId: 'a', ip: '1.1.1.1' });
    expect(sse.ok).toBe(true);
    if (sse.ok) expect(sse.evict).toBeUndefined();
    expect(table.stats().byTransport).toEqual({ sse: 1, ws: 2 });
  });

  it('refuses at TOTAL_SLOTS and at PER_IP, and release is idempotent', () => {
    const table = new StreamLimits({ totalSlots: 2, perIp: 1 });
    const a = table.tryAcquire({ transport: 'sse', ip: '9.9.9.9' });
    expect(a.ok).toBe(true);
    expect(table.tryAcquire({ transport: 'sse', ip: '9.9.9.9' })).toEqual({ ok: false, reason: 'PER_IP' });
    expect(table.tryAcquire({ transport: 'sse', ip: '9.9.9.8' }).ok).toBe(true);
    expect(table.tryAcquire({ transport: 'sse', ip: '9.9.9.7' })).toEqual({ ok: false, reason: 'TOTAL' });

    if (a.ok) {
      table.release(a.slot);
      table.release(a.slot);
    }
    expect(table.stats().total).toBe(1);
  });

  it('trusted egress CIDRs are exempt from PER_IP (IPv4-mapped IPv6 included)', () => {
    const table = new StreamLimits({ perIp: 1, trustedCidrs: ['10.0.0.0/8'] });
    expect(table.tryAcquire({ transport: 'sse', ip: '10.1.2.3' }).ok).toBe(true);
    expect(table.tryAcquire({ transport: 'sse', ip: '::ffff:10.1.2.3' }).ok).toBe(true);
    expect(table.tryAcquire({ transport: 'sse', ip: '10.200.0.1' }).ok).toBe(true);
    expect(table.tryAcquire({ transport: 'sse', ip: '11.0.0.1' }).ok).toBe(true);
    expect(table.tryAcquire({ transport: 'sse', ip: '11.0.0.1' })).toEqual({ ok: false, reason: 'PER_IP' });
  });
});
