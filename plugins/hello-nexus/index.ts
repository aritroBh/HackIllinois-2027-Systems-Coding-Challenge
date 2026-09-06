/**
 * hello-nexus — the worked example the fork guide points at.
 *
 * It does one of each thing a plugin can do, and nothing else: one route, one hook, one
 * client tab. Copy this directory, rename it (the directory name is the plugin name), add
 * the export to `CATALOG` in `src/plugins/registry.ts`, and put the name in `PLUGINS`.
 *
 * Two patterns here are worth copying deliberately:
 *
 *  - The context arrives with `registerRoutes` and is kept in a module-level variable, so
 *    the hooks can log and broadcast through it. Hooks are handed only their event.
 *  - State is per-process and in memory. That is honest for a counter. Anything a fork
 *    needs to survive a restart or be shared between replicas belongs in a Mongoose model
 *    of its own, not here.
 */
import { Router, Request, Response } from 'express';
import type { CheckInHookEvent, PluginContext, ServerPlugin } from '../../src/plugins/types';

let ctx: PluginContext | null = null;
let checkInsSeen = 0;

export const helloNexusPlugin: ServerPlugin = {
  name: 'hello-nexus',
  version: '1.0.0',
  apiVersion: 1,

  hooks: {
    onCheckIn(event: CheckInHookEvent): void {
      if (event.direction !== 'IN') return;
      checkInsSeen += 1;
      // Lands on the `ops` channel as `PLUGIN_HELLO_NEXUS_GREETED`; the registry adds the
      // prefix so a plugin cannot impersonate a core event.
      ctx?.broadcast('GREETED', { accountId: event.accountId, checkInsSeen });
    },
  },

  registerRoutes(router: Router, context: PluginContext): void {
    ctx = context;
    context.log('routes registered');

    // `{ success: true, data }` is the API's contract, not a suggestion: the dashboard's
    // fetch wrapper treats `success: false` as a thrown error.
    router.get('/hello', (_req: Request, res: Response) => {
      res.status(200).json({
        success: true,
        data: {
          plugin: helloNexusPlugin.name,
          version: helloNexusPlugin.version,
          greeting: 'Hello from a Nexus plugin.',
          checkInsSeen,
          uptimeSeconds: Math.round(process.uptime()),
        },
      });
    });
  },

  clientAssets: ['hello.js'],
};

export default helloNexusPlugin;
