/**
 * Desktop compiles revalidated policy-pack grant roots and canonical
 * protected-path policy into the sandbox used by managed local execution and
 * typed Git.
 *
 * Validates:
 *   1. `selectSandboxProtectedPaths` curates the canonical
 *      `ProtectedPathPolicy` to the home-relative secret/credential +
 *      Nautilo-state categories the sandbox can safely deny, and EXCLUDES
 *      the system categories the sandbox needs for tool operation
 *      (system_virtual / system_auth / system_network / system_boot).
 *   2. `buildShellBindingSandboxEnvelope` rebuilds the envelope so its
 *      `writablePaths` derive from the revalidated grant roots (unioned
 *      with the server's), `protectedPaths` carry the curated denies, and
 *      the rest of the envelope (workspace / dataDir / network posture /
 *      failIfNoBackend) is preserved.
 *   3. Invalid or mismatched authority never broadens the sandbox.
 *   4. The server's `allowedRoots` is never authority and never widened.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Sandbox,
  canonicalize,
} from "@nautilo/sandbox";
import {
  createWorkspaceGuard,
  RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  type RelayDispatchRequest,
  type RelaySandboxProfile,
  type RelayNetworkPolicy,
  type RelayWorkstationShellBinding,
  type RelayWorkstationProfileSnapshot,
} from "@nautilo/relay";
import { buildProtectedPathPolicy } from "@nautilo/security";
import type {
  DesktopFilesystemAccessOperation,
  DesktopFilesystemGrant,
} from "@nautilo/desktop-filesystem-grants";
import type {
  ProfileNetworkPolicy,
} from "@nautilo/workstation-profiles";
import type {
  DesktopFilesystemGrantAuthorityStore,
  RelayWorkstationProfileSnapshotProvider,
} from "../../electron/relay";
import { prepareLocalDispatchPolicy } from "../../electron/relay-dispatch/local-dispatch-policy";
import { DesktopFilesystemGrantStore } from "../../electron/desktop-filesystem-grants/store";
import { captureDesktopFilesystemGrantRootIdentity } from "../../electron/desktop-filesystem-grants/identity";

// `../../electron/relay` transitively imports `./paths`, which imports the
// Electron `app`. Under `bun test` (no Electron runtime) that module throws
// at load, so we stub it before dynamically importing the handler below.
mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-test-userdata" },
}));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
let buildShellBindingSandboxEnvelope: typeof import("../../electron/relay").buildShellBindingSandboxEnvelope;
let selectSandboxProtectedPaths: typeof import("../../electron/relay").selectSandboxProtectedPaths;
let SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES: typeof import("../../electron/relay").SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES;
let SANDBOX_PROTECTED_SYSTEM_PATH_NAMES: typeof import("../../electron/relay").SANDBOX_PROTECTED_SYSTEM_PATH_NAMES;
let createWorkstationShellBindingAuthorityResolver: typeof import("../../electron/relay").createWorkstationShellBindingAuthorityResolver;
let createLocalShellWorkspaceAuthorityResolver: typeof import("../../electron/relay").createLocalShellWorkspaceAuthorityResolver;
let profileNetworkPolicyToRelayNetworkPolicy: typeof import("../../electron/relay").profileNetworkPolicyToRelayNetworkPolicy;

beforeAll(async () => {
  ({
    makeDispatchHandler,
    buildShellBindingSandboxEnvelope,
    selectSandboxProtectedPaths,
    SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES,
    SANDBOX_PROTECTED_SYSTEM_PATH_NAMES,
    createWorkstationShellBindingAuthorityResolver,
    createLocalShellWorkspaceAuthorityResolver,
    profileNetworkPolicyToRelayNetworkPolicy,
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
    root = "/path/to/profile-root",
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
    toolCallId: "tc-exec-command",
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

function makeProfileProvider(
  snapshot: RelayWorkstationProfileSnapshot | undefined,
): RelayWorkstationProfileSnapshotProvider {
  return {
    getProfileSnapshot: () => Promise.resolve(snapshot),
    getExecutionEnvironment: () => snapshot === undefined
      ? null
      : ({
          profileId: snapshot.profileId,
          profileRevision: snapshot.profileRevision,
          protectedPolicyVersion: snapshot.protectedPolicyVersion,
          home: tmpdir(),
          environmentValues: {},
          executables: [],
        }),
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

function makeSandbox(): Sandbox {
  // Envelope-wiring tests need a containment-capable sandbox surface, not a
  // real macOS-only `sandbox-exec` binary. Return a structural fake whose
  // wrapper runs the requested process directly; real Seatbelt/bubblewrap
  // behavior is covered by the live protected-shell tests below.
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

function baseEnvelope(workspace = "/tmp"): RelaySandboxProfile {
  return {
    workspace,
    dataDir: `${workspace}/data`,
    toolsBin: `${workspace}/tools`,
    mode: "desktop-permissive",
    securityLevel: "standard",
    failIfNoBackend: false,
    config: {
      mode: "disabled",
      writablePaths: ["/server/supplied/writable"],
      projectPaths: [],
      passthroughEnv: [],
    },
  };
}

function mkRequest(overrides: Partial<RelayDispatchRequest> = {}): RelayDispatchRequest {
  return {
    id: "test-req-1",
    correlationId: "test-req-1",
    toolName: "exec_command",
    args: { command: "/bin/pwd" },
    impact: "low",
    approvalObtained: true,
    sandboxProfile: baseEnvelope(),
    ...overrides,
  } as RelayDispatchRequest;
}

function mkTmp(prefix: string): string {
  return canonicalize(mkdtempSync(join(tmpdir(), prefix)));
}

describe("request-local dispatch policy cleanup", () => {
  test("closes the created sandbox before preserving a throwing workspace revalidation", async () => {
    let closeCalls = 0;
    const sandbox = {
      containmentActive: () => true,
      protectedFileMaskSupported: () => true,
      close: async () => {
        closeCalls += 1;
      },
    } as unknown as Sandbox;
    const expected = new Error("Current Folder revalidation failed");

    let received: unknown;
    try {
      await prepareLocalDispatchPolicy({
        toolName: "exec_command",
        isProduction: true,
        desktopFilesystemAuthority: undefined,
        revalidatedShellBinding: undefined,
        shellNetworkPolicy: undefined,
        requestHasShellBinding: false,
        checkUnboundRunShell: async () => undefined,
        augmentEnvelope: async () => ({
          ok: true as const,
          sandboxEnvelope: baseEnvelope(),
          locallyAuthorizedWorkspace: undefined,
        }),
        revalidateWorkspaceBeforeOperation: async () => {
          throw expected;
        },
        createSandbox: () => Promise.resolve(sandbox),
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBe(expected);
    expect(closeCalls).toBe(1);
  });

  test("propagates a close rejection over the workspace revalidation error", async () => {
    const authorityError = new Error("Current Folder revalidation failed");
    const closeError = new Error("sandbox close failed");
    const sandbox = {
      containmentActive: () => true,
      protectedFileMaskSupported: () => true,
      close: async () => {
        throw closeError;
      },
    } as unknown as Sandbox;

    let received: unknown;
    try {
      await prepareLocalDispatchPolicy({
        toolName: "exec_command",
        isProduction: true,
        desktopFilesystemAuthority: undefined,
        revalidatedShellBinding: undefined,
        shellNetworkPolicy: undefined,
        requestHasShellBinding: false,
        checkUnboundRunShell: async () => undefined,
        augmentEnvelope: async () => ({
          ok: true as const,
          sandboxEnvelope: baseEnvelope(),
          locallyAuthorizedWorkspace: undefined,
        }),
        revalidateWorkspaceBeforeOperation: async () => {
          throw authorityError;
        },
        createSandbox: () => Promise.resolve(sandbox),
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBe(closeError);
  });
});

// ---------------------------------------------------------------------------
// selectSandboxProtectedPaths — curation
// ---------------------------------------------------------------------------

describe("selectSandboxProtectedPaths curation", () => {
  test("returns empty when no policy is configured", () => {
    expect(selectSandboxProtectedPaths(undefined)).toEqual([]);
  });

  test("includes home-relative secret/credential + Nautilo-state categories", () => {
    const home = mkTmp("relay-pp-home-");
    const policy = buildProtectedPathPolicy({
      homeDir: home,
      platform: process.platform,
      nautiloRoots: {
        privateRoot: join(home, ".nautilo", "private"),
        dataRoot: join(home, ".nautilo", "data"),
        auditRoot: join(home, ".nautilo", "audit"),
      },
    });
    const selected = selectSandboxProtectedPaths(policy);
    // SSH keys, cloud creds, Nautilo data are all compiled in.
    expect(selected).toContain(join(home, ".ssh"));
    expect(selected).toContain(join(home, ".aws"));
    expect(selected).toContain(join(home, ".nautilo", "data"));
    expect(selected).toContain(join(home, ".nautilo", "private"));
  });

  test("EXCLUDES system_virtual / system_auth / system_network / system_boot", () => {
    // Compiling /proc, /dev, /etc/passwd, /etc/hosts, /etc/ssl, /boot
    // into the sandbox would deny paths tools need for operation
    // (procfs, DNS, TLS trust, name resolution). The category allowlist
    // must keep them out.
    const home = mkTmp("relay-pp-exclude-");
    const policy = buildProtectedPathPolicy({
      homeDir: home,
      platform: process.platform,
    });
    const selected = selectSandboxProtectedPaths(policy);
    const platform = process.platform;
    if (platform === "darwin" || platform === "linux") {
      expect(selected).not.toContain("/proc");
      expect(selected).not.toContain("/dev");
      expect(selected).not.toContain("/boot");
    }
    if (platform !== "win32") {
      expect(selected).not.toContain("/etc/passwd");
      expect(selected).not.toContain("/etc/hosts");
      expect(selected).not.toContain("/etc/ssl");
    }
  });

  test("fine-grains protected system paths without breaking passwd/hosts/TLS/dev/proc", () => {
    const policy = buildProtectedPathPolicy({
      homeDir: mkTmp("relay-pp-system-"),
      platform: process.platform,
    });
    const selected = selectSandboxProtectedPaths(policy);
    if (process.platform !== "win32") {
      expect(selected).toContain("/etc/shadow");
      expect(selected).toContain("/etc/sudoers");
      expect(selected).toContain("/etc/pam.d");
      expect(selected).toContain("/etc/ssh");
      expect(selected).toContain("/sys"); // explicit kernel-control decision
      expect(selected).not.toContain("/etc/passwd");
      expect(selected).not.toContain("/etc/hosts");
      expect(selected).not.toContain("/etc/ssl");
      expect(selected).not.toContain("/proc");
      expect(selected).not.toContain("/dev");
      expect(SANDBOX_PROTECTED_SYSTEM_PATH_NAMES).toContain("/sys");
    }
  });

  test("the compiled category allowlist is pinned (no system_virtual)", () => {
    // A future widening that admitted system_virtual would deny /proc
    // and break every sandboxed shell. Pin the allowlist.
    expect(SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES).not.toContain("system_virtual");
    expect(SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES).not.toContain("system_auth");
    expect(SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES).not.toContain("system_network");
    expect(SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES).not.toContain("system_boot");
    // And the home-relative secret categories ARE present.
    expect(SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES).toContain("ssh");
    expect(SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES).toContain("cloud");
    expect(SANDBOX_COMPILED_PROTECTED_PATH_CATEGORY_NAMES).toContain("nautilo_data");
  });
});

// ---------------------------------------------------------------------------
// buildShellBindingSandboxEnvelope — envelope rebuild
// ---------------------------------------------------------------------------

describe("buildShellBindingSandboxEnvelope", () => {
  test("writablePaths derive only from locally revalidated write grants", () => {
    const profileRoot = mkTmp("relay-env-root-");
    const env = buildShellBindingSandboxEnvelope(
      baseEnvelope("/tmp"),
      { readOnlyRoots: [], writableRoots: [profileRoot] },
      undefined,
    );
    expect(env.config.writablePaths).toContain(profileRoot);
    expect(env.config.writablePaths).not.toContain("/server/supplied/writable");
    expect(env.config.projectPaths).toEqual([]);
  });

  test("preserves only operational envelope fields and forces guarded containment", () => {
    const profileRoot = mkTmp("relay-env-preserve-");
    const base = baseEnvelope("/custom-workspace");
    const applyPatchBinary = "/trusted/local/apply-patch/darwin-arm64/nautilo-apply-patch";
    const env = buildShellBindingSandboxEnvelope(
      base,
      { readOnlyRoots: [profileRoot], writableRoots: [] },
      undefined,
      dirname(applyPatchBinary),
      { workspace: "/trusted/local/scratch", protectedFileMaskPath: "/trusted/local/scratch/.mask" },
    );
    expect(env.workspace).toBe("/trusted/local/scratch");
    expect(env.dataDir).toBe("/custom-workspace/data");
    // The generic compiler retains a locally resolved product binary's
    // directory as the sandbox tools bind, which both Seatbelt and bubblewrap
    // expose read-only for execution.
    expect(env.toolsBin).toBe(dirname(applyPatchBinary));
    expect(env.mode).toBe("desktop-permissive");
    expect(env.securityLevel).toBe("standard");
    expect(env.failIfNoBackend).toBe(true);
    expect(env.config.mode).toBe("enabled");
    expect(env.config.readOnlyPaths).toEqual([profileRoot]);
    expect(env.config.writablePaths).toEqual([]);
    expect(env.config.passthroughEnv).toEqual([]);
  });

  test("uses the locally selected workspace when a writable grant contains it", () => {
    const profileRoot = mkTmp("relay-env-current-root-");
    const currentFolder = join(profileRoot, "current-project");
    mkdirSync(currentFolder);

    const env = buildShellBindingSandboxEnvelope(
      baseEnvelope("/server-supplied-workspace"),
      { readOnlyRoots: [profileRoot], writableRoots: [profileRoot] },
      undefined,
      "/trusted/local/tools",
      { workspace: "/trusted/local/scratch", protectedFileMaskPath: "/trusted/local/scratch/.mask" },
      undefined,
      currentFolder,
    );

    expect(env.workspace).toBe(currentFolder);
  });

  test("protectedPaths are threaded through when a policy is configured", () => {
    const profileRoot = mkTmp("relay-env-pp-");
    const home = mkTmp("relay-env-pp-home-");
    const policy = buildProtectedPathPolicy({
      homeDir: home,
      platform: process.platform,
    });
    const env = buildShellBindingSandboxEnvelope(
      baseEnvelope(),
      { readOnlyRoots: [profileRoot], writableRoots: [] },
      policy,
    );
    expect(env.config.protectedPaths).toBeDefined();
    if (env.config.protectedPaths !== undefined) {
      expect(env.config.protectedPaths).toContain(join(home, ".ssh"));
    }
  });

  test("omits protectedPaths when no policy is configured", () => {
    const profileRoot = mkTmp("relay-env-nopp-");
    const env = buildShellBindingSandboxEnvelope(
      baseEnvelope(),
      { readOnlyRoots: [profileRoot], writableRoots: [] },
      undefined,
    );
    expect(env.config.protectedPaths).toBeUndefined();
  });

  test("read/execute roots remain read-only and write-capable roots become writable", () => {
    const profileRoot = mkTmp("relay-env-dedupe-");
    const base = baseEnvelope();
    base.config.writablePaths = [profileRoot];
    const env = buildShellBindingSandboxEnvelope(
      base,
      { readOnlyRoots: [profileRoot], writableRoots: [profileRoot] },
      undefined,
    );
    expect(env.config.writablePaths.filter((p) => p === profileRoot).length).toBe(1);
    expect(env.config.readOnlyPaths).toEqual([profileRoot]);
    expect(env.config.writablePaths).toEqual([profileRoot]);
  });

  test("does not widen the server allowedRoots (envelope-level only)", () => {
    // The envelope augmentation is relay-local; the server's allowedRoots
    // wire field is never touched. This test documents that the helper
    // only mutates the sandbox envelope, not any allowedRoots concept.
    const profileRoot = mkTmp("relay-env-no-widen-");
    const env = buildShellBindingSandboxEnvelope(
      baseEnvelope(),
      { readOnlyRoots: [profileRoot], writableRoots: [] },
      undefined,
    );
    // The envelope carries only writablePaths / protectedPaths changes.
    expect(Object.keys(env).sort()).toEqual(
      ["workspace", "dataDir", "toolsBin", "config", "mode", "securityLevel", "failIfNoBackend"].sort(),
    );
    expect(env.config.readOnlyPaths).toContain(profileRoot);
  });
});

describe("local Current Folder shell authority", () => {
  const subject = {
    userId: USER,
    instanceId: INSTANCE,
    relayId: RELAY,
    agentScope: AGENT_SCOPE,
  };

  test.each([false, true])("a replacement grant supersedes revoked history regardless of record order (%s)", async (reverse) => {
    const root = mkTmp("relay-replaced-grant-");
    const revoked = grant("old", {
      root, lifetime: "durable", status: "revoked",
      revokedAt: "2026-07-12T12:00:00.000Z",
    });
    const replacement = grant("replacement", {
      root, lifetime: "durable", origin: "user_picker",
      createdAt: "2026-07-12T13:00:00.000Z",
      access: ["read", "create_modify", "execute"],
      filesystemIdentity: { realRoot: root },
    });
    const records = reverse ? [replacement, revoked] : [revoked, replacement];
    const options = {
      store: makeStore(records), expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({ homeDir: mkTmp("relay-replaced-home-"), platform: process.platform }),
    };
    expect(await createLocalShellWorkspaceAuthorityResolver(options)(root)).toEqual({ ok: true, workspace: root, access: ["read", "create_modify", "execute"] });
    // Reconstructing the resolver models a fresh relay session: recovery must
    // come from durable authority, not process-local cached permission.
    expect(await createLocalShellWorkspaceAuthorityResolver(options)(root)).toEqual({ ok: true, workspace: root, access: ["read", "create_modify", "execute"] });
  });

  test.each(["revoked", "expired"] as const)("an independent active grant survives %s of a duplicate at the same scope", async (status) => {
    const root = mkTmp("relay-grant-history-");
    const historical = grant("old", {
      root, lifetime: "durable", status,
      ...(status === "revoked" ? { revokedAt: "2026-07-12T12:00:00.000Z" } : { expiresAt: "2026-07-12T12:00:00.000Z" }),
    });
    const active = grant("active", {
      root, lifetime: "durable", access: ["read", "create_modify", "execute"],
      filesystemIdentity: { realRoot: root },
    });
    const records = [historical, active];
    const resolver = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore(records), expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({ homeDir: mkTmp("relay-history-home-"), platform: process.platform }),
    });
    expect(await resolver(root)).toEqual({ ok: true, workspace: root, access: ["read", "create_modify", "execute"] });
    records[1] = { ...active, grant: { ...active.grant, createdAt: "2026-07-12T13:00:00.000Z" } };
    expect(await resolver(root)).toEqual({ ok: true, workspace: root, access: ["read", "create_modify", "execute"] });
    records.splice(1);
    expect(await resolver(root)).toEqual({ ok: false, code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED" });
  });

  test.each(["narrower", "read-only", "foreign", "identity"] as const)("replacing history preserves %s restrictions", async (restriction) => {
    const root = mkTmp("relay-grant-restriction-");
    const project = join(root, "project");
    mkdirSync(project);
    const records = [
      grant("old", {
        root: restriction === "narrower" ? project : root,
        lifetime: "durable", status: "revoked", revokedAt: "2026-07-12T12:00:00.000Z",
      }),
      grant("replacement", {
        root, lifetime: "durable", createdAt: "2026-07-12T13:00:00.000Z",
        access: restriction === "read-only" ? ["read", "execute"] : ["read", "create_modify", "execute"],
        subject: restriction === "foreign" ? { ...subject, relayId: "other-relay" } : subject,
        filesystemIdentity: { realRoot: restriction === "identity" ? join(root, "missing") : root },
      }),
    ];
    const resolver = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore(records), expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({ homeDir: mkTmp("relay-restriction-home-"), platform: process.platform }),
    });
    expect(await resolver(project)).toEqual({
      ok: false,
      code: restriction === "identity" ? "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH" : "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED",
    });
  });

  test("authorizes a Current Folder through a containing durable grant", async () => {
    const parent = mkTmp("relay-current-parent-");
    const currentFolder = join(parent, "project");
    mkdirSync(currentFolder);
    const resolver = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore([
        grant("durable-current", {
          root: parent,
          access: ["read", "execute", "create_modify"],
          origin: "user_picker",
          lifetime: "durable",
          filesystemIdentity: { realRoot: parent },
        }),
      ]),
      expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("relay-current-home-"),
        platform: process.platform,
      }),
    });

    expect(await resolver(currentFolder)).toEqual({
      ok: true,
      workspace: currentFolder,
      access: ["read", "create_modify", "execute"],
    });
  });

  test("rejects a selected folder when its durable grant lacks write authority", async () => {
    const durableRoot = mkTmp("relay-current-read-only-root-");
    const currentFolder = join(durableRoot, "project");
    mkdirSync(currentFolder);
    const resolver = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore([
        grant("durable-current-read-only", {
          root: durableRoot,
          access: ["read", "execute"],
          origin: "user_picker",
          lifetime: "durable",
          filesystemIdentity: { realRoot: durableRoot },
        }),
      ]),
      expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("relay-current-read-only-home-"),
        platform: process.platform,
      }),
    });

    expect(await resolver(currentFolder)).toEqual({
      ok: false,
      code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED",
    });
  });

  test("uses the transient Current Folder baseline when no durable project grant exists", async () => {
    const currentFolder = mkTmp("relay-current-baseline-");
    const resolver = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore([]),
      expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("relay-current-baseline-home-"),
        platform: process.platform,
      }),
    });

    expect(await resolver(currentFolder)).toEqual({ ok: true, workspace: currentFolder, access: ["read", "create_modify", "delete", "execute"] });
  });

  test("a most-specific durable read-only grant constrains and denies the baseline", async () => {
    const parent = mkTmp("relay-current-most-specific-parent-");
    const currentFolder = join(parent, "project");
    mkdirSync(currentFolder);
    const resolver = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore([
        grant("durable-parent", {
          root: parent,
          access: ["read", "execute", "create_modify"],
          origin: "user_picker",
          lifetime: "durable",
          filesystemIdentity: { realRoot: parent },
        }),
        grant("durable-project-read-only", {
          root: currentFolder,
          access: ["read", "execute"],
          origin: "user_picker",
          lifetime: "durable",
          filesystemIdentity: { realRoot: currentFolder },
        }),
      ]),
      expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("relay-current-most-specific-home-"),
        platform: process.platform,
      }),
    });

    expect(await resolver(currentFolder)).toEqual({
      ok: false,
      code: "WORKSTATION_SHELL_WORKSPACE_UNAUTHORIZED",
    });
  });

  test("protected Current Folder and a replaced baseline both fail closed", async () => {
    const home = mkTmp("relay-current-protected-home-");
    const protectedFolder = join(home, ".ssh");
    mkdirSync(protectedFolder);
    const protectedResolver = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore([]),
      expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({ homeDir: home, platform: process.platform }),
    });
    expect(await protectedResolver(protectedFolder)).toEqual({
      ok: false,
      code: "WORKSTATION_SHELL_WORKSPACE_PROTECTED",
    });

    const currentFolder = mkTmp("relay-current-replaced-");
    const resolver = createLocalShellWorkspaceAuthorityResolver({
      store: makeStore([]),
      expectedSubject: subject,
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("relay-current-replaced-home-"),
        platform: process.platform,
      }),
    });
    expect(await resolver(currentFolder)).toEqual({ ok: true, workspace: currentFolder, access: ["read", "create_modify", "delete", "execute"] });
    rmSync(currentFolder, { recursive: true });
    mkdirSync(currentFolder);
    expect(await resolver(currentFolder)).toEqual({
      ok: false,
      code: "WORKSTATION_SHELL_WORKSPACE_IDENTITY_MISMATCH",
    });
  });
});

// ---------------------------------------------------------------------------
// makeDispatchHandler — envelope augmentation wiring
// ---------------------------------------------------------------------------

describe("profileNetworkPolicyToRelayNetworkPolicy", () => {
  test("maps host mode exactly", () => {
    const r = profileNetworkPolicyToRelayNetworkPolicy({ mode: "host", allow: [] });
    expect(r).toEqual({ ok: true, relay: { mode: "host" } });
  });

  test("maps isolated mode exactly", () => {
    const r = profileNetworkPolicyToRelayNetworkPolicy({ mode: "isolated", allow: [] });
    expect(r).toEqual({ ok: true, relay: { mode: "isolated" } });
  });

  test("maps representable proxy_allowlist rules (host/domain → domain, cidr → cidr)", () => {
    const r = profileNetworkPolicyToRelayNetworkPolicy({
      mode: "proxy_allowlist",
      allow: [
        { id: "h", kind: "host", value: "api.example.com" },
        { id: "d", kind: "domain", value: "registry.npmjs.org" },
        { id: "c", kind: "cidr", value: "192.0.2.0/24" },
      ],
    });
    expect(r).toEqual({
      ok: true,
      relay: {
        mode: "proxy-allowlist",
        allow: [
          { type: "domain", host: "api.example.com" },
          { type: "domain", host: "registry.npmjs.org" },
          { type: "cidr", cidr: "192.0.2.0/24" },
        ],
      },
    });
  });

  test("fails closed on a port-only rule (no representable wire shape)", () => {
    const r = profileNetworkPolicyToRelayNetworkPolicy({
      mode: "proxy_allowlist",
      allow: [
        { id: "d", kind: "domain", value: "registry.npmjs.org" },
        { id: "p", kind: "port", value: "8081" },
      ],
    });
    expect(r).toEqual({
      ok: false,
      code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNREPRESENTABLE",
    });
  });
});

// ---------------------------------------------------------------------------
// buildShellBindingSandboxEnvelope REPLACES the server network policy
// ---------------------------------------------------------------------------

describe("buildShellBindingSandboxEnvelope network replacement", () => {
  test("REPLACES the server network policy with the locally sourced one", () => {
    const base = baseEnvelope("/tmp");
    base.config.networkPolicy = { mode: "host" };
    const env = buildShellBindingSandboxEnvelope(
      base,
      { readOnlyRoots: [mkTmp("relay-net-replace-")], writableRoots: [] },
      undefined,
      undefined,
      undefined,
      { mode: "isolated" },
    );
    expect(env.config.networkPolicy).toEqual({ mode: "isolated" });
  });

  test("does NOT preserve the server network policy when none is supplied", () => {
    const base = baseEnvelope("/tmp");
    base.config.networkPolicy = { mode: "host" };
    const env = buildShellBindingSandboxEnvelope(
      base,
      { readOnlyRoots: [mkTmp("relay-net-drop-")], writableRoots: [] },
      undefined,
    );
    // The server's host posture is dropped — never carried into the guarded
    // envelope. The builder does not preserve base.config.networkPolicy.
    expect(env.config.networkPolicy).toBeUndefined();
  });

  test("threads a proxy-allowlist policy through verbatim", () => {
    const env = buildShellBindingSandboxEnvelope(
      baseEnvelope("/tmp"),
      { readOnlyRoots: [mkTmp("relay-net-proxy-")], writableRoots: [] },
      undefined,
      undefined,
      undefined,
      {
        mode: "proxy-allowlist",
        allow: [{ type: "domain", host: "registry.npmjs.org" }],
      },
    );
    expect(env.config.networkPolicy).toEqual({
      mode: "proxy-allowlist",
      allow: [{ type: "domain", host: "registry.npmjs.org" }],
    });
  });
});

// ---------------------------------------------------------------------------
// shell-binding resolver sources + returns the local network policy
// ---------------------------------------------------------------------------

describe("shell-binding resolver network policy sourcing", () => {
  test("a successful resolution carries the locally sourced network policy", async () => {
    const grants = [grant("grant-1")];
    const resolve = createWorkstationShellBindingAuthorityResolver({
      store: makeStore(grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      getCapabilityRevision: () => 5,
      getCurrentFolder: () => "/tmp",
      profileProvider: makeProfileProvider(profileSnapshot(2)),
      networkPolicyProvider: makeNetworkPolicyProvider({
        mode: "proxy_allowlist",
        allow: [{ id: "d", kind: "domain", value: "registry.npmjs.org" }],
      }),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
    });
    const r = await resolve({ binding: binding(), concreteOperation: "execute" });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.networkPolicy).toEqual({
        mode: "proxy-allowlist",
        allow: [{ type: "domain", host: "registry.npmjs.org" }],
      });
    }
  });

  test("fails closed when no network policy provider is configured", async () => {
    const grants = [grant("grant-1")];
    const resolve = createWorkstationShellBindingAuthorityResolver({
      store: makeStore(grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      getCapabilityRevision: () => 5,
      getCurrentFolder: () => "/tmp",
      profileProvider: makeProfileProvider(profileSnapshot(2)),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
    });
    const r = await resolve({ binding: binding(), concreteOperation: "execute" });
    expect(r).toMatchObject({
      ok: false,
      code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNAVAILABLE",
    });
  });

  test("fails closed when the provider has no active profile (null policy)", async () => {
    const grants = [grant("grant-1")];
    const resolve = createWorkstationShellBindingAuthorityResolver({
      store: makeStore(grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      getCapabilityRevision: () => 5,
      getCurrentFolder: () => "/tmp",
      profileProvider: makeProfileProvider(profileSnapshot(2)),
      networkPolicyProvider: makeNetworkPolicyProvider(null),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
    });
    const r = await resolve({ binding: binding(), concreteOperation: "execute" });
    expect(r).toMatchObject({
      ok: false,
      code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNAVAILABLE",
    });
  });

  test("fails closed when the active profile policy carries an unrepresentable rule", async () => {
    const grants = [grant("grant-1")];
    const resolve = createWorkstationShellBindingAuthorityResolver({
      store: makeStore(grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      getCapabilityRevision: () => 5,
      getCurrentFolder: () => "/tmp",
      profileProvider: makeProfileProvider(profileSnapshot(2)),
      networkPolicyProvider: makeNetworkPolicyProvider({
        mode: "proxy_allowlist",
        allow: [{ id: "p", kind: "port", value: "8081" }],
      }),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
    });
    const r = await resolve({ binding: binding(), concreteOperation: "execute" });
    expect(r).toMatchObject({
      ok: false,
      code: "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNREPRESENTABLE",
    });
  });

  test("a binding failure short-circuits before sourcing the network policy", async () => {
    const grants = [grant("grant-1")];
    let networkQueried = false;
    const resolve = createWorkstationShellBindingAuthorityResolver({
      store: makeStore(grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      getCapabilityRevision: () => 5,
      getCurrentFolder: () => "/tmp",
      profileProvider: makeProfileProvider(profileSnapshot(99)),
      networkPolicyProvider: {
        getActiveNetworkPolicy: () => {
          networkQueried = true;
          return Promise.resolve(ISOLATED_NETWORK_POLICY satisfies ProfileNetworkPolicy);
        },
      },
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
    });
    const r = await resolve({ binding: binding(), concreteOperation: "execute" });
    expect(r).toMatchObject({ ok: false, code: "PROFILE_BINDING_MISMATCH" });
    expect(networkQueried).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// makeDispatchHandler wires the local network policy into the envelope
// ---------------------------------------------------------------------------

describe("retired Desktop agent shell dispatch", () => {
  test.each([
    ["run_shell", { command: "touch must-not-run" }],
    ["terminal", { action: "run", data: "touch must-not-run" }],
  ] as const)("%s returns an upgrade refusal before sandbox construction", async (toolName, args) => {
    let sandboxCalls = 0;
    const handler = makeDispatchHandler(
      createWorkspaceGuard({ workspaceRoot: "/tmp" }),
      {
        createSandbox: () => {
          sandboxCalls += 1;
          return Promise.resolve(makeSandbox());
        },
      },
    );

    const result = await handler(mkRequest({ toolName, args }));
    expect(result).toMatchObject({
      status: "error",
      errorCode: "LOCAL_EXECUTION_UPGRADE_REQUIRED",
    });
    expect(result.status === "error" && result.error).toContain("exec_command");
    expect(sandboxCalls).toBe(0);
  });
});


describe("trusted user environment command policy", () => {
  test("HOME credentials are admitted only by local Development authority while internal state stays masked", () => {
    const home = mkTmp("trusted-user-home-");
    const policy = buildProtectedPathPolicy({ homeDir: home, platform: "darwin", nautiloRoots: {
      privateRoot: join(home, ".nautilo", "private"), dataRoot: join(home, ".nautilo", "data"),
      auditRoot: join(home, ".nautilo", "audit"),
    } });
    const normal = selectSandboxProtectedPaths(policy);
    const development = selectSandboxProtectedPaths(policy, home);
    expect(normal).toContain(join(home, ".config", "gh"));
    expect(normal).toContain(join(home, ".ssh"));
    expect(development).not.toContain(join(home, ".config", "gh"));
    expect(development).not.toContain(join(home, ".ssh"));
    expect(development).not.toContain(join(home, "Library", "Keychains"));
    expect(development).toContain(join(home, ".nautilo", "private"));
    expect(development).toContain(join(home, ".nautilo", "data"));
    expect(development).toContain(join(home, ".nautilo", "audit"));
    expect(development).toContain("/etc/shadow");
    expect(selectSandboxProtectedPaths(policy, join(home, "other"))).toEqual(normal);
    const base = baseEnvelope();
    const scratch = { workspace: home, protectedFileMaskPath: join(home, "mask") };
    const ordinary = buildShellBindingSandboxEnvelope(base, { readOnlyRoots: [], writableRoots: [] }, policy, "/usr/bin", scratch);
    expect(ordinary.config.writablePaths).not.toContain(home);
    const trusted = buildShellBindingSandboxEnvelope(base, { readOnlyRoots: [], writableRoots: [] }, policy, "/usr/bin", scratch,
      { mode: "host" }, base.workspace, { home, writablePaths: ["/fixture/install"], readOnlyPaths: ["/fixture/gh"] });
    expect(trusted.config.writablePaths).toEqual([home, "/fixture/install"]);
    expect(trusted.config.readOnlyPaths).toEqual(["/fixture/gh"]);
    expect(trusted.config.protectedPaths).toEqual(development);
  });
});
