/**
 * The plugin registry: which plugins exist, which are switched on, and when one is cut off.
 *
 * **Static catalogue, dynamic activation.** `CATALOG` is a literal array of imported
 * modules, so `tsc` sees every plugin and a fork that breaks the contract fails the build
 * instead of the event. `PLUGINS` (comma-separated names) selects which of them are
 * activated at boot. An unknown name is a boot failure, not a warning: a typo that silently
 * runs nothing is precisely the misconfiguration that surfaces at 3 a.m.
 *
 * **Hooks are fire-and-forget with a leash.** Each subscribes to the domain bus, runs with a
 * 2 second timeout, and never propagates a failure back to the operation that published the
 * event. A volunteer's check-in must not fail because a plugin's HTTP call to a scoreboard
 * hung. Five *consecutive* failures (throw or timeout, counted per plugin rather than per
 * hook) disable the plugin and broadcast `PLUGIN_DISABLED`; one success resets the count, so
 * a plugin that fails intermittently keeps running and one that is simply broken stops.
 *
 * Be honest about what the timeout buys: it stops the registry *waiting*, it does not cancel
 * the plugin's work. A hook that opens a socket and never closes it still leaks. The timeout
 * bounds the registry's own exposure, and the disable rule bounds how long a bad plugin gets
 * to keep doing that.
 *
 * **Disabling is a guard, not an unmount.** Express cannot remove a router from a running
 * app, so every plugin route and every plugin asset is mounted behind `pluginGuard(name)`,
 * which answers 404 the moment the plugin is disabled. That is why disabling is instant and
 * total without touching the middleware stack.
 *
 * **Payload adaptation lives here.** Each binding maps the raw bus payload into the shape
 * declared in `types.ts`. That single boundary is the only place that knows a core event's
 * field names, so renaming one is a change to this file and not to every fork.
 */
import type { RequestHandler } from 'express';
import { domainEvents } from '../common/events/domainEvents';
import type { DomainEventMap, DomainEventName } from '../common/events/domainEvents';
import { eventHub } from '../common/sse/eventHub';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { env } from '../config/env';
import {
  CheckInHookEvent,
  GymCapturedHookEvent,
  HookName,
  PLUGIN_API_VERSION,
  PLUGIN_NAME_PATTERN,
  PluginContext,
  RegistrationHookEvent,
  SOSResolvedHookEvent,
  ServerPlugin,
  ServerPluginHooks,
  SpinHookEvent,
} from './types';
import { helloNexusPlugin } from '../../plugins/hello-nexus';

/** Every plugin that ships in this tree. Add a fork's plugin here; `PLUGINS` turns it on. */
const CATALOG: readonly ServerPlugin[] = [helloNexusPlugin];

/**
 * Two seconds is a long time for a hook and a short time for the check-in desk. Anything a
 * plugin genuinely needs to do — a webhook, a write — fits inside it on a working network, and
 * a hook that does not fit was going to be a problem anyway. It bounds the registry's wait,
 * not the plugin's work: see the header.
 */
const HOOK_TIMEOUT_MS = 2_000;
/**
 * Consecutive, not cumulative, and that is the whole tuning. A plugin whose upstream blips
 * once an hour never trips this because a success resets the count; a plugin that is simply
 * broken trips it within five events, which at an event's rate is seconds. A cumulative count
 * would eventually disable everything that has ever failed.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** What the registry tracks per plugin. Mutable and in memory only — nothing here survives a restart, so a disabled plugin comes back enabled on the next boot, which is the intended way to retry one. */
export interface PluginState {
  plugin: ServerPlugin;
  enabled: boolean;
  /** Consecutive hook failures. Reset by any success. */
  failures: number;
  disabledReason: string | null;
}

/**
 * Bus payloads carry `Date`; the hook contract carries epoch milliseconds, because a plugin
 * may be handed its event across a JSON boundary later and a number survives that.
 */
const msOf = (at: Date): number => at.getTime();

/**
 * Races `work` against a timer that is unref'd (a hook's leash must never be the reason the
 * process stays alive) and always cleared, so a fast hook leaves nothing behind.
 */
