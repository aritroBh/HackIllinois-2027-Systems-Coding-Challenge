/**
 * The game endpoints (plan A6/M6): sponsor booths, the raid board, the faction objective bar
 * and the leaderboard.
 *
 * These four are the surfaces a hacker actually touches during the event, and three of them
 * are read-only aggregates whose failure mode is quiet: a leaderboard with an unstable order
 * looks like a leaderboard, and a faction bar that drops an empty faction looks like a faction
 * bar. So the tests here pin the properties that make them trustworthy rather than merely
 * checking that a 200 comes back.
 *
 * The booth scan is the one write, and it is the one worth being paranoid about: the code on a
 * poster is public to everybody standing in front of it, so the only thing stopping a hacker
 * scanning it eight times is the once-per-account rule, and the only thing stopping them
 * scanning a booth they have never visited is that the code is derived from a secret they do
 * not have.
 */
import request from 'supertest';
import { app } from '../src/app';
import { Volunteer, VolunteerRole, AccountKind } from '../src/models/volunteer.model';
import { BoothScan } from '../src/models/boothScan.model';
import { KarmaLedger } from '../src/models/karmaLedger.model';
import { StickerLedger } from '../src/models/stickerLedger.model';
import { BoothService } from '../src/services/booth.service';
import { GameBoardService } from '../src/services/gameBoard.service';
import { RaidService } from '../src/services/raid.service';
import { cookieNames } from '../src/common/utils/sessionToken';

function csrfFrom(res: request.Response): string {
  const setCookie = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const raw = setCookie.find((c) => c.startsWith(`${cookieNames().csrf}=`))!;
  return decodeURIComponent(raw.split(';')[0].split('=')[1]);
}

