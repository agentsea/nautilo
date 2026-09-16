import type { ToolRelayRegistry } from "../nodes/tools";
import {
  COMPUTER_USE_SEMANTIC_VERSION,
  MAX_DESKTOP_AUTOMATION_GRANT_GENERATION,
  parseDesktopAutomationOpaqueId,
} from "@nautilo/types";

function semanticComputerActions(
  capabilities: ReturnType<ToolRelayRegistry["getCapabilities"]> | undefined,
  currentAgentId: string | undefined,
): boolean {
  const snapshot = capabilities?.desktopAutomation;
  if (
    currentAgentId === undefined
    || capabilities?.computerUseSemanticVersion !== COMPUTER_USE_SEMANTIC_VERSION
    || capabilities?.canControlDesktop !== true
    || snapshot?.enabled !== true
    || snapshot.agentId !== currentAgentId
    || parseDesktopAutomationOpaqueId(snapshot.agentId) === null
    || parseDesktopAutomationOpaqueId(snapshot.installationEpoch) === null
    || !Number.isSafeInteger(snapshot.grantGeneration)
    || snapshot.grantGeneration < 1
    || snapshot.grantGeneration > MAX_DESKTOP_AUTOMATION_GRANT_GENERATION
    || snapshot.provider !== "cua"
    || parseDesktopAutomationOpaqueId(snapshot.providerGeneration) === null
  ) {
    return false;
  }
  return true;
}

/**
 * Build the flat capability-token Record consumed by
 * `ToolCatalog.getFiltered`'s third argument. See Layer 1 design
 * contract in the file comment of this module.
 *
 * Returns undefined when no relay is connected for the user — the
 * catalog then correctly excludes relay-executor tools.
 *
 * The catalog parameter is named `relayCapabilities` for legacy reasons.
 * The dict contains only live relay availability tokens; actor capability
 * gating happens separately via `envelope.toolPolicy`.
 */
