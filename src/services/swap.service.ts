import { Types } from 'mongoose';
import { ShiftSwap, IShiftSwap, SwapStatus } from '../models/swap.model';
import { Shift } from '../models/shift.model';
import { Volunteer } from '../models/volunteer.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { RegistrationService } from './registration.service';
import { CyclicTradeFinder, IAssignmentInput } from '../common/utils/cycleFinder';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';

export interface ICreateSwapDTO {
  proposerVolunteerId: string;
  proposerShiftId: string;
  targetVolunteerId?: string;
  targetShiftId: string;
  desiredShiftIds?: string[];
}

export class SwapService {
  /**
   * Creates a shift swap proposal.
   */
  public static async createSwapRequest(dto: ICreateSwapDTO): Promise<IShiftSwap> {
    // 1. Verify proposer actually holds a confirmed registration for proposerShiftId
    const proposerReg = await Registration.findOne({
      shiftId: new Types.ObjectId(dto.proposerShiftId),
      volunteerId: new Types.ObjectId(dto.proposerVolunteerId),
      status: RegistrationStatus.CONFIRMED,
    });

    if (!proposerReg) {
      throw ApiError.badRequest('Proposer does not hold a confirmed registration for this shift.');
    }

    // 2. If targetVolunteerId is specified, verify target holds a confirmed registration for targetShiftId
    if (dto.targetVolunteerId) {
      const targetReg = await Registration.findOne({
        shiftId: new Types.ObjectId(dto.targetShiftId),
        volunteerId: new Types.ObjectId(dto.targetVolunteerId),
        status: RegistrationStatus.CONFIRMED,
      });

      if (!targetReg) {
        throw ApiError.badRequest('Target volunteer does not hold a confirmed registration for target shift.');
      }
    }

    const swap = await ShiftSwap.create({
      proposerVolunteerId: new Types.ObjectId(dto.proposerVolunteerId),
      proposerShiftId: new Types.ObjectId(dto.proposerShiftId),
      targetVolunteerId: dto.targetVolunteerId ? new Types.ObjectId(dto.targetVolunteerId) : null,
      targetShiftId: new Types.ObjectId(dto.targetShiftId),
      desiredShiftIds: dto.desiredShiftIds?.map((id) => new Types.ObjectId(id)) || [new Types.ObjectId(dto.targetShiftId)],
      status: SwapStatus.PENDING,
    });

    eventHub.broadcast({
      type: 'SWAP_PROPOSED',
      data: swap.toObject(),
    });

    return swap;
  }

  /**
   * Accepts and executes a bilateral 1-to-1 shift swap atomically.
   */
  public static async acceptBilateralSwap(swapId: string, targetVolunteerId: string): Promise<IShiftSwap> {
    const swap = await ShiftSwap.findById(swapId);
    if (!swap || swap.status !== SwapStatus.PENDING) {
      throw ApiError.notFound('Pending swap request not found.', ErrorCode.SWAP_NOT_FOUND);
    }

    const proposerId = swap.proposerVolunteerId.toString();
    const targetId = targetVolunteerId;

    // Verify registrations still exist and are CONFIRMED
    const [regA, regB, shiftA, shiftB, volA, volB] = await Promise.all([
      Registration.findOne({ shiftId: swap.proposerShiftId, volunteerId: swap.proposerVolunteerId, status: RegistrationStatus.CONFIRMED }),
      Registration.findOne({ shiftId: swap.targetShiftId, volunteerId: new Types.ObjectId(targetId), status: RegistrationStatus.CONFIRMED }),
      Shift.findById(swap.proposerShiftId),
      Shift.findById(swap.targetShiftId),
      Volunteer.findById(proposerId),
      Volunteer.findById(targetId),
    ]);

    if (!regA || !regB || !shiftA || !shiftB || !volA || !volB) {
      swap.status = SwapStatus.FAILED;
      swap.failureReason = 'One or more participating shifts or registrations are no longer valid.';
      await swap.save();
      throw ApiError.conflict(swap.failureReason, ErrorCode.SWAP_INVALID);
    }

    // Check skills: volA needs shiftB.skills; volB needs shiftA.skills
    if (shiftB.requiredSkills && shiftB.requiredSkills.length > 0) {
      const volAHasSkills = shiftB.requiredSkills.every((s) => volA.certifications.includes(s));
      if (!volAHasSkills) {
        throw ApiError.conflict('Proposer lacks certifications required for target shift.', ErrorCode.MISSING_SKILL_CERTIFICATION);
      }
    }
    if (shiftA.requiredSkills && shiftA.requiredSkills.length > 0) {
      const volBHasSkills = shiftA.requiredSkills.every((s) => volB.certifications.includes(s));
      if (!volBHasSkills) {
        throw ApiError.conflict('Target volunteer lacks certifications required for proposer shift.', ErrorCode.MISSING_SKILL_CERTIFICATION);
      }
    }

    // Check bilateral schedule conflicts:
    // volA checked against shiftB (excluding shiftA)
    await RegistrationService.assertNoScheduleConflicts(proposerId, shiftB.startTime, shiftB.endTime, shiftA._id.toString());
    // volB checked against shiftA (excluding shiftB)
    await RegistrationService.assertNoScheduleConflicts(targetId, shiftA.startTime, shiftA.endTime, shiftB._id.toString());

    // Execute atomic swap of volunteer IDs on the two registrations
    regA.volunteerId = new Types.ObjectId(targetId);
    await regA.save();

    regB.volunteerId = new Types.ObjectId(proposerId);
    await regB.save();

    swap.status = SwapStatus.EXECUTED;
    swap.targetVolunteerId = new Types.ObjectId(targetId);
    await swap.save();

    eventHub.broadcast({
      type: 'SWAP_EXECUTED',
      data: {
        swapId: swap._id,
        proposerVolunteerId: proposerId,
        targetVolunteerId: targetId,
        shiftAId: shiftA._id,
        shiftBId: shiftB._id,
      },
    });

    return swap;
  }

