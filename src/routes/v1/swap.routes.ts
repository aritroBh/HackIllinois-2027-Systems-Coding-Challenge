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
import { requireVolunteerKind } from '../../middleware/identity';
import { createSwapRequestSchema, acceptSwapSchema } from '../../schemas/swap.schema';

export const swapRouter = Router();

swapRouter.post('/', requireVolunteerKind, validate(createSwapRequestSchema), SwapController.createSwapRequest);
swapRouter.post('/:id/accept', requireVolunteerKind, validate(acceptSwapSchema), SwapController.acceptSwap);
swapRouter.post('/cycles/resolve', requireVolunteerKind, SwapController.discoverCycles);
swapRouter.get('/', SwapController.listSwaps);
