/**
 * The gauntlet: win a coding challenge, standing at the gym, to take it.
 *
 * Every test here is written to be able to fail. Three of the invariants are enforced by a
 * database index rather than by service code, and an index that has not been built yet is an
 * invariant that silently is not there — `tests/setup.ts` builds them before the first test,
 * which is what makes the concurrency assertions meaningful rather than decorative.
 *
 * The concurrency tests fire real concurrent calls and assert exact counts, in the style of
 * the fifty-racing-registrations test: "exactly one winner and nineteen refusals" is a claim
 * about the database, and counting is the only way to make it.
 */
import { Types } from 'mongoose';
import { GauntletService } from '../src/services/gauntlet.service';
import { GymService } from '../src/services/gym.service';
import { ChallengeAttempt } from '../src/models/challengeAttempt.model';
import { Gym } from '../src/models/gym.model';
import { Volunteer } from '../src/models/volunteer.model';
import { pack } from '../src/content/loader';

/** The Main Quad, comfortably inside the campus bbox and inside any gym we place on it. */
const AT = { latitude: 40.10746, longitude: -88.22713 };
/** Chicago. Outside every geofence this event has. */
const FAR = { latitude: 41.8781, longitude: -87.6298 };

async function makeGym(name: string) {
  return Gym.create({
    name,
    locationName: 'Test Venue',
    venueKey: 'TEST_VENUE',
    latitude: AT.latitude,
    longitude: AT.longitude,
    controllingFaction: 'NEUTRAL',
    controlPoints: 100,
    maxControlPoints: 800,
    defenders: [],
  });
}

async function makeVolunteer(name: string) {
  return Volunteer.create({ name, email: `${name.toLowerCase()}@test.invalid`, role: 'VOLUNTEER' });
}

/** The answer that judges as correct for a challenge's case, derived the way the pack was authored. */
function correctAnswerFor(challengeId: string, caseIndex: number, candidates: string[]): string | null {
  const challenge = GauntletService.byId(challengeId)!;
  for (const candidate of candidates) {
    if (GauntletService.hashFor(challenge.id, caseIndex, candidate, challenge.normalise) === challenge.cases[caseIndex].hash) {
      return candidate;
    }
  }
  return null;
}

