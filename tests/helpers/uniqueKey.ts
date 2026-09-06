/**
 * A key that is unique across the whole run, not merely across one line of one test.
 *
 * Idempotency keys in tests were built from `Date.now()` plus a loop index. Two tests in
 * different files that both write `seed_0_${Date.now()}` inside the same millisecond produce
 * the same key, and the second request is then answered from the first one's stored response
 * rather than being executed. That is exactly what an idempotency layer is supposed to do; it
 * is simply not what the second test meant to ask for, and the resulting failure looks like a
 * concurrency bug in the code under test rather than a collision in the harness.
 *
 * The collision was previously invisible because the unique index that enforces it was never
 * built in tests. Building the indexes turned a latent flake into a visible one — which is the
 * right direction, and this is the other half of the fix.
 *
 * A process-wide counter, not a timestamp and not a random value: it cannot collide, it does
 * not depend on clock resolution, and a key that appears in a failure names the call that
 * produced it.
 */
let n = 0;

export function uniqueKey(prefix = 'k'): string {
  n += 1;
  return `${prefix}_${process.pid}_${n}`;
}
