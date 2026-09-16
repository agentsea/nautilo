/**
 * D440 Phase 3 — desktop relay integration of the structured `run_shell` git
 * variant with the typed GitBroker.
 *
 * Validates the authority flow and disposition return path through
 * `makeDispatchHandler` WITHOUT spawning a real Git subprocess: a fake
 * broker is injected via the `createGitBroker` test seam, so these tests
 * run on any host. The broker's own preflight/exec behavior is covered by
 * `packages/sandbox/tests/integration/git-broker.integration.test.ts`.
 *
 * Authority flow pinned here:
 *   - exactly one of `command` / `git` (both ⇒ RUN_SHELL_AMBIGUOUS_MODE);
 *   - strict parse of the `git` variant at the JSON ingress boundary
 *     (unknown op / pathspec magic / extra keys ⇒ RUN_SHELL_GIT_INVALID);
 *   - the broker is reached ONLY after a v2 binding revalidated AND at least
 *     one locally revalidated writable grant exists
 *     (else RUN_SHELL_GIT_REQUIRES_BINDING / RUN_SHELL_GIT_NO_WRITABLE_GRANT);
 *   - mutating ops never execute before approval
 *     (RUN_SHELL_GIT_APPROVAL_REQUIRED);
 *   - the broker is constructed with repository = binding.currentFolder and
 *     grantedRoots = the locally revalidated writable roots, fixed
 *     `/usr/bin/git`;
 *   - the typed disposition is returned as the tool result (ok and not-ok),
 *     preserving sideEffectStarted / retrySafe so the caller never retries
 *     an unknown outcome.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox, canonicalize } from "@nautilo/sandbox";
import {
  createWorkspaceGuard,
  RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  type RelayDispatchRequest,
  type RelayWorkstationShellBinding,
  type RelayWorkstationProfileSnapshot,
} from "@nautilo/relay";
import { buildProtectedPathPolicy } from "@nautilo/security";
import type {
  DesktopFilesystemAccessOperation,
  DesktopFilesystemGrant,
} from "@nautilo/desktop-filesystem-grants";
import type {
  DesktopFilesystemGrantAuthorityStore,
  RelayWorkstationProfileSnapshotProvider,
} from "../../electron/relay";
import type {
  RunShellGitBroker,
  RunShellGitBrokerFactory,
} from "../../electron/relay-dispatch/workstation";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-test-userdata" },
}));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
let createWorkstationShellBindingAuthorityResolver: typeof import("../../electron/relay").createWorkstationShellBindingAuthorityResolver;
let createLocalShellWorkspaceAuthorityResolver: typeof import("../../electron/relay").createLocalShellWorkspaceAuthorityResolver;

beforeAll(async () => {
  ({
    makeDispatchHandler,
    createWorkstationShellBindingAuthorityResolver,
    createLocalShellWorkspaceAuthorityResolver,
  } = await import("../../electron/relay"));
});

const RELAY = "relay-desktop";
const DESKTOP = "desktop-1";
const INSTANCE = "instance-1";
const USER = "user-a";
const PROFILE = "profile-A";
const AGENT_SCOPE = "all_owned_agents";
const NOW = new Date("2026-07-12T12:00:00.000Z");
const CURRENT_FOLDER = "/Users/test/project";

function grant(
  id: string,
  overrides: Partial<DesktopFilesystemGrant> & {
    root?: string;
    access?: readonly DesktopFilesystemAccessOperation[];
    status?: "active" | "revoked" | "expired";
  } = {},
): { grant: DesktopFilesystemGrant; status: "active" | "revoked" | "expired" } {
  const {
    root = "/Users/test/profile-root",
    access = ["execute", "read", "create_modify"] as readonly DesktopFilesystemAccessOperation[],
    status = "active",
    ...rest
  } = overrides;
  return {
    grant: {
      schemaVersion: 1,
      id,
      canonicalRoot: root,
      access,
      origin: "policy_pack",
      lifetime: "session",
      subject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      createdBy: USER,
      createdAt: "2026-07-12T11:00:00.000Z",
      policyVersion: 1,
      ...rest,
    },
    status,
  };
}

function binding(overrides: Partial<RelayWorkstationShellBinding> = {}): RelayWorkstationShellBinding {
  return {
    version: RELAY_WORKSTATION_SHELL_BINDING_VERSION,
    toolCallId: "tc-run_shell",
    relayId: RELAY,
    desktopSessionId: DESKTOP,
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-gen-1",
    profileId: PROFILE,
    profileRevision: 2,
    grantIds: ["grant-1"],
    capabilityRevision: 5,
    currentFolder: CURRENT_FOLDER,
    grantRevision: 7,
    protectedPolicyVersion: 1,
    subject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
    operation: "execute",
    executionClass: RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
    ...overrides,
  };
}

function profileSnapshot(rev = 2): RelayWorkstationProfileSnapshot {
  return {
    profileId: PROFILE,
    profileRevision: rev,
    grantIds: ["grant-1"],
    protectedPolicyVersion: 1,
    networkMode: "isolated",
    capabilities: [],
  };
}

function makeStore(
  grants: Array<{ grant: DesktopFilesystemGrant; status: "active" | "revoked" | "expired" }>,
): DesktopFilesystemGrantAuthorityStore {
  return {
    async list() {
      return { ok: true, data: { grants, revision: 7 } };
    },
  };
}

function makeProfileProvider(snapshot: RelayWorkstationProfileSnapshot | undefined): RelayWorkstationProfileSnapshotProvider {
  return { getProfileSnapshot: () => Promise.resolve(snapshot) };
}

function makeNetworkPolicyProvider(
  policy: import("@nautilo/workstation-profiles").ProfileNetworkPolicy | null | undefined,
): import("../../electron/relay").RelayWorkstationProfileNetworkPolicyProvider {
  return { getActiveNetworkPolicy: () => Promise.resolve(policy) };
}

const ISOLATED_NETWORK_POLICY: import("@nautilo/workstation-profiles").ProfileNetworkPolicy = {
  mode: "isolated",
  allow: [],
};

function makeSandbox(workspace: string): Sandbox {
  return {
    containmentActive: () => true,
    protectedFileMaskSupported: () => true,
    wrap: (program: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>) =>
      ({ program, args: [...args], cwd, env }),
    close: () => Promise.resolve(),
  } as unknown as Sandbox;
}

function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
}

function resolver(options: {
  grants: Array<{ grant: DesktopFilesystemGrant; status: "active" | "revoked" | "expired" }>;
  profile?: RelayWorkstationProfileSnapshot | undefined;
  capabilityRevision?: number;
  currentFolder?: string;
}) {
  return createWorkstationShellBindingAuthorityResolver({
    store: makeStore(options.grants),
    expectedRelayId: RELAY,
    expectedDesktopSessionId: DESKTOP,
    getCapabilityRevision: () => options.capabilityRevision ?? 5,
    getCurrentFolder: () => options.currentFolder ?? CURRENT_FOLDER,
    profileProvider: makeProfileProvider(options.profile ?? profileSnapshot(2)),
    networkPolicyProvider: makeNetworkPolicyProvider(ISOLATED_NETWORK_POLICY),
    expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
    now: () => NOW,
  });
}

function mkRequest(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    id: "test-req-1",
    correlationId: "test-req-1",
    toolName: "run_shell",
    args: { git: { operation: "status" } },
    impact: "low",
    approvalObtained: true,
    sandboxProfile: {
      workspace: CURRENT_FOLDER,
      dataDir: "/tmp/data",
      toolsBin: "/tmp/tools",
      mode: "desktop-permissive",
      securityLevel: "standard",
      failIfNoBackend: false,
      config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
    },
    ...overrides,
  } as RelayDispatchRequest;
}

type Captured = {
  factoryArgs: { authority: { repository: string; grantedRoots: readonly string[] }; gitExecutable: string } | undefined;
  called: string | undefined;
  callArgs: readonly unknown[] | undefined;
  disposition: import("@nautilo/sandbox").GitBrokerDisposition;
};

function fakeBrokerFactory(captured: Captured): RunShellGitBrokerFactory {
  return (opts) => {
    captured.factoryArgs = opts;
    const broker: RunShellGitBroker = {
      status: () => { captured.called = "status"; captured.callArgs = []; return Promise.resolve(captured.disposition); },
      diff: (ref) => { captured.called = "diff"; captured.callArgs = [ref]; return Promise.resolve(captured.disposition); },
      add: (paths) => { captured.called = "add"; captured.callArgs = [...paths]; return Promise.resolve(captured.disposition); },
      commit: (message) => { captured.called = "commit"; captured.callArgs = [message]; return Promise.resolve(captured.disposition); },
      worktreeAdd: (target, ref) => { captured.called = "worktreeAdd"; captured.callArgs = [target, ref]; return Promise.resolve(captured.disposition); },
      worktreeRemove: (target) => { captured.called = "worktreeRemove"; captured.callArgs = [target]; return Promise.resolve(captured.disposition); },
    };
    return broker;
  };
}

describe("D440 Phase 3 — run_shell git variant authority flow", () => {
  const savedLdPreload = process.env["LD_PRELOAD"];
  beforeEach(() => { delete process.env["LD_PRELOAD"]; });
  afterEach(() => {
    if (savedLdPreload === undefined) delete process.env["LD_PRELOAD"];
    else process.env["LD_PRELOAD"] = savedLdPreload;
  });

  test("Current Folder baseline reaches structured status and approved commit without a durable project grant", async () => {
    const currentFolder = mkTmp("d498-git-current-folder-");
    const profileRoot = mkTmp("d498-git-profile-root-");
    const grants = [grant("grant-1", { root: profileRoot, access: ["execute", "read"] })];
    const localAuthority = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore(grants),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("d498-git-home-"),
        platform: process.platform,
      }),
    });
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d498-git-guard-") });
    const captured: Captured = {
      factoryArgs: undefined,
      called: undefined,
      callArgs: undefined,
      disposition: { operation: "status", ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message: "status ok" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants, currentFolder }),
      getLocalWorkspacePath: () => currentFolder,
      localShellWorkspaceAuthority: localAuthority,
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });

    const status = await handler(mkRequest({
      sandboxProfile: { ...mkRequest().sandboxProfile!, workspace: currentFolder },
      workstationShellBinding: binding({ currentFolder }),
    }));
    expect(status.status).toBe("ok");
    expect(captured.called).toBe("status");
    expect(captured.factoryArgs?.authority.repository).toBe(currentFolder);
    expect(captured.factoryArgs?.authority.grantedRoots).toEqual([currentFolder]);

    captured.disposition = { operation: "commit", ok: true, reason: "ok", sideEffectStarted: true, retrySafe: false, message: "committed" };
    const commit = await handler(mkRequest({
      args: { git: { operation: "commit", message: "D498 baseline" } },
      impact: "destructive",
      approvalObtained: true,
      sandboxProfile: { ...mkRequest().sandboxProfile!, workspace: currentFolder },
      workstationShellBinding: binding({ currentFolder, toolCallId: "tc-current-folder-commit" }),
    }));
    expect(commit.status).toBe("ok");
    expect(captured.called).toBe("commit");
    expect(captured.factoryArgs?.authority.grantedRoots).toEqual([currentFolder]);
  });

  test("Current Folder baseline does not authorize an outside worktree target without an additional writable grant", async () => {
    const currentFolder = mkTmp("d498-git-current-worktree-");
    const outsideTarget = mkTmp("d498-git-outside-worktree-");
    const profileRoot = mkTmp("d498-git-worktree-profile-");
    const grants = [grant("grant-1", { root: profileRoot, access: ["execute", "read"] })];
    const localAuthority = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore(grants),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("d498-git-worktree-home-"),
        platform: process.platform,
      }),
    });
    let grantedRoots: readonly string[] = [];
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: mkTmp("d498-git-worktree-guard-") }), {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants, currentFolder }),
      getLocalWorkspacePath: () => currentFolder,
      localShellWorkspaceAuthority: localAuthority,
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: (options) => {
        grantedRoots = options.authority.grantedRoots;
        return {
          status: () => Promise.reject(new Error("unexpected status")),
          diff: () => Promise.reject(new Error("unexpected diff")),
          add: () => Promise.reject(new Error("unexpected add")),
          commit: () => Promise.reject(new Error("unexpected commit")),
          worktreeAdd: (target) => Promise.resolve({
            operation: "worktree-add" as const,
            ok: options.authority.grantedRoots.includes(target),
            reason: options.authority.grantedRoots.includes(target) ? "ok" : "deny-target-outside-authority",
            sideEffectStarted: false,
            retrySafe: true,
            message: "test broker target authority check",
          }),
          worktreeRemove: () => Promise.reject(new Error("unexpected worktreeRemove")),
        };
      },
    });

    const result = await handler(mkRequest({
      args: { git: { operation: "worktree-add", target: outsideTarget, ref: "HEAD" } },
      impact: "destructive",
      approvalObtained: true,
      sandboxProfile: { ...mkRequest().sandboxProfile!, workspace: currentFolder },
      workstationShellBinding: binding({ currentFolder }),
    }));

    expect(grantedRoots).toEqual([currentFolder]);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect((result.result as import("@nautilo/sandbox").GitBrokerDisposition).reason)
        .toBe("deny-target-outside-authority");
    }
  });

  test("status routes to the broker with repository=currentFolder and grantedRoots=writable roots", async () => {
    const writeRoot = mkTmp("d440-git-writeroot-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-guard-") });
    const captured: Captured = {
      factoryArgs: undefined,
      called: undefined,
      callArgs: undefined,
      disposition: { operation: "status", ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message: "status ok", stdout: "M file\n" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));

    expect(r.status).toBe("ok");
    expect(captured.called).toBe("status");
    expect(captured.factoryArgs?.gitExecutable).toBe("/usr/bin/git");
    expect(captured.factoryArgs?.authority.repository).toBe(CURRENT_FOLDER);
    expect(captured.factoryArgs?.authority.grantedRoots).toEqual([writeRoot]);
    if (r.status === "ok") {
      const disp = r.result as import("@nautilo/sandbox").GitBrokerDisposition;
      expect(disp.ok).toBe(true);
      expect(disp.sideEffectStarted).toBe(false);
      expect(disp.retrySafe).toBe(true);
    }
  });

  test("diff forwards the optional ref to the broker", async () => {
    const writeRoot = mkTmp("d440-git-diff-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-diff-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "diff", ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message: "diff ok" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({
      args: { git: { operation: "diff", ref: "HEAD" } },
      workstationShellBinding: binding(),
    }));
    expect(r.status).toBe("ok");
    expect(captured.called).toBe("diff");
    expect(captured.callArgs).toEqual(["HEAD"]);
  });

  test("commit (mutating) with approval invokes the broker", async () => {
    const writeRoot = mkTmp("d440-git-commit-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-commit-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "commit", ok: true, reason: "ok", sideEffectStarted: true, retrySafe: false, message: "committed" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({
      args: { git: { operation: "commit", message: "broker commit" } },
      impact: "destructive",
      approvalObtained: true,
      workstationShellBinding: binding(),
    }));
    expect(r.status).toBe("ok");
    expect(captured.called).toBe("commit");
    expect(captured.callArgs).toEqual(["broker commit"]);
    if (r.status === "ok") {
      const disp = r.result as import("@nautilo/sandbox").GitBrokerDisposition;
      expect(disp.sideEffectStarted).toBe(true);
      expect(disp.retrySafe).toBe(false);
    }
  });

  test("add and commit reuse one broker for the exact authority tuple", async () => {
    const writeRoot = mkTmp("d440-git-transaction-");
    const grants = [
      grant("grant-1", {
        root: writeRoot,
        access: ["execute", "read", "create_modify"],
      }),
    ];
    const guard = createWorkspaceGuard({
      workspaceRoot: mkTmp("d440-git-transaction-guard-"),
    });
    let factoryCalls = 0;
    let staged = false;
    const factory: RunShellGitBrokerFactory = () => {
      factoryCalls += 1;
      return {
        status: () => Promise.reject(new Error("unexpected status")),
        diff: () => Promise.reject(new Error("unexpected diff")),
        add: () => {
          staged = true;
          return Promise.resolve({
            operation: "add",
            ok: true,
            reason: "ok",
            sideEffectStarted: false,
            retrySafe: true,
            message: "staged",
          });
        },
        commit: () =>
          Promise.resolve({
            operation: "commit",
            ok: staged,
            reason: staged ? "ok" : "deny-no-staging-transaction",
            sideEffectStarted: staged,
            retrySafe: !staged,
            message: staged ? "committed" : "missing staging transaction",
          }),
        worktreeAdd: () => Promise.reject(new Error("unexpected worktreeAdd")),
        worktreeRemove: () => Promise.reject(new Error("unexpected worktreeRemove")),
      };
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: factory,
    });

    const addResult = await handler(
      mkRequest({
        args: { git: { operation: "add", paths: ["d440-live.txt"] } },
        impact: "destructive",
        approvalObtained: true,
        workstationShellBinding: binding({ toolCallId: "tc-add" }),
      }),
    );
    const commitResult = await handler(
      mkRequest({
        correlationId: "test-req-commit",
        args: { git: { operation: "commit", message: "D440 live commit" } },
        impact: "destructive",
        approvalObtained: true,
        workstationShellBinding: binding({ toolCallId: "tc-commit" }),
      }),
    );

    expect(addResult.status).toBe("ok");
    expect(commitResult.status).toBe("ok");
    if (commitResult.status === "ok") {
      expect((commitResult.result as import("@nautilo/sandbox").GitBrokerDisposition).ok).toBe(true);
    }
    expect(factoryCalls).toBe(1);
  });

  test("mutating op without approval ⇒ RUN_SHELL_GIT_APPROVAL_REQUIRED, broker never constructed", async () => {
    const writeRoot = mkTmp("d440-git-noapproval-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-noapproval-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "commit", ok: true, reason: "ok", sideEffectStarted: true, retrySafe: false, message: "x" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({
      args: { git: { operation: "commit", message: "no approval" } },
      impact: "destructive",
      approvalObtained: false,
      workstationShellBinding: binding(),
    }));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.errorCode).toBe("RUN_SHELL_GIT_APPROVAL_REQUIRED");
    expect(captured.called).toBeUndefined();
    expect(captured.factoryArgs).toBeUndefined();
  });

  test("git variant without a revalidated binding ⇒ RUN_SHELL_GIT_REQUIRES_BINDING", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-nobinding-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "status", ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message: "x" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({ workstationShellBinding: undefined }));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.errorCode).toBe("RUN_SHELL_GIT_REQUIRES_BINDING");
    expect(captured.called).toBeUndefined();
  });

  test("binding with read-only grants only ⇒ RUN_SHELL_GIT_NO_WRITABLE_GRANT", async () => {
    const readRoot = mkTmp("d440-git-readonly-");
    const grants = [grant("grant-1", { root: readRoot, access: ["execute", "read"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-readonly-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "status", ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message: "x" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({ workstationShellBinding: binding() }));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.errorCode).toBe("RUN_SHELL_GIT_NO_WRITABLE_GRANT");
    expect(captured.called).toBeUndefined();
  });

  test("unknown git operation ⇒ RUN_SHELL_GIT_INVALID before the broker exists", async () => {
    const writeRoot = mkTmp("d440-git-invalid-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-invalid-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "status", ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message: "x" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({
      args: { git: { operation: "stash" } },
      workstationShellBinding: binding(),
    }));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.errorCode).toBe("RUN_SHELL_GIT_INVALID");
    expect(captured.called).toBeUndefined();
  });

  test("pathspec magic in add paths ⇒ RUN_SHELL_GIT_INVALID", async () => {
    const writeRoot = mkTmp("d440-git-magic-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-magic-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "add", ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message: "x" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({
      args: { git: { operation: "add", paths: [":(magic)file"] } },
      workstationShellBinding: binding(),
    }));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.errorCode).toBe("RUN_SHELL_GIT_INVALID");
    expect(captured.called).toBeUndefined();
  });

  test("both command and git ⇒ RUN_SHELL_AMBIGUOUS_MODE", async () => {
    const writeRoot = mkTmp("d440-git-ambig-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-ambig-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "status", ok: true, reason: "ok", sideEffectStarted: false, retrySafe: true, message: "x" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({
      args: { command: "git status", git: { operation: "status" } },
      workstationShellBinding: binding(),
    }));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.errorCode).toBe("RUN_SHELL_AMBIGUOUS_MODE");
    expect(captured.called).toBeUndefined();
  });

  test.each([
    ["number zero", 0],
    ["boolean false", false],
    ["bigint zero", 0n],
  ] as const)(
    "non-string command %s and git still conflict before broker construction",
    async (_label, command) => {
      const writeRoot = mkTmp("d440-git-nonstring-ambig-");
      const grants = [
        grant("grant-1", {
          root: writeRoot,
          access: ["execute", "read", "create_modify"],
        }),
      ];
      const captured: Captured = {
        factoryArgs: undefined,
        called: undefined,
        callArgs: undefined,
        disposition: {
          operation: "status",
          ok: true,
          reason: "ok",
          sideEffectStarted: false,
          retrySafe: true,
          message: "unexpected broker call",
        },
      };
      const handler = makeDispatchHandler(
        createWorkspaceGuard({
          workspaceRoot: mkTmp("d440-git-nonstring-ambig-guard-"),
        }),
        {
          relayId: RELAY,
          workstationShellBindingAuthority: resolver({ grants }),
          createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
          createGitBroker: fakeBrokerFactory(captured),
        },
      );

      const result = await handler(
        mkRequest({
          args: { command, git: { operation: "status" } },
          workstationShellBinding: binding(),
        }),
      );

      expect(result.status).toBe("error");
      if (result.status === "error")
        expect(result.errorCode).toBe("RUN_SHELL_AMBIGUOUS_MODE");
      expect(captured.called).toBeUndefined();
      expect(captured.factoryArgs).toBeUndefined();
    },
  );

  test("a not-ok non-retryable disposition is returned as the result so the caller does not retry", async () => {
    const writeRoot = mkTmp("d440-git-unknown-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-unknown-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: {
        operation: "commit",
        ok: false,
        reason: "exec-unknown-outcome",
        sideEffectStarted: true,
        retrySafe: false,
        message: "outcome unknown; do not retry",
        residualPaths: ["/tmp/tx"],
      },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
    });
    const r = await handler(mkRequest({
      args: { git: { operation: "commit", message: "unknown outcome" } },
      impact: "destructive",
      approvalObtained: true,
      workstationShellBinding: binding(),
    }));
    // The disposition is always returned as the tool result (status "ok"),
    // even when the broker disposition is not-ok, so the caller can branch
    // on sideEffectStarted/retrySafe and never retry an unknown outcome.
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const disp = r.result as import("@nautilo/sandbox").GitBrokerDisposition;
      expect(disp.ok).toBe(false);
      expect(disp.reason).toBe("exec-unknown-outcome");
      expect(disp.sideEffectStarted).toBe(true);
      expect(disp.retrySafe).toBe(false);
      expect(disp.residualPaths).toEqual(["/tmp/tx"]);
    }
  });

  test("worktree-add forwards target and ref to the broker", async () => {
    const writeRoot = mkTmp("d440-git-wtadd-");
    const target = mkTmp("d440-git-wtadd-target-");
    const grants = [grant("grant-1", { root: writeRoot, access: ["execute", "read", "create_modify"] })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("d440-git-wtadd-guard-") });
    const captured: Captured = {
      factoryArgs: undefined, called: undefined, callArgs: undefined,
      disposition: { operation: "worktree-add", ok: true, reason: "ok", sideEffectStarted: true, retrySafe: false, message: "wt added" },
    };
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (env) => Promise.resolve(makeSandbox(env.workspace)),
      createGitBroker: fakeBrokerFactory(captured),
      gitWritableGrantRootsProvider: () => Promise.resolve([target]),
    });
    const r = await handler(mkRequest({
      args: { git: { operation: "worktree-add", target, ref: "HEAD" } },
      impact: "destructive",
      approvalObtained: true,
      workstationShellBinding: binding(),
    }));
    expect(r.status).toBe("ok");
    expect(captured.called).toBe("worktreeAdd");
    expect(captured.callArgs).toEqual([target, "HEAD"]);
    expect(captured.factoryArgs?.authority.grantedRoots).toContain(target);
  });
});
