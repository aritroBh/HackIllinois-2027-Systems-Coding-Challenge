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
 * before the browser has to, and says why. Plugins are first-party code in this repository
 * or in a content pack, reviewed like the rest of it; see docs/PLUGINS.md.
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
        el.integrity = `sha256-${asset.sha256}`;
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

  // After the session settles, so a plugin's tab registration sees the right role and the
  // manifest request carries the session cookie.
  N.onEvent('session:ready', () => { void load(); });
})();
