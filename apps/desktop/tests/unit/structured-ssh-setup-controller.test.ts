import { describe, expect, test } from "bun:test";
import type { StructuredSshDispatchRuntime } from "../../electron/relay-dispatch/structured-ssh.ts";
import { SshCapabilityStore } from "../../electron/structured-ssh/capability-store.ts";
import { SshHostTrustStore } from "../../electron/structured-ssh/host-trust-store.ts";
import { SshPreparationStore } from "../../electron/structured-ssh/preparation-store.ts";
import { createStructuredSshSetupController } from "../../electron/structured-ssh/setup-controller.ts";

const binding = "ssh-server-binding-aaaaaaaaaaaaaaaa";

function memoryStorage() {
  let value: string | null = null;
  return { read: async () => value, writeAtomic: async (next: string) => { value = next; } };
}

function runtime(readiness: "available" | "unavailable" = "available"): StructuredSshDispatchRuntime {
  return {
    instanceId: "",
    serverBindingId: binding,
    userId: "user-1",
    relayId: "relay-1",
    desktopSessionId: "desktop-1",
    appDataDirectory: "/unused",
    workspaceRoot: "/Nautilo Workspace",
    getCapabilityRevision: () => 0,
    capabilityStore: new SshCapabilityStore({
      instanceId: "",
      serverBindingId: binding,
      filePath: "/unused/capabilities.json",
      storage: memoryStorage(),
      clock: () => new Date("2026-08-08T12:00:00.000Z"),
    }),
    preparationStore: new SshPreparationStore(),
    hostTrustStore: new SshHostTrustStore({ instanceId: "", filePath: "/unused/trust.json", storage: memoryStorage() }),
    probeReadiness: async () => readiness === "available"
      ? { version: 1, state: "not-enabled", provider: "openssh", ssh: "observed", scp: "observed" }
      : { version: 1, state: "unavailable", provider: "openssh", ssh: "unavailable", scp: "unavailable" },
  };
}

function controller(current: () => StructuredSshDispatchRuntime | null, overrides: {
  verifyPin?: (pin: string) => Promise<string | null>;
  resolveOwnedAgent?: (token: string, userId: string) => Promise<string | null>;
  refreshRelay?: () => Promise<void>;
} = {}) {
  return createStructuredSshSetupController({
    getRuntime: current,
    verifyPin: overrides.verifyPin ?? (async () => "fresh-bearer"),
    resolveOwnedAgent: overrides.resolveOwnedAgent ?? (async () => "agent-1"),
    refreshRelay: overrides.refreshRelay ?? (async () => undefined),
    probeOpenSsh: async () => ({ ssh: current()?.probeReadiness === undefined || (await current()!.probeReadiness!()).ssh === "observed" ? "observed" : "unavailable" }),
  });
}

describe("SSH on this Mac capability controller", () => {
  test("reports OpenSSH readiness without requiring a loaded system-agent identity", async () => {
    const current = runtime();
    expect(await controller(() => current).status()).toEqual({
      state: "not-enabled",
      reason: null,
      enabledTools: [],
    });
    const missing = runtime("unavailable");
    expect(await controller(() => missing).status()).toMatchObject({
      state: "unavailable",
      enabledTools: [],
    });
  });

  test("enables all structured SSH tools for one verified owned Genie without target or key setup", async () => {
    const current = runtime();
    let verified = 0;
    let refreshed = 0;
    const managed = controller(() => current, {
      verifyPin: async (pin) => { verified += 1; return pin === "847291" ? "fresh-bearer" : null; },
      resolveOwnedAgent: async (token, userId) => token === "fresh-bearer" && userId === "user-1" ? "agent-1" : null,
      refreshRelay: async () => { refreshed += 1; },
    });
    expect(await managed.enable("847291")).toEqual({
      state: "enabled",
      reason: null,
      enabledTools: ["auth", "exec", "copyUpload", "copyDownload"],
    });
    expect(verified).toBe(1);
    expect(refreshed).toBe(1);
    const persisted = await current.capabilityStore.get({ instanceId: "", userId: "user-1", agentId: "agent-1", relayId: "relay-1", desktopSessionId: "desktop-1" });
    expect(JSON.stringify(persisted)).not.toMatch(/host|fingerprint|identity|folder|private/i);
  });

  test("rejects missing personal Genie authority and runtime drift before persistence", async () => {
    const current = runtime();
    let missingAgentError: unknown;
    try {
      await controller(() => current, {
        resolveOwnedAgent: async () => null,
      }).enable("847291");
    } catch (error) {
      missingAgentError = error;
    }
    expect(missingAgentError).toBeInstanceOf(Error);
    expect((missingAgentError as Error).message).toContain("personal Genie");

    let active: StructuredSshDispatchRuntime | null = current;
    const drifting = controller(() => active, { resolveOwnedAgent: async () => { active = null; return "agent-1"; } });
    let driftError: unknown;
    try {
      await drifting.enable("847291");
    } catch (error) {
      driftError = error;
    }
    expect(driftError).toBeInstanceOf(Error);
    expect((driftError as Error).message).toContain("Desktop connection changed");
    expect(await current.capabilityStore.get({ instanceId: "", userId: "user-1", agentId: "agent-1", relayId: "relay-1", desktopSessionId: "desktop-1" }))
      .toMatchObject({ ok: true, data: { capability: null, revision: 0 } });
  });

  test("turns off every capability in the exact active session immediately", async () => {
    const current = runtime();
    const agentIds = ["agent-1", "agent-2"];
    const managed = controller(() => current, { resolveOwnedAgent: async () => agentIds.shift() ?? null });
    await managed.enable("847291");
    await managed.enable("847291");
    let verifications = 0;
    const disabling = controller(() => current, { verifyPin: async () => { verifications += 1; return "fresh-bearer"; } });
    expect(await disabling.disable()).toEqual({
      state: "not-enabled",
      reason: null,
      enabledTools: [],
    });
    expect(verifications).toBe(0);
  });
});
