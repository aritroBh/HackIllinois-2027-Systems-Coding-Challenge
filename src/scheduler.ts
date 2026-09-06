/**
 * The one place a periodic job lives (plan §A6/§A7).
 *
 * Everything that has to happen on a clock — the SOS no-acknowledgement escalation today,
 * quest windows and raid timers from M6 — registers here rather than starting its own
 * `setInterval` somewhere in a service. That matters for two reasons: a single timer is
 * easy to stop in tests and on shutdown, and one file makes it obvious how much background
 * work the process is doing.
 *
 * The event runs one instance by decision (see the plan's transport section), so there is
 * no leader election. Each job is written to be idempotent anyway — the escalation claims
 * its ticket with a conditional update — so a second instance would duplicate work, not
 * corrupt it.
 */
import { SOSService } from './services/sos.service';
import { RaidService } from './services/raid.service';
import { sweepSseSessions } from './presence/sseTransport';
import { env } from './config/env';

export interface ScheduledJob {
  name: string;
  everyMs: number;
  run: () => Promise<void> | void;
  lastRunAt?: number;
  lastError?: string;
  runs: number;
}

const jobs: ScheduledJob[] = [
  {
    name: 'sos-escalation',
    everyMs: 30_000,
    runs: 0,
    // A dispatched ticket nobody has acknowledged after three minutes gets shouted about
    // once — redacted on the public channel, in full to leads.
    run: async () => {
      await SOSService.escalateStale();
    },
  },
  {
    name: 'presence-sse-sweep',
    everyMs: 30_000,
    runs: 0,
    // The SSE fallback has no socket to close, so a client that stops posting has to be
    // reaped on a timer.
    run: () => {
      sweepSseSessions();
    },
  },
  {
    name: 'raid-windows',
    everyMs: 30_000,
    runs: 0,
    // The docblock above has promised since M6 that raid timers live here, and they did not:
    // `RaidService.tick()` had no caller outside its own tests, so a raid window opened and
    // closed in the content pack without a single frame on the wire. Nobody saw a raid start.
    //
    // Idempotent per process by construction — `tick` remembers what it has announced — so
    // running it every thirty seconds costs a map lookup per raid and announces each edge once.
    run: () => {
      RaidService.tick();
    },
  },
];

let timer: NodeJS.Timeout | null = null;
const TICK_MS = 10_000;

export function registerJob(job: Omit<ScheduledJob, 'runs'>): void {
  jobs.push({ ...job, runs: 0 });
}

export function startScheduler(): void {
  if (timer || env.NODE_ENV === 'test') return;
  timer = setInterval(runDue, TICK_MS);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run whatever is due. Exported so tests can drive it without waiting on a timer. */
export async function runDue(now: number = Date.now()): Promise<void> {
  for (const job of jobs) {
    if (job.lastRunAt && now - job.lastRunAt < job.everyMs) continue;
    job.lastRunAt = now;
    try {
      await job.run();
      job.runs += 1;
      job.lastError = undefined;
    } catch (err) {
      // A failing job must not take the timer down with it; the next tick tries again.
      job.lastError = (err as Error).message;
      console.warn(`[scheduler] ${job.name} failed: ${job.lastError}`);
    }
  }
}

export function schedulerStats(): Array<{ name: string; runs: number; lastRunAt?: number; lastError?: string }> {
  return jobs.map((j) => ({ name: j.name, runs: j.runs, lastRunAt: j.lastRunAt, lastError: j.lastError }));
}
