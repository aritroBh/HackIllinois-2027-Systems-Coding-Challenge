import { Types } from 'mongoose';
import { CheckIn, ICheckIn } from '../models/checkin.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { Shift } from '../models/shift.model';
import { Volunteer, computePrestigeTier } from '../models/volunteer.model';
import { DynamicQrTokenEngine, IVerificationResult } from '../common/utils/crypto';
import { SurgePricingEngine } from '../common/utils/surgePricing';
import { GeoEngine, HACKILLINOIS_VENUES } from '../common/utils/geo';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';


export class CheckInService {
  /**
   * Generates a dynamic 30-second HMAC QR token for a volunteer's shift.
   */
  public static async generateToken(volunteerId: string, shiftId: string): Promise<{
    token: string;
    expiresInSeconds: number;
    timeSlice: number;
  }> {
    const reg = await Registration.findOne({
      shiftId: new Types.ObjectId(shiftId),
      volunteerId: new Types.ObjectId(volunteerId),
      status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] },
    });

    if (!reg) {
      throw ApiError.badRequest('Volunteer does not hold a confirmed spot for this shift.');
    }

    const now = Date.now();
    const token = DynamicQrTokenEngine.generateToken(volunteerId, shiftId, now);

    return {
      token,
      expiresInSeconds: 30 - (Math.floor(now / 1000) % 30),
      timeSlice: Math.floor(now / 1000 / 30),
    };
  }

  /**
   * Verifies an incoming dynamic QR code and marks attendance with optional geofence verification.
   */
  public static async verifyAndCheckIn(
    token: string,
    scannerId = 'DESK_SCANNER_MAIN',
    userCoordinates?: { latitude: number; longitude: number }
  ): Promise<{
    checkIn: ICheckIn;
    verification: IVerificationResult;
    geofenceStatus?: { distanceMeters: number; maxAllowedMeters: number; passed: boolean };
  }> {
    const verification = DynamicQrTokenEngine.verifyToken(token);

    if (!verification.valid) {
      if (verification.reason === 'EXPIRED') {
        throw ApiError.badRequest('QR token has expired (>30s old). Refresh your token.', { code: ErrorCode.TOKEN_EXPIRED });
      }
      if (verification.reason === 'REPLAY_ATTACK') {
        throw ApiError.conflict('Token replay attack detected: This QR token has already been scanned.', ErrorCode.REPLAY_ATTACK_DETECTED);
      }
      throw ApiError.badRequest(`Invalid QR token: ${verification.reason}`, { code: ErrorCode.MALFORMED_TOKEN });
    }

    const { volunteerId, shiftId } = verification;

    // Verify registration exists
    const reg = await Registration.findOne({
      shiftId: new Types.ObjectId(shiftId!),
      volunteerId: new Types.ObjectId(volunteerId!),
      status: { $in: [RegistrationStatus.CONFIRMED, RegistrationStatus.CHECKED_IN] },
    });

    if (!reg) {
      throw ApiError.notFound('Confirmed registration for this shift not found.', ErrorCode.REGISTRATION_NOT_FOUND);
    }

    const shift = await Shift.findById(shiftId);
    if (!shift) {
      throw ApiError.notFound('Shift not found.');
    }

    let geofenceStatus: { distanceMeters: number; maxAllowedMeters: number; passed: boolean } | undefined;
    if (userCoordinates) {
      const venueCoord = HACKILLINOIS_VENUES[shift.location] || HACKILLINOIS_VENUES.SIEBEL_ATRIUM;
      const geoCheck = GeoEngine.isWithinGeofence(userCoordinates, venueCoord, 75);
      geofenceStatus = {
        distanceMeters: geoCheck.distanceMeters,
        maxAllowedMeters: geoCheck.maxRadiusMeters,
        passed: geoCheck.allowed,
      };
      if (!geoCheck.allowed) {
        throw ApiError.forbidden(
          `Geofence Check-In Denied: You are ${geoCheck.distanceMeters}m away from ${shift.location} (Max allowed: 75m). Move closer to the check-in terminal.`
        );
      }
    }

    // Check if already checked in
    if (reg.status === RegistrationStatus.CHECKED_IN) {
      const existingCheckIn = await CheckIn.findOne({ registrationId: reg._id });
      if (existingCheckIn) {
        return { checkIn: existingCheckIn, verification, geofenceStatus };
      }
    }

    const nonce = token.split('.')[0];

    // Create CheckIn record
    const checkIn = await CheckIn.create({
      registrationId: reg._id,
      shiftId: new Types.ObjectId(shiftId),
      volunteerId: new Types.ObjectId(volunteerId),
      checkInTime: new Date(),
      nonce,
      verifiedBy: scannerId,
    });

    // Update registration status
    reg.status = RegistrationStatus.CHECKED_IN;
    reg.checkInTime = new Date();
    await reg.save();

    const vol = await Volunteer.findById(volunteerId);

    eventHub.broadcast({
      type: 'VOLUNTEER_CHECKED_IN',
      data: {
        volunteerId,
        volunteerName: vol ? vol.name : 'Volunteer',
        shiftId,
        shiftTitle: shift.title,
        checkInTime: checkIn.checkInTime,
        geofenceVerified: Boolean(userCoordinates),
      },
    });

    return { checkIn, verification, geofenceStatus };
  }

  /**
   * Concludes a shift check-out, calculates hours, and applies dynamic karma multiplier.
   */
  public static async checkOut(checkInId: string): Promise<ICheckIn> {
    const checkIn = await CheckIn.findById(checkInId);
    if (!checkIn) {
      throw ApiError.notFound('CheckIn record not found.');
    }
    if (checkIn.checkOutTime) {
      return checkIn;
    }

    const now = new Date();
    checkIn.checkOutTime = now;

    // Calculate duration in minutes
    const durationMinutes = Math.max(1, Math.round((now.getTime() - checkIn.checkInTime.getTime()) / (1000 * 60)));
    checkIn.durationMinutes = durationMinutes;

    // Compute earned karma with surge multiplier
    const shift = await Shift.findById(checkIn.shiftId);
    const baseKarma = shift ? shift.baseKarma : 100;

    const surge = SurgePricingEngine.calculate({
      baseKarma,
      capacity: shift ? shift.capacity : 1,
      filledSlots: shift ? shift.filledSlots : 1,
      startTime: shift ? shift.startTime : now,
      currentTime: checkIn.checkInTime,
      manualMultiplier: shift ? shift.manualSurgeMultiplier : 1.0,
    });

    const hours = durationMinutes / 60;
    const earnedKarma = Math.round(surge.karmaAward * Math.max(0.5, hours));
    checkIn.karmaAwarded = earnedKarma;
    await checkIn.save();

    // Update registration
    await Registration.findByIdAndUpdate(checkIn.registrationId, {
      $set: {
        status: RegistrationStatus.COMPLETED,
        checkOutTime: now,
        earnedKarma,
      },
    });

    // Update volunteer profile, karma balance, hours, and prestige tier
    const volunteer = await Volunteer.findById(checkIn.volunteerId);
    if (volunteer) {
      volunteer.karmaPoints += earnedKarma;
      volunteer.hoursServed = parseFloat((volunteer.hoursServed + hours).toFixed(2));
      volunteer.prestigeTier = computePrestigeTier(volunteer.karmaPoints);

      // Check special badges
      const checkInHour = checkIn.checkInTime.getHours();
      if ((checkInHour >= 2 && checkInHour <= 5) && !volunteer.badges.includes('MIDNIGHT_KRAKEN')) {
        volunteer.badges.push('MIDNIGHT_KRAKEN');
      }
      if (surge.surgeMultiplier >= 3.0 && !volunteer.badges.includes('SIEBEL_GUARDIAN')) {
        volunteer.badges.push('SIEBEL_GUARDIAN');
      }

      await volunteer.save();
    }

    eventHub.broadcast({
      type: 'VOLUNTEER_CHECKED_OUT',
      data: {
        volunteerId: checkIn.volunteerId,
        karmaAwarded: earnedKarma,
        hoursServed: hours,
        totalKarma: volunteer ? volunteer.karmaPoints : 0,
        prestigeTier: volunteer ? volunteer.prestigeTier : 'NEOPHYTE_PLANKTON',
      },
    });

    return checkIn;
  }
}