async function makeAccount(over: Partial<{ name: string; kind: AccountKind; faction: string; karma: number }> = {}) {
  const kind = over.kind ?? AccountKind.HACKER;
  return Volunteer.create({
    name: over.name ?? `G ${Math.random().toString(36).slice(2, 7)}`,
    email: kind === AccountKind.HACKER ? null : `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind,
    role: kind === AccountKind.HACKER ? VolunteerRole.HACKER : VolunteerRole.VOLUNTEER,
    faction: over.faction,
    karmaPoints: over.karma ?? 0,
  });
}

async function signIn(accountId: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/dev-login').send({ accountId });
  expect(res.status).toBe(200);
  return { agent, csrf: csrfFrom(res) };
}

describe('sponsor booths', () => {
  const booth = () => BoothService.list()[0];

  it('pays once, writes a ledger row, and refuses the second scan by the same person', async () => {
    const b = booth();
    expect(b).toBeDefined();
    const hacker = await makeAccount();
    const { agent, csrf } = await signIn(hacker.id);
    const code = BoothService.codeFor(b.id);

    const first = await agent.post(`/api/v1/game/booths/${b.id}/scan`).set('X-CSRF-Token', csrf).send({ code });
    expect(first.status).toBe(201);
    expect(first.body.data.boothId).toBe(b.id);
    expect(first.body.data.awardedKarma).toBe(b.reward.karma);

    const second = await agent.post(`/api/v1/game/booths/${b.id}/scan`).set('X-CSRF-Token', csrf).send({ code });
    expect(second.status).toBe(409);

    // One scan row, one karma row, and the balance agrees with both.
    expect(await BoothScan.countDocuments({ accountId: hacker._id, boothId: b.id })).toBe(1);
    const ledger = await KarmaLedger.find({ accountId: hacker._id, source: 'BOOTH' });
    expect(ledger.reduce((s, r) => s + r.amount, 0)).toBe(b.reward.karma);
    expect((await Volunteer.findById(hacker.id))!.karmaPoints).toBe(b.reward.karma);
  });

  it('accepts a code typed by someone awake for thirty hours: any case, any separators', async () => {
    const b = BoothService.list()[1];
    const hacker = await makeAccount();
    const { agent, csrf } = await signIn(hacker.id);
    const code = BoothService.codeFor(b.id);
    const mangled = code.toLowerCase().replace(/(.{4})/g, '$1-');

    const res = await agent.post(`/api/v1/game/booths/${b.id}/scan`).set('X-CSRF-Token', csrf).send({ code: mangled });
    expect(res.status).toBe(201);
  });

  it('refuses another booth’s code, and does not 500 on a short one', async () => {
    const [a, b] = BoothService.list();
    const hacker = await makeAccount();
    const { agent, csrf } = await signIn(hacker.id);

    const wrong = await agent.post(`/api/v1/game/booths/${a.id}/scan`).set('X-CSRF-Token', csrf).send({ code: BoothService.codeFor(b.id) });
    expect(wrong.status).toBe(403);

    // The constant-time compare throws rather than returning false when the lengths differ,
    // so a short code is the shape most likely to become a 500 rather than a refusal.
    const short = await agent.post(`/api/v1/game/booths/${a.id}/scan`).set('X-CSRF-Token', csrf).send({ code: 'AB' });
    expect([400, 403]).toContain(short.status);

    // A refused scan pays nothing and leaves no row to block a later legitimate one.
    expect(await BoothScan.countDocuments({ accountId: hacker._id })).toBe(0);
  });

  it('needs an account: a booth code alone is not a credential', async () => {
    const b = booth();
    const res = await request(app).post(`/api/v1/game/booths/${b.id}/scan`).send({ code: BoothService.codeFor(b.id) });
    expect(res.status).toBe(401);
  });

  it('a booth the pack does not declare is a 404, not a 500', async () => {
    const hacker = await makeAccount();
    const { agent, csrf } = await signIn(hacker.id);
    const res = await agent.post('/api/v1/game/booths/booth-not-real/scan').set('X-CSRF-Token', csrf).send({ code: 'ABCDEFGH' });
    expect(res.status).toBe(404);
  });

  it('twenty phones on one poster produce one winner and nineteen refusals', async () => {
    const b = BoothService.list()[2];
    const hacker = await makeAccount();
    const code = BoothService.codeFor(b.id);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => BoothService.scan(hacker.id, b.id, code).then(() => 'ok').catch((e) => String(e.statusCode ?? 'err')))
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === '409')).toHaveLength(19);
    expect(await BoothScan.countDocuments({ accountId: hacker._id, boothId: b.id })).toBe(1);
    if (b.reward.sticker) {
      expect(await StickerLedger.countDocuments({ accountId: hacker._id, stickerId: b.reward.sticker })).toBe(1);
    }
  });
});

describe('the boards a hacker reads', () => {
  it('reports every faction on the objective bar, including the ones nobody joined', async () => {
    const board = await GameBoardService.objectives();
    const { pack } = await import('../src/content/loader');
    for (const faction of pack.factions) {
      expect(board.factions.some((f: { id: string }) => f.id === faction.id)).toBe(true);
    }
    // A bar whose segments do not sum to the whole is a bar that lies about a share.
    const total = board.factions.reduce((s: number, f: { attending: number }) => s + f.attending, 0);
    expect(total).toBe(board.totalAttending);
  });

  it('orders the leaderboard totally, so two people on the same karma never swap between reads', async () => {
    // Same karma, same reliability: only the final tiebreak can separate them, and if it
    // cannot the order is a coin flip that changes between page loads.
    await makeAccount({ name: 'Tie Bravo', karma: 500 });
    await makeAccount({ name: 'Tie Alpha', karma: 500 });
    const first = await GameBoardService.leaderboard(50);
    const second = await GameBoardService.leaderboard(50);
    expect(first.map((e) => e.name)).toEqual(second.map((e) => e.name));

    const tied = first.filter((e) => e.name.startsWith('Tie '));
    expect(tied).toHaveLength(2);
    expect(tied[0].name < tied[1].name).toBe(true);
    expect(tied[0].rank).toBeLessThan(tied[1].rank);
  });

  it('leaves a zero-karma account off the board rather than filling it with nobody', async () => {
    const quiet = await makeAccount({ name: 'Zed Zero', karma: 0 });
    const board = await GameBoardService.leaderboard(200);
    expect(board.some((e) => e.accountId === String(quiet._id))).toBe(false);
  });

  it('serves the raid board over HTTP with a schedule the client can render', async () => {
    const res = await request(app).get('/api/v1/game/raids');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.raids)).toBe(true);
    // No-store: a raid window that a proxy caches for a minute is a raid a player misses.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('opens a raid only inside its own window', async () => {
    const board = await RaidService.board();
    if (!board.raids.length) return; // a pack with no raids has nothing to assert
    const raid = board.raids[0];
    const inside = RaidService.openAt(new Date(raid.startsAt));
    expect(inside.some((r) => r.id === raid.id)).toBe(true);
    const before = RaidService.openAt(new Date(new Date(raid.startsAt).getTime() - 60_000));
    expect(before.some((r) => r.id === raid.id)).toBe(false);
  });

  it('caps the leaderboard at what the caller asked for', async () => {
    for (let i = 0; i < 6; i++) await makeAccount({ name: `Board ${i}`, karma: 100 + i });
    const res = await request(app).get('/api/v1/game/leaderboard?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });
});
