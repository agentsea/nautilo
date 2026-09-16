import { describe, expect, test } from "bun:test";
import { workspaceRoomAuthorityProofAllows } from "../../src/queries/artifacts";

const valid = {
  currentRoomExists: true,
  currentRoomHumanActorIds: ["human-actor"],
  humanActorId: "human-actor",
  humanMembershipExists: true,
  agentMirrorMembershipExists: true,
  readableNamespaceIds: ["room-ns", "superset-ns"],
  attachedNamespaceIds: ["superset-ns"],
} as const;

describe("D448 Workspace transaction authority proof", () => {
  test("accepts the current Room-derived Namespace subset proof", () => {
    expect(workspaceRoomAuthorityProofAllows(valid)).toBe(true);
  });

  test("fails closed when human membership is removed", () => {
    expect(workspaceRoomAuthorityProofAllows({ ...valid, humanMembershipExists: false })).toBe(false);
  });

  test("fails closed when the current Room or agent mirror membership changes", () => {
    expect(workspaceRoomAuthorityProofAllows({ ...valid, currentRoomExists: false })).toBe(false);
    expect(workspaceRoomAuthorityProofAllows({ ...valid, agentMirrorMembershipExists: false })).toBe(false);
  });

  test("fails closed when a Room human-set shrink removes the artifact Namespace from the subset", () => {
    expect(workspaceRoomAuthorityProofAllows({
      ...valid,
      currentRoomHumanActorIds: ["human-actor", "revoked-human"],
      readableNamespaceIds: ["room-ns"],
    })).toBe(false);
  });

  test("fails closed when the artifact is detached during the proof", () => {
    expect(workspaceRoomAuthorityProofAllows({ ...valid, attachedNamespaceIds: [] })).toBe(false);
  });
});
