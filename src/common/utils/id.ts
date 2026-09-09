/**
 * Canonical ObjectId comparison. Hex casing and populated-document wrapping are
 * normalised away so ownership and self-dealing checks compare identity, not spelling.
 */
import { OBJECT_ID_PATTERN } from '../../schemas/common';

/**
 * Case-insensitive identity comparison for Mongo ObjectIds.
 *
 * ObjectId hex is case-insensitive as a *value* — `new Types.ObjectId('6A9C…')` and
 * `new Types.ObjectId('6a9c…')` are the same document — but it is case-*sensitive* as a
 * JavaScript string. Every ownership check in the service layer compares a caller-supplied
 * id against `someDoc.field.toString()`, and `toString()` always returns lowercase. So a
 * caller who spells their own id in uppercase fails the check on their own record.
 *
 * Over HTTP that cannot happen: `objectId()` in `src/schemas/common.ts` lowercases at the
 * validation boundary. But services are also called directly — by the test suite, by the
 * seeder, and by any future internal flow — and those callers never pass through Zod.
 * A guard that is only correct because of a caller's spelling is not a guard, so the
 * comparison itself is made case-insensitive here rather than relying on the boundary.
 *
 * Both directions of failure matter and they fail differently:
 *   - An *ownership* check (`a !== b` → 403) fails **closed** on a casing mismatch: the
 *     legitimate owner is denied. Annoying, not dangerous.
 *   - A *self-dealing* check (`a === b` → reject) fails **open**: the same volunteer
 *     spelled two ways slips past a "you cannot swap with yourself" guard.
 *
 * The second is why this is a correctness fix and not a cosmetic one.
 *
 * @param a First identifier. Accepts anything with a `toString()` — a raw string, an
 *          `ObjectId`, or a populated document's `_id`.
 * @param b Second identifier, same contract.
 * @returns `true` when both are present and name the same ObjectId, ignoring hex casing.
 *          A null or undefined operand is never equal to anything, including another
 *          null — absent identity must not satisfy an ownership check.
 */
export function sameId(a: unknown, b: unknown): boolean {
  const left = normalise(a);
  const right = normalise(b);
  if (left === null || right === null) return false;
  return left === right;
}

/**
 * Reduce a value to a comparable id string, or `null` if it does not name one.
 *
 * The `_id` unwrapping matters. A field that has been `.populate()`d is no longer an
 * ObjectId — it is the whole referenced document, and stringifying one of those yields a
 * dump of its fields rather than an identifier. Comparing two of those is meaningless:
 * it answers "are these documents identical in every field", which is not the question.
 * Unwrapping to `_id` first means the comparison keeps asking about identity whether it
 * is handed a raw string, an ObjectId, or a populated document.
 *
 * Anything that does not reduce to a 24-character hex id returns `null`, which never
 * compares equal — including to another `null`. Absent identity must not satisfy an
 * ownership check, and two missing ids must not satisfy a self-dealing check either.
 */
function normalise(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  // A populated document (or any object carrying an `_id`) reduces to that id.
  //
  // The self-reference check is not paranoia: BSON's `ObjectId` exposes a legacy `_id`
  // getter that returns the ObjectId itself, so an unguarded recursion here never
  // terminates on the single most common input this function receives. When `_id` points
  // back at the value, fall through and stringify it — an ObjectId already *is* the id.
  if (typeof value === 'object' && '_id' in (value as Record<string, unknown>)) {
    const inner = (value as { _id: unknown })._id;
    if (inner !== value) return normalise(inner);
  }

  const text = String(value).toLowerCase();
  return OBJECT_ID_PATTERN.test(text) ? text : null;
}
