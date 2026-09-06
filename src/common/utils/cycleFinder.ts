/**
 * Directed Graph Cycle Finder for Multi-Party Shift Swaps.
 * Implements bounded elementary cycle discovery with canonical rotation hashing
 * to discover 2-way, 3-way, and 4-way shift trade rings (Alice -> Bob -> Charlie -> Alice).
 */

/**
 * A node in the trade graph is one **offer** — a volunteer together with the shift they are
 * putting up — not a volunteer.
 *
 * A volunteer may hold several shifts and have a pending proposal against each. Those are
 * separate things to trade and they have different counterparties, so collapsing them onto
 * one node loses exactly the information the executor needs: which shift of theirs is
 * actually on the table for this ring.
 *
 * The separator is one a Mongo ObjectId hex string cannot contain, so the encoding is
 * unambiguous and `volunteerOf` is a plain prefix read.
 */
const OFFER_SEP = '::';

export function offerId(volunteerId: string, assignedShiftId: string): string {
  return `${volunteerId}${OFFER_SEP}${assignedShiftId}`;
}

export function volunteerOf(offer: string): string {
  return offer.slice(0, offer.indexOf(OFFER_SEP));
}

export function shiftOf(offer: string): string {
  return offer.slice(offer.indexOf(OFFER_SEP) + OFFER_SEP.length);
}

export interface IAssignmentInput {
  volunteerId: string;
  assignedShiftId: string;
  desiredShiftIds: string[];
}

export class CyclicTradeFinder {
  /**
   * Constructs an adjacency list from shift assignments and trade desires.
   * An edge u -> v exists if Volunteer u desires the shift currently assigned to Volunteer v.
   */
  public static buildAdjacencyList(assignments: IAssignmentInput[]): Map<string, string[]> {
    const shiftToOffer = new Map<string, string>();
    for (const a of assignments) {
      shiftToOffer.set(a.assignedShiftId, offerId(a.volunteerId, a.assignedShiftId));
    }

    const adj = new Map<string, string[]>();
    for (const a of assignments) {
      const from = offerId(a.volunteerId, a.assignedShiftId);
      // Deduplicated: repeated desired shifts previously produced duplicate
      // edges, which multiplied the discovered "cycles" and double-executed trades.
      const neighbors = new Set<string>();
      for (const desiredShift of a.desiredShiftIds) {
        const target = shiftToOffer.get(desiredShift);
        // No edge to another of your own shifts: trading with yourself is not a trade, and
        // it would put one volunteer in a ring twice.
        if (target && volunteerOf(target) !== a.volunteerId) {
          neighbors.add(target);
        }
      }
      // `set` on a node that already exists is impossible now, because the key includes the
      // shift. Keyed by volunteer alone, a person with two pending proposals had the first
      // one's edges silently overwritten by the second's — and the executor then resolved
      // their shift from the *first* proposal, so the edge that formed the cycle and the
      // shift that got rotated came from different offers. Somebody could be moved onto a
      // shift in exchange for one they had only offered against something else entirely.
      adj.set(from, [...neighbors]);
    }
    return adj;
  }

  /**
   * Discovers all elementary directed cycles with length in [minLen, maxLen].
   * Uses canonical ordering (cycle starts at lexicographically smallest ID)
   * to eliminate duplicate cyclic permutations (e.g. A->B->C vs B->C->A).
   */
  public static findCycles(
    adj: Map<string, string[]>,
    minLen = 2,
    maxLen = 4
  ): string[][] {
    const cycles: string[][] = [];
    const stack: string[] = [];
    const inStack = new Set<string>();

    const nodes = Array.from(adj.keys()).sort();

    const dfs = (startNode: string, currNode: string, depth: number) => {
      if (depth > maxLen) return;

      stack.push(currNode);
      inStack.add(currNode);

      // Deduplicated: callers passing hand-built adjacency with repeated
      // edges must not multiply discovered cycles either.
      const neighbors = [...new Set(adj.get(currNode) || [])];
      for (const next of neighbors) {
        // Enforce canonical minimum: only traverse nodes >= startNode
        if (next < startNode) continue;

        if (next === startNode) {
          if (stack.length >= minLen && stack.length <= maxLen) {
            cycles.push([...stack]);
          }
        } else if (!inStack.has(next)) {
          dfs(startNode, next, depth + 1);
        }
      }

      stack.pop();
      inStack.delete(currNode);
    };

    for (const node of nodes) {
      dfs(node, node, 1);
    }

    // Sort priority: smallest trade cycles first (2-way > 3-way > 4-way)
    return cycles.sort((a, b) => a.length - b.length);
  }
}
