import type { StructuredSshDispatchRuntime } from "../relay-dispatch/structured-ssh.ts";
import type { SshCapabilityTools } from "./contracts.ts";
import { probeSystemSshAgent } from "./system-agent.ts";

const ALL_SSH_TOOLS: SshCapabilityTools = Object.freeze({
  auth: true,
  exec: true,
  copyUpload: true,
  copyDownload: true,
});

export type StructuredSshManagedState = "unavailable" | "not-enabled" | "enabled";

export interface StructuredSshSetupStatus {
  readonly state: StructuredSshManagedState;
  readonly reason: string | null;
  readonly enabledTools: readonly (keyof SshCapabilityTools)[];
}

export interface StructuredSshSetupControllerDependencies {
  readonly getRuntime: () => StructuredSshDispatchRuntime | null;
  /** Verifies the signed-in Human's own PIN and returns the current bearer. */
  readonly verifyPin: (pin: string) => Promise<string | null>;
  /** Main resolves the signed-in Human's personal Genie; renderer and model supply no Agent identity. */
  readonly resolveOwnedAgent: (accessToken: string, expectedUserId: string) => Promise<string | null>;
  readonly refreshRelay: () => Promise<void>;
  readonly probeOpenSsh?: () => Promise<{ readonly ssh: "observed" | "unavailable" }>;
}

function sessionSelection(runtime: StructuredSshDispatchRuntime) {
  return {
    instanceId: runtime.instanceId,
    userId: runtime.userId,
    relayId: runtime.relayId,
    desktopSessionId: runtime.desktopSessionId,
  };
}

function subject(runtime: StructuredSshDispatchRuntime, agentId: string) {
  return { ...sessionSelection(runtime), agentId };
}

function enabledToolNames(capabilities: readonly { readonly enabled: boolean; readonly tools: SshCapabilityTools }[]): readonly (keyof SshCapabilityTools)[] {
  const names: (keyof SshCapabilityTools)[] = ["auth", "exec", "copyUpload", "copyDownload"];
  return names.filter((name) => capabilities.some((capability) => capability.enabled && capability.tools[name]));
}

function unavailable(reason: string): StructuredSshSetupStatus {
  return { state: "unavailable", reason, enabledTools: [] };
}

async function verifiedBearer(dependencies: StructuredSshSetupControllerDependencies, pin: string): Promise<string> {
  const accessToken = await dependencies.verifyPin(pin);
  if (!accessToken) throw new Error("Your PIN could not be verified. SSH access was not changed.");
  return accessToken;
}

/**
 * Human management for one managed capability, not a target/key grant form.
 * Destination, OpenSSH configuration, identity readiness, and trust are
 * resolved later for each exact Genie request.
 */
export function createStructuredSshSetupController(dependencies: StructuredSshSetupControllerDependencies) {
  const status = async (): Promise<StructuredSshSetupStatus> => {
    const runtime = dependencies.getRuntime();
    if (!runtime) return unavailable("Connect this signed-in Nautilo Desktop to manage SSH on this Mac.");
    const [readiness, listed] = await Promise.all([
      dependencies.probeOpenSsh?.() ?? probeSystemSshAgent().then((probe) => ({ ssh: probe.binaryProbes.ssh })),
      runtime.capabilityStore.listForDesktopSession(sessionSelection(runtime)),
    ]);
    if (!listed.ok) return unavailable("Nautilo could not read SSH capability state on this Mac.");
    if (readiness.ssh !== "observed") return unavailable("Apple OpenSSH is unavailable on this Mac.");
    const active = listed.data.capabilities.filter((capability) => capability.enabled);
    return active.length === 0
      ? { state: "not-enabled", reason: null, enabledTools: [] }
      : { state: "enabled", reason: null, enabledTools: enabledToolNames(active) };
  };

  return {
    status,
    check: status,

    /** The Human toggle supplies only a PIN; Electron resolves every authority field. */
    async enable(pin: string): Promise<StructuredSshSetupStatus> {
      if (!/^\d{6,8}$/.test(pin)) throw new Error("Enter your 6–8 digit PIN to enable SSH access.");
      const runtime = dependencies.getRuntime();
      if (!runtime) throw new Error("Connect this signed-in Nautilo Desktop before enabling SSH.");
      const accessToken = await verifiedBearer(dependencies, pin);
      const agentId = await dependencies.resolveOwnedAgent(accessToken, runtime.userId);
      if (!agentId) throw new Error("Nautilo could not identify your personal Genie. SSH access was not changed.");
      if (dependencies.getRuntime() !== runtime) throw new Error("The Desktop connection changed during SSH setup. Try again.");
      const current = await runtime.capabilityStore.get(subject(runtime, agentId));
      if (!current.ok) throw new Error("Nautilo could not read SSH capability state on this Mac.");
      const enabled = await runtime.capabilityStore.enable({
        subject: subject(runtime, agentId),
        expectedRevision: current.data.revision,
        tools: ALL_SSH_TOOLS,
      });
      if (!enabled.ok) throw new Error("SSH capability state changed during setup. Check again and retry.");
      if (dependencies.getRuntime() !== runtime) {
        await runtime.capabilityStore.revoke({ subject: subject(runtime, agentId), expectedRevision: enabled.data.revision });
        throw new Error("The Desktop connection changed during SSH setup. SSH was not enabled.");
      }
      await dependencies.refreshRelay();
      return await status();
    },

    /** Turn off every enabled SSH capability on this exact Human/Desktop session. */
    async disable(): Promise<StructuredSshSetupStatus> {
      const runtime = dependencies.getRuntime();
      if (!runtime) throw new Error("Connect this signed-in Nautilo Desktop before changing SSH.");
      const listed = await runtime.capabilityStore.listForDesktopSession(sessionSelection(runtime));
      if (!listed.ok) throw new Error("Nautilo could not read SSH capability state on this Mac.");
      const active = listed.data.capabilities.filter((capability) => capability.enabled);
      if (active.length === 0) return await status();
      if (dependencies.getRuntime() !== runtime) throw new Error("The Desktop connection changed. Nothing was disabled.");
      let revision = listed.data.revision;
      for (const capability of active) {
        const disabled = await runtime.capabilityStore.disable({ subject: capability.subject, expectedRevision: revision });
        if (!disabled.ok) throw new Error("SSH capability state changed while it was being disabled. Check again.");
        revision = disabled.data.revision;
      }
      await dependencies.refreshRelay();
      return await status();
    },
  };
}
