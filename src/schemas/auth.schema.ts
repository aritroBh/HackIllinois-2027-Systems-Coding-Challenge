/**
 * Request shapes for the identity endpoints.
 *
 * Nothing here decides who may call anything — the routes carry that, and the shapes below
 * are only about what a well-formed request looks like. Two of them are nonetheless
 * authorisation-relevant and are worth reading as such: `setRoleSchema` cannot express
 * HACKER, and every credential field is bounded on both ends so an oversized body is a 400
 * from the parser rather than work for an HMAC or a database round trip.
 *
 * The credential fields are deliberately loose about *shape* and strict about *length*. A
 * claim code is typed off a badge by somebody who has been awake for a day and a half, so
 * dashes and spaces reach the service, which normalises them; rejecting a hyphen here would
 * turn a correct code into a login failure. Nothing is disclosed by the looseness, because a
 * wrong code matches no document at all.
 */
import { z } from 'zod';
import { objectId } from './common';

/**
 * Mint one badge claim code. Either an account id or an email identifies the target, which is
 * what the `.refine()` enforces — Zod cannot say "at least one of these" in a field
 * validator. `ttlHours` tops out at 336 (two weeks), long enough to print badges well before
 * an event and short enough that a code left on a spare badge does not stay live for a year.
 */
export const issueClaimCodeSchema = z.object({
  body: z
    .object({
      accountId: objectId('Invalid account id').optional(),
      email: z.string().email().optional(),
      ttlHours: z.number().int().min(1).max(336).optional(),
    })
    .refine((b) => !!b.accountId || !!b.email, { message: 'accountId or email is required' }),
});

/** The same, for every account of a kind at once — the pre-event badge print run. */
export const issueClaimCodesBulkSchema = z.object({
  body: z.object({
    kind: z.enum(['VOLUNTEER', 'HACKER']).optional(),
    ttlHours: z.number().int().min(1).max(336).optional(),
  }),
});

/**
 * Redeem a claim code. Ten Crockford base32 characters is fifty bits, and the bound is 10..16
 * rather than exactly 10 so the separators and spacing a person types survive to the service
 * that strips them. Brute force is bounded by the per-IP limiter on this route, not by
 * anything here.
 */
export const claimSchema = z.object({
  body: z.object({
    // 10 Crockford characters, tolerant of dashes/spaces the user may type.
    code: z.string().trim().min(10).max(16),
  }),
});

/**
 * Ask for a magic link. The address is capped at 254 characters, which is the maximum length
 * of an email address, so a megabyte of text in this field is refused before any lookup. The
 * route answers 202 whether or not the address exists, and does not await the send, so the
 * response neither says nor times differently for a real account.
 */
export const magicLinkSchema = z.object({
  body: z.object({ email: z.string().trim().email().max(254) }),
});

/** Redeem one. The token arrives from the URL *fragment*, never a query string, so it does not reach server or proxy logs. */
export const magicRedeemSchema = z.object({
  body: z.object({ token: z.string().min(16).max(256) }),
});

/**
 * Exchange an Adonix token. The 4096 ceiling accommodates a JWT with a roles claim without
 * accepting an unbounded body for something that is about to be HMAC'd or forwarded upstream.
 * `link` asks to attach the Adonix identity to the already-signed-in account rather than
 * resolving to whichever account it names.
 */
export const adonixSchema = z.object({
  body: z.object({ token: z.string().min(16).max(4096), link: z.boolean().optional() }),
});

/**
 * Become an account by naming it, with no credential at all. The shape is harmless; what
 * makes it safe is that the route is **not registered** in production — `auth.routes.ts`
 * decides at construction time — so this is a 404 there rather than a guard that could be
 * misconfigured.
 */
export const devLoginSchema = z.object({
  body: z.object({ accountId: objectId('Invalid account id') }),
});

/** Bump an account's `sessionVersion`, invalidating every cookie ever minted for it. Lead-gated on the route. */
export const revokeSchema = z.object({
  params: z.object({ id: objectId('Invalid account id') }),
});

/**
 * Move an account up or down the volunteer ladder. Organiser-gated on the route.
 *
 * **HACKER is deliberately absent from the enum, and that absence is load-bearing.** The
 * volunteer model enforces `kind === HACKER ⇔ role === HACKER` in a pre-validate hook, so
 * setting `role: 'HACKER'` on a volunteer account — or any of the four below on a hacker —
 * produces an incoherent document that the hook refuses. Rejecting it here turns that into a
 * clean 400 naming the field, instead of a validation error surfacing from a save deep in the
 * service. Changing what kind of account somebody is is not a role change and has no route.
 */
export const setRoleSchema = z.object({
  params: z.object({ id: objectId('Invalid account id') }),
  body: z.object({ role: z.enum(['VOLUNTEER', 'SHIFT_LEAD', 'ORGANIZER', 'ADMIN']) }),
});
