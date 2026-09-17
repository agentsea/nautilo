import { describe, expect, test } from "bun:test";
import {
  readAgentIdFromCheckpoint,
  readConnectedWebActionResumeBindingFromCheckpoint,
  readCausalHumanUserIdFromCheckpoint,
  readTurnIdFromCheckpoint,
} from "../../src/graph/turn-id";

describe("readAgentIdFromCheckpoint (foreground resume identity)", () => {
  test("returns the paused graph Agent instead of a request default", async () => {
    expect(
      await readAgentIdFromCheckpoint(
        { getState: async () => ({ values: { agentId: "agent-nova" } }) },
        "room:room-id:bot:agent-nova",
      ),
    ).toBe("agent-nova");
  });

  test("fails closed when the checkpoint has no Agent identity", async () => {
    expect(
      await readAgentIdFromCheckpoint(
        { getState: async () => ({ values: {} }) },
        "legacy-thread",
      ),
    ).toBeNull();
  });
});

describe("readTurnIdFromCheckpoint (D082 PR B)", () => {
  test("returns the persisted turnId when the checkpoint carries one", async () => {
    const graph = {
      getState: async () => ({ values: { turnId: "persisted-abc" } }),
    };
    const id = await readTurnIdFromCheckpoint(graph, "thread-1");
    expect(id).toBe("persisted-abc");
  });

  test("mints a fresh uuid when checkpoint has no turnId field", async () => {
    const graph = {
      getState: async () => ({ values: { messages: [] } }),
    };
    const id = await readTurnIdFromCheckpoint(graph, "thread-1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("mints a fresh uuid when turnId is the empty string (legacy checkpoint)", async () => {
    const graph = {
      getState: async () => ({ values: { turnId: "" } }),
    };
    const id = await readTurnIdFromCheckpoint(graph, "thread-1");
    expect(id).not.toBe("");
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  test("mints a fresh uuid when getState throws (no checkpoint for this thread)", async () => {
    const graph = {
      getState: async () => {
        throw new Error("no such checkpoint");
      },
    };
    const id = await readTurnIdFromCheckpoint(graph, "thread-never-seen");
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  test("guards against non-string turnId values (defensive)", async () => {
    const graph = {
      getState: async () => ({ values: { turnId: 42 as unknown as string } }),
    };
    const id = await readTurnIdFromCheckpoint(graph, "thread-1");
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  test("returns distinct ids across calls when no checkpoint binding exists", async () => {
    const graph = {
      getState: async () => undefined,
    };
    const a = await readTurnIdFromCheckpoint(graph, "t1");
    const b = await readTurnIdFromCheckpoint(graph, "t2");
    expect(a).not.toBe(b);
  });
});

describe("readCausalHumanUserIdFromCheckpoint (M233)", () => {
  test("returns explicit checkpoint provenance and fails closed on absence", async () => {
    expect(
      await readCausalHumanUserIdFromCheckpoint(
        {
          getState: async () => ({
            values: { causalHumanUserId: "human-1" },
          }),
        },
        "thread-1",
      ),
    ).toBe("human-1");
    expect(
      await readCausalHumanUserIdFromCheckpoint(
        { getState: async () => ({ values: {} }) },
        "legacy-thread",
      ),
    ).toBeNull();
  });
});

describe("readConnectedWebActionResumeBindingFromCheckpoint", () => {
  test("returns only a complete originating checkpoint agent and lane", async () => {
    expect(await readConnectedWebActionResumeBindingFromCheckpoint({ getState: async () => ({ values: { agentId: "agent-2", approvalLaneKey: "lane-2" } }) }, "thread-1")).toEqual({ agentId: "agent-2", laneKey: "lane-2" });
    expect(await readConnectedWebActionResumeBindingFromCheckpoint({ getState: async () => ({ values: { agentId: "agent-2", approvalLaneKey: "" } }) }, "thread-1")).toBeNull();
    expect(await readConnectedWebActionResumeBindingFromCheckpoint({ getState: async () => { throw new Error("missing"); } }, "thread-1")).toBeNull();
  });
});
