/**
 * Rate-key table: which bucket a request lands in, and who is exempt.
 *
 * Limiters are built with `buildLimiters` and tiny explicit ceilings (`testMode: false`)
 * on throwaway express apps. Identity is a test-only middleware that sets `req.account`
 * from a header; client IPs are supplied via `X-Forwarded-For` behind `trust proxy`.
 */
import express, { Application, RequestHandler } from 'express';
import request from 'supertest';
import { buildLimiters, Limiters } from '../src/middleware/rateLimiter';
import { AccountContext } from '../src/common/types/account';

function makeApp(...limiters: RequestHandler[]): Application {
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    const id = req.header('x-test-account');
    if (id) {
      const account: AccountContext = {
        id,
        kind: 'VOLUNTEER',
        role: 'VOLUNTEER',
        faction: null,
        displayName: id,
        sessionVersion: 0,
        source: 'session',
      };
      req.account = account;
    }
    next();
  });
  app.use(...limiters);
  app.all('*', (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

const SMALL: Parameters<typeof buildLimiters>[0] = {
  windowMs: 60_000,
  accountMax: 2,
  anonymousMax: 3,
  authExchangeMax: 1,
  mutationMax: 1,
  ipCeilingMax: 2,
  trustedCidrs: ['10.0.0.0/8'],
  testMode: false,
};

describe('rate-key table', () => {
  let limiters: Limiters;

  beforeEach(() => {
    limiters = buildLimiters(SMALL);
  });

  describe('apiRateLimiter key selection', () => {
    it('keys authenticated requests by account, independent of IP and of other accounts', async () => {
      const app = makeApp(limiters.apiRateLimiter);
      const alice = { 'x-test-account': 'alice', 'X-Forwarded-For': '203.0.113.1' };

      await request(app).get('/x').set(alice).expect(200);
      await request(app).get('/x').set({ ...alice, 'X-Forwarded-For': '203.0.113.2' }).expect(200);
      const blocked = await request(app).get('/x').set(alice).expect(429);
      expect(blocked.body).toEqual({
        success: false,
        error: 'TOO_MANY_REQUESTS',
        message: expect.stringContaining('for this account'),
        statusCode: 429,
      });

      // Another account from the very same address is untouched.
      await request(app).get('/x').set({ 'x-test-account': 'bob', 'X-Forwarded-For': '203.0.113.1' }).expect(200);
    });

    it('keys anonymous requests by IP with their own ceiling, never counting authenticated traffic', async () => {
      const app = makeApp(limiters.apiRateLimiter);
      const ip = { 'X-Forwarded-For': '198.51.100.7' };

      // Two authenticated requests from this IP do not consume the anonymous budget.
      await request(app).get('/x').set({ ...ip, 'x-test-account': 'carol' }).expect(200);
      await request(app).get('/x').set({ ...ip, 'x-test-account': 'carol' }).expect(200);

      for (let i = 0; i < SMALL.anonymousMax!; i++) await request(app).get('/x').set(ip).expect(200);
      const blocked = await request(app).get('/x').set(ip).expect(429);
      expect(blocked.body.message).toContain('from this IP');

      await request(app).get('/x').set({ 'X-Forwarded-For': '198.51.100.8' }).expect(200);
    });
  });

  describe('authExchangeLimiter', () => {
    it('limits per IP and grants trusted egress CIDRs a 10x allowance, never an exemption', async () => {
      const app = makeApp(limiters.authExchangeLimiter);
      const untrusted = { 'X-Forwarded-For': '203.0.113.9' };
      await request(app).post('/auth/claim').set(untrusted).expect(200);
      await request(app).post('/auth/claim').set(untrusted).expect(429);

      const trusted = { 'X-Forwarded-For': '10.42.0.5' };
      for (let i = 0; i < 5; i++) await request(app).post('/auth/claim').set(trusted).expect(200);
    });
  });

  describe('mutationLimiter', () => {
    it('passes reads and anonymous requests through, limits mutations per account', async () => {
      const app = makeApp(limiters.mutationLimiter);
      const dave = { 'x-test-account': 'dave' };

      for (let i = 0; i < 4; i++) await request(app).get('/shifts').set(dave).expect(200);
      await request(app).post('/shifts').set(dave).expect(200);
      await request(app).patch('/shifts/1').set(dave).expect(429);

      // Reads still pass for the throttled account, and another account is unaffected.
      await request(app).get('/shifts').set(dave).expect(200);
      await request(app).post('/shifts').set({ 'x-test-account': 'erin' }).expect(200);

      // Anonymous mutations are not this limiter's job (identity rejects them in required mode).
      for (let i = 0; i < 3; i++) await request(app).post('/shifts').expect(200);
    });
  });

  describe('ipCeilingLimiter', () => {
    it('caps anonymous traffic per IP, skipping authenticated requests and trusted CIDRs', async () => {
      const app = makeApp(limiters.ipCeilingLimiter);
      const ip = { 'X-Forwarded-For': '192.0.2.4' };

      await request(app).get('/health').set({ ...ip, 'x-test-account': 'frank' }).expect(200);
      await request(app).get('/health').set({ ...ip, 'x-test-account': 'frank' }).expect(200);
      await request(app).get('/health').set({ ...ip, 'x-test-account': 'frank' }).expect(200);

      await request(app).get('/health').set(ip).expect(200);
      await request(app).get('/health').set(ip).expect(200);
      await request(app).get('/health').set(ip).expect(429);

      for (let i = 0; i < 5; i++) await request(app).get('/health').set({ 'X-Forwarded-For': '10.0.0.1' }).expect(200);
    });
  });

  describe('composition', () => {
    it('stacks the general, mutation and ceiling limiters on one request without double counting', async () => {
      const app = makeApp(limiters.apiRateLimiter, limiters.mutationLimiter, limiters.ipCeilingLimiter);
      const gina = { 'x-test-account': 'gina', 'X-Forwarded-For': '203.0.113.20' };
      await request(app).post('/x').set(gina).expect(200); // account 1/2, mutation 1/1
      await request(app).get('/x').set(gina).expect(200); // account 2/2
      const res = await request(app).get('/x').set(gina).expect(429);
      expect(res.body.message).toContain('for this account');
    });
  });

  describe('test mode', () => {
    it('raises every ceiling to at least 10,000 so the functional suites are never throttled', async () => {
      const relaxed = buildLimiters({ ...SMALL, testMode: true });
      const app = makeApp(relaxed.apiRateLimiter);
      for (let i = 0; i < 5; i++) await request(app).get('/x').set({ 'X-Forwarded-For': '203.0.113.30' }).expect(200);
      const res = await request(app).get('/x').set({ 'X-Forwarded-For': '203.0.113.30' });
      expect(Number(res.headers['ratelimit-limit'])).toBeGreaterThanOrEqual(10_000);
    });
  });
});
