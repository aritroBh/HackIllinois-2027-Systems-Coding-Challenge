/**
 * SSE fan-out at scale: open N dashboard-style event streams, fire a mutation,
 * measure how many clients receive it and how long the slowest waits.
 * Then hammer mutations and check for dropped events / heap growth.
 *
 *   NODE_ENV=test CLIENTS=1000 npx tsx .gstack/qa-reports/sse-fanout.ts
 */
import http from 'http';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { app } from '../../src/app';

const CLIENTS = +(process.env.CLIENTS || 1000);
let base = '';
const post = (p: string, b: unknown) => new Promise<number>((res) => {
  const d = JSON.stringify(b); const r = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (rs) => { rs.resume(); rs.on('end', () => res(rs.statusCode || 0)); });
  r.on('error', () => res(0)); r.write(d); r.end();
});

(async () => {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await rs.waitUntilRunning(); await mongoose.connect(rs.getUri());
  const server = http.createServer(app).listen({ port: 0, backlog: +(process.env.BACKLOG || 511) }); await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;

  const received: number[][] = Array.from({ length: CLIENTS }, () => []);
  const connected: number[] = [];
  const rejected: number[] = [];
  const connErrors: Record<string, number> = {};
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  let open = 0;
  const t0 = performance.now();
  const RAMP = +(process.env.RAMP || 0); // clients per 100ms; 0 = all at once
  const connectOne = (i: number) => new Promise<void>((resolve) => {
    const r = http.get(base + '/api/v1/stats/events', { agent }, (res) => {
      if (res.statusCode !== 200) { rejected.push(res.statusCode || 0); res.resume(); return resolve(); }
      open++; connected.push(performance.now() - t0);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { for (const line of chunk.split('\n')) if (line.startsWith('event:')) received[i]!.push(performance.now()); });
      resolve();
    });
    r.on('error', (e: any) => { connErrors[e.code || 'ERR'] = (connErrors[e.code || 'ERR'] || 0) + 1; resolve(); });
  });
  if (RAMP > 0) { for (let i = 0; i < CLIENTS; i += RAMP) { await Promise.all(Array.from({ length: Math.min(RAMP, CLIENTS - i) }, (_, k) => connectOne(i + k))); await new Promise((r) => setTimeout(r, 100)); } }
  else await Promise.all(Array.from({ length: CLIENTS }, (_, i) => connectOne(i)));
  console.log(`\n=== SSE FAN-OUT: ${CLIENTS} clients ===`);
  console.log(`client-side connect errors: ${JSON.stringify(connErrors)}`);
  console.log(`connected ${open}/${CLIENTS} in ${(performance.now() - t0).toFixed(0)}ms · rejected ${rejected.length} ${rejected.length ? JSON.stringify(rejected.reduce<Record<number, number>>((h, s) => ((h[s] = (h[s] || 0) + 1), h), {})) : ''}`);
  const heap0 = process.memoryUsage().rss / 1048576;

  // one mutation -> everyone should get SHIFT_CREATED (after the CONNECTED event)
  await new Promise((r) => setTimeout(r, 500));
  const mark = performance.now();
  const s = await post('/api/v1/shifts', { title: 'Fanout probe', description: 'sse fixture', category: 'FOOD', location: 'SIEBEL_ATRIUM', startTime: new Date(Date.now() + 3600e3).toISOString(), endTime: new Date(Date.now() + 7200e3).toISOString(), capacity: 2 });
  await new Promise((r) => setTimeout(r, 2000));
  const got = received.filter((r) => r.some((t) => t > mark)).length;
  const lat = received.map((r) => r.find((t) => t > mark)).filter((t): t is number => t !== undefined).map((t) => t - mark).sort((a, b) => a - b);
  console.log(`1 mutation (POST /shifts -> ${s}) reached ${got}/${open} connected clients · delivery p50 ${lat[Math.floor(lat.length * .5)]?.toFixed(0)}ms p99 ${lat[Math.floor(lat.length * .99)]?.toFixed(0)}ms max ${lat.at(-1)?.toFixed(0)}ms`);

  // burst: 200 mutations back to back
  const before = received.map((r) => r.length);
  const tb = performance.now();
  for (let i = 0; i < 200; i++) await post('/api/v1/shifts', { title: `Burst ${i}`, description: 'sse burst', category: 'FOOD', location: 'SIEBEL_ATRIUM', startTime: new Date(Date.now() + (i + 2) * 3600e3).toISOString(), endTime: new Date(Date.now() + (i + 3) * 3600e3).toISOString(), capacity: 2 });
  await new Promise((r) => setTimeout(r, 3000));
  const deltas = received.map((r, i) => r.length - before[i]!);
  const min = Math.min(...deltas.filter((_, i) => i < open)), max = Math.max(...deltas);
  console.log(`200 mutations in ${((performance.now() - tb) / 1000).toFixed(1)}s -> per-client events received: min ${min} max ${max} (expected 200 each) · clients that missed events: ${deltas.filter((d, i) => i < open && d < 200).length}`);
  const heap1 = process.memoryUsage().rss / 1048576;
  console.log(`RSS: ${heap0.toFixed(0)}MB -> ${heap1.toFixed(0)}MB with ${open} streams held open (${((heap1 - heap0) * 1024 / Math.max(open, 1)).toFixed(0)} KB/client)`);
  console.log(`rate-limit interaction: the SSE route sits under /api/v1, so ${open} dashboard opens consumed ${open} of the per-IP budget`);
  process.exit(0);
})();
