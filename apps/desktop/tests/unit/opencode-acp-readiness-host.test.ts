import { describe, expect, test } from "bun:test";
import type { RelayAcpSession } from "@nautilo/relay";
import {
  ElectronAcpReadinessRouter,
  ElectronOpenCodeAcpReadinessHost,
  OPENCODE_ACP_VERSION_ARGS,
  createOpenCodeAcpLaunchEnvironment,
  type OpenCodeAcpNativeProbe,
} from "../../electron/opencode-acp-readiness-host";

const session: RelayAcpSession = {
  relayId: "relay", relaySessionId: "session", desktopSessionId: "desktop",
  pairingGenerationRef: "pair", selectedProtocolVersion: 15, capabilityRevision: 2,
};

describe("OpenCode ACP desktop readiness", () => {
  test("builds a fresh allowlisted launch environment without provider configuration", () => {
    const prior = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = "must-not-cross";
    try {
      const environment = createOpenCodeAcpLaunchEnvironment(["/reviewed", "/usr/bin"]);
      expect(environment["PATH"]).toBe("/reviewed:/usr/bin");
      expect(environment).not.toHaveProperty("OPENAI_API_KEY");
      expect(environment).not.toHaveProperty("OPENCODE_CONFIG");
      expect(environment).not.toHaveProperty("provider");
      expect(environment).not.toHaveProperty("model");
    } finally {
      if (prior === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = prior;
    }
  });

  test("runs only the fixed version probe after exact v15 selection", async () => {
    const calls: unknown[] = [];
    const probe: OpenCodeAcpNativeProbe = { run: async (input) => {
      calls.push(input);
      return { state: "output", stdout: new TextEncoder().encode("1.18.16\n") };
    } };
    const host = new ElectronOpenCodeAcpReadinessHost(probe);
    const sent: unknown[] = [];
    host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onReadiness({
      type: "relay:acp-readiness", requestId: "request", scope: session, registrationId: "opencode-acp",
    });
    expect(calls).toEqual([{
      executableBasename: "opencode", args: OPENCODE_ACP_VERSION_ARGS,
      timeoutMs: 3_000, maxOutputBytes: 4_096, shell: false,
    }]);
    expect(sent).toEqual([{
      type: "relay:acp-readiness-result", requestId: "request", scope: session,
      registrationId: "opencode-acp", state: "ready",
    }]);
  });

  test("does not probe for Hermes or a stale session and fences disconnect", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const host = new ElectronOpenCodeAcpReadinessHost({ run: async () => {
      calls += 1;
      await gate;
      return { state: "missing" };
    } });
    const sent: unknown[] = [];
    host.onRegistered(session, { send: (message) => { sent.push(message); return true; } });
    await host.onReadiness({ type: "relay:acp-readiness", requestId: "hermes", scope: session, registrationId: "hermes-acp" });
    await host.onReadiness({ type: "relay:acp-readiness", requestId: "stale", scope: { ...session, capabilityRevision: 1 }, registrationId: "opencode-acp" });
    expect(calls).toBe(0);
    const pending = host.onReadiness({ type: "relay:acp-readiness", requestId: "exact", scope: session, registrationId: "opencode-acp" });
    host.onDisconnected();
    release?.();
    await pending;
    expect(sent).toEqual([]);
  });

  test("routes readiness by exact built-in registration without cross-probing", async () => {
    const calls: string[] = [];
    const host = (id: string) => ({
      isReady: () => true,
      onRegistered: () => { calls.push(`${id}:registered`); },
      onDisconnected: () => { calls.push(`${id}:disconnected`); },
      onReadiness: () => { calls.push(`${id}:readiness`); },
    });
    const router = new ElectronAcpReadinessRouter({
      "hermes-acp": host("hermes"),
      "opencode-acp": host("opencode"),
    });
    router.onRegistered?.(session, { send: () => true });
    await router.onReadiness?.({ type: "relay:acp-readiness", requestId: "open", scope: session, registrationId: "opencode-acp" });
    router.onDisconnected?.();
    expect(calls).toEqual([
      "hermes:registered", "opencode:registered", "opencode:readiness",
      "hermes:disconnected", "opencode:disconnected",
    ]);
  });
});
