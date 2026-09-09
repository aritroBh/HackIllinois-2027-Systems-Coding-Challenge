/**
 * The server plugin contract (plan §A8).
 *
 * A plugin is a plain object, not a class and not a package: a fork adds a directory under
 * `plugins/`, exports one of these, adds it to `CATALOG`, and names it in its pack's
 * `event.json` under `plugins`. There is no dynamic
 * `require` anywhere in the loader, so every plugin is type-checked with the rest of the
 * codebase and a broken one fails `npm run lint` rather than the event.
 *
 * Three things a plugin may do, in rising order of blast radius:
 *
 *  1. **Hooks** react to a domain event after it has been committed. They cannot veto the
 *     operation, cannot mutate its result, and are never awaited by the caller. A hook that
 *     is slow or throws is the plugin's problem, not the check-in desk's. See the timeout
 *     and the disable rule in `registry.ts`.
 *  2. **Routes** are mounted under `/api/v1/plugins/<name>` behind the registry guard.
 *     They inherit the whole API stack: identity, rate limiting, CSRF, the error handler.
 *  3. **Client assets** are plain browser scripts served under `/dashboard/plugins/<name>/`
 *     and loaded by the shell. They see the same `window.Nexus` registry as `app.js`.
 *
 * `apiVersion` is the compatibility gate. It is the version of *this file*, and a plugin
 * declaring anything other than 1 is refused at boot rather than run against a contract it
 * was not written for.
 */
import type { Router } from 'express';

/** The contract version this file defines. Bumped only when a hook signature changes. */
export const PLUGIN_API_VERSION = 1 as const;

/**
 * A plugin's name is also its directory name (`plugins/<name>`), its route prefix and its
 * asset prefix, so it is constrained to what is safe in all three.
 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Hook payloads.
 *
 * Each is adapted from a domain event in `registry.ts`, which is the only place that knows
 * the bus field names. A plugin is written against these shapes and is therefore insulated
 * from a rename inside a service. Ids are strings and times are epoch milliseconds, never
 * `ObjectId` or `Date`, so a plugin never depends on Mongoose and its event survives being
 * forwarded as JSON.
 *
 * `at` is the moment the event describes where the bus carries one, and the moment the
 * registry dispatched the hook otherwise. The two differ by a tick.
 *
 * Like the bus, a payload is a notification and not a snapshot: it carries the ids a hook
 * needs to do its own reads, because by the time it runs the documents may have moved on.
 */

export interface CheckInHookEvent {
  accountId: string;
  shiftId: string;
  /** Whether this was the arrival or the departure scan. */
  direction: 'IN' | 'OUT';
  /** The registration the arrival was matched to, null when there was none and on departure. */
  registrationId: string | null;
  /** Hours credited by the departure scan; null on arrival. */
  hoursServed: number | null;
  at: number;
}

/** Fired when an SOS ticket closes: what, where, who closed it, and when. */
export interface SOSResolvedHookEvent {
  ticketId: string;
  category: string;
  venueKey: string | null;
  /** Account that closed the ticket, null when it closed without one (auto-resolve, sweep). */
  resolverId: string | null;
  at: number;
}

/** Fired when a gym changes hands: which gym, to whom, by whom, and when. */
export interface GymCapturedHookEvent {
  gymId: string;
  /** The faction that now holds it. */
  faction: string;
  accountId: string;
  at: number;
}

/** Fired when a HackStop spin pays: which beacon, to whom, how much, and when. */
export interface SpinHookEvent {
  beaconId: string;
  accountId: string;
  awardedKarma: number;
  at: number;
}

/** Fired when a reservation settles: who, which shift, seat or queue place, and when. */
export interface RegistrationHookEvent {
  accountId: string;
  shiftId: string;
  /** True when the shift was full and the account went onto the waitlist instead. */
  waitlisted: boolean;
  at: number;
}

/** The five events a plugin may observe; every member is optional. */
export interface ServerPluginHooks {
  onCheckIn?(event: CheckInHookEvent): void | Promise<void>;
  onSOSResolved?(event: SOSResolvedHookEvent): void | Promise<void>;
  onGymCaptured?(event: GymCapturedHookEvent): void | Promise<void>;
  onSpin?(event: SpinHookEvent): void | Promise<void>;
  onRegistration?(event: RegistrationHookEvent): void | Promise<void>;
}

/** Every hook name, so the registry can iterate them without a cast. */
export const HOOK_NAMES = ['onCheckIn', 'onSOSResolved', 'onGymCaptured', 'onSpin', 'onRegistration'] as const;

/** One of the five hook names; the registry iterates these to invoke plugins. */
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * What a plugin is handed when its routes are registered.
 *
 * Deliberately small. A plugin gets a namespaced logger, a way to push to the live stream,
 * and a way to ask whether it is still enabled. It does not get the Express app, the
 * Mongoose connection, or the event hub itself. Anything it can reach, it can break for
 * everyone.
 */
export interface PluginContext {
  readonly name: string;
  readonly version: string;
  /** Prefixed with `[plugin:<name>]` so a noisy plugin is identifiable in the logs. */
  log(message: string, ...rest: unknown[]): void;
  /**
   * Publish to the SSE hub. The type is prefixed with `PLUGIN_<NAME>_` so a plugin cannot
   * forge a core event, and the payload lands on `ops` like any other unknown type.
   */
  broadcast(type: string, data: unknown): void;
  /** False once the registry has disabled this plugin; a long-running handler should check it. */
  enabled(): boolean;
}

/** A server plugin: identity, declared API version, optional hooks, optional routes. */
export interface ServerPlugin {
  readonly name: string;
  /** Free-form, shown in the manifest. Semver by convention, not enforced. */
  readonly version: string;
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly hooks?: ServerPluginHooks;
  /**
   * Called once at boot with a fresh router, mounted at `/api/v1/plugins/<name>`. The
   * router is created even when this is absent, so the guard exists either way.
   */
  registerRoutes?(router: Router, ctx: PluginContext): void;
  /**
   * Browser scripts to serve, as paths relative to `plugins/<name>/public/`. Each is served
   * at `/dashboard/plugins/<name>/<path>` and appears in the manifest with the SHA-256 of
   * the file as it was on disk at boot. A declared file that is missing disables the plugin
   * rather than leaving the client half-loaded.
   */
  readonly clientAssets?: readonly string[];
}

/** One asset as the manifest reports it. `sha256` is hex, computed at boot. */
export interface PluginAssetEntry {
  url: string;
  sha256: string;
}

/** One installed plugin as the manifest reports it: name, version, and client assets. */
export interface PluginManifestEntry {
  name: string;
  version: string;
  assets: PluginAssetEntry[];
}
