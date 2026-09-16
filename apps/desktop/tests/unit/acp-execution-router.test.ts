import { describe, expect, test } from "bun:test";
import type { RelayAcpHostPort, RelayAcpSession } from "@nautilo/relay";
import { ElectronAcpExecutionRouter } from "../../electron/acp-execution-router";

const session: RelayAcpSession = {
  relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop",
  pairingGenerationRef: "pair", selectedProtocolVersion: 15, capabilityRevision: 2,
};
const binding = {
  bindingId: "binding", bindingGeneration: "generation", ownerId: "owner", taskId: "task",
  taskRunId: "run", jobId: "job", profileId: "profile", profileGeneration: "profile-generation",
  postureId: "posture", postureGeneration: "posture-generation",
} as const;
const workspace = {
  workspaceReceiptId: "receipt", workspaceRevision: "revision", workspaceFingerprint: "fingerprint",
  workspaceExpiresAt: "2030-01-01T00:00:00.000Z",
} as const;
const scope = { socket: session, binding, workspace } as const;
const process = { connectionId: "connection", processGeneration: 1, acpSessionId: "acp", turnGeneration: 1, turnRef: "turn" } as const;

describe("ElectronAcpExecutionRouter", () => {
  test("fans lifecycle once and dispatches every command to the exact registration", async () => {
    const calls: string[] = [];
    const host = (name: string): RelayAcpHostPort => ({
      isReady: () => true,
      onRegistered: () => { calls.push(`${name}:registered`); },
      onDisconnected: () => { calls.push(`${name}:disconnected`); },
      onReadiness: () => { calls.push(`${name}:readiness`); },
      onPrepare: () => { calls.push(`${name}:prepare`); },
      onStart: () => { calls.push(`${name}:start`); },
      onContain: () => { calls.push(`${name}:contain`); },
    });
    const router = new ElectronAcpExecutionRouter({
      "hermes-acp": host("hermes"),
      "opencode-acp": host("opencode"),
    });
    await router.onRegistered(session, { send: () => true });
    await router.onReadiness({ type: "relay:acp-readiness", requestId: "r", registrationId: "opencode-acp", scope: session });
    await router.onPrepare({ type: "relay:acp-prepare", requestId: "p", registrationId: "opencode-acp", scope: session, binding });
    await router.onStart({ type: "relay:acp-start", registrationId: "opencode-acp", scope, prompt: "work", executionProfile: "interactive" });
    await router.onContain({ type: "relay:acp-contain", registrationId: "opencode-acp", containmentRef: "c", scope, process, code: "upstream_failure" });
    await router.onDisconnected();
    expect(calls).toEqual([
      "hermes:registered", "opencode:registered",
      "opencode:readiness", "opencode:prepare", "opencode:start", "opencode:contain",
      "hermes:disconnected", "opencode:disconnected",
    ]);
  });

  test("awaits both exact host containment promises before disconnect settles", async () => {
    let releaseHermes!: () => void;
    let releaseOpenCode!: () => void;
    const calls: string[] = [];
    const host = (name: string, install: (release: () => void) => void): RelayAcpHostPort => ({
      onDisconnected: async () => {
        calls.push(`${name}:started`);
        await new Promise<void>((resolve) => install(resolve));
        calls.push(`${name}:settled`);
      },
    });
    const router = new ElectronAcpExecutionRouter({
      "hermes-acp": host("hermes", (release) => { releaseHermes = release; }),
      "opencode-acp": host("opencode", (release) => { releaseOpenCode = release; }),
    });
    const disconnected = router.onDisconnected();
    await Promise.resolve();
    expect(calls).toEqual(["hermes:started", "opencode:started"]);
    releaseHermes();
    await Promise.resolve();
    expect(calls).toContain("hermes:settled");
    expect(calls).not.toContain("opencode:settled");
    releaseOpenCode();
    await disconnected;
    expect(calls).toContain("opencode:settled");
  });

  test("is ready only when both exact hosts are ready", () => {
    const router = new ElectronAcpExecutionRouter({
      "hermes-acp": { isReady: () => true },
      "opencode-acp": { isReady: () => false },
    });
    expect(router.isReady()).toBeFalse();
  });

  test("removes a disabled Hermes owner from registration and command routing", async () => {
    let hermesEnabled = true;
    const calls: string[] = [];
    const router = new ElectronAcpExecutionRouter({
      "hermes-acp": {
        isReady: () => true,
        onRegistered: () => { calls.push("hermes:registered"); },
        onDisconnected: () => { calls.push("hermes:disconnected"); },
        onStart: () => { calls.push("hermes:start"); },
      },
      "opencode-acp": { isReady: () => true },
    }, { isEnabled: (id) => id !== "hermes-acp" || hermesEnabled });
    await router.onRegistered(session, { send: () => true });
    expect(router.registrations()).toEqual(["hermes-acp", "opencode-acp"]);
    hermesEnabled = false;
    await router.reconcileRegistration("hermes-acp");
    expect(router.registrations()).toEqual(["opencode-acp"]);
    await router.onStart({ type: "relay:acp-start", registrationId: "hermes-acp", scope, prompt: "work" });
    expect(calls).toEqual(["hermes:registered", "hermes:disconnected"]);
  });
});
