/**
 * Presence, avatars and delegated actions (plan M4).
 *
 * The protocol and store are exercised directly; the transport is exercised through a real
 * `http.Server` with a real `ws` client, because the parts most likely to break — the
 * upgrade's cookie and CSRF checks — do not exist at all in a mocked socket.
 */
import http from 'http';
import { uniqueKey } from './helpers/uniqueKey';
import crypto from 'crypto';
import { AddressInfo } from 'net';
import request from 'supertest';
import { WebSocket } from 'ws';
import { PNG } from 'pngjs';
import { app } from '../src/app';
import { env } from '../src/config/env';
import { createServer } from '../src/server';
import { Volunteer, VolunteerRole, AccountKind } from '../src/models/volunteer.model';
import { Shift, ShiftCategory } from '../src/models/shift.model';
import { Registration, RegistrationStatus } from '../src/models/registration.model';
import { PresenceAudit } from '../src/models/presenceAudit.model';
import { Avatar, AvatarStatus } from '../src/models/avatar.model';
import { PresenceStore } from '../src/presence/store';
import { presenceStore } from '../src/presence/store';
import { presenceService } from '../src/presence/service';
import { wsClientCount } from '../src/presence/wsTransport';
import { encodeRows, decodeRows, IdxTable, IDX_WRAP } from '../src/presence/protocol';
import { __resetAvatarRate } from '../src/services/avatar.service';
import { pack, toLocal } from '../src/content/loader';
import { cookieNames } from '../src/common/utils/sessionToken';

const QUAD = pack.event.campus.origin as [number, number];

