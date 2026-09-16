/**
 * D418 — server-side advisory grant-reference SELECTION path (read-only slice).
 *
 * These tests pin the discovery-only contract. The advertised snapshot is never
 * authority: selection only chooses which already-held grant id the server may
 * reference, and the built request carries a reference + stale-detection
 * metadata and nothing that could stand in for authorization. The desktop live
 * grant store stays authoritative — the relay-local resolver reloads it and a
 * stale/revoked reference sourced from this snapshot fails closed there.
 */

import { describe, expect, test } from "bun:test";
import {
  DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
  DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
  type RelayCapabilities,
  type RelayDesktopFilesystemGrantSnapshot,
} from "@nautilo/relay";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import {
  buildLocalFileReadDesktopFilesystemGrantRequest,
  localFileReadOperation,
  selectDesktopFilesystemGrantSnapshotGrant,
} from "../../src/tools/file/local-file-routing";

const INSTANCE = "instance-A";
const RELAY_ID = "relay-1";
const USER_ID = "user-1";

function snapshot(
  grants: RelayDesktopFilesystemGrantSnapshot["grants"],
  overrides: Partial<Pick<RelayDesktopFilesystemGrantSnapshot, "instanceId" | "revision">> = {},
): RelayDesktopFilesystemGrantSnapshot {
  return {
    revision: overrides.revision ?? 1,
    instanceId: overrides.instanceId ?? INSTANCE,
    agentScope: DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
    grants,
  };
}

/** Minimal registry view exposing only the D418 discovery getter. */
function registryWithSnapshot(
  snap: RelayDesktopFilesystemGrantSnapshot | null,
): ToolRelayRegistry {
  return {
    findByCapabilityForUser: () => [RELAY_ID],
    getCapabilities: (): RelayCapabilities => ({ profile: "desktop-agent" }),
    getProtocolVersion: () => DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
    getDesktopFilesystemGrantSnapshot: () => snap,
    async dispatch() {
      throw new Error("dispatch should not be called by selection");
    },
  };
}

describe("selectDesktopFilesystemGrantSnapshotGrant (D418)", () => {
  test("selects the most-specific matching read grant", () => {
    const snap = snapshot([
      {
        id: "grant-broad",
        canonicalRoot: "/Users/ex/project",
        access: ["read"],
        policyVersion: 3,
        lifetime: "durable",
      },
      {
        id: "grant-narrow",
        canonicalRoot: "/Users/ex/project/src",
        access: ["read"],
        policyVersion: 3,
        lifetime: "durable",
      },
    ]);
    const entry = selectDesktopFilesystemGrantSnapshotGrant({
      snapshot: snap,
      expectedInstanceId: INSTANCE,
      candidatePath: "/Users/ex/project/src/app/main.ts",
      operation: "read",
    });
    expect(entry?.id).toBe("grant-narrow");
  });

  test("returns nothing when no grant contains the candidate", () => {
    const snap = snapshot([
      {
        id: "grant-1",
        canonicalRoot: "/Users/ex/project",
        access: ["read"],
        policyVersion: 1,
        lifetime: "session",
      },
    ]);
    const entry = selectDesktopFilesystemGrantSnapshotGrant({
      snapshot: snap,
      expectedInstanceId: INSTANCE,
      candidatePath: "/Users/ex/other/file.ts",
      operation: "read",
    });
    expect(entry).toBeUndefined();
  });

  test("rejects a snapshot for a different instance/scope", () => {
    const snap = snapshot([
      {
        id: "grant-1",
        canonicalRoot: "/Users/ex/project",
        access: ["read"],
        policyVersion: 1,
        lifetime: "session",
      },
    ]);
    // Wrong instance: desktop live store is per-instance authoritative, so a
    // reference bound to a different instance must never be selected here.
    expect(
      selectDesktopFilesystemGrantSnapshotGrant({
        snapshot: snap,
        expectedInstanceId: "instance-B",
        candidatePath: "/Users/ex/project/x.ts",
        operation: "read",
      }),
    ).toBeUndefined();

    // Wrong agent scope: only the bound-owner scope is admissible.
    const wrongScope = {
      ...snap,
      agentScope: "some_other_scope",
    } as unknown as RelayDesktopFilesystemGrantSnapshot;
    expect(
      selectDesktopFilesystemGrantSnapshotGrant({
        snapshot: wrongScope,
        expectedInstanceId: INSTANCE,
        candidatePath: "/Users/ex/project/x.ts",
        operation: "read",
      }),
    ).toBeUndefined();
  });

  test("ignores grants that do not list the requested operation", () => {
    const snap = snapshot([
      {
        id: "grant-write-only",
        canonicalRoot: "/Users/ex/project",
        access: ["create_modify", "delete"],
        policyVersion: 2,
        lifetime: "durable",
      },
    ]);
    expect(
      selectDesktopFilesystemGrantSnapshotGrant({
        snapshot: snap,
        expectedInstanceId: INSTANCE,
        candidatePath: "/Users/ex/project/x.ts",
        operation: "read",
      }),
    ).toBeUndefined();
  });

  test("containment is separator-safe (no prefix-collision matches)", () => {
    const snap = snapshot([
      {
        id: "grant-1",
        canonicalRoot: "/Users/ex/app",
        access: ["read"],
        policyVersion: 1,
        lifetime: "session",
      },
    ]);
    // "/Users/ex/app-secrets" must not match root "/Users/ex/app".
    expect(
      selectDesktopFilesystemGrantSnapshotGrant({
        snapshot: snap,
        expectedInstanceId: INSTANCE,
        candidatePath: "/Users/ex/app-secrets/creds.txt",
        operation: "read",
      }),
    ).toBeUndefined();
    // The root itself is contained.
    expect(
      selectDesktopFilesystemGrantSnapshotGrant({
        snapshot: snap,
        expectedInstanceId: INSTANCE,
        candidatePath: "/Users/ex/app",
        operation: "read",
      })?.id,
    ).toBe("grant-1");
  });
});