describe('the pack ships judgeable challenges', () => {
  it('loads challenges and a salt from the content pack', () => {
    expect(GauntletService.list().length).toBeGreaterThan(0);
    expect(GauntletService.salt().length).toBeGreaterThanOrEqual(16);
  });

  it('ships no plaintext answer — every case carries only a digest', () => {
    for (const c of GauntletService.list()) {
      for (const cs of c.cases) {
        expect(Object.keys(cs).sort()).toEqual(['hash', 'input']);
        expect(cs.hash).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it('judges a right answer right and a wrong answer wrong', () => {
    // Proven against a real pack challenge rather than a fixture, so a regenerated pack that
    // no longer judges would fail here rather than at a gym.
    const mc = GauntletService.list().find((c) => c.kind === 'MULTIPLE_CHOICE')!;
    const right = correctAnswerFor(mc.id, 0, mc.choices!);
    expect(right).not.toBeNull();
    expect(GauntletService.judge(mc, [right!]).won).toBe(true);
    const wrong = mc.choices!.find((ch) => ch !== right)!;
    expect(GauntletService.judge(mc, [wrong]).won).toBe(false);
  });

  it('normalises exactly as the pack declared, and not more', () => {
    const c = GauntletService.list()[0];
    // caseInsensitive is off by default: folding case when the pack did not ask would accept
    // answers the author did not intend, and the failure would be invisible.
    expect(GauntletService.normalise('  a   b  ', { trim: true, collapseWhitespace: true, caseInsensitive: false })).toBe('a b');
    expect(GauntletService.normalise('AbC', { trim: true, collapseWhitespace: true, caseInsensitive: false })).toBe('AbC');
    expect(GauntletService.normalise('AbC', { trim: true, collapseWhitespace: true, caseInsensitive: true })).toBe('abc');
    expect(c.normalise.trim).toBe(true);
  });
});

describe('you have to be there', () => {
  it('refuses to open a challenge from off campus, before choosing one', async () => {
    const gym = await makeGym('Far Test Gym');
    const v = await makeVolunteer('Faraway');
    await expect(GauntletService.start(String(v._id), String(gym._id), FAR)).rejects.toThrow(/Out of range/);
    // Nothing was created, so a distant caller cannot enumerate the question set.
    expect(await ChallengeAttempt.countDocuments({ accountId: v._id })).toBe(0);
  });

  it('refuses a submission from off campus even when the answer is right', async () => {
    const gym = await makeGym('Walkaway Test Gym');
    const v = await makeVolunteer('Walkaway');
    const served = await GauntletService.start(String(v._id), String(gym._id), AT);
    const challenge = GauntletService.byId(served.challengeId)!;
    const answers = challenge.cases.map((_, i) =>
      correctAnswerFor(challenge.id, i, challenge.choices ?? ['2', '60', '1', 'ReferenceError']) ?? 'x');
    // This is the line that stops "start at the gym, answer from the bus".
    await expect(GauntletService.submit(String(v._id), served.attemptId, answers, FAR)).rejects.toThrow(/Out of range/);
    const still = await ChallengeAttempt.findById(served.attemptId);
    expect(still!.status).toBe('OPEN');
  });
});

describe('one open attempt per account, decided by the database', () => {
  it('lets twenty concurrent starts create exactly one attempt', async () => {
    const gyms = await Promise.all(Array.from({ length: 20 }, (_, i) => makeGym(`Race Gym ${i}`)));
    const v = await makeVolunteer('Racer');
    const results = await Promise.allSettled(
      gyms.map((g) => GauntletService.start(String(v._id), String(g._id), AT))
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ChallengeAttempt.countDocuments({ accountId: v._id, status: 'OPEN' })).toBe(1);
  });
});

describe('a win is spent exactly once', () => {
  it('lets twenty concurrent spends capture once and refuse nineteen times', async () => {
    const gym = await makeGym('Spend Once Gym');
    const v = await makeVolunteer('Spender');
    const served = await GauntletService.start(String(v._id), String(gym._id), AT);
    const challenge = GauntletService.byId(served.challengeId)!;
    const answers = challenge.cases.map((_, i) =>
      correctAnswerFor(challenge.id, i, challenge.choices ?? ['2', '60', '1', 'ReferenceError'])!);
    const { won } = await GauntletService.submit(String(v._id), served.attemptId, answers, AT);
    expect(won).toBe(true);

    const spends = await Promise.allSettled(
      Array.from({ length: 20 }, () => GauntletService.spend(String(v._id), served.attemptId))
    );
    expect(spends.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = await ChallengeAttempt.findById(served.attemptId);
    expect(after!.status).toBe('SPENT');
  });
});

describe('a win is never burned on a blow that cannot land', () => {
  it('refuses the spend, and keeps the win, when the gym still has more points than the challenge is worth', async () => {
    const gym = await makeGym('Too Strong Gym');
    // Rival-held, and holding far more than any challenge in the pack is worth.
    await Gym.updateOne({ _id: gym._id }, { $set: { controllingFaction: 'TEAM_TENSOR', controlPoints: 5000 } });
    const v = await makeVolunteer('Hopeful');
    const served = await GauntletService.start(String(v._id), String(gym._id), AT);
    const challenge = GauntletService.byId(served.challengeId)!;
    const answers = challenge.cases.map((_, i) =>
      correctAnswerFor(challenge.id, i, challenge.choices ?? ['2', '60', '1', 'ReferenceError'])!);
    expect((await GauntletService.submit(String(v._id), served.attemptId, answers, AT)).won).toBe(true);

    await expect(GauntletService.spend(String(v._id), served.attemptId, 'TEAM_KERNEL'))
      .rejects.toThrow(/control points/);
    // The whole point: the refusal must not have cost the win.
    const after = await ChallengeAttempt.findById(served.attemptId);
    expect(after!.status).toBe('WON');
  });

  it('allows the spend once the gym has been worn down to within reach', async () => {
    const gym = await makeGym('Worn Down Gym');
    await Gym.updateOne({ _id: gym._id }, { $set: { controllingFaction: 'TEAM_TENSOR', controlPoints: 1 } });
    const v = await makeVolunteer('Persistent');
    const served = await GauntletService.start(String(v._id), String(gym._id), AT);
    const challenge = GauntletService.byId(served.challengeId)!;
    const answers = challenge.cases.map((_, i) =>
      correctAnswerFor(challenge.id, i, challenge.choices ?? ['2', '60', '1', 'ReferenceError'])!);
    await GauntletService.submit(String(v._id), served.attemptId, answers, AT);
    const spent = await GauntletService.spend(String(v._id), served.attemptId, 'TEAM_KERNEL');
    expect(spent.gymId).toBe(String(gym._id));
    expect((await ChallengeAttempt.findById(served.attemptId))!.status).toBe('SPENT');
  });
});

describe('a deadline is a deadline', () => {
  it('refuses a correct answer submitted after the clock ran out', async () => {
    const gym = await makeGym('Deadline Gym');
    const v = await makeVolunteer('Latecomer');
    const served = await GauntletService.start(String(v._id), String(gym._id), AT);
    // Wind the deadline into the past rather than sleeping: the assertion is about the
    // comparison, and a test that waits five minutes is a test nobody runs.
    await ChallengeAttempt.updateOne({ _id: served.attemptId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const challenge = GauntletService.byId(served.challengeId)!;
    const answers = challenge.cases.map((_, i) =>
      correctAnswerFor(challenge.id, i, challenge.choices ?? ['2', '60', '1', 'ReferenceError'])!);
    await expect(GauntletService.submit(String(v._id), served.attemptId, answers, AT)).rejects.toThrow(/Time is up/);
    const after = await ChallengeAttempt.findById(served.attemptId);
    expect(after!.status).toBe('EXPIRED');
  });
});

describe('the served payload carries no answer', () => {
  it('sends inputs and never a digest', async () => {
    const gym = await makeGym('Payload Gym');
    const v = await makeVolunteer('Reader');
    const served = await GauntletService.start(String(v._id), String(gym._id), AT);
    const wire = JSON.stringify(served);
    const challenge = GauntletService.byId(served.challengeId)!;
    for (const cs of challenge.cases) expect(wire).not.toContain(cs.hash);
    expect(served.cases.every((c) => Object.keys(c).sort().join() === 'index,input')).toBe(true);
  });
});

describe('the gauntlet gate on capture', () => {
  const flag = () => pack.event.gauntlet.requiredForCapture;

  it('is off by default, so a pack that opts out captures on control points alone', () => {
    // Guards the fork story: `content/example-campus` ships no challenges, and a default of
    // true would make every rival gym on such a pack permanently uncapturable.
    expect(typeof flag()).toBe('boolean');
    expect(GauntletService.requiredForCapture()).toBe(flag() && GauntletService.list().length > 0);
  });

  it('leaves a rival gym on its last point instead of flipping it, when required', async () => {
    const original = pack.event.gauntlet.requiredForCapture;
    pack.event.gauntlet.requiredForCapture = true;
    try {
      const gym = await makeGym('Gated Gym');
      await Gym.updateOne({ _id: gym._id }, { $set: { controllingFaction: 'TEAM_TENSOR', controlPoints: 50 } });
      const v = await makeVolunteer('Grinder');
      const result = await GymService.battleOrContribute(String(gym._id), String(v._id), 'TEAM_KERNEL' as never, 500, AT);
      expect(result.action).toBe('ATTACKED');
      expect(result.newControlPoints).toBe(1);
      expect(result.message).toMatch(/coding challenge/i);
      const after = await Gym.findById(gym._id);
      // The thing that must NOT have happened.
      expect(after!.controllingFaction).toBe('TEAM_TENSOR');
    } finally {
      pack.event.gauntlet.requiredForCapture = original;
    }
  });

  it('flips the same gym when the blow arrives through a won gauntlet', async () => {
    const original = pack.event.gauntlet.requiredForCapture;
    pack.event.gauntlet.requiredForCapture = true;
    try {
      const gym = await makeGym('Gated Gym Two');
      await Gym.updateOne({ _id: gym._id }, { $set: { controllingFaction: 'TEAM_TENSOR', controlPoints: 50 } });
      const v = await makeVolunteer('Winner');
      const result = await GymService.battleOrContribute(
        String(gym._id), String(v._id), 'TEAM_KERNEL' as never, 300, AT, { viaGauntlet: true }
      );
      expect(result.action).toBe('CAPTURED');
      const after = await Gym.findById(gym._id);
      expect(after!.controllingFaction).toBe('TEAM_KERNEL');
    } finally {
      pack.event.gauntlet.requiredForCapture = original;
    }
  });
});

afterEach(async () => {
  await ChallengeAttempt.deleteMany({});
  await Gym.deleteMany({ venueKey: 'TEST_VENUE' });
  await Volunteer.deleteMany({ email: /@test\.invalid$/ });
});

// Keeps `Types` referenced for the id helpers above without a lint suppression.
export const _ = Types;
