/**
 * How far from a place counts as being at it.
 *
 * One question, asked from four places — attendance check-in, a gym battle, a beacon spin, and a
 * power-up deploy — and every one of them used to answer it with its own literal `75`.
 *
 * **Two of the four call this**: check-in, with a venue key, and the gym battle, with none. The
 * beacon spin reads `geofenceRadiusMeters` off its own HackStop document, which the seed resolves
 * from the pack, so it follows without going through here. The power-up deploy still holds a
 * literal `GEOFENCE_RADIUS_METERS = 75` in `hackstop.service.ts`: it names a gym rather than a
 * venue, so the campus value is the best it could use, and that is a change worth making
 * deliberately rather than sliding in. An earlier version of this paragraph read as though all
 * four had moved. The
 * pack had two fields for it, `venues.<KEY>.radiusMeters` and `event.campus.geofenceMeters`, both
 * parsed, both documented as overrides, and neither read by anything. Two external reviewers
 * found that independently in the same round.
 *
 * The consequence is not abstract. A fork holds its opening ceremony in an arena, sets
 * `radiusMeters: 200` on that venue exactly as `docs/CONTENT-PACKS.md` describes, and its
 * volunteers standing well inside the advertised boundary are told to move closer — at the one
 * venue that needed the tuning, and with the pack file that was supposed to fix it sitting there
 * looking correct.
 *
 * ## The precedence, and why it is this way round
 *
 * A venue's own `radiusMeters` wins; failing that, the pack's `campus.geofenceMeters`; failing
 * that, 75. Specific beats general, which is the ordering anybody would guess — and the point of
 * the campus-wide value is that a fork with uniformly larger buildings sets it once instead of
 * annotating every venue.
 *
 * 75 remains the last resort because it is what the numbers were chosen against: consumer GPS is
 * routinely 10-30 m out and worse indoors, so a radius much below this refuses honest people
 * standing at the right desk, and one much above it stops meaning "here". `campus.geofenceMeters`
 * already defaults to 75 in the schema, so this final fallback only matters for a caller that
 * hands over no venue at all.
 *
 * ## What this deliberately does not do
 *
 * It does not touch the beacon path. A HackStop's radius is a column on its own document
 * (`geofenceRadiusMeters`), which `spinBeacon` already reads — the seed just wrote a literal 75
 * into it. Fixing that is a change to what the seed writes, not to how the check is made, and it
 * is done there.
 */
/*
 * This module and `content/loader.ts` import each other, and that is deliberate but conditional.
 *
 * The cycle is safe **only because neither side dereferences the other at module scope**. This
 * file imports `pack` and reads it exclusively inside `geofenceMetersFor`, which nothing calls
 * during module evaluation; `loader.ts` imports `geofenceMetersFor` and calls it only inside
 * `publicContent()`, which runs per request. So whichever module is evaluated first, the binding
 * the other needs is populated by the time anything reads it. Both orders were run, not reasoned
 * about — importing `loader` first and importing this file first each produce the same answers.
 *
 * What would break it: a module-scope read here, such as `const DEFAULT = pack.event.campus…`.
 * That would evaluate while `loader` is half-initialised in one import order and not the other,
 * which is the worst shape a bug can have — it depends on which file something else happened to
 * import first. If you need a value at module scope, take the cycle out first.
 */
import { pack } from '../../content/loader';

/**
 * The radius the numbers were chosen against, and the answer when a pack says nothing.
 *
 * Exported so a caller can put it in an error message without repeating the literal — the whole
 * failure this module exists to fix began as four copies of one number.
 */
export const DEFAULT_GEOFENCE_METERS = 75;

/**
 * The geofence radius for a venue key, in metres.
 *
 * `venueKey` is what `resolveVenue` returns, so an unmatched location arrives here as the pack's
 * HQ key rather than as `undefined` — but the parameter is optional anyway, because SOS dispatch
 * and the power-up deploy path can legitimately have no venue in hand and the campus-wide value
 * is the right answer for them.
 */
export function geofenceMetersFor(venueKey?: string | null): number {
  const venue = venueKey ? pack.venues[venueKey] : undefined;
  return venue?.radiusMeters ?? pack.event.campus?.geofenceMeters ?? DEFAULT_GEOFENCE_METERS;
}
