import { describe, expect, test } from "bun:test";
import type {
  RelayClaudeConnectionDiscoverCommand,
  RelayClaudeConnectionDiscoveryResult,
  RelayClaudeConnectionHostTransport,
  RelayClaudeConnectionSession,
  RelayClaudeFact,
} from "@nautilo/relay";
import { ElectronClaudeConnectionHost } from "../../electron/claude-connection";

const session: RelayClaudeConnectionSession = {
  relayId: "relay-1", relaySessionId: "session-1", desktopSessionId: "desktop-1",
  pairingGenerationRef: "pair-1", selectedProtocolVersion: 17, capabilityRevision: 0,
};

function command(correlationId = "6d141ab4-8ccc-4b69-9e81-75068454f013"): RelayClaudeConnectionDiscoverCommand {
  return {
    type: "relay:claude-connection-discover", version: 17, correlationId, scope: session,
    profileRef: "719f18c6-a3a9-4b8e-994a-9fa36136552e",
  };
}

function readyResolver() {
  return { resolve: async () => ({
    path: "/ambient/claude", version: "2.1.235",
    features: { accountInfo: true, supportedModels: true, interrupt: true, modelRefusalFallback: true, modelRefusalNoFallback: true, servingModelIdentity: true, switchModelsOnFlag: true },
  }) };
}

