import { Gym, IGym, Faction } from '../models/gym.model';
import { Volunteer } from '../models/volunteer.model';
import { GeoEngine, IGeoCoordinates } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { eventHub } from '../common/sse/eventHub';

export interface IBattleResult {
  gymId: string;
  action: 'CONTRIBUTED' | 'ATTACKED' | 'CAPTURED';
  controllingFaction: Faction;
  newControlPoints: number;
  maxControlPoints: number;
  leaderName: string;
  karmaAwarded: number;
  message: string;
}

export class GymService {
  /**
   * Retrieves all campus gyms with real-time control points.
   */
  public static async listGyms(): Promise<IGym[]> {
    return Gym.find().sort({ name: 1 });
  }

  /**
   * Atomic CAS Battle / Fortification Engine.
   * - If volunteer is in the controlling faction (or gym is NEUTRAL): reinforce points up to max.
   * - If volunteer is in an opposing faction: attack and reduce points.
   * - If control points reach 0: Gym is captured, flips faction, attacker becomes new Gym Leader!
   */
  public static async battleOrContribute(
    gymId: string,
    volunteerId: string,
    volunteerFaction: Faction,
    power: number = 100,
    coordinates?: IGeoCoordinates
  ): Promise<IBattleResult> {
    const volunteer = await Volunteer.findById(volunteerId);
    if (!volunteer) {
      throw ApiError.notFound('Volunteer not found.');
    }

    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const gym = await Gym.findById(gymId);
      if (!gym) {
        throw ApiError.notFound('Gym not found.');
      }

      // Geofence verification if coordinates provided
      if (coordinates) {
        const geoCheck = GeoEngine.isWithinGeofence(
          coordinates,
          { latitude: gym.latitude, longitude: gym.longitude },
          75
        );
        if (!geoCheck.allowed) {
          throw ApiError.forbidden(
            `Out of range: You are ${geoCheck.distanceMeters}m from ${gym.name}. Must be within 75m to contest this Gym.`
          );
        }
      }

      // Check Boba Shield active status
      if (gym.isShielded && gym.shieldExpiresAt && gym.shieldExpiresAt > new Date()) {
        throw ApiError.conflict('Gym is currently protected by an active Boba Shield. Cannot contest!');
      }

      const currentFaction = gym.controllingFaction;
      const isAlly = currentFaction === Faction.NEUTRAL || currentFaction === volunteerFaction;

      if (isAlly) {
        // --- CASE 1: REINFORCE / DEFEND ---
        const newPoints = Math.min(gym.maxControlPoints, gym.controlPoints + power);
        const shouldBeLeader = !gym.leaderVolunteerId || power > 150;

        const updated = await Gym.findOneAndUpdate(
          { _id: gym._id, version: gym.version },
          {
            $set: {
              controllingFaction: volunteerFaction,
              controlPoints: newPoints,
              leaderVolunteerId: shouldBeLeader ? volunteer._id : gym.leaderVolunteerId,
              leaderName: shouldBeLeader ? volunteer.name : gym.leaderName,
              lastBattledAt: new Date(),
            },
            $inc: { version: 1 },
          },
          { new: true }
        );

        if (!updated) continue; // CAS conflict, retry next iteration

        const karmaAward = Math.floor(power * 0.25);
        await Volunteer.findByIdAndUpdate(volunteerId, { $inc: { karmaPoints: karmaAward } });

        eventHub.broadcast({
          type: 'GYM_REINFORCED',
          data: { gymId, faction: volunteerFaction, controlPoints: newPoints, leaderName: updated.leaderName },
        });

        return {
          gymId,
          action: 'CONTRIBUTED',
          controllingFaction: volunteerFaction,
          newControlPoints: newPoints,
          maxControlPoints: gym.maxControlPoints,
          leaderName: updated.leaderName,
          karmaAwarded: karmaAward,
          message: `Successfully fortified ${gym.name} for ${volunteerFaction}! (+${power} CP)`,
        };
      } else {
        // --- CASE 2: ATTACK OPPOSING FACTION ---
        if (gym.controlPoints > power) {
          const newPoints = gym.controlPoints - power;
          const updated = await Gym.findOneAndUpdate(
            { _id: gym._id, version: gym.version },
            {
              $set: {
                controlPoints: newPoints,
                lastBattledAt: new Date(),
              },
              $inc: { version: 1 },
            },
            { new: true }
          );

          if (!updated) continue; // CAS conflict, retry next iteration

          const karmaAward = Math.floor(power * 0.35);
          await Volunteer.findByIdAndUpdate(volunteerId, { $inc: { karmaPoints: karmaAward } });

          eventHub.broadcast({
            type: 'GYM_ATTACKED',
            data: { gymId, attackedFaction: currentFaction, remainingPoints: newPoints },
          });

          return {
            gymId,
            action: 'ATTACKED',
            controllingFaction: currentFaction,
            newControlPoints: newPoints,
            maxControlPoints: gym.maxControlPoints,
            leaderName: gym.leaderName,
            karmaAwarded: karmaAward,
            message: `Inflicted ${power} damage on ${gym.name}! ${newPoints} CP remaining.`,
          };
        } else {
          // --- CASE 3: GYM OVERTHROW / FACTION FLIP! ---
          const freshControlPoints = Math.max(100, power);
          const updated = await Gym.findOneAndUpdate(
            { _id: gym._id, version: gym.version },
            {
              $set: {
                controllingFaction: volunteerFaction,
                controlPoints: freshControlPoints,
                leaderVolunteerId: volunteer._id,
                leaderName: volunteer.name,
                defenders: [
                  {
                    volunteerId: volunteer._id,
                    volunteerName: volunteer.name,
                    contributedPower: power,
                    assignedAt: new Date(),
                  },
                ],
                lastBattledAt: new Date(),
              },
              $inc: { version: 1 },
            },
            { new: true }
          );

          if (!updated) continue; // CAS conflict, retry next iteration

          const karmaAward = 150; // Capture bonus!
          await Volunteer.findByIdAndUpdate(volunteerId, { $inc: { karmaPoints: karmaAward } });

          eventHub.broadcast({
            type: 'GYM_CAPTURED',
            data: {
              gymId,
              newFaction: volunteerFaction,
              conqueror: volunteer.name,
              controlPoints: freshControlPoints,
            },
          });

          return {
            gymId,
            action: 'CAPTURED',
            controllingFaction: volunteerFaction,
            newControlPoints: freshControlPoints,
            maxControlPoints: gym.maxControlPoints,
            leaderName: volunteer.name,
            karmaAwarded: karmaAward,
            message: `💥 CAPTURE! ${gym.name} was overthrown and now flies the banner of ${volunteerFaction}!`,
          };
        }
      }
    }

    throw ApiError.conflict('Gym contestation was interrupted by high-concurrency write contention. Please retry.');
  }
}