function withTimeout(work: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const leash = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    timer.unref();
  });
  return Promise.race([work, leash]).finally(() => clearTimeout(timer));
}

class PluginRegistry {
  private readonly states = new Map<string, PluginState>();
  /** Activation order, which is `PLUGINS` order. Routes and assets mount in it. */
  private readonly order: string[] = [];

  /**
   * Validate the selection and activate what it names, or refuse to boot.
   *
   * Every failure here is `process.exit(1)` rather than a warning, and the reasoning is the
   * same each time: a plugin that is configured and silently not running is the
   * misconfiguration nobody notices until the feature is missing at 3 a.m. A name that is not
   * in the catalogue, a name that is not a safe route and directory segment, a plugin built
   * against a different contract version, two plugins claiming one name — all of them stop the
   * process while somebody is still watching the console.
   *
   * The duplicate-name check runs over the *catalogue*, before selection, because two plugins
   * sharing a name share a route prefix, an asset prefix and a state entry; there is no
   * sensible winner. Being named twice in `PLUGINS` is different and is not an error — it
   * activates once, because a comma-separated list is a set.
   *
   * Hooks are bound only when something was activated, so a deployment running no plugins adds
   * no bus listeners at all.
   */
  constructor(catalog: readonly ServerPlugin[], selection: string) {
    const known = new Map<string, ServerPlugin>();
    for (const plugin of catalog) {
      if (known.has(plugin.name)) {
        console.error(`❌ Refusing to boot: two plugins are named "${plugin.name}".`);
        process.exit(1);
      }
      known.set(plugin.name, plugin);
    }

    const wanted = selection
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);

    for (const name of wanted) {
      const plugin = known.get(name);
      if (!plugin) {
        console.error(
          `❌ Refusing to boot: PLUGINS names "${name}", which is not in the catalogue (${[...known.keys()].join(', ') || 'empty'}).`
        );
        process.exit(1);
      }
      if (!PLUGIN_NAME_PATTERN.test(plugin.name)) {
        console.error(`❌ Refusing to boot: plugin name "${plugin.name}" is not a safe route and directory name.`);
        process.exit(1);
      }
      if (plugin.apiVersion !== PLUGIN_API_VERSION) {
        console.error(
          `❌ Refusing to boot: plugin "${plugin.name}" targets API version ${plugin.apiVersion}; this server speaks ${PLUGIN_API_VERSION}.`
        );
        process.exit(1);
      }
      if (this.states.has(name)) continue; // named twice in PLUGINS; activate once
      this.states.set(name, { plugin, enabled: true, failures: 0, disabledReason: null });
      this.order.push(name);
    }

    if (this.order.length > 0) this.bindHooks();
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  /** The single question every plugin route and asset asks before doing any work. */
  public enabled(name: string): boolean {
    return this.states.get(name)?.enabled === true;
  }

  /** Activated plugins in `PLUGINS` order, disabled ones included (their routes still exist). */
  public activated(): ServerPlugin[] {
    return this.order.map((name) => this.states.get(name)!.plugin);
  }

  /** The mutable record itself, for the admin view. Callers get the live object, not a copy — read it, do not write it. */
  public state(name: string): PluginState | undefined {
    return this.states.get(name);
  }

  /** Shape for `/health` and the manifest: what is on, what fell over, and why. */
  public stats(): Array<{ name: string; version: string; enabled: boolean; failures: number; reason: string | null }> {
    return this.order.map((name) => {
      const s = this.states.get(name)!;
      return {
        name: s.plugin.name,
        version: s.plugin.version,
        enabled: s.enabled,
        failures: s.failures,
        reason: s.disabledReason,
      };
    });
  }

