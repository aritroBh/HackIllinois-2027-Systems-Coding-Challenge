/**
 * Plan-gate helper: assert the scheduler registers its named jobs.
 *
 * Run with `npx tsx scripts/checkSchedulerJobs.ts` (file mode). This used to
 * be a `tsx -e "import('./src/scheduler')..."` one-liner inside
 * checkPlanGates.sh, which broke in CI with `m.schedulerStats is not a
 * function`: `-e` input is compiled by esbuild to CJS and run through
 * `node --eval`, so the dynamic import becomes a hook-dependent
 * extensionless `require` from an eval context — a different module-loading
 * path from every other tsx invocation in CI (validate.ts and
 * checkCampus.ts both run in file mode and stay green). A real file keeps
 * the same assertion on the supported path.
 */

import { schedulerStats } from '../src/scheduler';

const REQUIRED = ['sos-escalation', 'presence-sse-sweep', 'raid-windows'];

const names = schedulerStats().map((j) => j.name);
const missing = REQUIRED.filter((w) => !names.includes(w));

if (missing.length > 0) {
  console.error(
    `missing scheduler jobs: ${missing.join(', ')} (have: ${names.join(', ') || '(none)'})`,
  );
  process.exit(1);
}

console.log(`scheduler jobs: ${names.join(', ')}`);
