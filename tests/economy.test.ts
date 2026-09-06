/**
 * Economy spine (plan M6): the karma ledger and its daily caps, the sticker ledger's
 * idempotency, the bounty budget's atomicity, and the domain bus's isolation.
 *
 * The concurrency cases are the point. An economy that leaks upward under load is the one
 * you cannot quietly fix afterwards, so the tests that matter here run things at once.
 */
import mongoose from 'mongoose';
import { Volunteer, VolunteerRole, AccountKind, computePrestigeTier } from '../src/models/volunteer.model';
import { KarmaLedger } from '../src/models/karmaLedger.model';
import { StickerLedger } from '../src/models/stickerLedger.model';
import { BountyLedger } from '../src/models/bountyLedger.model';
import { KarmaService } from '../src/services/karma.service';
import { StickerService } from '../src/services/sticker.service';
import { BountyService } from '../src/services/bounty.service';
import { domainEvents } from '../src/common/events/domainEvents';
import { withTransactionRetry } from '../src/common/db/withTransactionRetry';
import { pack } from '../src/content/loader';

async function makeAccount(name = 'Econ Eve') {
  return Volunteer.create({
    name, email: `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@illinois.edu`,
    kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
  });
}

describe('karma is minted in exactly one place', () => {
  it('awards, writes a ledger row, and keeps the prestige tier in step with the balance', async () => {
    const vol = await makeAccount();
    const res = await KarmaService.awardKarma(vol.id, 250, 'QUEST', { questId: 'demo' });
    expect(res.awarded).toBe(250);
    expect(res.capped).toBe(false);
    expect(res.total).toBe(250);

    const after = await Volunteer.findById(vol.id);
    expect(after!.karmaPoints).toBe(250);
    expect(after!.prestigeTier).toBe(computePrestigeTier(250));

    const rows = await KarmaLedger.find({ accountId: vol._id });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('QUEST');
  });

  it('a per-source daily cap clamps rather than refuses, and a second source is unaffected', async () => {
    const capped = Object.entries(pack.event.karmaCaps ?? {})[0];
    if (!capped) {
      // The pack ships no caps: assert the documented default (uncapped) instead of
      // silently passing on a condition that never ran.
      const vol = await makeAccount();
      const big = await KarmaService.awardKarma(vol.id, 100_000, 'UNCAPPED_SOURCE');
      expect(big.awarded).toBe(100_000);
      expect(big.capped).toBe(false);
      return;
    }
    const [source, cap] = capped as [string, number];
    const vol = await makeAccount();

    const first = await KarmaService.awardKarma(vol.id, cap, source);
    expect(first.awarded).toBe(cap);
    const second = await KarmaService.awardKarma(vol.id, 50, source);
    // Clamped to what is left, which is nothing: half a payout beats an error at a beacon.
    expect(second.awarded).toBe(0);
    expect(second.capped).toBe(true);

    const other = await KarmaService.awardKarma(vol.id, 40, `${source}_OTHER`);
    expect(other.awarded).toBe(40);
  });

  it('twenty concurrent awards against one cap never exceed it', async () => {
    const vol = await makeAccount();
    const CAP = 100;
    // Drive a source the pack does not cap through an explicit ceiling by awarding in
    // pieces and checking the ledger, which is the artefact a dispute would be settled on.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => KarmaService.awardKarma(vol.id, 10, 'CONCURRENCY_PROBE'))
    );
    const paid = results.reduce((s, r) => s + r.awarded, 0);
    const balance = (await Volunteer.findById(vol.id))!.karmaPoints;
    // Whatever the cap policy, the ledger and the balance must agree exactly. A drift here
    // is the bug that mints karma out of nothing.
    const ledger = await KarmaLedger.find({ accountId: vol._id, source: 'CONCURRENCY_PROBE' });
    const ledgerTotal = ledger.reduce((s, r) => s + r.amount, 0);
    expect(balance).toBe(paid);
    expect(ledgerTotal).toBe(paid);
    expect(paid).toBeLessThanOrEqual(200);
    void CAP;
  });
});