  /**
   * Build the capability object a plugin's routes are handed.
   *
   * Everything on it is a closure over this registry rather than a reference to anything a
   * plugin could reach on its own — that is what makes the contract in `types.ts` enforceable
   * rather than advisory. Two of them re-check `enabled()` at call time rather than at
   * construction: a plugin holds its context for the life of the process, so a disable that
   * happens afterwards has to be visible through the object it is already holding.
   *
   * The `PLUGIN_<NAME>_` prefix on `broadcast` is a namespace, not decoration. Without it a
   * plugin could publish `SOS_ESCALATED` on the same hub the war room listens to and set off
   * the floor. Hyphens become underscores because a plugin name may contain them and an event
   * type by convention may not.
   *
   * A context is minted for a name that was never activated (version falls back to `0.0.0`)
   * rather than throwing, because the guard is what refuses those requests and a throw here
   * would move that decision into route construction.
   */
  public context(name: string): PluginContext {
    const state = this.states.get(name);
    const version = state?.plugin.version ?? '0.0.0';
    return {
      name,
      version,
      log: (message: string, ...rest: unknown[]) => console.log(`[plugin:${name}] ${message}`, ...rest),
      // The prefix is not decoration: without it a plugin could broadcast `SOS_ESCALATED`
      // and set off the floor.
      broadcast: (type: string, data: unknown) => {
        if (!this.enabled(name)) return;
        eventHub.broadcast({ type: `PLUGIN_${name.toUpperCase().replace(/-/g, '_')}_${type}`, data });
      },
      enabled: () => this.enabled(name),
    };
  }

  // -------------------------------------------------------------------------
  // Disabling
  // -------------------------------------------------------------------------

  /**
   * Switch a plugin off, permanently for this process.
   *
   * Idempotent by the `!state.enabled` guard, and that guard is doing real work: `disable` is
   * reached from three unrelated places — a missing asset at boot, a `registerRoutes` that
   * threw, and the consecutive-failure rule — and a plugin that trips two of them should not
   * broadcast `PLUGIN_DISABLED` twice, because the dashboard renders that as an incident.
   * The first reason wins, which is also the useful one: it names what actually broke first.
   *
   * There is no `enable`. Re-enabling is a restart, deliberately — a plugin that failed five
   * times running has not been fixed by being asked again, and the operator's next step is to
   * look at why.
   */
  public disable(name: string, reason: string): void {
    const state = this.states.get(name);
    if (!state || !state.enabled) return;
    state.enabled = false;
    state.disabledReason = reason;
    console.error(`[plugin:${name}] disabled: ${reason}`);
    eventHub.broadcast({
      type: 'PLUGIN_DISABLED',
      data: { name, version: state.plugin.version, reason },
    });
  }

