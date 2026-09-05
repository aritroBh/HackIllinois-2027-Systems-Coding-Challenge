/**
 * Spatial Geofencing & Haversine Distance Engine.
 * Formulated for HackIllinois venue management across Siebel Center, ECEB, and Kenney Gym.
 */

export interface IGeoCoordinates {
  latitude: number;
  longitude: number;
}

export const HACKILLINOIS_VENUES: Record<string, IGeoCoordinates> = {
  SIEBEL_ATRIUM: { latitude: 40.113812, longitude: -88.224937 },
  SIEBEL_BASEMENT: { latitude: 40.113725, longitude: -88.224810 },
  ECEB_LOBBY: { latitude: 40.114828, longitude: -88.228056 },
  KENNEY_GYM: { latitude: 40.113054, longitude: -88.228012 },
  DCL_BRIDGE: { latitude: 40.113215, longitude: -88.226500 },
};

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

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
