import { describe, expect, test } from "bun:test";
import type { RankedRecordCoordinate } from "@nautilo/reflection/search";

import { selectSameRoomOrganizerCoordinates } from "../../src/server";

function record(
  recordRef: string,
  score: number,
): RankedRecordCoordinate {
  return {
    recordRef,
    score: Math.fround(score),
    structuralHeight: 0,
    recordProcessingGeneration: 1,
    projectionGeneration: 1,
    payloadRepresentationGeneration: 1,
    authorityProjectionGeneration: 1,
  };
}

describe("same-Room Organizer metadata selection", () => {
  test("applies one shared top-four score and identity tie-break policy", () => {
    const selected = selectSameRoomOrganizerCoordinates({
      records: [record("record-a", 0.9), record("record-low", 0.5)],
      authorityParentRecords: [record("parent-a", 0.9)],
      memories: [
        {
          sourceKind: "memory",
          logicalSourceRef: "memory:z",
          score: Math.fround(0.8),
        },
        {
          sourceKind: "memory",
          logicalSourceRef: "memory:a",
          score: Math.fround(0.9),
        },
      ],
    });

    expect(selected.map((entry) => entry.selectionRef)).toEqual([
      "authority-parent:parent-a",
      "record:record-a",
      "source:memory:memory:a",
      "source:memory:memory:z",
    ]);
    expect(selected.map((entry) => entry.kind)).toEqual([
      "authority_parent",
      "record",
      "source",
      "source",
    ]);
  });

  test("retains the canonical duplicate-identity rejection", () => {
    expect(() => selectSameRoomOrganizerCoordinates({
      records: [record("same", 0.9), record("same", 0.8)],
      authorityParentRecords: [],
      memories: [],
    })).toThrow("semantic candidate references must be unique");
  });
});
