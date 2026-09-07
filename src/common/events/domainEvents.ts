/**
 * In-process domain event bus (plan §A6).
 *
 * `eventHub` pushes to browsers. This is the other half, and it points inward: it lets one
 * part of the server react to another without importing it. Check-in has no business
 * knowing that a sticker book exists, so it emits `checkin.completed` and the reward rules
 * subscribe. The dependency runs one way, from the rule to the bus, and a new rule is a new
 * listener rather than another line inside a service that was already long enough.
 *
 * Two properties matter, and both are enforced here so no call site can forget them.
 * Listeners run on `setImmediate`, which means the request that emitted the event has
 * already been answered by the time they start and cannot be slowed by them. A listener
 * that throws, or whose promise rejects, is logged and goes no further, because a reward
 * rule with a bug must not fail the check-in that triggered it.
 *
 * The cost of those properties is that delivery is best-effort and confined to one process.
 * Nothing here survives a restart, and nothing crosses instances. Anything that must not be
 * lost belongs in the database write that produced the event, not in a listener.
 */

/**
 * The published events and their payloads. Each payload carries the ids a listener needs to
 * do its own reads; it is a notification, not a snapshot, because by the time a listener
 * runs the document may have moved on.
 */
export interface DomainEventMap {
  'checkin.completed': { accountId: string; shiftId: string; registrationId?: string; at: Date };
  'checkout.completed': { accountId: string; shiftId: string; hoursServed: number; at: Date };
  'registration.created': { accountId: string; shiftId: string; waitlisted: boolean };
  'registration.cancelled': { accountId: string; shiftId: string; reason?: string };
  /** `resolverId` is absent when a ticket closes without a named resolver (auto-resolve, sweep). */
  'sos.resolved': { ticketId: string; resolverId?: string; category: string; venueKey?: string };
  'gym.captured': { accountId: string; gymId: string; faction: string };
  'hackstop.spun': { accountId: string; beaconId: string; awardedKarma: number };
  'booth.scanned': { accountId: string; boothId: string };
}

/**
 * The same names as `DomainEventMap`, at runtime.
 *
 * `DomainEventMap` is an interface, so its keys exist only to the compiler and nothing can check
 * a *string* against it — which is why a content pack naming a quest event that does not exist
 * used to boot clean and sit dead all weekend. `crossValidate` compares against this array, so
 * the typo is refused by `npm run content:validate` instead.
 *
 * The `satisfies` below is what keeps the two from drifting: adding a member to the map without
 * adding it here, or vice versa, fails the build rather than silently narrowing what a pack may
 * declare.
 */
export const DOMAIN_EVENT_NAMES = [
  'checkin.completed',
  'checkout.completed',
  'registration.created',
  'registration.cancelled',
  'sos.resolved',
  'gym.captured',
  'hackstop.spun',
  'booth.scanned',
] as const satisfies readonly (keyof DomainEventMap)[];

export type DomainEventName = keyof DomainEventMap;

export type DomainListener<E extends DomainEventName> = (payload: DomainEventMap[E]) => void | Promise<void>;

/**
 * The stored listener type. `never` in parameter position accepts a listener for any single
 * event, which is what lets one map hold all of them; `emit` narrows back to the concrete
 * listener type for the event it is dispatching.
 */
type StoredListener = (payload: never) => void | Promise<void>;

class DomainEventBus {
  private listeners = new Map<DomainEventName, Set<StoredListener>>();

  /** Subscribe. The returned function unsubscribes, so a caller never needs to keep the reference. */
  public on<E extends DomainEventName>(name: E, listener: DomainListener<E>): () => void {
    const set = this.listeners.get(name);
    if (set) set.add(listener);
    else this.listeners.set(name, new Set([listener]));
    return () => this.off(name, listener);
  }

  /** Seldom called directly: `on` already returns this bound to its own listener, which is the
   *  form that cannot accidentally unsubscribe the wrong closure. */
  public off<E extends DomainEventName>(name: E, listener: DomainListener<E>): void {
    const set = this.listeners.get(name);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.listeners.delete(name);
  }

  /**
   * Publish. Returns immediately: the listeners are dispatched on the next check of the
   * immediate queue, after the current request has finished its work.
   */
  public emit<E extends DomainEventName>(name: E, payload: DomainEventMap[E]): void {
    const set = this.listeners.get(name);
    if (!set || set.size === 0) return;
    // Snapshot: a listener is allowed to unsubscribe itself, and mutating the set mid-loop
    // would skip its neighbour.
    const snapshot = [...set];
    setImmediate(() => {
      for (const stored of snapshot) {
        const listener = stored as DomainListener<E>;
        try {
          const result = listener(payload);
          if (result instanceof Promise) result.catch((err) => this.report(name, err));
        } catch (err) {
          this.report(name, err);
        }
      }
    });
  }

  /**
   * The only read-only view of the bus. It answers "did the wiring run", which is otherwise
   * unobservable: `on` hands back an unsubscribe rather than a handle.
   *
   * Nothing in `src/` calls it; `tests/plugins.test.ts` does, twice, asserting that constructing
   * a registry with nothing activated adds no listeners. This comment claimed no caller anywhere
   * until that test was written and then went unamended — a sentence falsified by the change that
   * made it worth having.
   */
  public listenerCount(name: DomainEventName): number {
    return this.listeners.get(name)?.size ?? 0;
  }

  private report(name: DomainEventName, err: unknown): void {
    console.error(`[domainEvents] listener for "${name}" failed:`, err instanceof Error ? err.message : err);
  }

  /** Test hook: a suite that registers listeners must not leak them into the next file. */
  public removeAll(): void {
    this.listeners.clear();
  }
}

/**
 * One bus per process. Subscribers are registered at boot — `wireEconomy` in
 * `src/economy/wiring.ts`, the plugin registry, and the raid service — and nothing subscribes
 * lazily in response to an event. An event emitted before that wiring runs has no listeners
 * and is dropped where `emit` returns early, with nothing logged. That is the best-effort
 * contract the header states rather than an oversight: what must not be lost belongs in the
 * database write, not in a listener.
 */
export const domainEvents = new DomainEventBus();
