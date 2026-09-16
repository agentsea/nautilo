import { describe, expect, test } from "bun:test";

import { advanceTerminalAuthorityClosure } from "../../src/server/authority-closure";
import type { AuthorityClosureNode } from "../../src/server/authority-contracts";

function port(nodes: readonly AuthorityClosureNode[]) {
  const byRef = new Map(nodes.map((node) => [node.recordRef, node]));
  return {
    readNode: (recordRef: string) => Promise.resolve(
      byRef.has(recordRef)
        ? { status: "available" as const, node: byRef.get(recordRef)! }
        : { status: "unavailable" as const },
    ),
  };
}

describe("terminal authority closure", () => {
  test("resumes a deep multi-parent DAG and deduplicates opaque leaves", async () => {
    const nodes = [
      { recordRef: "root", childRecordRefs: ["left", "right"], directAuthorityLeafHandles: [], declaredTerminalAuthorityLeafHandles: ["a", "b"] },
      { recordRef: "left", childRecordRefs: ["shared"], directAuthorityLeafHandles: ["a"], declaredTerminalAuthorityLeafHandles: ["a", "b"] },
      { recordRef: "right", childRecordRefs: ["shared"], directAuthorityLeafHandles: [], declaredTerminalAuthorityLeafHandles: ["b"] },
      { recordRef: "shared", childRecordRefs: [], directAuthorityLeafHandles: ["b"], declaredTerminalAuthorityLeafHandles: ["b"] },
    ] as const;
    let continuation: string | undefined;
    let pauses = 0;
    for (;;) {
      const result = await advanceTerminalAuthorityClosure({
        rootRecordRef: "root",
        nodes: port(nodes),
        maxVisitedRecords: 1,
        ...(continuation === undefined ? {} : { continuation }),
      });
      if (result.status === "paused") {
        pauses += 1;
        continuation = result.continuation;
        continue;
      }
      expect(result).toEqual({
        status: "complete",
        terminalAuthorityLeafHandles: ["a", "b"],
        visitedRecords: 4,
      });
      break;
    }
    expect(pauses).toBeGreaterThan(0);
  });

  test("rejects a declared cache omission and a dependency cycle", async () => {
    expect(await advanceTerminalAuthorityClosure({
      rootRecordRef: "root",
      nodes: port([
        { recordRef: "root", childRecordRefs: ["leaf"], directAuthorityLeafHandles: [], declaredTerminalAuthorityLeafHandles: [] },
        { recordRef: "leaf", childRecordRefs: [], directAuthorityLeafHandles: ["a"], declaredTerminalAuthorityLeafHandles: ["a"] },
      ]),
      maxVisitedRecords: 10,
    })).toEqual({ status: "unavailable", reason: "declared_closure_mismatch" });
    expect(await advanceTerminalAuthorityClosure({
      rootRecordRef: "a",
      nodes: port([
        { recordRef: "a", childRecordRefs: ["b"], directAuthorityLeafHandles: [], declaredTerminalAuthorityLeafHandles: ["x"] },
        { recordRef: "b", childRecordRefs: ["a"], directAuthorityLeafHandles: ["x"], declaredTerminalAuthorityLeafHandles: ["x"] },
      ]),
      maxVisitedRecords: 10,
    })).toEqual({ status: "unavailable", reason: "dependency_cycle" });
  });
});
