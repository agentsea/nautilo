/** D448 — v9 apply-patch registry transport and pinned-relay gates. */
import { describe, expect, it } from "bun:test";
import type {
  RelayCapabilities,
  RelayLocalApplyPatchRequest,
  RelayLocalApplyPatchResult,
  RelaySandboxProfile,
  RelayServerMessage,
} from "@nautilo/relay";
import {
  APPLY_PATCH_RELAY_DISPATCH_ERROR,
  ApplyPatchRelayDispatchError,
  InMemoryRelayRegistry,
  canDispatchApplyPatchToFocusedRelay,
} from "../../src/relay-registry";

const REQUEST: RelayLocalApplyPatchRequest = {
  operation: {
    kind: "apply_patch",
    version: 1,
    patch: "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch\n",
    routing: { zone: "current", turnId: "turn-1", agentId: "agent-1" },
  },
  expectedCurrentFolder: "/Users/alice/demo",
};

const RESULT: RelayLocalApplyPatchResult = {
  status: "applied",
  partial: false,
  operationCounts: { add: 0, update: 1, move: 0, delete: 0 },
  pathResults: [
    {
      operation: "update",
      path: "src/example.ts",
      status: "applied",
      bytesTouched: 8,
      revisionId: "rev-1",
    },
  ],
  changedFiles: [
    {
      operation: "update",
      path: "src/example.ts",
      status: "applied",
      bytesTouched: 8,
      revisionId: "rev-1",
    },
  ],
  revisionIds: ["rev-1"],
  unifiedDiff: "-old\n+new\n",
  runtimeVersion: "nautilo.apply_patch/v1",
  turnId: "turn-1",
};

const APPLY_PATCH_CAPS: RelayCapabilities = {
  profile: "desktop-agent",
  localFileExecution: true,
  applyPatchExecution: true,
};

const SANDBOX = {
  workspace: "/Users/alice/demo",
  dataDir: "/data",
  toolsBin: "/tools",
  config: { mode: "read-write", writablePaths: ["/Users/alice/demo"], projectPaths: ["/Users/alice/demo"], passthroughEnv: [] },
  mode: "desktop-locked",
  securityLevel: "standard",
  failIfNoBackend: true,
} as unknown as RelaySandboxProfile;

async function expectStableDispatchFailure(promise: Promise<unknown>): Promise<void> {
  await promise.then(
    () => {
      throw new Error("expected apply-patch dispatch to fail");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(APPLY_PATCH_RELAY_DISPATCH_ERROR);
    },
  );
}

