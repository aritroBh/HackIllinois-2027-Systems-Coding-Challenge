/**
 * Every model, in one import.
 *
 * Mongoose registers a model as a side effect of the module that defines it, so a model whose
 * file nobody has imported does not exist as far as `mongoose.models` is concerned — and
 * anything that walks the registry to build indexes or to check a schema silently skips it.
 * That is a bad failure: the collection still works, writes still succeed, and the uniqueness
 * constraint that was supposed to stop a double payment is simply absent.
 *
 * This barrel is the fix. It is imported by the migration and by the test harness, both of
 * which need the registry to be complete before they touch it, and by anything else that
 * would otherwise have to keep its own list of twenty-three files in step by hand.
 *
 * Adding a model means adding a line here. The alternative — a directory scan — would work
 * under `tsx` and break in the compiled build, where the files have different extensions and
 * may be bundled.
 */
export { Announcement } from './announcement.model';
export { AuthToken } from './authToken.model';
export { Avatar } from './avatar.model';
export { BoothScan } from './boothScan.model';
export { BountyLedger } from './bountyLedger.model';
export { CheckIn } from './checkin.model';
export { ClaimCode } from './claimCode.model';
export { Gym } from './gym.model';
export { HackStop } from './hackstop.model';
export { IdempotencyRecord } from './idempotency.model';
export { KarmaLedger } from './karmaLedger.model';
export { PowerUpInventory } from './powerup.model';
export { PresenceAudit } from './presenceAudit.model';
export { PresenceMute } from './presenceMute.model';
export { QuestProgress } from './questProgress.model';
export { RaidJoin } from './raidJoin.model';
export { Registration } from './registration.model';
export { ReservationLock } from './reservationLock.model';
export { Shift } from './shift.model';
export { SOSTicket } from './sosTicket.model';
export { StickerLedger } from './stickerLedger.model';
export { ShiftSwap } from './swap.model';
export { Volunteer } from './volunteer.model';
