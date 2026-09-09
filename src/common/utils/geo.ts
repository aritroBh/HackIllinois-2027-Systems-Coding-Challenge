/**
 * Venue resolution and distance, the two halves of every geofence in the system.
 *
 * A shift stores its location as free text ("Siebel Center Atrium"), because that is what an
 * organiser types. A check-in arrives with a latitude and longitude. Turning the first into
 * coordinates is what makes the second comparable, and getting it wrong does not look like a
 * bug: it looks like an honest volunteer standing at the right desk being told they are in
 * the wrong place.
 *
 * **Two resolvers with deliberately different failure modes.** `resolveVenueCoordinates`
 * returns `null` when nothing matches, and every caller of it must fail closed — measuring
 * from the wrong building is worse than refusing. `resolveVenue` cannot return null, so it
 * falls back to the HQ venue and says so with `matched: false`; callers that need a point on
 * a map (SOS dispatch ranking, the escalation notice) use it and read the flag rather than
 * inventing a coordinate of their own.
 *
 * **The gazetteer is the content pack.** It used to be a second copy: a `HACKILLINOIS_VENUES`
 * literal and a `VENUE_KEYWORDS` table in this file, holding the same keys as the pack
 * (fifteen then; twenty-three now with the eight dorm venues), the same
 * coordinates and the same hints as `content/hackillinois-2027/venues.json`, with nothing
 * checking that they still agreed. The pack's copy was what `BoothService` and `RaidService`
 * validated against and what the client rendered; this copy was what the check-in geofence and
 * SOS dispatch actually measured from. A fork that edited `venues.json` — which the fork guide
 * says is how you move a venue — moved the map pin and not the geofence, so its check-ins
 * failed against buildings in Urbana.
 *
 * The two were diffed before they were merged, and they were byte-identical: all fifteen keys
 * then in the pack, both coordinates each, every hint list. So this change moved nothing for the shipped pack and
 * it is the reason it could be made at all. `CONTRIBUTING.md` has always said that nothing in
 * `src/` names a building; `scripts/checkPackDriven.mjs` now enforces it.
 *
 * The deferral recorded here previously — that reading the pack "changes what boots when a pack
 * is missing a venue the seed data names" — was true when it was written and is not any more.
 * The seed reads the pack too, so it cannot name a venue the pack lacks, and `crossValidate`
 * already refuses a pack whose territories or beacons point at an unknown venue key.
 */
import { pack } from '../../content/loader';

/** A WGS84 point. Every distance and geofence check in the system takes these. */
export interface IGeoCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Every venue the active pack declares, as bare coordinates.
 *
 * Derived once at import, like every other `pack.*` read in `src/`. `loader.ts` guarantees the
 * pack is whole before anything can import it, so there is no half-loaded state to guard
 * against.
 *
 * Coordinates in the shipped pack were cross-checked against OpenStreetMap building centroids
 * (ODbL) when the territory map was built — see `design/pipeline/`, which resolves the same
 * landmarks into the 3D model the war room renders. That is what lets a shift at "Foellinger"
 * light up the right monument.
 */
export const VENUE_COORDINATES: Record<string, IGeoCoordinates> = Object.fromEntries(
  Object.entries(pack.venues).map(([key, venue]) => [key, { latitude: venue.latitude, longitude: venue.longitude }])
);

/**
 * Resolves a free-text shift location ("Siebel Center Atrium", "SIEBEL_ATRIUM",
 * "Kenney Gym Entrance") to venue coordinates. Returns null when the location
 * maps to no known venue — callers must fail closed (reject) rather than
 * measure from the wrong building.
 * ponytail: keyword matcher, not a gazetteer — add explicit venue keys when new buildings come online.
 */
export function resolveVenueCoordinates(location: string | undefined | null): IGeoCoordinates | null {
  if (!location) return null;
  const norm = location.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (VENUE_COORDINATES[norm]) return VENUE_COORDINATES[norm];
  const resolved = resolveVenue(location);
  return resolved.matched ? resolved.coordinates : null;
}

/**
 * Free-text hints, from the pack's `hints` array on each venue.
 *
 * Resolution scores by hint specificity — longest match wins — so this list is
 * order-independent: a venue cannot shadow, or be shadowed by, another, and a pack may list its
 * hints in whatever order reads best. That property is what let this become a derived list at
 * all. The old hand-written table encoded ordering in two places (a duplicate `KENNEY_GYM` row
 * carrying the deliberately weak bare hint `GYM`, placed last), and with longest-match scoring
 * that placement was already decorative: `GYM` is three characters and loses to `KENNEY`,
 * `MAIN STAGE` and everything else regardless of where it sits.
 *
 * Hints are upper-cased here rather than trusted from the pack, because the match below is a
 * substring test against an upper-cased input and a lower-case hint would simply never fire —
 * a venue that silently cannot be resolved is exactly the failure this file exists to prevent.
 */
const VENUE_KEYWORDS: Array<{ key: string; hints: string[] }> = Object.entries(pack.venues).map(
  ([key, venue]) => ({ key, hints: (venue.hints ?? []).map((hint) => hint.toUpperCase()) })
);

/**
 * `matched` is the field that matters. `coordinates` is always populated — there is no null
 * branch to forget — so a caller that ignores `matched` silently measures from Siebel
 * whatever the shift actually said. Anything that gates access on distance must read it;
 * anything that only needs a point to sort by may ignore it.
 */
export interface IVenueResolution {
  key: string;
  coordinates: IGeoCoordinates;
  /** True when the location matched a known venue; false when falling back to HQ. */
  matched: boolean;
}

