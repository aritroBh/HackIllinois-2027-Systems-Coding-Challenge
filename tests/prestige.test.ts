/**
 * The karma bands, checked against the one place that owns them.
 *
 * `public/views/me.js` carries a copy of the six prestige bands so the Me tab can draw a
 * distance — "1,500 karma to Leviathan Prime" needs both edges of the band, and
 * `GET /me/card` sends the tier the balance landed in without its bounds. (It sends plenty
 * else — karma, shortId, faction, badges — so "only the tier" was an overstatement; it is
 * the band *edges* specifically that are absent, which is the only part a distance needs.
 * The same sentence was corrected in `me.js` and left standing here.) A copy of a server rule is how
 * this repository grows its favourite bug, so the copy is gated rather than trusted.
 *
 * The bug this exists to have caught: the seed hand-typed `prestigeTier` beside
 * `karmaPoints` and the two drifted. Nexus Ops — the account `npm run demo` signs in as —
 * sat on 4,200 karma wearing SIEBEL_GUARDIAN, the band for 1,000-1,999. The leaderboard
 * showed rank one with a lower tier than rank two, who had 600 fewer points, on the demo's
 * own front page.
 *
 * Both halves assert on the *count* of what they parsed before comparing anything. A parser
 * that quietly matches nothing and reports agreement is the failure mode this repository has
 * shipped four times: a check that reads a value which cannot take the failing state.
 */
import fs from 'fs';
import path from 'path';
import { computePrestigeTier, PrestigeTier } from '../src/models/volunteer.model';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** The thresholds as `computePrestigeTier` states them, floor included. */
function bandsFromModel(): Array<{ tier: string; minKarma: number }> {
  const src = read('src', 'models', 'volunteer.model.ts');
  const body = src.slice(src.indexOf('export function computePrestigeTier'));
  const guarded = [...body.matchAll(/points >= (\d+)\)\s*return PrestigeTier\.([A-Z_]+)/g)]
    .map((m) => ({ tier: m[2], minKarma: Number(m[1]) }));
  const floor = body.match(/\n\s*return PrestigeTier\.([A-Z_]+);/);
  if (!floor) throw new Error('computePrestigeTier has no unguarded floor return — retarget this parser');
  return [...guarded, { tier: floor[1], minKarma: 0 }].sort((a, b) => a.minKarma - b.minKarma);
}

/** The thresholds as the Me tab restates them. */
function bandsFromClient(): Array<{ tier: string; minKarma: number }> {
  const src = read('public', 'views', 'me.js');
  const block = src.match(/const TIER_BANDS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('TIER_BANDS not found in public/views/me.js — retarget this parser');
  return [...block[1].matchAll(/tier:\s*'([A-Z_]+)',\s*minKarma:\s*(\d+)/g)]
    .map((m) => ({ tier: m[1], minKarma: Number(m[2]) }))
    .sort((a, b) => a.minKarma - b.minKarma);
}

describe('prestige bands are written down once', () => {
  it('parses six bands out of the model, or says so instead of passing', () => {
    const bands = bandsFromModel();
    expect(bands).toHaveLength(Object.keys(PrestigeTier).length);
    expect(bands[0].minKarma).toBe(0);
  });

  it('parses six bands out of the Me tab, or says so instead of passing', () => {
    expect(bandsFromClient()).toHaveLength(Object.keys(PrestigeTier).length);
  });

  it('the Me tab states exactly the bands the model applies', () => {
    expect(bandsFromClient()).toEqual(bandsFromModel());
  });

  /**
   * The parsed table is only worth anything if it is the table the function honours. This
   * runs the real `computePrestigeTier` at each edge, one point below it, and one above.
   */
  it('every parsed threshold is the point the real function changes its answer at', () => {
    for (const band of bandsFromModel()) {
      expect(computePrestigeTier(band.minKarma)).toBe(band.tier);
      expect(computePrestigeTier(band.minKarma + 1)).toBe(band.tier);
      if (band.minKarma > 0) expect(computePrestigeTier(band.minKarma - 1)).not.toBe(band.tier);
    }
  });

  it('holds below zero and far above the top band', () => {
    expect(computePrestigeTier(-1)).toBe(PrestigeTier.NEOPHYTE_PLANKTON);
    expect(computePrestigeTier(0)).toBe(PrestigeTier.NEOPHYTE_PLANKTON);
    expect(computePrestigeTier(10_000_000)).toBe(PrestigeTier.LEVIATHAN_PRIME);
  });
});

describe('the seed cannot restate the rule and get it wrong', () => {
  /**
   * Not "the six seeded tiers are correct" — that would pass again the moment somebody adds a
   * seventh account with a hand-typed tier. The assertion is that the seed contains no
   * hand-typed tier at all, which is the shape of the original defect.
   */
  it('writes no prestigeTier literal, deriving every one from karma', () => {
    const seed = read('src', 'seed', 'seedData.ts');
    // Every assignment, not "no enum literal anywhere and at least one derivation somewhere".
    //
    // The pair of assertions this replaces could both pass on a seed that derived five tiers
    // and hard-coded the sixth as a raw string — `prestigeTier: 'SIEBEL_GUARDIAN'` names no
    // enum, and the compliant five satisfied the "is derived" half on their own. That is the
    // original defect wearing quotes.
    const assignments = [...seed.matchAll(/prestigeTier\s*:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(assignments.length).toBeGreaterThan(0);   // a parser that matches nothing is not a pass
    for (const value of assignments) {
      expect(value).toMatch(/^computePrestigeTier\(/);
    }
  });

  /**
   * The band 4,200 karma belongs to, stated as a fact rather than as coverage.
   *
   * This deliberately does NOT claim to catch the seed drift. `computePrestigeTier` never
   * had the bug — it returned LEVIATHAN_PRIME for 4,200 before the fix and after it — and
   * this assertion passed the whole time the demo's own leaderboard was showing rank one
   * below rank two. The test above, which refuses a hand-typed literal in the seed, is the
   * one that catches it. Naming this one honestly matters: a future reader seeing both green
   * should not conclude the drift is covered twice.
   */
  it('puts 4,200 karma in the top band, which is where the seed disagreed', () => {
    expect(computePrestigeTier(4200)).toBe(PrestigeTier.LEVIATHAN_PRIME);
  });
});
