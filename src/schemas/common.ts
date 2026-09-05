/**
 * Shared primitives used across request schemas.
 */
import { z } from 'zod';

/** 24-character hexadecimal ObjectId, matching MongoDB's own accepted form. */
export const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * An ObjectId accepted in either casing and **normalised to lowercase**.
 *
 * MongoDB parses `6A9B…EF` and `6a9b…ef` as the same 12-byte identifier, so both must be
 * accepted. But several code paths use the id *string* as an identity key rather than
 * casting it — a distributed lock name, a Mongo map field path, an idempotency hash
 * input, and the ownership comparisons that test it against a stored `.toString()`
 * (which is always lowercase).
 *
 * Left un-normalised, one volunteer has 2^n spellings for an id containing n letters,
 * and each spelling is a distinct key. That splits the per-volunteer reservation lock
 * and the HackStop cooldown (letting one account bypass both), splits the idempotency
 * record, and simultaneously *denies* a legitimate user who submits their own id in
 * uppercase, because it will not match the lowercase stored form.
 *
 * Normalising here — at the validation boundary, before any handler runs — collapses all
 * of those to a single canonical form in one place, rather than requiring every future
 * call site to remember. Prefer this over a bare `z.string().regex(...)` for any field
 * that holds an ObjectId.
 */
export const objectId = (message = 'Invalid ObjectId'): z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .regex(OBJECT_ID_PATTERN, message)
    .transform((value) => value.toLowerCase());
