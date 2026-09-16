import { describe, expect, test } from "bun:test";
import {
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
  DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
  type RelayCapabilities,
  type RelayLocalFileRequest,
  type RelayLocalFileResult,
  type RelayDesktopFilesystemGrantSnapshot,
} from "@nautilo/relay";
import type { ToolRelayRegistry } from "../../src/nodes/tools";
import {
  isLocalFileZone,
  isMutatingLocalFileCommand,
  RELAY_OWNERSHIP_MISMATCH,
  resolveLocalFileRelay,
} from "../../src/tools/file/local-file-routing";

const ownerId = "user-1";

function registry(options: {
  protocolVersion: number;
  capabilities?: RelayCapabilities;
  ids?: string[];
  withLocalFileDispatch?: boolean;
  snapshot?: RelayDesktopFilesystemGrantSnapshot | null;
}): ToolRelayRegistry {
  const relayIds = options.ids ?? ["relay-1"];
  const caps = options.capabilities ?? {
    profile: "desktop-agent",
    canReadWorkspace: true,
    canWriteWorkspace: true,
    localFileExecution: true,
    allowedRoots: ["/Users/example/project"],
  };
  return {
    findByCapabilityForUser(capability, userId) {
      expect(userId).toBe(ownerId);
      return (caps as Record<string, unknown>)[capability] === true ? relayIds : [];
    },
    getCapabilities() {
      return caps;
    },
    getProtocolVersion() {
      return options.protocolVersion;
    },
    getDesktopFilesystemGrantSnapshot() {
      return options.snapshot ?? null;
    },
    async dispatch() {
      throw new Error("dispatch should not be called by selection");
    },
    ...(options.withLocalFileDispatch !== false
      ? {
          async localFileDispatch(
            _relayId: string,
            _req: RelayLocalFileRequest,
          ): Promise<RelayLocalFileResult> {
            return { ok: true, result: "ok" };
          },
        }
      : {}),
  };
}

const INSTANCE = "instance-A";

function grantSnapshot(
  grants: RelayDesktopFilesystemGrantSnapshot["grants"],
  instanceId = INSTANCE,
): RelayDesktopFilesystemGrantSnapshot {
  return {
    revision: 1,
    instanceId,
    agentScope: DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
    grants,
  };
}

const READ_GRANTS: RelayDesktopFilesystemGrantSnapshot["grants"] = [
  {
    id: "grant-1",
    canonicalRoot: "/Users/example/project",
    access: ["read"],
    policyVersion: 2,
    lifetime: "durable",
  },
];

describe("resolveLocalFileRelay (M206)", () => {
  test("characterizes the unsafe first-eligible multi-host fallback D458 must remove", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: registry({
        protocolVersion: 4,
        ids: ["mac-a", "mac-b"],
      }),
    });

    expect(selected.ok).toBe(true);
    if (selected.ok) expect(selected.relayId).toBe("mac-a");
  });

  test("v4 desktop-agent with localFileExecution selects relay", () => {
    const selected = resolveLocalFileRelay({
      command: "grep",
      ownerId,
      registry: registry({ protocolVersion: 4 }),
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.relayId).toBe("relay-1");
      expect(selected.allowedRoots).toEqual(["/Users/example/project"]);
    }
  });

  test("legacy v3 relay is rejected", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: registry({ protocolVersion: 3 }),
    });
    expect(selected.ok).toBe(false);
    if (!selected.ok) {
      expect(selected.code).toBe(LOCAL_FILE_EXECUTION_UNSUPPORTED);
      expect(selected.error).toContain("desktop app");
      expect(selected.error).not.toContain("nautilo-relay");
    }
  });

  test("headless device-relay profile is rejected", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: registry({
        protocolVersion: 4,
        capabilities: {
          profile: "device-relay",
          canReadWorkspace: true,
          canWriteWorkspace: true,
          localFileExecution: true,
          allowedRoots: ["/tmp"],
        },
      }),
    });
    expect(selected.ok).toBe(false);
  });

  test("missing localFileExecution capability is rejected", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: registry({
        protocolVersion: 4,
        capabilities: {
          profile: "desktop-agent",
          canReadWorkspace: true,
          canWriteWorkspace: true,
          allowedRoots: ["/tmp"],
        },
      }),
    });
    expect(selected.ok).toBe(false);
  });

  test("no registry returns desktop-required error", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: null,
    });
    expect(selected.ok).toBe(false);
    if (!selected.ok) {
      expect(selected.code).toBe(LOCAL_FILE_EXECUTION_UNSUPPORTED);
    }
  });

  test("mutating commands require write capability routing", () => {
    const reg = registry({
      protocolVersion: 4,
      capabilities: {
        profile: "desktop-agent",
        canReadWorkspace: true,
        canWriteWorkspace: false,
        localFileExecution: true,
        allowedRoots: ["/tmp"],
      },
    });
    const selected = resolveLocalFileRelay({ command: "write", ownerId, registry: reg });
    expect(selected.ok).toBe(false);
  });

  test("isMutatingLocalFileCommand covers history mutations", () => {
    expect(isMutatingLocalFileCommand("undo")).toBe(true);
    expect(isMutatingLocalFileCommand("list_revisions")).toBe(false);
    expect(isLocalFileZone("current")).toBe(true);
    expect(isLocalFileZone("workspace")).toBe(false);
  });

  test("relayIdHint rejects cross-relay refs when hint relay is not paired", () => {
    const selected = resolveLocalFileRelay({
      command: "pin_revision",
      ownerId,
      registry: registry({ protocolVersion: 4, ids: ["relay-1"] }),
      relayIdHint: "relay-other",
    });
    expect(selected.ok).toBe(false);
    if (!selected.ok) {
      expect(selected.code).toBe(RELAY_OWNERSHIP_MISMATCH);
    }
  });

  test("relayIdHint selects the hinted relay when paired", () => {
    const selected = resolveLocalFileRelay({
      command: "pin_revision",
      ownerId,
      registry: registry({ protocolVersion: 4, ids: ["relay-1", "relay-2"] }),
      relayIdHint: "relay-2",
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.relayId).toBe("relay-2");
    }
  });
});

