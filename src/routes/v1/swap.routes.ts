/**
 * Shift-swap routes — `/api/v1/swaps`.
 *
 * `POST /cycles/resolve` takes no body: it scans every PENDING proposal, builds the
 * directed wants-graph, and executes any elementary cycles it finds inside a
 * transaction. Running it twice is safe — the second pass finds nothing to rotate.
 */
import { Router } from 'express';
import { SwapController } from '../../controllers/swap.controller';
import { validate } from '../../middleware/validate';
import { requireVolunteerKind, requireRole } from '../../middleware/identity';
import { createSwapRequestSchema, acceptSwapSchema, listSwapsQuerySchema } from '../../schemas/swap.schema';

export const swapRouter = Router();

swapRouter.post('/', requireVolunteerKind, validate(createSwapRequestSchema), SwapController.createSwapRequest);
swapRouter.post('/:id/accept', requireVolunteerKind, validate(acceptSwapSchema), SwapController.acceptSwap);
// Scans the whole pending graph and executes rotations transactionally: a lead action, not
// something any volunteer may trigger in a loop.
swapRouter.post('/cycles/resolve', requireRole('SHIFT_LEAD'), SwapController.discoverCycles);
// requireVolunteerKind: swap proposals name volunteers and their shifts — staff data, not
// for hackers to enumerate. Anonymous is 401'd in required mode; open in legacy mode.
swapRouter.get('/', requireVolunteerKind, validate(listSwapsQuerySchema), SwapController.listSwaps);
