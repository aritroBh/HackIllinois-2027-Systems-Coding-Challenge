/**
 * In-process load harness — 5,000 concurrent volunteers.
 *
 * Runs with NODE_ENV=test so the per-IP limiter uses its 10,000/min branch,
 * which is the only way to exercise the engine rather than the throttle
 * (a live server cannot do this: index.ts skips bootstrap() when NODE_ENV=test).
 *
 *   npm run bench:load
 */
import http from 'http';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { app } from '../../src/app';

const USERS = +(process.env.USERS || 5000);
const SHIFTS = +(process.env.SHIFTS || 50);
const CAP = +(process.env.CAP || 20);
const CONC = +(process.env.CONC || 250);

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return (s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(0);
};
const hist = (r: { status: number }[]) =>
  r.reduce<Record<number, number>>((h, x) => ((h[x.status] = (h[x.status] || 0) + 1), h), {});

let base = '';
async function req(method: string, path: string, body?: unknown) {
  const t0 = performance.now();
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise<{ status: number; json: any; ms: number }>((resolve) => {
    const r = http.request(
      base + path,
      { method, headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(d); } catch {}
          resolve({ status: res.statusCode || 0, json: j, ms: performance.now() - t0 });
        });
      }
    );
    r.on('error', () => resolve({ status: 0, json: null, ms: performance.now() - t0 }));
    if (payload) r.write(payload);
    r.end();
  });
}
async function pool<T, R>(items: T[], fn: (t: T, i: number) => Promise<R>, limit: number): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]!, k); }
    })
  );
  return out;
}

(async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await replSet.waitUntilRunning();
  await mongoose.connect(replSet.getUri());
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  console.log(`\n=== IN-PROCESS LOAD: ${USERS} users · ${SHIFTS} shifts × cap ${CAP} = ${SHIFTS * CAP} seats · ${CONC} in-flight ===`);

  const t0 = performance.now();
  const day = Date.now() + 400 * 24 * 3600e3;
  const shifts = await pool(
    Array.from({ length: SHIFTS }, (_, i) => i),
    (i) => req('POST', '/api/v1/shifts', {
      title: `Load ${i} ${t0 | 0}`, description: 'load fixture', category: 'FOOD', location: 'SIEBEL_ATRIUM',
      startTime: new Date(day + i * 3 * 3600e3).toISOString(),
      endTime: new Date(day + i * 3 * 3600e3 + 3600e3).toISOString(), capacity: CAP,
    }), 40);
  const shiftIds = shifts.filter((s) => s.status === 201).map((s) => s.json.data._id);

  const vols = await pool(Array.from({ length: USERS }, (_, i) => i),
    (i) => req('POST', '/api/v1/volunteers', { name: `Load User ${i}`, email: `l_${i}_${t0 | 0}@x.edu` }), CONC);
  const volIds = vols.filter((v) => v.status === 201).map((v) => v.json.data._id);
  console.log(`setup: ${shiftIds.length} shifts, ${volIds.length}/${USERS} volunteers in ${((performance.now() - t0) / 1000).toFixed(1)}s  ${JSON.stringify(hist(vols))}`);

  console.log(`\n--- burst: every user does GET /shifts + POST /registrations + GET /shifts/:id ---`);
  const t1 = performance.now();
  const res = await pool(volIds, async (vid, k) => ({
    a: await req('GET', '/api/v1/shifts?limit=20'),
    b: await req('POST', '/api/v1/registrations', { shiftId: shiftIds[k % shiftIds.length], volunteerId: vid }),
    c: await req('GET', `/api/v1/shifts/${shiftIds[k % shiftIds.length]}`),
  }), CONC);
  const wall = (performance.now() - t1) / 1000;
  const reads = res.flatMap((r) => [r.a, r.c]);
  const writes = res.map((r) => r.b);

  console.log(`wall ${wall.toFixed(1)}s · ${((reads.length + writes.length) / wall).toFixed(0)} req/s`);
  console.log(`reads   p50 ${pct(reads.map((r) => r.ms), .5)}ms  p95 ${pct(reads.map((r) => r.ms), .95)}ms  p99 ${pct(reads.map((r) => r.ms), .99)}ms  ${JSON.stringify(hist(reads))}`);
  console.log(`writes  p50 ${pct(writes.map((r) => r.ms), .5)}ms  p95 ${pct(writes.map((r) => r.ms), .95)}ms  p99 ${pct(writes.map((r) => r.ms), .99)}ms  ${JSON.stringify(hist(writes))}`);
  const confirmed = writes.filter((w) => w.json?.status === 'CONFIRMED').length;
  const waitlisted = writes.filter((w) => w.json?.status === 'WAITLISTED').length;
  console.log(`outcomes: confirmed ${confirmed} (seats ${shiftIds.length * CAP}) · waitlisted ${waitlisted} · other ${writes.length - confirmed - waitlisted}`);

  // The limiter's window must drain before auditing, or the audit's own reads 429.
  console.log(`\n--- invariant audit across ${shiftIds.length} shifts (waiting out the rate-limit window) ---`);
  const getOk = async (path: string) => {
    for (let i = 0; i < 90; i++) {
      const r = await req('GET', path);
      if (r.status === 200) return r.json?.data;
      await new Promise((res) => setTimeout(res, 1000));
    }
    return null;
  };
  let breaches = 0, audited = 0;
  for (const sid of shiftIds) {
    const s = await getOk(`/api/v1/shifts/${sid}`);
    const rows = (await getOk(`/api/v1/registrations?shiftId=${sid}&status=CONFIRMED`)) || [];
    const wl = (await getOk(`/api/v1/registrations?shiftId=${sid}&status=WAITLISTED`)) || [];
    if (!s) continue;
    audited++;
    const pos = (wl as any[]).map((r: any) => r.waitlistPosition);
    if (s.filledSlots > s.capacity || s.filledSlots !== (rows as any[]).length || pos.length !== new Set(pos).size) {
      breaches++;
      console.log(`  BREACH ${sid}: filled=${s.filledSlots}/${s.capacity} rows=${(rows as any[]).length} wl=${(wl as any[]).length} dupPos=${pos.length !== new Set(pos).size}`);
    }
  }
  console.log(`  audited ${audited}/${shiftIds.length} shifts`);
  console.log(breaches === 0
    ? `  0 breaches: no overbooking, filledSlots == confirmed rows, waitlist positions unique`
    : `  ${breaches} shift(s) breached`);

  server.close();
  await mongoose.disconnect();
  await replSet.stop();
  process.exit(0);
})();
