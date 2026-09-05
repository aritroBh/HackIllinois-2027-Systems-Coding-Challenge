/**
 * Spatial Geofencing & Haversine Distance Engine.
 * Formulated for HackIllinois venue management across Siebel Center, ECEB, and Kenney Gym.
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
   * Calculates the great-circle distance between two geographic coordinates using the Haversine formula.
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
   * Verifies if a volunteer coordinate is within a specified radius (default 75 meters) of a venue.
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
