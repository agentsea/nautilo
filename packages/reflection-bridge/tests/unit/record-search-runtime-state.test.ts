import { describe, expect, test } from "bun:test";

import {
  BoundedRecordEvidenceTraversalCheckpoints,
  BoundedRecordSearchTraversalCheckpoints,
} from "../../src/server";

describe("bounded Record continuation state", () => {
  test("evicts oldest search state and removes evidence state", async () => {
    const search = new BoundedRecordSearchTraversalCheckpoints({ maximumEntries: 1 });
    const state = {
      redundancy: {
        policyVersion: 1,
        rankCommitment: "aaaaaaaaaaaaaaaa",
        resumeKind: "next_rank_page",
        rankPageCommitment: "bbbbbbbbbbbbbbbb",
        nextCandidateIndex: 0,
        retained: [],
        comparisonIndex: 0,
        direction: "retained_to_candidate",
        redundancySuppressedCount: 0,
        cumulativeVisitedCoordinates: 0,
      },
      alreadyEmittedRecordRefs: [],
    } as const;
    await search.save("one", state);
    await search.save("two", state);
    expect(await search.load("one")).toBeNull();
    expect(await search.load("two")).toEqual(state);

    const evidence = new BoundedRecordEvidenceTraversalCheckpoints();
    const ref = await evidence.save({
      rootRecordRef: "record:one",
      rootAuthorityGeneration: 1,
      rootProcessingGeneration: 1,
      rootRepresentationGeneration: 1,
      currentPageIndex: 0,
      absoluteChildPosition: 0,
      childrenComplete: false,
      sourceOffset: 0,
    });
    expect(await evidence.load(ref)).not.toBeNull();
    await evidence.remove(ref);
    expect(await evidence.load(ref)).toBeNull();
  });
});
