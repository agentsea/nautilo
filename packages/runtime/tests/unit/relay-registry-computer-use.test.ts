import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION, RELAY_PROTOCOL_VERSION, type RelayCapabilities, type RelayServerMessage } from "@nautilo/relay";
import { COMPUTER_USE_SEMANTIC_VERSION } from "@nautilo/types";
import type { ToolRelayRegistry } from "../../../agent/src/nodes/tools";
import { buildRuntimeCapabilityTokens } from "../../../agent/src/runtime/relay-capabilities";
import {
  InMemoryRelayRegistry,
  RelayDispatchOutcomeUnknownError,
} from "../../src/relay-registry";

const SNAPSHOT = {
  enabled: true as const,
  agentId: "agent-1",
  installationEpoch: "epoch-1",
  grantGeneration: 4,
  provider: "cua" as const,
  providerGeneration: "provider-generation-1",
};

const PAIRING_GENERATION_REF = `pairing-${createHash("sha256")
  .update("nautilo-relay-v8:pairing-1")
  .digest("base64url")}`;

const DESKTOP_AUTOMATION_BINDING = {
  version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  computerUseContextId: "context-1",
  computerUseInvocationId: "computer-invocation:fixture-1",
  originHumanId: "human-1",
  originRunId: "run-1",
  originAgentId: "agent-1",
  lineageId: "lineage-1",
  installationEpoch: "epoch-1",
  grantGeneration: 4,
  provider: "cua" as const,
  providerGeneration: "provider-generation-1",
  relayId: "relay-1",
  pairingGeneration: PAIRING_GENERATION_REF,
  desktopSessionId: "session-1",
};

const COMPUTER_USE_REQUEST = {
  contract: {
    contractNamespace: "nautilo.computer_use",
    contractId: "native.observe",
    contractVersion: 1,
    schemaDigest: `sha256:${"a".repeat(64)}`,
    effectClass: "read" as const,
    replayClass: "safe" as const,
    authorityClass: "standing_computer_use" as const,
    attachmentClass: "png" as const,
    disclosureClass: "semantic_and_visual" as const,
  },
  arguments: { operation: "desktop_state" },
};

const V10_SNAPSHOT = {
  ...SNAPSHOT,
  grantGeneration: 5,
  providerGeneration: "provider-generation-2",
};

const V10_DESKTOP_AUTOMATION_BINDING = {
  ...DESKTOP_AUTOMATION_BINDING,
  version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
  grantGeneration: V10_SNAPSHOT.grantGeneration,
  providerGeneration: V10_SNAPSHOT.providerGeneration,
};

function semanticCapabilities(capabilities: Omit<RelayCapabilities, "computerUseSemanticVersion">): RelayCapabilities {
  return { ...capabilities, computerUseSemanticVersion: COMPUTER_USE_SEMANTIC_VERSION };
}

async function registeredRegistry(capabilities: RelayCapabilities): Promise<InMemoryRelayRegistry> {
  const registry = new InMemoryRelayRegistry();
  await registry.register(
    "relay-1",
    "human-1",
    capabilities.desktopAutomation === undefined ? capabilities : semanticCapabilities(capabilities),
    () => {},
    RELAY_PROTOCOL_VERSION,
    "session-1",
    0,
    "pairing-1",
  );
  return registry;
}

