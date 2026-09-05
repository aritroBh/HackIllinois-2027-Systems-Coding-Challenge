/**
 * Algorithmic Dynamic Karma Surge Engine for WaveShift Nexus.
 * Formulated by Muse (Creative Director & War-Room Experience Designer).
 *
 * Dynamically balances hackathon volunteer demand and supply by increasing
 * Karma rewards for unglamorous late-night shifts and urgent logistics bottlenecks.
 */

export interface ISurgeCalculationParams {
  baseKarma: number;
  capacity: number;
  filledSlots: number;
  startTime: Date;
  currentTime?: Date;
  manualMultiplier?: number;
}

export interface ISurgeResult {
  karmaAward: number;
  surgeMultiplier: number;
  circadianFactor: number;
  scarcityFactor: number;
  urgencyFactor: number;
  isSurgeActive: boolean;
}

export class SurgePricingEngine {
  /**
   * Computes the dynamic surge multiplier and final karma award for a shift.
   */
  public static calculate(params: ISurgeCalculationParams): ISurgeResult {
    const {
      baseKarma,
      capacity,
      filledSlots,
      startTime,
      currentTime = new Date(),
      manualMultiplier = 1.0,
    } = params;

    // 1. Circadian Deficit Multiplier (Peaking at 3:30 AM UTC).
    // UTC is used deliberately so the peak does not wander with server timezone.
    const hour = currentTime.getUTCHours() + currentTime.getUTCMinutes() / 60;
    // Cosine cycle: peaks at h = 3.5 (03:30 AM), trough at h = 15.5 (03:30 PM)
    const cosineComponent = (1 + Math.cos((2 * Math.PI * (hour - 3.5)) / 24)) / 2;
    const circadianFactor = 1.0 + 1.5 * Math.pow(cosineComponent, 2);

    // 2. Capacity Scarcity Multiplier (Super-linear penalty for unfilled slots)
    const deficitRatio = capacity > 0 ? Math.max(0, (capacity - filledSlots) / capacity) : 0;
    const scarcityFactor = 1.0 + 1.8 * Math.pow(deficitRatio, 2);

    // 3. Time-to-Shift Urgency Multiplier
    const minutesToStart = (startTime.getTime() - currentTime.getTime()) / (1000 * 60);
    let urgencyFactor = 1.0;
    if (deficitRatio > 0 && minutesToStart > 0) {
      urgencyFactor = 1.0 + 1.2 * Math.exp(-minutesToStart / 90);
    }

    // Combine factors and cap at 5.0x
    const rawMultiplier = circadianFactor * scarcityFactor * urgencyFactor * manualMultiplier;
    const surgeMultiplier = Math.min(5.0, Math.max(1.0, parseFloat(rawMultiplier.toFixed(2))));

    const karmaAward = Math.round(baseKarma * surgeMultiplier);
    const isSurgeActive = surgeMultiplier >= 1.3;

    return {
      karmaAward,
      surgeMultiplier,
      circadianFactor: parseFloat(circadianFactor.toFixed(2)),
      scarcityFactor: parseFloat(scarcityFactor.toFixed(2)),
      urgencyFactor: parseFloat(urgencyFactor.toFixed(2)),
      isSurgeActive,
    };
  }
}
