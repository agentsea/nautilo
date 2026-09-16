import { afterEach, describe, expect, test } from "bun:test";
import { createScheduleTool } from "../../src/tools/tasks/shortcuts/schedule";
import {
  setTaskToolRuntime,
  type TaskToolCreateInput,
} from "../../src/tools/tasks/task-tool-runtime";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000002";
const ROOM_ID = "30000000-0000-4000-8000-000000000003";
const CTX = {
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  roomId: ROOM_ID,
  userTimezone: "America/Los_Angeles",
};

function futureIso(): string {
  // One hour from now, offset-qualified (Z).
  return new Date(Date.now() + 3_600_000).toISOString();
}

describe("schedule shortcut (M145)", () => {
  let captured: TaskToolCreateInput | null = null;

  afterEach(() => {
    setTaskToolRuntime(null);
    captured = null;
  });

  function stubRuntime() {
    setTaskToolRuntime({
      db: {} as never,
      createTask: async (input) => {
        captured = input;
        return { taskId: "t1", status: "pending", nextFireAt: new Date() };
      },
      computeNextFireAt: () => new Date(),
      pauseTask: async () => ({ ok: true, status: "paused", message: "" }),
      unpauseTask: async () => ({ ok: true, status: "pending", message: "" }),
      stopTask: async () => ({ ok: true, status: "cancelled", message: "" }),
    });
  }

  test("name", () => {
    expect(createScheduleTool().name).toBe("schedule");
  });

  test("M152 — threads model_selection → selectionProfile", async () => {
    stubRuntime();
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "x";
    try {
      await createScheduleTool(CTX).invoke({
        message: "summarize email",
        when: { kind: "once", at: futureIso() },
        model_selection: "cheapest",
      });
      expect(captured?.selectionProfile).toBe("cheapest");
    } finally {
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  test("one-shot input shape", async () => {
    stubRuntime();
    const at = futureIso();
    await createScheduleTool(CTX).invoke({
      message: "drink water",
      when: { kind: "once", at },
    });
    expect(captured).toMatchObject({
      ownerId: OWNER_ID,
      requestorId: OWNER_ID,
      agentId: AGENT_ID,
      prompt: "drink water",
      preset: "schedule",
      scheduleKind: "one_shot",
      timezone: "America/Los_Angeles",
      useScope: false,
      targetChat: "last_in_namespace",
      resultDelivery: "wake",
      awaitResponse: false,
      toolsMode: "auto",
      callingRoomId: ROOM_ID,
      targetUserIds: [OWNER_ID],
      depth: 0,
    });
    expect(captured?.runAt instanceof Date).toBe(true);
    expect(captured?.runAt?.toISOString()).toBe(at);
  });

  test("cron input shape", async () => {
    stubRuntime();
    await createScheduleTool(CTX).invoke({
      message: "stand up",
      when: { kind: "recurring", cron: "0 9 * * 1-5" },
    });
    expect(captured).toMatchObject({
      preset: "schedule",
      scheduleKind: "cron",
      cron: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
    });
    expect(captured?.runAt).toBeUndefined();
  });

  test("past one-shot is rejected, no createTask", async () => {
    stubRuntime();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const out = await createScheduleTool(CTX).invoke({
      message: "x",
      when: { kind: "once", at: past },
    });
    expect(String(out)).toContain("in the past");
    expect(captured).toBeNull();
  });

  test("bare local datetime (no offset) is rejected", async () => {
    stubRuntime();
    const out = await createScheduleTool(CTX).invoke({
      message: "x",
      when: { kind: "once", at: "2099-06-09T14:30:00" },
    });
    expect(String(out)).toContain("UTC offset");
    expect(captured).toBeNull();
  });

  test("invalid datetime is rejected", async () => {
    stubRuntime();
    const out = await createScheduleTool(CTX).invoke({
      message: "x",
      when: { kind: "once", at: "not-a-date-Z" },
    });
    expect(String(out)).toContain("invalid");
    expect(captured).toBeNull();
  });

  test("invalid cron is rejected, no createTask", async () => {
    stubRuntime();
    const out = await createScheduleTool(CTX).invoke({
      message: "x",
      when: { kind: "recurring", cron: "not a cron" },
    });
    expect(String(out)).toContain("cron");
    expect(captured).toBeNull();
  });

  test("timezone falls back to UTC when absent", async () => {
    stubRuntime();
    await createScheduleTool({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
    }).invoke({
      message: "x",
      when: { kind: "recurring", cron: "0 9 * * *" },
    });
    expect(captured?.timezone).toBe("UTC");
  });

  test("missing context returns error string (no execution)", async () => {
    const out = await createScheduleTool({
      ownerId: "",
      agentId: "",
      roomId: "",
    }).invoke({ message: "x", when: { kind: "recurring", cron: "0 9 * * *" } });
    expect(String(out)).toContain("missing owner or agent context");
    expect(captured).toBeNull();
  });
});
