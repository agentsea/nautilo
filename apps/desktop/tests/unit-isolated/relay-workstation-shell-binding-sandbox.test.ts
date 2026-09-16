/**
 * D418 task 3.2.1 — desktop relay compiles the revalidated policy-pack
 * grant roots + canonical protected-path policy into the per-turn sandbox
 * envelope for a planned generic `run_shell` dispatch.
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
 *   3. `makeDispatchHandler`: a valid shell binding passes an AUGMENTED
 *      envelope (profile-bound roots + protected paths) to the sandbox
 *      factory; the shell still runs sandboxed (no unsandboxed fallback).
 *   4. Invalid / missing / stale / mismatched binding stays baseline
 *      behavior — no envelope augmentation, no authority, stable denial.
 *   5. The server's `allowedRoots` is never authority and never widened.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Sandbox,
  canonicalize,
  type SandboxBackend,
  type SandboxConfig,
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
import { resolveContainedWorkstationIdentityProjection } from "../../electron/relay-dispatch/workstation-identity";

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

function makeProfileProvider(
  snapshot: RelayWorkstationProfileSnapshot | undefined,
): RelayWorkstationProfileSnapshotProvider {
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

function makeDisabledSandbox(workspace: string): Sandbox {
  return new Sandbox({
    config: {
      mode: "disabled",
      writablePaths: [],
      projectPaths: [],
      passthroughEnv: [],
    },
    workspace,
    dataDir: `${workspace}/data`,
    toolsBin: `${workspace}/tools`,
    backend: { kind: "none" },
  });
}

function makeBubblewrapWithoutFileMask(workspace: string): Sandbox {
  return new Sandbox({
    config: {
      mode: "enabled",
      writablePaths: [],
      projectPaths: [],
      passthroughEnv: [],
    },
    workspace,
    dataDir: `${workspace}/data`,
    toolsBin: `${workspace}/tools`,
    backend: { kind: "bubblewrap", procSupported: true, fileMaskSupported: false },
  });
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
    toolName: "run_shell",
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

describe("D574 — contained workstation identity projection", () => {
  test("projects a github.com-scoped credential helper and keeps HOME implicit", async () => {
    const home = mkTmp("relay-workstation-identity-");
    const ghConfigDir = join(home, ".config", "gh");
    mkdirSync(ghConfigDir, { recursive: true });
    writeFileSync(join(ghConfigDir, "hosts.yml"), "github.com: {}\n");

    const token = "ghp_contained_test_token_1234567890";
    const projection = await resolveContainedWorkstationIdentityProjection(
      home,
      async () => token,
    );

    expect(projection.commandEnv).toEqual({
      GH_TOKEN: token,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      GH_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    });
    expect(projection.outputSecrets).toEqual([Buffer.from(token)]);
    expect(projection.commandEnv).not.toHaveProperty("HOME");
    expect(projection.commandEnv).not.toHaveProperty("GIT_CONFIG_GLOBAL");
  });

  test("does not read a token when no gh configuration exists", async () => {
    const home = mkTmp("relay-workstation-no-gh-identity-");
    let tokenRead = false;
    const projection = await resolveContainedWorkstationIdentityProjection(
      home,
      async () => {
        tokenRead = true;
        return "must-not-be-read";
      },
    );

    expect(tokenRead).toBe(false);
    expect(projection).toEqual({ commandEnv: {}, outputSecrets: [] });
  });

  test("the GitHub credential read follows dispatch cancellation instead of a local timer", async () => {
    const home = mkTmp("relay-workstation-cancelled-gh-identity-");
    mkdirSync(join(home, ".config", "gh"), { recursive: true });
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;

    await resolveContainedWorkstationIdentityProjection(
      home,
      async (signal) => {
        observedSignal = signal;
        return null;
      },
      controller.signal,
    );

    expect(observedSignal).toBe(controller.signal);
  });

  test("returns an empty projection when no supported local identity exists", async () => {
    const home = mkTmp("relay-workstation-empty-identity-");
    expect(await resolveContainedWorkstationIdentityProjection(home)).toEqual({
      commandEnv: {},
      outputSecrets: [],
    });
  });
});

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
        toolName: "run_shell",
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
        toolName: "run_shell",
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

describe("D418 3.2.1 — selectSandboxProtectedPaths curation", () => {
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

describe("D418 3.2.1 — buildShellBindingSandboxEnvelope", () => {
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

describe("D418 — local Current Folder shell authority", () => {
  const subject = {
    userId: USER,
    instanceId: INSTANCE,
    relayId: RELAY,
    agentScope: AGENT_SCOPE,
  };

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

    expect(await resolver(currentFolder)).toEqual({ ok: true, workspace: currentFolder });
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
    expect(await resolver(currentFolder)).toEqual({ ok: true, workspace: currentFolder });
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

describe("D418 3.2.1 — makeDispatchHandler envelope augmentation", () => {
  const savedLdPreload = process.env["LD_PRELOAD"];
  beforeEach(() => {
    delete process.env["LD_PRELOAD"];
  });
  afterEach(() => {
    if (savedLdPreload === undefined) delete process.env["LD_PRELOAD"];
    else process.env["LD_PRELOAD"] = savedLdPreload;
  });

  function resolver(options: {
    grants: Array<{ grant: DesktopFilesystemGrant; status: "active" | "revoked" | "expired" }>;
    profile?: RelayWorkstationProfileSnapshot | undefined;
    capabilityRevision?: number;
    currentFolder?: string;
    networkPolicy?: import("@nautilo/workstation-profiles").ProfileNetworkPolicy | null;
  }) {
    return createWorkstationShellBindingAuthorityResolver({
      store: makeStore(options.grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
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

  test("valid binding ⇒ sandbox factory receives an augmented envelope with the profile root + protected paths", async () => {
    const profileRoot = mkTmp("relay-dispatch-root-");
    const home = mkTmp("relay-dispatch-home-");
    const policy = buildProtectedPathPolicy({
      homeDir: home,
      platform: process.platform,
    });
    const grants = [grant("grant-1", { root: profileRoot })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-dispatch-guard-") });

    let captured: RelaySandboxProfile | undefined;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      protectedPathPolicy: policy,
      trustedToolsBin: "/trusted/local/tools",
      createSandbox: (envelope) => {
        captured = envelope as RelaySandboxProfile;
        return Promise.resolve(makeSandbox(envelope.workspace));
      },
    });

    const r = await handler(
      mkRequest({
        allowedRoots: ["/untrusted-server-root"],
        sandboxProfile: baseEnvelope("/tmp"),
        args: { command: "/bin/pwd" },
        workstationShellBinding: binding(),
      }),
    );

    expect(r.status).toBe("ok");
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      // The profile-bound root is the sandbox writable surface — derived
      // from the revalidated grant, NOT the server's allowedRoots.
      expect(captured.config.readOnlyPaths).toContain(profileRoot);
      expect(captured.config.writablePaths).not.toContain("/untrusted-server-root");
      expect(captured.toolsBin).toBe("/trusted/local/tools");
      expect(captured.toolsBin).not.toBe("/tmp/tools");
      // The canonical protected-path policy is compiled in.
      expect(captured.config.protectedPaths).toBeDefined();
      if (captured.config.protectedPaths !== undefined) {
        expect(captured.config.protectedPaths).toContain(join(home, ".ssh"));
      }
    }
  });

  test("valid binding projects and redacts gh identity without mounting HOME or gh config", async () => {
    const profileRoot = mkTmp("relay-dispatch-identity-root-");
    const home = mkTmp("relay-dispatch-identity-home-");
    const ghConfigDir = join(home, ".config", "gh");
    mkdirSync(ghConfigDir, { recursive: true });
    writeFileSync(join(ghConfigDir, "hosts.yml"), "github.com: {}\n");
    const grants = [grant("grant-1", { root: profileRoot })];
    const guard = createWorkspaceGuard({
      workspaceRoot: mkTmp("relay-dispatch-identity-guard-"),
    });

    let captured: RelaySandboxProfile | undefined;
    const projectedToken = "ghp_dispatch_test_token_1234567890";
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      workstationIdentityHomePath: home,
      readWorkstationGitHubToken: async () => projectedToken,
      createSandbox: (envelope) => {
        captured = envelope as RelaySandboxProfile;
        return Promise.resolve(makeSandbox(envelope.workspace));
      },
    });

    const result = await handler(
      mkRequest({
        sandboxProfile: baseEnvelope("/tmp"),
        args: { command: "printf '%s' \"$GH_TOKEN\"" },
        workstationShellBinding: binding(),
      }),
    );

    expect(result.status).toBe("ok");
    expect(captured?.config.readOnlyPaths).not.toContain(ghConfigDir);
    expect(captured?.config.readOnlyPaths).not.toContain(home);
    if (result.status === "ok") {
      const stdout = (result.result as { stdout: string }).stdout;
      expect(stdout).toStartWith("[REDACTED]");
      expect(stdout).not.toContain(projectedToken);
    }
  });

  test("valid binding resolves the local workspace at dispatch time", async () => {
    const profileRoot = mkTmp("relay-dispatch-live-workspace-root-");
    const currentFolder = join(profileRoot, "current-project");
    mkdirSync(currentFolder);
    const grants = [
      grant("grant-1", { root: profileRoot, access: ["execute", "read", "create_modify"] }),
    ];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-dispatch-live-workspace-guard-") });
    let captured: RelaySandboxProfile | undefined;
    let allowedWorkspaceGovernanceWrites = false;

    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants, currentFolder }),
      getLocalWorkspacePath: () => currentFolder,
      localShellWorkspaceAuthority: async (candidate) => ({
        ok: true,
        workspace: candidate,
      }),
      createSandbox: (envelope, localAuthority) => {
        captured = envelope as RelaySandboxProfile;
        allowedWorkspaceGovernanceWrites =
          localAuthority?.allowWorkspaceGovernanceWrites === true;
        return Promise.resolve(makeSandbox(envelope.workspace));
      },
    });

    const result = await handler(
      mkRequest({
        sandboxProfile: baseEnvelope("/server-supplied-workspace"),
        args: { command: "/bin/pwd" },
        workstationShellBinding: binding({ currentFolder }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(captured?.workspace).toBe(currentFolder);
    expect(allowedWorkspaceGovernanceWrites).toBe(true);
  });

  test("valid binding with no protectedPathPolicy ⇒ envelope has profile root but no protectedPaths", async () => {
    const profileRoot = mkTmp("relay-dispatch-nopp-root-");
    const grants = [grant("grant-1", { root: profileRoot })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-dispatch-nopp-guard-") });

    let captured: RelaySandboxProfile | undefined;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      createSandbox: (envelope) => {
        captured = envelope as RelaySandboxProfile;
        return Promise.resolve(makeSandbox(envelope.workspace));
      },
    });

    const r = await handler(
      mkRequest({ sandboxProfile: baseEnvelope("/tmp"), workstationShellBinding: binding() }),
    );

    expect(r.status).toBe("ok");
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      expect(captured.config.readOnlyPaths).toContain(profileRoot);
      expect(captured.config.protectedPaths).toBeUndefined();
    }
  });

  test("non-Full-Mode (no binding) ⇒ envelope is byte-for-byte baseline (no augmentation)", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-dispatch-baseline-guard-") });
    const baseline = baseEnvelope("/tmp");

    let captured: RelaySandboxProfile | undefined;
    let allowedWorkspaceGovernanceWrites = true;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants: [grant("grant-1")] }),
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("relay-dispatch-baseline-home-"),
        platform: process.platform,
      }),
      createSandbox: (envelope, localAuthority) => {
        captured = envelope as RelaySandboxProfile;
        allowedWorkspaceGovernanceWrites =
          localAuthority?.allowWorkspaceGovernanceWrites === true;
        return Promise.resolve(makeSandbox("/tmp"));
      },
    });

    const r = await handler(
      mkRequest({ sandboxProfile: baseline, args: { command: "/bin/pwd" } }),
    );

    expect(r.status).toBe("ok");
    expect(captured).toBeDefined();
    expect(allowedWorkspaceGovernanceWrites).toBe(false);
    if (captured !== undefined) {
      // Baseline envelope is passed through unchanged — no profile root,
      // no protectedPaths. The server's writablePaths are preserved.
      expect(captured.config.writablePaths).toEqual(["/server/supplied/writable"]);
      expect(captured.config.protectedPaths).toBeUndefined();
    }
  });

  test("stale binding ⇒ stable denial, sandbox factory never invoked", async () => {
    const grants = [grant("grant-1")];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-dispatch-stale-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants, profile: profileSnapshot(99) }),
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: mkTmp("relay-dispatch-stale-home-"),
        platform: process.platform,
      }),
      createSandbox: () => {
        ran = true;
        return Promise.resolve(makeSandbox("/tmp"));
      },
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("PROFILE_BINDING_MISMATCH");
    expect(ran).toBe(false);
  });

  test("binding present but no resolver configured ⇒ UNCONFIGURED, no sandbox", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-dispatch-unconf-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      createSandbox: () => {
        ran = true;
        return Promise.resolve(makeSandbox("/tmp"));
      },
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));

    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("WORKSTATION_SHELL_BINDING_UNCONFIGURED");
    expect(ran).toBe(false);
  });

  test("valid guarded binding refuses a disabled or backend-less sandbox", async () => {
    const profileRoot = mkTmp("relay-dispatch-disabled-root-");
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-dispatch-disabled-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants: [grant("grant-1", { root: profileRoot })] }),
      createSandbox: () => Promise.resolve(makeDisabledSandbox(profileRoot)),
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));
    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("WORKSTATION_SHELL_SANDBOX_UNAVAILABLE");
  });

  test("guarded protected-file policy refuses bwrap without the tested file-mask capability", async () => {
    const profileRoot = mkTmp("relay-dispatch-bwrap-root-");
    const home = mkTmp("relay-dispatch-bwrap-home-");
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-dispatch-bwrap-guard-") });
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants: [grant("grant-1", { root: profileRoot })] }),
      protectedPathPolicy: buildProtectedPathPolicy({ homeDir: home, platform: process.platform }),
      createSandbox: (envelope) => Promise.resolve(makeBubblewrapWithoutFileMask(envelope.workspace)),
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));
    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe("WORKSTATION_SHELL_SANDBOX_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// D418 protected-shell enforcement — a bound run_shell denies a protected
// .ssh sentinel under sandbox-exec (deny-overrides after allows). This live
// Seatbelt proof is macOS-only; Linux containment is covered by bubblewrap
// tests in packages/sandbox.
// ---------------------------------------------------------------------------

if (process.platform === "darwin") {
describe("D418 protected-shell — bound run_shell denies a protected .ssh sentinel", () => {
  const savedLdPreload = process.env["LD_PRELOAD"];
  beforeEach(() => {
    delete process.env["LD_PRELOAD"];
  });
  afterEach(() => {
    if (savedLdPreload === undefined) delete process.env["LD_PRELOAD"];
    else process.env["LD_PRELOAD"] = savedLdPreload;
  });

  function resolver(options: {
    grants: Array<{ grant: DesktopFilesystemGrant; status: "active" | "revoked" | "expired" }>;
    profile?: RelayWorkstationProfileSnapshot | undefined;
    capabilityRevision?: number;
    networkPolicy?: import("@nautilo/workstation-profiles").ProfileNetworkPolicy | null;
  }) {
    return createWorkstationShellBindingAuthorityResolver({
      store: makeStore(options.grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      getCapabilityRevision: () => options.capabilityRevision ?? 5,
      getCurrentFolder: () => "/tmp",
      profileProvider: makeProfileProvider(options.profile ?? profileSnapshot(2)),
      networkPolicyProvider: makeNetworkPolicyProvider(
        options.networkPolicy ?? ISOLATED_NETWORK_POLICY,
      ),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
    });
  }

  // Build a real sandbox-exec Sandbox from the augmented envelope so the
  // canonical protected-path policy is compiled into Seatbelt as
  // deny-overrides — mirroring production `createSandboxFromEnvelope` but
  // with an explicit sandbox-exec backend so the test is deterministic on
  // macOS hosts (the platform that ships sandbox-exec).
  function makeEnvelopeSandbox(envelope: RelaySandboxProfile): Sandbox {
    return new Sandbox({
      config: envelope.config,
      workspace: envelope.workspace,
      dataDir: envelope.dataDir,
      toolsBin: envelope.toolsBin,
      backend: { kind: "sandbox-exec" },
    });
  }

  test("a bound run_shell cannot read a protected .ssh sentinel (deny-overrides win)", async () => {
    const profileRoot = mkTmp("relay-ssh-deny-root-");
    const home = mkTmp("relay-ssh-deny-home-");
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    // Plant the same kind of sentinel the live failure exfiltrated
    // (`head -c 1 ~/.ssh/config`). The sandbox must deny the read.
    writeFileSync(join(sshDir, "config"), "TOP-SECRET-SENTINEL\n");
    const policy = buildProtectedPathPolicy({
      homeDir: home,
      platform: process.platform,
    });
    const grants = [
      grant("grant-1", {
        root: profileRoot,
        access: ["execute", "read", "create_modify"],
      }),
    ];
    const guard = createWorkspaceGuard({
      workspaceRoot: mkTmp("relay-ssh-deny-guard-"),
    });

    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      protectedPathPolicy: policy,
      createSandbox: (envelope) =>
        Promise.resolve(makeEnvelopeSandbox(envelope as RelaySandboxProfile)),
    });

    const r = await handler(
      mkRequest({
        sandboxProfile: baseEnvelope("/tmp"),
        args: { command: `head -c 1 ${join(sshDir, "config")}` },
        workstationShellBinding: binding(),
      }),
    );

    // The protected .ssh sentinel must be denied — never exit 0 with the
    // secret. D502 represents every started process as a canonical receipt,
    // so sandbox-exec denial is a successful relay result with a nonzero
    // process exit rather than a transport error.
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const receipt = r.result as { exitCode: number | null; stdout: string; stderr: string };
      expect(receipt.exitCode).not.toBe(0);
      expect(`${receipt.stdout}${receipt.stderr}`).not.toContain("TOP-SECRET-SENTINEL");
    }
  });

  test("a bound run_shell can still read an unprotected workspace file", async () => {
    const profileRoot = mkTmp("relay-ssh-allow-root-");
    const home = mkTmp("relay-ssh-allow-home-");
    const policy = buildProtectedPathPolicy({
      homeDir: home,
      platform: process.platform,
    });
    const grants = [
      grant("grant-1", {
        root: profileRoot,
        access: ["execute", "read", "create_modify"],
      }),
    ];
    const guard = createWorkspaceGuard({
      workspaceRoot: mkTmp("relay-ssh-allow-guard-"),
    });
    // A non-protected file inside the profile root stays readable.
    const allowedFile = join(profileRoot, "allowed.txt");
    writeFileSync(allowedFile, "OK\n");

    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: resolver({ grants }),
      protectedPathPolicy: policy,
      createSandbox: (envelope) =>
        Promise.resolve(makeEnvelopeSandbox(envelope as RelaySandboxProfile)),
    });

    const r = await handler(
      mkRequest({
        sandboxProfile: baseEnvelope("/tmp"),
        args: { command: `cat ${allowedFile}` },
        workstationShellBinding: binding(),
      }),
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string; stderr: string };
      expect(result.stdout.trim()).toBe("OK");
    }
  });
});
}

// ---------------------------------------------------------------------------
// D418 B5 — profile network policy → relay network policy conversion
// ---------------------------------------------------------------------------

describe("D418 B5 — profileNetworkPolicyToRelayNetworkPolicy", () => {
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
        { id: "c", kind: "cidr", value: "10.0.0.0/8" },
      ],
    });
    expect(r).toEqual({
      ok: true,
      relay: {
        mode: "proxy-allowlist",
        allow: [
          { type: "domain", host: "api.example.com" },
          { type: "domain", host: "registry.npmjs.org" },
          { type: "cidr", cidr: "10.0.0.0/8" },
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
// D418 B5 — buildShellBindingSandboxEnvelope REPLACES the server network policy
// ---------------------------------------------------------------------------

describe("D418 B5 — buildShellBindingSandboxEnvelope network replacement", () => {
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
// D418 B5 — shell-binding resolver sources + returns the local network policy
// ---------------------------------------------------------------------------

describe("D418 B5 — shell-binding resolver network policy sourcing", () => {
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
// D418 B5 — makeDispatchHandler wires the local network policy into the envelope
// ---------------------------------------------------------------------------

describe("D418 B5 — makeDispatchHandler envelope network wiring", () => {
  const savedLdPreload = process.env["LD_PRELOAD"];
  beforeEach(() => {
    delete process.env["LD_PRELOAD"];
  });
  afterEach(() => {
    if (savedLdPreload === undefined) delete process.env["LD_PRELOAD"];
    else process.env["LD_PRELOAD"] = savedLdPreload;
  });

  test("the envelope networkPolicy comes from the local profile, REPLACING the server's", async () => {
    const profileRoot = mkTmp("relay-net-dispatch-root-");
    const grants = [grant("grant-1", { root: profileRoot })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-net-dispatch-guard-") });

    let captured: RelaySandboxProfile | undefined;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: createWorkstationShellBindingAuthorityResolver({
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
      }),
      createSandbox: (envelope) => {
        captured = envelope as RelaySandboxProfile;
        return Promise.resolve(makeSandbox(envelope.workspace));
      },
    });

    const serverEnvelope = baseEnvelope("/tmp");
    // Server tries to impose host networking; the relay must NOT honor it.
    serverEnvelope.config.networkPolicy = { mode: "host" };

    const r = await handler(
      mkRequest({
        sandboxProfile: serverEnvelope,
        args: { command: "/bin/pwd" },
        workstationShellBinding: binding(),
      }),
    );

    expect(r.status).toBe("ok");
    expect(captured).toBeDefined();
    if (captured !== undefined) {
      expect(captured.config.networkPolicy).toEqual({
        mode: "proxy-allowlist",
        allow: [{ type: "domain", host: "registry.npmjs.org" }],
      });
      expect(captured.config.networkPolicy).not.toEqual({ mode: "host" });
    }
  });

  test("an unrepresentable active-profile policy denies the dispatch (fail closed)", async () => {
    const profileRoot = mkTmp("relay-net-unrep-root-");
    const grants = [grant("grant-1", { root: profileRoot })];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-net-unrep-guard-") });
    let ran = false;
    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationShellBindingAuthority: createWorkstationShellBindingAuthorityResolver({
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
      }),
      createSandbox: () => {
        ran = true;
        return Promise.resolve(makeSandbox(profileRoot));
      },
    });

    const r = await handler(mkRequest({ workstationShellBinding: binding() }));
    expect(r.status).toBe("error");
    expect((r as { errorCode?: string }).errorCode).toBe(
      "WORKSTATION_SHELL_BINDING_NETWORK_POLICY_UNREPRESENTABLE",
    );
    expect(ran).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D418 local authority-boundary correction — under an active local profile a
// bound run_shell executes inside a sandbox that denies a protected .ssh
// sentinel (deny-overrides win) while an unprotected workspace file stays
// readable. Mirrors the live failure (`head -c 1 ~/.ssh/config`) that escaped
// the unbound generic sandbox before this gate existed. The live Seatbelt
// proof is macOS-only; Linux containment is covered by bubblewrap tests.
// ---------------------------------------------------------------------------

if (process.platform === "darwin") {
describe("D418 local authority-boundary correction — active profile + valid binding live sandbox", () => {
  const savedLdPreload = process.env["LD_PRELOAD"];
  beforeEach(() => {
    delete process.env["LD_PRELOAD"];
  });
  afterEach(() => {
    if (savedLdPreload === undefined) delete process.env["LD_PRELOAD"];
    else process.env["LD_PRELOAD"] = savedLdPreload;
  });

  function resolver(options: {
    grants: Array<{ grant: DesktopFilesystemGrant; status: "active" | "revoked" | "expired" }>;
    profile?: RelayWorkstationProfileSnapshot | undefined;
    networkPolicy?: import("@nautilo/workstation-profiles").ProfileNetworkPolicy | null;
  }) {
    return createWorkstationShellBindingAuthorityResolver({
      store: makeStore(options.grants),
      expectedRelayId: RELAY,
      expectedDesktopSessionId: DESKTOP,
      getCapabilityRevision: () => 5,
      getCurrentFolder: () => "/tmp",
      profileProvider: makeProfileProvider(options.profile ?? profileSnapshot(2)),
      networkPolicyProvider: makeNetworkPolicyProvider(
        options.networkPolicy ?? ISOLATED_NETWORK_POLICY,
      ),
      expectedSubject: { userId: USER, instanceId: INSTANCE, relayId: RELAY, agentScope: AGENT_SCOPE },
      now: () => NOW,
    });
  }

  function makeEnvelopeSandbox(envelope: RelaySandboxProfile): Sandbox {
    return new Sandbox({
      config: envelope.config,
      workspace: envelope.workspace,
      dataDir: envelope.dataDir,
      toolsBin: envelope.toolsBin,
      backend: { kind: "sandbox-exec" },
    });
  }

  function stateProvider(
    snapshot: RelayWorkstationProfileSnapshot | undefined,
  ): RelayWorkstationProfileSnapshotProvider {
    return { getProfileSnapshot: () => Promise.resolve(snapshot) };
  }

  test("active local profile + valid binding ⇒ live sandbox-exec denies protected .ssh sentinel", async () => {
    const profileRoot = mkTmp("relay-correct-deny-root-");
    const home = mkTmp("relay-correct-deny-home-");
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(join(sshDir, "config"), "TOP-SECRET-SENTINEL\n");
    const policy = buildProtectedPathPolicy({ homeDir: home, platform: process.platform });
    const grants = [
      grant("grant-1", { root: profileRoot, access: ["execute", "read", "create_modify"] }),
    ];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-correct-deny-guard-") });

    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationProfileStateProvider: stateProvider(profileSnapshot(2)),
      workstationShellBindingAuthority: resolver({ grants }),
      protectedPathPolicy: policy,
      createSandbox: (envelope) =>
        Promise.resolve(makeEnvelopeSandbox(envelope as RelaySandboxProfile)),
    });

    const r = await handler(
      mkRequest({
        sandboxProfile: baseEnvelope("/tmp"),
        args: { command: `head -c 1 ${join(sshDir, "config")}` },
        workstationShellBinding: binding(),
      }),
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const receipt = r.result as { exitCode: number | null; stdout: string; stderr: string };
      expect(receipt.exitCode).not.toBe(0);
      expect(`${receipt.stdout}${receipt.stderr}`).not.toContain("TOP-SECRET-SENTINEL");
    }
  });

  test("active local profile + valid binding ⇒ unprotected workspace read still works", async () => {
    const profileRoot = mkTmp("relay-correct-allow-root-");
    const home = mkTmp("relay-correct-allow-home-");
    const policy = buildProtectedPathPolicy({ homeDir: home, platform: process.platform });
    const grants = [
      grant("grant-1", { root: profileRoot, access: ["execute", "read", "create_modify"] }),
    ];
    const guard = createWorkspaceGuard({ workspaceRoot: mkTmp("relay-correct-allow-guard-") });
    const allowedFile = join(profileRoot, "allowed.txt");
    writeFileSync(allowedFile, "OK\n");

    const handler = makeDispatchHandler(guard, {
      relayId: RELAY,
      workstationProfileStateProvider: stateProvider(profileSnapshot(2)),
      workstationShellBindingAuthority: resolver({ grants }),
      protectedPathPolicy: policy,
      createSandbox: (envelope) =>
        Promise.resolve(makeEnvelopeSandbox(envelope as RelaySandboxProfile)),
    });

    const r = await handler(
      mkRequest({
        sandboxProfile: baseEnvelope("/tmp"),
        args: { command: `cat ${allowedFile}` },
        workstationShellBinding: binding(),
      }),
    );

    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const result = r.result as { stdout: string };
      expect(result.stdout.trim()).toBe("OK");
    }
  });
});
}