  /**
   * Count one failure against the plugin, and disable it if that was the fifth in a row.
   *
   * The count lives on the plugin, not the hook, so a plugin failing alternately in two
   * different hooks still trips — the thing that is broken is the plugin, and a per-hook count
   * would let it fail indefinitely by spreading the failures around.
   *
   * The log line carries the running count as well as the message, so the operator can see a
   * plugin walking towards its limit rather than only the moment it arrives.
   */
  private recordFailure(state: PluginState, hook: HookName, error: unknown): void {
    state.failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[plugin:${state.plugin.name}] ${hook} failed (${state.failures}/${MAX_CONSECUTIVE_FAILURES}): ${message}`);
    if (state.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.disable(state.plugin.name, `${hook} failed ${state.failures} times consecutively: ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Hook dispatch
  // -------------------------------------------------------------------------

  /**
   * The bus vocabulary in one place. Each binding names a domain event, the hook it feeds,
   * and how the bus payload becomes the shape `types.ts` promises a plugin. Renaming a core
   * event or a field is a change to this file only, which is the point: a fork's plugins are
   * written against the hook contract, never against the services.
   *
   * Arrival and departure both feed `onCheckIn`, distinguished by `direction`, because a
   * plugin that cares about one almost always cares about the other.
   */
  private bindHooks(): void {
    this.subscribe(
      'checkin.completed',
      'onCheckIn',
      (p): CheckInHookEvent => ({
        accountId: p.accountId,
        shiftId: p.shiftId,
        direction: 'IN',
        registrationId: p.registrationId ?? null,
        hoursServed: null,
        at: msOf(p.at),
      }),
      (hooks) => hooks.onCheckIn
    );

    this.subscribe(
      'checkout.completed',
      'onCheckIn',
      (p): CheckInHookEvent => ({
        accountId: p.accountId,
        shiftId: p.shiftId,
        direction: 'OUT',
        registrationId: null,
        hoursServed: p.hoursServed,
        at: msOf(p.at),
      }),
      (hooks) => hooks.onCheckIn
    );

    this.subscribe(
      'sos.resolved',
      'onSOSResolved',
      (p): SOSResolvedHookEvent => ({
        ticketId: p.ticketId,
        category: p.category,
        venueKey: p.venueKey ?? null,
        resolverId: p.resolverId ?? null,
        at: Date.now(),
      }),
      (hooks) => hooks.onSOSResolved
    );

    this.subscribe(
      'gym.captured',
      'onGymCaptured',
      (p): GymCapturedHookEvent => ({
        gymId: p.gymId,
        faction: p.faction,
        accountId: p.accountId,
        at: Date.now(),
      }),
      (hooks) => hooks.onGymCaptured
    );

    this.subscribe(
      'hackstop.spun',
      'onSpin',
      (p): SpinHookEvent => ({
        beaconId: p.beaconId,
        accountId: p.accountId,
        awardedKarma: p.awardedKarma,
        at: Date.now(),
      }),
      (hooks) => hooks.onSpin
    );

    this.subscribe(
      'registration.created',
      'onRegistration',
      (p): RegistrationHookEvent => ({
        accountId: p.accountId,
        shiftId: p.shiftId,
        waitlisted: p.waitlisted,
        at: Date.now(),
      }),
      (hooks) => hooks.onRegistration
    );
  }

  /**
   * One bus subscription serving every activated plugin. The adapter runs once per event
   * rather than once per plugin, and the dispatch promise is deliberately not awaited: the
   * publisher is a domain service that has already committed its write.
   *
   * The subscription is never torn down. A disabled plugin is filtered out here instead, so
   * that re-enabling one is a flag flip rather than a re-subscription.
   */
  private subscribe<N extends DomainEventName, E>(
    event: N,
    hook: HookName,
    adapt: (payload: DomainEventMap[N]) => E,
    pick: (hooks: ServerPluginHooks) => ((event: E) => void | Promise<void>) | undefined
  ): void {
    domainEvents.on(event, (payload) => {
      const listeners: Array<[PluginState, (event: E) => void | Promise<void>]> = [];
      for (const state of this.states.values()) {
        if (!state.enabled) continue;
        const hooks = state.plugin.hooks;
        if (!hooks) continue;
        const fn = pick(hooks);
        if (fn) listeners.push([state, fn.bind(hooks)]);
      }
      if (listeners.length === 0) return;
      const adapted = adapt(payload);
      for (const [state, fn] of listeners) void this.dispatch(state, hook, () => fn(adapted));
    });
  }

  /**
   * Run one hook under the leash and record the outcome.
   *
   * This promise is never awaited by a publisher, so it must not reject: an unhandled
   * rejection from a plugin would crash the process that just committed somebody's check-in.
   * Every path through here resolves, and the only record of a failure is the counter and the
   * log.
   *
   * A timeout and a throw are counted identically. From the registry's side they are the same
   * event — the plugin did not finish — and treating a slow plugin more gently than a broken
   * one would keep the worse of the two running.
   */
  private async dispatch(state: PluginState, hook: HookName, run: () => void | Promise<void>): Promise<void> {
    try {
      // `run()` is called inside the try so a hook that throws synchronously is counted the
      // same as one whose promise rejects.
      await withTimeout(Promise.resolve(run()), HOOK_TIMEOUT_MS, `exceeded the ${HOOK_TIMEOUT_MS} ms budget`);
      state.failures = 0;
    } catch (error) {
      this.recordFailure(state, hook, error);
    }
  }
}

export const pluginRegistry = new PluginRegistry(CATALOG, env.PLUGINS);

/**
 * The 404 gate every plugin route and asset sits behind. A disabled plugin's URLs must not
 * merely fail. They must be indistinguishable from URLs that were never mounted, so a client
 * falls back to the core experience instead of retrying a broken feature.
 */
export function pluginGuard(name: string): RequestHandler {
  return (_req, _res, next) => {
    if (pluginRegistry.enabled(name)) {
      next();
      return;
    }
    next(ApiError.notFound(`Plugin "${name}" is not available.`, ErrorCode.NOT_FOUND));
  };
}
