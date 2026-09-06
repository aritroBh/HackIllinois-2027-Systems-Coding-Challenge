/**
 * Volunteer routes — `/api/v1/volunteers`.
 *
 * Reads are open in `legacy` mode so the demo dashboard works without credentials and
 * session-gated in `required` mode; every response is projected by role in the controller
 * (contact details lead+ only, identities/sessionVersion never). Creation is organiser-only.
 * The list is still unpaginated (plan M5).
 */
import { Router } from 'express';
import { VolunteerController } from '../../controllers/volunteer.controller';
import { validate } from '../../middleware/validate';
import { requireRole } from '../../middleware/identity';
import { createVolunteerSchema, getVolunteerParamsSchema } from '../../schemas/volunteer.schema';

export const volunteerRouter = Router();

// Creating accounts is organiser work (legacy anonymous callers pass): otherwise anyone could
// mint accounts to multiply their per-account rate budget.
volunteerRouter.post('/', requireRole('ORGANIZER'), validate(createVolunteerSchema), VolunteerController.createVolunteer);
volunteerRouter.get('/', VolunteerController.listVolunteers);
volunteerRouter.get('/:id', validate(getVolunteerParamsSchema), VolunteerController.getVolunteerById);
