/**
 * Directed Graph Cycle Finder for Multi-Party Shift Swaps.
 * Implements bounded elementary cycle discovery with canonical rotation hashing
 * to discover 2-way, 3-way, and 4-way shift trade rings (Alice -> Bob -> Charlie -> Alice).
 */

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
    const shiftToOwner = new Map<string, string>();
    for (const a of assignments) {
      shiftToOwner.set(a.assignedShiftId, a.volunteerId);
    }

    const adj = new Map<string, string[]>();
    for (const a of assignments) {
      const neighbors: string[] = [];
      for (const desiredShift of a.desiredShiftIds) {
        const targetVolunteer = shiftToOwner.get(desiredShift);
        if (targetVolunteer && targetVolunteer !== a.volunteerId) {
          neighbors.push(targetVolunteer);
        }
      }
      adj.set(a.volunteerId, neighbors);
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

      const neighbors = adj.get(currNode) || [];
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
