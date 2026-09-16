import { describe, expect, test } from "bun:test";

import {
  deriveHumanArtifactExactAccessChange,
  fingerprintHumanArtifactExactAccessTarget,
  targetAfterHumanArtifactAuthorizedViewDeletion,
} from "../../src/server/artifact/human-artifact-exact-access.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const authority = {
  userId: "user-1",
  subjectHumanId: "human-1",
  actorId: "actor-1",
  agentId: null,
  readableNamespaceIds: [A, B],
  mutableNamespaceIds: [A, B],
  writableNamespaceIds: [A, B],
} as const;

describe("Human Artifact exact access", () => {
  test("preserves inaccessible audiences and authorizes only the changed delta", () => {
    expect(deriveHumanArtifactExactAccessChange({
      authority,
      currentNamespaceIds: [A, C],
      proposedTargetNamespaceIds: [B, C],
    })).toEqual({
      status: "changed",
      currentNamespaceIds: [A, C],
      targetNamespaceIds: [B, C],
      addedNamespaceIds: [B],
      removedNamespaceIds: [A],
    });
    expect(targetAfterHumanArtifactAuthorizedViewDeletion({
      currentNamespaceIds: [A, C],
      readableNamespaceIds: [A],
    })).toEqual([C]);
  });

  test("supports an empty terminal target and rejects unauthorized deltas", () => {
    expect(fingerprintHumanArtifactExactAccessTarget([])).toHaveLength(32);
    expect(() => deriveHumanArtifactExactAccessChange({
      authority,
      currentNamespaceIds: [A],
      proposedTargetNamespaceIds: [C],
    })).toThrow("add authority");
    expect(() => deriveHumanArtifactExactAccessChange({
      authority: { ...authority, mutableNamespaceIds: [] },
      currentNamespaceIds: [A],
      proposedTargetNamespaceIds: [],
    })).toThrow("remove authority");
  });
});
