/**
 * Desktop revalidation of a profile-bound workstation authority reference.
 *
 * Validates:
 * Pure authority coverage remains relevant to managed execution and typed Git:
 * successful validation returns exact profile roots, while stale, revoked,
 * foreign, or mismatched references fail closed with stable codes.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import {
  RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
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

// `../../electron/relay` transitively imports `./paths`, which imports the
// Electron `app`. Under `bun test` (no Electron runtime) that module throws at
// load, so we stub it before dynamically importing the handler below.
mock.module("electron", () => ({
  app: { getPath: () => "/tmp/nautilo-test-userdata" },
}));

let revalidateWorkstationShellBinding: typeof import("../../electron/relay").revalidateWorkstationShellBinding;
let createWorkstationShellBindingAuthorityResolver: typeof import("../../electron/relay").createWorkstationShellBindingAuthorityResolver;

beforeAll(async () => {
  ({
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