/**
 * Resolves a free-text shift location (e.g. "Siebel Center Atrium") to the
 * nearest canonical venue. Exact venue keys ("SIEBEL_ATRIUM") always win;
 * otherwise keyword matching is attempted before falling back to Siebel HQ.
 * Previously this was an exact-match-or-default lookup, which silently
 * anchored every seeded shift's geofence to the wrong building.
 */
export function resolveVenue(location: string | undefined | null): IVenueResolution {
  const raw = (location || '').trim();
  if (raw && Object.prototype.hasOwnProperty.call(VENUE_COORDINATES, raw)) {
    return { key: raw, coordinates: VENUE_COORDINATES[raw], matched: true };
  }
  const upper = raw.toUpperCase();
  if (upper) {
    // Longest matching hint wins, rather than the first entry in list order.
    //
    // First-match made correctness depend on table ordering, and every venue
    // added below an existing one inherited its shadows: "Main Library Atrium"
    // resolved to SIEBEL_ATRIUM (on "ATRIUM") and "State Farm Center Main
    // Stage" to KENNEY_GYM (on "MAIN STAGE"). Both then geofenced the caller
    // against a building over a kilometre away, so a legitimate check-in at
    // the true location fails closed. Scoring by hint specificity makes the
    // table order-independent and safe to extend.
    let best: { key: string; score: number } | null = null;
    for (const venue of VENUE_KEYWORDS) {
      for (const hint of venue.hints) {
        if (upper.includes(hint) && (best === null || hint.length > best.score)) {
          best = { key: venue.key, score: hint.length };
        }
      }
    }
    if (best) {
      return { key: best.key, coordinates: VENUE_COORDINATES[best.key], matched: true };
    }
  }
  // The pack's own HQ, not a building named in this file.
  //
  // This used to be a hard-coded `SIEBEL_ATRIUM`, which is the one place a fork could not
  // reach: every unresolvable location fell back to a specific building in Urbana. `hqVenue`
  // is a required pack field and `crossValidate` refuses a pack whose `hqVenue` is not a real
  // venue key, so the lookup below cannot miss.
  return { key: pack.event.hqVenue, coordinates: VENUE_COORDINATES[pack.event.hqVenue], matched: false };
}

const EARTH_RADIUS_METERS = 6371000; // Earth mean radius in meters

/**
 * Geospatial computation engine for great-circle distance calculation,
 * geofence validation, and bounding-box spatial tests.
 */
export class GeoEngine {
  /**
   * Great-circle distance on a sphere of mean Earth radius.
   *
   * A sphere rather than the WGS84 ellipsoid, which is a real approximation and a harmless
   * one at this scale: the two disagree by a few tenths of a percent, so over the 75 m the
   * geofence cares about the difference is well under a metre — an order of magnitude inside
   * the GPS error the radius was chosen to absorb in the first place. Vincenty would be more
   * accurate and would not change a single accept/reject decision here.
   *
   * The clamp on `a` is not cosmetic. Floating-point drift can push it a hair above 1.0 for
   * near-antipodal inputs, and `Math.sqrt(1 - a)` then returns NaN, which propagates through
   * the distance into a geofence comparison that is false for every radius — a fail-closed
   * refusal with no explanation. Clamping keeps the degenerate case at a finite distance.
   */
  public static haversineDistanceMeters(
    coord1: IGeoCoordinates,
    coord2: IGeoCoordinates
  ): number {
    const lat1Rad = (coord1.latitude * Math.PI) / 180;
    const lat2Rad = (coord2.latitude * Math.PI) / 180;
    const deltaLatRad = ((coord2.latitude - coord1.latitude) * Math.PI) / 180;
    const deltaLonRad = ((coord2.longitude - coord1.longitude) * Math.PI) / 180;

    const a =
      Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
      Math.cos(lat1Rad) *
        Math.cos(lat2Rad) *
        Math.sin(deltaLonRad / 2) *
        Math.sin(deltaLonRad / 2);

    // Clamp against floating-point drift (antipodal points can push `a` past 1.0,
    // yielding NaN from sqrt of a negative). Matches ARCHITECTURE.md spec.
    const aClamped = Math.min(1.0, Math.max(0.0, a));
    const c = 2 * Math.atan2(Math.sqrt(aClamped), Math.sqrt(1 - aClamped));
    const distance = EARTH_RADIUS_METERS * c;

    return parseFloat(distance.toFixed(1));
  }

  /**
   * The distance test, with the answer and the numbers behind it, so a caller can put "you
   * are 140 m away, the limit is 75" in the error rather than a bare refusal.
   *
   * 75 m is the default because consumer GPS is routinely 10–30 m out and worse indoors,
   * which is where all of these venues are; `docs/LIMITATIONS.md` records the reasoning and
   * the band either side of it. Callers with their own radius (a beacon's
   * `geofenceRadiusMeters`) pass it instead.
   *
   * Be clear about what this does not do: the coordinate is supplied by the client. A caller
   * who sends the venue's published position passes from anywhere on earth. This is a guard
   * against honest mistakes and casual sharing, not an attestation of where anybody is.
   */
  public static isWithinGeofence(
    userCoord: IGeoCoordinates,
    targetCoord: IGeoCoordinates,
    maxRadiusMeters = 75
  ): { allowed: boolean; distanceMeters: number; maxRadiusMeters: number } {
    const distanceMeters = this.haversineDistanceMeters(userCoord, targetCoord);
    return {
      allowed: distanceMeters <= maxRadiusMeters,
      distanceMeters,
      maxRadiusMeters,
    };
  }
}
