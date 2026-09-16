import { describe, expect, test } from "bun:test";
import {
  adaptJournalEventFixture,
  adaptMemoryFixture,
} from "../../src/adapters/fixture-snapshots";

describe("synthetic source fixture adapters", () => {
  test("keeps an authored Memory as a leaf and unions attachment audiences", () => {
    const projection = adaptMemoryFixture({
      recordRef: "memory-1",
      logicalMemoryRef: "logical-memory-1",
      observedRevision: "v7",
      contentFingerprint: "sha256:memory",
      statement: "Postgres is the supported transactional database.",
      memoryType: "decision",
      importance: 0.9,
      lifecycle: "current",
      anchors: ["postgres"],
      attachmentAudiences: [
        { kind: "access", humanRefs: ["casey", "alex"] },
        { kind: "access", humanRefs: ["casey", "ada"] },
      ],
      initialPublicationScope: { kind: "access", humanRefs: ["casey"] },
    });

    expect(projection.eligibleRecord).toEqual({
      snapshot: {
        recordRef: "memory-1",
        observedLogicalObjectRef: "logical-memory-1",
        observedRevision: "v7",
        observedContentFingerprint: "sha256:memory",
        posture: "authored",
        anchors: ["postgres"],
        statement: "Postgres is the supported transactional database.",
        sourceRefs: [],
        childRecordRefs: [],
        structuralHeight: 0,
        lifecycle: "current",
        sourceOwnedKind: "memory:decision",
      },
      audience: { kind: "access", humanRefs: ["ada", "alex", "casey"] },
      initialPublicationScope: { kind: "access", humanRefs: ["casey"] },
    });
    expect(projection.compatibility).toEqual({
      memoryType: "decision",
      importance: 0.9,
      attachmentCount: 2,
    });
  });

  test("projects an effective Journal event, not its raw citations or rollup", () => {
    const projection = adaptJournalEventFixture({
      recordRef: "journal-event-2",
      logicalEventRef: "event-2",
      observedRevision: "event-version-3",
      contentFingerprint: "sha256:event",
      statement: "Alex preferred Postgres because transactions remain local.",
      eventKind: "argument",
      lifecycle: "current",
      anchors: ["postgres", "database"],
      audience: { kind: "access", humanRefs: ["alex", "casey"] },
      initialPublicationScope: { kind: "access", humanRefs: ["alex", "casey"] },
    });

    expect(projection.snapshot).toMatchObject({
      observedLogicalObjectRef: "event-2",
      observedRevision: "event-version-3",
      posture: "derived",
      sourceOwnedKind: "journal_event:argument",
      sourceRefs: [],
      childRecordRefs: [],
      structuralHeight: 0,
    });
    expect(JSON.stringify(projection)).not.toContain("message");
    expect(JSON.stringify(projection)).not.toContain("rollup");
  });
});
