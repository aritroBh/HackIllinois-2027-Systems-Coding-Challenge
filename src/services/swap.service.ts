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

/**
 * A swap proposal.
 *
 * `targetVolunteerId` is what makes a proposal *directed*: name somebody and only they may
 * accept it, omit it and any eligible holder of `targetShiftId` may. Both shapes are
 * legitimate, and the acceptance guard is written to skip only when nobody was named.
 *
 * `desiredShiftIds` is the wants-list the cycle finder builds its graph from, and it
 * defaults to `[targetShiftId]`. That default is what makes an ordinary bilateral proposal
 * a node in the trade graph without the proposer doing anything special — which is how a
 * proposal nobody accepts head-on can still clear as one leg of a three-way rotation.
 */
export interface ICreateSwapDTO {
  proposerVolunteerId: string;
  proposerShiftId: string;
  targetVolunteerId?: string;
  targetShiftId: string;
  desiredShiftIds?: string[];
}

/**
 * Mark a swap FAILED **only while it is still pending**.
 *
 * The two failure paths in `acceptBilateralSwap` used to do `swap.status = FAILED` followed by
 * `swap.save()`, on a document read at the very top of the method, before any of the checks. A
 * Mongoose `save()` writes the whole document from that in-memory copy, so the write was
 * unconditional on what had happened to the row in between.
 *
 * That is losable. Two coordinators accept the same PENDING proposal: X wins, its transaction
 * rotates both registrations and CASes the swap to EXECUTED. Y, still holding the copy it read
 * as PENDING, now finds `regA` is no longer CONFIRMED — because X moved it — takes the
 * "no longer valid" branch, and saves FAILED over the EXECUTED row. The trade really happened;
 * the record says it did not. Nothing downstream reconciles the two, so the swap ledger and the
 * registrations disagree permanently, and the only trace of the real outcome is the
 * `SWAP_EXECUTED` frame X already broadcast.
 *
 * Conditioning the write on `status: PENDING` makes the loser's write match nothing, which is
 * correct: a swap that has moved on is not this caller's to describe. It matches the discipline
 * everywhere else in this file — the executing path is already a CAS.
 *
 * Returns whether it claimed the transition, so a caller can tell "I failed it" from "somebody
 * else had already finished it".
 */
async function failIfStillPending(swapId: Types.ObjectId, reason: string): Promise<boolean> {
  const result = await ShiftSwap.updateOne(
    { _id: swapId, status: SwapStatus.PENDING },
    { $set: { status: SwapStatus.FAILED, failureReason: reason } }
  );
  return result.matchedCount > 0;
}