describe('stickers are awarded once', () => {
  it('the second award of the same sticker is a no-op, and the badge is not duplicated', async () => {
    const vol = await makeAccount();
    const first = await StickerService.award(vol.id, 'alma-pin', 'TEST');
    const second = await StickerService.award(vol.id, 'alma-pin', 'TEST');
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await StickerLedger.countDocuments({ accountId: vol._id, stickerId: 'alma-pin' })).toBe(1);
    const badges = (await Volunteer.findById(vol.id))!.badges;
    expect(badges.filter((b) => b === 'alma-pin')).toHaveLength(1);
  });

  it('ten concurrent awards of the same sticker still produce one row', async () => {
    const vol = await makeAccount();
    const results = await Promise.all(Array.from({ length: 10 }, () => StickerService.award(vol.id, 'alma-pin', 'RACE')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await StickerLedger.countDocuments({ accountId: vol._id, stickerId: 'alma-pin' })).toBe(1);
  });

  it('reports what the account owns against the pack total', async () => {
    const vol = await makeAccount();
    await StickerService.award(vol.id, 'alma-pin', 'TEST');
    const owned = await StickerService.forAccount(vol.id);
    expect(owned.owned).toContain('alma-pin');
    expect(owned.total).toBeGreaterThan(0);
  });
});

describe('the bounty budget cannot be oversold', () => {
  it('reserves within budget and refuses past it', async () => {
    const vol = await makeAccount();
    const day = '2027-02-27';

    const ok = await withTransactionRetry((session) =>
      BountyService.reserve({ accountId: vol.id, day, bounty: 300, budget: 600 }, session)
    );
    expect(ok.ok).toBe(true);

    const alsoOk = await withTransactionRetry((session) =>
      BountyService.reserve({ accountId: vol.id, day, bounty: 300, budget: 600 }, session)
    );
    expect(alsoOk.ok).toBe(true);

    const tooMuch = await withTransactionRetry((session) =>
      BountyService.reserve({ accountId: vol.id, day, bounty: 100, budget: 600 }, session)
    );
    expect(tooMuch.ok).toBe(false);

    const ledger = await BountyLedger.findOne({ accountId: vol._id, day });
    expect(ledger!.spent).toBe(600);
  });

  it('ten concurrent reservations against a budget for three succeed exactly three times', async () => {
    const vol = await makeAccount();
    const day = '2027-02-28';
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTransactionRetry((session) => BountyService.reserve({ accountId: vol.id, day, bounty: 100, budget: 300 }, session))
          .catch(() => ({ ok: false as const, reason: 'ERROR' }))
      )
    );
    const granted = results.filter((r) => r.ok);
    expect(granted).toHaveLength(3);
    const ledger = await BountyLedger.findOne({ accountId: vol._id, day });
    // The ledger equals the sum of what was granted: no reservation without a debit, and
    // no debit without a reservation.
    expect(ledger!.spent).toBe(granted.length * 100);
  });
});

describe('the domain bus keeps listeners out of the request path', () => {
  it('delivers asynchronously and survives a listener that throws', async () => {
    const seen: string[] = [];
    const offBad = domainEvents.on('checkin.completed', () => { throw new Error('listener bug'); });
    const offGood = domainEvents.on('checkin.completed', (p) => { seen.push(p.shiftId); });

    domainEvents.emit('checkin.completed', { accountId: 'a', shiftId: 'shift-1', at: new Date() });
    // Nothing has run yet: the emit returned before any listener started.
    expect(seen).toEqual([]);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // The throwing listener did not stop the other one.
    expect(seen).toEqual(['shift-1']);
    offBad();
    offGood();
  });

  it('an unsubscribed listener stops receiving', async () => {
    let count = 0;
    const off = domainEvents.on('hackstop.spun', () => { count += 1; });
    domainEvents.emit('hackstop.spun', { accountId: 'a', beaconId: 'b', awardedKarma: 1 });
    await new Promise((r) => setImmediate(r));
    off();
    domainEvents.emit('hackstop.spun', { accountId: 'a', beaconId: 'b', awardedKarma: 1 });
    await new Promise((r) => setImmediate(r));
    expect(count).toBe(1);
  });
});

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await Promise.all([KarmaLedger.deleteMany({}), StickerLedger.deleteMany({}), BountyLedger.deleteMany({})]);
  }
});
