/**
 * D418 task 3.1.3b — desktop relay consumption + revalidation of the plan-bound
 * `RelayWorkstationShellBinding` for generic `run_shell` dispatches.
 *
 * Validates:
 *   1. Pure `revalidateWorkstationShellBinding`: success returns the
 *      profile-bound roots; stale/revoked/foreign/mismatched
 *      relay/profile/session/grant references fail closed with stable codes.
 *   2. `makeDispatchHandler`: a valid shell binding makes the run_shell cwd
 *      the profile-bound root (Electron authority), never the server
 *      `allowedRoots`; the shell still runs sandboxed.
 *   3. A stale/mismatched binding ⇒ stable denial errorCode, no execution.
 *   4. A binding with no resolver configured ⇒ `WORKSTATION_SHELL_BINDING_UNCONFIGURED`.
 *   5. A malformed binding ⇒ `WORKSTATION_SHELL_BINDING_INVALID`.
 *   6. Non-Full-Mode (no envelope) ⇒ byte-for-byte prior behavior
 *      (cwd = sandboxProfile.workspace).
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
import type {
  DesktopFilesystemAccessOperation,
  DesktopFilesystemGrant,
} from "@nautilo/desktop-filesystem-grants";
import type {
  DesktopFilesystemGrantAuthorityStore,
  RelayWorkstationProfileSnapshotProvider,
} from "../../electron/relay";
import { deriveDesktopFilesystemAccessOperation } from "../../electron/relay-dispatch/desktop-filesystem.ts";

// `../../electron/relay` transitively imports `./paths`, which imports the
// Electron `app`. Under `bun test` (no Electron runtime) that module throws at
// load, so we stub it before dynamically importing the handler below.
mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-test-userdata" },
}));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
let revalidateWorkstationShellBinding: typeof import("../../electron/relay").revalidateWorkstationShellBinding;
let createWorkstationShellBindingAuthorityResolver: typeof import("../../electron/relay").createWorkstationShellBindingAuthorityResolver;

beforeAll(async () => {
  ({
    makeDispatchHandler,
    revalidateWorkstationShellBinding,
    createWorkstationShellBindingAuthorityResolver,
  } = await import("../../electron/relay"));
});

const RELAY = "relay-desktop";
const DESKTOP = "desktop-1";
const INSTANCE = "instance-1";
const USER = "user-a";
const PROFILE = "profile-A";
const AGENT_SCOPE = "all_owned_agents";
const NOW = new Date("2026-07-12T12:00:00.000Z");

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
    access = ["execute", "read"] as readonly DesktopFilesystemAccessOperation[],
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
    currentFolder: "/tmp",
    grantRevision: 7,
    protectedPolicyVersion: 1,
    subject: {
      userId: USER,
      instanceId: INSTANCE,
      relayId: RELAY,
      agentScope: AGENT_SCOPE,
    },
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
  return {
    getProfileSnapshot: () => Promise.resolve(snapshot),
  };
}

function makeNetworkPolicyProvider(
  policy: import("@nautilo/workstation-profiles").ProfileNetworkPolicy | null | undefined,
): import("../../electron/relay").RelayWorkstationProfileNetworkPolicyProvider {
  return {
    getActiveNetworkPolicy: () => Promise.resolve(policy),
  };
}

const ISOLATED_NETWORK_POLICY: import("@nautilo/workstation-profiles").ProfileNetworkPolicy = {
  mode: "isolated",
  allow: [],
};

function makeSandbox(workspace: string): Sandbox {
  // Envelope-wiring tests need a containment-capable sandbox surface, not a
  // real macOS-only `sandbox-exec` binary. Return a structural fake whose
  // wrapper runs the requested process directly; live Seatbelt/bubblewrap
  // behavior is covered in relay-workstation-shell-binding-sandbox.test.ts.
  return {
    containmentActive: () => true,
    protectedFileMaskSupported: () => true,
    wrap: (
      program: string,
      args: readonly string[],
      cwd: string,
      env: Readonly<Record<string, string>>,
    ) => ({ program, args: [...args], cwd, env }),
    close: () => Promise.resolve(),
  } as unknown as Sandbox;
}

function mkRequest(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    id: "test-req-1",
    correlationId: "test-req-1",
    toolName: "run_shell",
    args: { command: "/bin/echo shell-bound" },
    impact: "low",
    approvalObtained: true,
    sandboxProfile: {
      workspace: "/tmp",
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

describe("D418 task 3.1.3b — revalidateWorkstationShellBinding (pure)", () => {
  test("success returns the profile-bound roots (most specific first)", () => {
    const grants = [
      grant("grant-1", { root: "/Users/test/profile-root" }),
      grant("grant-2", { root: "/Users/test" }),
    ];
    const r = revalidateWorkstationShellBinding({
      binding: binding({ grantIds: ["grant-1", "grant-2"] }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: {
        profileId: PROFILE,
        profileRevision: 2,
        protectedPolicyVersion: 1,
      },
      liveGrantRevision: 7,
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants,
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.roots).toEqual(["/Users/test/profile-root", "/Users/test"]);
      expect(r.grantIds).toEqual(["grant-1", "grant-2"]);
    }
  });

  test("read/execute grants stay read-only; only mutate grants become writable", () => {
    const readRoot = "/Users/test/read-only";
    const writeRoot = "/Users/test/write-capable";
    const r = revalidateWorkstationShellBinding({
      binding: binding({ grantIds: ["read", "write"] }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: {
        profileId: PROFILE,
        profileRevision: 2,
        protectedPolicyVersion: 1,
      },
      liveGrantRevision: 7,
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [
        grant("read", { root: readRoot, access: ["read", "execute"] }),
        grant("write", { root: writeRoot, access: ["execute", "create_modify"] }),
      ],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.readOnlyRoots).toContain(readRoot);
      expect(r.readOnlyRoots).toContain(writeRoot);
      expect(r.writableRoots).toEqual([writeRoot]);
    }
  });

  test("null concrete operation ⇒ INVALID (never defaults)", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding(),
      concreteOperation: null,
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "WORKSTATION_SHELL_BINDING_INVALID" });
  });

  test("operation mismatch ⇒ OPERATION_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ operation: "read" }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "OPERATION_MISMATCH" });
  });

  test("foreign relay ⇒ RELAY_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ relayId: "relay-other" }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "RELAY_MISMATCH" });
  });

  test("stale desktop session ⇒ DESKTOP_SESSION_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ desktopSessionId: "desktop-restarted" }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "DESKTOP_SESSION_MISMATCH" });
  });

  test("stale capability revision ⇒ CAPABILITY_REVISION_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ capabilityRevision: 4 }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "CAPABILITY_REVISION_MISMATCH" });
  });

  test("stale profile binding ⇒ PROFILE_BINDING_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ profileRevision: 1 }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "PROFILE_BINDING_MISMATCH" });
  });

  test("stale durable grant-store revision ⇒ GRANT_REVISION_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ grantRevision: 6 }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: {
        profileId: PROFILE,
        profileRevision: 2,
        protectedPolicyVersion: 1,
      },
      liveGrantRevision: 7,
      expectedSubject: {
        userId: USER,
        instanceId: INSTANCE,
        relayId: RELAY,
        agentScope: AGENT_SCOPE,
      },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "GRANT_REVISION_MISMATCH" });
  });

  test("stale protected-policy version ⇒ PROTECTED_POLICY_VERSION_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ protectedPolicyVersion: 2 }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: {
        profileId: PROFILE,
        profileRevision: 2,
        protectedPolicyVersion: 1,
      },
      liveGrantRevision: 7,
      expectedSubject: {
        userId: USER,
        instanceId: INSTANCE,
        relayId: RELAY,
        agentScope: AGENT_SCOPE,
      },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({
      ok: false,
      code: "PROTECTED_POLICY_VERSION_MISMATCH",
    });
  });

  test("no live profile ⇒ PROFILE_BINDING_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding(),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: null,
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "PROFILE_BINDING_MISMATCH" });
  });

  test("foreign subject ⇒ SUBJECT_MISMATCH", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ subject: { userId: "user-b", instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE } }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "SUBJECT_MISMATCH" });
  });

  test("stale grant id ⇒ GRANT_STALE", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ grantIds: ["grant-missing"] }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1")],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "GRANT_STALE" });
  });

  test("revoked grant ⇒ GRANT_REVOKED", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding(),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1", { status: "revoked" })],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "GRANT_REVOKED" });
  });

  test("expired grant ⇒ GRANT_EXPIRED", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding(),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2 },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [grant("grant-1", { status: "expired" })],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: false, code: "GRANT_EXPIRED" });
  });

  test("mixed profile grants retain their own access without requiring execute on every root", () => {
    const r = revalidateWorkstationShellBinding({
      binding: binding({ grantIds: ["read-only", "write-only", "delete-only", "executable"] }),
      concreteOperation: "execute",
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      expectedCapabilityRevision: 5,
      liveProfile: { profileId: PROFILE, profileRevision: 2, protectedPolicyVersion: 1 },
      liveGrantRevision: 7,
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      grants: [
        grant("read-only", { root: "/Users/test/reference", access: ["read"] }),
        grant("write-only", { root: "/Users/test/output", access: ["create_modify"] }),
        grant("delete-only", { root: "/Users/test/trash", access: ["delete"] }),
        grant("executable", { root: "/Users/test/bin", access: ["execute"] }),
      ],
      now: () => NOW,
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.readOnlyRoots).toEqual([
        "/Users/test/reference",
        "/Users/test/bin",
      ]);
      expect(r.writableRoots).toEqual(["/Users/test/output", "/Users/test/trash"]);
    }
  });
});

describe("D418 task 3.1.3b — makeDispatchHandler shell-binding gate", () => {
  const savedLdPreload = process.env["LD_PRELOAD"];
  beforeEach(() => {
    delete process.env["LD_PRELOAD"];
  });
  afterEach(() => {
    if (savedLdPreload === undefined) delete process.env["LD_PRELOAD"];
    else process.env["LD_PRELOAD"] = savedLdPreload;
  });

  function mkTmp(prefix: string): string {
    return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
  }

  function resolver(options: {
    grants: Array<{ grant: DesktopFilesystemGrant; status: "active" | "revoked" | "expired" }>;
    profile?: RelayWorkstationProfileSnapshot | undefined;
    capabilityRevision?: number;
    relayId?: string;
    desktopSessionId?: string;
    networkPolicy?: import("@nautilo/workstation-profiles").ProfileNetworkPolicy | null;
    currentFolder?: string;
  }) {
    return createWorkstationShellBindingAuthorityResolver({
      store: makeStore(options.grants),
      expectedRelayId: options.relayId ?? RELAY,
      expectedDesktopSessionId: options.desktopSessionId ?? DESKTOP,
      getCapabilityRevision: () => options.capabilityRevision ?? 5,
      getCurrentFolder: () => options.currentFolder ?? "/tmp",
      profileProvider: makeProfileProvider(options.profile ?? profileSnapshot(2)),
      networkPolicyProvider: makeNetworkPolicyProvider(
        options.networkPolicy ?? ISOLATED_NETWORK_POLICY,
      ),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
    });
  }

  test("read/execute-only binding ⇒ run_shell cwd is private scratch, not a grant root", async () => {
    const profileRoot = mkTmp("relay-shell-profile-root-");
    const grants = [grant("grant-1", { root: profileRoot })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-guard-") });
    let capturedWorkspace: string | undefined;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (envelope) => {
        capturedWorkspace = envelope.workspace;
        return Promise.resolve(makeSandbox(envelope.workspace));
      },
    });

    const r = await handler(
      mkRequest({
        allowedRoots: ["/untrusted-server-root"],
        sandboxProfile: {
          workspace: "/tmp",
          dataDir: "/tmp/data",
          toolsBin: "/tmp/tools",
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
        },
        args: { command: "/bin/pwd" },
        workstationShellBinding: binding(),
      }),
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string; stderr: string };
      expect(result.stdout.trimEnd()).toBe(canonicalize(capturedWorkspace ?? ""));
      expect(result.stdout).not.toBe(profileRoot);
    }
  });

  test("stale profile binding ⇒ stable denial, no execution", async () => {
    const grants = [grant("grant-1")];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants, profile: profileSnapshot(99) }),
      createSandbox: () => {
        ran = true;
        return Promise.resolve(makeSandbox("/tmp"));
      },
    });

    const r = await handler(
      mkRequest({ workstationShellBinding: binding() }),
    );

    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.errorCode).toBe("PROFILE_BINDING_MISMATCH");
      expect(r.error).toContain("PROFILE_BINDING_MISMATCH");
    }
    expect(ran).toBe(false);
  });

  test("Current Folder drift ⇒ CURRENT_FOLDER_MISMATCH before execution", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-folder-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({
        grants: [grant("grant-1")],
        currentFolder: "/Users/test/other-project",
      }),
      createSandbox: () => {
        ran = true;
        return Promise.resolve(makeSandbox("/tmp"));
      },
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("CURRENT_FOLDER_MISMATCH");
    expect(ran).toBe(false);
  });

  test("foreign relay binding ⇒ RELAY_MISMATCH denial", async () => {
    const grants = [grant("grant-1")];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: () => Promise.resolve(makeSandbox("/tmp")),
    });

    const r = await handler(
      mkRequest({ workstationShellBinding: binding({ relayId: "relay-other" }) }),
    );

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("RELAY_MISMATCH");
  });

  test("filesystem identity replacement ⇒ IDENTITY_MISMATCH before execution", async () => {
    const profileRoot = mkTmp("relay-shell-identity-root-");
    const grants = [
      grant("grant-1", {
        root: profileRoot,
        filesystemIdentity: {
          realRoot: profileRoot,
          device: 1,
          inode: 2,
        },
      }),
    ];
    const authority = createWorkstationShellBindingAuthorityResolver({
      store: makeStore(grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      getCapabilityRevision: () => 5,
      getCurrentFolder: () => "/tmp",
      profileProvider: makeProfileProvider(profileSnapshot(2)),
      networkPolicyProvider: makeNetworkPolicyProvider(ISOLATED_NETWORK_POLICY),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
      revalidateIdentity: async () => ({ ok: false, code: "IDENTITY_MISMATCH" }),
    });
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-identity-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: authority,
      createSandbox: () => {
        ran = true;
        return Promise.resolve(makeSandbox(profileRoot));
      },
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));
    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("IDENTITY_MISMATCH");
    expect(ran).toBe(false);
  });

  test("binding present but no resolver configured ⇒ UNCONFIGURED", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      createSandbox: () => Promise.resolve(makeSandbox("/tmp")),
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("WORKSTATION_SHELL_BINDING_UNCONFIGURED");
  });

  test("malformed binding ⇒ INVALID", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants: [grant("grant-1")] }),
      createSandbox: () => Promise.resolve(makeSandbox("/tmp")),
    });

    const r = await handler(
      mkRequest({
        workstationShellBinding: { ...binding(), version: 999 } as unknown as RelayWorkstationShellBinding,
      }),
    );

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("WORKSTATION_SHELL_BINDING_INVALID");
  });

  test("missing pairingGeneration ⇒ INVALID at ingress (mandatory wire field)", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants: [grant("grant-1")] }),
      createSandbox: () => Promise.resolve(makeSandbox("/tmp")),
    });

    const { pairingGeneration: _omitted, ...withoutPairing } = binding();
    const r = await handler(
      mkRequest({
        workstationShellBinding: withoutPairing as RelayWorkstationShellBinding,
      }),
    );

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("WORKSTATION_SHELL_BINDING_INVALID");
  });

  test("missing protocol-v2 coherence field ⇒ INVALID at ingress", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-v2-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants: [grant("grant-1")] }),
      createSandbox: () => Promise.resolve(makeSandbox("/tmp")),
    });

    for (const field of [
      "currentFolder",
      "grantRevision",
      "protectedPolicyVersion",
    ] as const) {
      const malformed = { ...binding() } as Record<string, unknown>;
      delete malformed[field];
      const r = await handler(
        mkRequest({
          workstationShellBinding:
            malformed as unknown as RelayWorkstationShellBinding,
        }),
      );
      expect(r.status).toBe("error");
      expect((r as { errorCode?: string }).errorCode).toBe(
        "WORKSTATION_SHELL_BINDING_INVALID",
      );
    }
  });

  test("non-Full-Mode (no envelope) ⇒ cwd follows sandboxProfile.workspace (prior behavior)", async () => {
    const currentFolder = mkTmp("relay-shell-nofullmode-");
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-shell-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants: [grant("grant-1")] }),
      createSandbox: () => Promise.resolve(makeSandbox(currentFolder)),
    });

    const r = await handler(
      mkRequest({
        sandboxProfile: {
          workspace: currentFolder,
          dataDir: `${currentFolder}/data`,
          toolsBin: `${currentFolder}/tools`,
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
        },
        args: { command: "/bin/pwd" },
      }),
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string };
      expect(result.stdout.trimEnd()).toBe(currentFolder);
    }
  });

  test("deriveDesktopFilesystemAccessOperation maps run_shell to execute", () => {
    expect(deriveDesktopFilesystemAccessOperation(mkRequest())).toBe("execute");
  });
});

// ---------------------------------------------------------------------------
// D418 local authority-boundary correction — a generic run_shell that carries
// no workstationShellBinding is refused while a locally authoritative active
// workstation profile is bound (and on profile lookup failure). No active
// profile ⇒ baseline behavior is preserved byte-for-byte.
// ---------------------------------------------------------------------------

describe("D418 local authority-boundary correction — active-profile run_shell gate", () => {
  const savedLdPreload = process.env["LD_PRELOAD"];
  beforeEach(() => {
    delete process.env["LD_PRELOAD"];
  });
  afterEach(() => {
    if (savedLdPreload === undefined) delete process.env["LD_PRELOAD"];
    else process.env["LD_PRELOAD"] = savedLdPreload;
  });

  function mkTmp(prefix: string): string {
    return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
  }

  function stateProvider(
    snapshot: RelayWorkstationProfileSnapshot | undefined,
  opts: { throws?: boolean } = {},
  ): RelayWorkstationProfileSnapshotProvider {
    return {
      getProfileSnapshot: () => {
        if (opts.throws) return Promise.reject(new Error("controller unavailable"));
        return Promise.resolve(snapshot);
      },
    };
  }

  test("active local profile + no binding ⇒ stable refusal, sandbox factory never invoked", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-gate-active-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationProfileStateProvider: stateProvider(profileSnapshot(2)),
      createSandbox: () => {
        ran = true;
        return Promise.resolve(makeSandbox("/tmp"));
      },
    });

    const r = await handler(mkRequest({ args: { command: "/bin/pwd" } }));

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("WORKSTATION_SHELL_BINDING_REQUIRED");
    expect(ran).toBe(false);
  });

  test("provider throws ⇒ stable refusal (lookup failure denies), sandbox factory never invoked", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-gate-throw-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationProfileStateProvider: stateProvider(undefined, { throws: true }),
      createSandbox: () => {
        ran = true;
        return Promise.resolve(makeSandbox("/tmp"));
      },
    });

    const r = await handler(mkRequest({ args: { command: "/bin/pwd" } }));

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("WORKSTATION_PROFILE_LOOKUP_FAILED");
    expect(ran).toBe(false);
  });

  test("no active profile + no binding ⇒ baseline works (cwd follows sandboxProfile.workspace)", async () => {
    const currentFolder = mkTmp("relay-gate-none-cwd-");
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-gate-none-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationProfileStateProvider: stateProvider(undefined),
      createSandbox: () => Promise.resolve(makeSandbox(currentFolder)),
    });

    const r = await handler(
      mkRequest({
        sandboxProfile: {
          workspace: currentFolder,
          dataDir: `${currentFolder}/data`,
          toolsBin: `${currentFolder}/tools`,
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
        },
        args: { command: "/bin/pwd" },
      }),
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string };
      expect(result.stdout.trimEnd()).toBe(currentFolder);
    }
  });

  test("no state provider wired ⇒ baseline route still works (gate skipped)", async () => {
    const currentFolder = mkTmp("relay-gate-noprovider-cwd-");
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-gate-noprovider-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      createSandbox: () => Promise.resolve(makeSandbox(currentFolder)),
    });

    const r = await handler(
      mkRequest({
        sandboxProfile: {
          workspace: currentFolder,
          dataDir: `${currentFolder}/data`,
          toolsBin: `${currentFolder}/tools`,
          mode: "desktop-permissive",
          securityLevel: "standard",
          failIfNoBackend: false,
          config: { mode: "disabled", writablePaths: [], projectPaths: [], passthroughEnv: [] },
        },
        args: { command: "/bin/pwd" },
      }),
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string };
      expect(result.stdout.trimEnd()).toBe(currentFolder);
    }
  });

  test("active local profile + valid binding ⇒ gate does not deny (binding path proceeds)", async () => {
    const profileRoot = mkTmp("relay-gate-valid-root-");
    const grants = [grant("grant-1", { root: profileRoot })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-gate-valid-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationProfileStateProvider: stateProvider(profileSnapshot(2)),
      workstationShellBindingAuthority: createWorkstationShellBindingAuthorityResolver({
        store: makeStore(grants),
        expectedRelayId: RELAY,
        expectedDesktopSessionId: DESKTOP,
        getCapabilityRevision: () => 5,
        getCurrentFolder: () => "/tmp",
        profileProvider: makeProfileProvider(profileSnapshot(2)),
        networkPolicyProvider: makeNetworkPolicyProvider(ISOLATED_NETWORK_POLICY),
        expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
        now: () => NOW,
      }),
      createSandbox: (envelope) => {
        ran = true;
        return Promise.resolve(makeSandbox(envelope.workspace));
      },
    });

    const r = await handler(
      mkRequest({ args: { command: "/bin/pwd" }, workstationShellBinding: binding() }),
    );

    expect(r.status).toBe("ok");
    expect(ran).toBe(true);
  });

  test("active local profile + non-run_shell dispatch ⇒ gate is run_shell-specific (no gate denial)", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-gate-nonshell-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationProfileStateProvider: stateProvider(profileSnapshot(2)),
      createSandbox: () => Promise.resolve(makeSandbox("/tmp")),
    });

    // An fs dispatch does not carry run_shell's gate; the gate must not
    // short-circuit it with the run_shell denial codes.
    const r = await handler(
      mkRequest({
        toolName: "fs",
        executionClass: "fs",
        args: { op: "stat", path: "/tmp" },
      }),
    );

    expect((r as { errorCode?: string }).errorCode).not.toBe("WORKSTATION_SHELL_BINDING_REQUIRED");
    expect((r as { errorCode?: string }).errorCode).not.toBe("WORKSTATION_PROFILE_LOOKUP_FAILED");
  });
});
