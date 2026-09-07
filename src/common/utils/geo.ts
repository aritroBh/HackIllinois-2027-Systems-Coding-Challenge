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
 * **Known gap: this gazetteer is a second copy of the content pack.** `HACKILLINOIS_VENUES`
 * and `VENUE_KEYWORDS` below hold the same fifteen keys, the same coordinates and the same
 * hints as `content/hackillinois-2027/venues.json`, and nothing checks that they still agree.
 * The pack's copy is what `BoothService` and `RaidService` validate against and what the
 * client renders; this copy is what the check-in geofence and SOS dispatch actually measure
 * from. So a fork that edits `venues.json` — which the fork guide says is the way to move a
 * venue — moves the map pin and not the geofence. Reading the pack here is the fix; it is
 * recorded rather than done because it changes what boots when a pack is missing a venue the
 * seed data names.
 */

export interface IGeoCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Campus gazetteer. Coordinates for the landmark venues were cross-checked
 * against OpenStreetMap building centroids (ODbL) when the territory map was
 * built — see design/build-campus.py, which resolves the same set of landmarks
 * into the 3D model the war-room renders. Keeping the two lists agreeing is
 * what lets a shift at "Foellinger" light up the right monument on the map.
 */
export const HACKILLINOIS_VENUES: Record<string, IGeoCoordinates> = {
  // Engineering campus
  SIEBEL_ATRIUM: { latitude: 40.113812, longitude: -88.224937 },
  SIEBEL_BASEMENT: { latitude: 40.113725, longitude: -88.224810 },
  ECEB_LOBBY: { latitude: 40.114828, longitude: -88.228056 },
  KENNEY_GYM: { latitude: 40.113054, longitude: -88.228012 },
  DCL_BRIDGE: { latitude: 40.113215, longitude: -88.226500 },
  GRAINGER_LIBRARY: { latitude: 40.112400, longitude: -88.226870 },
  BECKMAN_INSTITUTE: { latitude: 40.115620, longitude: -88.227480 },

  // The Main Quad and its monuments
  ALMA_MATER: { latitude: 40.109920, longitude: -88.228400 },
  ILLINI_UNION: { latitude: 40.109540, longitude: -88.227340 },
  ALTGELD_HALL: { latitude: 40.109370, longitude: -88.228400 },
  FOELLINGER_AUDITORIUM: { latitude: 40.106030, longitude: -88.227210 },
  MAIN_LIBRARY: { latitude: 40.104550, longitude: -88.228850 },

  // Outer campus
  KRANNERT_CENTER: { latitude: 40.108020, longitude: -88.222940 },
  MEMORIAL_STADIUM: { latitude: 40.099250, longitude: -88.235970 },
  STATE_FARM_CENTER: { latitude: 40.096220, longitude: -88.235990 },
};

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
  if (HACKILLINOIS_VENUES[norm]) return HACKILLINOIS_VENUES[norm];
  const resolved = resolveVenue(location);
  return resolved.matched ? resolved.coordinates : null;
}

/** Keyword hints mapping free-text shift locations to canonical venue keys. */
// Resolution scores by hint specificity (longest match wins), so this list is
// order-independent: adding a venue cannot shadow, or be shadowed by, another.
// Keep hints as specific as the venue they identify.
const VENUE_KEYWORDS: Array<{ key: string; hints: string[] }> = [
  { key: 'SIEBEL_BASEMENT', hints: ['BASEMENT', '0220'] },
  { key: 'SIEBEL_ATRIUM', hints: ['SIEBEL', 'ATRIUM', '1404', '1100'] },
  { key: 'ECEB_LOBBY', hints: ['ECEB', 'ROOM 1020', 'MICROELECTRONICS'] },
  { key: 'KENNEY_GYM', hints: ['KENNEY', 'PAVILION', 'MAIN STAGE'] },
  { key: 'DCL_BRIDGE', hints: ['DCL', 'BRIDGE'] },
  { key: 'GRAINGER_LIBRARY', hints: ['GRAINGER'] },
  { key: 'BECKMAN_INSTITUTE', hints: ['BECKMAN'] },
  { key: 'ALMA_MATER', hints: ['ALMA', 'GREEN & WRIGHT', 'GREEN AND WRIGHT'] },
  { key: 'ILLINI_UNION', hints: ['UNION', 'COURTYARD CAFE'] },
  { key: 'ALTGELD_HALL', hints: ['ALTGELD', 'CHIME'] },
  { key: 'FOELLINGER_AUDITORIUM', hints: ['FOELLINGER'] },
  { key: 'MAIN_LIBRARY', hints: ['MAIN LIBRARY', 'STACKS'] },
  { key: 'KRANNERT_CENTER', hints: ['KRANNERT'] },
  { key: 'MEMORIAL_STADIUM', hints: ['MEMORIAL STADIUM', 'STADIUM', 'ZUPPKE'] },
  { key: 'STATE_FARM_CENTER', hints: ['STATE FARM CENTER', 'STATE FARM', 'ASSEMBLY HALL'] },
  // Bare "GYM" is the weakest hint in the table, so any longer phrase — including
  // "KENNEY" itself — outranks it.
  { key: 'KENNEY_GYM', hints: ['GYM'] },
];

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
  if (raw && Object.prototype.hasOwnProperty.call(HACKILLINOIS_VENUES, raw)) {
    return { key: raw, coordinates: HACKILLINOIS_VENUES[raw], matched: true };
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
      return { key: best.key, coordinates: HACKILLINOIS_VENUES[best.key], matched: true };
    }
  }
  return { key: 'SIEBEL_ATRIUM', coordinates: HACKILLINOIS_VENUES.SIEBEL_ATRIUM, matched: false };
}

const EARTH_RADIUS_METERS = 6371000; // Earth mean radius in meters

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