describe("localFileReadOperation (D418)", () => {
  test("maps only structurally read-only commands to the read operation", () => {
    for (const cmd of ["read", "list", "stat", "grep"]) {
      expect(localFileReadOperation(cmd)).toBe("read");
    }
    for (const cmd of ["write", "str_replace", "move", "copy", "delete", "run_shell"]) {
      expect(localFileReadOperation(cmd)).toBeUndefined();
    }
  });
});

describe("buildLocalFileReadDesktopFilesystemGrantRequest (D418)", () => {
  const grants: RelayDesktopFilesystemGrantSnapshot["grants"] = [
    {
      id: "grant-broad",
      canonicalRoot: "/Users/ex/project",
      access: ["read", "create_modify"],
      policyVersion: 4,
      lifetime: "durable",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    {
      id: "grant-narrow",
      canonicalRoot: "/Users/ex/project/src",
      access: ["read"],
      policyVersion: 4,
      lifetime: "durable",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  ];

  test("attaches exactly one read grant reference for a read command", () => {
    const registry = registryWithSnapshot(snapshot(grants));
    const request = buildLocalFileReadDesktopFilesystemGrantRequest({
      command: "read",
      candidatePath: "/Users/ex/project/src/index.ts",
      subjectUserId: USER_ID,
      relayId: RELAY_ID,
      registry,
    });
    expect(request).toBeDefined();
    expect(request?.grantIds).toEqual(["grant-narrow"]);
    expect(request?.operation).toBe("read");
    expect(request?.requestedRoot).toBe("/Users/ex/project/src/index.ts");
    expect(request?.subject).toEqual({
      userId: USER_ID,
      instanceId: INSTANCE,
      relayId: RELAY_ID,
      agentScope: DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
    });
    expect(request?.policy).toEqual({
      policyVersion: 4,
      lifetime: "durable",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  test("omits the envelope for a mutating command even if a grant covers it", () => {
    const registry = registryWithSnapshot(snapshot(grants));
    expect(
      buildLocalFileReadDesktopFilesystemGrantRequest({
        command: "write",
        candidatePath: "/Users/ex/project/src/index.ts",
        subjectUserId: USER_ID,
        relayId: RELAY_ID,
        registry,
      }),
    ).toBeUndefined();
  });

  test("omits the envelope when the relay advertised no snapshot", () => {
    const registry = registryWithSnapshot(null);
    expect(
      buildLocalFileReadDesktopFilesystemGrantRequest({
        command: "read",
        candidatePath: "/Users/ex/project/src/index.ts",
        subjectUserId: USER_ID,
        relayId: RELAY_ID,
        registry,
      }),
    ).toBeUndefined();
  });

  test("omits the envelope for a non-canonical / ambiguous candidate path", () => {
    const registry = registryWithSnapshot(snapshot(grants));
    for (const candidatePath of [
      "relative/path.ts",
      "/Users/ex/project/../project/src/index.ts",
    ]) {
      expect(
        buildLocalFileReadDesktopFilesystemGrantRequest({
          command: "read",
          candidatePath,
          subjectUserId: USER_ID,
          relayId: RELAY_ID,
          registry,
        }),
      ).toBeUndefined();
    }
  });

  test("payload carries exactly one grant id and no authority secrets", () => {
    const registry = registryWithSnapshot(snapshot(grants));
    const request = buildLocalFileReadDesktopFilesystemGrantRequest({
      command: "grep",
      candidatePath: "/Users/ex/project/src/deep/nested.ts",
      subjectUserId: USER_ID,
      relayId: RELAY_ID,
      registry,
    });
    expect(request).toBeDefined();
    if (!request) return;

    // Exactly one grant id — the server references a single grant, never a set.
    expect(request.grantIds).toHaveLength(1);

    // The envelope admits ONLY the reference + stale-detection fields.
    expect(new Set(Object.keys(request))).toEqual(
      new Set(["version", "grantIds", "requestedRoot", "operation", "subject", "policy"]),
    );
    expect(new Set(Object.keys(request.subject))).toEqual(
      new Set(["userId", "instanceId", "relayId", "agentScope"]),
    );
    expect(
      Object.keys(request.policy).every((k) =>
        ["policyVersion", "lifetime", "expiresAt"].includes(k),
      ),
    ).toBe(true);

    // No authority / identity secrets ever cross the wire from the snapshot.
    const serialized = JSON.stringify(request);
    for (const forbidden of [
      "platformAuthorization",
      "filesystemIdentity",
      "realRoot",
      "canonicalRoot",
      "createdBy",
      "revokedAt",
      "device",
      "inode",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
