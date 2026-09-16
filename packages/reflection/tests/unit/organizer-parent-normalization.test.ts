import { describe, expect, test } from "bun:test";
import { normalizeOrganizerCurrentParents } from "../../src";

describe("Organizer current-parent normalization", () => {
  test("resolves an unparented leaf to itself", () => {
    const result = normalizeOrganizerCurrentParents({
      seedRecordRefs: ["A"],
      currentParentEdges: [],
      maxTraversalWork: 8,
    });
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect(result.representatives.get("A")).toBe("A");
      expect(result.maximumDepth).toBe(0);
    }
  });

  test("walks a unique current chain to its highest representative", () => {
    const result = normalizeOrganizerCurrentParents({
      seedRecordRefs: ["A", "B"],
      currentParentEdges: [
        { childRecordRef: "B", parentRecordRef: "P" },
        { childRecordRef: "P", parentRecordRef: "Q" },
      ],
      maxTraversalWork: 8,
    });
    expect(result.status).toBe("complete");
    if (result.status === "complete") {
      expect([...result.representatives]).toEqual([["A", "A"], ["B", "Q"]]);
      expect(result.maximumDepth).toBe(2);
    }
  });

  test("fails closed on two current parents", () => {
    expect(normalizeOrganizerCurrentParents({
      seedRecordRefs: ["B"],
      currentParentEdges: [
        { childRecordRef: "B", parentRecordRef: "P1" },
        { childRecordRef: "B", parentRecordRef: "P2" },
      ],
      maxTraversalWork: 8,
    })).toEqual({
      status: "unavailable",
      reason: "multiple_current_parents",
      traversalWork: 0,
    });
  });

  test("fails closed on cycles and bounded overflow", () => {
    expect(normalizeOrganizerCurrentParents({
      seedRecordRefs: ["A"],
      currentParentEdges: [
        { childRecordRef: "A", parentRecordRef: "P" },
        { childRecordRef: "P", parentRecordRef: "A" },
      ],
      maxTraversalWork: 8,
    })).toMatchObject({ status: "unavailable", reason: "dependency_cycle" });
    expect(normalizeOrganizerCurrentParents({
      seedRecordRefs: ["A"],
      currentParentEdges: [
        { childRecordRef: "A", parentRecordRef: "P" },
        { childRecordRef: "P", parentRecordRef: "Q" },
      ],
      maxTraversalWork: 1,
    })).toEqual({
      status: "unavailable",
      reason: "budget_exceeded",
      traversalWork: 1,
    });
  });

  test("is permutation-invariant across generated single-parent forests", () => {
    let state = 0x288f0a;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    const shuffled = <Value>(values: readonly Value[]): Value[] => {
      const result = [...values];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const swap = next() % (index + 1);
        [result[index], result[swap]] = [result[swap]!, result[index]!];
      }
      return result;
    };

    for (let run = 0; run < 250; run += 1) {
      const seeds = Array.from({ length: 12 }, (_, index) => `leaf:${index}`);
      const edges = [
        ...seeds.map((seed, index) => ({
          childRecordRef: seed,
          parentRecordRef: `cluster:${Math.floor(index / 3)}`,
        })),
        ...Array.from({ length: 4 }, (_, index) => ({
          childRecordRef: `cluster:${index}`,
          parentRecordRef: `root:${Math.floor(index / 2)}`,
        })),
      ];
      const result = normalizeOrganizerCurrentParents({
        seedRecordRefs: shuffled(seeds),
        currentParentEdges: shuffled(edges),
        maxTraversalWork: 32,
      });
      expect(result.status).toBe("complete");
      if (result.status !== "complete") continue;
      for (const [index, seed] of seeds.entries()) {
        expect(result.representatives.get(seed)).toBe(
          `root:${Math.floor(Math.floor(index / 3) / 2)}`,
        );
      }
      expect(result.maximumDepth).toBe(2);
    }
  });

  test("rejects generated second-parent insertions regardless of edge order", () => {
    for (let run = 0; run < 250; run += 1) {
      const competing = run % 2 === 0
        ? [
            { childRecordRef: "leaf", parentRecordRef: "parent:a" },
            { childRecordRef: "leaf", parentRecordRef: "parent:b" },
          ]
        : [
            { childRecordRef: "leaf", parentRecordRef: "parent:b" },
            { childRecordRef: "leaf", parentRecordRef: "parent:a" },
          ];
      expect(normalizeOrganizerCurrentParents({
        seedRecordRefs: ["leaf"],
        currentParentEdges: competing,
        maxTraversalWork: 8,
      })).toMatchObject({ status: "unavailable", reason: "multiple_current_parents" });
    }
  });
});
