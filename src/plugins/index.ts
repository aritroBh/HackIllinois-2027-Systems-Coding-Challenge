/**
 * Mounting: where a plugin's routes and browser scripts actually appear.
 *
 * Two mounts, in two different places, for one reason. Routes go under
 * `/api/v1/plugins/<name>` so they inherit identity, rate limiting, CSRF and the JSON error
 * contract like every other endpoint. Assets go under `/dashboard/plugins/<name>/` beside
 * the rest of the shell, *outside* the API stack: a `<script src>` carries no CSRF token and
 * must load before a session exists, so serving it through the API would 401 it in
 * `AUTH_MODE=required`. Both sit behind `pluginGuard`, so a disabled plugin is a 404 on
 * either path.
 *
 * **Asset integrity.** Every declared asset is hashed at boot and the manifest reports the
 * digest alongside the URL. That is what makes a fork's deployment auditable: the operator
 * can compare what the server is serving against what they reviewed, without trusting the
 * filename. It is a manifest, not subresource-integrity enforcement. The browser is not
 * asked to verify it, and nothing here defends against an attacker who can write to the
 * plugin directory, since they could rewrite the digest too.
 *
 * A declared asset that is missing or that escapes its plugin directory disables the plugin
 * at boot. A route with no tab, or a tab with no script, is worse than no plugin at all.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../common/utils/repoRoot';
import { Router, Request, Response } from 'express';
import { pluginGuard, pluginRegistry } from './registry';
import { PluginAssetEntry, PluginManifestEntry, ServerPlugin } from './types';

/** Where plugin directories live, relative to the repository root. */
const PLUGIN_DIR_NAME = 'plugins';
const ASSET_URL_PREFIX = '/dashboard/plugins';

interface ResolvedAsset extends PluginAssetEntry {
  /** Absolute path on disk, resolved and confirmed to be inside the plugin's public dir. */
  file: string;
}

/**
 * Resolves and hashes one plugin's assets. Returns null when any of them is unusable, which
 * the caller turns into a disable.
 */
function resolveAssets(plugin: ServerPlugin, root: string): { assets: ResolvedAsset[] } | { error: string } {
  const publicDir = path.resolve(root, PLUGIN_DIR_NAME, plugin.name, 'public');
  const assets: ResolvedAsset[] = [];
  for (const declared of plugin.clientAssets ?? []) {
    if (declared.length === 0 || path.isAbsolute(declared)) {
      return { error: `asset "${declared}" must be a path relative to plugins/${plugin.name}/public` };
    }
    const file = path.resolve(publicDir, declared);
    // The declaration comes from source, not from a request, but a plugin that reaches into
    // the server's own tree with `../..` would be publishing whatever it points at.
    if (file !== publicDir && !file.startsWith(publicDir + path.sep)) {
      return { error: `asset "${declared}" resolves outside plugins/${plugin.name}/public` };
    }
    let contents: Buffer;
    try {
      contents = fs.readFileSync(file);
    } catch {
      return { error: `asset "${declared}" is declared but missing at ${file}` };
    }
    const rel = path.relative(publicDir, file).split(path.sep).join('/');
    assets.push({
      url: `${ASSET_URL_PREFIX}/${plugin.name}/${rel}`,
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
      file,
    });
  }
  return { assets };
}

/**
 * Read once, at import. The digests describe the files as they were when the process
 * started, so a script swapped underneath a running server shows up as a mismatch rather
 * than silently redefining what the manifest promised.
 */
const assetTable: Map<string, ResolvedAsset[]> = (() => {
  const root = REPO_ROOT;
  const table = new Map<string, ResolvedAsset[]>();
  for (const plugin of pluginRegistry.activated()) {
    const result = resolveAssets(plugin, root);
    if ('error' in result) {
      table.set(plugin.name, []);
      pluginRegistry.disable(plugin.name, result.error);
      continue;
    }
    table.set(plugin.name, result.assets);
  }
  return table;
})();

/**
 * `[{ name, version, assets: [{ url, sha256 }] }]` for every plugin that is currently
 * ENABLED. A plugin that was activated at boot but has since been disabled by repeated hook
 * failures is omitted: its assets 404 at the guard, so listing them only sends clients to
 * fetch files they cannot have, and it discloses that the plugin exists at all.
 */
export function pluginManifest(): PluginManifestEntry[] {
  return pluginRegistry
    .activated()
    .filter((plugin) => pluginRegistry.enabled(plugin.name))
    .map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    assets: (assetTable.get(plugin.name) ?? []).map(({ url, sha256 }) => ({ url, sha256 })),
  }));
}

/**
 * Mounts `/plugins` on the given router: the manifest at `/plugins`, and each activated
 * plugin's own router at `/plugins/<name>` behind the guard. Called with the v1 router, so
 * the public paths are `/api/v1/plugins` and `/api/v1/plugins/<name>/…`.
 *
 * A plugin whose `registerRoutes` throws is disabled rather than allowed to abort the boot:
 * an event that starts without one optional feature beats an event that does not start.
 */
export function mountPlugins(router: Router): Router {
  const plugins = Router();

  plugins.get('/', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: pluginManifest() });
  });

  for (const plugin of pluginRegistry.activated()) {
    const own = Router();
    try {
      plugin.registerRoutes?.(own, pluginRegistry.context(plugin.name));
    } catch (error) {
      pluginRegistry.disable(plugin.name, `registerRoutes threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Mounted whether or not registration succeeded: the guard is what answers, and a route
    // that exists and 404s is the same to a client as one that was never there.
    plugins.use(`/${plugin.name}`, pluginGuard(plugin.name), own);
  }

  router.use('/plugins', plugins);
  return router;
}

/**
 * Serves each declared asset at `/dashboard/plugins/<name>/<path>`, one explicit route per
 * file. Explicit routes rather than `express.static` on the plugin directory: only what a
 * plugin declared is reachable, and nothing else in its tree (its TypeScript source, a
 * stray `.env`) is ever served by accident.
 *
 * Call with the app, before the 404 handlers.
 */
export function mountPluginAssets(app: Router): Router {
  for (const plugin of pluginRegistry.activated()) {
    const guard = pluginGuard(plugin.name);
    for (const asset of assetTable.get(plugin.name) ?? []) {
      app.get(asset.url, guard, (_req: Request, res: Response) => {
        // Short and revalidated: a plugin script changes with a deploy, and the manifest
        // digest is how a client knows it did.
        res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
        res.sendFile(asset.file);
      });
    }
  }
  return app;
}
