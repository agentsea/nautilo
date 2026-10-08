import { beforeAll, expect, mock, test } from "bun:test";
import { createWorkspaceGuard, type RelayDispatchRequest, type RelayWorkstationShellBinding } from "@nautilo/relay";
import type { Sandbox } from "@nautilo/sandbox";
import { RunShellOutputArtifactStore } from "../../electron/run-shell-output-continuity";
mock.module("electron", () => ({ app: { getPath: () => "/tmp/synthetic-desktop" } }));
let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
beforeAll(async () => { ({ makeDispatchHandler } = await import("../../electron/relay")); });
const owner = { instanceId: "instance-fixture", userId: "human-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture" };
const binding: RelayWorkstationShellBinding = { version: 2, toolCallId: "call-fixture", relayId: owner.relayId, desktopSessionId: owner.desktopSessionId,
  serverBindingId: "server-fixture", pairingGeneration: "pair-fixture", profileId: "profile-fixture", profileRevision: 1,
  grantIds: ["grant-fixture"], capabilityRevision: 1, currentFolder: "/tmp", grantRevision: 1, protectedPolicyVersion: 1,
  subject: { userId: owner.userId, instanceId: owner.instanceId, relayId: owner.relayId, agentScope: "all_owned_agents" }, operation: "execute", executionClass: "profile_bound_sandbox" };
const request = (toolName: string, args: Record<string, unknown>): RelayDispatchRequest => ({ correlationId: "request-fixture", toolName, args, impact: "read-only", approvalObtained: false });
test("retained output is read before filesystem, profile, or sandbox preparation", async () => {
  const store = new RunShellOutputArtifactStore();
  const draft = store.createDraft(owner); draft.append("stdout", Buffer.from("retained output"), 15); const reference = draft.commit().reference;
  const forbidden = async () => { throw new Error("Read must not prepare execution"); };
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
    runShellOutputArtifactStore: store, workstationShellBindingAuthority: forbidden, createSandbox: forbidden,
  });
  try {
    expect(await handler({ ...request("read_shell_output", { operation: "search", reference, query: "retained" }), runShellOwnerBinding: owner }))
      .toMatchObject({ status: "ok", result: { reference } });
    expect(await handler({ ...request("read_shell_output", { operation: "page", reference }), runShellOwnerBinding: { ...owner, userId: "foreign" } }))
      .toMatchObject({ status: "error", errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_NOT_FOUND" });
  } finally { store.clear(); }
});
test("composed typed Git dispatch revalidates execute authority and preserves broker outcome", async () => {
  let checkedOperation: string | undefined; let calls = 0; let closed = 0;
  const outcome = { operation: "status" as const, ok: true, reason: "ok" as const, sideEffectStarted: false, retrySafe: true, message: "clean" };
  const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: "/tmp" }), {
    relayId: owner.relayId, isProduction: false,
    workstationShellBindingAuthority: async input => { checkedOperation = input.concreteOperation; return { ok: true, roots: ["/tmp"], readOnlyRoots: [], writableRoots: ["/tmp"], grantIds: ["grant-fixture"], networkPolicy: { mode: "isolated", allow: [] } }; },
    getLocalWorkspacePath: () => "/tmp", localShellWorkspaceAuthority: async () => ({ ok: true, workspace: "/tmp" }),
    createGuardedShellScratch: () => "/tmp/synthetic-shell-scratch",
    createSandbox: async () => ({ containmentActive: () => true, protectedFileMaskSupported: () => true, close: async () => { closed++; } }) as unknown as Sandbox,
    createGitBroker: options => { expect(options.gitExecutable).toBe("/usr/bin/git"); expect(options.authority.repository).toBe("/tmp");
      const run = async () => { calls++; return outcome; }; return { status: run, diff: run, add: run, commit: run, worktreeAdd: run, worktreeRemove: run }; },
  });
  const result = await handler({ ...request("local_git", { operation: "status" }), workstationShellBinding: binding,
    sandboxProfile: { workspace: "/tmp", config: { enabled: true, platform: process.platform, allowedPaths: ["/tmp"], networkPolicy: { mode: "isolated", allow: [] } } } as RelayDispatchRequest["sandboxProfile"] });
  expect(result).toEqual({ status: "ok", result: outcome }); expect(checkedOperation).toBe("execute"); expect(calls).toBe(1); expect(closed).toBe(1);
});
