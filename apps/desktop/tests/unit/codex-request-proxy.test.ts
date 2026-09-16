import { describe, expect, test } from "bun:test";
import {
  dispatchCodexHumanServerRequest,
  projectCodexHumanRequest,
  resolveCodexHumanRequest,
} from "../../electron/codex-request-proxy";

const EXPIRY = "2026-07-29T00:00:30.000Z";

describe("Codex human request proxy", () => {
  test("projects commands without leaking command or cwd and preserves only offered base decisions", () => {
    expect(projectCodexHumanRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item",
        command: "bun test --cwd /private", cwd: "/private",
        reason: "Run tests under /private", availableDecisions: [
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["bun", "test"] } },
          "decline",
        ],
      },
      EXPIRY,
    )).toEqual({
      threadId: "thread", turnId: "turn", itemId: "item",
      request: {
        kind: "command_approval",
        reason: "host_local_only",
        command: { detail: "host_local_only", actionKinds: [] },
        choices: ["decline"],
        expiresAt: EXPIRY,
      },
    });

    expect(projectCodexHumanRequest(
      "execCommandApproval",
      {
        conversationId: "thread", callId: "call", approvalId: null,
        command: ["git", "status"], cwd: "/private", reason: null,
      },
      EXPIRY,
    )).toMatchObject({
      threadId: "thread", turnId: null, itemId: "call",
      request: {
        kind: "command_approval",
        command: { detail: "host_local_only" },
      },
    });
  });

  test("projects managed network approval with host/protocol instead of command text", () => {
    expect(projectCodexHumanRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item",
        command: "curl https://api.example.test/private", cwd: "/private",
        reason: "network access", networkApprovalContext: { host: "api.example.test", protocol: "https" },
        availableDecisions: ["accept", "decline"],
      },
      EXPIRY,
    )).toMatchObject({
      request: {
        kind: "network_approval",
        network: { host: "api.example.test", protocol: "https" },
        choices: ["accept", "decline"],
      },
    });
  });

  test("projects structured permission counts and never invents command-style permission choices", () => {
    expect(projectCodexHumanRequest(
      "item/permissions/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item",
        environmentId: null, cwd: "/private", reason: "need files",
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ["/read"], write: ["/write-a", "/write-b"] },
        },
      },
      EXPIRY,
    )).toEqual({
      threadId: "thread", turnId: "turn", itemId: "item",
      request: {
        kind: "permissions_approval",
        reason: "host_local_only",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            readPathCount: 1,
            writePathCount: 2,
            entryCount: 0,
            pathDetail: "host_local_only",
          },
        },
        expiresAt: EXPIRY,
      },
    });
  });

  test("maps opaque user-input option IDs back to exact upstream labels", () => {
    const params = {
      threadId: "thread", turnId: "turn", itemId: "item",
      questions: [{
        id: "target", header: "Target", question: "Which target?",
        isOther: true, isSecret: false,
        options: [
          { label: "Tests", description: "Run tests." },
          { label: "Tests", description: "A duplicate label." },
        ],
      }],
    } as const;
    const projected = projectCodexHumanRequest("item/tool/requestUserInput", params, EXPIRY);
    expect(projected).toMatchObject({
      request: {
        kind: "user_input",
        autoResolutionMs: null,
        questions: [{
          id: "target",
          options: [
            { id: "option:0", label: "Tests" },
            { id: "option:1", label: "Tests" },
          ],
        }],
      },
    });
    expect(resolveCodexHumanRequest(
      "item/tool/requestUserInput",
      params,
      {
        kind: "user_input",
        answers: {
          target: { answers: ["option:1", "manual target"] },
        },
      },
    )).toEqual({ answers: { target: { answers: ["Tests", "manual target"] } } });
  });

  test("maps permission subsets only to requested capabilities and keeps scope exact", () => {
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: ["/read"], write: ["/write"] },
    };
    expect(resolveCodexHumanRequest(
      "item/permissions/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item",
        environmentId: null, cwd: "/private", reason: null, permissions,
      },
      { kind: "permissions_approval", grants: { network: false, fileSystem: true }, scope: "session" },
    )).toEqual({ permissions: { fileSystem: permissions.fileSystem }, scope: "session" });
    expect(resolveCodexHumanRequest(
      "item/permissions/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item",
        environmentId: null, cwd: "/private", reason: null, permissions,
      },
      { kind: "permissions_approval", grants: { network: false, fileSystem: false }, scope: "turn" },
    )).toEqual({ permissions: {}, scope: "turn" });
  });

  test("rejects unsupported amendment-only decisions and wrong semantic response kinds", () => {
    expect(() => projectCodexHumanRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item",
        availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["bun"] } }],
      },
      EXPIRY,
    )).toThrow("unsupported policy-amendment");
    expect(() => resolveCodexHumanRequest(
      "item/tool/requestUserInput",
      { threadId: "thread", turnId: "turn", itemId: "item", questions: [] },
      { kind: "command_approval", decision: "decline" },
    )).toThrow("response kind mismatch");
  });

  test("adapts native human requests once and rejects unsupported tool calls", async () => {
    await expect(dispatchCodexHumanServerRequest(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread", turnId: "turn", itemId: "item",
        command: "private command", cwd: "/private", reason: null,
        availableDecisions: ["accept", "decline"],
      },
      { signal: new AbortController().signal, requestId: "request", expiresAt: EXPIRY },
      async (request) => {
        expect(request.projected).toMatchObject({
          request: { kind: "command_approval", command: { detail: "host_local_only" } },
        });
        return { kind: "command_approval", decision: "decline" };
      },
    )).resolves.toEqual({ decision: "decline" });

    await expect(dispatchCodexHumanServerRequest(
      "item/tool/call",
      { threadId: "thread", turnId: "turn", callId: "call", namespace: null, tool: "tool", arguments: {} },
      { signal: new AbortController().signal, requestId: "request", expiresAt: EXPIRY },
      async () => ({ kind: "command_approval", decision: "decline" }),
    )).rejects.toThrow("Unsupported Codex server request");
  });
});
