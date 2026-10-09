import { describe, expect, test } from "bun:test";
import { RELAY_WORKSTATION_SHELL_BINDING_VERSION, type RelayDispatchRequest, type RelayWorkstationShellBinding } from "@nautilo/relay";
import type { GitBrokerDisposition } from "@nautilo/sandbox";
import { createWorkstationHandlers, type CreateWorkstationHandlersInput, type LocalDispatchPolicyState,
  type RunShellGitBrokerFactory } from "../../electron/relay-dispatch/workstation";

const binding: RelayWorkstationShellBinding = {
  version: RELAY_WORKSTATION_SHELL_BINDING_VERSION, toolCallId: "call-fixture", relayId: "relay-fixture", desktopSessionId: "desktop-fixture",
  serverBindingId: "server-fixture", pairingGeneration: "pairing-fixture", profileId: "profile-fixture",
  profileRevision: 1, grantIds: ["grant-fixture"], capabilityRevision: 1,
  currentFolder: "/synthetic/repository", grantRevision: 1, protectedPolicyVersion: 1,
  subject: { userId: "human-fixture", instanceId: "instance-fixture", relayId: "relay-fixture", agentScope: "all_owned_agents" },
  operation: "execute", executionClass: "profile_bound_sandbox",
};
function fixture(authenticated = false) {
  const calls: { operation: string; args: unknown[] }[] = [];
  const factories: Parameters<RunShellGitBrokerFactory>[0][] = [];
  const disposition: GitBrokerDisposition = { operation: "commit", ok: false, reason: "exec-unknown-outcome",
    sideEffectStarted: true, retrySafe: false, message: "Mutation outcome unconfirmed", stderr: "diagnostic" };
  const record = (operation: string, ...args: unknown[]) => { calls.push({ operation, args }); return Promise.resolve(disposition); };
  const handlers = createWorkstationHandlers({
    createGitBroker: (options) => { factories.push(options); return Object.assign({
      status: () => record("status"), diff: (ref) => record("diff", ref), add: (paths) => record("add", paths),
      commit: (message) => record("commit", message), worktreeAdd: (target, ref) => record("worktree-add", target, ref),
      worktreeRemove: (target) => record("worktree-remove", target),
    }, authenticated ? {
      fetch: async () => ({ operation: "fetch" as const, ok: true, reason: "ok" as const, sideEffectStarted: true, retrySafe: false }),
      preparePush: async () => null,
      push: async () => ({ operation: "push" as const, ok: true, reason: "ok" as const, sideEffectStarted: true, retrySafe: false }),
      clone: async () => ({ operation: "clone" as const, ok: true, reason: "ok" as const, sideEffectStarted: true, retrySafe: false }),
      pull: async () => ({ operation: "pull" as const, ok: true, reason: "ok" as const, sideEffectStarted: true, retrySafe: false }),
    } : {}); },
    selectSandboxProtectedPaths: () => [],
  } satisfies CreateWorkstationHandlersInput);
  const policy: LocalDispatchPolicyState = { revalidatedShellBinding: binding,
    desktopFilesystemAuthority: { roots: ["/synthetic/repository"], writableRoots: ["/synthetic/granted"] },
    locallyAuthorizedWorkspace: undefined, sandboxEnvelopeWorkspace: undefined, shellNetworkPolicy: { mode: "host" } };
  const request = (args: Record<string, unknown>, overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest => ({
    correlationId: "correlation-fixture", toolName: "local_git", args,
    impact: "destructive", approvalObtained: true, workstationShellBinding: binding, ...overrides,
  });
  return { handlers, policy, request, calls, factories, disposition };
}

describe("dedicated local Git dispatch", () => {
  test("routes all six operations without a shell, credentials or request-name substitution", async () => {
    const f = fixture();
    const operations = [ { operation: "status" }, { operation: "diff", ref: "HEAD" },
      { operation: "add", paths: ["src/example.ts"] }, { operation: "commit", message: "Update example" },
      { operation: "worktree-add", target: "/synthetic/granted/worktree", ref: "HEAD" },
      { operation: "worktree-remove", target: "/synthetic/granted/worktree" } ];
    for (const args of operations) {
      const request = f.request(args);
      const before = JSON.stringify(request);
      expect(await f.handlers.dispatchLocalGit({ request, policy: f.policy })).toEqual({ handled: true,
        result: { status: "ok", result: f.disposition } });
      expect(JSON.stringify(request)).toBe(before);
      expect(request.toolName).toBe("local_git");
    }
    expect(f.calls).toEqual([
      { operation: "status", args: [] }, { operation: "diff", args: ["HEAD"] },
      { operation: "add", args: [["src/example.ts"]] }, { operation: "commit", args: ["Update example"] },
      { operation: "worktree-add", args: ["/synthetic/granted/worktree", "HEAD"] },
      { operation: "worktree-remove", args: ["/synthetic/granted/worktree"] },
    ]);
    expect(f.factories).toEqual([{ authority: { repository: binding.currentFolder,
      grantedRoots: ["/synthetic/granted"] }, gitExecutable: "/usr/bin/git" }]);
  });
  test("rejects malformed, network and shell variants before constructing a broker", async () => {
    const f = fixture();
    for (const args of [{ operation: "push" }, { operation: "status", command: "git status" },
      { operation: "status", execution: "workstation" }, { git: { operation: "status" } },
      { operation: "add", paths: [":(top)*"] }]) {
      expect(await f.handlers.dispatchLocalGit({ request: f.request(args), policy: f.policy })).toMatchObject({
        handled: true, result: { status: "error", errorCode: "LOCAL_GIT_INVALID" } });
    }
    expect(f.factories).toHaveLength(0);
  });
  test("requires locally revalidated binding, filesystem authority and writable grants", async () => {
    const f = fixture();
    for (const policy of [{ ...f.policy, revalidatedShellBinding: undefined },
      { ...f.policy, desktopFilesystemAuthority: undefined }]) {
      expect(await f.handlers.dispatchLocalGit({ request: f.request({ operation: "status" }), policy })).toMatchObject({
        result: { status: "error", errorCode: "LOCAL_GIT_REQUIRES_BINDING" } });
    }
    expect(await f.handlers.dispatchLocalGit({ request: f.request({ operation: "status" }),
      policy: { ...f.policy, desktopFilesystemAuthority: { roots: ["/synthetic/repository"] } } })).toMatchObject({
      result: { status: "error", errorCode: "LOCAL_GIT_NO_WRITABLE_GRANT" } });
    expect(f.factories).toHaveLength(0);
  });
  test("mutations including worktree removal retain explicit approval", async () => {
    const f = fixture();
    for (const args of [{ operation: "add", paths: ["src/example.ts"] }, { operation: "commit", message: "Update" },
      { operation: "worktree-add", target: "/synthetic/granted/worktree", ref: "HEAD" },
      { operation: "worktree-remove", target: "/synthetic/granted/worktree" }]) {
      expect(await f.handlers.dispatchLocalGit({ request: f.request(args, { approvalObtained: false }), policy: f.policy })).toMatchObject({
        result: { status: "error", errorCode: "LOCAL_GIT_APPROVAL_REQUIRED" } });
    }
    expect(f.factories).toHaveLength(0);
    await f.handlers.dispatchLocalGit({ request: f.request({ operation: "status" }, { approvalObtained: false }), policy: f.policy });
    expect(f.calls).toEqual([{ operation: "status", args: [] }]);
  });
  test("broker caches remain separated by exact binding revisions and Human", async () => {
    const f = fixture();
    for (const changes of [{ profileRevision: 2 }, { grantRevision: 2 },
      { subject: { ...binding.subject, userId: "other-human-fixture" } }, { currentFolder: "/synthetic/other-repository" }]) {
      const revalidatedShellBinding = { ...binding, ...changes };
      await f.handlers.dispatchLocalGit({ request: f.request({ operation: "status" }, { workstationShellBinding: revalidatedShellBinding }),
        policy: { ...f.policy, revalidatedShellBinding } });
    }
    expect(f.factories).toHaveLength(4);
  });
  test("authenticated Git resolves only through the exact revalidated project broker", async () => {
    const localOnly = fixture();
    const authenticated = fixture(true);
    const networkRequest = authenticated.request({ operation: "fetch", repository: "fixture/project", branch: "main" },
      { githubBinding: {} as RelayDispatchRequest["githubBinding"] });
    expect(await localOnly.handlers.resolveAuthenticatedGitBroker({ request: networkRequest, policy: localOnly.policy })).toBeNull();
    const broker = await authenticated.handlers.resolveAuthenticatedGitBroker({ request: networkRequest, policy: authenticated.policy });
    expect(broker).not.toBeNull();
    expect(authenticated.factories).toHaveLength(1);
    expect(await authenticated.handlers.resolveAuthenticatedGitBroker({ request: { ...networkRequest, githubBinding: undefined },
      policy: authenticated.policy })).toBeNull();
    expect(await authenticated.handlers.resolveAuthenticatedGitBroker({ request: networkRequest,
      policy: { ...authenticated.policy, revalidatedShellBinding: undefined } })).toBeNull();
  });
  test("refuses other tool names instead of retaining a legacy shell route", async () => {
    const f = fixture();
    const request = f.request({ git: { operation: "status" } }, { toolName: "run_shell" });
    expect(await f.handlers.dispatchLocalGit({ request, policy: f.policy })).toEqual({ handled: false });
    expect(f.calls).toEqual([]);
  });
  test("restricted or missing profile networking cannot construct an authenticated Git broker", async () => {
    const f = fixture(true);
    const request = f.request({ operation: "fetch", repository: "fixture/project", branch: "main" },
      { githubBinding: {} as RelayDispatchRequest["githubBinding"] });
    for (const shellNetworkPolicy of [undefined, { mode: "isolated" as const },
      { mode: "proxy-allowlist" as const, allow: [{ type: "domain" as const, host: "github.com" }] }]) {
      expect(await f.handlers.resolveAuthenticatedGitBroker({ request,
        policy: { ...f.policy, shellNetworkPolicy } })).toBeNull();
    }
    expect(f.factories).toHaveLength(0);
    // Offline typed operations still use their existing project authority.
    await f.handlers.dispatchLocalGit({ request: f.request({ operation: "status" }),
      policy: { ...f.policy, shellNetworkPolicy: { mode: "isolated" } } });
    expect(f.calls).toEqual([{ operation: "status", args: [] }]);
  });
});
