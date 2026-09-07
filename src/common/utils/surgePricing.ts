/**
 * Surge pricing — how much a shift is advertised as paying, and how much it actually pays.
 *
 * The problem is that the 3 a.m. rubbish run and the 2 p.m. sponsor desk both pay
 * `baseKarma`, and only one of them fills. Rather than making an organiser hand-tune every
 * unpopular shift, three factors multiply the base: the hour it falls in, how empty it is,
 * and how soon it starts. Each is a pure function of the shift and the clock, so the number
 * shown on a shift card and the number paid at check-out come from the same call.
 *
 * **This is not display-only.** `ShiftService` calls it to decorate a listing, and
 * `CheckInService.checkOut` calls it to decide the payout — with `currentTime` pinned to the
 * check-*in* moment, so a volunteer is paid the rate advertised when they turned up rather
 * than the rate the shift has decayed to by the time they leave. Changing a coefficient here
 * moves real balances.
 *
 * **The clamp does most of the work, and that is worth knowing before tuning anything.** The
 * three factors top out at 2.5, 2.8 and 2.2, so their product reaches 15.4 before the manual
 * multiplier is applied at all, against a ceiling of 5.0. In the region that matters — a
 * mostly-empty shift starting soon at an unsociable hour — the result is the ceiling, and
 * raising any one coefficient changes nothing there. The coefficients shape the *middle* of
 * the range; the ceiling decides the top of it.
 *
 * **The circadian peak is in the event's local time, and that took two goes to get right.**
 * The original read `getUTCHours()` and put the peak at 03:30 UTC. The reasoning written next
 * to it was sound as far as it went — the peak must be a property of the event and not of
 * whatever `TZ` the server happens to boot with, so reading a UTC clock is correct — but it
 * then treated UTC as though it were the event's clock. For the shipped pack
 * (`America/Chicago`, UTC−6 in late February) the peak landed at 21:30 local the previous
 * evening, and the real 3:30 a.m. fell at 09:30 UTC, where the cosine term is exactly zero and
 * the factor is 1.375 out of a possible 2.5.
 *
 * That is not a rounding detail. This whole file exists because the 3 a.m. rubbish run does
 * not fill, and the term named for the graveyard shift was paying the graveyard shift a
 * middling rate while peaking during the evening, when shifts fill on their own.
 *
 * The fix reads the hour in `pack.event.timezone`, which is a required pack field that
 * `karmaLedger.model.ts` and `quest.service.ts` were already formatting against. An older
 * version of this comment said the event's timezone was "not yet something a pack can set";
 * that was untrue when it was written. Doing it through `Intl` rather than a fixed offset also
 * means an event in June gets CDT rather than CST without anybody remembering to change a
 * number.
 *
 * None of these coefficients is derived from data. The event has not run.
 */
import { eventLocalHour } from './eventClock';

/**
 * What the caller knows about the shift. `currentTime` defaults to now and is overridden by
 * check-out, which needs the rate as it stood at check-in. `manualMultiplier` is the
 * organiser's thumb on the scale from `Shift.manualSurgeMultiplier`, bounded 1.0–5.0 by the
 * shift schema.
 */
export interface ISurgeCalculationParams {
  baseKarma: number;
  capacity: number;
  filledSlots: number;
  startTime: Date;
  currentTime?: Date;
  manualMultiplier?: number;
}

/**
 * The three factors are returned alongside the result so a shift card can explain itself
 * ("2.1x — late night, nearly empty") instead of showing an unexplained number. They are the
 * rounded-for-display copies; the multiplier was computed from the unrounded ones.
 *
 * `isSurgeActive` is the boolean the `surgeOnly` list filter and the dashboard badge read.
 */
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
   * Pure and side-effect free: same inputs, same answer, no reads. That is what lets the
   * listing path call it once per shift in a loop and the check-out path call it again later
   * with a pinned `currentTime` and get the same number the volunteer was shown.
   *
   * The three factors are independent by construction — an empty shift at noon and a full
   * shift at 3 a.m. are different problems and each has its own term — and they *multiply*
   * rather than add, so a shift that is unpopular for two reasons at once is worth more than
   * the sum of the two.
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

    // 1. Circadian factor: 1.0 at the trough, 2.5 at the peak.
    //
    // The hour is the event's own wall clock, not the server's and not UTC. Both of the
    // properties that matter hold: the peak does not wander with the server's `TZ`, because
    // nothing here reads it, and 03:30 means half past three where the volunteers are. See the
    // file header for what this used to do and why it mattered.
    //
    // Squaring the cosine is what makes it a peak rather than a wave: a raw cosine spends
    // half the day above 1.75x, whereas the square keeps the multiplier near 1 for most of
    // the daytime and concentrates the money in a few hours around the maximum.
    const hour = eventLocalHour(currentTime);
    // Cosine cycle: peaks at local h = 3.5 (03:30), trough at local h = 15.5 (15:30).
    const cosineComponent = (1 + Math.cos((2 * Math.PI * (hour - 3.5)) / 24)) / 2;
    const circadianFactor = 1.0 + 1.5 * Math.pow(cosineComponent, 2);

    // 2. Scarcity factor: 1.0 at full, 2.8 at empty.
    //
    // Squared for the same reason. A shift missing one of twelve people needs no incentive;
    // one missing eleven of twelve needs all of it, and a linear term would spend most of the
    // budget on shifts that were going to fill anyway.
    //
    // `capacity > 0` is not defensive noise: `capacity` is only bounded away from zero by the
    // shift schema, and this method is also called directly with figures assembled by a
    // caller. Dividing by a zero capacity would produce a NaN multiplier and a NaN payout.
    const deficitRatio = capacity > 0 ? Math.max(0, (capacity - filledSlots) / capacity) : 0;
    const scarcityFactor = 1.0 + 1.8 * Math.pow(deficitRatio, 2);

    // 3. Urgency factor: 1.0 far out, rising towards 2.2 as the start time arrives.
    //
    // Gated on `deficitRatio > 0`, so a shift that is already full gets nothing from the
    // clock — there is no one left to attract. Gated on `minutesToStart > 0` too, which means
    // urgency is exactly 1.0 for a shift already in progress: a late arrival is paid the rate
    // the shift had before it started, never a rising one, so there is nothing to gain by
    // turning up late. The 90-minute constant is the decay's half-life-ish scale rather than a
    // cutoff — at 90 minutes out the factor is about 1.44, at 30 about 1.86.
    const minutesToStart = (startTime.getTime() - currentTime.getTime()) / (1000 * 60);
    let urgencyFactor = 1.0;
    if (deficitRatio > 0 && minutesToStart > 0) {
      urgencyFactor = 1.0 + 1.2 * Math.exp(-minutesToStart / 90);
    }

    // The product reaches 15.4 before `manualMultiplier` is applied, so the 5.0 ceiling is not
    // a safety rail that rarely fires — it is the operative rule anywhere two factors are high
    // at once. The 1.0 floor exists for the direct-call case: `manualMultiplier` cannot go
    // below 1.0 over HTTP, but nothing stops an internal caller passing something smaller, and
    // a surge that pays less than base is not a surge.
    const rawMultiplier = circadianFactor * scarcityFactor * urgencyFactor * manualMultiplier;
    const surgeMultiplier = Math.min(5.0, Math.max(1.0, parseFloat(rawMultiplier.toFixed(2))));

    const karmaAward = Math.round(baseKarma * surgeMultiplier);
    // 1.3 is the threshold for calling it surging in the UI. Below it the three factors are
    // still nudging the number, but a 1.1x badge on a shift card is noise rather than a signal.
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
