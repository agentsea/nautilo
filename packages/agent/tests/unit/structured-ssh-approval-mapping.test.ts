import { describe, expect, test } from "bun:test";
import { interruptValueToServerEvent } from "../../src/graph/interrupt-mapping";

const structuredSsh = {
  version: "structured-ssh-v1" as const,
  toolCallId: "tool-call-1",
  approvedRequestDigest: "a".repeat(64),
  preparationId: "ssh-preparation-1",
  operation: "exec" as const,
  host: "build.example.test",
  port: 22,
  remoteUser: "deploy",
  hostKeyFingerprint: "SHA256:host-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  hostTrust: "trusted" as const,
  program: "printf",
  argv: ["hello"],
  timeoutSeconds: 300,
};

describe("structured SSH approval interrupt mapping", () => {
  test("keeps the dedicated exact-review DTO and forces once/deny", () => {
    const event = interruptValueToServerEvent({
      type: "approval_ask",
      approvalId: "ssh-prepare-approval:1",
      tools: [{
        name: "structured_ssh_exec",
        args: {
          destination: { host: "build.example.test", user: "deploy", port: 22 },
          program: "printf",
          argv: ["hello"],
        },
      }],
      allowedVerbs: ["once", "room", "always", "deny"],
      requiresExplicitReview: false,
      structuredSsh,
    }, "thread-1", "lane-1");
    expect(event).toMatchObject({
      type: "approval.ask",
      approvalId: "ssh-prepare-approval:1",
      allowedVerbs: ["once", "deny"],
      requiresExplicitReview: true,
      structuredSsh,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("grantRef");
    expect(serialized).not.toContain("identityPath");
    expect(serialized).not.toContain("sshOptions");
  });

  test("fails closed instead of dropping a malformed or smuggled SSH review", () => {
    expect(interruptValueToServerEvent({
      type: "approval_ask",
      tools: [],
      structuredSsh: { ...structuredSsh, localHandle: "/private/key" },
    }, "thread-1", "lane-1")).toBeNull();
  });

  test("accepts only bounded timeout facts carried by the exact review DTO", () => {
    expect(interruptValueToServerEvent({
      type: "approval_ask",
      tools: [],
      structuredSsh: {
        ...structuredSsh,
        timeoutSeconds: 3_600,
        timeoutReason: "A bounded maintenance operation needs a longer foreground budget.",
      },
    }, "thread-1", "lane-1")?.type).toBe("approval.ask");

    for (const malformed of [
      { ...structuredSsh, timeoutSeconds: 0 },
      { ...structuredSsh, timeoutSeconds: 3_600 },
      { ...structuredSsh, timeoutSeconds: 300, timeoutReason: "not allowed here" },
      { ...structuredSsh, timeoutSeconds: 3_600, timeoutReason: "line one\nline two" },
    ]) {
      expect(interruptValueToServerEvent({
        type: "approval_ask",
        tools: [],
        structuredSsh: malformed,
      }, "thread-1", "lane-1")).toBeNull();
    }
  });
});
