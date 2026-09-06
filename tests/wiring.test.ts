/**
 * The gap between a function that works and a function that runs.
 *
 * Every test in this file exists because something was written, tested directly, and never
 * connected to anything — which is the one defect a unit test cannot see, since the unit
 * passes. `RaidService.subscribe()` and `RaidService.tick()` had no caller outside their own
 * tests for the whole of M6: raids opened and closed in the content pack with no frame on the
 * wire and nobody ever enrolled, while `tests/game.test.ts` went green throughout.
 *
 * So these assert the wiring, not the behaviour behind it.
 */
import { domainEvents } from '../src/common/events/domainEvents';
import { wireEconomy, __resetEconomyWiring } from '../src/economy/wiring';
import { RaidService } from '../src/services/raid.service';
import { runDue } from '../src/scheduler';
import { PresenceStore, PresenceEntry } from '../src/presence/store';
import { PresenceService } from '../src/presence/service';
import { PresenceSession } from '../src/presence/session';
import type { PresenceClient } from '../src/presence/transport';
import type { AccountContext } from '../src/common/types/account';
import { BoothScan } from '../src/models/boothScan.model';
import { BoothService } from '../src/services/booth.service';
import { KarmaService } from '../src/services/karma.service';
import { PowerUpInventory } from '../src/models/powerup.model';
import { Volunteer, AccountKind, VolunteerRole } from '../src/models/volunteer.model';
import { StickerService } from '../src/services/sticker.service';
import { pack } from '../src/content/loader';
import fs from 'fs';
import path from 'path';

