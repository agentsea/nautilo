import type { AgentAccessChoice, AgentAccessReason, AgentAccessStatus, ReadyToWorkComponentSelection, ReadyToWorkDesiredState, ReadyToWorkSelection } from "./ready-to-work-contract";

const emptySelection: ReadyToWorkSelection = { voice: false, auto_approve: false, workstation: false, computer_use: false, coding_connection: false };
/** Called inside the existing Ready operation queue, after reading this key. */
export function selectionForAgentAccess(previous: ReadyToWorkDesiredState | null, choice: AgentAccessChoice): ReadyToWorkSelection {
  return { ...(previous?.components ?? emptySelection), workstation: choice === "development" };
}
/** The renderer cannot submit a stale Development bit with unrelated choices. */
export function selectionForReadyComponents(previous: ReadyToWorkDesiredState | null, selection: ReadyToWorkComponentSelection): ReadyToWorkSelection {
  return { ...selection, workstation: previous?.components.workstation ?? false };
}
export interface AgentAccessObservation {
  readonly desired: ReadyToWorkDesiredState | null;
  readonly persistenceUnavailable: boolean;
  readonly authenticated: boolean;
  readonly connected: boolean;
  readonly commandAvailable: boolean;
  readonly ptyAvailable: boolean;
  readonly developmentReady: boolean;
  readonly developmentReason: AgentAccessReason | null;
  readonly fullMac: AgentAccessStatus["fullMac"];
  readonly fullMacOneShot: boolean;
}
/** Projection only: this creates no grants, restores nothing, and stores nothing. */
export function projectAgentAccess(input: AgentAccessObservation): AgentAccessStatus {
  const sandboxedChoice = input.persistenceUnavailable ? null : input.desired?.components.workstation ? "development" : "basic";
  const choiceReason = input.persistenceUnavailable ? "saved_state_unavailable" : input.desired ? "chosen_by_user" : "default";
  let readiness: AgentAccessStatus["readiness"] = "ready";
  let reason: AgentAccessReason | null = null;
  let repairAction: AgentAccessStatus["repairAction"] = null;
  if (input.persistenceUnavailable) { readiness = "needs_attention"; reason = "saved_state_unavailable"; repairAction = "open_settings"; }
  else if (!input.authenticated) { readiness = "needs_attention"; reason = "authentication_unavailable"; repairAction = "open_settings"; }
  else if (!input.connected) { readiness = "reconnecting"; reason = "relay_reconnecting"; repairAction = "retry"; }
  else if (input.fullMac.state === "unconfirmed") { readiness = "needs_attention"; reason = "full_mac_unconfirmed"; repairAction = "retry"; }
  else if (sandboxedChoice === "development" && !input.developmentReady) {
    readiness = "needs_attention"; reason = input.developmentReason ?? "development_not_active";
    repairAction = reason === "workstation_profile_update_needed" ? "review_development" : "restore_development";
  } else if (!input.commandAvailable) { readiness = "needs_attention"; reason = "managed_execution_unavailable"; repairAction = "retry"; }
  return { sandboxedChoice, choiceReason, readiness, reason, repairAction, fullMac: input.fullMac,
    capabilities: { commands: input.authenticated && input.connected && input.commandAvailable,
      interactiveContainedTerminals: input.authenticated && input.connected && input.commandAvailable && input.ptyAvailable && !(input.fullMac.state === "active" && input.fullMacOneShot),
      fullMacOneShot: input.authenticated && input.connected && input.fullMac.state === "active" && input.fullMacOneShot } };
}

/** Disclosure of configured permission ceilings; per-command authority remains dynamic. */
export function developmentProfileScope(profile: import("@nautilo/workstation-profiles").WorkstationProfile, currentProject: string | null): import("./ready-to-work-contract").AgentDevelopmentScope {
  return {
    currentProject,
    roots: [...profile.roots, ...profile.toolchainCapabilities.flatMap(capability => capability.roots)]
      .map(root => ({ path: root.path, access: [...root.access] })),
    network: { mode: profile.network.mode, allow: profile.network.allow.map(rule => ({ kind: rule.kind, value: rule.value })) },
    environmentKeys: [...new Set([...profile.environmentKeys, ...profile.toolchainCapabilities.flatMap(capability => capability.environmentKeys)])],
  };
}
