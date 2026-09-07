/**
 * Contract-first request validation.
 *
 * Every route that accepts input mounts `validate(schema)` ahead of its controller, so a
 * controller can assume its input is already shaped, bounded and typed. This is the only
 * place request data is trusted to change shape, which is what makes the boundary
 * auditable: to know what a route accepts, read one Zod schema.
 *
 * **The write-back is the point.** Zod does not merely check — it transforms, and the
 * assignments below are what make those transformations reach the controller. ObjectId
 * fields are lowercased by `objectId()` in `src/schemas/common.ts`, numbers are coerced
 * from query strings, and unknown keys are stripped. Without the write-back the app would
 * validate a normalised copy and then act on the raw original: the exact failure mode
 * where a request passes validation and still carries the value that breaks an invariant.
 *
 * `headers` is validated but deliberately *not* written back. Express treats `req.headers`
 * as a live view of the incoming message and other middleware reads it; replacing it with
 * a parsed object is not worth the blast radius for the one header this app validates.
 * Anything that needs a normalised header value should normalise it at the point of use.
 *
 * A `ZodError` becomes a **400** carrying per-field `{field, message, rule}` issues, so a
 * client can point at the offending input instead of guessing. (An earlier version of this
 * comment said 422; `ApiError.validationError` has always constructed a 400, and
 * `tests/shifts.test.ts` asserts it. `config/swagger.ts` still documents 422 on two
 * operations and is wrong about them.) Anything else is passed through untouched for the
 * error handler to classify.
 */
import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { ApiError } from '../common/errors/apiError';

/**
 * Build the validation middleware for one route's schema.
 *
 * All four sections are always handed to the schema, but a section the schema does not
 * declare is neither checked nor written back: Zod strips keys it does not know about, so
 * `parsed.body` comes out undefined and `req.body` is left exactly as it arrived. That is
 * usually what you want — a schema declares only the sections its route has — but it means a
 * schema with a mistyped section name silently validates nothing rather than failing. If a
 * field reaches a controller un-normalised, that is the first thing to check.
 *
 * `parseAsync` rather than `parse` so a schema is free to use an async refinement. None does
 * today; the cost of allowing it is one `await` on a path that resolves immediately.
 *
 * A `ZodError` becomes a 400 with per-field issues. Anything else is forwarded untouched,
 * because a fault inside a refinement is not a client error and must not be reported as one.
 */
export function validate(schema: AnyZodObject) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
        headers: req.headers,
      });

      if (parsed.body !== undefined) req.body = parsed.body;
      if (parsed.query !== undefined) req.query = parsed.query;
      if (parsed.params !== undefined) req.params = parsed.params;

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.errors.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
          rule: err.code,
        }));
        next(ApiError.validationError('Request validation failed', issues));
      } else {
        next(error);
      }
    }
  };
}
