/**
 * Shift swaps — bilateral trades and multi-party rotations.
 *
 * Bilateral is the easy half: two volunteers exchange shifts inside one transaction, so
 * the pair either both move or neither does.
 *
 * Acceptance is scoped by whether the proposal names a target. A *directed* swap may be
 * accepted only by the volunteer it names, which closes an IDOR where anyone could take a
 * swap offered to someone else. An *open* proposal deliberately names nobody and is
 * claimable by any eligible holder of the wanted shift — that is the feature, not a hole
 * in the check, and the guard is written to skip only when no target was named.
 *
 * The interesting half is the cyclic case. A wants B's shift, B wants C's, C wants A's —
 * no two of them can trade bilaterally, but all three can rotate. Finding those is
 * elementary cycle discovery over a directed graph of who wants what, bounded to cycles
 * of length 2 to 4. The bound is a product decision as much as a performance one: a
 * six-way rotation is hard for organisers to reason about and much likelier to have a leg
 * fail validation.
 *
 * Three things make a rotation safe to execute:
 *
 *  - **Every leg is validated before the transaction opens.** The receiver must hold the
 *    incoming shift's certifications and must not collide with it, excluding the shift
 *    they are giving up. The bilateral path always enforced both; the cyclic path once
 *    enforced neither, so a rotation could hand a volunteer a shift they were not
 *    certified for or were already double-booked against.
 *  - **All or nothing.** The whole rotation runs in one transaction. A half-applied
 *    three-way trade leaves a volunteer holding two shifts and another holding none.
 *  - **No volunteer is consumed twice.** Cycles are found against one snapshot and can
 *    overlap; a volunteer already committed to an executed rotation is skipped rather
 *    than rotated twice.
 *
 * Self-dealing guards compare through `sameId`, because a raw `===` fails *open* here:
 * the same volunteer spelled two ways would slip past "you cannot swap with yourself".
 */
