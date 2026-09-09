/**
 * Economy spine (plan M6): the karma ledger and its daily caps, the sticker ledger's
 * idempotency, the bounty budget's atomicity, and the domain bus's isolation.
 *
 * The concurrency cases are the point. An economy that leaks upward under load is the one
 * you cannot quietly fix afterwards, so the tests that matter here run things at once.
 */
import mongoose from 'mongoose';
import { HOLDER } from './helpers/factions';
import { Volunteer, VolunteerRole, AccountKind, computePrestigeTier } from '../src/models/volunteer.model';
import { KarmaLedger } from '../src/models/karmaLedger.model';
import { StickerLedger } from '../src/models/stickerLedger.model';
import { BountyLedger } from '../src/models/bountyLedger.model';
import { eventDay } from '../src/models/karmaLedger.model';
import { KarmaService } from '../src/services/karma.service';
import { RaidService } from '../src/services/raid.service';
import { StickerService } from '../src/services/sticker.service';
import { BountyService } from '../src/services/bounty.service';
import { domainEvents } from '../src/common/events/domainEvents';
import { TransactionContentionError, withTransactionRetry } from '../src/common/db/withTransactionRetry';
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

  it('twenty concurrent awards against a real cap stop at the cap, and the ledger agrees', async () => {
    // Cap a source for the duration of this test. Probing an UNCAPPED source would let the
    // assertion pass for the wrong reason: twenty awards of ten can never exceed two
    // hundred, so "at most two hundred" would hold whether the cap worked or not.
    const CAP = 100;
    const caps = pack.event.karmaCaps as Record<string, number>;
    caps.CONCURRENCY_PROBE = CAP;
    try {
      const vol = await makeAccount();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => KarmaService.awardKarma(vol.id, 10, 'CONCURRENCY_PROBE'))
      );
      const paid = results.reduce((s, r) => s + r.awarded, 0);
      const balance = (await Volunteer.findById(vol.id))!.karmaPoints;
      const ledger = await KarmaLedger.find({ accountId: vol._id, source: 'CONCURRENCY_PROBE' });
      const ledgerTotal = ledger.reduce((s, r) => s + r.amount, 0);

      // The cap held under twenty simultaneous writers.
      expect(paid).toBe(CAP);
      // And the three numbers that must never diverge agree exactly. A drift here is karma
      // minted out of nothing, which is the failure you cannot quietly correct afterwards.
      expect(balance).toBe(CAP);
      expect(ledgerTotal).toBe(CAP);
      expect(results.filter((r) => r.capped).length).toBeGreaterThan(0);
    } finally {
      delete caps.CONCURRENCY_PROBE;
    }
  });
});