describe("InMemoryRelayRegistry Computer Use snapshot", () => {
  test("Host descriptors are copied, replaced, and cleared with the Desktop capability snapshot", async () => {
    const contracts = [COMPUTER_USE_REQUEST.contract];
    const registry = await registeredRegistry({
      profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT,
      computerUseHostContracts: contracts,
    });
    expect(registry.getCapabilities("relay-1")?.computerUseHostContracts).toEqual(contracts);
    contracts.length = 0;
    expect(registry.getCapabilities("relay-1")?.computerUseHostContracts).toHaveLength(1);
    for (const [index, advertised] of [[COMPUTER_USE_REQUEST.contract, COMPUTER_USE_REQUEST.contract], []].entries()) {
      expect(registry.updateCapabilities({
        relayId: "relay-1", userId: "human-1", desktopSessionId: "session-1", capabilityRevision: index + 1,
        capabilities: semanticCapabilities({ profile: "desktop-agent", canControlDesktop: true,
          desktopAutomation: SNAPSHOT, computerUseHostContracts: advertised }),
      })).toEqual({ ok: true });
      // A malformed advertisement must not become legacy omission.
      expect(registry.getCapabilities("relay-1")?.computerUseHostContracts).toEqual([]);
    }
    expect(registry.updateCapabilities({
      relayId: "relay-1", userId: "human-1", desktopSessionId: "session-1", capabilityRevision: 3,
      capabilities: { profile: "desktop-agent", canControlDesktop: false },
    })).toEqual({ ok: true });
    expect(registry.getCapabilities("relay-1")?.computerUseHostContracts).toBeUndefined();
  });

  async function lifetimeFixture() {
    const sent: RelayServerMessage[] = [];
    const registry = new InMemoryRelayRegistry({
      authorizeDesktopAutomationDispatch: () => true,
    });
    await registry.register("relay-1", "human-1", semanticCapabilities({
      profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT,
    }), message => { sent.push(message); }, RELAY_PROTOCOL_VERSION, "session-1", 0, "pairing-1");
    const controller = new AbortController();
    const request = {
      toolName: "future_catalogue_mutation", args: {}, impact: "high" as const,
      approvalObtained: true, executionClass: "computer_use" as const,
      desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
      computerUseRequest: COMPUTER_USE_REQUEST, signal: controller.signal,
    };
    return { registry, sent, controller, request };
  }

  test("admitted Computer Use is signal-owned, with no generic RPC execution deadline", async () => {
    const { registry, sent, request } = await lifetimeFixture();
    const timers = spyOn(globalThis, "setTimeout");
    const pending = registry.dispatch("relay-1", request);
    await Promise.resolve();
    try {
      // No timer exists to cancel otherwise valid work at 60 seconds (or at
      // any replacement magic duration). The executor owns its completion.
      expect(timers.mock.calls).toHaveLength(0);
    } finally { timers.mockRestore(); }
    const frame = sent[0];
    if (frame?.type !== "relay:dispatch") throw new Error("Missing dispatch");
    registry.resolveDispatch(frame.correlationId, { status: "ok", result: { settlement: "completed" } });
    expect(await pending).toMatchObject({ status: "ok", result: { settlement: "completed" } });
    expect(sent).toHaveLength(1);
  });

  test.each(["timeout", "cancel"] as const)("a lost callback after %s is outcome-unknown, not evidence of Human Stop", async reason => {
    const { registry, sent, controller, request } = await lifetimeFixture();
    const pending = registry.dispatch("relay-1", { ...request, ...(reason === "timeout" ? { timeout: 1 } : {}) });
    const outcome = pending.catch((error: unknown) => error);
    await Promise.resolve();
    if (reason === "cancel") controller.abort();
    else await new Promise(resolve => setTimeout(resolve, 5));
    const frame = sent[0];
    if (frame?.type !== "relay:dispatch") throw new Error("Missing dispatch");
    registry.resolveDispatch(frame.correlationId, { status: "error", error: "Relay Host callback was cancelled" });
    const error = await outcome;
    expect(error).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect(error).toMatchObject({ reason, desktopAutomationOutcome: "unknown" });
    expect(sent.filter(message => message.type === "relay:cancel")).toHaveLength(1);
  });

  test("Stop retains the original invocation beyond the former receipt grace without replay", async () => {
    const { registry, sent, controller, request } = await lifetimeFixture();
    const outcome = registry.dispatch("relay-1", request).catch((error: unknown) => error);
    await Promise.resolve();
    const timers = spyOn(globalThis, "setTimeout");
    controller.abort();
    registry.cancelDispatch((sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>).correlationId);
    const expiryCallbacks = timers.mock.calls.map(([callback]) => callback);
    timers.mockRestore();
    // Advance every scheduled post-cancel deadline deterministically. With
    // the old implementation this destroys the correlation before readback.
    for (const callback of expiryCallbacks) if (typeof callback === "function") callback();
    const frame = sent[0];
    if (frame?.type !== "relay:dispatch") throw new Error("Missing dispatch");
    const receipt = { status: "ok" as const, result: { settlement: "cancelled",
      result: { textDelivery: { requestedCharacters: 289, deliveredCharacters: 73 }, completionCertainty: "partially_completed" },
    } };
    registry.resolveDispatch(frame.correlationId, receipt);
    expect(await outcome).toEqual(receipt);
    expect(expiryCallbacks).toHaveLength(0);
    expect(sent.filter(message => message.type === "relay:cancel")).toHaveLength(1);
    expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
  });

  test("unowned Computer Use retains the fallback instead of creating an immortal request", async () => {
    const { registry, sent, request } = await lifetimeFixture();
    const { signal: _signal, ...unowned } = request;
    const timers = spyOn(globalThis, "setTimeout");
    const pending = registry.dispatch("relay-1", unowned);
    await Promise.resolve();
    try { expect(timers.mock.calls).toHaveLength(1); }
    finally { timers.mockRestore(); }
    const frame = sent[0];
    if (frame?.type !== "relay:dispatch") throw new Error("Missing dispatch");
    registry.resolveDispatch(frame.correlationId, { status: "ok", result: { settlement: "completed" } });
    expect(await pending).toMatchObject({ status: "ok" });
  });

  test("an explicit deadline cancels immediately but does not impose another receipt deadline", async () => {
    const { registry, sent, request } = await lifetimeFixture();
    const timers = spyOn(globalThis, "setTimeout");
    const outcome = registry.dispatch("relay-1", { ...request, timeout: 100 });
    await Promise.resolve();
    expect(timers.mock.calls).toHaveLength(1);
    const deadline = timers.mock.calls[0]![0];
    if (typeof deadline !== "function") throw new Error("Missing deadline");
    deadline();
    const timerCount = timers.mock.calls.length;
    timers.mockRestore();
    const frame = sent[0];
    if (frame?.type !== "relay:dispatch") throw new Error("Missing dispatch");
    registry.resolveDispatch(frame.correlationId, { status: "ok", result: { settlement: "completed" } });
    expect(await outcome).toMatchObject({ status: "ok", result: { settlement: "completed" } });
    expect(timerCount).toBe(1);
    expect(sent.filter(message => message.type === "relay:cancel")).toHaveLength(1);
  });

  test("a replacement cannot inherit a cancelled invocation or accept its late receipt", async () => {
    const { registry, sent, controller, request } = await lifetimeFixture();
    const old = registry.dispatch("relay-1", request).catch((error: unknown) => error);
    await Promise.resolve();
    controller.abort();
    const oldFrame = sent[0];
    if (oldFrame?.type !== "relay:dispatch") throw new Error("Missing old dispatch");
    const replacement: RelayServerMessage[] = [];
    await registry.register("relay-1", "human-1", semanticCapabilities({
      profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT,
    }), message => { replacement.push(message); }, RELAY_PROTOCOL_VERSION, "session-1", 0, "pairing-1");
    expect(await old).toMatchObject({ desktopAutomationOutcome: "unknown", reason: "replacement" });
    let settled = false;
    const fresh = registry.dispatch("relay-1", { ...request, signal: new AbortController().signal });
    void fresh.then(() => { settled = true; });
    await Promise.resolve();
    registry.resolveDispatch(oldFrame.correlationId, { status: "ok", result: { settlement: "completed" } });
    registry.cancelDispatch(oldFrame.correlationId);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(replacement.filter(message => message.type === "relay:cancel")).toHaveLength(0);
    const freshFrame = replacement[0];
    if (freshFrame?.type !== "relay:dispatch") throw new Error("Missing fresh dispatch");
    registry.resolveDispatch(freshFrame.correlationId, { status: "ok", result: { settlement: "not_completed" } });
    expect(await fresh).toMatchObject({ status: "ok", result: { settlement: "not_completed" } });
    expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
    expect(replacement.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
  });

  test("signal-owned work still settles unknown on disconnect without replay", async () => {
    const { registry, sent, request } = await lifetimeFixture();
    const outcome = registry.dispatch("relay-1", request).catch((error: unknown) => error);
    await Promise.resolve();
    await registry.unregister("relay-1");
    expect(await outcome).toMatchObject({ desktopAutomationOutcome: "unknown", reason: "disconnect" });
    expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
  });

  test("drops the complete semantic Computer Use tuple from an older relay protocol", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register("relay-old", "human-1", semanticCapabilities({
      profile: "desktop-agent",
      canControlDesktop: true,
      desktopAutomation: SNAPSHOT,
    }), () => {}, 16, "session-old", 0, "pairing-old");
    expect(registry.getCapabilities("relay-old")).toEqual({ profile: "desktop-agent" });
    expect(registry.snapshotForComputerUse("human-1")[0]).toMatchObject({
      relayId: "relay-old",
      canControlDesktop: false,
      desktopAutomation: null,
    });
  });

  test("retains and returns only the redacted, cloned exact live tuple", async () => {
    const registry = await registeredRegistry({
      profile: "desktop-agent",
      canControlDesktop: true,
      desktopAutomation: SNAPSHOT,
    });
    const snapshot = registry.snapshotForComputerUse("human-1");
    const pairingGenerationRef = snapshot[0]!.pairingGenerationRef;
    expect(typeof pairingGenerationRef).toBe("string");
    expect(snapshot).toEqual([{
      relayId: "relay-1",
      userId: "human-1",
      pairingGeneration: "pairing-1",
      pairingGenerationRef,
      desktopSessionId: "session-1",
      canControlDesktop: true,
      desktopAutomation: SNAPSHOT,
    }]);
    expect(snapshot[0]!.pairingGenerationRef).not.toBe("pairing-1");
    const first = registry.snapshotForComputerUse("human-1");
    const second = registry.snapshotForComputerUse("human-1");
    expect(first).not.toBe(second);
    expect(first[0]!.desktopAutomation).not.toBe(second[0]!.desktopAutomation);
    expect(registry.snapshotForComputerUse("other-human")).toEqual([]);
  });

  test("drops malformed or non-desktop registration snapshots without keeping stale authority", async () => {
    const malformed = await registeredRegistry({
      profile: "desktop-agent",
      desktopAutomation: { ...SNAPSHOT, extra: true } as unknown as typeof SNAPSHOT,
    } as RelayCapabilities);
    expect(malformed.snapshotForComputerUse("human-1")[0]!.desktopAutomation).toBeNull();

    const { providerGeneration: _providerGeneration, ...missingProviderGeneration } = SNAPSHOT;
    const missing = await registeredRegistry({
      profile: "desktop-agent",
      desktopAutomation: missingProviderGeneration,
    } as unknown as RelayCapabilities);
    expect(missing.snapshotForComputerUse("human-1")[0]!.desktopAutomation).toBeNull();

    const nonDesktop = await registeredRegistry({
      profile: "device-relay",
      desktopAutomation: SNAPSHOT,
    } as RelayCapabilities);
    expect(nonDesktop.snapshotForComputerUse("human-1")).toEqual([]);
  });

  test("a malformed authenticated Desktop receipt creates no Computer Use authority", async () => {
    const malformed = await registeredRegistry({
      profile: "desktop-agent",
      canControlDesktop: true,
      desktopAutomation: { ...SNAPSHOT, extra: true } as unknown as typeof SNAPSHOT,
    } as RelayCapabilities);
    const malformedCapabilities = malformed.getCapabilities("relay-1");
    expect(malformedCapabilities?.desktopAutomation).toBeUndefined();
    expect(malformedCapabilities?.computerUseSemanticVersion).toBe(COMPUTER_USE_SEMANTIC_VERSION);
    const malformedTokens = buildRuntimeCapabilityTokens(
      malformed as unknown as ToolRelayRegistry,
      "human-1",
      "agent-1",
    );
    expect(malformedTokens?.["canUseComputer"]).toBeUndefined();
    expect(malformedTokens?.["control_desktop"]).toBeUndefined();

    const oldRelay = await registeredRegistry({
      profile: "desktop-agent",
      canControlDesktop: true,
    });
    const oldCapabilities = oldRelay.getCapabilities("relay-1");
    expect(oldCapabilities?.desktopAutomation).toBeUndefined();
    expect(oldCapabilities?.computerUseSemanticVersion).toBeUndefined();
    const oldTokens = buildRuntimeCapabilityTokens(
      oldRelay as unknown as ToolRelayRegistry,
      "human-1",
      "agent-1",
    );
    expect(oldTokens?.["canUseComputer"]).toBeUndefined();
    expect(oldTokens?.["control_desktop"]).toBeUndefined();
  });

  test("a marker-only relay creates no Computer Use catalog tokens", async () => {
    const registry = new InMemoryRelayRegistry();
    await registry.register(
      "modern-relay",
      "human-1",
      { profile: "desktop-agent", computerUseSemanticVersion: COMPUTER_USE_SEMANTIC_VERSION },
      () => {},
      RELAY_PROTOCOL_VERSION,
      "modern-session",
      0,
      "modern-pairing",
    );
    await registry.register(
      "legacy-relay",
      "human-1",
      { profile: "desktop-agent", canControlDesktop: true },
      () => {},
      RELAY_PROTOCOL_VERSION,
      "legacy-session",
      0,
      "legacy-pairing",
    );
    const tokens = buildRuntimeCapabilityTokens(
      registry as unknown as ToolRelayRegistry,
      "human-1",
      "agent-1",
    );
    expect(tokens?.["canUseComputer"]).toBeUndefined();
    expect(tokens?.["control_desktop"]).toBeUndefined();
  });

  test("atomically replaces then clears the snapshot on full capability updates", async () => {
    const registry = await registeredRegistry({ profile: "desktop-agent", desktopAutomation: SNAPSHOT });
    const updated = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "human-1",
      desktopSessionId: "session-1",
      capabilityRevision: 1,
      capabilities: semanticCapabilities({
        profile: "desktop-agent",
        canControlDesktop: true,
        desktopAutomation: { ...SNAPSHOT, installationEpoch: "epoch-2", grantGeneration: 5 },
      }),
    });
    expect(updated).toEqual({ ok: true });
    expect(registry.snapshotForComputerUse("human-1")[0]!.desktopAutomation).toEqual({
      ...SNAPSHOT,
      installationEpoch: "epoch-2",
      grantGeneration: 5,
    });
    const cleared = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "human-1",
      desktopSessionId: "session-1",
      capabilityRevision: 2,
      capabilities: semanticCapabilities({ profile: "desktop-agent", canControlDesktop: false }),
    });
    expect(cleared).toEqual({ ok: true });
    expect(registry.snapshotForComputerUse("human-1")[0]!.desktopAutomation).toBeNull();
    const clearedCapabilities = registry.getCapabilities("relay-1");
    expect(clearedCapabilities?.computerUseSemanticVersion).toBe(COMPUTER_USE_SEMANTIC_VERSION);
    expect(clearedCapabilities?.desktopAutomation).toBeUndefined();
    const clearedTokens = buildRuntimeCapabilityTokens(
      registry as unknown as ToolRelayRegistry,
      "human-1",
      "agent-1",
    );
    expect(clearedTokens?.["canUseComputer"]).toBeUndefined();
    expect(clearedTokens?.["control_desktop"]).toBeUndefined();
  });

  test("accepts the exact Cua-only capability update and publishes semantic Computer Use tokens", async () => {
    const registry = await registeredRegistry({
      profile: "desktop-agent",
      canControlDesktop: true,
      desktopAutomation: SNAPSHOT,
    });

    const updated = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "human-1",
      desktopSessionId: "session-1",
      capabilityRevision: 1,
      capabilities: semanticCapabilities({
        profile: "desktop-agent",
        canControlDesktop: true,
        desktopAutomation: V10_SNAPSHOT,
      }),
    });

    expect(updated).toEqual({ ok: true });
    expect(registry.snapshotForComputerUse("human-1")[0]!.desktopAutomation).toEqual(V10_SNAPSHOT);

    const tokens = buildRuntimeCapabilityTokens(
      registry as unknown as ToolRelayRegistry,
      "human-1",
      "agent-1",
    );
    expect(tokens).toMatchObject({
      canUseComputer: true,
      canComputerDo: true,
      canComputerVerify: true,
      canComputerTargetedObserve: true,
      canComputerWindowCreation: true,
      canComputerElementTargeting: true,
    });
    expect(tokens?.["control_desktop"]).toBeUndefined();
  });

  test("rejects malformed updates and preserves the prior exact snapshot", async () => {
    const registry = await registeredRegistry({
      profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT,
    });
    const rejected = registry.updateCapabilities({
      relayId: "relay-1",
      userId: "human-1",
      desktopSessionId: "session-1",
      capabilityRevision: 1,
      capabilities: {
        profile: "desktop-agent",
        computerUseSemanticVersion: COMPUTER_USE_SEMANTIC_VERSION,
        desktopAutomation: { ...SNAPSHOT, enabled: false },
      } as unknown as RelayCapabilities,
    });
    expect(rejected.ok).toBe(false);
    expect(registry.snapshotForComputerUse("human-1")[0]!.desktopAutomation).toEqual(SNAPSHOT);
  });

  test("rejects an active Cua snapshot without its exact marker and readiness facts", async () => {
    const registry = await registeredRegistry({
      profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT,
    });
    for (const capabilities of [
      { profile: "desktop-agent", canControlDesktop: true, desktopAutomation: V10_SNAPSHOT },
      {
        profile: "desktop-agent",
        computerUseSemanticVersion: COMPUTER_USE_SEMANTIC_VERSION,
        canControlDesktop: false,
        desktopAutomation: V10_SNAPSHOT,
      },
    ] as const) {
      const rejected = registry.updateCapabilities({
        relayId: "relay-1",
        userId: "human-1",
        desktopSessionId: "session-1",
        capabilityRevision: 1,
        capabilities: capabilities as unknown as RelayCapabilities,
      });
      expect(rejected.ok).toBe(false);
      expect(registry.snapshotForComputerUse("human-1")[0]!.desktopAutomation).toEqual(SNAPSHOT);
    }
  });

  test("rejects semantic dispatch on a pre-v17 relay before authorization or send", async () => {
    const sent: RelayServerMessage[] = [];
    let authorizationCalls = 0;
    const registry = new InMemoryRelayRegistry({
      authorizeDesktopAutomationDispatch: () => {
        authorizationCalls += 1;
        return true;
      },
    });
    registry.register(
      "relay-1",
      "human-1",
      semanticCapabilities({ profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT }),
      (message) => { sent.push(message); },
      16,
      "session-1",
      0,
      "pairing-1",
    );

    let error: unknown;
    try {
      await registry.dispatch("relay-1", {
        toolName: "future_catalogue_observe",
        args: { operation: "desktop_state" },
        impact: "read-only",
        approvalObtained: true,
        executionClass: "computer_use",
        desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain("authorization denied");
    expect(authorizationCalls).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("rejects a previously admitted binding after the live Cua route changes", async () => {
    const sent: RelayServerMessage[] = [];
    let authorizationCalls = 0;
    const registry = new InMemoryRelayRegistry({
      authorizeDesktopAutomationDispatch: () => {
        authorizationCalls += 1;
        return true;
      },
    });
    registry.register(
      "relay-1",
      "human-1",
      semanticCapabilities({ profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT }),
      (message) => { sent.push(message); },
      RELAY_PROTOCOL_VERSION,
      "session-1",
      0,
      "pairing-1",
    );
    expect(registry.updateCapabilities({
      relayId: "relay-1",
      userId: "human-1",
      desktopSessionId: "session-1",
      capabilityRevision: 1,
      capabilities: semanticCapabilities({
        profile: "desktop-agent",
        canControlDesktop: true,
        desktopAutomation: V10_SNAPSHOT,
      }),
    })).toEqual({ ok: true });

    let error: unknown;
    try {
      await registry.dispatch("relay-1", {
        toolName: "future_catalogue_observe",
        args: { operation: "desktop_state" },
        impact: "read-only",
        approvalObtained: true,
        executionClass: "computer_use",
        desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toContain("authorization denied");
    expect(authorizationCalls).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("forwards an exact binding for an unknown future Computer Use catalogue key", async () => {
    const sent: RelayServerMessage[] = [];
    let authorization: unknown;
    const registry = new InMemoryRelayRegistry({
      authorizeDesktopAutomationDispatch: (input) => {
        authorization = input;
        return true;
      },
    });
    registry.register(
      "relay-1",
      "human-1",
      semanticCapabilities({ profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT }),
      (message) => { sent.push(message); },
      RELAY_PROTOCOL_VERSION,
      "session-1",
      0,
      "pairing-1",
    );
    const pending = registry.dispatch("relay-1", {
      toolName: "future_catalogue_operation",
      args: { operation: "desktop_state" },
      impact: "high",
      approvalObtained: true,
      executionClass: "computer_use",
      desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
      computerUseRequest: COMPUTER_USE_REQUEST,
    });
    await Promise.resolve();
    const frame = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(authorization).toEqual({
      userId: "human-1",
      agentId: "agent-1",
      toolName: "future_catalogue_operation",
    });
    expect(frame.desktopAutomationBinding).toEqual(DESKTOP_AUTOMATION_BINDING);
    expect(frame.computerUseRequest).toEqual(COMPUTER_USE_REQUEST);
    registry.resolveDispatch(frame.correlationId, { status: "ok", result: "observed" });
    expect(await pending).toEqual({ status: "ok", result: "observed" });
  });

  test("forwards exact catalogue arguments without interpreting their operation shape", async () => {
    const sent: RelayServerMessage[] = [];
    const registry = new InMemoryRelayRegistry({ authorizeDesktopAutomationDispatch: () => true });
    registry.register(
      "relay-1",
      "human-1",
      semanticCapabilities({ profile: "desktop-agent", canControlDesktop: true, desktopAutomation: V10_SNAPSHOT }),
      (message) => { sent.push(message); },
      RELAY_PROTOCOL_VERSION,
      "session-1",
      0,
      "pairing-1",
    );
    const target = {
      version: 1 as const,
      context: `dctx_${"a".repeat(43)}`,
      reference: `dtgt_${"b".repeat(43)}`,
    };
    const args = { operation: "window_state", target, selector: { role: "text_area" } };
    const pending = registry.dispatch("relay-1", {
      toolName: "future_catalogue_observe",
      args,
      impact: "read-only",
      approvalObtained: true,
      executionClass: "computer_use",
      desktopAutomationBinding: V10_DESKTOP_AUTOMATION_BINDING,
    });
    await Promise.resolve();
    const frame = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;
    expect(frame.args).toEqual(args);
    expect(frame.desktopAutomationBinding).toEqual(V10_DESKTOP_AUTOMATION_BINDING);
    registry.resolveDispatch(frame.correlationId, { status: "ok", result: "observed" });
    expect(await pending).toEqual({ status: "ok", result: "observed" });
  });

  test("abort keeps a bound catalogue mutation pending until Desktop returns its generic settlement", async () => {
    const sent: RelayServerMessage[] = [];
    const registry = new InMemoryRelayRegistry({
      authorizeDesktopAutomationDispatch: () => true,
    });
    registry.register(
      "relay-1",
      "human-1",
      semanticCapabilities({ profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT }),
      (message) => { sent.push(message); },
      RELAY_PROTOCOL_VERSION,
      "session-1",
      0,
      "pairing-1",
    );
    const controller = new AbortController();
    let settled = false;
    const pending = registry.dispatch("relay-1", {
      toolName: "future_catalogue_mutation",
      args: { operation: { kind: "focus" } },
      impact: "high",
      approvalObtained: true,
      executionClass: "computer_use",
      desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
      signal: controller.signal,
    });
    await Promise.resolve();
    pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    const dispatch = sent[0] as Extract<RelayServerMessage, { type: "relay:dispatch" }>;

    controller.abort();
    await Promise.resolve();

    expect(sent[1]).toEqual({ type: "relay:cancel", correlationId: dispatch.correlationId });
    expect(settled).toBe(false);
    registry.resolveDispatch(dispatch.correlationId, {
      status: "ok",
      result: { settlement: "unknown_completion" },
    });
    expect(await pending).toEqual({
      status: "ok",
      result: { settlement: "unknown_completion" },
    });
  });

  test("connection loss after Stop settles unknown without inventing a receipt", async () => {
    const sent: RelayServerMessage[] = [];
    const registry = new InMemoryRelayRegistry({
      authorizeDesktopAutomationDispatch: () => true,
    });
    registry.register(
      "relay-1",
      "human-1",
      semanticCapabilities({ profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT }),
      (message) => { sent.push(message); },
      RELAY_PROTOCOL_VERSION,
      "session-1",
      0,
      "pairing-1",
    );
    const controller = new AbortController();
    const pending = registry.dispatch("relay-1", {
      toolName: "future_catalogue_mutation",
      args: { operation: { kind: "focus" } },
      impact: "high",
      approvalObtained: true,
      executionClass: "computer_use",
      desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await registry.unregister("relay-1");
    const error = await pending.catch((caught: unknown) => caught);

    expect(sent.filter((message) => message.type === "relay:cancel")).toHaveLength(1);
    expect(error).toBeInstanceOf(RelayDispatchOutcomeUnknownError);
    expect((error as RelayDispatchOutcomeUnknownError).desktopAutomationOutcome).toBe("unknown");
    expect((error as RelayDispatchOutcomeUnknownError).reason).toBe("disconnect");
  });

  test.each(["revoked", "throw"] as const)("fresh RBAC %s denies before semantic send", async (mode) => {
    const sent: RelayServerMessage[] = [];
    const registry = new InMemoryRelayRegistry({
      authorizeDesktopAutomationDispatch: mode === "revoked"
        ? () => false
        : () => { throw new Error("RBAC unavailable"); },
    });
    registry.register(
      "relay-1",
      "human-1",
      semanticCapabilities({ profile: "desktop-agent", canControlDesktop: true, desktopAutomation: SNAPSHOT }),
      (message) => { sent.push(message); },
      RELAY_PROTOCOL_VERSION,
      "session-1",
      0,
      "pairing-1",
    );
    let error: unknown;

    try {
      await registry.dispatch("relay-1", {
        toolName: "future_catalogue_observe",
        args: { operation: "desktop_state" },
        impact: "high",
        approvalObtained: true,
        executionClass: "computer_use",
        desktopAutomationBinding: DESKTOP_AUTOMATION_BINDING,
      });
    } catch (caught) {
      error = caught;
    }

    expect((error as Error).message).toContain("authorization denied");
    expect(sent).toEqual([]);
  });
});