/** The shipped pack's own reward lists, read straight off disk rather than through a service. */
function packJson(name: string): Record<string, unknown> {
  const file = path.join(pack.dir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
const boothsOfPack = (): Array<{ reward: { sticker?: string } }> =>
  ((packJson('booths.json').booths as Array<{ reward: { sticker?: string } }>) ?? []);
const questsOfPack = (): Array<{ reward: { sticker?: string } }> =>
  ((packJson('quests.json').quests as Array<{ reward: { sticker?: string } }>) ?? []);

afterEach(() => {
  __resetEconomyWiring();
  jest.restoreAllMocks();
});

describe('raids are connected to the things that drive them', () => {
  it('enrols from the domain bus once the economy is wired, and not before', async () => {
    // `subscribe()` returns an unsubscribe and was never called, so during a live raid window
    // `RaidJoin` stayed empty and every board reported a join count of zero. Asserting on
    // `recordJoin` rather than on a row keeps this independent of the pack's raid dates —
    // what was missing is the listener, not the enrolment logic behind it.
    const record = jest.spyOn(RaidService, 'recordJoin').mockResolvedValue([]);

    domainEvents.emit('hackstop.spun', { accountId: '507f1f77bcf86cd799439011', beaconId: 'b1', awardedKarma: 0 });
    expect(record).not.toHaveBeenCalled();

    wireEconomy();
    domainEvents.emit('hackstop.spun', { accountId: '507f1f77bcf86cd799439011', beaconId: 'b1', awardedKarma: 0 });
    await new Promise((r) => setImmediate(r));
    expect(record).toHaveBeenCalledWith('507f1f77bcf86cd799439011', 'hackstop.spun');
  });

  it('advances raid windows from the scheduler, which its own docblock promised', async () => {
    // The scheduler's header has said since M6 that raid timers register here. They did not,
    // so a window opened and closed with no RAID_OPENED and no RAID_CLOSED on the wire.
    const tick = jest.spyOn(RaidService, 'tick').mockImplementation(() => undefined);
    await runDue();
    expect(tick).toHaveBeenCalled();
  });

  it('detaches its listeners when the graph is torn down', async () => {
    // Not housekeeping: a suite that rewires without detaching accumulates a second set of
    // raid listeners, and every join is then recorded twice.
    wireEconomy();
    __resetEconomyWiring();
    const record = jest.spyOn(RaidService, 'recordJoin').mockResolvedValue([]);
    domainEvents.emit('hackstop.spun', { accountId: '507f1f77bcf86cd799439011', beaconId: 'b1', awardedKarma: 0 });
    await new Promise((r) => setImmediate(r));
    expect(record).not.toHaveBeenCalled();
  });
});

describe('a demotion reaches a socket that is already open', () => {
  it('drops lead vision on the next tick rather than at the next reconnect', () => {
    // `invalidate()` deleted the cached facts, and the tick only acted when it *had* facts —
    // so invalidating an account destroyed the evidence that would have demoted its live
    // session. A lead demoted mid-event kept lead vision (off-duty volunteers, and the
    // `presence:exact` stream) for as long as the socket stayed open, which is exactly the
    // case `invalidate` was written for and the one it could not reach.
    const store = new PresenceStore();
    const service = new PresenceService(store);

    const id = '507f1f77bcf86cd799439012';
    const account: AccountContext = {
      id, role: 'SHIFT_LEAD', kind: 'VOLUNTEER', faction: null, displayName: 'Lena',
      sessionVersion: 0, source: 'session',
    };
    const client = {
      id, account, transport: 'ws' as const, binary: false,
      send: () => true, sendBinary: () => true, bufferedBytes: () => 0, close: () => undefined,
    } as unknown as PresenceClient;
    const session = new PresenceSession(client, store, { snapshotEveryMs: 15_000, jsonDetailCap: 40 });
    Object.defineProperty(session, 'accountId', { get: () => id });
    (service as unknown as { sessions: Map<string, PresenceSession> }).sessions.set(id, session);

    // Standing somewhere, so the tick has a cohort to build for them.
    const e: PresenceEntry = {
      id, name: 'Lena', kind: 'VOLUNTEER', role: 'SHIFT_LEAD', faction: null, avatarHash: null,
      onDuty: true, x: 0, z: 0, lat: 0, lng: 0, acc: 5, h: 0, fx: 0, fz: 0,
      pendingFx: NaN, pendingFz: NaN, cell: '', t: Date.now(), version: 1, strikes: 0,
      muteUntil: 0, lastSampleT: Date.now(), optIn: true,
    };
    (store as unknown as { entries: Map<string, PresenceEntry> }).entries.set(id, e);
    (store as unknown as { reindex(x: PresenceEntry): void }).reindex(e);

    expect(session.lead).toBe(true);
    service.tickNow();
    expect(session.lead).toBe(true); // no facts either way yet: the cookie's answer stands

    service.invalidate(id);
    service.tickNow();
    expect(session.lead).toBe(false);
  });
});

describe('a booth hands itself back only when nothing has moved', () => {
  it('keeps the scan row when the power-up landed and a later write failed', async () => {
    // The compensating delete was guarded by a flag that tracked the karma award alone, and
    // the reward is three things. A booth paying zero karma (or one the daily cap has clamped
    // to zero) that grants a power-up left the flag false, so a transient failure after the
    // grant deleted the scan row and handed the booth back — with the power-up already in the
    // inventory. The retry then passes the uniqueness insert and `$inc`s a second one.
    const account = await Volunteer.create({
      name: 'Booth Bea', email: `bb-${Date.now()}@illinois.edu`,
      kind: AccountKind.VOLUNTEER, role: VolunteerRole.VOLUNTEER,
    });
    const boothId = 'booth-prairie-compute'; // karma + a power-up, per the shipped pack
    const code = BoothService.codeFor(boothId);

    // The cap has nothing left, so karma alone would leave the flag false.
    jest.spyOn(KarmaService, 'awardKarma').mockResolvedValue({ awarded: 0, capped: true, total: 0, multiplier: 1 });
    // ...and the write after the grants fails.
    jest.spyOn(BoothScan, 'updateOne').mockRejectedValue(new Error('connection 7 closed'));

    await expect(BoothService.scan(String(account._id), boothId, code)).rejects.toThrow(/connection 7/);

    // The power-up landed, so the once-ever guard has to stand with it.
    const held = await PowerUpInventory.findOne({ volunteerId: account._id });
    expect(held?.quantity).toBe(1);
    expect(await BoothScan.countDocuments({ accountId: account._id, boothId })).toBe(1);

    // And the retry is refused rather than granting a second core.
    jest.restoreAllMocks();
    await expect(BoothService.scan(String(account._id), boothId, code)).rejects.toThrow(/already scanned/i);
    const stillOne = await PowerUpInventory.findOne({ volunteerId: account._id });
    expect(stillOne?.quantity).toBe(1);
  });
});

describe('a reward names something the pack actually has', () => {
  it('refuses a booth or a quest whose sticker id is not in memorabilia.json', () => {
    // The failure this moves: `settle()` and `scan()` both pay the karma and then grant the
    // sticker, so an id the pack never declared surfaced as a 404 *after* the money moved.
    // The scanner got an error, the sticker and the power-up were lost, and nothing repaired
    // it. Venue and power-up were already cross-checked at load; the sticker is the third
    // vocabulary these files draw on and was the only one that was not.
    //
    // Asserted through `knows` rather than by loading a broken pack, because the catalogs are
    // read once per process and a suite cannot un-read one.
    expect(StickerService.knows('siebel-keycard')).toBe(true);
    expect(StickerService.knows('sponser-foo')).toBe(false);

    // And every reward the shipped pack actually declares resolves, which is the assertion
    // that fails if somebody adds a booth or a quest with a typo in it.
    for (const booth of boothsOfPack()) {
      if (booth.reward.sticker) expect(StickerService.knows(booth.reward.sticker)).toBe(true);
    }
    for (const quest of questsOfPack()) {
      if (quest.reward.sticker) expect(StickerService.knows(quest.reward.sticker)).toBe(true);
    }
  });
});