import mongoose, { Types } from 'mongoose';
import { ShiftSwap, IShiftSwap, SwapStatus } from '../models/swap.model';
import { Shift } from '../models/shift.model';
import { Volunteer } from '../models/volunteer.model';
import { Registration, RegistrationStatus } from '../models/registration.model';
import { RegistrationService } from './registration.service';
import { CyclicTradeFinder, IAssignmentInput, volunteerOf, shiftOf } from '../common/utils/cycleFinder';
import { ApiError } from '../common/errors/apiError';
import { ErrorCode } from '../common/errors/errorCodes';
import { eventHub } from '../common/sse/eventHub';
import { sameId } from '../common/utils/id';

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
    // ponytail: contract guards — self-swaps, same-shift swaps, and duplicate PENDING spam rejected up front.
    if (dto.targetVolunteerId && sameId(dto.targetVolunteerId, dto.proposerVolunteerId)) {
      throw ApiError.badRequest('A volunteer cannot propose a swap with themselves.');
    }
    if (sameId(dto.proposerShiftId, dto.targetShiftId)) {
      throw ApiError.badRequest('Proposer and target shifts must be different.');
    }
    const duplicatePending = await ShiftSwap.findOne({
      proposerVolunteerId: new Types.ObjectId(dto.proposerVolunteerId),
      proposerShiftId: new Types.ObjectId(dto.proposerShiftId),
      targetShiftId: new Types.ObjectId(dto.targetShiftId),
      status: SwapStatus.PENDING,
    });
    if (duplicatePending) {
      throw ApiError.conflict('An identical swap request is already pending.', ErrorCode.SWAP_INVALID);
    }
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

    // ponytail: IDOR fix — only the addressed target volunteer may accept.
    if (swap.targetVolunteerId && !sameId(swap.targetVolunteerId, targetId)) {
      throw ApiError.forbidden('Only the targeted volunteer may accept this swap.');
    }
    if (sameId(proposerId, targetId)) {
      throw ApiError.badRequest('A volunteer cannot swap with themselves.');
    }

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

    // Execute the volunteer-ID rotation inside a multi-document transaction so a
    // crash between the two writes can never leave a half-swap behind.
    // ponytail: single transaction replaces two sequential saves (half-swap corruption fix).
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Every leg is match-guarded: a concurrent accepter (open proposals
        // name no fixed target) that commits first makes the loser's filters
        // match zero documents, aborting the whole rotation instead of
        // last-writer-winning over it.
        const regAUpdated = await Registration.findOneAndUpdate(
          { _id: regA._id, volunteerId: swap.proposerVolunteerId, status: RegistrationStatus.CONFIRMED },
          { $set: { volunteerId: new Types.ObjectId(targetId) } },
          { session, new: true }
        );
        if (!regAUpdated) {
          throw ApiError.conflict('Proposer registration changed during swap execution.', ErrorCode.SWAP_CONFLICT);
        }
        const regBUpdated = await Registration.findOneAndUpdate(
          { _id: regB._id, volunteerId: new Types.ObjectId(targetId), status: RegistrationStatus.CONFIRMED },
          { $set: { volunteerId: new Types.ObjectId(proposerId) } },
          { session, new: true }
        );
        if (!regBUpdated) {
          throw ApiError.conflict('Target registration changed during swap execution.', ErrorCode.SWAP_CONFLICT);
        }
        const swapClaimed = await ShiftSwap.updateOne(
          { _id: swap._id, status: SwapStatus.PENDING },
          { $set: { status: SwapStatus.EXECUTED, targetVolunteerId: new Types.ObjectId(targetId) } },
          { session }
        );
        if (swapClaimed.matchedCount === 0) {
          throw ApiError.conflict('Swap was already accepted by another coordinator.', ErrorCode.SWAP_CONFLICT);
        }
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      swap.status = SwapStatus.FAILED;
      swap.failureReason = 'Swap transaction aborted due to a concurrent modification.';
      await swap.save();
      throw ApiError.conflict(swap.failureReason, ErrorCode.SWAP_CONFLICT);
    } finally {
      await session.endSession();
    }

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
    const consumedVolunteers = new Set<string>();

    for (const offerCycle of cycles) {
      const n = offerCycle.length;
      // Each node carries both halves of the offer, so the volunteer and the shift on the
      // table come from the same proposal by construction. They used to be resolved
      // separately — the edge from the graph, the shift from `pendingSwaps.find(...)`, which
      // returns the *first* proposal a volunteer made — so a volunteer with two pending
      // proposals could be rotated out of a shift they had offered against something else.
      const cycle = offerCycle.map(volunteerOf);

      // ponytail: overlapping cycles from one snapshot must not double-execute the same
      // rotation, and a person may not appear in two rings from one snapshot.
      if (cycle.some((v) => consumedVolunteers.has(v))) continue;
      // Nor twice within one ring: the leg validation excludes "the shift they surrender",
      // singular, and a volunteer appearing twice has two.
      if (new Set(cycle).size !== n) continue;

      try {
        const shiftMap = new Map<string, Types.ObjectId>();
        for (const offer of offerCycle) {
          shiftMap.set(volunteerOf(offer), new Types.ObjectId(shiftOf(offer)));
        }
        if (shiftMap.size !== n) continue; // incomplete mapping — skip rather than half-rotate

        // Validate every leg BEFORE touching the transaction: the receiver
        // must carry the incoming shift's certifications and must not collide
        // with it (excluding the shift they surrender). The bilateral path
        // enforces both; the cyclic path previously enforced neither, so a
        // rotation could hand an uncertified or double-booked volunteer a shift.
        let legInvalidReason: string | null = null;
        for (let i = 0; i < n && !legInvalidReason; i++) {
          const receiverId = cycle[i];
          const giverId = cycle[(i + 1) % n];
          const targetShiftId = shiftMap.get(giverId);
          if (!targetShiftId) {
            legInvalidReason = `missing shift mapping for cycle leg ${giverId}`;
            break;
          }
          const [incomingShift, receiverVol] = await Promise.all([
            Shift.findById(targetShiftId),
            Volunteer.findById(receiverId),
          ]);
          if (!incomingShift || !receiverVol) {
            legInvalidReason = 'incoming shift or receiving volunteer no longer exists';
            break;
          }
          if (
            incomingShift.requiredSkills &&
            incomingShift.requiredSkills.length > 0 &&
            !incomingShift.requiredSkills.every((s) => receiverVol.certifications.includes(s))
          ) {
            legInvalidReason = `receiver lacks certifications required for shift "${incomingShift.title}"`;
            break;
          }
          try {
            await RegistrationService.assertNoScheduleConflicts(
              receiverId,
              incomingShift.startTime,
              incomingShift.endTime,
              shiftMap.get(receiverId)?.toString()
            );
          } catch (err) {
            legInvalidReason = err instanceof Error ? err.message : 'schedule conflict on incoming shift';
            break;
          }
        }
        if (legInvalidReason) {
          for (const volId of cycle) consumedVolunteers.add(volId);
          await ShiftSwap.updateMany(
            {
              $or: cycle.map((volId) => ({
                proposerVolunteerId: new Types.ObjectId(volId),
                proposerShiftId: shiftMap.get(volId),
              })),
              status: SwapStatus.PENDING,
            },
            { $set: { status: SwapStatus.FAILED, failureReason: `Cyclic trade invalid: ${legInvalidReason}` } }
          );
          continue;
        }

        // ponytail: whole rotation + swap-marking in one transaction — abort rolls back every leg.
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => {
            // Rotate assignments: volunteer cycle[i] receives shift currently held by cycle[(i + 1) % n]
            for (let i = 0; i < n; i++) {
              const receiverId = cycle[i];
              const giverId = cycle[(i + 1) % n];
              const targetShiftId = shiftMap.get(giverId);

              if (!targetShiftId) {
                throw new Error(`Missing shift mapping for cycle leg ${giverId}`);
              }
              // ponytail: null results are checked — a missing leg aborts the cycle instead of partial-rotating.
              const moved = await Registration.findOneAndUpdate(
                { shiftId: targetShiftId, volunteerId: new Types.ObjectId(giverId), status: RegistrationStatus.CONFIRMED },
                { $set: { volunteerId: new Types.ObjectId(receiverId) } },
                { session }
              );
              if (!moved) {
                throw new Error(`Registration leg missing for ${giverId} on shift ${targetShiftId}`);
              }
            }

            // Mark only the swaps that formed this cycle as EXECUTED (scoped by proposer shift).
            for (const volId of cycle) {
              await ShiftSwap.updateOne(
                {
                  proposerVolunteerId: new Types.ObjectId(volId),
                  proposerShiftId: shiftMap.get(volId),
                  status: SwapStatus.PENDING,
                },
                { $set: { status: SwapStatus.EXECUTED, isCyclic: true, cycleParticipants: cycle.map((id) => new Types.ObjectId(id)) } },
                { session }
              );
            }
          });
        } finally {
          await session.endSession();
        }

        for (const volId of cycle) consumedVolunteers.add(volId);

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
      // Names only — email is PII and this list is readable by any volunteer-kind caller.
      .populate('proposerVolunteerId', 'name')
      .populate('targetVolunteerId', 'name')
      .populate('proposerShiftId', 'title startTime endTime')
      .populate('targetShiftId', 'title startTime endTime')
      .sort({ createdAt: -1 });
  }
}
