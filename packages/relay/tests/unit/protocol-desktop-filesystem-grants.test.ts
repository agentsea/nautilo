import { describe, expect, test } from "bun:test";
import {
  RELAY_PROTOCOL_VERSION,
  DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
  CAPABILITY_UPDATE_PROTOCOL_VERSION,
  RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION,
  parseRelayApplyPatchDesktopFilesystemGrantRequest,
  parseRelayDesktopFilesystemGrantRequest,
  parseRelayDesktopFilesystemGrantSnapshot,
  type RelayDispatchMessage,
  type RelayRegisterMessage,
  type RelayUpdateCapabilitiesMessage,
  type RelayCapabilitiesUpdatedMessage,
  type RelayDesktopFilesystemGrantRequest,
} from "../../src/protocol";
import type { RelayDesktopFilesystemGrantSnapshot } from "../../src/types";

const REQUEST: RelayDesktopFilesystemGrantRequest = {
  version: RELAY_DESKTOP_FILESYSTEM_GRANT_REQUEST_VERSION,
  grantIds: ["grant-1"],
  requestedRoot: "/Users/alice/project",
  operation: "create_modify",
  subject: {
    userId: "user-1",
    instanceId: "instance-1",
    relayId: "relay-1",
    agentScope: "agent-1",
  },
  policy: {
    policyVersion: 3,
    lifetime: "session",
    expiresAt: "2030-01-01T00:00:00.000Z",
  },
};

describe("D418 desktop-filesystem-grant request protocol", () => {
  test("uses protocol v19 and parses the strict v1 reference envelope", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(20);
    expect(DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION).toBe(9);
    expect(CAPABILITY_UPDATE_PROTOCOL_VERSION).toBe(7);
    expect(parseRelayDesktopFilesystemGrantRequest(REQUEST)).toEqual({ ok: true, request: REQUEST });
  });

  test("carries references only, with no relationship to allowedRoots authority", () => {
    const dispatch: RelayDispatchMessage = {
      type: "relay:dispatch",
      correlationId: "corr-1",
      toolName: "local-file",
      args: {},
      impact: "read-only",
      approvalObtained: false,
      allowedRoots: ["/untrusted-server-root"],
      desktopFilesystemGrantRequest: REQUEST,
    };

    expect(dispatch.desktopFilesystemGrantRequest).toEqual(REQUEST);
    expect(dispatch.allowedRoots).toEqual(["/untrusted-server-root"]);
    expect(Object.keys(REQUEST).sort()).toEqual([
      "grantIds",
      "operation",
      "policy",
      "requestedRoot",
      "subject",
      "version",
    ]);
  });

  test("fails closed for unknown versions and unsupported fields", () => {
    expect(parseRelayDesktopFilesystemGrantRequest({ ...REQUEST, version: 2 })).toMatchObject({ ok: false });
    expect(
      parseRelayDesktopFilesystemGrantRequest({
        ...REQUEST,
        platformAuthorization: "must-never-cross-the-wire",
      }),
    ).toMatchObject({ ok: false });
  });

  test("fails closed for malformed subject, operation, root, and stale reference", () => {
    expect(
      parseRelayDesktopFilesystemGrantRequest({
        ...REQUEST,
        subject: { ...REQUEST.subject, relayId: "" },
      }),
    ).toMatchObject({ ok: false });
    expect(parseRelayDesktopFilesystemGrantRequest({ ...REQUEST, operation: "write" })).toMatchObject({ ok: false });
    expect(parseRelayDesktopFilesystemGrantRequest({ ...REQUEST, requestedRoot: "relative/path" })).toMatchObject({
      ok: false,
    });
    expect(
      parseRelayDesktopFilesystemGrantRequest({
        ...REQUEST,
        policy: { ...REQUEST.policy, expiresAt: "not-a-timestamp" },
      }),
    ).toMatchObject({ ok: false });
  });

  test("preserves scalar callers but apply-patch requires a complete operation set", () => {
    expect(parseRelayDesktopFilesystemGrantRequest(REQUEST)).toEqual({ ok: true, request: REQUEST });
    expect(parseRelayApplyPatchDesktopFilesystemGrantRequest(REQUEST)).toMatchObject({ ok: false });

    const applyPatchRequest = {
      ...REQUEST,
      requiredOperations: ["read", "create_modify", "delete"],
    } as const;
    expect(parseRelayApplyPatchDesktopFilesystemGrantRequest(applyPatchRequest)).toEqual({
      ok: true,
      request: applyPatchRequest,
    });
  });

  test("rejects empty, duplicate, unknown, and scalar-mismatched operation sets", () => {
    for (const requiredOperations of [
      [],
      ["read", "read"],
      ["read", "write"],
      ["read", "delete"],
    ]) {
      expect(
        parseRelayDesktopFilesystemGrantRequest({ ...REQUEST, requiredOperations }),
      ).toMatchObject({ ok: false });
    }
  });

  test("D418 default-instance — subject.instanceId accepts the canonical default and named ids", () => {
    // Exact empty string is the canonical default instance and is valid.
    expect(
      parseRelayDesktopFilesystemGrantRequest({
        ...REQUEST,
        subject: { ...REQUEST.subject, instanceId: "" },
      }),
    ).toEqual({
      ok: true,
      request: { ...REQUEST, subject: { ...REQUEST.subject, instanceId: "" } },
    });
    // A canonical lowercase named id is valid.
    expect(
      parseRelayDesktopFilesystemGrantRequest({
        ...REQUEST,
        subject: { ...REQUEST.subject, instanceId: "stack-b" },
      }),
    ).toEqual({
      ok: true,
      request: { ...REQUEST, subject: { ...REQUEST.subject, instanceId: "stack-b" } },
    });
  });

  test("D418 default-instance — subject.instanceId rejects whitespace and noncanonical ids", () => {
    for (const bad of ["  ", "\t", "instance-1 ", " instance-1", "Instance-1", "-bad", "bad!"]) {
      expect(
        parseRelayDesktopFilesystemGrantRequest({
          ...REQUEST,
          subject: { ...REQUEST.subject, instanceId: bad },
        }),
      ).toMatchObject({ ok: false });
    }
    // Non-string instance ids still fail closed.
    expect(
      parseRelayDesktopFilesystemGrantRequest({
        ...REQUEST,
        subject: { ...REQUEST.subject, instanceId: 0 },
      }),
    ).toMatchObject({ ok: false });
  });
});