describe("resolveLocalFileRelay D418 grant-reference attachment", () => {
  test("attaches one read grant reference when a snapshot covers the candidate", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: registry({ protocolVersion: DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION, snapshot: grantSnapshot(READ_GRANTS) }),
      candidatePath: "/Users/example/project/src/index.ts",
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.desktopFilesystemGrantRequest?.grantIds).toEqual(["grant-1"]);
      expect(selected.desktopFilesystemGrantRequest?.operation).toBe("read");
      expect(selected.desktopFilesystemGrantRequest?.subject).toEqual({
        userId: ownerId,
        instanceId: INSTANCE,
        relayId: "relay-1",
        agentScope: DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
      });
    }
  });

  test("keeps the baseline (no envelope) when no candidate path is supplied", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: registry({ protocolVersion: DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION, snapshot: grantSnapshot(READ_GRANTS) }),
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.desktopFilesystemGrantRequest).toBeUndefined();
    }
  });

  test("never attaches an envelope for a mutating command", () => {
    const selected = resolveLocalFileRelay({
      command: "write",
      ownerId,
      registry: registry({ protocolVersion: DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION, snapshot: grantSnapshot(READ_GRANTS) }),
      candidatePath: "/Users/example/project/src/index.ts",
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.desktopFilesystemGrantRequest).toBeUndefined();
    }
  });

  test("does not attach when the snapshot instance/scope does not match", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: registry({
        protocolVersion: DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
        snapshot: grantSnapshot(READ_GRANTS, "instance-OTHER"),
      }),
      candidatePath: "/Users/example/other/index.ts",
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      // The candidate is outside the advertised root anyway, and the snapshot
      // is bound to a live desktop store that stays authoritative regardless.
      expect(selected.desktopFilesystemGrantRequest).toBeUndefined();
    }
  });

  test("attaches through the relayIdHint path when the hint relay covers it", () => {
    const selected = resolveLocalFileRelay({
      command: "grep",
      ownerId,
      registry: registry({
        protocolVersion: DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
        ids: ["relay-1", "relay-2"],
        snapshot: grantSnapshot(READ_GRANTS),
      }),
      relayIdHint: "relay-2",
      candidatePath: "/Users/example/project/src/index.ts",
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.relayId).toBe("relay-2");
      expect(selected.desktopFilesystemGrantRequest?.grantIds).toEqual(["grant-1"]);
      expect(selected.desktopFilesystemGrantRequest?.subject.relayId).toBe("relay-2");
    }
  });

  test("pre-v9 relays keep ordinary local-file routing but never construct a renamed envelope", () => {
    const selected = resolveLocalFileRelay({
      command: "read",
      ownerId,
      registry: registry({ protocolVersion: 8, snapshot: grantSnapshot(READ_GRANTS) }),
      candidatePath: "/Users/example/project/src/index.ts",
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.relayId).toBe("relay-1");
      expect(selected.desktopFilesystemGrantRequest).toBeUndefined();
    }
  });
});