describe("InMemoryRelayRegistry.applyPatchDispatch (D448)", () => {
  it("uses one approved destructive local-file round trip without legacy allowedRoots", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", APPLY_PATCH_CAPS, (message) => sent.push(message), 9);

    const pending = registry.applyPatchDispatch("relay-1", REQUEST, { sandboxProfile: SANDBOX });

    expect(sent).toHaveLength(1);
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(dispatch).toMatchObject({
      type: "relay:dispatch",
      toolName: "local-file",
      executionClass: "local-file",
      impact: "destructive",
      approvalObtained: true,
      args: REQUEST,
      sandboxProfile: SANDBOX,
    });
    expect(dispatch).not.toHaveProperty("allowedRoots");
    expect(dispatch.args).not.toHaveProperty("allowedRoots");

    registry.resolveDispatch(dispatch.correlationId, { status: "ok", result: RESULT });
    expect(await pending).toEqual(RESULT);
  });

  it("fails closed with one stable error for relay errors, malformed output, and invalid inputs", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", APPLY_PATCH_CAPS, (message) => sent.push(message), 9);

    const relayError = registry.applyPatchDispatch("relay-1", REQUEST, { sandboxProfile: SANDBOX });
    registry.resolveDispatch(
      (sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId,
      { status: "error", error: "do not expose relay detail" },
    );
    await expectStableDispatchFailure(relayError);

    const malformed = registry.applyPatchDispatch("relay-1", REQUEST, { sandboxProfile: SANDBOX });
    registry.resolveDispatch(
      (sent[1] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId,
      { status: "ok", result: { status: "applied" } },
    );
    await expectStableDispatchFailure(malformed);

    await expectStableDispatchFailure(
      registry.applyPatchDispatch(
        "relay-1",
        { ...REQUEST, allowedRoots: ["/must-not-cross-the-wire"] } as unknown as RelayLocalApplyPatchRequest,
        { sandboxProfile: SANDBOX },
      ),
    );
    expect(sent).toHaveLength(2);
  });

  it("preserves public denial and runtime categories from a live Desktop relay", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", APPLY_PATCH_CAPS, (message) => sent.push(message), 9);

    const denied = registry.applyPatchDispatch("relay-1", REQUEST, { sandboxProfile: SANDBOX });
    registry.resolveDispatch((sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId, {
      status: "error", errorCode: "denied_path", error: "secret local detail",
    });
    await denied.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApplyPatchRelayDispatchError);
      expect((error as ApplyPatchRelayDispatchError).applyPatchErrorCode).toBe("denied_path");
      expect((error as ApplyPatchRelayDispatchError).applyPatchFailureReason).toBeUndefined();
    });

    const staleFolder = registry.applyPatchDispatch("relay-1", REQUEST, { sandboxProfile: SANDBOX });
    registry.resolveDispatch((sent[1] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId, {
      status: "error", errorCode: "stale_context", error: "secret local path detail",
    });
    await staleFolder.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ApplyPatchRelayDispatchError);
      expect((error as ApplyPatchRelayDispatchError).applyPatchErrorCode).toBe("stale_context");
      expect((error as ApplyPatchRelayDispatchError).applyPatchFailureReason).toBe("stale_current_folder");
      expect((error as Error).message).toBe(APPLY_PATCH_RELAY_DISPATCH_ERROR);
    });

    const unavailable = registry.applyPatchDispatch("relay-1", REQUEST, { sandboxProfile: SANDBOX });
    registry.resolveDispatch((sent[2] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId, {
      status: "error", errorCode: "runtime_unavailable", error: "secret local detail",
    });
    await unavailable.catch((error: unknown) => {
      expect((error as ApplyPatchRelayDispatchError).applyPatchErrorCode).toBe("runtime_unavailable");
    });

    for (const code of ["human_edit_conflict", "reapply_required"] as const) {
      const conflict = registry.applyPatchDispatch("relay-1", REQUEST, { sandboxProfile: SANDBOX });
      registry.resolveDispatch((sent.at(-1) as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId, {
        status: "error", errorCode: code, error: "secret local detail",
      });
      await conflict.catch((error: unknown) => {
        expect((error as ApplyPatchRelayDispatchError).applyPatchErrorCode).toBe(code);
      });
    }
  });

  it("rejects a malformed Current Folder assertion without emitting a request", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: RelayServerMessage[] = [];
    await registry.register("relay-1", "alice", APPLY_PATCH_CAPS, (message) => sent.push(message), 9);

    await expectStableDispatchFailure(
      registry.applyPatchDispatch("relay-1", {
        ...REQUEST,
        expectedCurrentFolder: "",
      }, {
        sandboxProfile: SANDBOX,
      }),
    );

    expect(sent).toEqual([]);
  });

  it("preserves applyPatchExecution across a strict capability replacement", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-1", "alice", { profile: "desktop-agent" }, () => {}, 9, "desktop-1", 0);

    expect(
      registry.updateCapabilities({
        relayId: "relay-1",
        userId: "alice",
        desktopSessionId: "desktop-1",
        capabilityRevision: 1,
        capabilities: APPLY_PATCH_CAPS,
      }),
    ).toEqual({ ok: true });
    expect(registry.getCapabilities("relay-1")?.applyPatchExecution).toBe(true);
    expect(registry.snapshotForFocusedResource("relay-1", "alice")?.applyPatchExecution).toBe(true);
  });
});

describe("canDispatchApplyPatchToFocusedRelay (D448)", () => {
  it("requires the exact owner, desktop profile, protocol v9, and dedicated capability", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("good", "alice", APPLY_PATCH_CAPS, () => {}, 9);
    await registry.register("old", "alice", APPLY_PATCH_CAPS, () => {}, 8);
    await registry.register("headless", "alice", { profile: "device-relay", applyPatchExecution: true }, () => {}, 9);
    await registry.register("unavailable", "alice", { profile: "desktop-agent" }, () => {}, 9);

    expect(canDispatchApplyPatchToFocusedRelay(registry.snapshotForFocusedResource("good", "alice"))).toBe(true);
    expect(canDispatchApplyPatchToFocusedRelay(registry.snapshotForFocusedResource("good", "mallory"))).toBe(false);
    expect(canDispatchApplyPatchToFocusedRelay(registry.snapshotForFocusedResource("old", "alice"))).toBe(false);
    expect(canDispatchApplyPatchToFocusedRelay(registry.snapshotForFocusedResource("headless", "alice"))).toBe(false);
    expect(canDispatchApplyPatchToFocusedRelay(registry.snapshotForFocusedResource("unavailable", "alice"))).toBe(false);
    expect(canDispatchApplyPatchToFocusedRelay(registry.snapshotForFocusedResource("missing", "alice"))).toBe(false);
  });

  it("never substitutes a compatible relay after the pinned relay fails its gate", async () => {
    const registry = new InMemoryRelayRegistry();
    const sent: string[] = [];
    await registry.register("pinned-old", "alice", APPLY_PATCH_CAPS, () => sent.push("pinned-old"), 8);
    await registry.register("other-good", "alice", APPLY_PATCH_CAPS, () => sent.push("other-good"), 9);

    expect(canDispatchApplyPatchToFocusedRelay(registry.snapshotForFocusedResource("pinned-old", "alice"))).toBe(false);
    await expectStableDispatchFailure(
      registry.applyPatchDispatch("pinned-old", REQUEST, { sandboxProfile: SANDBOX }),
    );
    expect(sent).toEqual([]);
  });
});
