import { describe, expect, test } from "bun:test";
import type { PersistJobPayload } from "@nautilo/db";
import { JobManager } from "../../src/job-manager";

describe("M293 Deep Research return-route admission", () => {
  test("binds only Deep Research to its trusted room route", async () => {
    const persisted: PersistJobPayload[] = [];
    const manager = new JobManager({
      persist: async (payload) => {
        persisted.push(payload);
        return `job-${persisted.length}`;
      },
      updateStatus: async () => {},
    });
    const trusted = {
      ownerId: "owner-m293",
      requestorId: "human-m293",
      roomId: "room-m293",
      laneKey: "room:room-m293",
      agentId: "agent-m293",
      graphThreadId: "thread-m293",
      modelId: null,
    };
    const job = await manager.createBackgroundJob(
      trusted.ownerId,
      trusted.requestorId,
      {
        type: "deep-research",
        deep_research_return_context: { roomId: "attacker-room" },
      },
      undefined,
      undefined,
      trusted,
    );

    expect(job.laneKey).toBe(trusted.laneKey);
    expect(job.input["deep_research_return_context"]).toEqual(trusted);
    expect(persisted[0]?.laneKey).toBe(trusted.laneKey);
    expect(persisted[0]?.roomId).toBe(trusted.roomId);
    expect(persisted[0]?.input["deep_research_return_context"]).toEqual(trusted);

    const genericInput = {
      type: "other",
      deep_research_return_context: { unchanged: true },
    };
    const generic = await manager.createBackgroundJob(
      trusted.ownerId,
      trusted.requestorId,
      genericInput,
    );
    expect(generic.laneKey).toBeNull();
    expect(generic.input).toBe(genericInput);
  });

  test("rejects a route that does not match accepted identity", async () => {
    const manager = new JobManager({
      persist: async () => "must-not-persist",
      updateStatus: async () => {},
    });
    let failure: unknown;
    try {
      await manager.createBackgroundJob(
        "owner-m293",
        "owner-m293",
        { type: "deep-research", research_brief: "test" },
        undefined,
        undefined,
        {
          ownerId: "different-owner",
          requestorId: "owner-m293",
          roomId: "room-m293",
          laneKey: "room:room-m293",
          agentId: "agent-m293",
          graphThreadId: "thread-m293",
          modelId: null,
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("does not match accepted authority");
  });
});
