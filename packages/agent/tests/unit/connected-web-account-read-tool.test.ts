import { afterEach, describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";
import {
  CONNECTED_WEB_ACCOUNT_READ_MODEL_RESULT_MAX_JSON_CHARS,
  CONNECTED_WEB_ACCOUNT_READ_REQUEST_MAX_CHARS,
  CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS,
  createConnectedWebAccountReadTool,
  dispatchConnectedWebAccountRead,
  listConnectedWebAccountCapabilities,
  resolveConnectedWebAccountReadActor,
} from "../../src/tools/connected-web-accounts/read-connected-web-account";
import {
  resetConnectedWebAccountReadToolRuntimeForTests,
  setConnectedWebAccountReadToolRuntime,
  type ConnectedWebAccountReadToolRuntime,
} from "../../src/tools/connected-web-accounts/runtime";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000001";
const ROOM_ID = "30000000-0000-4000-8000-000000000001";
const MEMORY_ACCESS_ENVELOPE = {} as never;

afterEach(() => resetConnectedWebAccountReadToolRuntimeForTests());

describe("read_connected_web_account", () => {
  test("is a single human-recognizable-account, plain-language read tool", () => {
    const tool = createConnectedWebAccountReadTool();
    expect(tool.name).toBe("read_connected_web_account");
    expect(tool.description).toContain("first-use arbitrary site");
    expect(tool.description).toContain("protected Browser Use profile");
    expect(tool.description).toContain("do not search the public web");
    expect(tool.description).toContain("do not substitute the embedded browser");
    expect(tool.schema.safeParse({ account: "Work calendar", request: "What is due next?" }).data).toMatchObject({ delivery: "text" });
    expect(tool.schema.safeParse({ account: "Work calendar", request: "What is due next?", delivery: "workspace" }).success).toBe(true);
    expect(tool.schema.safeParse({ account: "", request: "What is due next?" }).success).toBe(false);
    expect(tool.schema.safeParse({ account: "Work calendar", request: "" }).success).toBe(false);
    expect(tool.schema.safeParse({
      account: "a".repeat(CONNECTED_WEB_ACCOUNT_SELECTOR_MAX_CHARS + 1),
      request: "What is due next?",
    }).success).toBe(false);
    expect(tool.schema.safeParse({
      account: "Work calendar",
      request: "r".repeat(CONNECTED_WEB_ACCOUNT_READ_REQUEST_MAX_CHARS + 1),
    }).success).toBe(false);
    expect("maxCostUsd" in tool.schema.shape).toBe(false);
  });

  test("projects the current Human's safe connected-site inventory without provider coordinates", async () => {
    setConnectedWebAccountReadToolRuntime({
      listAvailable: async (actor) => {
        expect(actor).toEqual({
          userId: USER_ID,
          agentId: AGENT_ID,
          roomId: ROOM_ID,
          callingRoomId: null,
          memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE,
        });
        return [{
          label: "console.nebius.com",
          service: "console.nebius.com",
          origin: "https://console.nebius.com",
          status: "connected",
        }];
      },
      read: async () => ({ ok: false, code: "unavailable", recovery: "none" }),
    });

    expect(await listConnectedWebAccountCapabilities({
      userId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE,
    })).toEqual([{
      label: "console.nebius.com",
      service: "console.nebius.com",
      origin: "https://console.nebius.com",
      status: "connected",
    }]);
    expect(await listConnectedWebAccountCapabilities({ userId: USER_ID })).toEqual([]);
  });

  test("fails closed when authenticated Human, current Genie, or foreground Room context is missing", async () => {
    let called = false;
    setConnectedWebAccountReadToolRuntime({
      read: async () => {
        called = true;
        throw new Error("not reached");
      },
    });

    expect(resolveConnectedWebAccountReadActor({ userId: USER_ID })).toBeNull();
    expect(resolveConnectedWebAccountReadActor({ agentId: AGENT_ID })).toBeNull();
    expect(resolveConnectedWebAccountReadActor({ userId: USER_ID, agentId: AGENT_ID })).toBeNull();

    expect(JSON.parse(await dispatchConnectedWebAccountRead(
      { account: "Work calendar", request: "Read my updates" },
      { userId: USER_ID, roomId: ROOM_ID, memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
    ))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
    expect(called).toBe(false);
  });

  test("returns a typed recovery when the server runtime has not been injected", async () => {
    expect(JSON.parse(await dispatchConnectedWebAccountRead(
      { account: "Work calendar", request: "Read my updates" },
      { userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID, memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
    ))).toEqual({ ok: false, code: "unavailable", recovery: "none" });
  });

  test("passes exact foreground Human, Genie, Room, calling-room state, account, and request to the injected runtime", async () => {
    const calls: unknown[] = [];
    const runtime: ConnectedWebAccountReadToolRuntime = {
      read: async (actor, input) => {
        calls.push({ actor, input });
        return {
          ok: false,
          code: "ambiguous_account",
          recovery: "none",
        };
      },
    };
    setConnectedWebAccountReadToolRuntime(runtime);

    const response = JSON.parse(await dispatchConnectedWebAccountRead(
      { account: "Work calendar", request: "Read my recent notifications" },
      { userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID, callingRoomId: "", memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
    )) as unknown;

    expect(calls).toEqual([{
      actor: { userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID, callingRoomId: null, memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
      input: { account: "Work calendar", request: "Read my recent notifications", delivery: "text" },
    }]);
    expect(response).toEqual({ ok: false, code: "ambiguous_account", recovery: "none" });
  });

  test("preserves a non-empty calling Room for server-side foreground rejection", async () => {
    const calls: unknown[] = [];
    setConnectedWebAccountReadToolRuntime({
      read: async (actor) => {
        calls.push(actor);
        return { ok: false, code: "unavailable", recovery: "none" };
      },
    });

    await dispatchConnectedWebAccountRead(
      { account: "Work calendar", request: "Read my recent notifications" },
      { userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID, callingRoomId: "task-origin-room", memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
    );
    expect(calls).toEqual([{
      userId: USER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      callingRoomId: "task-origin-room",
      memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE,
    }]);
  });

  test("projects only the bounded safe read receipt and strips internal execution details", async () => {
    setConnectedWebAccountReadToolRuntime({
      read: async () => ({
        ok: true,
        status: "completed",
        account: {
          id: "account-1",
          label: "Work calendar",
          service: "Calendar",
          origin: "https://calendar.example",
          profileId: "profile-secret",
          browserId: "browser-secret",
        },
        page: { ref: "account-1", title: "Work calendar", origin: "https://calendar.example", sessionId: "session-secret" },
        read: {
          answer: "Your next meeting is at 10:00.",
          facts: [{ label: "Next meeting", value: "10:00" }],
          completeness: "complete",
          provenance: "authenticated_website",
          origin: "https://calendar.example",
          runId: "run-secret",
          liveViewUrl: "https://bearer.example",
        },
        cost: { currency: "USD", amountUsd: 0.01, state: "actual", provider: "hidden" },
        outputs: [{ artifactId: "artifact-1", path: "connected-web/report.csv", mime: "text/csv", bytes: 3, workspaceId: "workspace-secret", url: "https://presigned.example" }],
        outputsTruncated: false,
        provider: "hidden",
      }) as unknown as Awaited<ReturnType<ConnectedWebAccountReadToolRuntime["read"]>>,
    });

    const raw = await dispatchConnectedWebAccountRead(
      { account: "Work calendar", request: "What is next?" },
      { userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID, memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
    );
    const body = JSON.parse(raw) as unknown;

    expect(body).toEqual({
      ok: true,
      status: "completed",
      account: {
        id: "account-1",
        label: "Work calendar",
        service: "Calendar",
        origin: "https://calendar.example",
      },
      page: { ref: "account-1", title: "Work calendar", origin: "https://calendar.example" },
      read: {
        answer: "Your next meeting is at 10:00.",
        facts: [{ label: "Next meeting", value: "10:00" }],
        completeness: "complete",
        provenance: "authenticated_website",
        origin: "https://calendar.example",
      },
      cost: { currency: "USD", amountUsd: 0.01, state: "actual" },
      outputs: [{ artifactId: "artifact-1", path: "connected-web/report.csv", mime: "text/csv", bytes: 3 }],
      outputsTruncated: false,
    });
    expect(raw).not.toContain("profile-secret");
    expect(raw).not.toContain("browser-secret");
    expect(raw).not.toContain("run-secret");
    expect(raw).not.toContain("bearer.example");
    expect(raw).not.toContain("session-secret");
    expect(raw).not.toContain("workspace-secret");
    expect(raw).not.toContain("presigned.example");
    expect(raw).not.toContain('"provider"');
  });

  test("projects an active operation with the exact epoch needed for later control and no provider coordinates", async () => {
    setConnectedWebAccountReadToolRuntime({
      read: async () => ({
        ok: true,
        status: "active",
        account: { id: "account-1", label: "Nebius", service: "Nebius", origin: "https://console.nebius.com" },
        operation: {
          operationId: "50000000-0000-4000-8000-000000000001",
          driver: "hosted",
          lifecycle: "running",
          controlEpoch: 2,
          activity: { version: 1, phase: "working", code: "provider_running", summary: "Connected website work is running." },
          receipt: null,
          runRef: "sealed-provider-run",
          liveViewUrl: "https://private.example/live",
        },
      }) as unknown as Awaited<ReturnType<ConnectedWebAccountReadToolRuntime["read"]>>,
    });
    const raw = await dispatchConnectedWebAccountRead(
      { account: "Nebius", request: "List projects" },
      { userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID, memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
    );
    expect(JSON.parse(raw)).toEqual({
      ok: true,
      status: "active",
      account: { id: "account-1", label: "Nebius", service: "Nebius", origin: "https://console.nebius.com" },
      operation: {
        operationId: "50000000-0000-4000-8000-000000000001",
        driver: "hosted",
        lifecycle: "running",
        controlEpoch: 2,
        activity: { phase: "working", code: "provider_running", summary: "Connected website work is running." },
        receipt: null,
      },
    });
    expect(raw).not.toContain("sealed-provider-run");
    expect(raw).not.toContain("private.example");
  });

  test("projects a sealed authentication intervention without provider capability fields", async () => {
    setConnectedWebAccountReadToolRuntime({
      read: async () => ({
        ok: false,
        code: "authentication_required",
        recovery: "reconnect",
        intervention: {
          kind: "authentication_required",
          mode: "reconnect",
          reason: "captcha",
          account: {
            id: "account-1",
            label: "Airbnb",
            service: "Airbnb",
            origin: "https://www.airbnb.com",
            liveViewUrl: "https://provider.example/bearer",
          },
          profileId: "profile-secret",
        },
      }) as unknown as Awaited<ReturnType<ConnectedWebAccountReadToolRuntime["read"]>>,
    });

    const raw = await dispatchConnectedWebAccountRead(
      { account: "Airbnb", request: "Find stays in Madrid" },
      { userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID, memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
    );
    expect(JSON.parse(raw)).toEqual({
      ok: false,
      code: "authentication_required",
      recovery: "reconnect",
      intervention: {
        kind: "authentication_required",
        mode: "reconnect",
        reason: "captcha",
        account: { id: "account-1", label: "Airbnb", service: "Airbnb", origin: "https://www.airbnb.com" },
      },
      continuation: {
        account: "Airbnb",
        request: "Find stays in Madrid",
        delivery: "text",
      },
    });
    expect(raw).not.toContain("provider.example");
    expect(raw).not.toContain("profile-secret");
  });

  test("preserves provider completion when a read exceeds the model-result projection", async () => {
    setConnectedWebAccountReadToolRuntime({
      read: async () => ({
        ok: true,
        status: "completed",
        account: { id: "account-1", label: "Work calendar", service: "Calendar", origin: "https://calendar.example" },
        page: { ref: "account-1", title: "Work calendar", origin: "https://calendar.example" },
        read: {
          answer: "x".repeat(CONNECTED_WEB_ACCOUNT_READ_MODEL_RESULT_MAX_JSON_CHARS),
          facts: [],
          completeness: "partial",
          provenance: "authenticated_website",
          origin: "https://calendar.example",
        },
        cost: { currency: "USD", amountUsd: null, state: "unknown" },
        outputs: [],
        outputsTruncated: false,
      }),
    });

    expect(JSON.parse(await dispatchConnectedWebAccountRead(
      { account: "Work calendar", request: "Read my updates" },
      { userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID, memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE },
    ))).toMatchObject({ ok: true, status: "completed", read: null });
  });

  test("registers as capability-gated core, low-impact authenticated app use", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    expect(catalog.get("read_connected_web_account")).toMatchObject({
      category: "integrations",
      discoveryCategories: ["research"],
      trustTier: "standard",
      impact: "low",
      exposure: "core",
      requiredCapabilities: ["use_connections"],
      resultScanPolicy: "on-suspicious",
    });
  });
});

test("connected website actor inherits voice only from trusted invocation context", () => {
  for (const voiceMode of [true, false, undefined]) {
    expect(resolveConnectedWebAccountReadActor({ userId: USER_ID, agentId: AGENT_ID, roomId: ROOM_ID,
      memoryAccessEnvelope: MEMORY_ACCESS_ENVELOPE, voiceMode })?.voiceMode).toBe(voiceMode);
  }
});