function csrfFrom(res: request.Response): string {
  const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const raw = setCookie.find((c) => c.startsWith(`${cookieNames().csrf}=`));
  if (!raw) throw new Error('no csrf cookie');
  return decodeURIComponent(raw.split(';')[0].split('=')[1]);
}
function cookieHeaderFrom(res: request.Response): string {
  const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function makeAccount(over: Partial<{ name: string; role: VolunteerRole; kind: AccountKind; optIn: boolean }> = {}) {
  return Volunteer.create({
    name: over.name ?? `P ${Math.random().toString(36).slice(2, 7)}`,
    email: over.kind === AccountKind.HACKER ? null : `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind: over.kind ?? AccountKind.VOLUNTEER,
    role: over.role ?? (over.kind === AccountKind.HACKER ? VolunteerRole.HACKER : VolunteerRole.VOLUNTEER),
    presenceOptIn: over.optIn ?? true,
  });
}

async function signIn(accountId: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/dev-login').send({ accountId });
  expect(res.status).toBe(200);
  return { agent, csrf: csrfFrom(res), cookie: cookieHeaderFrom(res) };
}

/** Offset from the Quad by metres, as a lat/lng. */
function at(metresEast: number, metresSouth: number): { lat: number; lng: number } {
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((QUAD[0] * Math.PI) / 180);
  return { lat: QUAD[0] - metresSouth / mPerLat, lng: QUAD[1] + metresEast / mPerLng };
}

const facts = (id: string, over: Partial<{ kind: 'VOLUNTEER' | 'HACKER'; role: string; onDuty: boolean; optIn: boolean; faction: string | null }> = {}) => ({
  id, name: `n-${id.slice(-4)}`, kind: over.kind ?? ('VOLUNTEER' as const), role: over.role ?? 'VOLUNTEER',
  faction: over.faction ?? 'KERNEL', avatarHash: null, optIn: over.optIn ?? true, onDuty: over.onDuty ?? true,
});

describe('presence protocol', () => {
  it('binary rows round-trip within the 0.2 m quantum and carry faction, stale and kind', () => {
    const rows = [
      { idx: 1, x: 12.5, z: -7.25, h: 90, faction: 3, stale: false, kind: 0 as const },
      { idx: 65000, x: -300.4, z: 288.6, h: 359, faction: 7, stale: true, kind: 1 as const },
    ];
    const back = decodeRows(encodeRows(1, 42, rows, 10), 10);
    expect(back.kind).toBe(1);
    expect(back.tick).toBe(42);
    expect(back.rows).toHaveLength(2);
    for (let i = 0; i < rows.length; i++) {
      expect(back.rows[i].idx).toBe(rows[i].idx);
      expect(back.rows[i].x * 10).toBeCloseTo(rows[i].x * 10, 0.6);
      expect(back.rows[i].z * 10).toBeCloseTo(rows[i].z * 10, 0.6);
      expect(back.rows[i].faction).toBe(rows[i].faction);
      expect(back.rows[i].stale).toBe(rows[i].stale);
      expect(back.rows[i].kind).toBe(rows[i].kind);
      expect(Math.abs(back.rows[i].h - rows[i].h)).toBeLessThan(2);
    }
    // 8 bytes a row plus the 7-byte header: the budget the interest cut is sized against.
    expect(encodeRows(1, 0, rows, 10).byteLength).toBe(7 + 2 * 8);
  });

  it('the whole campus fits the i16 row: every bbox corner is inside ±6.5 km of the origin', () => {
    const [s, w, n, e] = pack.event.campus.bbox;
    for (const [lat, lng] of [[s, w], [s, e], [n, w], [n, e]] as Array<[number, number]>) {
      const { x, z } = toLocal(lat, lng);
      const metres = Math.hypot(x, z) * pack.event.campus.metersPerUnit;
      expect(metres).toBeLessThan(6500);
    }
  });

  it('slot ids are per-connection, monotonic, and a wrap forces a full snapshot', () => {
    const t = new IdxTable();
    const [a, aNew] = t.assign('alpha', 1);
    const [b] = t.assign('beta', 1);
    expect([a, b, aNew]).toEqual([1, 2, true]);
    expect(t.assign('alpha', 2)).toEqual([1, false]);
    expect(t.idOf(2)).toBe('beta');
    t.release('alpha', 3);
    expect(t.get('alpha')).toBeUndefined();
    // A released id is not handed straight back out.
    const [c] = t.assign('gamma', 4);
    expect(c).toBe(3);
  });

  it('a wrap clears the table and demands a full snapshot, so no slot is ever mis-bound', () => {
    const t = new IdxTable();
    t.needsFullSnapshot = false;
    // Walk the counter to the wrap point. Every assignment is a distinct player.
    for (let i = 1; i < IDX_WRAP; i++) t.assign(`p${i}`, 1);
    expect(t.size()).toBe(IDX_WRAP - 1);
    const [idx, isNew] = t.assign('after-the-wrap', 2);
    expect(idx).toBe(1);          // counter restarted
    expect(isNew).toBe(true);
    expect(t.size()).toBe(1);     // everything else was forgotten
    // The client must be told to rebind, or it would draw the previous holder of slot 1.
    expect(t.needsFullSnapshot).toBe(true);
  });
});

describe('presence store gates', () => {
  let store: PresenceStore;
  beforeEach(() => {
    store = new PresenceStore();
  });

  it('accepts a good sample and publishes a fuzzed position, never the exact one', () => {
    const p = at(20, 30);
    const r = store.update(facts('a'.repeat(24)), { lat: p.lat, lng: p.lng, acc: 8 });
    expect(r.ok).toBe(true);
    const e = store.get('a'.repeat(24))!;
    expect(e.lat).toBeCloseTo(p.lat, 6);
    // The published point is snapped to a 20 m grid and jittered; it is never the raw fix.
    const offMetres = Math.hypot(e.fx - e.x, e.fz - e.z) * store.cfg.metersPerUnit;
    expect(offMetres).toBeGreaterThan(0);
    expect(offMetres).toBeLessThan(40);
  });

  it('drops an inaccurate sample without a strike, and refuses one off campus or opted out', () => {
    const id = 'b'.repeat(24);
    const p = at(0, 0);
    expect(store.update(facts(id), { lat: p.lat, lng: p.lng, acc: 120 })).toEqual({ ok: false, reason: 'INACCURATE' });
    expect(store.update(facts(id), { lat: 41.88, lng: -87.63, acc: 5 })).toEqual({ ok: false, reason: 'OFF_CAMPUS' });
    expect(store.update(facts(id, { optIn: false }), { lat: p.lat, lng: p.lng, acc: 5 })).toEqual({ ok: false, reason: 'OPT_OUT' });
    // None of those created an entry, so nothing was "counted" against the sender.
    expect(store.get(id)).toBeUndefined();
  });

  it('rate-limits to one sample per two seconds and mutes after three consecutive speed violations', async () => {
    const id = 'c'.repeat(24);
    const t0 = Date.now();
    const start = at(0, 0);
    expect(store.update(facts(id), { lat: start.lat, lng: start.lng, acc: 5 }, t0).ok).toBe(true);
    expect(store.update(facts(id), { lat: start.lat, lng: start.lng, acc: 5 }, t0 + 500)).toEqual({ ok: false, reason: 'RATE' });

    // 500 m in 2 s is 250 m/s — far past the 15 m/s gate.
    let far = at(500, 0);
    expect(store.update(facts(id), { lat: far.lat, lng: far.lng, acc: 5 }, t0 + 2100)).toEqual({ ok: false, reason: 'TOO_FAST' });
    far = at(1000, 0);
    expect(store.update(facts(id), { lat: far.lat, lng: far.lng, acc: 5 }, t0 + 4200)).toEqual({ ok: false, reason: 'TOO_FAST' });
    far = at(1500, 0);
    expect(store.update(facts(id), { lat: far.lat, lng: far.lng, acc: 5 }, t0 + 6300)).toEqual({ ok: false, reason: 'SPEED_STRIKE' });
    // The mute is what stops the next one, and it outlives the store.
    expect(store.update(facts(id), { lat: start.lat, lng: start.lng, acc: 5 }, t0 + 8400)).toEqual({ ok: false, reason: 'MUTED' });
  });

  it('a walking pace is never mistaken for spoofing', () => {
    const id = 'd'.repeat(24);
    const t0 = Date.now();
    let ok = 0;
    for (let i = 0; i < 6; i++) {
      const p = at(i * 5, 0); // 5 m every 3 s ≈ 1.7 m/s
      if (store.update(facts(id), { lat: p.lat, lng: p.lng, acc: 10 }, t0 + i * 3000).ok) ok += 1;
    }
    expect(ok).toBe(6);
  });

  it('the published position lags one tick, and an entry expires when its sender goes quiet', () => {
    const id = 'e'.repeat(24);
    const t0 = Date.now();
    const a = at(0, 0);
    store.update(facts(id), { lat: a.lat, lng: a.lng, acc: 5 }, t0);
    const first = { fx: store.get(id)!.fx, fz: store.get(id)!.fz };
    const b = at(30, 0); // 30 m over 5 s is about 6 m/s: a jog, well inside the speed gate
    expect(store.update(facts(id), { lat: b.lat, lng: b.lng, acc: 5 }, t0 + 5000).ok).toBe(true);
    // Still the old published point: movement is visible only after the next tick.
    expect(store.get(id)!.fx).toBeCloseTo(first.fx, 6);
    store.tick(t0 + 5100);
    expect(store.get(id)!.fx).not.toBeCloseTo(first.fx, 6);

    const { expired } = store.tick(t0 + 5100 + store.cfg.expireAfterMs + 1);
    expect(expired).toContain(id);
    expect(store.get(id)).toBeUndefined();
  });

  it('an off-shift volunteer is hidden from peers but visible to a lead; a hacker is always visible', () => {
    const offDuty = 'f'.repeat(24);
    const hacker = '9'.repeat(24);
    const p = at(10, 10);
    store.update(facts(offDuty, { onDuty: false }), { lat: p.lat, lng: p.lng, acc: 5 });
    store.update(facts(hacker, { kind: 'HACKER', role: 'HACKER' }), { lat: p.lat, lng: p.lng, acc: 5 });
    expect(store.visible(store.get(offDuty)!, false)).toBe(false);
    expect(store.visible(store.get(offDuty)!, true)).toBe(true);
    expect(store.visible(store.get(hacker)!, false)).toBe(true);
  });

  it('near() finds only what is inside the radius, and clusters count the rest', () => {
    const centre = at(0, 0);
    const ids = ['1', '2', '3'].map((n) => n.repeat(24));
    store.update(facts(ids[0]), { ...at(0, 0), acc: 5 } as never);
    store.update(facts(ids[1]), { ...at(50, 0), acc: 5 } as never);
    store.update(facts(ids[2]), { ...at(900, 0), acc: 5 } as never);
    const me = toLocal(centre.lat, centre.lng);
    const near = store.near(me.x, me.z, 300);
    const foundIds = near.map((n) => n.e.id);
    expect(foundIds).toEqual(expect.arrayContaining([ids[0], ids[1]]));
    expect(foundIds).not.toContain(ids[2]);
    const clusters = store.clusters(me.x, me.z, 300, new Set([ids[0]]));
    expect(clusters.reduce((s, c) => s + c[2], 0)).toBe(1); // only ids[1] remains uncounted
  });
});

describe('presence HTTP mirror and privacy', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required'; });
  afterAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original; });
  beforeEach(() => presenceStore.clear());

  it('a sample is accepted only after opting in, and opting out erases the position', async () => {
    const vol = await makeAccount({ optIn: false });
    const { agent, csrf } = await signIn(vol.id);
    const p = at(15, 15);

    const refused = await agent.post('/api/v1/presence').set('X-CSRF-Token', csrf).send({ lat: p.lat, lng: p.lng, acc: 9 });
    expect(refused.status).toBe(403);

    const on = await agent.patch('/api/v1/me/presence').set('X-CSRF-Token', csrf).send({ optIn: true });
    expect(on.body.data.presenceOptIn).toBe(true);

    const accepted = await agent.post('/api/v1/presence').set('X-CSRF-Token', csrf).send({ lat: p.lat, lng: p.lng, acc: 9 });
    expect(accepted.status).toBe(202);
    expect(accepted.body.data.accepted).toBe(true);
    expect(presenceStore.get(vol.id)).toBeDefined();

    const off = await agent.patch('/api/v1/me/presence').set('X-CSRF-Token', csrf).send({ optIn: false });
    expect(off.body.data.presenceOptIn).toBe(false);
    expect(presenceStore.get(vol.id)).toBeUndefined();
  });

  it('GET /presence is lead-only, audited once per call, and rate-bound to one call per five seconds', async () => {
    const vol = await makeAccount();
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const { agent: v, csrf: vCsrf } = await signIn(vol.id);
    const { agent: l } = await signIn(lead.id);
    const p = at(25, 25);
    await v.post('/api/v1/presence').set('X-CSRF-Token', vCsrf).send({ lat: p.lat, lng: p.lng, acc: 7 });

    expect((await v.get('/api/v1/presence')).status).toBe(403);

    await PresenceAudit.deleteMany({});
    const list = await l.get('/api/v1/presence');
    expect(list.status).toBe(200);
    expect(list.body.data.count).toBeGreaterThanOrEqual(1);
    expect(list.headers['cache-control']).toBe('no-store');
    // Exactly one audit document for the call, not one per subject.
    const audits = await PresenceAudit.find({ reason: 'presence-list' });
    expect(audits).toHaveLength(1);
    expect(audits[0].subjectCount).toBe(list.body.data.count);

    expect((await l.get('/api/v1/presence')).status).toBe(429);
  });
});

describe('SOS dispatch prefers a live position', () => {
  beforeEach(() => presenceStore.clear());

  it('ranks a live fix above a venue estimate and audits the read once', async () => {
    const near = await makeAccount({ name: 'Near Nan' });
    const far = await makeAccount({ name: 'Far Fay' });
    const shift = await Shift.create({
      title: 'Dispatch pool', description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() - 3600_000), endTime: new Date(Date.now() + 3600_000), capacity: 5, baseKarma: 10,
    });
    await Registration.create([
      { shiftId: shift._id, volunteerId: near._id, status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('d1') },
      { shiftId: shift._id, volunteerId: far._id, status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('d2') },
    ]);

    // The ticket is at the Quad; "Near Nan" is standing 20 m away, "Far Fay" has no fix.
    const ticketAt = at(0, 0);
    const nanAt = at(20, 0);
    presenceStore.update(facts(String(near._id)), { lat: nanAt.lat, lng: nanAt.lng, acc: 6 });

    await PresenceAudit.deleteMany({});
    // Raising a ticket is a request to share your location with responders, so it is bound
    // to an account: there is nobody to send help to, and nobody to bill the bounty against,
    // if the caller is anonymous.
    const sam = await makeAccount({ name: 'Stuck Sam', kind: AccountKind.HACKER, role: VolunteerRole.HACKER });
    const samSession = await signIn(sam.id);
    const created = await samSession.agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', samSession.csrf).send({
      hackerName: 'Stuck Sam', tableLocation: 'Table 4', description: 'Need a hand', urgency: 'HIGH',
      coordinates: { latitude: ticketAt.lat, longitude: ticketAt.lng },
    });
    expect(created.status).toBe(201);

    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const { agent: l, csrf } = await signIn(lead.id);
    const res = await l.post(`/api/v1/sos/tickets/${created.body.data._id}/dispatch`).set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.dispatchedVolunteer.name).toBe('Near Nan');
    expect(res.body.data.positionSource).toBe('live');
    expect(res.body.data.positionAgeMs).toBeLessThan(30_000);
    // A lead sees everyone considered, including the one with no live location, and an
    // exact distance — they can already read exact positions through the audited listing.
    const fay = res.body.data.candidates.find((c: { name: string }) => c.name === 'Far Fay');
    expect(fay.positionSource).toBe('venue');
    expect(res.body.data.distanceMeters % 10).not.toBe(0); // exact, not bucketed
    // One audit document for the whole dispatch.
    const audits = await PresenceAudit.find({ reason: 'dispatch' });
    expect(audits).toHaveLength(1);
    expect(audits[0].winnerId).toBe(String(near._id));
    expect(audits[0].candidatesScanned).toBeGreaterThanOrEqual(2);
  });

  it('an ordinary caller gets a bucketed distance and no candidate list, so dispatch is not a ranging oracle', async () => {
    const responder = await makeAccount({ name: 'Rae' });
    const shift = await Shift.create({
      title: 'Oracle pool', description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() - 3600_000), endTime: new Date(Date.now() + 3600_000), capacity: 5, baseKarma: 10,
    });
    await Registration.create({ shiftId: shift._id, volunteerId: responder._id, status: RegistrationStatus.CHECKED_IN, idempotencyKey: uniqueKey('o1') });
    const ticketAt = at(0, 0);
    const raeAt = at(37, 0); // a distance that is obviously not a multiple of ten
    presenceStore.update(facts(String(responder._id)), { lat: raeAt.lat, lng: raeAt.lng, acc: 6 });

    const sam = await makeAccount({ name: 'Sam', kind: AccountKind.HACKER, role: VolunteerRole.HACKER });
    const samSession = await signIn(sam.id);
    const created = await samSession.agent.post('/api/v1/sos/tickets').set('X-CSRF-Token', samSession.csrf).send({
      hackerName: 'Sam', tableLocation: 'T1', description: 'help', urgency: 'HIGH',
      coordinates: { latitude: ticketAt.lat, longitude: ticketAt.lng },
    });
    expect(created.status).toBe(201);
    const volunteer = await makeAccount();
    const { agent: v, csrf } = await signIn(volunteer.id);
    const res = await v.post(`/api/v1/sos/tickets/${created.body.data._id}/dispatch`).set('X-CSRF-Token', csrf).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.candidates).toEqual([]);
    expect(res.body.data.distanceMeters % 10).toBe(0);
  });
});

describe('avatars', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required'; });
  afterAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original; });
  beforeEach(() => __resetAvatarRate());

  /** A sheet carrying a tEXt chunk, so the re-encode has something to strip. */
  function sheetWithText(keyword: string, text: string): Buffer {
    const base = sheet();
    const chunk = Buffer.from(`${keyword}\0${text}`, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(chunk.length);
    const type = Buffer.from('tEXt');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([type, chunk])) >>> 0);
    const iendAt = base.length - 12; // IEND is the final 12 bytes
    return Buffer.concat([base.subarray(0, iendAt), len, type, chunk, crcBuf, base.subarray(iendAt)]);
  }

  function crc32(buf: Buffer): number {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c;
  }

  function sheet(width = 128, height = 48, tint = 200): Buffer {
    const png = new PNG({ width, height });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = tint; png.data[i + 1] = 90; png.data[i + 2] = 40; png.data[i + 3] = 255;
    }
    return PNG.sync.write(png);
  }

  it('re-encodes the upload, so appended junk cannot survive and the hash is of the pixels', async () => {
    const vol = await makeAccount();
    const { agent, csrf } = await signIn(vol.id);
    // A sheet carrying a metadata chunk, and a polyglot with an archive glued past IEND.
    const withMeta = sheetWithText('Comment', 'phone-home: http://evil.example/x');
    const polyglot = Buffer.concat([sheet(), Buffer.from('PK not really a zip')]);

    const a = await agent.post('/api/v1/avatars').set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(withMeta);
    const b = await agent.post('/api/v1/avatars').set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(polyglot);
    expect(a.status).toBe(201);
    // Bytes past IEND are refused outright rather than trimmed - stronger than sanitising.
    expect(b.status).toBe(400);

    const stored = await Avatar.findOne({ hash: a.body.data.hash });
    // The metadata chunk did not survive the re-encode, and the hash is of OUR bytes.
    expect(withMeta.includes(Buffer.from('phone-home'))).toBe(true);
    expect(stored!.bytes.includes(Buffer.from('phone-home'))).toBe(false);
    expect(stored!.bytes.includes(Buffer.from('Comment'))).toBe(false);
    expect(crypto.createHash('sha256').update(stored!.bytes).digest('hex')).toBe(a.body.data.hash);
    // The same pixels uploaded again deduplicate to the same document.
    const again = await agent.post('/api/v1/avatars').set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(sheet());
    expect(again.body.data.hash).toBe(a.body.data.hash);
  });

  it('refuses a non-PNG and an unsupported size', async () => {
    const vol = await makeAccount();
    const { agent, csrf } = await signIn(vol.id);
    const bad = await agent.post('/api/v1/avatars').set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(Buffer.from('definitely not a png'));
    expect(bad.status).toBe(400);
    const wrongSize = await agent.post('/api/v1/avatars').set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').send(sheet(64, 64));
    expect(wrongSize.status).toBe(400);
  });

  it('is private until approved: the owner and a lead can fetch it, another player cannot', async () => {
    const owner = await makeAccount();
    const other = await makeAccount();
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const { agent: o, csrf: oCsrf } = await signIn(owner.id);
    const { agent: p } = await signIn(other.id);
    const { agent: l, csrf: lCsrf } = await signIn(lead.id);

    const up = await o.post('/api/v1/avatars?share=1').set('X-CSRF-Token', oCsrf).set('Content-Type', 'image/png').send(sheet(128, 48, 111));
    const hash = up.body.data.hash;
    expect(up.body.data.status).toBe(AvatarStatus.PENDING);

    expect((await o.get(`/api/v1/avatars/${hash}`)).status).toBe(200);
    expect((await l.get(`/api/v1/avatars/${hash}`)).status).toBe(200);
    expect((await p.get(`/api/v1/avatars/${hash}`)).status).toBe(404);

    const queue = await l.get('/api/v1/avatars/queue');
    expect(queue.body.data.some((r: { hash: string }) => r.hash === hash)).toBe(true);

    await l.post(`/api/v1/avatars/${hash}/review`).set('X-CSRF-Token', lCsrf).send({ approve: true });
    const now = await p.get(`/api/v1/avatars/${hash}`);
    expect(now.status).toBe(200);
    expect(now.headers['content-type']).toContain('image/png');
    expect(now.headers['cache-control']).toBe('private, max-age=60, must-revalidate');
    expect(now.headers.etag).toBeTruthy();
  });

  it('three distinct reporters unpublish it, and so does one lead on its own', async () => {
    const owner = await makeAccount();
    const { agent: o, csrf: oCsrf } = await signIn(owner.id);
    const up = await o.post('/api/v1/avatars?share=1').set('X-CSRF-Token', oCsrf).set('Content-Type', 'image/png').send(sheet(128, 48, 77));
    const hash = up.body.data.hash;
    await Avatar.updateOne({ hash }, { $set: { status: AvatarStatus.APPROVED } });
    await Volunteer.updateOne({ _id: owner._id }, { $set: { avatarHash: hash } });

    for (let i = 0; i < 2; i++) {
      const reporter = await makeAccount();
      const { agent, csrf } = await signIn(reporter.id);
      const r = await agent.post(`/api/v1/avatars/${hash}/flag`).set('X-CSRF-Token', csrf).send({ reason: 'rude' });
      expect(r.body.data.unpublished).toBe(false);
    }
    const third = await makeAccount();
    const { agent: t, csrf: tCsrf } = await signIn(third.id);
    const done = await t.post(`/api/v1/avatars/${hash}/flag`).set('X-CSRF-Token', tCsrf).send({ reason: 'rude' });
    expect(done.body.data.unpublished).toBe(true);
    // The takedown clears the hash off the account, so the presence wire stops carrying it.
    expect((await Volunteer.findById(owner._id))!.avatarHash).toBeNull();

    // A lead needs no corroboration.
    const owner2 = await makeAccount();
    const { agent: o2, csrf: o2Csrf } = await signIn(owner2.id);
    const up2 = await o2.post('/api/v1/avatars?share=1').set('X-CSRF-Token', o2Csrf).set('Content-Type', 'image/png').send(sheet(128, 48, 33));
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const { agent: l, csrf: lCsrf } = await signIn(lead.id);
    const byLead = await l.post(`/api/v1/avatars/${up2.body.data.hash}/flag`).set('X-CSRF-Token', lCsrf).send({ reason: 'policy' });
    expect(byLead.body.data.unpublished).toBe(true);
  });
});

describe('act-on-behalf is narrow', () => {
  const original = env.AUTH_MODE;
  beforeAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required'; });
  afterAll(() => { (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original; });

  async function openShift(title: string) {
    return Shift.create({
      title, description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() + 3600_000), endTime: new Date(Date.now() + 7200_000), capacity: 4, baseKarma: 10,
    });
  }

  it('a lead registers the named volunteer; a plain volunteer naming someone else still registers themselves', async () => {
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const subject = await makeAccount({ name: 'Signed Up Sam' });
    const sneak = await makeAccount();
    const shift = await openShift('Delegation desk');

    const { agent: l, csrf: lCsrf } = await signIn(lead.id);
    const asLead = await l.post('/api/v1/registrations').set('X-CSRF-Token', lCsrf)
      .set('Idempotency-Key', uniqueKey('deleg'))
      .send({ shiftId: shift.id, onBehalfVolunteerId: subject.id });
    if (asLead.status !== 201) console.log('DELEG FAIL', asLead.status, JSON.stringify(asLead.body));
    expect(asLead.status).toBe(201);
    expect(String(asLead.body.data.volunteerId)).toBe(subject.id);

    const { agent: s, csrf: sCsrf } = await signIn(sneak.id);
    const asVolunteer = await s.post('/api/v1/registrations').set('X-CSRF-Token', sCsrf)
      .set('Idempotency-Key', uniqueKey('sneak'))
      .send({ shiftId: shift.id, onBehalfVolunteerId: subject.id });
    expect(asVolunteer.status).toBe(201);
    // The delegation field is ignored for a non-lead: they registered themselves.
    expect(String(asVolunteer.body.data.volunteerId)).toBe(sneak.id);

    // And the ordinary `volunteerId` slot is still refused outright for a non-lead session.
    const named = await s.post('/api/v1/registrations').set('X-CSRF-Token', sCsrf)
      .set('Idempotency-Key', uniqueKey('named'))
      .send({ shiftId: shift.id, volunteerId: subject.id });
    expect(named.status).toBe(403);
    expect(named.body.error).toBe('IDENTITY_MISMATCH');
  });

  it('a lead cannot use it to act as someone on spins, SOS resolution, check-out or gyms', async () => {
    const lead = await makeAccount({ role: VolunteerRole.SHIFT_LEAD });
    const victim = await makeAccount({ name: 'Victim Vee' });
    const { agent, csrf } = await signIn(lead.id);

    // Every one of these routes resolves the actor from the session only. Naming the victim
    // must never make the server act as them — the reason delegation is not in resolveActorId.
    const spin = await agent.post('/api/v1/pokeshift/hackstops/UNION_COURTYARD/spin').set('X-CSRF-Token', csrf)
      .send({ onBehalfVolunteerId: victim.id, volunteerId: victim.id, coordinates: { latitude: 40.1099, longitude: -88.2272 } });
    // Whatever the outcome (geofence, cooldown), it is never an action taken as the victim.
    if (spin.status === 200) expect(String(spin.body.data.volunteerId ?? lead.id)).not.toBe(victim.id);

    // The real path (`POST /attendance/:id/checkout`); the earlier probe pointed at a route
    // that does not exist, so it passed on a 404 without testing anything.
    const shift = await Shift.create({
      title: 'Checkout probe', description: 'x', category: ShiftCategory.LOGISTICS, location: 'Siebel Center Atrium',
      startTime: new Date(Date.now() - 3600_000), endTime: new Date(Date.now() + 3600_000), capacity: 3, baseKarma: 10,
    });
    const victimReg = await Registration.create({
      shiftId: shift._id, volunteerId: victim._id, status: RegistrationStatus.CHECKED_IN,
      idempotencyKey: uniqueKey('victim'), checkInTime: new Date(Date.now() - 1800_000),
    });
    const before = (await Volunteer.findById(victim._id))!.karmaPoints;
    const checkout = await agent.post(`/api/v1/attendance/${victimReg.id}/checkout`).set('X-CSRF-Token', csrf)
      .send({ onBehalfVolunteerId: victim.id, volunteerId: victim.id });
    // Whatever the status, the lead must not have closed the victim's shift and banked
    // their karma: that is the delegation-as-impersonation case.
    expect((await Volunteer.findById(victim._id))!.karmaPoints).toBe(before);
    expect((await Registration.findById(victimReg.id))!.status).toBe(RegistrationStatus.CHECKED_IN);
    expect(checkout.status).not.toBe(200);
  });
});

describe('presence WebSocket transport', () => {
  let server: http.Server;
  let url = '';
  const original = env.AUTH_MODE;

  beforeAll(async () => {
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = 'required';
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/ws/presence`;
  });
  afterAll(async () => {
    (env as { AUTH_MODE: 'legacy' | 'required' }).AUTH_MODE = original;
    presenceService.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function open(headers: Record<string, string>, protocols?: string | string[]): Promise<{ ws?: WebSocket; error?: string; status?: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, protocols, { headers });
      const done = (r: { ws?: WebSocket; error?: string; status?: number }) => { resolve(r); };
      ws.on('open', () => done({ ws }));
      ws.on('unexpected-response', (_req, res) => { ws.terminate(); done({ status: res.statusCode }); });
      ws.on('error', (err) => done({ error: err.message }));
    });
  }

  it('refuses an upgrade with no cookie, and one with a cookie but no CSRF subprotocol', async () => {
    const anon = await open({});
    expect(anon.status).toBe(401);

    const vol = await makeAccount();
    const { cookie } = await signIn(vol.id);
    const noNonce = await open({ cookie });
    expect(noNonce.status).toBe(403);

    const wrongNonce = await open({ cookie }, 'nexus.v1.not-the-nonce');
    expect(wrongNonce.status).toBe(403);
  });

  it('accepts cookie + nonce, answers hello with the frame parameters, and streams a snapshot', async () => {
    const vol = await makeAccount();
    const { cookie, csrf } = await signIn(vol.id);
    const { port } = server.address() as AddressInfo;
    const { ws, status, error } = await open({ cookie, origin: `http://127.0.0.1:${port}` }, `nexus.v1.${csrf}`);
    expect(error ?? status ?? 'open').toBe('open');
    const socket = ws!;

    const frames: Array<Record<string, unknown>> = [];
    socket.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(String(raw))); });
    socket.send(JSON.stringify({ t: 'hello', v: 1, enc: 'bin' }));

    await new Promise((r) => setTimeout(r, 300));
    const ack = frames.find((f) => f.t === 'hello_ack') as Record<string, unknown>;
    expect(ack).toBeDefined();
    expect(ack.enc).toBe('bin');
    expect(ack.metersPerUnit).toBe(pack.event.campus.metersPerUnit);
    expect(ack.interestM).toBe(pack.event.presence.interestRadiusMeters);
    expect(Array.isArray(ack.factions)).toBe(true);

    // A position, then a forced tick: the session must produce a snapshot for its sender.
    const p = at(5, 5);
    socket.send(JSON.stringify({ t: 'pos', lat: p.lat, lng: p.lng, acc: 8 }));
    await new Promise((r) => setTimeout(r, 200));
    presenceService.tickNow();
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.some((f) => f.t === 'snapshot' || f.t === 'delta')).toBe(true);
    socket.close();
  });

  it('a client that never says hello is closed with 4401', async () => {
    const vol = await makeAccount();
    const { cookie, csrf } = await signIn(vol.id);
    const { ws } = await open({ cookie }, `nexus.v1.${csrf}`);
    const closed = await new Promise<number>((resolve) => {
      ws!.on('close', (code) => resolve(code));
      setTimeout(() => resolve(0), 7000);
    });
    expect(closed).toBe(4401);
  }, 15000);

  it('more than five messages in two seconds closes the socket with 1008', async () => {
    const vol = await makeAccount();
    const { cookie, csrf } = await signIn(vol.id);
    const { ws } = await open({ cookie }, `nexus.v1.${csrf}`);
    const socket = ws!;
    const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
    for (let i = 0; i < 12; i++) socket.send(JSON.stringify({ t: 'hello', v: 1, enc: 'json' }));
    expect(await closed).toBe(1008);
  }, 15000);

  it('a third connection from one account closes the oldest socket, not just its slot accounting', async () => {
    const vol = await makeAccount();
    const { cookie, csrf } = await signIn(vol.id);
    const first = await open({ cookie }, `nexus.v1.${csrf}`);
    const second = await open({ cookie }, `nexus.v1.${csrf}`);
    expect(first.ws && second.ws).toBeTruthy();
    const firstClosed = new Promise<number>((resolve) => first.ws!.on('close', (code) => resolve(code)));

    const before = wsClientCount();
    const third = await open({ cookie }, `nexus.v1.${csrf}`);
    expect(third.ws).toBeTruthy();
    // The replaced socket is actually closed. Without this the process would hold three
    // live sockets while the slot table believed it held two.
    expect(await firstClosed).toBe(1013);
    await new Promise((r) => setTimeout(r, 100));
    expect(wsClientCount()).toBe(before);

    second.ws!.close();
    third.ws!.close();
  }, 15000);

  it('two clients see each other once both are publishing', async () => {
    presenceStore.clear();
    // Hackers, because an off-shift volunteer is deliberately invisible to peers — see the
    // visibility test above. Two hackers standing 30 m apart must see each other.
    const a = await makeAccount({ name: 'Ada', kind: AccountKind.HACKER });
    const b = await makeAccount({ name: 'Bo', kind: AccountKind.HACKER });
    const sa = await signIn(a.id);
    const sb = await signIn(b.id);
    const ca = await open({ cookie: sa.cookie }, `nexus.v1.${sa.csrf}`);
    const cb = await open({ cookie: sb.cookie }, `nexus.v1.${sb.csrf}`);
    expect(ca.ws && cb.ws).toBeTruthy();

    const joinsSeenByA: Array<{ id: string; name: string }> = [];
    ca.ws!.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const f = JSON.parse(String(raw));
      if (Array.isArray(f.j)) joinsSeenByA.push(...f.j);
    });
    for (const [c, who] of [[ca, a], [cb, b]] as const) {
      c.ws!.send(JSON.stringify({ t: 'hello', v: 1, enc: 'json' }));
      const p = at(who === a ? 0 : 30, 0);
      c.ws!.send(JSON.stringify({ t: 'pos', lat: p.lat, lng: p.lng, acc: 6 }));
    }
    await new Promise((r) => setTimeout(r, 300));
    presenceService.tickNow();
    await new Promise((r) => setTimeout(r, 300));
    presenceService.tickNow();
    await new Promise((r) => setTimeout(r, 300));

    expect(joinsSeenByA.some((j) => j.id === b.id && j.name === 'Bo')).toBe(true);
    ca.ws!.close();
    cb.ws!.close();
  });
});

afterAll(() => {
  // `tests/setup.ts` already truncates every collection after each test and disconnects
  // last, so this only has to drop the in-process state the store holds.
  presenceStore.clear();
  presenceService.stop();
});
