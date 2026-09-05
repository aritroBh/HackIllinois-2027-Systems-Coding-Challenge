import { Router } from 'express';
import { SwapController } from '../../controllers/swap.controller';
import { validate } from '../../middleware/validate';
import { createSwapRequestSchema, acceptSwapSchema } from '../../schemas/swap.schema';

export const swapRouter = Router();

swapRouter.post('/', validate(createSwapRequestSchema), SwapController.createSwapRequest);
swapRouter.post('/:id/accept', validate(acceptSwapSchema), SwapController.acceptSwap);
swapRouter.post('/cycles/resolve', SwapController.discoverCycles);
swapRouter.get('/', SwapController.listSwaps);