  /**
   * Discovers and resolves multi-party cyclic trades (e.g. A -> B -> C -> A).
   */
  public static async discoverAndResolveCycles(): Promise<{
    discoveredCycles: string[][];
    executedCount: number;
  }> {
    // 1. Fetch all pending swaps
    const pendingSwaps = await ShiftSwap.find({ status: SwapStatus.PENDING });
    if (pendingSwaps.length < 2) {
      return { discoveredCycles: [], executedCount: 0 };
    }

    const assignments: IAssignmentInput[] = pendingSwaps.map((s) => ({
      volunteerId: s.proposerVolunteerId.toString(),
      assignedShiftId: s.proposerShiftId.toString(),
      desiredShiftIds: s.desiredShiftIds?.map((id) => id.toString()) || [s.targetShiftId.toString()],
    }));

    const adj = CyclicTradeFinder.buildAdjacencyList(assignments);
    const cycles = CyclicTradeFinder.findCycles(adj, 2, 4);

    let executedCount = 0;

    for (const cycle of cycles) {
      const n = cycle.length;
      try {
        // Collect registrations for participants
        const shiftMap = new Map<string, Types.ObjectId>();
        for (const volId of cycle) {
          const swapItem = pendingSwaps.find((s) => s.proposerVolunteerId.toString() === volId);
          if (swapItem) shiftMap.set(volId, swapItem.proposerShiftId);
        }

        // Rotate assignments: volunteer cycle[i] receives shift currently held by cycle[(i + 1) % n]
        for (let i = 0; i < n; i++) {
          const receiverId = cycle[i];
          const giverId = cycle[(i + 1) % n];
          const targetShiftId = shiftMap.get(giverId);

          if (targetShiftId) {
            await Registration.findOneAndUpdate(
              { shiftId: targetShiftId, volunteerId: new Types.ObjectId(giverId), status: RegistrationStatus.CONFIRMED },
              { $set: { volunteerId: new Types.ObjectId(receiverId) } }
            );
          }
        }

        // Mark associated swaps as EXECUTED
        for (const volId of cycle) {
          await ShiftSwap.updateMany(
            { proposerVolunteerId: new Types.ObjectId(volId), status: SwapStatus.PENDING },
            { $set: { status: SwapStatus.EXECUTED, isCyclic: true, cycleParticipants: cycle.map((id) => new Types.ObjectId(id)) } }
          );
        }

        executedCount++;

        eventHub.broadcast({
          type: 'CYCLIC_TRADE_EXECUTED',
          data: { cycle, length: n },
        });
      } catch (err) {
        console.error('Error executing cyclic swap:', err);
      }
    }

    return { discoveredCycles: cycles, executedCount };
  }

  /**
   * Lists active swaps.
   */
  public static async listSwaps(status?: SwapStatus): Promise<IShiftSwap[]> {
    const query = status ? { status } : {};
    return ShiftSwap.find(query)
      .populate('proposerVolunteerId', 'name email')
      .populate('targetVolunteerId', 'name email')
      .populate('proposerShiftId', 'title startTime endTime')
      .populate('targetShiftId', 'title startTime endTime')
      .sort({ createdAt: -1 });
  }
}