export function buildRuntimeCapabilityTokens(
  registry: ToolRelayRegistry | null,
  userId: string,
  /**
   * D516 — foreground callers supply the exact Agent receiving a catalog.
   * Omitting it deliberately keeps the semantic Computer use catalog absent:
   * a generic owner-wide relay union must never borrow another Agent's local
   * desktop-automation receipt.
   */
  currentAgentId?: string,
): Readonly<Record<string, boolean>> | undefined {
  if (!registry) return undefined;
  // Single capability used to detect any relay's presence; matches the
  // desktop-agent profile that today's relay clients advertise.
  const relayIds = registry
    .findByCapabilityForUser("canRunShell", userId)
    .concat(registry.findByCapabilityForUser("canReadWorkspace", userId))
    .concat(registry.findByCapabilityForUser("canWriteWorkspace", userId))
    .concat(registry.findByCapabilityForUser("canControlDesktop", userId))
    .concat(registry.findByCapabilityForUser("canSeeDesktop", userId))
    .concat(registry.findByCapabilityForUser("canControlBrowser", userId))
    .concat(registry.findByCapabilityForUser("canUseTerminal", userId))
    .concat(registry.findByCapabilityForUser("canUseGoogleWorkspace", userId))
    .concat(registry.findByCapabilityForUser("canControlHue", userId))
    .concat(registry.findByCapabilityForUser("canReadStructuredSshOutput", userId))
    .concat(registry.findByCapabilityForUser("canUseStructuredSsh", userId))
    .concat(registry.findByCapabilityForUser("canConfigureStructuredSsh", userId));
  const uniqueIds = Array.from(new Set(relayIds));
  if (uniqueIds.length === 0) return undefined;

  // Desktop automation is not an owner-wide relay capability. It is a
  // redacted receipt naming one Agent on one Desktop. Derive the semantic
  // catalog token only for that exact Agent. Electron still reloads and fences
  // the durable local receipt before any execution.
  const semanticRouteCandidates = currentAgentId === undefined
    ? []
    : uniqueIds
      .map((id) => registry.getCapabilities(id))
      .filter((capabilities) => capabilities?.desktopAutomation?.agentId === currentAgentId);
  // A single exact same-Agent route is the only source of Computer Use tokens.
  // This layer never merges route capabilities or infers a provider action.
  const semanticRouteReady = semanticRouteCandidates.length === 1
    ? semanticComputerActions(semanticRouteCandidates[0], currentAgentId)
    : null;
  const tokens: Record<string, boolean> = {};
  if (semanticRouteReady) {
    tokens["canUseComputer"] = true;
    tokens["canComputerDo"] = true;
    tokens["canComputerVerify"] = true;
    tokens["canComputerTargetedObserve"] = true;
    tokens["canComputerWindowCreation"] = true;
    tokens["canComputerElementTargeting"] = true;
  }
  for (const id of uniqueIds) {
    const caps = registry.getCapabilities(id);
    if (!caps) continue;
    if (caps.canRunShell) tokens["canRunShell"] = true;
    if (caps.canReadWorkspace) tokens["canReadWorkspace"] = true;
    if (caps.canWriteWorkspace) tokens["canWriteWorkspace"] = true;
    if (caps.canSeeDesktop) tokens["canSeeDesktop"] = true;
    if (caps.canControlBrowser) {
      // Two tokens, mirroring the canControlDesktop / control_desktop pair:
      //   - canControlBrowser: mirrors the relay's advertised wire-capability.
      //   - control_browser:   the gate token ToolCatalog.getFiltered checks
      //     against browser_* `requiredCapabilities` (register-all.ts).
      tokens["canControlBrowser"] = true;
      tokens["control_browser"] = true;
    }
    if (caps.canUseTerminal) {
      // Terminal registration names canUseTerminal explicitly, so runtime
      // availability never impersonates the Human's use_workstation grant.
      tokens["canUseTerminal"] = true;
      // Presence only: the exact PTY remains Electron-local while a
      // session-less terminal operation binds to it. This token automatically
      // makes that tool callable and injects the pending-handoff instruction.
      if (caps.hasPendingTerminalHandoff === true) {
        tokens["hasPendingTerminalHandoff"] = true;
      }
    }
    if (caps.canReadStructuredSshOutput) {
      tokens["canReadStructuredSshOutput"] = true;
    }
    if (caps.canUseGoogleWorkspace) {
      tokens["canUseGoogleWorkspace"] = true;
      tokens["use_google_workspace"] = true;
    }
    if (caps.canControlHue) {
      // The advertised capability proves a connected relay can execute the
      // bounded Hue protocol. `control_home` is the catalog gate for the
      // server-owned hue_lights contract; actor RBAC is separate.
      tokens["canControlHue"] = true;
      tokens["control_home"] = true;
    }
    // D500 — readiness is a secret-free aggregate of Electron-local managed
    // capabilities. The catalog has one shared token for auth + exec and one
    // shared token for upload + download, so partial operation permissions
    // cannot be represented safely here. Emit each shared token only when all
    // operations it would expose are enabled; local prepare remains final
    // authority for the exact operation and destination.
    if (
      caps.structuredSsh?.state === "enabled" &&
      caps.structuredSsh.ssh === "observed" &&
      caps.structuredSsh.auth &&
      caps.structuredSsh.exec
    ) {
      tokens["canUseStructuredSsh"] = true;
      if (
        caps.structuredSsh.scp === "observed" &&
        caps.structuredSsh.upload &&
        caps.structuredSsh.download
      ) {
        tokens["canUseStructuredSshCopy"] = true;
      }
    }
    if (
      caps.structuredSsh !== undefined &&
      caps.structuredSsh.state !== "unavailable" &&
      caps.structuredSsh.ssh === "observed"
    ) {
      tokens["canConfigureStructuredSsh"] = true;
      if (caps.structuredSsh.scp === "observed") {
        tokens["canConfigureStructuredSshCopy"] = true;
      }
    }
  }
  return Object.freeze(tokens);
}