describe('a raid window multiplies what work is worth', () => {
  it('pays the raid multiplier on effort and leaves fixed rewards alone', async () => {
    // `RaidService.multiplierAt` existed with no caller: the banner promised "3x karma"
    // during a raid window and every award paid 1x. The multiplier is applied where karma is
    // minted, which is the only place it can be applied without the promise and the payment
    // disagreeing.
    const spy = jest.spyOn(RaidService, 'multiplierAt').mockReturnValue(3);
    try {
      const worker = await makeAccount();
      const scanner = await makeAccount();

      // SHIFT is work, so it is multiplied.
      const shift = await KarmaService.awardKarma(worker.id, 50, 'SHIFT');
      expect(shift.multiplier).toBe(3);
      expect(shift.awarded).toBe(150);
      expect((await Volunteer.findById(worker.id))!.karmaPoints).toBe(150);

      // BOOTH is a fixed sponsor reward for a thing you do once, so it is not: tripling it
      // would make a raid window a scavenging hour rather than a shift.
      const booth = await KarmaService.awardKarma(scanner.id, 60, 'BOOTH');
      expect(booth.multiplier).toBe(1);
      expect(booth.awarded).toBe(60);
    } finally {
      spy.mockRestore();
    }
  });

  it('multiplies before the daily cap, so a raid does not raise the ceiling', async () => {
    // A cap is a ceiling on what a source may pay in a day. A raid is meant to make an hour
    // worth more, not to lift that ceiling — multiplying after the clamp would do the latter.
    const CAP = 100;
    const caps = pack.event.karmaCaps as Record<string, number>;
    caps.SHIFT = CAP;
    const spy = jest.spyOn(RaidService, 'multiplierAt').mockReturnValue(3);
    try {
      const vol = await makeAccount();
      const res = await KarmaService.awardKarma(vol.id, 50, 'SHIFT');
      // 50 x 3 = 150 requested, clamped to the 100 ceiling.
      expect(res.awarded).toBe(CAP);
      expect(res.capped).toBe(true);
      expect((await Volunteer.findById(vol.id))!.karmaPoints).toBe(CAP);
    } finally {
      spy.mockRestore();
      delete caps.SHIFT;
    }
  });

  it('is a no-op outside a raid window', async () => {
    const vol = await makeAccount();
    const res = await KarmaService.awardKarma(vol.id, 40, 'SHIFT');
    expect(res.multiplier).toBe(1);
    expect(res.awarded).toBe(40);
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
    // Deliberately NOT swallowing throws: the plan forbids a 500 here, so an exception is a
    // failure of the test rather than a budget refusal to be counted.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTransactionRetry((session) => BountyService.reserve({ accountId: vol.id, day, bounty: 100, budget: 300 }, session))
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

describe('the first ticket of the day is not a race anybody loses', () => {
  it('two simultaneous first tickets both settle, neither 500s', async () => {
    // Both transactions try to open the same account's first ledger row of the day with an
    // upsert. One wins; the other's E11000 used to escape as a DuplicateKeyError and became a
    // 500 — the exact contention the retry helper's own comments claim to handle. A duplicate
    // on this collection means the row now exists, so re-running the body finds it and
    // increments.
    const vol = await makeAccount();
    const day = eventDay();
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        withTransactionRetry(
          (session) => BountyService.reserve({ accountId: vol.id, day, bounty: 100, budget: 1000 }, session),
          { retryOnDuplicateIn: ['bountyledgers'] }
        ).then((r) => (r.ok ? 'granted' : 'refused')).catch((e) => `threw:${e.name}`)
      )
    );
    expect(results.filter((r) => r === 'granted')).toHaveLength(2);
    expect(results.some((r) => r.startsWith('threw'))).toBe(false);
    const row = await BountyLedger.findOne({ accountId: vol._id, day });
    expect(row!.spent).toBe(200);
  });

  it('twenty at once against a budget for five grant exactly five, and none of them throw', async () => {
    const vol = await makeAccount();
    const day = eventDay();
    // A contender that loses every race gets the typed contention signal, which the API
    // answers as a 409 advising a retry — so retry it here, the way a real client does,
    // rather than counting the design's own escape hatch as a failure. On slow iron a
    // twenty-way burst on one ledger row exhausts the helper's twelve attempts for the
    // unluckiest contender; that is a busy moment, not an oversell, and the grant/refuse
    // counts below are what prove the budget held.
    const settle = async (): Promise<string> => {
      for (let round = 0; round < 3; round += 1) {
        try {
          const r = await withTransactionRetry(
            (session) => BountyService.reserve({ accountId: vol.id, day, bounty: 100, budget: 500 }, session),
            { retryOnDuplicateIn: ['bountyledgers'] }
          );
          return r.ok ? 'granted' : 'refused';
        } catch (e) {
          if (!(e instanceof TransactionContentionError)) return `threw:${e instanceof Error ? e.name : String(e)}`;
        }
      }
      return 'threw:TransactionContentionError';
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => settle())
    );
    expect(results.filter((r) => r === 'granted')).toHaveLength(5);
    expect(results.filter((r) => r === 'refused')).toHaveLength(15);
    // Nothing escapes as a raw driver error. Contention that genuinely cannot settle raises a
    // typed TransactionContentionError, which the error handler answers as a 409 with advice
    // to retry — never a 500, which would read as a fault rather than as a busy moment.
    expect(results.filter((r) => r.startsWith('threw:Mongo'))).toHaveLength(0);
    expect((await BountyLedger.findOne({ accountId: vol._id, day }))!.spent).toBe(500);
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

describe('a compensating rollback never unwinds a guard the money has already passed', () => {
  /**
   * Both the sponsor-booth scan and quest settlement create their once-only guard first —
   * a unique `BoothScan` row, a CAS on `completedAt: null` — then pay, then do the rest.
   * Both then had a `catch` that removed that guard "to hand the reward back", which is
   * right only while nothing has been paid. After the award, deleting the guard turns a
   * once-ever reward into a repeatable one: the sticker write is a second database round
   * trip and one transient failure was enough.
   *
   * The failure is injected on the sticker write because that is the real shape of it —
   * `StickerService.award` writes to two collections, so a blip there is ordinary.
   */
  it('a booth scan that pays and then fails stays scanned, and cannot be scanned again', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { BoothService } = await import('../src/services/booth.service');
    const { BoothScan } = await import('../src/models/boothScan.model');

    // `booths.json` is optional in a pack, so read it the way the service does.
    const boothsFile = path.join(pack.dir, 'booths.json');
    if (!fs.existsSync(boothsFile)) return;
    const booths = JSON.parse(fs.readFileSync(boothsFile, 'utf8')).booths as Array<{
      id: string; reward: { karma: number; sticker?: string };
    }>;
    const booth = booths.find((b) => b.reward.karma > 0 && b.reward.sticker);
    if (!booth) return; // no booth pays both karma and a sticker; nothing to assert
    const boothId = booth.id;

    const vol = await makeAccount('Booth Bella');
    const spy = jest
      .spyOn(StickerService, 'award')
      .mockRejectedValueOnce(new Error('transient sticker failure'));

    await expect(
      BoothService.scan(String(vol._id), boothId, BoothService.codeFor(boothId))
    ).rejects.toThrow(/transient sticker failure/);
    spy.mockRestore();

    const paid = (await Volunteer.findById(vol._id))!.karmaPoints;
    // The guard stands even though the rest of the scan failed.
    expect(await BoothScan.countDocuments({ accountId: vol._id, boothId })).toBe(1);

    // And the second press is refused rather than paying again.
    await expect(
      BoothService.scan(String(vol._id), boothId, BoothService.codeFor(boothId))
    ).rejects.toThrow(/already scanned/i);
    expect((await Volunteer.findById(vol._id))!.karmaPoints).toBe(paid);
  });
});

describe('NEUTRAL is not a side you can fight for', () => {
  /**
   * The faction lock only ran when the declared faction was non-neutral, and `isAlly`
   * compares the declared faction to the gym's — so an account already bound to one team
   * could declare `NEUTRAL`, skip the lock, take the attack branch against any gym
   * including its own, capture it for nobody, and be paid for it. `NEUTRAL` was the word
   * that turned the lock off.
   */
  it('refuses a battle declared as NEUTRAL, whatever the account is bound to', async () => {
    const { GymService } = await import('../src/services/gym.service');
    const { Gym, Faction } = await import('../src/models/gym.model');

    const vol = await makeAccount('Turncoat Tom');
    await Volunteer.updateOne({ _id: vol._id }, { $set: { faction: 'TEAM_KERNEL' } });
    const gym = await Gym.create({
      name: 'Test Shrine', locationName: 'Somewhere', latitude: 40.10992, longitude: -88.2284,
      controllingFaction: HOLDER, controlPoints: 100, maxControlPoints: 1000, level: 1,
    });

    await expect(
      GymService.battleOrContribute(String(gym._id), String(vol._id), Faction.NEUTRAL, 200, {
        latitude: 40.10992, longitude: -88.2284,
      })
    ).rejects.toThrow(/NEUTRAL/);

    const after = await Gym.findById(gym._id);
    expect(after!.controllingFaction).toBe(HOLDER);
    expect((await Volunteer.findById(vol._id))!.karmaPoints).toBe(0);
  });
});
