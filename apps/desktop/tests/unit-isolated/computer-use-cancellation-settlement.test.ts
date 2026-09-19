import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION, RELAY_PROTOCOL_VERSION, type RelayServerMessage } from "@nautilo/relay";
import { COMPUTER_USE_SEMANTIC_VERSION } from "@nautilo/types";
import type { ComputerUseHostContract } from "@nautilo/computer-use-host-protocol";
import { ComputerUseHost } from "../../../../packages/computer-use-host/src/runtime.ts";
import { InMemoryRelayRegistry } from "../../../../packages/runtime/src/relay-registry.ts";
import { ComputerUseHostBroker } from "../../electron/computer-use-host-runtime/broker.ts";
import type { ComputerUseHostRuntimeLaunch } from "../../electron/computer-use-host-runtime/runtime.ts";

test("registry, Desktop broker and Host preserve the final partial receipt after Stop", async () => {
  const contract: ComputerUseHostContract = {
    contractNamespace: "nautilo.computer_use", contractId: "test.native_mutation", contractVersion: 1,
    schemaDigest: `sha256:${"a".repeat(64)}`, effectClass: "mutate", replayClass: "at_most_once",
    authorityClass: "standing_computer_use", attachmentClass: "none", disclosureClass: "semantic",
  };
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const releaseReceipt = Promise.withResolvers<void>();
  const finalReceipt = { completionCertainty: "partially_completed", textDelivery: { requestedCharacters: 289, deliveredCharacters: 73 } };
  let executions = 0;
  const host = new ComputerUseHost({ hostGeneration: "host-1", driverGeneration: "driver-1", handlers: [{
    contract,
    execute: async (_args, { signal }) => {
      executions += 1;
      signal.addEventListener("abort", () => stopped.resolve(), { once: true });
      started.resolve();
      // The transport must retain ownership while the executor finishes its
      // cleanup/readback. No native app or real input is involved in this test.
      await releaseReceipt.promise;
      expect(signal.aborted).toBe(true);
      return { settlement: "cancelled", result: finalReceipt };
    },
  }] });
  const broker = new ComputerUseHostBroker(
    { bootstrap: async () => ({ state: "ready" }), acquireLaunch: () => ({
      entrypoint: "/private/test/host", generation: 1,
      release: {} as ComputerUseHostRuntimeLaunch["release"], lease: { generation: 1, release() {} },
    }) },
    { launch: async () => ({ ready: { kind: "ready", protocol: { major: 3, minor: 0 },
      hostGeneration: "host-1", driverGeneration: "driver-1", contracts: [contract] },
      request: async message => ({ result: await host.dispatch(message) }),
      cancel: async message => { host.cancel(message); }, close: async () => { host.cancelAll(); },
    }) },
    () => ({ driverPath: "/private/test/cua-driver", runtimeRoot: "/private/test/runtime", hostBundleId: "com.nautilo.desktop" }),
  );
  const snapshot = { enabled: true as const, agentId: "agent-1", installationEpoch: "epoch-1",
    grantGeneration: 1, provider: "cua" as const, providerGeneration: "driver-1" };
  const binding = { version: RELAY_DESKTOP_AUTOMATION_INVOCATION_BINDING_VERSION,
    computerUseContextId: "context-1", computerUseInvocationId: "invocation-1",
    originHumanId: "human-1", originRunId: "run-1", originAgentId: "agent-1", lineageId: "lineage-1",
    installationEpoch: "epoch-1", grantGeneration: 1, provider: "cua" as const, providerGeneration: "driver-1",
    relayId: "relay-1", pairingGeneration: `pairing-${createHash("sha256").update("nautilo-relay-v8:pairing-1").digest("base64url")}`,
    desktopSessionId: "session-1",
  };
  const registry = new InMemoryRelayRegistry({ authorizeDesktopAutomationDispatch: () => true });
  const transportAbort = new AbortController();
  const sent: RelayServerMessage[] = [];
  await registry.register("relay-1", "human-1", { profile: "desktop-agent", canControlDesktop: true,
    computerUseSemanticVersion: COMPUTER_USE_SEMANTIC_VERSION, desktopAutomation: snapshot }, message => {
    sent.push(message);
    if (message.type === "relay:cancel") transportAbort.abort();
    if (message.type === "relay:dispatch") void broker.dispatch({
      authority: { authorityLeaseId: binding.computerUseContextId, authorityGeneration: 1 },
      cancellationGeneration: 1, contract, arguments: {}, requestId: binding.computerUseInvocationId,
      signal: transportAbort.signal,
    }).then(result => registry.resolveDispatch(message.correlationId, result.ok
      ? { status: "ok", result: result.result } : { status: "error", error: result.code }));
  }, RELAY_PROTOCOL_VERSION, "session-1", 0, "pairing-1");
  const humanStop = new AbortController();
  const pending = registry.dispatch("relay-1", { toolName: "fixture_native_mutation", args: {},
    impact: "high", approvalObtained: true, executionClass: "computer_use", desktopAutomationBinding: binding,
    computerUseRequest: { contract, arguments: {} }, signal: humanStop.signal });
  const timers = spyOn(globalThis, "setTimeout");
  try {
    await started.promise;
    humanStop.abort();
    await stopped.promise;
    // Drain any old post-Stop deadline before allowing final executor readback.
    for (const [callback] of [...timers.mock.calls]) if (typeof callback === "function") callback();
    expect(timers.mock.calls).toHaveLength(0);
    releaseReceipt.resolve();
    expect(await pending).toMatchObject({ status: "ok", result: {
      requestId: binding.computerUseInvocationId, settlement: "cancelled", result: finalReceipt,
    } });
    expect(executions).toBe(1);
    expect(sent.filter(message => message.type === "relay:dispatch")).toHaveLength(1);
    expect(sent.filter(message => message.type === "relay:cancel")).toHaveLength(1);
  } finally {
    timers.mockRestore();
    releaseReceipt.resolve();
    await registry.unregister("relay-1");
    await pending.catch(() => undefined);
    await broker.close();
  }
});
