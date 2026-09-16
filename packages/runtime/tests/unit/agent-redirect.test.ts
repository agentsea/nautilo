/**
 * D421 Phase 4.2 — runtime half of the one-hop agent redirect trusted seam.
 *
 * Runtime owns only the in-memory completion-hook contract. Dispatch-owned
 * pending wake context is tested in the server package.
 *
 * Privacy contract (Phase 0 §0.2.4): the raw `AgentRedirectRequest.reason`,
 * actorIds, jobIds, and trace NEVER ride the room-scoped `eventBus`. The
 * completion hook is invoked IN-MEMORY (a direct function call from the
 * executor, not a bus event); pending context remains dispatch-owned.
 *
 * These tests exercise the hook contract directly against the
 * public runtime API — no executor process, no server, no DB.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setLogOutput } from "@nautilo/logger";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getOrCreateAgentTurnContextByKey,
  turnContextKey,
  _resetAgentTurnContextsForTests,
} from "@nautilo/agent";
import {
  shouldGraphAbortOnStreamTimeoutByKey,
} from "../../src/executors/langgraph-executor";
import {
  _resetRedirectCompletionForTests,
  getRedirectCompletionHook,
  notifyRedirectCompletion,
  setRedirectCompletionHook,
  type RedirectCompletionKind,
  type RedirectCompletionNotification,
} from "../../src/agent-redirect";

afterEach(() => {
  _resetRedirectCompletionForTests();
  _resetAgentTurnContextsForTests();
});

describe("RedirectCompletionHook registry", () => {
  test("install / read / release", () => {
    expect(getRedirectCompletionHook()).toBeNull();
    const hook = async (_n: RedirectCompletionNotification) => {};
    setRedirectCompletionHook(hook);
    expect(getRedirectCompletionHook()).toBe(hook);
    setRedirectCompletionHook(null);
    expect(getRedirectCompletionHook()).toBeNull();
  });

  test("notifyRedirectCompletion is a no-op when no hook is installed", async () => {
    await notifyRedirectCompletion({
      kind: "fulfilled",
      turnContextId: "k",
      humanTurnId: "turn-1",
      sourceAgentId: "agent-genie",
    });
    expect(getRedirectCompletionHook()).toBeNull();
  });

  test("notifyRedirectCompletion invokes the installed hook in-memory", async () => {
    const seen: RedirectCompletionNotification[] = [];
    setRedirectCompletionHook(async (n) => {
      seen.push(n);
    });
    await notifyRedirectCompletion({
      kind: "fulfilled",
      turnContextId: "k",
      humanTurnId: "turn-1",
      sourceAgentId: "agent-genie",
      request: { targetHandle: "alepo", depth: 1 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("fulfilled");
    expect(seen[0]?.request?.targetHandle).toBe("alepo");
  });

  test("throwing hook logs only a fixed code, never the secret error", async () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    setLogOutput("stderr");
    setRedirectCompletionHook(async () => {
      throw new Error("SECRET provider query text");
    });
    try {
      await notifyRedirectCompletion({
        kind: "error",
        turnContextId: "k",
        humanTurnId: "turn-1",
        sourceAgentId: "agent-genie",
      });
      const output = stderr.mock.calls.flat().join(" ");
      expect(output).toContain("completion_hook_failed kind=error");
      expect(output).not.toContain("SECRET provider query text");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("RedirectCompletionNotification — privacy contract", () => {
  test("fulfilled payload excludes the tool's raw internal reason", async () => {
    const seen: RedirectCompletionNotification[] = [];
    setRedirectCompletionHook(async (n) => {
      seen.push(n);
    });
    await notifyRedirectCompletion({
      kind: "fulfilled",
      turnContextId: "k",
      humanTurnId: "turn-1",
      sourceAgentId: "agent-genie",
      request: { targetHandle: "alepo", depth: 1 },
    });
    expect(seen[0]).toEqual({
      kind: "fulfilled",
      turnContextId: "k",
      humanTurnId: "turn-1",
      sourceAgentId: "agent-genie",
      request: { targetHandle: "alepo", depth: 1 },
    });
    expect("reason" in (seen[0]?.request ?? {})).toBe(false);

    const executorSource = readFileSync(
      resolve(import.meta.dirname, "../../src/executors/langgraph-executor.ts"),
      "utf8",
    );
    expect(executorSource).not.toContain("request.reason");
  });

  test("completed_no_request notification carries no request view", async () => {
    const seen: RedirectCompletionNotification[] = [];
    setRedirectCompletionHook(async (n) => {
      seen.push(n);
    });
    await notifyRedirectCompletion({
      kind: "completed_no_request",
      turnContextId: "k",
      humanTurnId: "turn-1",
      sourceAgentId: "agent-genie",
    });
    expect(seen[0]?.request).toBeUndefined();
    expect(seen[0]?.kind).toBe("completed_no_request" as RedirectCompletionKind);
  });

  test("error / aborted notifications carry no request view", async () => {
    const seen: RedirectCompletionNotification[] = [];
    setRedirectCompletionHook(async (n) => {
      seen.push(n);
    });
    await notifyRedirectCompletion({
      kind: "error",
      turnContextId: "k",
      humanTurnId: "turn-1",
      sourceAgentId: "agent-genie",
    });
    await notifyRedirectCompletion({
      kind: "aborted",
      turnContextId: "k",
      humanTurnId: "turn-1",
      sourceAgentId: "agent-genie",
    });
    expect(seen.map((n) => n.kind)).toEqual(["error", "aborted"]);
    expect(seen.every((n) => n.request === undefined)).toBe(true);
  });
});

describe("redirect target depth ingress ordering", () => {
  test("executor seeds depth before graph/model/tool execution begins", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../src/executors/langgraph-executor.ts"),
      "utf8",
    );
    const seed = source.indexOf(
      'if (input["redirectDepth"] === 1 && turnContextId)',
    );
    const graphInput = source.indexOf("const graphInput", seed);
    const graphStream = source.indexOf("graph.streamEvents", seed);
    expect(seed).toBeGreaterThan(0);
    expect(seed).toBeLessThan(graphInput);
    expect(seed).toBeLessThan(graphStream);
  });
});

describe("per-agent stream timeout abort gate", () => {
  test("visible output aborts only the matching agent slot", () => {
    const humanTurnId = "turn-shared";
    const agentA = turnContextKey(humanTurnId, "agent-a");
    const agentB = turnContextKey(humanTurnId, "agent-b");
    expect(shouldGraphAbortOnStreamTimeoutByKey(agentA)).toBe(false);
    expect(shouldGraphAbortOnStreamTimeoutByKey(agentB)).toBe(false);

    getOrCreateAgentTurnContextByKey(agentA).assistantVisibleOutput = true;
    expect(shouldGraphAbortOnStreamTimeoutByKey(agentA)).toBe(true);
    expect(shouldGraphAbortOnStreamTimeoutByKey(agentB)).toBe(false);
  });
});

