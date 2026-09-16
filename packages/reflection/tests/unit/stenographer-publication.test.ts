import { describe, expect, test } from "bun:test";

import {
  planStenographerObservationPublication,
  STENOGRAPHER_RECORD_POLICY_VERSION_V1,
} from "../../src/stenographer/publication";

const source = Object.freeze({
  logicalMessageRef: "message:41",
  observedRevision: "3",
  observedContentFingerprint: "sha256:message-41-r3",
  terminalAuthorityLeafHandle: "namespace:room-alpha",
});

describe("Stenographer observation publication", () => {
  test("maps a source-owned observation to one height-zero derived Record", () => {
    const plan = planStenographerObservationPublication({
      recordRef: "record:event-alpha",
      kind: "decision",
      statement: "The Room selected PostgreSQL.",
      roomAnchorRef: "room:alpha",
      terminalAuthorityLeafHandle: "namespace:room-alpha",
      sources: [source],
      observedContentFingerprint: "sha256:event-alpha",
      producerRef: "stenographer",
      producerPolicyVersion: STENOGRAPHER_RECORD_POLICY_VERSION_V1,
      processingGeneration: 2,
      transition: { operation: "append" },
    });

    expect(plan).toEqual({
      record: {
        recordRef: "record:event-alpha",
        lifecycle: "current",
        structuralHeight: 0,
        processingGeneration: 2,
        semantic: {
          posture: "derived",
          observedContentFingerprint: "sha256:event-alpha",
          sourceOwnedKind: "journal_event:decision",
          observedLogicalObjectRef: "record:event-alpha",
          observedRevision: "2",
          statement: "The Room selected PostgreSQL.",
          sourceDependencies: [{
            sourceKind: "message",
            logicalSourceRef: "message:41",
            observedRevision: "3",
            observedContentFingerprint: "sha256:message-41-r3",
            terminalAuthorityLeafHandle: "namespace:room-alpha",
            authorityBearing: true,
          }],
          anchors: [{ kind: "room", anchorRef: "room:alpha", role: "origin" }],
          childRecordRefs: [],
          producer: {
            producerRef: "stenographer",
            policyVersion: "stenographer-record-v1",
          },
          terminalAuthorityLeafHandles: ["namespace:room-alpha"],
        },
      },
    });
  });

  test("maps supersede and resolve to immutable successor relations", () => {
    const base = {
      recordRef: "record:event-beta",
      kind: "fact" as const,
      statement: "The deployment is complete.",
      roomAnchorRef: "room:alpha",
      terminalAuthorityLeafHandle: "namespace:room-alpha",
      sources: [source],
      observedContentFingerprint: "sha256:event-beta",
      producerRef: "stenographer",
      producerPolicyVersion: STENOGRAPHER_RECORD_POLICY_VERSION_V1,
      processingGeneration: 1,
    };
    expect(planStenographerObservationPublication({
      ...base,
      transition: { operation: "supersede", predecessorRecordRef: "record:event-alpha" },
    }).predecessor).toEqual({
      recordRef: "record:event-alpha",
      relation: "supersedes",
    });
    expect(planStenographerObservationPublication({
      ...base,
      transition: { operation: "resolve", predecessorRecordRef: "record:event-alpha" },
    }).predecessor).toEqual({
      recordRef: "record:event-alpha",
      relation: "resolves",
    });
  });

  test("rejects cross-Namespace sources, duplicates, and oversized statements", () => {
    expect(() => planStenographerObservationPublication({
      recordRef: "record:event-alpha",
      kind: "decision",
      statement: "x".repeat(501),
      roomAnchorRef: "room:alpha",
      terminalAuthorityLeafHandle: "namespace:room-alpha",
      sources: [source],
      observedContentFingerprint: "sha256:event-alpha",
      producerRef: "stenographer",
      producerPolicyVersion: STENOGRAPHER_RECORD_POLICY_VERSION_V1,
      processingGeneration: 1,
      transition: { operation: "append" },
    })).toThrow();

    expect(() => planStenographerObservationPublication({
      recordRef: "record:event-alpha",
      kind: "decision",
      statement: "A decision.",
      roomAnchorRef: "room:alpha",
      terminalAuthorityLeafHandle: "namespace:room-alpha",
      sources: [source, source],
      observedContentFingerprint: "sha256:event-alpha",
      producerRef: "stenographer",
      producerPolicyVersion: STENOGRAPHER_RECORD_POLICY_VERSION_V1,
      processingGeneration: 1,
      transition: { operation: "append" },
    })).toThrow();

    expect(() => planStenographerObservationPublication({
      recordRef: "record:event-alpha",
      kind: "decision",
      statement: "A decision.",
      roomAnchorRef: "room:alpha",
      terminalAuthorityLeafHandle: "namespace:room-alpha",
      sources: [{ ...source, terminalAuthorityLeafHandle: "namespace:other" }],
      observedContentFingerprint: "sha256:event-alpha",
      producerRef: "stenographer",
      producerPolicyVersion: STENOGRAPHER_RECORD_POLICY_VERSION_V1,
      processingGeneration: 1,
      transition: { operation: "append" },
    })).toThrow();
  });
});
