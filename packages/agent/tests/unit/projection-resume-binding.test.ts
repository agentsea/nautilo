import { describe, expect, test } from "bun:test";
import { projectionResumeBindingFromCheckpoint } from "../../src/graph/projection-resume-binding";

function parkedProjectionState(snapshot: unknown = {
  toolCallId: "projection-call",
  requesterUserId: "initiator-user",
  requesterActorId: "initiator-actor",
}): unknown {
  return {
    values: { projectionSnapshots: [snapshot] },
    tasks: [{
      interrupts: [{
        value: {
          type: "prove_it_challenge",
          tools: [{
            id: "projection-call",
            name: "share_memory",
            args: { mode: "project", proposed_content: "public text" },
          }],
        },
      }],
    }],
  };
}

describe("projectionResumeBindingFromCheckpoint", () => {
  test("returns the initiating Human and Actor for a parked projection", () => {
    expect(projectionResumeBindingFromCheckpoint(parkedProjectionState())).toEqual({
      kind: "bound",
      requesterUserId: "initiator-user",
      requesterActorId: "initiator-actor",
    });
  });

  test("leaves a non-projection approval on the legacy resume path", () => {
    expect(projectionResumeBindingFromCheckpoint({
      values: { projectionSnapshots: [] },
      tasks: [{
        interrupts: [{
          value: {
            type: "approval_ask",
            tools: [{ id: "legacy", name: "run_shell", args: { command: "pwd" } }],
          },
        }],
      }],
    })).toEqual({ kind: "none" });
  });

  test("fails closed when an active projection has no valid private snapshot", () => {
    expect(projectionResumeBindingFromCheckpoint(parkedProjectionState({
      toolCallId: "projection-call",
      requesterUserId: "initiator-user",
    }))).toEqual({ kind: "malformed" });
  });

  test("ignores a stale snapshot once no projection interrupt is parked", () => {
    expect(projectionResumeBindingFromCheckpoint({
      values: { projectionSnapshots: [{ malformed: true }] },
      tasks: [],
    })).toEqual({ kind: "none" });
  });
});
