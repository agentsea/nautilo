/**
 * M206 Slice A — `InMemoryRelayRegistry.localFileDispatch` envelope +
 * error/timeout mapping mirrors `fsDispatch`.
 */
import { describe, expect, it } from "bun:test";
import type {
  RelayCapabilities,
  RelayServerMessage,
  RelayLocalFileRequest,
  RelayLocalFileResult,
} from "@nautilo/relay";
import { InMemoryRelayRegistry } from "../../src/relay-registry";

const CAPS: RelayCapabilities = {
  profile: "desktop-agent",
  localFileExecution: true,
} as RelayCapabilities;

const FILE_GREP_REQ: RelayLocalFileRequest = {
  operation: {
    kind: "file",
    command: "grep",
    zone: "current",
    args: { path: "notes.md", query: "fixme" },
  },
  allowedRoots: ["/Users/alice/demo"],
};

type RelayDesktopFilesystemGrantRequest = NonNullable<
  Extract<RelayServerMessage, { type: "relay:dispatch" }>["desktopFilesystemGrantRequest"]
>;

const GRANT_REQUEST: RelayDesktopFilesystemGrantRequest = {
  version: 1,
  grantIds: ["grant-1"],
  requestedRoot: "/Users/alice/demo",
  operation: "read",
  subject: {
    userId: "alice",
    instanceId: "instance-A",
    relayId: "relay-1",
    agentScope: "workstation",
  },
  policy: { policyVersion: 2, lifetime: "durable" },
};

describe("InMemoryRelayRegistry.localFileDispatch (M206 Slice A)", () => {
  it("rejects a replaced Task continuation generation before transport", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register(
      "relay-1",
      "alice",
      CAPS,
      (message) => sent.push(message),
      9,
      "desktop-1",
      1,
      "pairing-2",
    );

    const result = await registry.localFileDispatch("relay-1", FILE_GREP_REQ, {
      mutating: false,
      approvalObtained: false,
      requiredRelaySessionId: registry.getRelaySessionId("relay-1")!,
      requiredDesktopSessionId: "desktop-1",
      requiredPairingGeneration: "pairing-1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Task continuation relay topology changed");
    }
    expect(sent).toHaveLength(0);
  });

  it("sends relay:dispatch with toolName local-file and executionClass local-file", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (m) => sent.push(m), 4);

    const pending = registry.localFileDispatch("relay-1", FILE_GREP_REQ, {
      mutating: false,
      approvalObtained: false,
    });

    expect(sent).toHaveLength(1);
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.type).toBe("relay:dispatch");
    expect(dispatch.toolName).toBe("local-file");
    expect(dispatch.executionClass).toBe("local-file");
    expect(dispatch.impact).toBe("read-only");
    expect(dispatch.approvalObtained).toBe(false);
    expect(dispatch.allowedRoots).toEqual([...FILE_GREP_REQ.allowedRoots]);
    expect((dispatch.args as unknown as RelayLocalFileRequest).operation.kind).toBe("file");

    const corrId = dispatch.correlationId;
    registry.resolveDispatch(corrId, {
      status: "ok",
      result: { ok: true, result: { matches: [] } } satisfies RelayLocalFileResult,
    });
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it("preserves the search sandbox envelope alongside the existing roots and grant metadata", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (message) => sent.push(message), 9);
    const sandboxProfile = {
      workspace: "/Users/alice/demo", dataDir: "/data", toolsBin: "/tools",
      mode: "desktop-locked" as const, securityLevel: "standard" as const, failIfNoBackend: true,
      config: { mode: "enabled" as const, writablePaths: [], projectPaths: ["/Users/alice/demo"], passthroughEnv: [] },
    };
    const pending = registry.localFileDispatch("relay-1", FILE_GREP_REQ, {
      mutating: false, approvalObtained: false, sandboxProfile, desktopFilesystemGrantRequest: GRANT_REQUEST,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.sandboxProfile).toEqual(sandboxProfile);
    expect(dispatch.desktopFilesystemGrantRequest).toEqual(GRANT_REQUEST);
    expect(dispatch.allowedRoots).toEqual([...FILE_GREP_REQ.allowedRoots]);
    registry.resolveDispatch(dispatch.correlationId, { status: "ok", result: { ok: true, result: { matches: [] } } });
    expect((await pending).ok).toBe(true);
  });

  it("forwards a read-only desktopFilesystemGrantRequest on the outer relay:dispatch message", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (m) => sent.push(m), 9);

    const pending = registry.localFileDispatch("relay-1", FILE_GREP_REQ, {
      mutating: false,
      approvalObtained: false,
      desktopFilesystemGrantRequest: GRANT_REQUEST,
    });

    expect(sent).toHaveLength(1);
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    // Exactly one reference rides as OUTER envelope metadata; allowedRoots is
    // unchanged and args carry no grant reference.
    expect(dispatch.desktopFilesystemGrantRequest).toEqual(GRANT_REQUEST);
    expect(dispatch.allowedRoots).toEqual([...FILE_GREP_REQ.allowedRoots]);
    expect((dispatch.args as unknown as RelayLocalFileRequest)).not.toHaveProperty(
      "desktopFilesystemGrantRequest",
    );

    registry.resolveDispatch(dispatch.correlationId, {
      status: "ok",
      result: { ok: true, result: { matches: [] } } satisfies RelayLocalFileResult,
    });
    const result = await pending;
    expect(result.ok).toBe(true);
  });

  it("omits desktopFilesystemGrantRequest when none is supplied (baseline unchanged)", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (m) => sent.push(m), 6);

    void registry.localFileDispatch("relay-1", FILE_GREP_REQ, {
      mutating: false,
      approvalObtained: false,
    });

    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.desktopFilesystemGrantRequest).toBeUndefined();
  });

  it("maps relay transport errors to { ok:false } like fsDispatch", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "alice", CAPS, () => {}, 4);

    const pending = registry.localFileDispatch("relay-1", FILE_GREP_REQ, {
      mutating: false,
      approvalObtained: false,
    });
    await registry.unregister("relay-1");

    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error branch");
    expect(result.message).toContain("disconnected");
  });

  it("maps dispatch status:error to { ok:false, code }", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", CAPS, (m) => sent.push(m), 4);

    const pending = registry.localFileDispatch("relay-1", FILE_GREP_REQ, {
      mutating: true,
      approvalObtained: true,
    });
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch.impact).toBe("destructive");
    expect(dispatch.approvalObtained).toBe(true);

    registry.resolveDispatch(dispatch.correlationId, {
      status: "error",
      error: "approval missing on relay",
      errorCode: "LOCAL_FILE_EXECUTION_UNSUPPORTED",
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error branch");
    expect(result.code).toBe("LOCAL_FILE_EXECUTION_UNSUPPORTED");
  });
});
