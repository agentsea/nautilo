import { expect, test } from "bun:test";
import { isRelayTaskProjectFileDispatch, projectRelayCapabilitiesForProtocol, RELAY_TASK_PROJECT_FILE_PROTOCOL_VERSION,
  type RelayLocalExecutionBindingV4, type RelayDispatchRequest, type RelayCapabilities } from "../../src/index";
const binding: RelayLocalExecutionBindingV4 = {
  version: 4, generation: "generation", invocationId: "call", executionId: "execution", operation: "read",
  owner: { instanceId: "", humanUserId: "human", agentId: "agent", runId: "10000000-0000-4000-8000-000000000001", conversationId: "task-thread",
    relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "wire-pairing", serverBindingId: "server",
    profileId: null, profileRevision: null, grantIds: ["project-grant"], grantRevision: null, protectedPolicyVersion: 1 },
  authority: { kind: "delegated", taskId: "task", taskRunId: "10000000-0000-4000-8000-000000000001", roomId: "task-room", delegation: {
    version: 1, humanUserId: "human", agentId: "agent", sourceRoomId: "source-room", sourceConversationId: "source-thread",
    rootTaskId: "task", projectGrantId: "project-grant", ceiling: "basic", profile: null,
    target: { instanceId: "", relayId: "relay", pairingGeneration: "raw-pairing", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" },
  } },
};

const capabilities: RelayCapabilities = { profile: "desktop-agent", localFileExecution: true,
  canDelegateLocalExecution: true, canUseTaskProjectFiles: true,
  localExecution: { version: 1, generation: "generation", pipe: true, pty: true, localNetworkPolicy: true, capacity: 1 } };
const root = `/project/nautilo-repo-docs/task-run-${binding.authority.taskRunId}`;
const request: RelayDispatchRequest = { correlationId: "file-fixture", impact: "read-only", approvalObtained: false, toolName: "local-file", executionClass: "local-file",
  args: { operation: { kind: "file", command: "read", zone: "current", args: { path: "wiki/index.md" } }, allowedRoots: [root] },
  localExecutionBinding: binding };
function allowed(candidate: RelayDispatchRequest = request, extra: Partial<Parameters<typeof isRelayTaskProjectFileDispatch>[0]> = {}) {
  return isRelayTaskProjectFileDispatch({ request: candidate, capabilities, protocolVersion: RELAY_TASK_PROJECT_FILE_PROTOCOL_VERSION,
    userId: "human", relayId: "relay", desktopSessionId: "desktop", pairingGeneration: "wire-pairing", instanceId: "", ...extra });
}
test("Task project files require exact current V4 owner, generation and negotiated capability", () => {
  expect(allowed()).toBe(true);
  for (const extra of [ { userId: "other" }, { relayId: "other" }, { desktopSessionId: "other" },
    { pairingGeneration: "other" }, { instanceId: "other" }, { protocolVersion: RELAY_TASK_PROJECT_FILE_PROTOCOL_VERSION - 1 },
    { capabilities: { ...capabilities, profile: "device-relay" as const } },
    { capabilities: { ...capabilities, canUseTaskProjectFiles: false } },
    { capabilities: { ...capabilities, localFileExecution: false } },
    { capabilities: { ...capabilities, canDelegateLocalExecution: false } },
    { capabilities: { ...capabilities, localExecution: { ...capabilities.localExecution!, generation: "other" } } } ]) {
    expect(allowed(request, extra)).toBe(false);
  }
});
test("Task file calls never borrow ordinary command or other authority envelopes", () => {
  for (const candidate of [ { ...request, toolName: "exec_command" }, { ...request, executionClass: "desktop" as const },
    ...["start", "cancel"].map(operation => ({ ...request, localExecutionBinding: { ...binding, operation } })),
    ...["hostedBy", "desktopFilesystemGrantRequest", "localExecutionHistoryBinding", "workstationShellBinding",
      "githubBinding", "humanTerminalBinding", "sshBinding", "desktopAutomationBinding", "computerUseRequest",
      "localExecutionDelegationCapture", "sandboxProfile"].map(key => ({ ...request, [key]: {} })),
    { ...request, uncontainedHostCommandsSession: true } ]) {
    expect(allowed(candidate as RelayDispatchRequest)).toBe(false);
  }
});
test("only one canonical occurrence child and closed local file arguments are admitted", () => {
  for (const args of [ { ...request.args, allowedRoots: ["/project"] }, { ...request.args, allowedRoots: [root, root] },
    { ...request.args, allowedRoots: [root + "/../escape"] }, { ...request.args, allowedRoots: ["relative/" + root] },
    { ...request.args, allowedRoots: [root.replace(binding.authority.taskRunId, "other-run")] },
    { ...request.args, extra: true }, { ...request.args, operation: { kind: "shell" } } ]) {
    expect(allowed({ ...request, args })).toBe(false);
  }
  for (const kind of ["file", "history", "search"]) expect(allowed({ ...request, args: { ...request.args, operation: { kind } } })).toBe(true);
});
test("Task project roots use the remote Windows path syntax on every server", () => {
  for (const project of ["C:\\project", "\\\\desktop\\share\\project"]) {
    const windowsRoot = `${project}\\nautilo-repo-docs\\task-run-${binding.authority.taskRunId}`;
    expect(allowed({ ...request, args: { ...request.args, allowedRoots: [windowsRoot] } })).toBe(true);
    for (const invalid of [windowsRoot + "\\..\\escape", windowsRoot + "\\", windowsRoot.replace(binding.authority.taskRunId, "other-run")]) {
      expect(allowed({ ...request, args: { ...request.args, allowedRoots: [invalid] } })).toBe(false);
    }
  }
});
test("capability projection keeps ordinary file support but withholds new Task support from older peers", () => {
  const old = projectRelayCapabilitiesForProtocol(capabilities, RELAY_TASK_PROJECT_FILE_PROTOCOL_VERSION - 1);
  expect(old.canUseTaskProjectFiles).toBeUndefined();
  expect(old.localFileExecution).toBe(true);
  expect(old.canDelegateLocalExecution).toBe(true);
  expect(projectRelayCapabilitiesForProtocol(capabilities, RELAY_TASK_PROJECT_FILE_PROTOCOL_VERSION).canUseTaskProjectFiles).toBe(true);
});