describe("D452 Electron Claude Connections composition", () => {
  test("maps one parked discovery's independent facts into exactly one closed result", async () => {
    const results: RelayClaudeConnectionDiscoveryResult[] = [];
    let emit: ((fact: RelayClaudeFact) => void) | null = null;
    const host = new ElectronClaudeConnectionHost({
      workingDirectory: () => "/genie-workspace",
      executableResolver: readyResolver(),
      createHost: (onFact) => ({ discover: async () => {
        emit = onFact;
        onFact({ kind: "runtime", state: "ready", version: "2.1.235", executionQualified: true });
        onFact({ kind: "account", account: { state: "connected", email: "writer@example.test" } });
        onFact({ kind: "model_catalog", complete: false, models: [{ id: "claude-fable-5", displayName: "Fable 5", description: "Frontier", supportsEffort: true, supportedEffortLevels: ["high"] }] });
        return false;
      } }),
    });
    const transport: RelayClaudeConnectionHostTransport = { send: (result) => { results.push(result); return true; } };
    host.onRegistered(session, transport);
    host.onDiscover(command());
    await waitFor(() => results.length === 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.runtime).toEqual({ state: "ready", version: "2.1.235", executionQualified: true });
    expect(results[0]?.account).toEqual({ state: "connected", email: "writer@example.test" });
    expect(results[0]?.catalog).toMatchObject({ state: "incomplete", complete: false });
    expect(emit).not.toBeNull();
  });

  test("preserves disconnected account while retaining observed catalog and reports missing facts honestly", async () => {
    const results: RelayClaudeConnectionDiscoveryResult[] = [];
    const host = new ElectronClaudeConnectionHost({
      workingDirectory: () => "/genie-workspace", executableResolver: readyResolver(),
      createHost: (onFact) => ({ discover: async () => {
        onFact({ kind: "runtime", state: "unavailable" });
        onFact({ kind: "account_state", state: "disconnected" });
        onFact({ kind: "model_catalog", complete: true, models: [] });
        return false;
      } }),
    });
    host.onRegistered(session, { send: (result) => { results.push(result); return true; } });
    host.onDiscover(command());
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({
      runtime: { state: "unavailable" }, account: { state: "disconnected" },
      catalog: { state: "complete", complete: true, models: [] },
    });
  });

  test("aborts an old command synchronously and never lets a stale completion send", async () => {
    const results: RelayClaudeConnectionDiscoveryResult[] = [];
    const pending: Array<{ request: { signal?: AbortSignal }; emit: (fact: RelayClaudeFact) => void; resolve: () => void }> = [];
    const host = new ElectronClaudeConnectionHost({
      workingDirectory: () => "/genie-workspace", executableResolver: readyResolver(),
      createHost: (onFact) => ({ discover: (request) => new Promise<boolean>((resolve) => {
        pending.push({ request, emit: onFact, resolve: () => resolve(false) });
      }) }),
    });
    host.onRegistered(session, { send: (result) => { results.push(result); return true; } });
    host.onDiscover(command());
    await waitFor(() => pending.length === 1);
    host.onDiscover(command("c4d141ab-8ccc-4b69-9e81-75068454f013"));
    expect(pending[0]?.request.signal?.aborted).toBe(true);
    pending[0]?.emit({ kind: "runtime", state: "ready", version: "2.1.235", executionQualified: true });
    pending[0]?.resolve();
    await waitFor(() => pending.length === 2);
    pending[1]?.emit({ kind: "host_failure", code: "CLAUDE_SDK_FAILURE" });
    pending[1]?.resolve();
    await waitFor(() => results.length === 1);
    expect(results[0]?.correlationId).toBe("c4d141ab-8ccc-4b69-9e81-75068454f013");
    expect(results[0]).toMatchObject({ runtime: { state: "failure" }, account: { state: "unavailable" }, catalog: { state: "unavailable", complete: false, models: [] } });
    host.onDisconnected();
    expect(results).toHaveLength(1);
  });

  test("contains a throwing transport, clears that exact attempt, and lets the next command run", async () => {
    const requests: AbortSignal[] = [];
    const results: RelayClaudeConnectionDiscoveryResult[] = [];
    const host = new ElectronClaudeConnectionHost({
      workingDirectory: () => "/genie-workspace", executableResolver: readyResolver(),
      createHost: (onFact) => ({ discover: async (request) => {
        if (request.signal !== undefined) requests.push(request.signal);
        onFact({ kind: "host_failure", code: "CLAUDE_SDK_FAILURE" });
        return false;
      } }),
    });
    host.onRegistered(session, { send: () => { throw new Error("stale socket"); } });
    host.onDiscover(command());
    await waitFor(() => requests.length === 1);
    host.onRegistered(session, { send: (result) => { results.push(result); return true; } });
    // The completed send failure was contained and cleared; a replacement
    // registration must not have to abort a stale previous discovery.
    expect(requests[0]?.aborted).toBe(false);
    host.onDiscover(command("b4d141ab-8ccc-4b69-9e81-75068454f013"));
    await waitFor(() => results.length === 1);
    expect(results[0]?.correlationId).toBe("b4d141ab-8ccc-4b69-9e81-75068454f013");
  });

  test("fails closed when the Genie Workspace is unavailable and never opens the SDK host", async () => {
    let discoveries = 0;
    const results: RelayClaudeConnectionDiscoveryResult[] = [];
    const host = new ElectronClaudeConnectionHost({
      workingDirectory: () => { throw new Error("workspace unavailable"); }, executableResolver: readyResolver(),
      createHost: () => ({ discover: async () => { discoveries++; return true; } }),
    });
    host.onRegistered(session, { send: (result) => { results.push(result); return true; } });
    host.onDiscover(command());
    await waitFor(() => results.length === 1);
    expect(discoveries).toBe(0);
    expect(results[0]).toMatchObject({ runtime: { state: "failure" }, account: { state: "unavailable" }, catalog: { state: "unavailable", complete: false, models: [] } });
  });

  test("a later Check again can recover after a runtime install without a relay restart", async () => {
    const results: RelayClaudeConnectionDiscoveryResult[] = [];
    let installed = false;
    const host = new ElectronClaudeConnectionHost({
      workingDirectory: () => "/genie-workspace", executableResolver: readyResolver(),
      createHost: (onFact) => ({ discover: async () => {
        if (!installed) {
          onFact({ kind: "runtime", state: "unavailable" });
          return false;
        }
        onFact({ kind: "runtime", state: "ready", version: "2.1.235", executionQualified: true });
        onFact({ kind: "account", account: { state: "connected", email: "writer@example.test" } });
        onFact({ kind: "model_catalog", complete: true, models: [] });
        return true;
      } }),
    });
    host.onRegistered(session, { send: (result) => { results.push(result); return true; } });
    host.onDiscover(command());
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({ runtime: { state: "unavailable" } });
    installed = true;
    host.onDiscover(command("a4d141ab-8ccc-4b69-9e81-75068454f013"));
    await waitFor(() => results.length === 2);
    expect(results[1]).toMatchObject({ runtime: { state: "ready", version: "2.1.235", executionQualified: true }, account: { state: "connected", email: "writer@example.test" }, catalog: { state: "complete", complete: true } });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for local discovery");
}
