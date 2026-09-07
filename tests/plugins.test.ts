/**
 * The plugin registry — the extension point this project points every contributor at.
 *
 * It had no tests at all. Not because nobody wrote them: because they were not writable. The
 * four boot refusals called `process.exit(1)` directly from the constructor, so any test that
 * exercised one would have taken the runner down with it, and `PluginRegistry` was not exported,
 * so there was no way to build one with a catalogue you controlled. The refusals that exist
 * specifically to fail loudly were the four nothing could prove still fired.
 *
 * They throw `PluginBootError` now and the class is exported, so this file can exist. What it
 * covers is the machinery a fork actually depends on: that a misconfiguration is refused rather
 * than silently ignored, that the pack decides what runs, that a broken plugin is cut off, and
 * that a plugin cannot forge a core event.
 *
 * `domainEvents.removeAll()` after each case matters more than it looks. Constructing a registry
 * with anything activated binds hooks on the process-wide bus, so a registry built here outlives
 * its test and would keep receiving events published by later ones — the failure counts would
 * then depend on file order, which is the worst shape a test can have.
 */
import { PluginRegistry, PluginBootError, activeSelection, pluginGuard } from '../src/plugins/registry';
import { PLUGIN_API_VERSION, ServerPlugin } from '../src/plugins/types';
import { domainEvents } from '../src/common/events/domainEvents';
import { eventHub } from '../src/common/sse/eventHub';

/** A minimal valid plugin. Overrides let each case bend exactly one thing. */
const plugin = (over: Partial<ServerPlugin> = {}): ServerPlugin => ({
  name: 'unit-plugin',
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,
  ...over,
});

afterEach(() => {
  domainEvents.removeAll();
  jest.restoreAllMocks();
});

describe('a misconfigured plugin stops the boot rather than running nothing', () => {
  it('refuses a selection naming a plugin that is not in the catalogue', () => {
    expect(() => new PluginRegistry([plugin()], ['not-in-catalogue'])).toThrow(PluginBootError);
    // The message has to name the fix, not just the fault: the person reading it at boot has to
    // know that CATALOG is the thing to edit.
    expect(() => new PluginRegistry([plugin()], ['not-in-catalogue'])).toThrow(/CATALOG/);
  });

  it('refuses two plugins claiming one name, because they would share a route prefix', () => {
    const catalogue = [plugin(), plugin({ version: '2.0.0' })];
    expect(() => new PluginRegistry(catalogue, [])).toThrow(/two plugins are named "unit-plugin"/);
  });

  it('checks for duplicates over the whole catalogue, even when nothing is activated', () => {
    // The empty selection is the point. A name collision breaks the asset and route namespace
    // whether or not either plugin runs, so it cannot be conditional on activation.
    expect(() => new PluginRegistry([plugin(), plugin()], [])).toThrow(PluginBootError);
  });

  it('refuses a plugin built against a different contract version', () => {
    const stale = plugin({ apiVersion: (PLUGIN_API_VERSION + 1) as typeof PLUGIN_API_VERSION });
    expect(() => new PluginRegistry([stale], ['unit-plugin'])).toThrow(
      new RegExp(`targets API version ${PLUGIN_API_VERSION + 1}`)
    );
  });

  it('refuses a name that is not safe as a route segment and a directory name', () => {
    // The name is used verbatim in `/api/v1/plugins/<name>` and in a filesystem path, so a
    // traversal segment here would be a traversal in both.
    const unsafe = plugin({ name: '../etc' });
    expect(() => new PluginRegistry([unsafe], ['../etc'])).toThrow(/not a safe route and directory name/);
  });

  it('activates a plugin named twice only once, because a list of names is a set', () => {
    const registry = new PluginRegistry([plugin()], ['unit-plugin', 'unit-plugin']);
    expect(registry.activated().map((p) => p.name)).toEqual(['unit-plugin']);
  });
});

