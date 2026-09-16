import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CodexRequestEvent, CodexRequestResponse } from "@nautilo/types";
import {
  CodexRequestContext,
  initialCodexRequestLifecycleState,
  reduceCodexRequestLifecycle,
  selectCodexRequestsForRoom,
  type CodexRequestState,
  type CodexRequestView,
} from "../../src/adapters/runtime-contexts";
import { CodexRequestDock } from "../../src/components/codex-request-dock";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const conversationSource = readFileSync(`${repoRoot}src/components/conversation.tsx`, "utf8");

function commandRequest(overrides: Partial<CodexRequestEvent> = {}): CodexRequestEvent {
  return {
    type: "codex.request",
    ownerId: "owner-1",
    requestId: "request-1",
    taskId: "task-1",
    jobId: "job-1",
    roomId: "room-1",
    expiresAt: null,
    request: {
      kind: "command_approval_required",
      options: ["approve", "deny"],
      reason: "host_local_only",
      command: { detail: "host_local_only", actionKinds: ["unknown"] },
    },
    ...overrides,
  };
}

function inputRequest(): CodexRequestEvent {
  return {
    ...commandRequest({ requestId: "request-input" }),
    requestId: "request-input",
    request: {
      kind: "user_input_required",
      questions: [{
        id: "choice",
        header: "Choose a path",
        prompt: "Which path should Codex take?",
        secret: false,
        allowOther: false,
        options: [{ id: "option:0", label: "Safe option", description: null }],
      }],
      autoResolutionMs: null,
    },
  };
}

function requestView(event: CodexRequestEvent, availability: "actionable" | "unavailable" = "actionable"): CodexRequestView {
  return { event, availability };
}

describe("D453 Codex request lifecycle", () => {
  test("keeps background-room requests pending until that room is active, then clears exact/job/task terminals", () => {
    const first = commandRequest();
    const second = commandRequest({ requestId: "request-2", taskId: "task-2", jobId: "job-2" });
    let state = reduceCodexRequestLifecycle(initialCodexRequestLifecycleState(), {
      kind: "arm",
      event: first,
    });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: second });

    expect(state.order).toEqual(["request-1", "request-2"]);
    expect(selectCodexRequestsForRoom(state, "room-1", "owner-1").requests).toHaveLength(2);
    expect(selectCodexRequestsForRoom(state, "room-2", "owner-1").requests).toEqual([]);
    const background = commandRequest({ requestId: "request-background", roomId: "room-2" });
    state = reduceCodexRequestLifecycle(state, { kind: "arm", event: background });
    expect(selectCodexRequestsForRoom(state, "room-2", "owner-1").requests.map((view) => view.event.requestId))
      .toEqual(["request-background"]);
    state = reduceCodexRequestLifecycle(state, { kind: "resolved", requestId: "request-1" });
    expect(state.order).toEqual(["request-2", "request-background"]);
    state = reduceCodexRequestLifecycle(state, { kind: "clear_job", jobId: "job-2" });
    expect(state.order).toEqual(["request-background"]);
    state = reduceCodexRequestLifecycle(state, { kind: "clear_task", taskId: "task-1" });
    expect(state.order).toEqual([]);
  });
});

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const) {
    priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    HTMLElement: happyWindow.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});

const mountedDocks: Array<{ root: Root; host: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, host } of mountedDocks.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
      await flush();
    });
    host.remove();
  }
});

afterAll(async () => {
  // Let React's scheduled unmount work settle before returning the global DOM
  // shims to Bun. This mirrors the other happy-dom Workbench dock tests.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const globals = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete globals[key];
    else globals[key] = priorGlobals[key];
  }
});

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function renderDock(
  requests: readonly CodexRequestView[],
  respond: (requestId: string, response: CodexRequestResponse) => Promise<void>,
): Promise<{ root: Root; host: HTMLElement }> {
  const host = happyWindow.document.createElement("div") as unknown as HTMLElement;
  happyWindow.document.body.appendChild(host);
  const state: CodexRequestState = {
    requests,
    submittingRequestId: null,
    errors: {},
  };
  const root = createRoot(host);
  mountedDocks.push({ root, host });
  await act(async () => {
    root.render(
      <CodexRequestContext.Provider value={{ state, respond, dismiss: () => {} }}>
        <CodexRequestDock />
      </CodexRequestContext.Provider>,
    );
    await flush();
  });
  return { root, host };
}

describe("CodexRequestDock", () => {
  test("renders a compact inline approval with only browser-safe local detail", async () => {
    const responses: Array<{ requestId: string; response: CodexRequestResponse }> = [];
    const { host } = await renderDock([requestView(commandRequest())], async (requestId, response) => {
      responses.push({ requestId, response });
    });

    expect(host.querySelector('[data-testid="codex-request-dock"]')).not.toBeNull();
    expect(host.textContent).toContain("run a local operation");
    expect(host.textContent).toContain("stay on this device");
    expect(host.querySelectorAll("button").length).toBe(2);
    await act(async () => {
      (host.querySelector('[data-decision="approve"]') as HTMLButtonElement).click();
      await flush();
    });
    expect(responses).toEqual([{
      requestId: "request-1",
      response: { kind: "command_approval_required", decision: "approve" },
    }]);
  });

  test("submits the opaque option id rather than constructing provider JSON", async () => {
    const responses: Array<{ requestId: string; response: CodexRequestResponse }> = [];
    const { host } = await renderDock([requestView(inputRequest())], async (requestId, response) => {
      responses.push({ requestId, response });
    });

    await act(async () => {
      (host.querySelector('input[type="radio"]') as HTMLInputElement).click();
      await flush();
    });
    await act(async () => {
      (host.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await flush();
    });
    expect(responses).toEqual([{
      requestId: "request-input",
      response: { kind: "user_input_required", answers: { choice: ["option:0"] } },
    }]);
  });
});

describe("D453 placement", () => {
  test("keeps the native request dock inline after the transcript and before the composer", () => {
    const approval = conversationSource.indexOf("<ApprovalAskDock />");
    const codex = conversationSource.indexOf("<CodexRequestDock />");
    const composer = conversationSource.indexOf("<Composer", codex);
    expect(approval).toBeGreaterThan(-1);
    expect(codex).toBeGreaterThan(approval);
    expect(composer).toBeGreaterThan(codex);
  });
});
