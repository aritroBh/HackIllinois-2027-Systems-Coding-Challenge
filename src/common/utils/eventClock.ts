/**
 * What time it is *at the event*.
 *
 * Two things in this system reward the small hours — the circadian surge multiplier, which
 * exists because the 3 a.m. rubbish run does not fill, and the `MIDNIGHT_KRAKEN` badge. Both
 * originally asked `getUTCHours()`, and both had the same half-right reasoning written next to
 * them: the hour must not wander with whatever `TZ` the server happens to boot with, so read a
 * clock that is not the server's. That part is correct. Both then treated UTC *as* the event's
 * clock, which it is not.
 *
 * For the shipped pack (`America/Chicago`, UTC−6 in late February) the cost was:
 *
 *  - the surge peak fixed at 03:30 UTC landed at 21:30 local, and real 3:30 a.m. fell where the
 *    cosine is exactly zero — 1.375 of a possible 2.5;
 *  - the badge window `2 <= hour <= 5` UTC was 8 p.m. to 11 p.m. local, so the graveyard badge
 *    went to evening shifts and never once to the graveyard shift.
 *
 * This module exists so there is one answer rather than two. The surge fix landed first and
 * carried its own private formatter; when the badge needed the same thing, copying that
 * formatter would have made "what hour is it at the event" a rule in two places — which is the
 * duplication this repository has spent a long day removing from venues, loot tables and
 * geofence radii. It was extracted instead.
 */
import { pack } from '../../content/loader';

/**
 * Built once. Constructing an `Intl.DateTimeFormat` is not cheap and the shift listing calls
 * into this once per shift in a loop.
 *
 * `Intl` rather than a fixed offset is the load-bearing choice: it is the only thing in the
 * standard library that knows `America/Chicago` was UTC−6 in February and is UTC−5 in June, and
 * an event in June with a hard-coded offset would reward the hour either side of the one it
 * meant.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`, because the latter is specified to produce
 * "24" for midnight in some locales — which on a cosine that wraps at 24 would put midnight at
 * the trough instead of near the peak, and would put it outside a `2..5` window it should be
 * approaching.
 */
const eventClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: pack.event.timezone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The wall-clock hour at the event, as a fraction — 03:30 is `3.5`. */
export function eventLocalHour(when: Date): number {
  const parts = eventClock.formatToParts(when);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour + minute / 60;
}

/** The whole wall-clock hour at the event, 0-23, for a window test like "between 2 and 5". */
export function eventLocalHourOfDay(when: Date): number {
  return Math.floor(eventLocalHour(when));
}
