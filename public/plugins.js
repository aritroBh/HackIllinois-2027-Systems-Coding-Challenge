/**
 * Client plugin loader (plan §C1, §A8).
 *
 * Fetches `GET /api/v1/plugins` — the one manifest the server publishes — and injects each
 * declared asset as a same-origin `<script>` pinned by its sha256 through Subresource
 * Integrity. The digest is computed on the server from the file on disk at boot, so a
 * script that has changed since then simply does not run: the browser refuses it and we log
 * `PLUGIN_ASSET_MISMATCH` rather than executing something the manifest did not describe.
 *
 * Two things this deliberately does not do.
 *
 * It never loads from another origin. The content security policy is `script-src 'self'`,
 * so a cross-origin plugin script would be blocked anyway, but the loader refuses one
 * before the browser has to, and says why. Plugins are first-party code **in this
 * repository**, reviewed like the rest of it; see docs/PLUGINS.md.
 *
 * Not "or in a content pack", which this said until now and which is not a thing that works.
 * `PluginRegistry`'s `CATALOG` is a literal array of static imports and nothing scans a
 * filesystem: a pack's `event.json` carries a `plugins` array, but those are *names* selecting
 * from that catalogue, not code the pack ships. A fork that read this sentence and bundled a
 * plugin into its pack would get silence — no error, no plugin — which is the worst of the
 * three possible outcomes.
 *
 * It never retries. A plugin that fails to load leaves the core dashboard exactly as it
 * was, which is the right outcome: an optional feature is not worth a reload loop, and a
 * digest mismatch is a reason to look at the deploy rather than to try again.
 */
(function () {
  'use strict';

  const N = window.Nexus;
  if (!N) { console.error('[plugins] nexus.js must load first'); return; }

  const loaded = new Map(); // name → { version, assets: [url] }
  const failed = [];

  N.plugins = { loaded, failed, list: () => [...loaded.entries()].map(([name, v]) => ({ name, ...v })) };

  /**
   * Subresource Integrity wants base64; the manifest publishes hex.
   *
   * Those are two encodings of the same thirty-two bytes and the browser accepts exactly one
   * of them. Handing it the hex string is not a soft failure: the digest never matches, every
   * plugin script is refused, and the only symptom is a plugin that silently does not load —
   * which is indistinguishable from a plugin that was never enabled. That is precisely how
   * this shipped, and how it survived a passing plugin test suite, because the server side was
   * right and the browser side was never exercised.
   *
   * Hex stays in the manifest deliberately. It is what `sha256sum` prints, so an operator can
   * compare what the server says it is serving against the file on disk without a conversion
   * step; the conversion belongs here, where the browser's requirement is.
   *
   * Returns null for anything that is not 64 hex characters, so a malformed digest is a
   * refusal rather than an `integrity` attribute the browser quietly ignores.
   */
  function hexToBase64(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
    let binary = '';
    for (let i = 0; i < hex.length; i += 2) binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return btoa(binary);
  }

  /** A plugin asset must be same-origin and under the canonical /dashboard/plugins/ path. */
  function pathIsSafe(url) {
    try {
      const u = new URL(url, location.origin);
      return u.origin === location.origin && u.pathname.startsWith('/dashboard/plugins/');
    } catch {
      return false;
    }
  }

  function inject(name, asset) {
    return new Promise((resolve) => {
      if (!pathIsSafe(asset.url)) {
        failed.push({ name, url: asset.url, reason: 'OFF_ORIGIN' });
        console.warn(`[plugins] refusing ${name}: "${asset.url}" is not a same-origin plugin asset`);
        resolve(false);
        return;
      }
      const el = document.createElement('script');
      el.src = asset.url;
      // The digest is the contract. Without `integrity` the manifest would be a list of
      // suggestions rather than a description of what is about to run.
      if (asset.sha256) {
        const b64 = hexToBase64(asset.sha256);
        if (!b64) {
          failed.push({ name, url: asset.url, reason: 'BAD_DIGEST' });
          console.warn(`[plugins] refusing ${name}: "${asset.sha256}" is not a sha256 hex digest`);
          resolve(false);
          return;
        }
        el.integrity = `sha256-${b64}`;
        el.crossOrigin = 'anonymous';
      }
      el.defer = true;
      el.onload = () => resolve(true);
      el.onerror = () => {
        // The browser reports an integrity failure as a plain load error, so this is where
        // a changed file surfaces.
        failed.push({ name, url: asset.url, reason: 'PLUGIN_ASSET_MISMATCH' });
        console.warn(`[plugins] PLUGIN_ASSET_MISMATCH: ${name} asset ${asset.url} did not match its digest, or failed to load`);
        resolve(false);
      };
      document.head.appendChild(el);
    });
  }

  async function load() {
    let manifest;
    try {
      const { data } = await N.api('/api/v1/plugins', { lenient: true });
      manifest = Array.isArray(data) ? data : [];
    } catch (err) {
      // No plugin system on this deployment, or it is not reachable. Neither is a problem
      // for the core dashboard.
      console.info('[plugins] manifest unavailable:', err.message);
      return;
    }
    if (!manifest.length) return;

    for (const plugin of manifest) {
      const urls = [];
      for (const asset of plugin.assets ?? []) {
        if (await inject(plugin.name, asset)) urls.push(asset.url);
      }
      loaded.set(plugin.name, { version: plugin.version, assets: urls });
    }
    if (loaded.size) {
      console.info(`[plugins] loaded ${[...loaded.keys()].join(', ')}`);
      N.emit('plugins:ready', { loaded: N.plugins.list(), failed });
    }
  }

  /**
   * After the session settles, so a plugin's tab registration sees the right role and the
   * manifest request carries the session cookie.
   *
   * Awaiting the promise rather than subscribing to the event. `session:ready` fires exactly
   * once, and a subscriber that arrives afterwards waits for a second firing that never
   * comes — the plugin then simply never loads, with no error anywhere, which is
   * indistinguishable from a plugin that was not enabled. `Nexus.session.ready` is the
   * promise built for this: it resolves whether you were there or not.
   *
   * A rejection is still a settled session as far as this is concerned. The manifest request
   * carries whatever cookie the browser has, and a signed-out visitor gets an empty manifest
   * rather than an error, so there is nothing to abandon.
   */
  const started = Promise.resolve(N.session && N.session.ready).catch(() => undefined).then(() => load());
  void started;
})();
