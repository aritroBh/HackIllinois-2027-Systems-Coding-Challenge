/**
 * Where the economy is plugged into the rest of the server (plan §A6).
 *
 * Every rule that pays somebody for doing something lives here as a listener on the domain
 * bus, not inside the service that published the event. Check-in does not know that quests
 * exist; it says `checkin.completed` and this file decides what that is worth. The
 * dependency runs one way, and adding a rule is adding a listener rather than another
 * branch inside a service that was already long enough.
 *
 * Two consequences worth stating, because they are choices rather than accidents:
 *
 * Rewards are best-effort. A listener runs after the request has been answered, so a quest
 * that fails to advance does not fail the check-in that earned it. Anything that must not
 * be lost belongs in the write that produced the event, not here.
 *
 * Nothing in this file reacts to presence. Being somewhere is not work, and paying for
 * location would turn an opt-in safety feature into a reason to leave a phone on a table.
 */
import { domainEvents } from '../common/events/domainEvents';
import { QuestService } from '../services/quest.service';
import { RaidService } from '../services/raid.service';

let wired = false;
let unsubscribeRaids: (() => void) | null = null;

/**
 * Subscribe the economy to the domain bus. Idempotent, because both entry points call it
 * and a test may call it again after tearing down.
 */
export function wireEconomy(): void {
  if (wired) return;
  wired = true;

  // Completion pays its own karma and sticker inside QuestService, so this listener only
  // has to say that something happened and to whom.
  const advance = (event: string) => (payload: Record<string, unknown>) => {
    const accountId = typeof payload.accountId === 'string' ? payload.accountId : null;
    if (!accountId) return;
    void QuestService.advance(accountId, event, payload).catch((err) =>
      console.warn(`[economy] ${event} quest advance failed: ${(err as Error).message}`)
    );
  };

  domainEvents.on('checkin.completed', advance('checkin.completed'));
  domainEvents.on('checkout.completed', advance('checkout.completed'));
  domainEvents.on('registration.created', advance('registration.created'));
  domainEvents.on('sos.resolved', (payload) => {
    // The resolver is the earner; a ticket that closes without one pays nobody.
    if (payload.resolverId) advance('sos.resolved')({ ...payload, accountId: payload.resolverId });
  });
  domainEvents.on('gym.captured', advance('gym.captured'));
  domainEvents.on('hackstop.spun', advance('hackstop.spun'));
  domainEvents.on('booth.scanned', advance('booth.scanned'));

  // Raid enrolment is the same shape — a listener on the bus — and belongs here for the same
  // reason: `RaidService` owns what a join means, and nothing that emits an event should know
  // that raids exist.
  //
  // It was written and never called. `subscribe()` had no caller anywhere outside its own
  // tests, so during a live raid window nobody was ever enrolled: `RaidJoin` stayed empty and
  // every board reported a join count of zero. The unit tests exercised `board()` and
  // `openAt()` directly and passed throughout, which is exactly the failure mode of testing a
  // function instead of the wiring that reaches it. `tests/game.test.ts` now asserts that
  // wiring this file produces an enrolment from a bus event.
  unsubscribeRaids = RaidService.subscribe();
}

/** Test hook: forget that we wired, so a suite can rebuild the graph. */
export function __resetEconomyWiring(): void {
  wired = false;
  // Detached rather than orphaned: `subscribe()` returns its own unsubscribe, and a suite
  // that rebuilds the graph without calling it accumulates a second set of raid listeners
  // that record every join twice.
  if (unsubscribeRaids) {
    unsubscribeRaids();
    unsubscribeRaids = null;
  }
}
