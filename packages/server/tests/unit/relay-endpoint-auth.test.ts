/**
 * M056 — `relay:register` token validation in the WS endpoint.
 *
 * Exercises `handleRelayRegister` with a fake socket + fake registry
 * + stubbed token store. Post-M072, token validation is unconditional:
 * missing/invalid token → relay:error + close code 4401, registry never
 * called; valid token → registry receives validated.userId (not spoofed
 * msg.userId).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE,
  RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  type RelayCapabilities,
  type RelayRegisterMessage,
  type RelayResultMessage,
} from "@nautilo/relay";
import {
  handleRelayResult,
  isValidRelayRunShellProgress,
  isValidRelayStructuredSshProgress,
  parseRelayEndpointClientMessage,
  handleRelayRegister,
  isExpectedRelayDesktopSession,
  negotiateRelayProtocolVersion,
  RELAY_TOKEN_AUTH_CLOSE_CODE,
  type RelayRegistryLike,
  type RelaySocketLike,
} from "../../src/realtime/relay-endpoint";
import {
  getRelayTokenStore,
  resetRelayTokenStore,
  setRelayTokenStore,
  type RelayTokenStore,
} from "../../src/lib/relay-token-store";

interface SocketEvent {
  readonly kind: "send" | "close";
  readonly payload?: unknown;
  readonly code?: number | undefined;
  readonly reason?: string | undefined;
}

function makeFakeSocket(): {
  socket: RelaySocketLike;
  events: SocketEvent[];
} {
  const events: SocketEvent[] = [];
  const socket: RelaySocketLike = {
    OPEN: 1,
    readyState: 1,
    send(data) {
      events.push({ kind: "send", payload: JSON.parse(data) });
    },
    close(code, reason) {
      events.push({ kind: "close", code, reason });
      // Mirror real WS: readyState flips so subsequent sends no-op.
      this.readyState = 3;
    },
  };
  return { socket, events };
}

interface RegisteredCall {
  relayId: string;
  userId: string;
  capabilities: RelayCapabilities;
  protocolVersion?: number;
  desktopSessionId?: string;
  capabilityRevision?: number;
  pairingGeneration?: string;
}

function makeFakeRegistry(): {
  registry: RelayRegistryLike;
  calls: RegisteredCall[];
} {
  const calls: RegisteredCall[] = [];
  const registry: RelayRegistryLike = {
    getUserId: () => null,
    unregisterConnection: async () => {},
    async register(
      relayId,
      userId,
      capabilities,
      _send,
      protocolVersion,
      desktopSessionId,
      capabilityRevision,
      pairingGeneration,
    ) {
      calls.push({
        relayId,
        userId,
        capabilities,
        ...(protocolVersion !== undefined ? { protocolVersion } : {}),
        ...(desktopSessionId !== undefined ? { desktopSessionId } : {}),
        ...(capabilityRevision !== undefined ? { capabilityRevision } : {}),
        ...(pairingGeneration !== undefined ? { pairingGeneration } : {}),
      });
    },
  };
  return { registry, calls };
}

const FAKE_CAPS: RelayCapabilities = {
  profile: "desktop-agent",
  canReadWorkspace: true,
  canWriteWorkspace: true,
  canRunShell: true,
  allowedRoots: ["/tmp"],
  securityLevel: "standard",
  userHome: "/path/to/user",
  dataDir: "/path/to/user/.nautilo",
  toolsBin: "/usr/local/bin",
};

function makeRegisterMsg(
  overrides: Partial<RelayRegisterMessage> = {},
): RelayRegisterMessage {
  return {
    type: "relay:register",
    relayId: "relay-1",
    userId: "claimed-user-id",
    capabilities: FAKE_CAPS,
    protocolVersion: RELAY_PROTOCOL_VERSION,
    ...overrides,
  };
}

function stubStore(
  findActiveByHash: RelayTokenStore["findActiveByHash"],
): void {
  setRelayTokenStore({
    insertToken: async () => ({ id: "" }),
    pairForInstallation: async () => ({ id: "" }),
    findActiveByHash,
    withRegistrationAdmission: (_row, publish) => publish(),
    touchLastSeen: async () => {},
    listForUser: async () => [],
    revokeForUser: async () => false,
  });
}

describe("handleRelayRegister (M056)", () => {
  afterEach(() => {
    resetRelayTokenStore();
  });

  test("withdrawal between lookup and publication rejects registration", async () => {
    stubStore(async () => ({ id: "pairing", userId: "human", actorId: "actor" }));
    setRelayTokenStore({ ...getRelayTokenStore(), withRegistrationAdmission: async () => null });
    const { socket } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();
    const result = await handleRelayRegister(socket, makeRegisterMsg({ token: "rty_fixture" }), registry);
    expect(result.outcome).toBe("rejected-invalid-token");
    expect(calls).toHaveLength(0);
    expect(socket.readyState).toBe(3);
  });

  test("a socket closed during token lookup never enters the registry", async () => {
    const { socket } = makeFakeSocket();
    stubStore(async () => {
      socket.close();
      return { id: "pairing", userId: "human", actorId: "actor" };
    });
    const { registry, calls } = makeFakeRegistry();
    const result = await handleRelayRegister(socket, makeRegisterMsg({ token: "rty_fixture" }), registry);
    expect(result.outcome).toBe("connection-closed");
    expect(calls).toHaveLength(0);
  });

  test("a socket closed during registry publication retires only its exact connection", async () => {
    stubStore(async () => ({ id: "pairing", userId: "human", actorId: "actor" }));
    const { socket, events } = makeFakeSocket();
    let installed: ((msg: unknown) => void) | undefined;
    let retired = false;
    const registry: RelayRegistryLike = {
      getUserId: () => null,
      register: async (_id, _user, _caps, send) => { installed = send; socket.close(); },
      unregisterConnection: async (_id, send) => { expect(send).toBe(installed!); retired = true; },
    };
    expect((await handleRelayRegister(socket, makeRegisterMsg({ token: "rty_fixture" }), registry)).outcome).toBe("connection-closed");
    expect(retired).toBe(true);
    expect(events.some(e => (e.payload as { type?: string } | undefined)?.type === "relay:registered")).toBe(false);
  });

  test("the endpoint publishes its socket binding while admission is still locked", async () => {
    stubStore(async () => ({ id: "pairing", userId: "human", actorId: "actor" }));
    let locked = false;
    let bound = false;
    setRelayTokenStore({ ...getRelayTokenStore(), withRegistrationAdmission: async (_row, publish) => {
      locked = true;
      try { return await publish(); } finally { locked = false; }
    } });
    const { socket } = makeFakeSocket();
    const { registry } = makeFakeRegistry();
    const result = await handleRelayRegister(socket, makeRegisterMsg({ token: "rty_fixture" }), registry, undefined, () => {
      expect(locked).toBe(true); bound = true;
    });
    expect(result.outcome).toBe("registered");
    expect(bound).toBe(true);
    expect(locked).toBe(false);
  });

  test("an existing relay id cannot be replaced by another paired Human", async () => {
    stubStore(async () => ({ id: "pairing", userId: "different-human", actorId: "actor" }));
    const { socket } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();
    registry.getUserId = () => "original-human";
    expect((await handleRelayRegister(socket, makeRegisterMsg({ token: "rty_fixture" }), registry)).outcome).toBe("rejected-invalid-token");
    expect(calls).toHaveLength(0);
  });

  test("missing token → relay:error + 4401, registry untouched", async () => {
    stubStore(async () => null);
    const { socket, events } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg(),
      registry,
    );

    expect(result.outcome).toBe("rejected-no-token");
    expect(calls.length).toBe(0);
    const errEvent = events.find(
      (e) => e.kind === "send" && (e.payload as { type?: string }).type === "relay:error",
    );
    expect(errEvent).toBeDefined();
    expect(errEvent?.payload).toMatchObject({
      code: RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE,
    });
    const closeEvent = events.find((e) => e.kind === "close");
    expect(closeEvent?.code).toBe(RELAY_TOKEN_AUTH_CLOSE_CODE);
  });

  test("bogus token → relay:error + 4401, registry untouched", async () => {
    stubStore(async () => null);
    const { socket, events } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg({ token: "rty_obviously-wrong" }),
      registry,
    );

    expect(result.outcome).toBe("rejected-invalid-token");
    expect(calls.length).toBe(0);
    expect(
      events.some((e) => e.kind === "close" && e.code === RELAY_TOKEN_AUTH_CLOSE_CODE),
    ).toBe(true);
  });

  test("valid token + spoofed userId → registry receives validated.userId", async () => {
    stubStore(async () => ({
      id: "tok-1",
      userId: "real-owner-uuid",
      actorId: "real-actor-uuid",
    }));
    const { socket } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();

    const result = await handleRelayRegister(
      socket,
      // Attacker presents a valid token but lies about userId.
      makeRegisterMsg({ token: "rty_valid-token", userId: "victim-uuid" }),
      registry,
    );

    expect(result.outcome).toBe("registered");
    expect(calls.length).toBe(1);
    expect(calls[0]?.userId).toBe("real-owner-uuid");
    expect(calls[0]?.userId).not.toBe("victim-uuid");
    expect(calls[0]?.protocolVersion).toBe(RELAY_PROTOCOL_VERSION);
  });

  test("D418 Commit 2 — registry receives validated.tokenId as server-derived pairingGeneration (never client-authored)", async () => {
    stubStore(async () => ({
      id: "tok-row-42",
      userId: "real-owner-uuid",
      actorId: "real-actor-uuid",
    }));
    const { socket } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg({
        token: "rty_valid-token",
        desktopSessionId: "desktop-session-1",
        capabilityRevision: 3,
      }),
      registry,
    );

    expect(result.outcome).toBe("registered");
    expect(calls.length).toBe(1);
    // The pairing generation is stamped from the validated token row id,
    // not from any relay/client payload field.
    expect(calls[0]?.pairingGeneration).toBe("tok-row-42");
    expect(calls[0]?.desktopSessionId).toBe("desktop-session-1");
    expect(calls[0]?.capabilityRevision).toBe(3);
  });

  test("server rejects protocols below its compatibility floor before token validation", async () => {
    let storeHit = false;
    stubStore(async () => {
      storeHit = true;
      return {
        id: "tok-1",
        userId: "real-owner-uuid",
        actorId: "real-actor-uuid",
      };
    });
    const { socket } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg({ token: "rty_valid-token", protocolVersion: 1 }),
      registry,
    );

    expect(result.outcome).toBe("version-mismatch");
    expect(storeHit).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("current Codex-capable acknowledgement contains only server-minted session and opaque pairing fields", async () => {
    stubStore(async () => ({
      id: "tok-row-42",
      userId: "real-owner-uuid",
      actorId: "real-actor-uuid",
    }));
    const { socket, events } = makeFakeSocket();
    const base = makeFakeRegistry();
    const registry = {
      ...base.registry,
      getV8Acknowledgement: () => ({
        relaySessionId: "server-session-1",
        pairingGenerationRef: "opaque-pair-ref-1",
      }),
    } as unknown as RelayRegistryLike;

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg({
        token: "rty_valid-token",
        protocolVersion: RELAY_PROTOCOL_VERSION,
        capabilities: {
          profile: "desktop-agent",
          codex: { version: 1, hostKind: "electron", maxProfiles: 4, maxActiveTurns: 4 },
        },
      }),
      registry,
    );

    expect(result.outcome).toBe("registered");
    const ack = events.find((event) => (event.payload as { type?: string } | undefined)?.type === "relay:registered")?.payload as Record<string, unknown>;
    expect(ack).toEqual({
      type: "relay:registered",
      relayId: "relay-1",
      protocolVersion: RELAY_PROTOCOL_VERSION,
      relaySessionId: "server-session-1",
      pairingGenerationRef: "opaque-pair-ref-1",
      selectedProtocolVersion: RELAY_PROTOCOL_VERSION,
    });
    expect(ack["userId"]).toBeUndefined();
  });

  test("selects the highest common protocol and its version-specific capabilities", async () => {
    stubStore(async () => ({
      id: "tok-1",
      userId: "real-owner-uuid",
      actorId: "real-actor-uuid",
    }));
    const { socket, events } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();
    const v10Capabilities: RelayCapabilities = {
      ...FAKE_CAPS,
      workspaceRoot: "/path/to/user/Nautilo",
    };

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg({
        token: "rty_valid-token",
        protocolVersion: RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
        protocolRange: {
          minimum: RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
          maximum: RELAY_PROTOCOL_VERSION,
        },
        capabilitiesByProtocolVersion: {
          [String(RELAY_PROTOCOL_VERSION)]: v10Capabilities,
        },
      }),
      registry,
    );

    expect(result.outcome).toBe("registered");
    expect(calls[0]?.protocolVersion).toBe(RELAY_PROTOCOL_VERSION);
    expect(calls[0]?.capabilities.workspaceRoot).toBe("/path/to/user/Nautilo");
    expect(events.some((event) =>
      event.kind === "send" &&
      (event.payload as { type?: string }).type === "relay:registered" &&
      (event.payload as { protocolVersion?: number }).protocolVersion === RELAY_PROTOCOL_VERSION
    )).toBe(true);
  });

  test("a v10-only server policy rejects a v9-only relay", async () => {
    let storeHit = false;
    stubStore(async () => {
      storeHit = true;
      return null;
    });
    const { socket } = makeFakeSocket();
    const { registry } = makeFakeRegistry();

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg({ protocolVersion: 9 }),
      registry,
      { minimum: 10, maximum: 10 },
    );

    expect(result.outcome).toBe("version-mismatch");
    expect(storeHit).toBe(false);
  });

  test("negotiated v9 strips Computer Files capabilities but preserves shell", async () => {
    stubStore(async () => ({
      id: "tok-1",
      userId: "real-owner-uuid",
      actorId: "real-actor-uuid",
    }));
    const { socket } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg({
        token: "rty_valid-token",
        protocolVersion: 9,
        capabilities: {
          ...FAKE_CAPS,
          workspaceRoot: "/path/to/user/Nautilo",
          currentFolderRoot: "/path/to/user/project",
        },
      }),
      registry,
      { minimum: 9, maximum: 9 },
    );

    expect(result.outcome).toBe("registered");
    expect(calls[0]?.protocolVersion).toBe(9);
    expect(calls[0]?.capabilities.canRunShell).toBe(true);
    expect(calls[0]?.capabilities.canReadWorkspace).toBeUndefined();
    expect(calls[0]?.capabilities.canWriteWorkspace).toBeUndefined();
    expect(calls[0]?.capabilities.workspaceRoot).toBeUndefined();
    expect(calls[0]?.capabilities.currentFolderRoot).toBeUndefined();
  });

  test("unsupported protocol version closes with 1002 and bypasses validator", async () => {
    let storeHit = false;
    stubStore(async () => {
      storeHit = true;
      return null;
    });
    const { socket, events } = makeFakeSocket();
    const { registry, calls } = makeFakeRegistry();

    const result = await handleRelayRegister(
      socket,
      makeRegisterMsg({ protocolVersion: 999 as unknown as typeof RELAY_PROTOCOL_VERSION }),
      registry,
    );

    expect(result.outcome).toBe("version-mismatch");
    expect(storeHit).toBe(false);
    expect(calls.length).toBe(0);
    expect(events.find((e) => e.kind === "close")?.code).toBe(1002);
  });
});

describe("local MCP safety-close session guard", () => {
  test("never closes a relay socket after its Desktop session has been replaced", () => {
    expect(isExpectedRelayDesktopSession("desktop-session-1", "desktop-session-1")).toBe(true);
    expect(isExpectedRelayDesktopSession("replacement-session", "desktop-session-1")).toBe(false);
    expect(isExpectedRelayDesktopSession(null, "desktop-session-1")).toBe(false);
  });
});

describe("negotiateRelayProtocolVersion", () => {
  test("chooses the highest value in the client/server intersection", () => {
    expect(negotiateRelayProtocolVersion({
      protocolVersion: 9,
      protocolRange: { minimum: 9, maximum: 10 },
    }, { minimum: 9, maximum: 10 })).toBe(10);
    expect(negotiateRelayProtocolVersion({
      protocolVersion: 9,
      protocolRange: { minimum: 9, maximum: 10 },
    }, { minimum: 9, maximum: 9 })).toBe(9);
  });

  test("rejects malformed ranges and disjoint policies", () => {
    expect(negotiateRelayProtocolVersion({
      protocolVersion: 9,
      protocolRange: { minimum: 10, maximum: 9 },
    }, { minimum: 9, maximum: 10 })).toBeNull();
    expect(negotiateRelayProtocolVersion({
      protocolVersion: 9,
      protocolRange: { minimum: 9, maximum: 9 },
    }, { minimum: 10, maximum: 10 })).toBeNull();
  });
});

describe("handleRelayResult (M196)", () => {
  test("passes machine errorCode through to pending dispatch", () => {
    let captured: unknown = null;
    const registry = {
      resolveDispatch(_correlationId: string, result: unknown) {
        captured = result;
      },
    };

    const msg: RelayResultMessage = {
      type: "relay:result",
      correlationId: "relay-1:dispatch-1",
      status: "error",
      error: "Google Workspace is not connected.",
      errorCode: "google_auth_required",
      durationMs: 12,
    };

    handleRelayResult(msg, registry);

    expect(captured).toEqual({
      status: "error",
      result: undefined,
      error: "Google Workspace is not connected.",
      errorCode: "google_auth_required",
      networkDeniedDestination: undefined,
      durationMs: 12,
    });
  });
});

describe("D502 relay:run-shell-progress ingress", () => {
  test("accepts only the bounded, internally consistent v1 envelope", () => {
    const valid = {
      type: "relay:run-shell-progress" as const,
      correlationId: "relay-1:dispatch-1",
      version: 1 as const,
      sequence: 0,
      stream: "stdout" as const,
      offsetBytes: 0,
      endOffsetBytes: 3,
      text: "€",
      elapsedMs: 1,
      phase: "running" as const,
    };
    expect(isValidRelayRunShellProgress(valid)).toBe(true);
    expect(isValidRelayRunShellProgress({ ...valid, endOffsetBytes: 2 })).toBe(false);
    expect(isValidRelayRunShellProgress({ ...valid, text: "x".repeat(4097), endOffsetBytes: 4097 })).toBe(false);
    expect(isValidRelayRunShellProgress({ ...valid, droppedBytes: -1 })).toBe(false);
  });

  test("rejects an oversized progress frame before JSON parsing", () => {
    const raw = JSON.stringify({ type: "relay:run-shell-progress", padding: "x".repeat(9 * 1024) });
    expect(parseRelayEndpointClientMessage(raw)).toEqual({
      ok: false,
      codex: false,
      error: "RUN_SHELL_PROGRESS_FRAME_TOO_LARGE",
    });
  });
});

describe("D500 relay:structured-ssh-progress ingress", () => {
  test("accepts bounded output and transfer observations but rejects malformed or leaky shapes", () => {
    const output = {
      type: "relay:structured-ssh-progress" as const,
      correlationId: "relay-1:dispatch-1",
      version: 1 as const,
      sequence: 0,
      operation: "exec" as const,
      kind: "exec-output" as const,
      stream: "stdout" as const,
      offsetBytes: 0,
      endOffsetBytes: 3,
      text: "€",
      elapsedMs: 1,
      phase: "running" as const,
    };
    const transfer = {
      type: "relay:structured-ssh-progress" as const,
      correlationId: "relay-1:dispatch-1",
      version: 1 as const,
      sequence: 1,
      operation: "copy-upload" as const,
      kind: "transfer" as const,
      phase: "transferring" as const,
      transferredBytes: 3,
      totalBytes: 5,
      elapsedMs: 2,
    };
    expect(isValidRelayStructuredSshProgress(output)).toBe(true);
    expect(isValidRelayStructuredSshProgress(transfer)).toBe(true);
    expect(isValidRelayStructuredSshProgress({ ...output, destination: "must-not-cross" } as typeof output)).toBe(false);
    expect(isValidRelayStructuredSshProgress({ ...output, endOffsetBytes: 2 })).toBe(false);
    expect(isValidRelayStructuredSshProgress({ ...transfer, transferredBytes: 6 })).toBe(false);
  });

  test("rejects an oversized structured SSH progress frame before JSON parsing", () => {
    const raw = JSON.stringify({ type: "relay:structured-ssh-progress", padding: "x".repeat(9 * 1024) });
    expect(parseRelayEndpointClientMessage(raw)).toEqual({
      ok: false,
      codex: false,
      error: "STRUCTURED_SSH_PROGRESS_FRAME_TOO_LARGE",
    });
  });
});
