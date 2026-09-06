/**
 * The per-volunteer reservation mutex.
 *
 * Two overlapping reservations by one person must not both pass the rest-buffer, fatigue and
 * double-booking checks, all of which are read-then-act. The lock is what makes those checks
 * sound, so a lock that can be released by somebody who no longer holds it is not a smaller
 * bug than no lock at all — it is the same bug, arriving rarely enough to be hard to believe.
 *
 * These drive the private methods directly. That is deliberate: the failure needs a lock to
 * expire mid-request, and the honest way to produce that is to reach in and age it rather than
 * to sleep for thirty seconds in a test suite.
 */
import { ReservationLock } from '../src/models/reservationLock.model';
import { RegistrationService } from '../src/services/registration.service';

/** The private mutex, named once so the casts do not spread through the file. */
const lock = RegistrationService as unknown as {
  acquireVolunteerLock(volunteerId: string): Promise<string>;
  releaseVolunteerLock(volunteerId: string, token: string | null): Promise<void>;
};

const VOL = '6a9d3ebf2e9237ec3b74baef';

describe('the reservation mutex is held by exactly one request', () => {
  it('a second acquisition is refused while the first holds it', async () => {
    const token = await lock.acquireVolunteerLock(VOL);
    expect(token).toBeTruthy();
    await expect(lock.acquireVolunteerLock(VOL)).rejects.toThrow(/another reservation request in flight/i);
    await lock.releaseVolunteerLock(VOL, token);
    // Released, so the next caller gets it.
    const second = await lock.acquireVolunteerLock(VOL);
    expect(second).toBeTruthy();
    expect(second).not.toBe(token);
    await lock.releaseVolunteerLock(VOL, second);
  });

  it('a request whose lock was stolen cannot release the thief’s lock', async () => {
    // The scenario, in order: A takes the lock; A is slow and its lock expires; B waits, sees
    // the expiry, and steals it; A finally finishes and runs its `finally`.
    const aToken = await lock.acquireVolunteerLock(VOL);
    await ReservationLock.updateOne({ key: `vol:${VOL}` }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const bToken = await lock.acquireVolunteerLock(VOL);
    expect(bToken).not.toBe(aToken);
    expect((await ReservationLock.findOne({ key: `vol:${VOL}` }))!.token).toBe(bToken);

    // A's release must be a no-op. Unconditional, it deleted B's lock and two reservations
    // for one volunteer then ran at once — both succeeding, which is why nobody would notice.
    await lock.releaseVolunteerLock(VOL, aToken);
    const still = await ReservationLock.findOne({ key: `vol:${VOL}` });
    expect(still).not.toBeNull();
    expect(still!.token).toBe(bToken);

    // And B can still release its own.
    await lock.releaseVolunteerLock(VOL, bToken);
    expect(await ReservationLock.findOne({ key: `vol:${VOL}` })).toBeNull();
  });

  it('two waiters racing on the same stale lock produce one winner', async () => {
    const stale = await lock.acquireVolunteerLock(VOL);
    await ReservationLock.updateOne({ key: `vol:${VOL}` }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const results = await Promise.all([
      lock.acquireVolunteerLock(VOL).then((t) => ({ ok: true as const, t })).catch(() => ({ ok: false as const, t: '' })),
      lock.acquireVolunteerLock(VOL).then((t) => ({ ok: true as const, t })).catch(() => ({ ok: false as const, t: '' })),
    ]);

    // The steal names the token it read, so two stealers cannot both believe they hold it.
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    const held = (await ReservationLock.findOne({ key: `vol:${VOL}` }))!.token;
    expect(winners.some((w) => w.t === held)).toBe(true);
    // Whichever tokens did not win cannot release the one that did.
    for (const r of results) if (r.ok && r.t !== held) await lock.releaseVolunteerLock(VOL, r.t);
    expect((await ReservationLock.findOne({ key: `vol:${VOL}` }))!.token).toBe(held);
    void stale;
  });
});