describe('the content pack decides what runs, and the environment can only narrow it', () => {
  it('uses the pack list when PLUGINS is unset', () => {
    expect(activeSelection(['a', 'b'], '')).toEqual(['a', 'b']);
  });

  it('narrows to the intersection when PLUGINS is set', () => {
    expect(activeSelection(['a', 'b', 'c'], 'a,c')).toEqual(['a', 'c']);
  });

  it('preserves the pack order rather than the environment order', () => {
    // Routes and assets mount in activation order, so the order has to come from one place.
    expect(activeSelection(['a', 'b', 'c'], 'c,a')).toEqual(['a', 'c']);
  });

  it('refuses a PLUGINS entry the pack does not list, instead of silently ignoring it', () => {
    // This is the whole defect this change exists to remove. Before, activation came only from
    // PLUGINS and the pack's array was read by nobody, so a fork that followed the documentation
    // got no plugin and no error. Turning that around must not reintroduce a silent no-op in the
    // other direction.
    expect(() => activeSelection(['a'], 'b')).toThrow(PluginBootError);
    expect(() => activeSelection(['a'], 'b')).toThrow(/narrows the pack's list; it cannot add to it/);
  });

  it('treats whitespace and empty entries as absent', () => {
    expect(activeSelection(['a'], '  ')).toEqual(['a']);
    expect(activeSelection([' a ', ''], '')).toEqual(['a']);
  });

  it('binds no bus listeners at all when nothing is activated', () => {
    const before = domainEvents.listenerCount('checkin.completed');
    new PluginRegistry([plugin()], []);
    expect(domainEvents.listenerCount('checkin.completed')).toBe(before);
  });
});

describe('a broken plugin is cut off, and an intermittent one is not', () => {
  /** Publish a `checkin.completed` and wait for the bus's `setImmediate` plus the hook. */
  const fireCheckIn = async (): Promise<void> => {
    domainEvents.emit('checkin.completed', {
      accountId: 'a1',
      shiftId: 's1',
      registrationId: 'r1',
      at: new Date(),
    });
    // Two turns: one for the bus's setImmediate, one for the hook's own promise chain.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  it('disables after five consecutive failures and not before', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = new PluginRegistry(
      [plugin({ hooks: { onCheckIn: () => { throw new Error('boom'); } } })],
      ['unit-plugin']
    );

    for (let i = 0; i < 4; i += 1) await fireCheckIn();
    // Four is deliberately asserted. A test that only checks the fifth cannot tell a
    // five-strike rule from a one-strike rule.
    expect(registry.enabled('unit-plugin')).toBe(true);
    expect(registry.state('unit-plugin')?.failures).toBe(4);

    await fireCheckIn();
    expect(registry.enabled('unit-plugin')).toBe(false);
    expect(registry.state('unit-plugin')?.disabledReason).toMatch(/onCheckIn failed 5 times consecutively/);
  });

  it('resets the count on a success, so a plugin that blips never trips', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let failNext = true;
    const registry = new PluginRegistry(
      [plugin({ hooks: { onCheckIn: () => { if (failNext) throw new Error('blip'); } } })],
      ['unit-plugin']
    );

    // Four failures, one success, four more failures. Under a cumulative count this is eight
    // and the plugin would be gone; under a consecutive count it is still running.
    for (let i = 0; i < 4; i += 1) await fireCheckIn();
    failNext = false;
    await fireCheckIn();
    expect(registry.state('unit-plugin')?.failures).toBe(0);

    failNext = true;
    for (let i = 0; i < 4; i += 1) await fireCheckIn();
    expect(registry.enabled('unit-plugin')).toBe(true);
  });

  it('answers 404 on a disabled plugin rather than unmounting its router', () => {
    const registry = new PluginRegistry([plugin()], ['unit-plugin']);
    registry.disable('unit-plugin', 'test');
    const guard = pluginGuard('unit-plugin');
    const next = jest.fn();
    // Express cannot remove a router at runtime, so the guard is the whole mechanism: it must
    // refuse rather than call through.
    guard({} as never, {} as never, next as never);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('a plugin cannot impersonate the core', () => {
  it('prefixes every broadcast with PLUGIN_<NAME>_', () => {
    const registry = new PluginRegistry([plugin({ name: 'my-thing' })], ['my-thing']);
    const sent = jest.spyOn(eventHub, 'broadcast').mockImplementation(() => undefined);

    // `SOS_ESCALATED` is the worst case on purpose: unprefixed it lands on `announce`, which is
    // readable without a session, and sets off the floor.
    registry.context('my-thing').broadcast('SOS_ESCALATED', { hoax: true });

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0].type).toBe('PLUGIN_MY_THING_SOS_ESCALATED');
  });

  it('drops a broadcast from a plugin that has been disabled', () => {
    const registry = new PluginRegistry([plugin()], ['unit-plugin']);
    const sent = jest.spyOn(eventHub, 'broadcast').mockImplementation(() => undefined);
    const context = registry.context('unit-plugin');

    registry.disable('unit-plugin', 'test');
    context.broadcast('ANYTHING', {});

    // Asserting on the *type*, not on the call count. `disable()` broadcasts `PLUGIN_DISABLED`
    // itself — that is the point of it, so somebody sees a plugin go dark — and a bare
    // `not.toHaveBeenCalled()` catches that instead, which is what the first version of this
    // test did. The claim being made is narrower: nothing the plugin itself published got out.
    const fromPlugin = sent.mock.calls.filter((call) => call[0].type.startsWith('PLUGIN_UNIT_PLUGIN_'));
    expect(fromPlugin).toHaveLength(0);
    expect(sent.mock.calls.map((call) => call[0].type)).toEqual(['PLUGIN_DISABLED']);

    // A handler already running when the plugin was disabled still holds its context, so
    // `enabled()` is what a long-running handler is meant to check — and `broadcast` checks it
    // too, so a handler that does not is still contained.
    expect(context.enabled()).toBe(false);
  });
});
