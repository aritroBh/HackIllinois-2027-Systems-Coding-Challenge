/**
 * Lite mode's geolocation watch and its claim on the HUD.
 *
 * `public/lite.js` is a browser file with no build step, so it is loaded here the way the page
 * loads it — evaluated against a hand-built `window` — rather than imported. The stubs are
 * deliberately thin: only what the file actually touches, so a new dependency shows up as a
 * failure here instead of passing silently.
 *
 * Both tests exist because of bugs that shipped in the commit that added the watch, and both
 * were verified to fail before the fix:
 *
 *  - `mount()` started a `watchPosition` while `game.js` could already be running one of its
 *    own. Entering lite mode does not stop the renderer's walk, so a user who was walking and
 *    then chose the flat map had two watches and two presence publishers, of which `unmount()`
 *    stopped one. The comment in lite.js asserted "They never run at once".
 *  - `unmount()` has to actually clear the watch, or choosing the 3D map back leaks it.
 */
import fs from 'fs';
import path from 'path';

type Watch = { ok: (p: unknown) => void; err: (e: unknown) => void } | null;

/** Everything `lite.js` reaches for, and nothing else. */
function harness() {
  const watches: Watch[] = [];
  let stopWalkCalls = 0;
  const nearest = { innerHTML: '' };

  const makeEl = (): any => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    setAttribute() {}, getAttribute: () => null,
    append() {}, appendChild() {}, addEventListener() {},
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    children: [] as unknown[], innerHTML: '', textContent: '',
  });

  const byId: Record<string, any> = {
    'campus-viewport': makeEl(),
    'campus-3d-canvas': makeEl(),
    'hud-nearest': nearest,
  };

  const doc: any = {
    readyState: 'complete', body: makeEl(), documentElement: makeEl(),
    createElement: makeEl,
    getElementById: (id: string) => byId[id] ?? null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };

  const Nexus: any = {
    flags: {}, emit() {}, onEvent() {}, registerAction() {}, showTab() {},
    presence: { publish() {} },
  };

  const win: any = {
    Nexus, document: doc, location: { search: '' },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {
      geolocation: {
        watchPosition(ok: any, err: any) { watches.push({ ok, err }); return watches.length; },
        clearWatch(id: number) { watches[id - 1] = null; },
      },
    },
    // Stands in for game.js. `stopWalk` is the handle lite.js uses to close the other watch.
    game: { stopWalk() { stopWalkCalls++; return true; } },
    addEventListener() {}, devicePixelRatio: 1, innerHeight: 900, console,
    setInterval: () => 1 as unknown as NodeJS.Timeout, clearInterval() {},
  };
  win.window = win;

  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'lite.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'navigator', 'localStorage', 'location', 'setInterval', 'clearInterval', 'console', src)(
    win, doc, win.navigator, win.localStorage, win.location, win.setInterval, win.clearInterval, console,
  );

  return {
    lite: Nexus.lite as { enable: (why?: string) => void; disable: () => void; active: boolean },
    live: () => watches.filter(Boolean).length,
    stopWalkCalls: () => stopWalkCalls,
    nearest,
    hackStops: (list: unknown[]) => { win.hackStopsCache = list; },
    fix: (lat: number, lng: number) => watches.filter(Boolean)[0]?.ok({ coords: { latitude: lat, longitude: lng, accuracy: 5 } }),
  };
}

describe('lite mode owns exactly one location watch', () => {
  it('closes the renderer\'s walk before opening its own', () => {
    const h = harness();
    h.lite.enable('test');
    expect(h.stopWalkCalls()).toBe(1);
    expect(h.live()).toBe(1);
  });

  it('clears its watch on the way back to the 3D map', () => {
    const h = harness();
    h.lite.enable('test');
    expect(h.live()).toBe(1);
    h.lite.disable();
    expect(h.live()).toBe(0);
  });

  it('does not open a second watch when mounted twice', () => {
    const h = harness();
    h.lite.enable('test');
    h.lite.enable('test again');   // `apply` is a no-op when the state already matches
    expect(h.live()).toBe(1);
  });
});

describe('the nearest-HackStop readout', () => {
  it('says it is waiting before any fix arrives, rather than showing nothing', () => {
    const h = harness();
    h.lite.enable('test');
    expect(h.nearest.innerHTML).toContain('NEAREST HACKSTOP');
    expect(h.nearest.innerHTML).toContain('Waiting for a location fix');
  });

  it('names the closest stop and the distance to it once a fix lands', () => {
    const h = harness();
    // Siebel is ~200 m from the Quad; Grainger is much further.
    h.hackStops([
      { name: 'Siebel Atrium', latitude: 40.1138, longitude: -88.2249 },
      { name: 'Grainger Library', latitude: 40.1122, longitude: -88.2270 },
    ]);
    h.lite.enable('test');
    h.fix(40.1139, -88.2250);
    expect(h.nearest.innerHTML).toContain('Siebel Atrium');
    expect(h.nearest.innerHTML).not.toContain('Grainger');
    // Within a few metres of the stop, so it must offer the spin rather than a walking distance.
    expect(h.nearest.innerHTML).toContain('in range');
  });

  it('asks the reader to walk closer when they are outside the 75 m geofence', () => {
    const h = harness();
    h.hackStops([{ name: 'Siebel Atrium', latitude: 40.1138, longitude: -88.2249 }]);
    h.lite.enable('test');
    h.fix(40.1180, -88.2249);          // ~470 m north
    expect(h.nearest.innerHTML).toContain('walk');
    expect(h.nearest.innerHTML).not.toContain('in range');
  });

  it('escapes a stop name, because the names come from the API and this writes innerHTML', () => {
    const h = harness();
    h.hackStops([{ name: '<img src=x onerror=alert(1)>', latitude: 40.1138, longitude: -88.2249 }]);
    h.lite.enable('test');
    h.fix(40.1139, -88.2250);
    expect(h.nearest.innerHTML).not.toContain('<img');
    expect(h.nearest.innerHTML).toContain('&lt;img');
  });
});
