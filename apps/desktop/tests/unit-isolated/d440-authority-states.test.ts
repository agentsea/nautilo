/**
 * D440 Phase 0 tasks 0.1.1 / 0.1.3 — local authority-state fixtures.
 *
 * Smallest reusable D350/D418 fixture set (kept local so Phase 0 does not
 * change shared helpers):
 *   - `createWorkspaceGuard` + `sandboxProfile.workspace`: baseline Current
 *     Folder authority;
 *   - active profile snapshot + plan-derived shell binding: workstation mode;
 *   - `createWorkstationShellBindingAuthorityResolver`: profile grant binding;
 *   - `createLocalShellWorkspaceAuthorityResolver`: transient, identity-bound
 *     Current Folder baseline plus any explicit durable grant constraint;
 *   - `makeDispatchHandler`: relay revalidation and sandbox-envelope seam.
 *
 * The profile grant and Current Folder baseline are deliberately independent.
 * Activating a profile never persists or broadens a project grant.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, type Sandbox } from "@nautilo/sandbox";
import {
  createWorkspaceGuard,
  RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  type RelayDispatchRequest,
  type RelaySandboxProfile,
  type RelayWorkstationProfileSnapshot,
  type RelayWorkstationShellBinding,
} from "@nautilo/relay";
import { buildProtectedPathPolicy } from "@nautilo/security";
import type {
  DesktopFilesystemAccessOperation,
  DesktopFilesystemGrant,
} from "@nautilo/desktop-filesystem-grants";
import type {
  RelayWorkstationProfileSnapshotProvider,
  DesktopFilesystemGrantAuthorityStore,
} from "../../electron/relay";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-d440-test-userdata" },
}));

let makeDispatchHandler: typeof import("../../electron/relay").makeDispatchHandler;
let createWorkstationShellBindingAuthorityResolver:
  typeof import("../../electron/relay").createWorkstationShellBindingAuthorityResolver;
let createLocalShellWorkspaceAuthorityResolver:
  typeof import("../../electron/relay").createLocalShellWorkspaceAuthorityResolver;

beforeAll(async () => {
  ({
    makeDispatchHandler,
    createWorkstationShellBindingAuthorityResolver,
    createLocalShellWorkspaceAuthorityResolver,
  } = await import("../../electron/relay"));
});

const USER = "d440-user";
const INSTANCE = "instance-1";
const RELAY = "d440-relay";
const DESKTOP = "d440-desktop-session";
const PROFILE = "developer-workstation";
const SUBJECT = {
  userId: USER,
  instanceId: INSTANCE,
  relayId: RELAY,
  agentScope: "all_owned_agents",
};

type ListedGrant = {
  grant: DesktopFilesystemGrant;
  status: "active" | "revoked" | "expired";
};

function grant(
  id: string,
  root: string,
  access: readonly DesktopFilesystemAccessOperation[],
  overrides: Partial<DesktopFilesystemGrant> = {},
): ListedGrant {
  return {
    grant: {
      schemaVersion: 1,
      id,
      canonicalRoot: root,
      access,
      origin: "policy_pack",
      lifetime: "session",
      subject: SUBJECT,
      createdBy: USER,
      createdAt: "2026-07-20T12:00:00.000Z",
      policyVersion: 1,
      ...overrides,
    },
    status: "active",
  };
}

function store(grants: readonly ListedGrant[]): DesktopFilesystemGrantAuthorityStore {
  return {
    async list() {
      return { ok: true, data: { grants: [...grants], revision: 8 } };
    },
  };
}

function profileSnapshot(): RelayWorkstationProfileSnapshot {
  return {
    profileId: PROFILE,
    profileRevision: 4,
    grantIds: ["profile-tools"],
    protectedPolicyVersion: 3,
    networkMode: "isolated",
    capabilities: [],
  };
}

function profileProvider(): RelayWorkstationProfileSnapshotProvider {
  return { getProfileSnapshot: async () => profileSnapshot() };
}

function binding(): RelayWorkstationShellBinding {
  return {
    version: RELAY_WORKSTATION_SHELL_BINDING_VERSION,
    toolCallId: "d440-shell-call",
    relayId: RELAY,
    desktopSessionId: DESKTOP,
    serverBindingId: "server-binding-1",
    pairingGeneration: "pairing-generation-1",
    profileId: PROFILE,
    profileRevision: 4,
    grantIds: ["profile-tools"],
    capabilityRevision: 9,
    currentFolder: "/Users/d440/exact-project",
    grantRevision: 8,
    protectedPolicyVersion: 3,
    subject: SUBJECT,
    operation: "execute",
    executionClass: RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  };
}

function sandboxProfile(workspace: string): RelaySandboxProfile {
  return {
    workspace,
    dataDir: join(workspace, ".data"),
    toolsBin: "/usr/bin",
    mode: "desktop-permissive",
    securityLevel: "standard",
    failIfNoBackend: false,
    config: {
      mode: "disabled",
      writablePaths: [workspace],
      projectPaths: [workspace],
      passthroughEnv: [],
    },
  };
}

function request(workspace: string, withBinding: boolean): RelayDispatchRequest {
  return {
    correlationId: "d440-request",
    toolName: "run_shell",
    args: { command: "/bin/pwd" },
    impact: "low",
    approvalObtained: true,
    sandboxProfile: sandboxProfile(workspace),
    ...(withBinding
      ? { workstationShellBinding: { ...binding(), currentFolder: workspace } }
      : {}),
  };
}

function directSandbox(envelope: RelaySandboxProfile): Sandbox {
  return {
    containmentActive: () => true,
    protectedFileMaskSupported: () => true,
    wrap: (
      program: string,
      args: readonly string[],
      cwd: string,
      env: Readonly<Record<string, string>>,
    ) => ({ program, args: [...args], cwd, env }),
    close: async () => {},
  } as unknown as Sandbox;
}

function workstationShellAuthority(
  grants: readonly ListedGrant[],
  currentFolder: string,
) {
  return createWorkstationShellBindingAuthorityResolver({
    store: store(grants),
    expectedRelayId: RELAY,
    expectedDesktopSessionId: DESKTOP,
    getCapabilityRevision: () => 9,
    getCurrentFolder: () => currentFolder,
    profileProvider: profileProvider(),
    networkPolicyProvider: {
      getActiveNetworkPolicy: async () => ({ mode: "isolated", allow: [] }),
    },
    expectedSubject: SUBJECT,
    now: () => new Date("2026-07-20T12:01:00.000Z"),
  });
}

describe("D440 authority states", () => {
  test("baseline Current Folder reaches the ordinary sandbox unchanged", async () => {
    const currentFolder = canonicalize(mkdtempSync(join(tmpdir(), "d440-baseline-")));
    let captured: RelaySandboxProfile | undefined;
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: currentFolder }), {
      createSandbox: async (envelope) => {
        captured = envelope;
        return directSandbox(envelope);
      },
    });

    const result = await handler(request(currentFolder, false));

    expect(result.status).toBe("ok");
    expect(captured).toEqual(sandboxProfile(currentFolder));
  });

  test("active Developer Workstation authorizes Current Folder without a duplicate project grant", async () => {
    const currentFolder = canonicalize(mkdtempSync(join(tmpdir(), "d440-ungranted-project-")));
    const profileRoot = canonicalize(mkdtempSync(join(tmpdir(), "d440-profile-tools-")));
    const grants = [grant("profile-tools", profileRoot, ["read", "execute"])];
    let sandboxConstructed = false;
    const localAuthority = createLocalShellWorkspaceAuthorityResolver({
      store: store(grants),
      expectedSubject: SUBJECT,
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: canonicalize(mkdtempSync(join(tmpdir(), "d440-home-"))),
        platform: process.platform,
      }),
      revalidateIdentity: async (filesystemIdentity) => ({
        ok: true,
        canonicalRoot: filesystemIdentity.realRoot,
        filesystemIdentity,
      }),
    });
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: currentFolder }), {
      relayId: RELAY,
      workstationShellBindingAuthority: workstationShellAuthority(grants, currentFolder),
      getLocalWorkspacePath: () => currentFolder,
      localShellWorkspaceAuthority: localAuthority,
      createSandbox: async (envelope) => {
        sandboxConstructed = true;
        return directSandbox(envelope);
      },
    });

    const result = await handler(request(currentFolder, true));

    expect(result.status).toBe("ok");
    expect(sandboxConstructed).toBe(true);
  });

  test("exact durable project grant authorizes only that Current Folder and reaches sandbox", async () => {
    const currentFolder = canonicalize(mkdtempSync(join(tmpdir(), "d440-granted-project-")));
    const profileRoot = canonicalize(mkdtempSync(join(tmpdir(), "d440-profile-tools-")));
    const grants = [
      grant("profile-tools", profileRoot, ["read", "execute"]),
      grant(
        "durable-project",
        currentFolder,
        ["read", "create_modify", "delete", "execute"],
        {
          origin: "user_picker",
          lifetime: "durable",
          filesystemIdentity: { realRoot: currentFolder },
        },
      ),
    ];
    let captured: RelaySandboxProfile | undefined;
    const localAuthority = createLocalShellWorkspaceAuthorityResolver({
      store: store(grants),
      expectedSubject: SUBJECT,
      protectedPathPolicy: buildProtectedPathPolicy({
        homeDir: canonicalize(mkdtempSync(join(tmpdir(), "d440-home-"))),
        platform: process.platform,
      }),
      revalidateIdentity: async (filesystemIdentity) => ({
        ok: true,
        canonicalRoot: filesystemIdentity.realRoot,
        filesystemIdentity,
      }),
    });
    const handler = makeDispatchHandler(createWorkspaceGuard({ workspaceRoot: currentFolder }), {
      relayId: RELAY,
      workstationShellBindingAuthority: workstationShellAuthority(grants, currentFolder),
      getLocalWorkspacePath: () => currentFolder,
      localShellWorkspaceAuthority: localAuthority,
      trustedToolsBin: "/usr/bin",
      createSandbox: async (envelope) => {
        captured = envelope;
        return directSandbox(envelope);
      },
    });

    const result = await handler(request(currentFolder, true));

    expect(result.status).toBe("ok");
    expect(captured?.workspace).toBe(currentFolder);
    expect(captured?.config.writablePaths).toContain(currentFolder);
    expect(captured?.config.writablePaths).not.toContain(profileRoot);
    expect(captured?.config.networkPolicy).toEqual({ mode: "isolated" });
    expect(captured?.failIfNoBackend).toBe(true);
  });
});