export class SwapService {
  /**
   * Record a proposal. Nothing moves yet.
   *
   * The holdings are checked here — the proposer must actually hold a CONFIRMED
   * registration for the shift they are putting up, and a named target must hold one for
   * the shift being asked for — so an impossible proposal never reaches the graph. They are
   * checked again at execution time regardless, because either can lapse in between: this
   * row can sit PENDING for hours and a cancellation in that window is ordinary.
   *
   * The duplicate guard is keyed on proposer, offered shift and wanted shift rather than on
   * the whole DTO. Two proposals agreeing on those three are the same offer however their
   * `desiredShiftIds` differ, and both sitting PENDING would feed two entries for one offer
   * node into `buildAdjacencyList`, where the second's wants-list silently overwrites the
   * first's — half the proposer's stated wants disappearing from the graph with nothing to
   * show for it.
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
   * Execute a two-party trade.
   *
   * A swap moves the *registration*, not the volunteer. Both rows keep their `_id` and their
   * `confirmedAt`; only `volunteerId` is rewritten. That is why neither shift's
   * `filledSlots` moves — occupancy is unchanged, only who is sitting in the seats — and why
   * a swap needs no capacity claim at all and cannot oversell anything.
   *
   * Everything that can refuse the trade is settled before the transaction opens: both
   * registrations still CONFIRMED, each volunteer certified for the shift they are
   * *receiving* (the proposer for the target's, the target for the proposer's), and neither
   * colliding with it once the shift they are giving up is excluded from their schedule.
   *
   * Inside the transaction all three writes are match-guarded on what was read — the two
   * registrations on the volunteer who held them and their CONFIRMED status, the swap row on
   * its PENDING status — and that is what makes two people accepting the same open proposal
   * safe.
   * The loser's filter matches zero documents, so it throws `SWAP_CONFLICT` and the
   * transaction aborts — every leg rolls back rather than the second writer landing on top
   * of the first. The loser sees a 409; what it must never see is a success that quietly
   * undid somebody else's trade.
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
      const reason = 'One or more participating shifts or registrations are no longer valid.';
      // Conditional on the swap still being PENDING — see `failIfStillPending`. The most likely
      // cause of a registration no longer being CONFIRMED is that a competing accept moved it a
      // moment ago, which is exactly the case where this must not overwrite the outcome.
      if (!(await failIfStillPending(swap._id as Types.ObjectId, reason))) {
        throw ApiError.conflict('Swap was already settled by another coordinator.', ErrorCode.SWAP_CONFLICT);
      }
      throw ApiError.conflict(reason, ErrorCode.SWAP_INVALID);
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
      const reason = 'Swap transaction aborted due to a concurrent modification.';
      // Same guard as above, and for the same reason: an abort here is usually a competing
      // accept committing first, so the row may already say EXECUTED.
      await failIfStillPending(swap._id as Types.ObjectId, reason);
      throw ApiError.conflict(reason, ErrorCode.SWAP_CONFLICT);
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
   * The multi-party trade engine: find rings of proposals that clear each other, and rotate
   * them.
   *
   * A wants B's shift, B wants C's, C wants A's. No two of them can trade bilaterally but
   * all three can rotate at once, and finding those rings is elementary cycle discovery over
   * a directed graph of who wants what.
   *
   * The single most important fact about that graph is what its nodes are: **an offer,
   * `volunteerId::shiftId`, not a volunteer.** A volunteer holding two shifts with a pending
   * proposal against each has two separate things to trade, and collapsing them onto one
   * node was a real bug rather than a hypothetical one — the edge that formed the ring came
   * from one proposal while the shift that got rotated was resolved from the other, so
   * somebody could be moved out of a shift they had only ever offered against something
   * else. `cycleFinder.ts` carries the full account. Here, `volunteerOf` and `shiftOf` read
   * the two halves back off a node, which is what guarantees the person and the shift on the
   * table come from the same proposal.
   *
   * An edge u -> v means u wants the shift on offer at v, so the ring is rotated along its
   * edges: `cycle[i]` receives the shift `cycle[i + 1]` is giving up, and the last wraps to
   * the first.
   *
   * Rings are found against one snapshot and can overlap, so three rules keep a pass sane.
   * A ring whose members include anyone already rotated in this pass is skipped. Rings are
   * tried shortest-first, so a volunteer who appears in both a two-way and a three-way is
   * spent on the two-way. And a ring with a repeated volunteer is skipped outright, because
   * the per-leg validation excludes "the shift they surrender", singular, and somebody
   * appearing twice has two.
   *
   * Every leg is validated before any transaction opens — the receiver must hold the
   * incoming shift's certifications and must not collide with it. One bad leg fails the
   * *whole* ring: every proposal in it is marked FAILED and every member consumed for this
   * pass. That is blunt on purpose. The ring is the unit that clears, and a proposal that
   * might have worked in some other ring is better re-proposed by its owner than silently
   * retried into a different trade than the one they asked for.
   *
   * The rotation and the marking of its proposals are one transaction, and each leg is
   * match-guarded on the giver still holding that registration as CONFIRMED. So a bilateral
   * accept that commits mid-rotation makes one leg match nothing, the transaction aborts,
   * and every leg rolls back — there is no half-applied ring leaving one volunteer with two
   * shifts and another with none. That abort is caught, logged and skipped rather than
   * raised, and note what is *not* done on that path: the ring's members are never added to
   * `consumedVolunteers`, so a later ring in the same pass may still use them. The pass ends
   * with a smaller `executedCount`, not an error.
   *
   * The two halves of the return value are in different alphabets, which is easy to trip
   * over. `discoveredCycles` is what the finder produced — arrays of `volunteerId::shiftId`
   * node keys, including every ring that was then skipped or failed — while `executedCount`
   * counts only rings that actually rotated. The SSE frame carries plain volunteer ids.
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
        // There is deliberately no `if (shiftMap.size !== n) continue` here any more.
        //
        // There used to be, described as "incomplete mapping — skip rather than half-rotate",
        // and it could never fire. `shiftMap` is keyed by `volunteerOf(offer)` over the same
        // `offerCycle` the distinctness check five lines above has already run on: that check
        // is `new Set(cycle).size !== n` over `cycle = offerCycle.map(volunteerOf)`, which is
        // exactly the key set of this map. Once the n volunteers are known distinct, n
        // `Map.set` calls leave exactly n entries, always. Deleting the guard changes no
        // behaviour and reds no test, which is the definition of the problem: a reader met a
        // named failure mode ("half-rotate") that the code could not reach and took it as
        // evidence the case had been thought about here, when it had been thought about above.
        //
        // This is the fifth check found in this repository that reads a value which cannot take
        // its failing state. The class is worth naming once more: a guard is only a guard if you
        // can say what makes it fire. If the answer is "nothing, because an earlier line already
        // settled it", the earlier line is the guard and this one is a comment wearing an `if`.

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
          // Type narrowing, not a runtime guard — `Map.get` is `T | undefined` and `giverId` is
          // an element of `cycle`, which is precisely this map's key set. Kept because the
          // compiler needs it and because it is the right thing to do if the key set and the
          // map ever stop being built from the same array; it is not a case that can arise
          // today, and the message would be a lie about the data rather than about the code.
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
