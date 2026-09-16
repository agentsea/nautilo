import { afterEach, expect, test } from "bun:test";
import { ToolCatalog, clearToolCatalog, getToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { resolveApprovalForToolCall } from "../../src/nodes/post-model";
import { registerAllTools } from "../../src/tools/register-all";
import { createRunWebsiteTaskTool, runWebsiteTaskSchema } from "../../src/tools/connected-web-accounts/run-website-task";
import { resetConnectedWebAccountReadToolRuntimeForTests, setConnectedWebAccountReadToolRuntime } from "../../src/tools/connected-web-accounts/runtime";
import type { ConnectedWebAccountReadToolContext } from "../../src/tools/connected-web-accounts/read-connected-web-account";
import { AgentToolCallTracker } from "../../src/runtime-hooks";

const context: ConnectedWebAccountReadToolContext = { userId: "human", agentId: "genie", roomId: "room", toolCallId: "delivery", currentThreadId: "thread", turnId: "turn", laneKey: "lane",
  memoryAccessEnvelope: { ownerId: "human", agentId: "genie", roomId: "room", toolPolicy: { run_website_task: "allow" } } as never };
afterEach(() => resetConnectedWebAccountReadToolRuntimeForTests());

test("website tasks are capability-gated, high impact and do not ask twice", () => {
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { publicBrowserUseAvailable: () => true });
  expect(catalog.get("run_website_task")).toMatchObject({ impact: "high", requiresApproval: false, requiredCapabilities: ["use_connections"], exposure: "core" });
  expect(runWebsiteTaskSchema.safeParse({ url: "https://example.com", request: "Create a page" }).success).toBe(true);
  expect(runWebsiteTaskSchema.safeParse({ account: "BookStack", request: "Create a page" }).success).toBe(true);
  expect(runWebsiteTaskSchema.safeParse({ account: "BookStack", url: "https://example.com", request: "Create a page" }).success).toBe(false);
  expect(runWebsiteTaskSchema.safeParse({ request: "Create a page", profileId: "forged" }).success).toBe(false);
  expect(runWebsiteTaskSchema.safeParse({ url: `https://example.com/${"x".repeat(2100)}`, request: "Create a page" }).success).toBe(false);
});

test("website task admission does not add confirmation at any security level", () => {
  const previous = getToolCatalog();
  const catalog = new ToolCatalog();
  registerAllTools(catalog, { publicBrowserUseAvailable: () => true });
  initToolCatalog(catalog);
  try {
    for (const level of ["yolo", "permissive", "standard", "cautious", "paranoid"] as const) {
      for (const name of ["run_website_task", "act_connected_web_account"]) {
        expect(resolveApprovalForToolCall({ id: "task", name, args: {} }, level))
          .toMatchObject({ verb: "auto", severity: "high-impact" });
      }
    }
  } finally { if (previous) initToolCatalog(previous); else clearToolCatalog(); }
});

test("a detailed task reaches the runtime intact without an arbitrary prompt cap", async () => {
  const request = "Include this requested detail. ".repeat(200);
  let received = "";
  setConnectedWebAccountReadToolRuntime({ read: async (_actor, input) => {
    received = input.request;
    return { ok: false, code: "provider_unavailable", recovery: "none" };
  } });
  await createRunWebsiteTaskTool(context).invoke({ account: "BookStack", request });
  expect(received).toBe(request.trim());
});

test("task tool supplies explicit task intent and retains the original request through sign-in", async () => {
  const request = "Create a book and Welcome page. ".repeat(150).trim();
  const calls: unknown[] = [];
  setConnectedWebAccountReadToolRuntime({ read: async (actor, input) => {
    calls.push({ actor, input });
    return { ok: false, code: "authentication_required", recovery: "connect", intervention: { kind: "authentication_required", mode: "connect", reason: "not_connected", target: { selector: input.account } } };
  } });
  const result: unknown = JSON.parse(await createRunWebsiteTaskTool(context).invoke({ account: "BookStack", request }));
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ actor: { toolCallId: "delivery" }, input: { intent: "task", delivery: "text" } });
  expect(result).toMatchObject({ code: "authentication_required", continuation: { account: "BookStack", request, delivery: "text" } });
});

test("public tasks do not look up or borrow a saved account", async () => {
  const calls: unknown[] = [];
  setConnectedWebAccountReadToolRuntime({ read: async () => { throw new Error("must not read a profile"); },
    readPublic: async (_actor, input) => { calls.push(input); return { ok: false, code: "provider_unavailable", recovery: "none" }; } });
  const result: unknown = JSON.parse(await createRunWebsiteTaskTool(context).invoke({ url: "https://example.com", request: "Submit the requested feedback" }));
  expect(calls).toEqual([{ url: "https://example.com", request: "Submit the requested feedback", intent: "task" }]);
  expect(result).toEqual({ ok: false, code: "provider_unavailable", recovery: "none" });
});

test("active task receipt preserves exact continuation while lifecycle args stay display-only", async () => {
  const request = "Create the requested page. ".repeat(200).trim();
  setConnectedWebAccountReadToolRuntime({ read: async () => ({ ok: false, code: "unavailable", recovery: "none" }),
    readPublic: async () => ({ ok: true, status: "active", target: { url: "https://example.com", origin: "https://example.com" },
      operation: { operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1,
        activity: { phase: "working", code: "working", summary: "Working" }, receipt: null } }) });
  const result: unknown = JSON.parse(await createRunWebsiteTaskTool(context).invoke({ url: "https://example.com", request }));
  expect(result).toMatchObject({ status: "active", continuation: { account: "https://example.com", request, delivery: "text" } });
  const tracker = new AgentToolCallTracker();
  const display = tracker.toolStart("task", "run_website_task", { url: "https://example.com", request });
  expect(JSON.parse(display.argsSummary!)).toEqual({ url: "https://example.com" });
  expect(tracker.toolEnd("task", "run_website_task", "success", undefined, JSON.stringify(result)).result).toContain(request);
});

test("a read-only envelope cannot execute a task and exceptions do not expose credentials", async () => {
  let calls = 0;
  setConnectedWebAccountReadToolRuntime({ read: async () => { calls++; throw new Error("Bearer private-token wss://private-session"); } });
  const readOnly = { ...context, memoryAccessEnvelope: { ...context.memoryAccessEnvelope!, toolPolicy: { run_website_task: "read_only" as const } } };
  expect(JSON.parse(await createRunWebsiteTaskTool(readOnly).invoke({ account: "BookStack", request: "Create a page" }))).toMatchObject({ ok: false });
  expect(calls).toBe(0);
  expect(await createRunWebsiteTaskTool(context).invoke({ account: "BookStack", request: "Create a page" })).not.toMatch(/private-token|private-session/);
  expect(calls).toBe(1);
});