const SNAPSHOT: RelayDesktopFilesystemGrantSnapshot = {
  revision: 4,
  instanceId: "instance-1",
  agentScope: "all_owned_agents",
  grants: [
    {
      id: "grant-1",
      canonicalRoot: "/Users/alice/project",
      access: ["read", "create_modify"],
      policyVersion: 3,
      lifetime: "session",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
  ],
};

describe("D418 advisory active-grant snapshot protocol", () => {
  test("parses a strict snapshot and carries only redacted discovery fields", () => {
    const parsed = parseRelayDesktopFilesystemGrantSnapshot(SNAPSHOT);
    expect(parsed).toEqual({ ok: true, snapshot: SNAPSHOT });
    expect(Object.keys(SNAPSHOT).sort()).toEqual([
      "agentScope",
      "grants",
      "instanceId",
      "revision",
    ]);
    expect(Object.keys(SNAPSHOT.grants[0]!).sort()).toEqual([
      "access",
      "canonicalRoot",
      "expiresAt",
      "id",
      "lifetime",
      "policyVersion",
    ]);
  });

  test("accepts an empty active-grant set", () => {
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({ ...SNAPSHOT, grants: [] }),
    ).toEqual({ ok: true, snapshot: { ...SNAPSHOT, grants: [] } });
  });

  test("rejects an unsupported agent scope (no unbound wildcard)", () => {
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({ ...SNAPSHOT, agentScope: "everyone" }),
    ).toMatchObject({ ok: false });
  });

  test("D418 default-instance — instanceId accepts the canonical default and named ids", () => {
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({ ...SNAPSHOT, instanceId: "" }),
    ).toEqual({ ok: true, snapshot: { ...SNAPSHOT, instanceId: "" } });
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({ ...SNAPSHOT, instanceId: "stack-b" }),
    ).toEqual({ ok: true, snapshot: { ...SNAPSHOT, instanceId: "stack-b" } });
  });

  test("D418 default-instance — instanceId rejects whitespace and noncanonical ids", () => {
    for (const bad of ["  ", "\t", "instance-1 ", " instance-1", "Instance-1", "-bad", "bad!"]) {
      expect(
        parseRelayDesktopFilesystemGrantSnapshot({ ...SNAPSHOT, instanceId: bad }),
      ).toMatchObject({ ok: false });
    }
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({ ...SNAPSHOT, instanceId: 0 }),
    ).toMatchObject({ ok: false });
  });

  test("rejects redacted identity/authority fields smuggled onto an entry", () => {
    for (const forbidden of [
      "platformAuthorization",
      "createdBy",
      "createdAt",
      "revokedAt",
      "lastUsedAt",
      "filesystemIdentity",
      "origin",
      "subject",
    ]) {
      expect(
        parseRelayDesktopFilesystemGrantSnapshot({
          ...SNAPSHOT,
          grants: [{ ...SNAPSHOT.grants[0], [forbidden]: "must-never-cross" }],
        }),
      ).toMatchObject({ ok: false });
    }
  });

  test("fails closed for malformed root, access, policy, lifetime, and duplicate ids", () => {
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({
        ...SNAPSHOT,
        grants: [{ ...SNAPSHOT.grants[0], canonicalRoot: "relative/path" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({
        ...SNAPSHOT,
        grants: [{ ...SNAPSHOT.grants[0], access: [] }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({
        ...SNAPSHOT,
        grants: [{ ...SNAPSHOT.grants[0], access: ["read", "read"] }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({
        ...SNAPSHOT,
        grants: [{ ...SNAPSHOT.grants[0], policyVersion: 0 }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({
        ...SNAPSHOT,
        grants: [{ ...SNAPSHOT.grants[0], lifetime: "forever" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseRelayDesktopFilesystemGrantSnapshot({
        ...SNAPSHOT,
        grants: [SNAPSHOT.grants[0], SNAPSHOT.grants[0]],
      }),
    ).toMatchObject({ ok: false });
    expect(parseRelayDesktopFilesystemGrantSnapshot({ ...SNAPSHOT, revision: -1 })).toMatchObject({
      ok: false,
    });
  });
});

describe("D418 protocol v7 desktop-session capability-update transport", () => {
  const CAPS = { profile: "desktop-agent" as const, canReadWorkspace: true };

  test("register carries desktopSessionId and capabilityRevision for desktop relays", () => {
    const register: RelayRegisterMessage = {
      type: "relay:register",
      relayId: "relay-1",
      userId: "user-1",
      capabilities: CAPS,
      protocolVersion: RELAY_PROTOCOL_VERSION,
      desktopSessionId: "session-1",
      capabilityRevision: 0,
    };
    expect(register.desktopSessionId).toBe("session-1");
    expect(register.capabilityRevision).toBe(0);
    // Both fields are optional on the wire so pre-v7 relays still parse.
    const legacy: RelayRegisterMessage = {
      type: "relay:register",
      relayId: "relay-1",
      userId: "user-1",
      capabilities: CAPS,
      protocolVersion: 6,
    };
    expect(legacy.desktopSessionId).toBeUndefined();
    expect(legacy.capabilityRevision).toBeUndefined();
  });

  test("relay:update-capabilities is a full-replacement client→server frame", () => {
    const update: RelayUpdateCapabilitiesMessage = {
      type: "relay:update-capabilities",
      relayId: "relay-1",
      desktopSessionId: "session-1",
      capabilityRevision: 5,
      capabilities: { ...CAPS, desktopFilesystemGrantSnapshot: SNAPSHOT },
    };
    expect(update.type).toBe("relay:update-capabilities");
    // The frame carries the FULL capabilities object — never a partial merge.
    expect(update.capabilities.desktopFilesystemGrantSnapshot).toEqual(SNAPSHOT);
    expect(Object.keys(update).sort()).toEqual([
      "capabilities",
      "capabilityRevision",
      "desktopSessionId",
      "relayId",
      "type",
    ]);
  });

  test("relay:capabilities-updated is the matching server→client ack", () => {
    const ok: RelayCapabilitiesUpdatedMessage = {
      type: "relay:capabilities-updated",
      relayId: "relay-1",
      capabilityRevision: 5,
      status: "ok",
    };
    const rejected: RelayCapabilitiesUpdatedMessage = {
      type: "relay:capabilities-updated",
      relayId: "relay-1",
      capabilityRevision: 5,
      status: "rejected",
      error: "stale or duplicate capability revision",
    };
    expect(ok.status).toBe("ok");
    expect(rejected.status).toBe("rejected");
    expect(rejected.error).toBe("stale or duplicate capability revision");
  });
});
