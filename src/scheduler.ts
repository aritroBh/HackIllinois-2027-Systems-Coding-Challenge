/**
 * The one place a periodic job lives (plan §A6/§A7).
 *
 * Everything that has to happen on a clock registers here rather than starting its own
 * `setInterval` somewhere in a service. That matters for two reasons: a single timer is
 * easy to stop in tests and on shutdown, and one file makes it obvious how much *scheduled*
 * work the process is doing.
 *
 * Three jobs today: the SOS no-acknowledgement escalation, the SSE presence sweep, and raid
 * windows. **Quest windows are not among them** and never were, although this header listed
 * them: a quest's window is derived on read from a date-bucket key (`windowKey` in
 * `quest.service.ts`), so there is nothing to tick. An administrator looking here for a missing
 * quest-window job would be looking for something that should not exist.
 *
 * Scheduled work, not all of it. Three timers deliberately live outside this file, so the
 * table below is not an inventory of everything ticking: the 1 Hz presence tick
 * (`presence/service.ts`, started by `server.ts` right beside this scheduler), the SSE
 * heartbeat and re-authorisation sweep (`common/sse/eventHub.ts`), and a per-socket
 * WebSocket ping (`presence/wsTransport.ts`). Each of those paces a connection rather than
 * running a unit of work, which is the line: a *job* belongs here.
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

/**
 * One entry in the table below. `everyMs` is a floor, not a schedule: the tick is 10 s wide
 * and jobs are awaited in order, so a job asking for 30 s gets "at least 30 s, on a tick
 * boundary, after everything ahead of it has finished". Nothing here is a cron expression and
 * nothing fires at a wall-clock time.
 *
 * `lastError` holds the message of the most recent failure and is cleared by the next success,
 * so it answers "is this job broken now", not "has it ever broken". It is published by
 * `schedulerStats` and reaches `GET /health`, which is why it is a message and never the
 * error object or its stack.
 */
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

/**
 * Add a job at runtime, for the same reason the table above exists rather than a `setInterval`
 * in a service. Nothing in this repository calls it today — the three core jobs are declared
 * statically — so it is the extension point a plugin or a fork uses, and it is unexercised by
 * the suite.
 *
 * Deliberately not idempotent and not keyed on `name`: registering twice gives two entries
 * that both run. There is no unregister either. Call it once, at boot, before `startScheduler`
 * or after — `runDue` walks the array afresh on every tick, so a job added late is simply due
 * on the next one.
 */
export function registerJob(job: Omit<ScheduledJob, 'runs'>): void {
  jobs.push({ ...job, runs: 0 });
}

/**
 * Start the one timer, if it is not already running.
 *
 * Two guards, for two different reasons. The `timer` check makes a second call a no-op, which
 * matters because `createServer` calls this and a process may build more than one server. The
 * `NODE_ENV === 'test'` check keeps background work out of the suite entirely: a job firing
 * between two assertions would mutate the database underneath them, and the tests that care
 * about a job drive `runDue` directly instead. Note what that costs — under `test` this
 * function does nothing at all, so it can never be the thing a test proves works.
 *
 * `unref` so the timer alone does not keep the process alive; Ctrl-C on a server with no open
 * connections should exit rather than wait out a ten-second tick.
 */
export function startScheduler(): void {
  if (timer || env.NODE_ENV === 'test') return;
  timer = setInterval(runDue, TICK_MS);
  timer.unref?.();
}

/**
 * Stop the timer. It does not interrupt a `runDue` already in flight — `clearInterval` only
 * cancels future fires — so a job's promise may still settle after this returns. Safe to call
 * when nothing is running, which is what makes it usable straight from a `close` listener.
 */
export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Run whatever is due. Exported so tests can drive it without waiting on a timer — which is
 * the only way a job runs under `NODE_ENV=test`, since `startScheduler` is a no-op there.
 *
 * Two properties of this loop are worth knowing before adding a job to the table.
 *
 * `lastRunAt` is stamped *before* `run` is awaited, not after. A job's clock therefore starts
 * when it begins rather than when it finishes, and a job that throws is still marked as having
 * run — so a consistently failing job retries on its own interval instead of on every tick.
 * The `try`/`catch` around each one is what keeps a single bad job from ending the loop and
 * silently stopping every job after it.
 *
 * There is no overlap guard. `setInterval` does not wait for an async callback, so a job that
 * takes longer than the 10 s tick has a second `runDue` walking the same array while it is
 * still in flight. Two consequences. The jobs *behind* the slow one are reached by that second
 * pass, which is the only reason one slow job does not stall the rest indefinitely — within a
 * single pass they are strictly sequential. And the slow job itself is protected only by its
 * own `everyMs`: a job that regularly runs longer than its own interval will be entered again
 * while the previous call has not returned. Nothing here serialises that for you.
 */
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

/**
 * What the background half of the process is doing, for `GET /health`.
 *
 * A projection rather than the jobs themselves: the `run` closure must not be handed to a
 * caller that serialises what it is given. `lastError` is still a message written by whatever
 * threw, which is why `/health` only shows this table to a proved lead — an internal detail
 * can reach it from a driver error nobody chose to publish.
 *
 * `runs` counts successes, not attempts, because it is incremented after `run` resolves. A job
 * that fails every time therefore reads as `runs: 0` with a `lastRunAt` that keeps moving,
 * which is the pair worth looking at together.
 */
export function schedulerStats(): Array<{ name: string; runs: number; lastRunAt?: number; lastError?: string }> {
  return jobs.map((j) => ({ name: j.name, runs: j.runs, lastRunAt: j.lastRunAt, lastError: j.lastError }));
}
