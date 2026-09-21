import type { RelaySecurityScanProgressMessage } from "@nautilo/relay";
import { securityScanRelayRequestSchema } from "@nautilo/types";
import { createHash, randomUUID } from "node:crypto";
import type {
  RelayCapabilities,
  RelayClaudeConnectionDiscoverCommand,
  RelayClaudeConnectionDiscoveryResult,
  RelayClaudeConnectionScope,
  RelayClaudeExecutionCommand,
  RelayClaudeExecutionDesktopEvent,
  RelayClaudeExecutionEvent,
  RelayClaudeExecutionResponse,
  RelayClaudeExecutionSocketScope,
  RelayDesktopFilesystemGrantSnapshot,
  RelaySshDispatchBindingV1,
  RelaySshOperation,
  RelaySshApprovedRequestV1,
  RelaySshPreparedMessage,
  RelaySshPrepareFailureCode,
  RelaySshResolutionFailure,
  RelaySshPrepareRequestV1,
  RelaySshPrepareResponseV1,
  RelayWorkstationProfileSnapshot,
} from "@nautilo/relay";
import type {
  RelayServerMessage,
  RelayDispatchResult,
  RelayRunShellProgressMessage,
  RelayStructuredSshProgressMessage,
  RelaySandboxProfile,
  RelayFsRequest,
  RelayFsResult,
  RelayLocalApplyPatchRequest,
  RelayLocalApplyPatchResult,
  RelayBrowserResearchReadRequest,
  RelayBrowserResearchSnapshotInspectionRequest,
  RelayBrowserResearchSearchRequest,
  RelayLocalFileRequest,
  RelayLocalFileResult,
  RelayMcpConfigureOperation,
  RelayMcpConfigureResultMessage,
  RelayMcpPreflightResultMessage,
  RelayMcpServerConfig,
} from "@nautilo/relay";
import {
  HEARTBEAT_TIMEOUT_MS,
  DISPATCH_DEFAULT_TIMEOUT_MS,
  OPENHUE_SETUP_TIMEOUT_MS,
  DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION,
  browserToolMayMutate,
  canRelayExecuteApplyPatch,
  canRelayExecuteBrowserResearchRead,
  canRelayExecuteBrowserResearchConsentRecovery,
  canRelayExecuteBrowserResearchSnapshotInspection,
  canRelayExecuteBrowserResearchSearch,
  parseRelayLocalApplyPatchRequest,
  parseRelayLocalApplyPatchResult,
  parseRelayBrowserResearchReadRequest,
  parseRelayBrowserResearchReadResult,
  parseRelayBrowserResearchConsentRecoveryRequest,
  parseRelayBrowserResearchConsentRecoveryResult,
  parseRelayBrowserResearchSnapshotInspectionRequest,
  parseRelayBrowserResearchSnapshotInspectionResult,
  parseRelayBrowserResearchSearchRequest,
  parseRelayBrowserResearchSearchResult,
  parseRelayDesktopFilesystemGrantSnapshot,
  CODEX_RELAY_MAX_REPLAY_ENTRIES,
  CODEX_RELAY_REPLAY_CACHE_TTL_MS,
  CODEX_RELAY_PROTOCOL_VERSION,
  CLAUDE_CONNECTION_PROTOCOL_VERSION,
  CLAUDE_EXECUTION_MAX_QUEUED_EVENTS,
  CLAUDE_EXECUTION_PROTOCOL_VERSION,
  parseRelayClaudeConnectionDiscoverCommand,
  parseRelayClaudeConnectionDiscoveryResult,
  parseRelayClaudeExecutionCapability,
  parseRelayClaudeExecutionCommand,
  parseRelayClaudeExecutionDesktopEvent,
  RELAY_MCP_TRUTH_PROTOCOL_VERSION,
  RELAY_MCP_DISPATCH_PROVENANCE_PROTOCOL_VERSION,
  RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
  RELAY_SSH_PREPARE_PROTOCOL_VERSION,
  RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION,
  RELAY_SSH_PREPARE_VERSION,
  parseRelaySshPrepareRequest,
  parseRelaySshPrepareResponse,
  parseRelayWorkstationProfileSnapshot,
  parseRelayStructuredSshReadiness,
  parseRelayClaudeCapability,
  parseRelayCodexCapability,
  isRelayCodexCommandResponseForCommand,
  ACP_RELAY_PROTOCOL_VERSION,
  ACP_RELAY_READINESS_PROTOCOL_VERSION,
  OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
  parseRelayAcpCapability,
  isRelayAcpReadinessResultForCommand,
  isRelayAcpBindingScope,
} from "@nautilo/relay";
import type {
  CodexHostStatus,
  RelayCodexClientMessage,
  RelayCodexCommandMessage,
  RelayCodexCommandResponseMessage,
  RelayCodexServerMessage,
  V8SocketScope,
  AcpReadinessState,
  AcpRegistrationId,
  AcpExecutionProfile,
  RelayAcpReadinessCommand,
  RelayAcpClientMessage,
  AcpSocketScope,
  AcpBindingScope,
  AcpExecutionScope,
  AcpProcessScope,
  AcpWorkspaceReceipt,
  RelayAcpPrepareCommand,
  RelayAcpPreparedResult,
  RelayAcpStartCommand,
  RelayAcpContainCommand,
  RelayAcpStartedResult,
  RelayAcpStartFailedResult,
  RelayAcpSemanticEvent,
  RelayAcpTerminalEvent,
  AcpStartFailureStage,
} from "@nautilo/relay";
import {
  COMPUTER_USE_SEMANTIC_VERSION,
  MAX_DESKTOP_AUTOMATION_GRANT_GENERATION,
  parseDesktopAutomationOpaqueId,
} from "@nautilo/types";

export type RelaySendFn = (message: RelayServerMessage) => void;
type RelayDesktopAutomationSnapshot = NonNullable<RelayCapabilities["desktopAutomation"]>;
type RelayDesktopFilesystemGrantRequest = NonNullable<
  Extract<RelayServerMessage, { type: "relay:dispatch" }>["desktopFilesystemGrantRequest"]
>;
type RelayWorkstationShellBinding = NonNullable<
  Extract<RelayServerMessage, { type: "relay:dispatch" }>["workstationShellBinding"]
>;

interface RelayEntry {
  relayId: string;
  /** Monotonic in-memory registration generation; binds pending MCP truth work to one socket. */
  connectionGeneration: number;
  userId: string;
  capabilities: RelayCapabilities;
  /**
   * Protocol version the relay registered with. Used to gate the
   * `fs` execution class — only relays at v2+ can serve `file` fs
   * primitives; a relay below threshold is treated as
   * "no fs-capable relay". Defaults
   * to 1 when a caller omits it (back-compat with older register paths).
   */
  protocolVersion: number;
  /**
   * protocol v7 — per Electron main-process-launch identity. Present
   * only for desktop relays; the headless relay never sends one. Required
   * to accept `relay:update-capabilities` for this entry.
   */
  desktopSessionId?: string | undefined;
  /**
   * protocol v7 — monotonic revision of the advertised capability
   * state. Set at register and bumped on each accepted
   * `updateCapabilities`. Updates with a revision <= this are rejected as
   * stale/duplicate.
   */
  capabilityRevision: number;
  /**
   * the relay's advisory active-grant snapshot, retained under this
   * authenticated user/relay association. Present only when the relay
   * advertised a snapshot that passed the strict parser; a malformed snapshot
   * is dropped (see `register`) and leaves this `undefined`. It is discovery
   * data only — never authority. The relay-local resolver decides every access,
   * so stale or revoked entries here fail closed on the relay.
   */
  desktopFilesystemGrantSnapshot?: RelayDesktopFilesystemGrantSnapshot | undefined;
  /**
   * validated redacted Computer use grant projection. This is only
   * current-live discovery evidence; Electron reloads and enforces the local
   * receipt before an effect. Absent means Off/recovery/malformed.
   */
  desktopAutomationSnapshot?: RelayDesktopAutomationSnapshot | undefined;
  /**
   * the relay's advisory Workstation Profile binding snapshot, retained
   * under this authenticated user/relay association. Present only when the
   * relay advertised a snapshot that passed the strict parser; a malformed
   * snapshot is dropped (see `register`) and leaves this `undefined`. It is
   * advisory binding data only — never compiled-profile authority. The
   * desktop relay's live compiled profile remains final, so a stale or revoked
   * binding here fails closed on the relay.
   */
  workstationProfileSnapshot?: RelayWorkstationProfileSnapshot | undefined;
  /**
   * the server-derived `pairingGeneration` stamped from the
   * validated relay-token row id at register. It is NEVER accepted from the
   * relay/client payload: the endpoint reads it off the validated token and
   * passes it here. Present only when the register path supplied one (a
   * headless relay with no token would carry none); the binding provider
   * treats a missing/empty value as ineligible. A changed pairingGeneration
   * on re-register (same relay/user, same desktopSessionId) fires
   * `onPairingGenerationChanged` so bound Full Workstation sessions + plans
   * are invalidated even when desktopSessionId is reused.
   */
  pairingGeneration?: string | undefined;
  /** minted per live socket; never client-authored. */
  relaySessionId?: string | undefined;
  /** Opaque derivation of the validated pairing generation. */
  pairingGenerationRef?: string | undefined;
  /** Last accepted bounded Codex status for this authenticated v8 socket. */
  codexStatus?: CodexHostStatus | undefined;
  lastSeen: number;
  send: RelaySendFn;
}

interface CodexReplayEntry {
  readonly fingerprint: string;
  readonly expiresAt: number;
}

interface PendingCodexCommand {
  readonly command: RelayCodexCommandMessage;
  readonly fingerprint: string;
  readonly resolve: (response: RelayCodexCommandResponseMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly promise: Promise<RelayCodexCommandResponseMessage>;
}

interface CodexCommandOutcome {
  readonly fingerprint: string;
  readonly response: RelayCodexCommandResponseMessage;
  readonly expiresAt: number;
}

/**
 * server-private, copied view of a currently connected relay that is
 * eligible to be projected as a paired remote host. This is intentionally a
 * registry/server seam, not an API response: consumers must still join it to
 * durable, owner-scoped controller bindings before returning anything to a
 * client.
 *
 * Only relays carrying a non-empty server-derived pairing generation are
 * included. A connection without that generation cannot safely be matched to
 * a remote-controller binding and is therefore omitted rather than guessed.
 */
export interface RemotePresenceRelaySnapshot {
  readonly relayId: string;
  readonly pairingGeneration: string;
  readonly userId: string;
  readonly desktopSessionId: string | null;
  readonly protocolVersion: number;
  readonly capabilityRevision: number;
  readonly lastSeenAt: number;
  /** A copied, allow-listed readiness view; never a registry-owned object. */
  readonly capabilities: RemotePresenceCapabilitySummary;
}

/**
 * the only relay capability data allowed to cross the remote-presence
 * seam. This is deliberately not `RelayCapabilities`: remote-host discovery
 * needs a device profile and a few readiness hints, never filesystem paths,
 * network policy, security posture, MCP names, or advisory grant/profile
 * snapshots. Adding a field here is an explicit API/security decision.
 */
export interface RemotePresenceCapabilitySummary {
  readonly profile: "desktop-agent" | "device-relay";
  readonly canControlDesktop?: boolean;
  readonly canControlBrowser?: boolean;
  readonly canUseTerminal?: boolean;
  readonly canSeeDesktop?: boolean;
  readonly canReadWorkspace?: boolean;
  readonly canWriteWorkspace?: boolean;
  readonly canRunShell?: boolean;
}

/**
 * server-private current-live tuple for semantic desktop admission.
 * It is deliberately not part of remote-host presence or any client API.
 */
export interface ComputerUseRelaySnapshot {
  readonly relayId: string;
  readonly userId: string;
  readonly pairingGeneration: string;
  readonly pairingGenerationRef: string;
  readonly desktopSessionId: string;
  readonly canControlDesktop: boolean;
  readonly desktopAutomation: RelayDesktopAutomationSnapshot | null;
}

/**
 * post-mutation notification for the remote-host projector. Both
 * snapshots are fresh copies. `current:null` is the disconnect signal; the
 * previous snapshot preserves the exact pairing generation needed to retract
 * presence without a best-effort reverse lookup.
 */
export interface InMemoryRelayRegistryRemotePresenceChangedInput {
  readonly relayId: string;
  readonly previous: RemotePresenceRelaySnapshot | null;
  readonly current: RemotePresenceRelaySnapshot | null;
}

/**
 * Relay registration originates at a transport boundary. Keep the registry's
 * stored representation detached from that boundary even when a caller holds
 * on to, or later mutates, its original capabilities object. Bun/Node both
 * provide structuredClone and the relay capability payload is plain data.
 */
function copyRelayCapabilities(capabilities: RelayCapabilities): RelayCapabilities {
  return structuredClone(capabilities);
}

/**
 * Make a deliberately boring, allow-listed copy for remote presence. In
 * particular, advisory grant/profile snapshots, filesystem paths, network
 * allowlists, and MCP server/tool names are not part of remote-host discovery.
 * Only the profile and explicitly-curated readiness booleans cross this seam.
 */
function sanitizeCapabilitiesForRemotePresence(
  capabilities: RelayCapabilities,
): RemotePresenceCapabilitySummary | null {
  if (capabilities.profile !== "desktop-agent" && capabilities.profile !== "device-relay") {
    return null;
  }
  const raw = capabilities as Record<string, unknown>;
  const copied: RemotePresenceCapabilitySummary = {
    profile: capabilities.profile,
  };
  const copiedMutable = copied as unknown as Record<string, unknown>;
  for (const key of REMOTE_PRESENCE_CAPABILITY_BOOLEAN_KEYS) {
    if (typeof raw[key] === "boolean") {
      copiedMutable[key] = raw[key];
    }
  }
  return copied;
}

function snapshotRemotePresence(entry: RelayEntry): RemotePresenceRelaySnapshot | null {
  if (entry.pairingGeneration === undefined || entry.pairingGeneration === "") return null;
  const capabilities = sanitizeCapabilitiesForRemotePresence(entry.capabilities);
  if (capabilities === null) return null;
  return {
    relayId: entry.relayId,
    pairingGeneration: entry.pairingGeneration,
    userId: entry.userId,
    desktopSessionId: entry.desktopSessionId ?? null,
    protocolVersion: entry.protocolVersion,
    capabilityRevision: entry.capabilityRevision,
    lastSeenAt: entry.lastSeen,
    capabilities,
  };
}

const DESKTOP_AUTOMATION_SNAPSHOT_KEYS = [
  "agentId",
  "enabled",
  "grantGeneration",
  "installationEpoch",
  "provider",
  "providerGeneration",
] as const;

/**
 * Strictly parse the redacted discovery tuple. This is kept inside the
 * registry because registration and capability replacement are both hostile
 * transport boundaries; accepting a typed RelayCapabilities object is not a
 * substitute for validating its runtime bytes.
 */
function parseRelayDesktopAutomationSnapshot(
  value: unknown,
): { ok: true; snapshot: RelayDesktopAutomationSnapshot } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "capabilities.desktopAutomation must be an object" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    Object.getOwnPropertySymbols(record).length !== 0
    || keys.length !== DESKTOP_AUTOMATION_SNAPSHOT_KEYS.length
    || !keys.every((key, index) => key === DESKTOP_AUTOMATION_SNAPSHOT_KEYS[index])
  ) {
    return { ok: false, error: "capabilities.desktopAutomation has an invalid shape" };
  }
  const agentId = parseDesktopAutomationOpaqueId(record["agentId"]);
  const installationEpoch = parseDesktopAutomationOpaqueId(record["installationEpoch"]);
  const grantGeneration = record["grantGeneration"];
  const providerGeneration = parseDesktopAutomationOpaqueId(record["providerGeneration"]);
  if (
    record["enabled"] !== true
    || agentId === null
    || installationEpoch === null
    || record["provider"] !== "cua"
    || providerGeneration === null
    || typeof grantGeneration !== "number"
    || !Number.isSafeInteger(grantGeneration)
    || grantGeneration < 1
    || grantGeneration > MAX_DESKTOP_AUTOMATION_GRANT_GENERATION
  ) {
    return { ok: false, error: "capabilities.desktopAutomation is invalid" };
  }
  return {
    ok: true,
    snapshot: {
      enabled: true,
      agentId,
      installationEpoch,
      grantGeneration,
      provider: record["provider"],
      providerGeneration,
    },
  };
}

/**
 * validate any advertised advisory snapshots at registration. Both the
 * active-grant snapshot and the Workstation Profile binding snapshot are
 * advisory discovery only, so a malformed one is IGNORED SAFELY (dropped from
 * stored capabilities) rather than failing the whole relay registration —
 * mirroring the "pre-v9 relays simply carry no renamed envelope" convention. This
 * never grants authority: the relay-local resolver still decides every
 * filesystem access, and the desktop relay's live compiled profile remains
 * final. Returns the capabilities to store plus the validated snapshots (if
 * any). Each snapshot is sanitized independently so a malformed profile
 * snapshot never strips a valid grant snapshot (and vice versa).
 */
function sanitizeAdvisorySnapshots(
  capabilities: RelayCapabilities,
  protocolVersion: number,
): {
  capabilities: RelayCapabilities;
  snapshot: RelayDesktopFilesystemGrantSnapshot | undefined;
  profileSnapshot: RelayWorkstationProfileSnapshot | undefined;
  desktopAutomationSnapshot: RelayDesktopAutomationSnapshot | undefined;
} {
  let working = capabilities;
  if (protocolVersion < RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION) {
    const {
      computerUseSemanticVersion: _oldComputerUseSemanticVersion,
      desktopAutomation: _oldDesktopAutomation,
      canControlDesktop: _oldCanControlDesktop,
      ...compatible
    } = working;
    working = compatible;
  }
  // This marker is deliberately non-authoritative. It identifies the exact
  // snapshot schema supported by this Desktop; active authority still comes
  // solely from the complete `desktopAutomation` tuple below.
  if (working.computerUseSemanticVersion !== undefined) {
    if (working.profile !== "desktop-agent" || working.computerUseSemanticVersion !== COMPUTER_USE_SEMANTIC_VERSION) {
      const { computerUseSemanticVersion: _droppedComputerUseSemanticVersion, ...rest } = working;
      working = rest;
    }
  }
  // Codex is a capability declaration, not an untrusted extension bag. An
  // invalid optional declaration is dropped at registration just like the
  // advisory snapshots; explicit capability replacement rejects it below.
  if (capabilities.codex !== undefined) {
    const parsed = parseRelayCodexCapability(capabilities.codex);
    if (!parsed.ok || capabilities.profile !== "desktop-agent") {
      const { codex: _droppedCodex, ...rest } = working;
      working = rest;
    } else {
      working = { ...working, codex: parsed.value };
    }
  }
  if (capabilities.claude !== undefined) {
    const parsed = parseRelayClaudeCapability(capabilities.claude);
    if (!parsed.ok || capabilities.profile !== "desktop-agent" || protocolVersion < CLAUDE_CONNECTION_PROTOCOL_VERSION) {
      const { claude: _droppedClaude, ...rest } = working;
      working = rest;
    } else {
      working = { ...working, claude: parsed.value };
    }
  }
  // execution is a separate current-socket capability. Invalid
  // optional registration declarations are denial-only; an explicit update
  // below rejects them so it cannot silently retain an older execution host.
  if (capabilities.claudeExecution !== undefined) {
    const parsed = parseRelayClaudeExecutionCapability(capabilities.claudeExecution);
    if (!parsed.ok || capabilities.profile !== "desktop-agent" || protocolVersion < CLAUDE_EXECUTION_PROTOCOL_VERSION) {
      const { claudeExecution: _droppedClaudeExecution, ...rest } = working;
      working = rest;
    } else {
      working = { ...working, claudeExecution: parsed.value };
    }
  }
  // readiness is an allow-listed, secret-free discovery projection. A
  // malformed optional declaration is dropped at registration; explicit
  // capability replacement rejects it below.
  if (capabilities.structuredSsh !== undefined) {
    const parsed = parseRelayStructuredSshReadiness(capabilities.structuredSsh);
    if (!parsed.ok || capabilities.profile !== "desktop-agent") {
      const { structuredSsh: _droppedStructuredSsh, ...rest } = working;
      working = rest;
    } else {
      working = { ...working, structuredSsh: parsed.readiness };
    }
  }
  if (capabilities.acp !== undefined) {
    const parsed = parseRelayAcpCapability(capabilities.acp);
    // ACP v13 advertised the readiness-only host. Keep that capability on
    // an otherwise valid v13 relay; v14 execution is gated separately when
    // its typed lifecycle messages are admitted.
    if (!parsed.ok || capabilities.profile !== "desktop-agent" || protocolVersion < ACP_RELAY_READINESS_PROTOCOL_VERSION) {
      const { acp: _droppedAcp, ...rest } = working;
      working = rest;
    } else {
      working = { ...working, acp: parsed.value };
    }
  }
  let snapshot: RelayDesktopFilesystemGrantSnapshot | undefined;
  const advertisedGrant = capabilities.desktopFilesystemGrantSnapshot;
  if (advertisedGrant !== undefined && protocolVersion < DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION) {
    // protocol cutover: pre-v9 relays never advertised the renamed
    // snapshot wire field. Drop it rather than retaining a value an old peer
    // could not have understood.
    const { desktopFilesystemGrantSnapshot: _droppedGrant, ...rest } = working;
    working = rest;
  } else if (advertisedGrant !== undefined) {
    const parsed = parseRelayDesktopFilesystemGrantSnapshot(advertisedGrant);
    if (!parsed.ok) {
      // Fail closed for discovery: strip the malformed advisory grant snapshot
      // but keep the relay registered and fully functional for every other
      // capability.
      const { desktopFilesystemGrantSnapshot: _droppedGrant, ...rest } = working;
      working = rest;
    } else {
      working = { ...working, desktopFilesystemGrantSnapshot: parsed.snapshot };
      snapshot = parsed.snapshot;
    }
  }
  let profileSnapshot: RelayWorkstationProfileSnapshot | undefined;
  const advertisedProfile = working.workstationProfileSnapshot;
  if (advertisedProfile !== undefined) {
    const parsed = parseRelayWorkstationProfileSnapshot(advertisedProfile);
    if (!parsed.ok) {
      // Fail closed for discovery: strip the malformed advisory profile
      // binding snapshot but keep the relay registered and every other
      // capability (including a valid grant snapshot) intact.
      const { workstationProfileSnapshot: _droppedProfile, ...rest } = working;
      working = rest;
    } else {
      working = { ...working, workstationProfileSnapshot: parsed.snapshot };
      profileSnapshot = parsed.snapshot;
    }
  }
  let desktopAutomationSnapshot: RelayDesktopAutomationSnapshot | undefined;
  // The marker is the exact schema companion for the current Computer Use
  // snapshot. It never creates a route by itself; malformed or incomplete
  // tuples are dropped before discovery.
  const hasAdvertisedDesktopAutomation = Object.hasOwn(working, "desktopAutomation");
  const advertisedDesktopAutomation = working.desktopAutomation;
  const hasCurrentComputerUseMarker = working.computerUseSemanticVersion === COMPUTER_USE_SEMANTIC_VERSION;
  if (hasAdvertisedDesktopAutomation) {
    const parsed = parseRelayDesktopAutomationSnapshot(advertisedDesktopAutomation);
    if (
      !parsed.ok
      || working.profile !== "desktop-agent"
      || working.canControlDesktop !== true
      || !hasCurrentComputerUseMarker
    ) {
      const { desktopAutomation: _droppedDesktopAutomation, ...rest } = working;
      working = rest;
    } else {
      working = { ...working, computerUseSemanticVersion: COMPUTER_USE_SEMANTIC_VERSION, desktopAutomation: parsed.snapshot };
      desktopAutomationSnapshot = parsed.snapshot;
    }
  }
  return { capabilities: working, snapshot, profileSnapshot, desktopAutomationSnapshot };
}

/**
 * protocol v7 — strict, fail-closed parser for a `relay:update-capabilities`
 * payload. Unlike `sanitizeAdvisorySnapshots` (used at register, where a
 * malformed advisory snapshot is dropped but the relay stays registered), an
 * update is an explicit full-replacement: a malformed payload REJECTS the
 * whole update and leaves the prior state intact. A narrower or empty snapshot
 * is valid and applies immediately. The snapshot portions are validated by the
 * shared strict parsers; the profile must be one of the two known relay
 * profiles.
 *
 * Anti-smuggling: the rebuilt `RelayCapabilities` is reconstructed ONLY from
 * the known capability surface below. Unknown top-level keys in the raw update
 * are dropped (never copied), and a known key carrying a value of the wrong
 * type rejects the whole update so a malformed frame cannot smuggle
 * non-capability state through either an unknown field or a mistyped known
 * one. The two advisory snapshots are added back only after their strict
 * parsers accept them.
 */

const CAPABILITY_BOOLEAN_KEYS = [
  "canDiscoverHue",
  "canControlHue",
  "canControlSonos",
  "canControlTV",
  "canControlDesktop",
  "canControlBrowser",
  "canResearchWeb",
  "canSearchResearchWeb",
  "canDeferResearchChallenges",
  "canContinueBrowserPageRead",
  "canInspectBrowserPageSnapshot",
  "canReplayResearchConsent",
  "canRecoverResearchConsent",
  "canUseTerminal",
  "hasPendingTerminalHandoff",
  "canUseGoogleWorkspace",
  "canSeeDesktop",
  "canReadWorkspace",
  "canWriteWorkspace",
  "canBrowsePairedFilesystem",
  "canRunShell",
  "canReadStructuredSshOutput",
  "localFileExecution",
  "applyPatchExecution",
  "canRunOffice",
] as const;

/**
 * A much narrower subset than the full relay capability surface. Keep this
 * list adjacent to the broader parser list so new relay capabilities do not
 * accidentally become remotely discoverable by default.
 */
const REMOTE_PRESENCE_CAPABILITY_BOOLEAN_KEYS = [
  "canControlDesktop",
  "canControlBrowser",
  "canUseTerminal",
  "canSeeDesktop",
  "canReadWorkspace",
  "canWriteWorkspace",
  "canRunShell",
] as const;

// These paths are retained only inside the authenticated relay registry. In
// particular, the current two desktop roots must never be added to the much
// narrower RemotePresenceCapabilitySummary projection below.
const CAPABILITY_STRING_KEYS = [
  "dataDir",
  "toolsBin",
  "userHome",
  "workspaceRoot",
  "currentFolderRoot",
  "browserSessionId",
] as const;

const CAPABILITY_STRING_ARRAY_KEYS = ["allowedRoots", "allowedHosts"] as const;

const CAPABILITY_SECURITY_LEVELS = new Set(["cautious", "standard", "permissive"]);

function isBooleanValue(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringValue(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArrayValue(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Reconstructs the known, type-validated non-snapshot capability fields from
 * a raw update frame. Unknown keys are dropped; a known key with a wrong-typed
 * value rejects. Returns the validated fields keyed by their capability name.
 */
function parseKnownCapabilityFields(
  raw: Record<string, unknown>,
  protocolVersion: number,
): { ok: true; fields: Record<string, unknown> } | { ok: false; error: string } {
  const fields: Record<string, unknown> = {};
  if (raw["computerUseSemanticVersion"] !== undefined) {
    if (raw["profile"] !== "desktop-agent" || raw["computerUseSemanticVersion"] !== COMPUTER_USE_SEMANTIC_VERSION) {
      return { ok: false, error: `capabilities.computerUseSemanticVersion requires desktop-agent and version ${COMPUTER_USE_SEMANTIC_VERSION}` };
    }
    fields["computerUseSemanticVersion"] = COMPUTER_USE_SEMANTIC_VERSION;
  }
  for (const key of CAPABILITY_BOOLEAN_KEYS) {
    if (raw[key] === undefined) continue;
    if (!isBooleanValue(raw[key])) {
      return { ok: false, error: `capabilities.${key} must be a boolean` };
    }
    fields[key] = raw[key];
  }
  for (const key of CAPABILITY_STRING_KEYS) {
    if (raw[key] === undefined) continue;
    if (!isStringValue(raw[key])) {
      return { ok: false, error: `capabilities.${key} must be a string` };
    }
    fields[key] = raw[key];
  }
  for (const key of CAPABILITY_STRING_ARRAY_KEYS) {
    if (raw[key] === undefined) continue;
    if (!isStringArrayValue(raw[key])) {
      return { ok: false, error: `capabilities.${key} must be a string array` };
    }
    fields[key] = raw[key];
  }
  if (raw["securityLevel"] !== undefined) {
    if (!isStringValue(raw["securityLevel"]) || !CAPABILITY_SECURITY_LEVELS.has(raw["securityLevel"])) {
      return {
        ok: false,
        error: "capabilities.securityLevel must be one of cautious|standard|permissive",
      };
    }
    fields["securityLevel"] = raw["securityLevel"];
  }
  if (raw["mcpTools"] !== undefined) {
    const mcp = raw["mcpTools"];
    if (
      !Array.isArray(mcp) ||
      !mcp.every(
        (entry): entry is { serverName: string; toolNames: string[] } =>
          typeof entry === "object" &&
          entry !== null &&
          isStringValue((entry as Record<string, unknown>)["serverName"]) &&
          isStringArrayValue((entry as Record<string, unknown>)["toolNames"]),
      )
    ) {
      return {
        ok: false,
        error: "capabilities.mcpTools must be an array of { serverName, toolNames }",
      };
    }
    fields["mcpTools"] = mcp;
  }
  if (raw["codex"] !== undefined) {
    if (raw["profile"] !== "desktop-agent") {
      return { ok: false, error: "capabilities.codex requires desktop-agent" };
    }
    const parsed = parseRelayCodexCapability(raw["codex"]);
    if (!parsed.ok) {
      return { ok: false, error: "capabilities.codex is invalid" };
    }
    fields["codex"] = parsed.value;
  }
  if (raw["claude"] !== undefined) {
    if (raw["profile"] !== "desktop-agent") return { ok: false, error: "capabilities.claude requires desktop-agent" };
    if (protocolVersion < CLAUDE_CONNECTION_PROTOCOL_VERSION) return { ok: false, error: "capabilities.claude requires relay protocol v17" };
    const parsed = parseRelayClaudeCapability(raw["claude"]);
    if (!parsed.ok) return { ok: false, error: "capabilities.claude is invalid" };
    fields["claude"] = parsed.value;
  }
  if (raw["claudeExecution"] !== undefined) {
    if (raw["profile"] !== "desktop-agent") {
      return { ok: false, error: "capabilities.claudeExecution requires desktop-agent" };
    }
    if (protocolVersion < CLAUDE_EXECUTION_PROTOCOL_VERSION) {
      return { ok: false, error: "capabilities.claudeExecution requires relay protocol v18" };
    }
    const parsed = parseRelayClaudeExecutionCapability(raw["claudeExecution"]);
    if (!parsed.ok) return { ok: false, error: "capabilities.claudeExecution is invalid" };
    fields["claudeExecution"] = parsed.value;
  }
  if (raw["acp"] !== undefined) {
    if (raw["profile"] !== "desktop-agent") return { ok: false, error: "capabilities.acp requires desktop-agent" };
    const parsed = parseRelayAcpCapability(raw["acp"]);
    if (!parsed.ok) return { ok: false, error: "capabilities.acp is invalid" };
    fields["acp"] = parsed.value;
  }
  return { ok: true, fields };
}

function parseCapabilityUpdate(value: unknown, protocolVersion: number): {
  ok: true;
  capabilities: RelayCapabilities;
  snapshot: RelayDesktopFilesystemGrantSnapshot | undefined;
  profileSnapshot: RelayWorkstationProfileSnapshot | undefined;
  desktopAutomationSnapshot: RelayDesktopAutomationSnapshot | undefined;
} | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "capabilities must be an object" };
  }
  const raw = value as Record<string, unknown>;
  if (protocolVersion < RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION
    && (raw["computerUseSemanticVersion"] !== undefined
      || raw["desktopAutomation"] !== undefined
      || raw["canControlDesktop"] !== undefined)) {
    return { ok: false, error: `semantic Computer Use requires relay protocol v${RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION}` };
  }
  if (raw["profile"] !== "desktop-agent" && raw["profile"] !== "device-relay") {
    return { ok: false, error: "capabilities profile is unsupported" };
  }
  let snapshot: RelayDesktopFilesystemGrantSnapshot | undefined;
  if (raw["desktopFilesystemGrantSnapshot"] !== undefined) {
    if (protocolVersion < DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION) {
      return { ok: false, error: "desktop filesystem grant snapshot requires relay protocol v9" };
    }
    const parsed = parseRelayDesktopFilesystemGrantSnapshot(raw["desktopFilesystemGrantSnapshot"]);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    snapshot = parsed.snapshot;
  }
  let profileSnapshot: RelayWorkstationProfileSnapshot | undefined;
  if (raw["workstationProfileSnapshot"] !== undefined) {
    const parsed = parseRelayWorkstationProfileSnapshot(raw["workstationProfileSnapshot"]);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    profileSnapshot = parsed.snapshot;
  }
  let desktopAutomationSnapshot: RelayDesktopAutomationSnapshot | undefined;
  if (raw["desktopAutomation"] !== undefined) {
    if (raw["profile"] !== "desktop-agent") {
      return { ok: false, error: "capabilities.desktopAutomation requires desktop-agent" };
    }
    if (
      raw["computerUseSemanticVersion"] !== COMPUTER_USE_SEMANTIC_VERSION
      || raw["canControlDesktop"] !== true
    ) {
      return { ok: false, error: "capabilities.desktopAutomation requires the current Cua capability tuple" };
    }
    const parsed = parseRelayDesktopAutomationSnapshot(raw["desktopAutomation"]);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    desktopAutomationSnapshot = parsed.snapshot;
  }
  let structuredSsh: RelayCapabilities["structuredSsh"];
  if (raw["structuredSsh"] !== undefined) {
    if (raw["profile"] !== "desktop-agent") {
      return { ok: false, error: "capabilities.structuredSsh requires desktop-agent" };
    }
    const parsed = parseRelayStructuredSshReadiness(raw["structuredSsh"]);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    structuredSsh = parsed.readiness;
  }
  // Rebuild capabilities from the known surface ONLY. Unknown top-level keys
  // are dropped (not copied) so a malformed update can't smuggle non-capability
  // state, and a known key with a wrong type rejects the whole update.
  const known = parseKnownCapabilityFields(raw, protocolVersion);
  if (!known.ok) {
    return { ok: false, error: known.error };
  }
  const capabilities: RelayCapabilities = {
    ...known.fields,
    profile: raw["profile"],
    ...(snapshot !== undefined ? { desktopFilesystemGrantSnapshot: snapshot } : {}),
    ...(profileSnapshot !== undefined ? { workstationProfileSnapshot: profileSnapshot } : {}),
    ...(desktopAutomationSnapshot !== undefined ? { desktopAutomation: desktopAutomationSnapshot } : {}),
    ...(structuredSsh !== undefined ? { structuredSsh } : {}),
  } as RelayCapabilities;
  return { ok: true, capabilities, snapshot, profileSnapshot, desktopAutomationSnapshot };
}

interface PendingDispatch {
  resolve: (result: RelayDispatchResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The request crossed the registry's send seam, so its process outcome is no longer knowable on loss. */
  dispatched: boolean;
  toolName: string;
  /** Only a raw command can have started a child process. */
  rawRunShellCommand: boolean;
  /** subset of raw shell work admitted to the uncontained runner. */
  realWorkstationRawRunShell: boolean;
  /** A structured SSH frame may have reached Electron's fixed broker. */
  structuredSshDispatch: boolean;
  /** A mutating Computer Use or Browser frame may have changed UI state before its receipt is lost. */
  effectfulDesktopAutomation: boolean;
  /** Exact prepared operation; auth is deliberately progress-free. */
  structuredSshOperation?: RelaySshOperation | undefined;
  /** Authenticated socket generation that accepted this dispatch frame. */
  connectionGeneration: number;
  /** Cancel has been forwarded; do not let duplicate cancels extend its receipt window. */
  receiptGraceReason?: "cancel" | "timeout" | undefined;
  onSecurityScanProgress?: ((progress: RelaySecurityScanProgressMessage) => void) | undefined;
  onRunShellProgress?: ((progress: RelayRunShellProgressMessage) => void) | undefined;
  onStructuredSshProgress?: ((progress: RelayStructuredSshProgressMessage) => void) | undefined;
  lastRunShellProgressSequence: number;
  runShellProgressEnds: { stdout: number; stderr: number };
  lastStructuredSshProgressSequence: number;
  structuredSshProgressEnds: { stdout: number; stderr: number };
  structuredSshTransferStarted: boolean;
  lastStructuredSshTransferBytes: number;
  structuredSshTransferTotal?: number | undefined;
  abortSignal?: AbortSignal | undefined;
  abortListener?: (() => void) | undefined;
}

export interface RelayMcpPreflightRequest {
  readonly requestId: string;
  readonly digest: string;
  /** Exact Desktop session approved by the server for this operation. */
  readonly expectedDesktopSessionId: string;
  readonly server: RelayMcpServerConfig;
  readonly timeoutMs?: number | undefined;
}

export interface RelayMcpConfigureRequest {
  readonly servers: readonly RelayMcpServerConfig[];
  readonly operation: RelayMcpConfigureOperation;
  /** Exact Desktop session approved by the server for this operation. */
  readonly expectedDesktopSessionId: string;
  readonly timeoutMs?: number | undefined;
}

interface PendingMcpPreflight {
  readonly relayId: string;
  readonly connectionGeneration: number;
  readonly requestId: string;
  readonly digest: string;
  readonly targetName: string;
  /** The request's transport determines which launcher report is meaningful. */
  readonly transportKind: RelayMcpServerConfig["transportKind"];
  /** Ordered env NAMES only — values never enter pending registry state. */
  readonly environmentNames: readonly string[];
  readonly resolve: (result: RelayMcpPreflightResultMessage) => void;
  readonly reject: (error: RelayMcpTruthError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingMcpConfigure {
  readonly relayId: string;
  readonly connectionGeneration: number;
  readonly operationId: string;
  readonly digest: string;
  readonly targetName: string;
  /** A start must observe connected; a rollback must observe stopped. */
  readonly phase: RelayMcpConfigureOperation["phase"];
  readonly resolve: (result: RelayMcpConfigureResultMessage) => void;
  readonly reject: (error: RelayMcpTruthError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Server-only input for Electron's exact structured-SSH preparation. */
export interface RelaySshPrepareInvocation {
  readonly instanceId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly actorRole: "owner" | "admin";
  readonly agentId: string;
  readonly executionEntrypoint: "foreground.main";
  readonly toolCallId: string;
  readonly approvedRequestDigest: string;
  readonly operation: RelaySshOperation;
  /** Canonical model/Human-approved request Electron must reparse before preparing. */
  readonly approvedRequest: RelaySshApprovedRequestV1;
  readonly timeoutMs?: number | undefined;
}

interface PendingSshPrepare {
  readonly relayId: string;
  readonly connectionGeneration: number;
  readonly request: RelaySshPrepareRequestV1;
  readonly resolve: (response: RelaySshPrepareResponseV1) => void;
  readonly reject: (error: RelaySshPrepareError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type RelaySshPrepareErrorCode =
  | RelaySshPrepareFailureCode
  | "relay_unavailable"
  | "relay_protocol_unsupported"
  | "relay_disconnected"
  | "relay_replaced"
  | "topology_stale"
  | "ssh_prepare_timeout"
  | "ssh_prepare_duplicate"
  | "ssh_prepare_response_mismatch";

/** Secret-free, typed failure for the correlated SSH prepare seam. */
export class RelaySshPrepareError extends Error {
  readonly code: RelaySshPrepareErrorCode;
  readonly failure: RelaySshResolutionFailure | undefined;

  constructor(code: RelaySshPrepareErrorCode, failure?: RelaySshResolutionFailure) {
    super(code);
    this.name = "RelaySshPrepareError";
    this.code = code;
    this.failure = failure;
  }
}

export type RelayMcpTruthErrorCode =
  | "relay_unavailable"
  | "relay_protocol_unsupported"
  | "mcp_preflight_timeout"
  | "mcp_configure_timeout"
  | "relay_disconnected"
  | "relay_replaced"
  | "mcp_response_mismatch"
  | "mcp_duplicate_operation";

/** Stable transport-level failure for an unconfirmed local-MCP operation. */
export class RelayMcpTruthError extends Error {
  readonly code: RelayMcpTruthErrorCode;

  constructor(code: RelayMcpTruthErrorCode) {
    super(code);
    this.name = "RelayMcpTruthError";
    this.code = code;
  }
}

function matchesPendingMcpPreflight(
  pending: PendingMcpPreflight,
  result: RelayMcpPreflightResultMessage,
): boolean {
  const resultNames = result.environment.map((entry) => entry.name);
  if (
    resultNames.length !== pending.environmentNames.length ||
    new Set(resultNames).size !== resultNames.length ||
    resultNames.some((name, index) => name !== pending.environmentNames[index])
  ) {
    return false;
  }
  if (pending.transportKind === "stdio") {
    // stdio has a launcher; ready specifically means that launcher is present.
    return result.launcher !== "not-applicable" &&
      (result.status !== "ready" || result.launcher === "present");
  }
  // HTTP/SSE transports never have a local process launcher.
  return result.launcher === "not-applicable";
}

function matchesPendingMcpConfigure(
  pending: PendingMcpConfigure,
  result: RelayMcpConfigureResultMessage,
): boolean {
  // `failed` is an observed terminal outcome, not a phase contradiction: the
  // caller needs its fixed category to explain a spawn/protocol/rollback
  // failure. Only the other phase's successful terminal state is impossible.
  return result.state === "failed" ||
    (pending.phase === "start" && result.state === "connected") ||
    (pending.phase === "rollback" && result.state === "stopped");
}

const MCP_RELAY_TRUTH_DEFAULT_TIMEOUT_MS = 20_000;
const MCP_RELAY_TRUTH_MAX_TIMEOUT_MS = 30_000;
const SSH_PREPARE_DEFAULT_TIMEOUT_MS = 15_000;
const SSH_PREPARE_MAX_TIMEOUT_MS = 30_000;

function boundedMcpTruthTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return MCP_RELAY_TRUTH_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return MCP_RELAY_TRUTH_DEFAULT_TIMEOUT_MS;
  return Math.min(timeoutMs, MCP_RELAY_TRUTH_MAX_TIMEOUT_MS);
}

function mcpPendingKey(relayId: string, id: string): string {
  return `${relayId}:${id}`;
}

function boundedSshPrepareTimeout(timeoutMs: number | undefined): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs === undefined || timeoutMs <= 0) {
    return SSH_PREPARE_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(timeoutMs, SSH_PREPARE_MAX_TIMEOUT_MS);
}

function sshPreparePendingKey(relayId: string, requestId: string): string {
  return `${relayId}:${requestId}`;
}

/**
 * 's shared catalog token covers both auth and exec, so it is usable only
 * when the relay's exact aggregate permits both operations. Keep this
 * projection check here, beside the registry routes that consume it: the
 * Electron-local prepare still selects the one destination-specific grant.
 */
function hasStructuredSshAuthExecReadiness(capabilities: RelayCapabilities): boolean {
  const readiness = capabilities.structuredSsh;
  return readiness?.state === "enabled" &&
    readiness.provider === "openssh" &&
    readiness.ssh === "observed" &&
    readiness.auth === true &&
    readiness.exec === true;
}

function hasConfigurableStructuredSsh(capabilities: RelayCapabilities): boolean {
  const readiness = capabilities.structuredSsh;
  return readiness !== undefined &&
    readiness.state !== "unavailable" &&
    readiness.provider === "openssh" &&
    readiness.ssh === "observed";
}

function hasConfigurableStructuredSshCopy(capabilities: RelayCapabilities): boolean {
  return hasConfigurableStructuredSsh(capabilities) &&
    capabilities.structuredSsh?.scp === "observed";
}

/**
 * The current catalog token cannot distinguish copy direction. Advertising
 * it therefore requires OpenSSH scp plus both aggregate directions.
 */
function hasStructuredSshCopyReadiness(capabilities: RelayCapabilities): boolean {
  const readiness = capabilities.structuredSsh;
  return readiness?.state === "enabled" &&
    readiness.provider === "openssh" &&
    readiness.ssh === "observed" &&
    readiness.auth === true &&
    readiness.exec === true &&
    readiness.scp === "observed" &&
    readiness.upload === true &&
    readiness.download === true;
}

/**
 * Prepare receives the exact operation, unlike the shared catalog tokens.
 * Gate that operation against its own advertised executable rather than
 * accidentally imposing the auth/exec catalog boundary on copy requests.
 */
function hasStructuredSshOperationReadiness(
  capabilities: RelayCapabilities,
  operation: RelaySshOperation,
): boolean {
  const readiness = capabilities.structuredSsh;
  if (
    readiness?.state !== "enabled" ||
    readiness.provider !== "openssh" ||
    readiness.ssh !== "observed"
  ) {
    return false;
  }
  switch (operation) {
    case "auth":
      return readiness.auth === true;
    case "exec":
      return readiness.exec === true;
    case "copy-upload":
      return readiness.scp === "observed" && readiness.upload === true;
    case "copy-download":
      return readiness.scp === "observed" && readiness.download === true;
  }
}

function sameSshPrepareRequestAndResponse(
  request: RelaySshPrepareRequestV1,
  response: RelaySshPrepareResponseV1,
): boolean {
  return request.requestId === response.requestId &&
    request.toolCallId === response.toolCallId &&
    request.approvedRequestDigest === response.approvedRequestDigest &&
    request.operation === response.operation &&
    request.subject.instanceId === response.subject.instanceId &&
    request.subject.userId === response.subject.userId &&
    request.subject.actorId === response.subject.actorId &&
    request.subject.actorRole === response.subject.actorRole &&
    request.subject.agentId === response.subject.agentId &&
    request.subject.executionEntrypoint === response.subject.executionEntrypoint &&
    request.subject.relayId === response.subject.relayId &&
    request.subject.relaySessionId === response.subject.relaySessionId &&
    request.subject.desktopSessionId === response.subject.desktopSessionId &&
    request.subject.pairingGenerationRef === response.subject.pairingGenerationRef &&
    request.subject.capabilityRevision === response.subject.capabilityRevision;
}

/**
 * Stable internal transport disposition for an effectful Desktop frame that
 * may have reached Electron but has no canonical receipt. This is deliberately
 * an Error (not a relay result): no relay result exists. Consumers may use its
 * structural discriminant across the runtime/agent package boundary without
 * importing this package (which would create a dependency cycle).
 */
export class RelayDispatchOutcomeUnknownError extends Error {
  readonly runShellOutcome?: "unknown";
  readonly structuredSshOutcome?: "unknown";
  readonly desktopAutomationOutcome?: "unknown";
  readonly reason: "disconnect" | "timeout" | "cancel" | "shutdown" | "replacement";

  constructor(
    kind: "raw-run-shell" | "structured-ssh" | "desktop-automation",
    reason: RelayDispatchOutcomeUnknownError["reason"],
  ) {
    const label = kind === "raw-run-shell"
      ? "run_shell"
      : kind === "structured-ssh"
        ? "structured SSH"
        : "desktop automation";
    super(`${label} outcome unknown after relay dispatch (${reason})`);
    this.name = "RelayDispatchOutcomeUnknownError";
    if (kind === "raw-run-shell") {
      this.runShellOutcome = "unknown";
    } else if (kind === "structured-ssh") {
      this.structuredSshOutcome = "unknown";
    } else {
      this.desktopAutomationOutcome = "unknown";
    }
    this.reason = reason;
  }
}

function pendingDispatchError(
  pending: Pick<PendingDispatch, "dispatched" | "rawRunShellCommand" | "structuredSshDispatch" | "effectfulDesktopAutomation">,
  reason: RelayDispatchOutcomeUnknownError["reason"],
  fallback: string,
): Error {
  if (!pending.dispatched) return new Error(fallback);
  if (pending.rawRunShellCommand) {
    return new RelayDispatchOutcomeUnknownError("raw-run-shell", reason);
  }
  if (pending.structuredSshDispatch) {
    return new RelayDispatchOutcomeUnknownError("structured-ssh", reason);
  }
  if (pending.effectfulDesktopAutomation) {
    return new RelayDispatchOutcomeUnknownError("desktop-automation", reason);
  }
  return new Error(fallback);
}

/** Electron needs a short, bounded window to return its canonical final receipt. */
const RUN_SHELL_RESULT_RECEIPT_GRACE_MS = 5_000;
// Hue's executor owns and reaps the pairing process at its setup deadline.
// Allow its terminal receipt to arrive before abandoning the server wait.
const HUE_SETUP_RESULT_RECEIPT_GRACE_MS = 5_000;
const RUN_SHELL_RESULT_RECEIPT_GRACE_MAX_MS = 10_000;
const DESKTOP_AUTOMATION_RESULT_RECEIPT_GRACE_MS = 5_000;
const DESKTOP_AUTOMATION_RESULT_RECEIPT_GRACE_MAX_MS = 10_000;

function isRawRunShellCommand(request: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}): boolean {
  return request.toolName === "run_shell" &&
    typeof request.args["command"] === "string" &&
    request.args["command"].length > 0;
}

function isStructuredSshDispatch(request: {
  readonly toolName: string;
  readonly sshBinding?: RelaySshDispatchBindingV1 | undefined;
  readonly executionClass?: string | undefined;
}): boolean {
  return request.toolName === "ssh" &&
    request.executionClass === "structured-ssh" &&
    request.sshBinding !== undefined;
}

function isEffectfulDesktopAutomationDispatch(request: {
  readonly toolName: string;
  readonly executionClass?: string | undefined;
  readonly desktopAutomationBinding?: unknown;
}): boolean {
  return (request.executionClass === "computer_use" &&
    request.desktopAutomationBinding !== undefined) ||
    (request.executionClass === "browser" && browserToolMayMutate(request.toolName));
}

/**
 * 4.1.3 — server-private snapshot of a connected relay, surfaced for
 * focused-local-file validation. Carries ONLY the fields the local-file
 * resolver needs to enforce sender ownership + protocol v4 +
 * `profile:"desktop-agent"` + `localFileExecution:true`. Relay IDs, byte
 * bridges, and WebSocket/API transport stay hidden from the model — this
 * snapshot never authorizes a byte read; filesystem authority (realpath /
 * symlink / allowedRoots) remains with tool dispatch on the relay.
 */
export interface FocusedResourceRelaySnapshot {
  /** True when the relay's registered owner id matches the sending actor. */
  ownedByActor: boolean;
  /** Protocol version the relay registered with. */
  protocolVersion: number;
  profile: "device-relay" | "desktop-agent";
  localFileExecution: boolean;
  /** relay can run the dedicated v8 apply-patch operation. */
  applyPatchExecution: boolean;
  /** Relay-advertised allowed roots (advisory for tool dispatch; never the
   * focus resolver's authority — `rootPath`/`allowedRoots` are revalidated
   * by the relay at execution time). */
  allowedRoots: readonly string[];
  /** relay bundles OfficeCLI and can run structured local Office ops. */
  canRunOffice: boolean;
}

/**
 * exact eligibility gate for an already-pinned focused relay. This is
 * intentionally a gate, not a selector: callers must never replace an
 * unavailable or incompatible pinned relay with another connected device.
 */
export function canDispatchApplyPatchToFocusedRelay(
  snapshot: FocusedResourceRelaySnapshot | null | undefined,
): boolean {
  return (
    snapshot !== null &&
    snapshot !== undefined &&
    snapshot.ownedByActor &&
    canRelayExecuteApplyPatch(snapshot.protocolVersion, {
      profile: snapshot.profile,
      applyPatchExecution: snapshot.applyPatchExecution,
    })
  );
}

/** Stable fail-closed error returned for every rejected v8 relay round trip. */
export const APPLY_PATCH_RELAY_DISPATCH_ERROR = "relay apply-patch dispatch failed";

/** A sanitized relay failure with the public stable category intact. */
export class ApplyPatchRelayDispatchError extends Error {
  readonly applyPatchErrorCode: "stale_context" | "human_edit_conflict" | "reapply_required" | "denied_path" | "runtime_unavailable" | "parse_error" | "invalid_request";
  readonly applyPatchFailureReason: "stale_current_folder" | undefined;
  constructor(
    code: ApplyPatchRelayDispatchError["applyPatchErrorCode"],
    failureReason?: ApplyPatchRelayDispatchError["applyPatchFailureReason"],
  ) {
    super(APPLY_PATCH_RELAY_DISPATCH_ERROR);
    this.name = "ApplyPatchRelayDispatchError";
    this.applyPatchErrorCode = code;
    this.applyPatchFailureReason = failureReason;
  }
}

/** Stable, redacted error for the current exact Desktop-only research read. */
export class BrowserResearchReadRelayDispatchError extends Error {
  readonly browserResearchReadErrorCode:
    | "runtime_unavailable" | "transport_failed" | "invalid_result"
    | "cancelled" | "alternate" | "expired" | "consent_wall";
  constructor(code: BrowserResearchReadRelayDispatchError["browserResearchReadErrorCode"]) {
    super("relay browser research read dispatch failed");
    this.name = "BrowserResearchReadRelayDispatchError";
    this.browserResearchReadErrorCode = code;
  }
}

/** Stable, redacted error for v13's inert retained-page inspection. */
export class BrowserResearchSnapshotInspectionRelayDispatchError extends Error {
  readonly browserResearchSnapshotInspectionErrorCode:
    | "runtime_unavailable" | "transport_failed" | "invalid_result"
    | "expired" | "evicted" | "unavailable" | "invalid_offset" | "resource_limit";
  constructor(code: BrowserResearchSnapshotInspectionRelayDispatchError["browserResearchSnapshotInspectionErrorCode"]) {
    super("relay browser research snapshot inspection failed");
    this.name = "BrowserResearchSnapshotInspectionRelayDispatchError";
    this.browserResearchSnapshotInspectionErrorCode = code;
  }
}

export class BrowserResearchConsentRecoveryRelayDispatchError extends Error {
  readonly browserResearchConsentRecoveryErrorCode:
    | "runtime_unavailable" | "transport_failed" | "invalid_result" | "expired" | "operation_failed";
  constructor(code: BrowserResearchConsentRecoveryRelayDispatchError["browserResearchConsentRecoveryErrorCode"]) {
    super("relay browser research consent recovery failed");
    this.name = "BrowserResearchConsentRecoveryRelayDispatchError";
    this.browserResearchConsentRecoveryErrorCode = code;
  }
}

export class BrowserResearchSearchRelayDispatchError extends Error {
  readonly browserResearchSearchErrorCode: "runtime_unavailable" | "transport_failed" | "invalid_result" | "cancelled";
  constructor(code: BrowserResearchSearchRelayDispatchError["browserResearchSearchErrorCode"]) {
    super("relay browser research search dispatch failed");
    this.name = "BrowserResearchSearchRelayDispatchError";
    this.browserResearchSearchErrorCode = code;
  }
}

function safeApplyPatchRelayFailureReason(
  errorCode: string | undefined,
): ApplyPatchRelayDispatchError["applyPatchFailureReason"] {
  // Keep relay-local paths and raw error strings private. This allowlisted
  // reason only tells the server that Electron main's selection changed.
  return errorCode === "stale_context" ? "stale_current_folder" : undefined;
}

function stableApplyPatchRelayErrorCode(errorCode: string | undefined): ApplyPatchRelayDispatchError["applyPatchErrorCode"] {
  if (errorCode === "denied_path" || errorCode === "runtime_unavailable") return errorCode;
  if (errorCode === "stale_context") return "stale_context";
  if (errorCode === "human_edit_conflict" || errorCode === "reapply_required") return errorCode;
  if (errorCode === "parse_error") return "parse_error";
  if (errorCode === "invalid_request") return "invalid_request";
  // Every live grant rejection is local authority denial: no grant, revoked,
  // expired, changed root, protected path, or an incomplete operation set.
  if (errorCode?.includes("GRANT") || errorCode === "REVOKED" || errorCode === "EXPIRED" ||
      errorCode === "PROTECTED_PATH" || errorCode === "IDENTITY_MISMATCH" || errorCode === "OPERATION_UPGRADE" ||
      errorCode === "ROOT_EXPANSION" || errorCode === "SUBJECT_MISMATCH") return "denied_path";
  return "runtime_unavailable";
}

/**
 * 4.1.3 — narrow registry port the focused-resource resolver consumes.
 * Structurally satisfied by `InMemoryRelayRegistry`; declared as a port so
 * the server-side resolver (`packages/server/.../focused-resources.ts`) does
 * not depend on the full runtime registry surface.
 */
interface FocusedResourceRelayRegistry {
  snapshotForFocusedResource(
    relayId: string,
    actorId: string,
  ): FocusedResourceRelaySnapshot | null;
}

/**
 * input passed to the `onUnregister` hook. Captured from the
 * registry entry BEFORE it is deleted so the callback can fail-closed
 * any server-side state bound to that relay (e.g. invalidate a Full
 * Workstation session). `desktopSessionId` is `null` for a headless
 * relay that never advertised one.
 */
export interface InMemoryRelayRegistryUnregisterInput {
  readonly relayId: string;
  readonly userId: string;
  readonly desktopSessionId: string | null;
}

/**
 * a server-private snapshot of a live relay whose validated
 * pairing-generation is being revoked. This is intentionally a narrow
 * lifecycle view: callers can invalidate authority and ask the websocket
 * endpoint to close this exact live relay, but do not receive capabilities,
 * send functions, or any token material.
 */
export interface LiveRelayPairingGenerationSnapshot {
  readonly relayId: string;
  readonly userId: string;
  readonly desktopSessionId: string | null;
  readonly pairingGeneration: string;
}

/**
 * input passed to the `onDesktopSessionReplaced` hook. Captured
 * when a register call replaces an existing entry for the SAME
 * `(relayId, userId)` with a DIFFERENT non-empty `desktopSessionId`.
 * `previousDesktopSessionId` is the dead main-process-launch identity;
 * `nextDesktopSessionId` is the one the relay is registering with now.
 */
export interface InMemoryRelayRegistryDesktopSessionReplacedInput {
  readonly relayId: string;
  readonly userId: string;
  readonly previousDesktopSessionId: string;
  readonly nextDesktopSessionId: string;
}

/**
 * input passed to the `onPairingGenerationChanged` hook.
 * Captured when a register call replaces an existing entry for the SAME
 * `(relayId, userId)` with the SAME non-empty `desktopSessionId` but a
 * DIFFERENT non-empty `pairingGeneration`. This is the explicit re-pair
 * signal: the server-validated relay-token row id changed while the
 * desktop session identity stayed stable, so any Full Workstation session
 * + dispatch plans bound to the prior pairing generation are now stale and
 * must be invalidated. `previousPairingGeneration` is the dead generation;
 * `nextPairingGeneration` is the one the relay is registering with now.
 */
export interface InMemoryRelayRegistryPairingGenerationChangedInput {
  readonly relayId: string;
  readonly userId: string;
  readonly desktopSessionId: string;
  readonly previousPairingGeneration: string;
  readonly nextPairingGeneration: string;
}

/**
 * reconnect/session split-brain fix — input passed to the
 * `onWorkstationProfileSnapshotCleared` hook. Captured when a register or
 * `updateCapabilities` transition causes a desktop relay's advisory
 * Workstation Profile binding snapshot to go from PRESENT to ABSENT
 * (cleared or omitted) for an entry that previously carried one. The input
 * carries the EXISTING entry's binding identity (the one a live Full
 * Workstation session could be bound to), so production can invalidate any
 * matching session + dispatch plans: a session must never survive the loss
 * of its relay's profile binding snapshot, or the no-plan `run_shell` gate
 * would skip and dispatch an unbound generic shell under an active session.
 */
export interface InMemoryRelayRegistryWorkstationProfileSnapshotClearedInput {
  readonly relayId: string;
  readonly userId: string;
  readonly desktopSessionId: string;
  /**
   * The EXISTING entry's server-derived pairing generation (the one the
   * prior session was bound to), when the entry carried one. Production
   * may pin invalidation to it so a session already re-activated under a
   * new generation is not touched.
   */
  readonly pairingGeneration?: string;
}

/**
 * reconnect/session split-brain fix — minimal structural view of an
 * active Full Workstation session that the relay registry exposes to the
 * agent tools node (via the injected `getActiveWorkstationSession` lookup)
 * so the no-plan `run_shell` gate can fail closed for an active session
 * even when the selected relay's profile snapshot is absent. Only the
 * binding fields the tools node compares against the selected relay are
 * exposed; the runtime session registry is the authority and is injected
 * at construction so this module never imports the session registry.
 */
export interface RelayActiveWorkstationSessionView {
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly capabilityRevision: number;
}

/**
 * registry construction options. All fields optional; the
 * earlier `new InMemoryRelayRegistry` call site stays valid.
 */
export interface InMemoryRelayRegistryOptions {
  /** Fresh execution-time RBAC check for an exact semantic desktop dispatch. */
  readonly authorizeDesktopAutomationDispatch?: ((input: {
    readonly userId: string;
    readonly agentId: string;
    /** Opaque admitted Computer Use catalogue key; not a routing allowlist. */
    readonly toolName: string;
  }) => boolean | Promise<boolean>) | undefined;
  /**
   * bounded receipt grace after a raw shell's command deadline or
   * forwarded cancel. Production uses the 5s default; the override exists
   * solely to keep registry timing tests deterministic and cannot exceed 10s.
   */
  readonly runShellResultReceiptGraceMs?: number | undefined;
  /** Bounded wait for Electron's canonical Computer Use or Browser mutation receipt after cancel/timeout. */
  readonly desktopAutomationResultReceiptGraceMs?: number | undefined;
  /**
   * invoked after a relay's remotely-projectable presence changes:
   * after registration has replaced the entry, after an accepted capability
   * replacement, and after unregister has deleted it. It deliberately does
   * not run for heartbeats. The snapshots are detached copies, and duplicate
   * live relays sharing one pairing generation are reported separately so a
   * server projector can fail closed instead of silently choosing one.
   *
   * This is a best-effort publication seam. A callback failure is swallowed
   * and never changes relay liveness or prevents existing invalidation hooks.
   */
  readonly onRemotePresenceChanged?:
    | ((input: InMemoryRelayRegistryRemotePresenceChangedInput) => void)
    | undefined;
  /**
   * Invoked synchronously on every relay unregister path (explicit
   * `relay:disconnect`, socket close, and the heartbeat-timeout
   * `sweepStale` sweep) with the entry's `(relayId, userId,
   * desktopSessionId)` captured before deletion. This is the fail-closed
   * seam that lets the server invalidate a Full Workstation session the
   * instant its bound relay disappears — covering re-pair / disconnect /
   * silent heartbeat loss uniformly. The callback MUST NOT throw: it
   * runs inline on the unregister path and a thrown error surfaces to
   * the caller. Keep it side-effect-bounded (e.g. a registry invalidate
   * + audit write that swallows its own errors).
   */
  readonly onUnregister?:
    | ((input: InMemoryRelayRegistryUnregisterInput) => void)
    | undefined;
  /**
   * invoked synchronously during `register` when an existing entry
   * for the same `(relayId, userId)` is about to be replaced by one
   * carrying a DIFFERENT non-empty `desktopSessionId`. This is the
   * app-restart signal: a desktop relay's main-process-launch identity
   * changes on every Electron main-process launch, so a re-register with
   * a new `desktopSessionId` means the prior Full Workstation session is
   * now bound to a dead desktop session. Production wires this to
   * `InMemoryWorkstationSessionRegistry.invalidateForRelayBinding` against
   * the previous `(userId, serverBindingId, relayId, desktopSessionId)`.
   *
   * It is deliberately NOT fired on a transient socket disconnect or a
   * reconnect that re-uses the same `desktopSessionId` — those resume the
   * existing session. Nor is it fired on an explicit unregister (the
   * `onUnregister` hook is the separate fail-closed seam for that path,
   * and production intentionally does NOT wire `onUnregister` to session
   * invalidation so transient disconnects preserve the session). The
   * callback MUST NOT throw: it runs inline on the register path and a
   * thrown error would otherwise surface to the caller.
   */
  readonly onDesktopSessionReplaced?:
    | ((input: InMemoryRelayRegistryDesktopSessionReplacedInput) => void)
    | undefined;
  /**
   * invoked synchronously during `register` when an existing
   * entry for the same `(relayId, userId)` is about to be replaced by one
   * carrying the SAME non-empty `desktopSessionId` but a DIFFERENT non-empty
   * `pairingGeneration`. This is the explicit re-pair signal: the
   * server-derived pairing generation (the validated relay-token row id)
   * changed while the desktop session identity stayed stable, so prior Full
   * Workstation sessions + dispatch plans bound to the old generation are
   * stale. Production wires this to
   * `InMemoryWorkstationSessionRegistry.invalidateForRelayBinding` +
   * `InMemoryWorkstationDispatchPlanRegistry.invalidateForBinding` against
   * the (userId, relayId, desktopSessionId) — the pairing-generation change
   * invalidates matching active sessions/plans even when desktopSessionId is
   * reused.
   *
   * It is deliberately NOT fired when the desktopSessionId also differs
   * (the `onDesktopSessionReplaced` hook already invalidates the prior
   * session by the dead desktop session id), nor on an explicit unregister
   * (the `onUnregister` hook is the separate fail-closed seam for that
   * path), nor on a transient reconnect that re-uses both ids. The callback
   * MUST NOT throw: it runs inline on the register path and a thrown error
   * would otherwise surface to the caller.
   */
  readonly onPairingGenerationChanged?:
    | ((input: InMemoryRelayRegistryPairingGenerationChangedInput) => void)
    | undefined;
  /**
   * reconnect/session split-brain fix — invoked synchronously during
   * `register` or `updateCapabilities` when a desktop relay's advisory
   * Workstation Profile binding snapshot transitions from PRESENT to ABSENT
   * (cleared or omitted) for an entry that previously carried one. This is
   * the fail-closed seam that lets the server invalidate a Full Workstation
   * session the instant its relay loses the profile binding snapshot —
   * covering reconnect-with-frozen-caps, profile deactivation, a transient
   * controller unavailability during a capability refresh, and a headless
   * re-register of a previously-desktop relay uniformly. Without it, an
   * active session would survive a null snapshot and the no-plan
   * `run_shell` gate would skip, dispatching an unbound generic shell.
   *
   * It is deliberately narrow: it fires ONLY on a present→absent
   * transition for an entry that had a non-empty `desktopSessionId` (a
   * headless relay can never host a Full Workstation session). A
   * present→present snapshot change (revision/profile id drift) is handled
   * by the activation route + plan re-validation, not here. The callback
   * MUST NOT throw: it runs inline on the register/update path and a
   * thrown error would otherwise surface to the caller.
   */
  readonly onWorkstationProfileSnapshotCleared?:
    | ((input: InMemoryRelayRegistryWorkstationProfileSnapshotClearedInput) => void)
    | undefined;
  /**
   * reconnect/session split-brain fix — lookup the LIVE active Full
   * Workstation session for a user, exposed to the agent tools node so the
   * no-plan `run_shell` gate can fail closed for an active session even
   * when the selected relay's profile snapshot is absent (defense in depth
   * behind the snapshot-cleared invalidation seam). Returns `null` when no
   * session is active. Production wires this to
   * `InMemoryWorkstationSessionRegistry.get`; the relay registry itself
   * never owns session state.
   */
  readonly getActiveWorkstationSession?:
    | ((userId: string) => RelayActiveWorkstationSessionView | null)
    | undefined;
  /** testable bound for one exact ACP turn's retained/subscriber events. */
  readonly acpEventQueueMaxEntries?: number | undefined;
  /** byte bound includes queued and handed-but-unacknowledged events. */
  readonly acpEventQueueMaxBytes?: number | undefined;
  /** global active-turn bound; active turns are never silently evicted. */
  readonly acpMaxTurns?: number | undefined;
}

/**
 * Server-private identity of one currently live, authenticated desktop relay
 * socket. This is deliberately capability-neutral: consumers may use it as
 * the trusted topology input for a new desktop admission path, but it exposes
 * neither relay capabilities nor the raw pairing generation.
 */
export interface RelayAuthenticatedDesktopSessionSnapshot {
  readonly relayId: string;
  readonly userId: string;
  readonly relaySessionId: string;
  readonly pairingGenerationRef: string;
  readonly desktopSessionId: string;
  /** Exact negotiated relay version. Codex is a v8+ protocol family, not a
   * permanently v8 socket, so every correlated scope must echo this value. */
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
}

/** Authenticated v8 state exposed to Codex admission code, never to browsers. */
export interface RelayCodexSessionSnapshot extends RelayAuthenticatedDesktopSessionSnapshot {
  readonly status: CodexHostStatus | null;
}

export type RelayCodexRouteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "CODEX_RELAY_UNAVAILABLE" | "CODEX_CONTEXT_INVALID" | "CODEX_CONTEXT_STALE" | "CODEX_CORRELATION_REPLAY" };

export interface RelayAcpSessionSnapshot {
  readonly relayId: string;
  readonly userId: string;
  readonly relaySessionId: string;
  readonly pairingGenerationRef: string;
  readonly desktopSessionId: string;
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
}

/** Exact v17 route context a future Claude controller may observe, never account facts. */
export type RelayClaudeConnectionContextSnapshot = RelayAuthenticatedDesktopSessionSnapshot;

export type RelayAcpRouteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "ACP_RELAY_UNAVAILABLE" | "ACP_CONTEXT_STALE" | "ACP_CORRELATION_REPLAY" | "ACP_EVENT_OUT_OF_ORDER" | "ACP_BACKPRESSURE" | "ACP_TERMINAL_FENCED" };

export type RelayClaudeConnectionRouteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "CLAUDE_CONNECTION_UNAVAILABLE" | "CLAUDE_CONNECTION_CONTEXT_STALE" | "CLAUDE_CONNECTION_CORRELATION_REPLAY" };

/** thin current-socket Claude execution, never a durable broker. */
export type RelayClaudeExecutionOpenResult =
  | Readonly<{
      ok: false;
      error:
        | "CLAUDE_EXECUTION_INVALID"
        | "CLAUDE_EXECUTION_UNAVAILABLE"
        | "CLAUDE_EXECUTION_CONTEXT_STALE"
        | "CLAUDE_EXECUTION_BUSY";
    }>
  | Readonly<{ ok: true; control: RelayClaudeExecutionControl }>;

export type RelayClaudeExecutionRouteResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      error:
        | "CLAUDE_EXECUTION_UNAVAILABLE"
        | "CLAUDE_EXECUTION_CONTEXT_STALE"
        | "CLAUDE_EXECUTION_PROTOCOL_INVALID";
    }>;

export interface RelayClaudeExecutionControl {
  readonly executionRef: string;
  next(): Promise<RelayClaudeExecutionEvent | null>;
  respond(interactionRef: string, response: RelayClaudeExecutionResponse): Promise<"accepted" | "rejected">;
  steer(prompt: string): Promise<"accepted">;
  interrupt(): Promise<"acknowledged" | "uncertain">;
}

// Entries only: the v18 relay parser already caps every admitted frame at
// 128KiB, so this remains a <=4MiB transient buffer without a byte ledger.
type ClaudeExecutionNextWaiter = {
  readonly resolve: (event: RelayClaudeExecutionEvent | null) => void;
  readonly reject: (error: Error) => void;
};

type ClaudeExecutionResponseWaiter = {
  readonly interactionRef: string;
  readonly resolve: (outcome: "accepted" | "rejected") => void;
  readonly reject: (error: Error) => void;
  readonly promise: Promise<"accepted" | "rejected">;
};

type ClaudeExecutionInterruptWaiter = {
  readonly resolve: (outcome: "acknowledged" | "uncertain") => void;
  readonly reject: (error: Error) => void;
  readonly promise: Promise<"acknowledged" | "uncertain">;
  receiptReceived: boolean;
};

type ClaudeExecutionSteerWaiter = {
  readonly steerRef: string;
  readonly resolve: (outcome: "accepted") => void;
  readonly reject: (error: Error) => void;
  readonly promise: Promise<"accepted">;
};

type ActiveClaudeExecution = {
  readonly relayId: string;
  readonly userId: string;
  readonly connectionGeneration: number;
  readonly scope: RelayClaudeExecutionSocketScope;
  readonly executionRef: string;
  readonly queue: RelayClaudeExecutionEvent[];
  firstEvent: boolean;
  streamClosed: boolean;
  streamError: Error | null;
  overflowed: boolean;
  interactionRef: string | null;
  interactionDelivered: boolean;
  nextWaiter: ClaudeExecutionNextWaiter | null;
  responseWaiter: ClaudeExecutionResponseWaiter | null;
  interruptWaiter: ClaudeExecutionInterruptWaiter | null;
  steerWaiter: ClaudeExecutionSteerWaiter | null;
};

type PendingAcpReadiness = {
  /** Stored separately from its opaque key so lifecycle cleanup cannot parse keys. */
  readonly relayId: string;
  readonly scope: AcpSocketScope;
  readonly command: RelayAcpReadinessCommand;
  readonly fingerprint: string;
  readonly resolve: (state: AcpReadinessState) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly promise: Promise<AcpReadinessState>;
};

type PendingAcpPrepare = {
  readonly relayId: string;
  readonly command: RelayAcpPrepareCommand;
  readonly fingerprint: string;
  readonly resolve: (workspace: AcpWorkspaceReceipt) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly promise: Promise<AcpWorkspaceReceipt>;
};

type PreparedAcpExecution = {
  readonly relayId: string;
  readonly registrationId: AcpRegistrationId;
  readonly scope: AcpExecutionScope;
  readonly expiresAt: number;
};

type PendingAcpStart = {
  readonly relayId: string;
  readonly command: RelayAcpStartCommand;
  readonly fingerprint: string;
  readonly resolve: (started: RelayAcpStartedResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly promise: Promise<RelayAcpStartedResult>;
};

type PendingClaudeConnectionDiscovery = {
  readonly relayId: string;
  readonly command: RelayClaudeConnectionDiscoverCommand;
  readonly fingerprint: string;
  readonly resolve: (result: RelayClaudeConnectionDiscoveryResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly promise: Promise<RelayClaudeConnectionDiscoveryResult>;
};

/** Internal-only rejection detail; public callers receive the stable code. */
class AcpStartFailedError extends Error {
  readonly acpStartFailureStage: AcpStartFailureStage;

  constructor(stage: AcpStartFailureStage) {
    super("ACP_START_FAILED");
    this.name = "AcpStartFailedError";
    this.acpStartFailureStage = stage;
  }
}

export type RelayAcpExecutionEvent = RelayAcpSemanticEvent | RelayAcpTerminalEvent;

export interface RelayAcpExecutionSubscription {
  /** Delivers exactly one item; acknowledgement keeps backpressure bounded. */
  next(): Promise<RelayAcpExecutionEvent | null>;
  acknowledge(eventId: string, eventSequence: number): void;
  close(): void;
}

type AcpSubscriber = {
  readonly queue: RelayAcpExecutionEvent[];
  readonly inFlight: Map<string, RelayAcpExecutionEvent>;
  queuedBytes: number;
  inFlightBytes: number;
  waiter: ((event: RelayAcpExecutionEvent | null) => void) | null;
  nextPending: boolean;
  terminalDelivered: boolean;
  closed: boolean;
};

type AcpTurnBroker = {
  readonly key: string;
  readonly relayId: string;
  readonly registrationId: AcpRegistrationId;
  readonly scope: AcpExecutionScope;
  readonly process: AcpProcessScope;
  readonly capabilities: RelayAcpStartedResult["capabilities"];
  lastSequence: number;
  terminal: RelayAcpTerminalEvent | null;
  readonly retained: RelayAcpExecutionEvent[];
  retainedBytes: number;
  readonly subscribers: Set<AcpSubscriber>;
  readonly startedEventId: string;
  subscriberAttached: boolean;
  faultRetentionTimer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * In-memory relay registry — tracks connected relays, routes tool dispatches,
 * and monitors heartbeat presence.
 *
 * The registry never touches WebSockets directly. Each relay's `send` callback
 * is injected by the server endpoint during registration.
 */
export class InMemoryRelayRegistry implements FocusedResourceRelayRegistry {
  private relays = new Map<string, RelayEntry>();
  private nextRelayConnectionGeneration = 1;
  private pending = new Map<string, PendingDispatch>();
  private pendingMcpPreflights = new Map<string, PendingMcpPreflight>();
  private pendingMcpConfigures = new Map<string, PendingMcpConfigure>();
  private pendingSshPrepares = new Map<string, PendingSshPrepare>();
  /** V8-only replay state is intentionally distinct from tool dispatch IDs. */
  private codexReplay = new Map<string, CodexReplayEntry>();
  private codexEventSequences = new Map<string, CodexReplayEntry>();
  private pendingCodexCommands = new Map<string, PendingCodexCommand>();
  private codexCommandOutcomes = new Map<string, CodexCommandOutcome>();
  private codexTurnOutcomes = new Map<string, CodexReplayEntry>();
  private codexListeners = new Set<(relayId: string, message: RelayCodexClientMessage) => void>();
  /**
   * Private server-side observers for the canonical lifecycle seam that
   * invalidates all Codex state associated with one relay context. This is
   * intentionally separate from accepted relay frames: consumers use it to
   * fail closed when a relay disconnects or its authenticated context changes.
   */
  private codexContextInvalidationListeners = new Set<
    (relayId: string, errorCode: string) => void
  >();
  private claudeConnectionContextListeners = new Set<
    (relayId: string, userId: string, context: RelayClaudeConnectionContextSnapshot | null) => void
  >();
  /** Only contexts explicitly published after endpoint acknowledgement are observable. */
  private publishedClaudeConnectionContexts = new Map<string, RelayClaudeConnectionContextSnapshot>();
  private pendingAcpReadiness = new Map<string, PendingAcpReadiness>();
  private pendingAcpPrepares = new Map<string, PendingAcpPrepare>();
  private preparedAcpExecutions = new Map<string, PreparedAcpExecution>();
  private pendingAcpStarts = new Map<string, PendingAcpStart>();
  private pendingClaudeConnectionDiscoveries = new Map<string, PendingClaudeConnectionDiscovery>();
  /** One non-durable current-socket execution lane per Desktop relay. */
  private activeClaudeExecutions = new Map<string, ActiveClaudeExecution>();
  private acpTurns = new Map<string, AcpTurnBroker>();
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onUnregister:
    | ((input: InMemoryRelayRegistryUnregisterInput) => void)
    | undefined;
  private readonly onRemotePresenceChanged:
    | ((input: InMemoryRelayRegistryRemotePresenceChangedInput) => void)
    | undefined;
  private readonly onDesktopSessionReplaced:
    | ((input: InMemoryRelayRegistryDesktopSessionReplacedInput) => void)
    | undefined;
  private readonly onPairingGenerationChanged:
    | ((input: InMemoryRelayRegistryPairingGenerationChangedInput) => void)
    | undefined;
  private readonly onWorkstationProfileSnapshotCleared:
    | ((input: InMemoryRelayRegistryWorkstationProfileSnapshotClearedInput) => void)
    | undefined;
  private readonly getActiveWorkstationSessionFn:
    | ((userId: string) => RelayActiveWorkstationSessionView | null)
    | undefined;
  private readonly runShellResultReceiptGraceMs: number;
  private readonly acpEventQueueMaxEntries: number;
  private readonly acpEventQueueMaxBytes: number;
  private readonly acpMaxTurns: number;
  private readonly desktopAutomationResultReceiptGraceMs: number;
  private readonly authorizeDesktopAutomationDispatch:
    | NonNullable<InMemoryRelayRegistryOptions["authorizeDesktopAutomationDispatch"]>
    | undefined;

  constructor(options: InMemoryRelayRegistryOptions = {}) {
    this.onRemotePresenceChanged = options.onRemotePresenceChanged;
    this.onUnregister = options.onUnregister;
    this.onDesktopSessionReplaced = options.onDesktopSessionReplaced;
    this.onPairingGenerationChanged = options.onPairingGenerationChanged;
    this.onWorkstationProfileSnapshotCleared =
      options.onWorkstationProfileSnapshotCleared;
    this.getActiveWorkstationSessionFn = options.getActiveWorkstationSession;
    this.authorizeDesktopAutomationDispatch = options.authorizeDesktopAutomationDispatch;
    const configuredGrace = options.runShellResultReceiptGraceMs;
    this.runShellResultReceiptGraceMs =
      Number.isSafeInteger(configuredGrace) && configuredGrace !== undefined && configuredGrace >= 0
        ? Math.min(configuredGrace, RUN_SHELL_RESULT_RECEIPT_GRACE_MAX_MS)
        : RUN_SHELL_RESULT_RECEIPT_GRACE_MS;
    this.acpEventQueueMaxEntries = boundedAcpLimit(options.acpEventQueueMaxEntries, 128, 1, CODEX_RELAY_MAX_REPLAY_ENTRIES);
    this.acpEventQueueMaxBytes = boundedAcpLimit(options.acpEventQueueMaxBytes, 1024 * 1024, 1024, 4 * 1024 * 1024);
    this.acpMaxTurns = boundedAcpLimit(options.acpMaxTurns, CODEX_RELAY_MAX_REPLAY_ENTRIES, 1, CODEX_RELAY_MAX_REPLAY_ENTRIES);
    const configuredDesktopGrace = options.desktopAutomationResultReceiptGraceMs;
    this.desktopAutomationResultReceiptGraceMs =
      Number.isSafeInteger(configuredDesktopGrace) && configuredDesktopGrace !== undefined && configuredDesktopGrace >= 0
        ? Math.min(configuredDesktopGrace, DESKTOP_AUTOMATION_RESULT_RECEIPT_GRACE_MAX_MS)
        : DESKTOP_AUTOMATION_RESULT_RECEIPT_GRACE_MS;
  }

  private expirePendingDispatch(
    correlationId: string,
    pending: PendingDispatch,
    reason: RelayDispatchOutcomeUnknownError["reason"],
    fallback: string,
  ): void {
    if (this.pending.get(correlationId) !== pending) return;
    this.pending.delete(correlationId);
    this.detachPendingAbort(pending);
    pending.reject(pendingDispatchError(pending, reason, fallback));
  }

  private rejectPendingDispatchesForRelay(
    relayId: string,
    reason: RelayDispatchOutcomeUnknownError["reason"],
    fallback: string,
    connectionGeneration?: number,
  ): void {
    for (const [correlationId, pending] of this.pending) {
      if (
        !correlationId.startsWith(relayId + ":") ||
        (connectionGeneration !== undefined && pending.connectionGeneration !== connectionGeneration)
      ) {
        continue;
      }
      clearTimeout(pending.timer);
      this.detachPendingAbort(pending);
      pending.reject(pendingDispatchError(pending, reason, fallback));
      this.pending.delete(correlationId);
    }
  }

  /**
   * A replacement retains the old authenticated socket just long enough to
   * issue best-effort cancellation for dispatched raw shell and security scanner
   * work on that exact old connection generation. Other relay tools retain
   * their existing replacement behavior.
   */
  private cancelRawRunShellDispatchesForReplacement(
    relayId: string,
    connectionGeneration: number,
  ): void {
    for (const [correlationId, pending] of this.pending) {
      if (
        !correlationId.startsWith(relayId + ":") ||
        pending.connectionGeneration !== connectionGeneration ||
        (!pending.realWorkstationRawRunShell && pending.toolName !== "security_scan") ||
        !pending.dispatched
      ) continue;
      this.cancelDispatch(correlationId);
    }
  }

  private detachPendingAbort(pending: PendingDispatch): void {
    if (pending.abortSignal && pending.abortListener) {
      pending.abortSignal.removeEventListener("abort", pending.abortListener);
    }
  }

  private rejectPendingMcpForRelay(
    relayId: string,
    code: RelayMcpTruthErrorCode,
    connectionGeneration?: number,
  ): void {
    for (const [key, pending] of this.pendingMcpPreflights) {
      if (pending.relayId !== relayId ||
        (connectionGeneration !== undefined && pending.connectionGeneration !== connectionGeneration)) continue;
      clearTimeout(pending.timer);
      pending.reject(new RelayMcpTruthError(code));
      this.pendingMcpPreflights.delete(key);
    }
    for (const [key, pending] of this.pendingMcpConfigures) {
      if (pending.relayId !== relayId ||
        (connectionGeneration !== undefined && pending.connectionGeneration !== connectionGeneration)) continue;
      clearTimeout(pending.timer);
      pending.reject(new RelayMcpTruthError(code));
      this.pendingMcpConfigures.delete(key);
    }
  }

  private rejectPendingSshForRelay(
    relayId: string,
    code: RelaySshPrepareErrorCode,
    connectionGeneration?: number,
  ): void {
    for (const [key, pending] of this.pendingSshPrepares) {
      if (pending.relayId !== relayId ||
        (connectionGeneration !== undefined && pending.connectionGeneration !== connectionGeneration)) continue;
      clearTimeout(pending.timer);
      pending.reject(new RelaySshPrepareError(code));
      this.pendingSshPrepares.delete(key);
    }
  }

  private notifyRemotePresenceChanged(
    relayId: string,
    previous: RemotePresenceRelaySnapshot | null,
    current: RemotePresenceRelaySnapshot | null,
  ): void {
    if (!this.onRemotePresenceChanged) return;
    try {
      this.onRemotePresenceChanged({ relayId, previous, current });
    } catch {
      // Presence projection is observability/discovery only. A publisher must
      // never make a registered relay disappear or block disconnect cleanup.
    }
  }

  start(): void {
    this.presenceTimer = setInterval(() => this.sweepStale(), HEARTBEAT_TIMEOUT_MS);
  }

  stop(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(pendingDispatchError(p, "shutdown", "Registry shutting down"));
    }
    this.pending.clear();
    for (const pending of this.pendingMcpPreflights.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RelayMcpTruthError("relay_disconnected"));
    }
    this.pendingMcpPreflights.clear();
    for (const pending of this.pendingMcpConfigures.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RelayMcpTruthError("relay_disconnected"));
    }
    this.pendingMcpConfigures.clear();
    for (const pending of this.pendingSshPrepares.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RelaySshPrepareError("relay_disconnected"));
    }
    this.pendingSshPrepares.clear();
    for (const pending of this.pendingCodexCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CODEX_RELAY_UNAVAILABLE"));
    }
    this.pendingCodexCommands.clear();
    for (const pending of this.pendingClaudeConnectionDiscoveries.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CLAUDE_CONNECTION_UNAVAILABLE"));
    }
    this.pendingClaudeConnectionDiscoveries.clear();
    for (const relayId of this.activeClaudeExecutions.keys()) {
      this.clearClaudeExecutionState(relayId, "CLAUDE_EXECUTION_UNAVAILABLE");
    }
    this.codexReplay.clear();
    this.codexEventSequences.clear();
    this.codexCommandOutcomes.clear();
    this.codexTurnOutcomes.clear();
    this.publishedClaudeConnectionContexts.clear();
    this.relays.clear();
  }

  register(
    relayId: string,
    userId: string,
    capabilities: RelayCapabilities,
    send: RelaySendFn,
    protocolVersion = 1,
    desktopSessionId?: string,
    capabilityRevision?: number,
    /**
     * server-derived `pairingGeneration` stamped from the
     * validated relay-token row id by the relay endpoint. NEVER accepted
     * from the relay/client payload. Optional only for earlier
     * call sites; the binding provider treats a missing/empty value as
     * ineligible so a Full Workstation session cannot bind to a relay that
     * never proved a pairing generation.
     */
    pairingGeneration?: string,
  ): Promise<void> {
    const {
      capabilities: capabilitiesToStore,
      snapshot,
      profileSnapshot,
      desktopAutomationSnapshot,
    } =
      sanitizeAdvisorySnapshots(capabilities, protocolVersion);
    // app-restart desktop-session invalidation. When the SAME
    // `(relayId, userId)` re-registers with a DIFFERENT non-empty
    // `desktopSessionId`, the prior Full Workstation session is bound to a
    // dead desktop session. Emit the narrow replacement hook BEFORE the
    // entry is overwritten so production can invalidate the matching old
    // session. Transient disconnects / reconnects that re-use the same
    // `desktopSessionId` never reach here, and an explicit unregister does
    // NOT invalidate (the `onUnregister` hook is intentionally not wired to
    // invalidation in production, to preserve transient reconnect semantics).
    const existing = this.relays.get(relayId);
    if (existing !== undefined) {
      this.invalidatePublishedClaudeConnectionContext(relayId, existing.userId);
      this.clearCodexState(relayId, "CODEX_CONTEXT_STALE");
      this.clearClaudeConnectionState(relayId, "CLAUDE_CONNECTION_CONTEXT_STALE");
      this.clearClaudeExecutionState(relayId, "CLAUDE_EXECUTION_CONTEXT_STALE");
    }
    const previousRemotePresence = existing ? snapshotRemotePresence(existing) : null;
    if (existing !== undefined && existing.userId === userId) {
      const previousDesktopSessionId = existing.desktopSessionId;
      const previousPairingGeneration = existing.pairingGeneration;
      const desktopChanged =
        previousDesktopSessionId !== undefined &&
        previousDesktopSessionId !== "" &&
        desktopSessionId !== undefined &&
        desktopSessionId !== "" &&
        previousDesktopSessionId !== desktopSessionId;
      if (desktopChanged && this.onDesktopSessionReplaced) {
        try {
          this.onDesktopSessionReplaced({
            relayId,
            userId,
            previousDesktopSessionId,
            nextDesktopSessionId: desktopSessionId,
          });
        } catch {
          // Swallow — a callback error must never block registration.
        }
      } else if (
        !desktopChanged &&
        this.onPairingGenerationChanged &&
        previousDesktopSessionId !== undefined &&
        previousDesktopSessionId !== "" &&
        desktopSessionId !== undefined &&
        desktopSessionId !== "" &&
        previousDesktopSessionId === desktopSessionId &&
        previousPairingGeneration !== undefined &&
        previousPairingGeneration !== "" &&
        pairingGeneration !== undefined &&
        pairingGeneration !== "" &&
        previousPairingGeneration !== pairingGeneration
      ) {
        // explicit re-pair: the same relay/user re-registered
        // with the SAME desktopSessionId but a DIFFERENT server-derived
        // pairingGeneration. Invalidate bound Full Workstation sessions +
        // plans even though desktopSessionId is reused.
        try {
          this.onPairingGenerationChanged({
            relayId,
            userId,
            desktopSessionId: desktopSessionId,
            previousPairingGeneration: previousPairingGeneration,
            nextPairingGeneration: pairingGeneration,
          });
        } catch {
          // Swallow — a callback error must never block registration.
        }
      }
      // reconnect/session split-brain fix — fail-closed snapshot-loss
      // seam. When the prior entry carried an advisory Workstation Profile
      // binding snapshot AND a non-empty desktopSessionId (so a Full
      // Workstation session could be live against it) and this register
      // carries NO profile snapshot, the snapshot just transitioned
      // present→absent. Fire the cleared hook against the EXISTING binding
      // identity so production invalidates any matching session + plans
      // BEFORE the entry is overwritten. A session must never survive the
      // loss of its relay's profile binding snapshot, or the no-plan
      // `run_shell` gate would skip and dispatch an unbound generic shell
      // under an active session. present→present and absent→* never fire.
      if (
        this.onWorkstationProfileSnapshotCleared &&
        existing.workstationProfileSnapshot !== undefined &&
        profileSnapshot === undefined &&
        previousDesktopSessionId !== undefined &&
        previousDesktopSessionId !== ""
      ) {
        try {
          this.onWorkstationProfileSnapshotCleared({
            relayId,
            userId,
            desktopSessionId: previousDesktopSessionId,
            ...(previousPairingGeneration !== undefined && previousPairingGeneration !== ""
              ? { pairingGeneration: previousPairingGeneration }
              : {}),
          });
        } catch {
          // Swallow — a callback error must never block registration.
        }
      }
    }
    if (existing !== undefined) {
      // Desktop/pairing lifecycle callbacks above invalidate the exact
      // activation first. While the old authenticated socket is still
      // installed, cancel only its pending uncontained raw shells, then apply
      // the existing replacement result fence to all old-generation work.
      this.cancelRawRunShellDispatchesForReplacement(
        relayId,
        existing.connectionGeneration,
      );
      // A replacement socket cannot return the old socket's canonical receipt.
      // Once an effectful frame crossed the former send seam, fail with its
      // stable unknown-effect disposition instead of leaving it to time out.
      this.rejectPendingDispatchesForRelay(
        relayId,
        "replacement",
        `Relay ${relayId} was replaced during dispatch`,
        existing.connectionGeneration,
      );
      // The send callback is the authenticated socket-generation boundary.
      // A replacement registration must never inherit a prior socket's MCP
      // acknowledgement promise, even when both sockets use the same relay id.
      this.rejectPendingMcpForRelay(relayId, "relay_replaced", existing.connectionGeneration);
      this.rejectPendingSshForRelay(relayId, "relay_replaced", existing.connectionGeneration);
    }
    // The v8+ authenticated socket topology is shared by Codex and future
    // server-private desktop admission paths. Capability-specific consumers
    // must apply their own stricter gate before using it.
    const supportsAuthenticatedDesktopSession = protocolVersion >= CODEX_RELAY_PROTOCOL_VERSION;
    const relaySessionId = supportsAuthenticatedDesktopSession ? randomUUID() : undefined;
    // The reference deliberately does not reveal the validated token row id.
    // Production registration always supplies pairingGeneration from the token.
    // Base64url digests can start with '-' or '_'; signed Desktop authority
    // stores require an alphanumeric-leading opaque ID. Namespace the complete
    // digest, preserving its entropy and exact pairing identity across reconnects.
    const pairingGenerationRef = supportsAuthenticatedDesktopSession && pairingGeneration
      ? `pairing-${createHash("sha256").update(`nautilo-relay-v8:${pairingGeneration}`).digest("base64url")}`
      : undefined;
    this.relays.set(relayId, {
      relayId,
      connectionGeneration: this.nextRelayConnectionGeneration++,
      userId,
      capabilities: copyRelayCapabilities(capabilitiesToStore),
      protocolVersion,
      ...(desktopSessionId !== undefined ? { desktopSessionId } : {}),
      capabilityRevision: capabilityRevision ?? 0,
      desktopFilesystemGrantSnapshot: snapshot ? structuredClone(snapshot) : undefined,
      desktopAutomationSnapshot: desktopAutomationSnapshot
        ? structuredClone(desktopAutomationSnapshot)
        : undefined,
      workstationProfileSnapshot: profileSnapshot ? structuredClone(profileSnapshot) : undefined,
      ...(pairingGeneration !== undefined && pairingGeneration !== ""
        ? { pairingGeneration }
        : {}),
      ...(relaySessionId !== undefined ? { relaySessionId } : {}),
      ...(pairingGenerationRef !== undefined ? { pairingGenerationRef } : {}),
      lastSeen: Date.now(),
      send,
    });
    // notify only after the new entry is fully visible to consumers.
    // A re-register carries both snapshots; a first registration has null
    // previous. If either side lacks a server-derived pairing generation, it
    // remains null and the projector fails closed rather than guessing.
    this.notifyRemotePresenceChanged(
      relayId,
      previousRemotePresence,
      snapshotRemotePresence(this.relays.get(relayId)!),
    );
    return Promise.resolve();
  }

  /**
   * protocol v7 — atomically replace a connected desktop relay's full
   * advertised capability state. Accepts updates ONLY for the registered
   * authenticated relay/user, requires an exact `desktopSessionId` match,
   * strictly parses the full capabilities (including the grant snapshot),
   * rejects stale/duplicate revisions, and atomically replaces capabilities
   * and the advisory snapshot. A malformed update leaves the old state
   * intact; a narrower or empty snapshot applies immediately. Returns
   * `{ok:true}` on apply or `{ok:false,error}` so the endpoint can ack.
   */
  updateCapabilities(input: {
    relayId: string;
    userId: string;
    desktopSessionId: string;
    capabilityRevision: number;
    capabilities: RelayCapabilities;
  }): { ok: true } | { ok: false; error: string } {
    const entry = this.relays.get(input.relayId);
    if (!entry) return { ok: false, error: "relay is not connected" };
    // Accept updates only for the registered authenticated user. The userId
    // comes from the validated register token, never from the update frame.
    if (entry.userId !== input.userId) {
      return { ok: false, error: "update is not for the registered user" };
    }
    if (entry.desktopSessionId === undefined) {
      return { ok: false, error: "relay has no desktop session" };
    }
    if (entry.desktopSessionId !== input.desktopSessionId) {
      return { ok: false, error: "desktop session id mismatch" };
    }
    if (
      !Number.isSafeInteger(input.capabilityRevision) ||
      input.capabilityRevision < 0
    ) {
      return { ok: false, error: "capability revision must be a non-negative safe integer" };
    }
    if (input.capabilityRevision <= entry.capabilityRevision) {
      return { ok: false, error: "stale or duplicate capability revision" };
    }
    const parsed = parseCapabilityUpdate(input.capabilities, entry.protocolVersion);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    // This is the first state mutation after every rejectable validation. A
    // successfully applied revision replaces the Claude socket scope, while a
    // rejected update must leave the published, still-current context intact.
    this.invalidatePublishedClaudeConnectionContext(entry.relayId, entry.userId);
    const previousRemotePresence = snapshotRemotePresence(entry);
    // Atomically replace capabilities + both advisory snapshots; a malformed
    // parse above returns before reaching here, so the prior state is left
    // intact.
    entry.capabilities = copyRelayCapabilities(parsed.capabilities);
    if (parsed.snapshot !== undefined) {
      entry.desktopFilesystemGrantSnapshot = structuredClone(parsed.snapshot);
    } else {
      // Narrower/empty grant snapshot: clear the advisory hint immediately.
      entry.desktopFilesystemGrantSnapshot = undefined;
    }
    if (parsed.desktopAutomationSnapshot !== undefined) {
      entry.desktopAutomationSnapshot = structuredClone(parsed.desktopAutomationSnapshot);
    } else {
      // A narrower/Off/recovery capability replacement revokes this advisory
      // tuple immediately; an old grant must never survive a refresh.
      entry.desktopAutomationSnapshot = undefined;
    }
    if (parsed.profileSnapshot !== undefined) {
      entry.workstationProfileSnapshot = structuredClone(parsed.profileSnapshot);
    } else {
      // Narrower/absent profile binding: clear the advisory hint immediately.
      // reconnect/session split-brain fix — a present→absent transition
      // for a desktop relay fires the fail-closed cleared hook so production
      // invalidates any matching Full Workstation session + plans BEFORE the
      // entry reflects the cleared snapshot. (parsed.profileSnapshot ===
      // undefined while entry.workstationProfileSnapshot was set.)
      if (
        this.onWorkstationProfileSnapshotCleared &&
        entry.workstationProfileSnapshot !== undefined &&
        entry.desktopSessionId !== undefined &&
        entry.desktopSessionId !== ""
      ) {
        try {
          this.onWorkstationProfileSnapshotCleared({
            relayId: entry.relayId,
            userId: entry.userId,
            desktopSessionId: entry.desktopSessionId,
            ...(entry.pairingGeneration !== undefined && entry.pairingGeneration !== ""
              ? { pairingGeneration: entry.pairingGeneration }
              : {}),
          });
        } catch {
          // Swallow — a callback error must never block the capability update.
        }
      }
      entry.workstationProfileSnapshot = undefined;
    }
    entry.capabilityRevision = input.capabilityRevision;
    this.rejectPendingSshForRelay(entry.relayId, "topology_stale", entry.connectionGeneration);
    entry.codexStatus = undefined;
    this.clearCodexState(entry.relayId, "CODEX_CONTEXT_STALE");
    this.clearClaudeConnectionState(entry.relayId, "CLAUDE_CONNECTION_CONTEXT_STALE");
    this.clearClaudeExecutionState(entry.relayId, "CLAUDE_EXECUTION_CONTEXT_STALE");
    entry.lastSeen = Date.now();
    // publish after the atomic replacement has become observable.
    this.notifyRemotePresenceChanged(
      entry.relayId,
      previousRemotePresence,
      snapshotRemotePresence(entry),
    );
    return { ok: true };
  }

  /**
   * push a fresh MCP config set to a connected relay so it
   * (re)starts its hosted MCP fleet LIVE (no reconnect needed). The relay's
   * `mcpHost.configure` reconciles to this set: newly-enabled servers start
   * + advertise their tools; removed/disabled ones stop. Returns false (no-op)
   * if the relay isn't currently connected — it will pick up the config on its
   * next register instead.
   */
  sendConfigureMcp(relayId: string, servers: RelayMcpServerConfig[]): boolean {
    const entry = this.relays.get(relayId);
    if (!entry) return false;
    entry.send({ type: "relay:configure-mcp", servers });
    return true;
  }

  /**
   * ask one connected, MCP-capable relay for a name-only local
   * prerequisite report. The promise resolves only when the same relay echoes
   * the exact request id, digest, and target name.
   */
  async preflightMcp(
    relayId: string,
    request: RelayMcpPreflightRequest,
  ): Promise<RelayMcpPreflightResultMessage> {
    const entry = this.relays.get(relayId);
    if (!entry || entry.capabilities.mcpTools === undefined) {
      throw new RelayMcpTruthError("relay_unavailable");
    }
    if (entry.protocolVersion < RELAY_MCP_TRUTH_PROTOCOL_VERSION) {
      throw new RelayMcpTruthError("relay_protocol_unsupported");
    }
    // Entry selection, exact session check, pending registration, and send all
    // happen synchronously in this call. A replacement can therefore only
    // occur afterwards, where connectionGeneration rejects its old pending
    // operation instead of sending it to the replacement socket.
    if (entry.desktopSessionId === undefined || entry.desktopSessionId === "") {
      throw new RelayMcpTruthError("relay_unavailable");
    }
    if (entry.desktopSessionId !== request.expectedDesktopSessionId) {
      throw new RelayMcpTruthError("relay_replaced");
    }
    const key = mcpPendingKey(relayId, request.requestId);
    if (this.pendingMcpPreflights.has(key)) {
      throw new RelayMcpTruthError("mcp_duplicate_operation");
    }
    const timeoutMs = boundedMcpTruthTimeout(request.timeoutMs);
    return new Promise<RelayMcpPreflightResultMessage>((resolve, reject) => {
      const pending: PendingMcpPreflight = {
        relayId,
        connectionGeneration: entry.connectionGeneration,
        requestId: request.requestId,
        digest: request.digest,
        targetName: request.server.name,
        transportKind: request.server.transportKind,
        environmentNames: [...(request.server.envPassthrough ?? [])],
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingMcpPreflights.get(key) !== pending) return;
          this.pendingMcpPreflights.delete(key);
          reject(new RelayMcpTruthError("mcp_preflight_timeout"));
        }, timeoutMs),
      };
      this.pendingMcpPreflights.set(key, pending);
      try {
        entry.send({
          type: "relay:mcp-preflight",
          requestId: request.requestId,
          digest: request.digest,
          server: request.server,
        });
      } catch {
        clearTimeout(pending.timer);
        this.pendingMcpPreflights.delete(key);
        reject(new RelayMcpTruthError("relay_unavailable"));
      }
    });
  }

  /**
   * reconcile an MCP fleet and await the exact state of one target.
   * This is intentionally separate from `sendConfigureMcp`, which remains the
   * legacy uncorrelated hot-reconfigure API for old relay/server pairs.
   */
  async configureMcpWithOutcome(
    relayId: string,
    request: RelayMcpConfigureRequest,
  ): Promise<RelayMcpConfigureResultMessage> {
    const entry = this.relays.get(relayId);
    if (!entry || entry.capabilities.mcpTools === undefined) {
      throw new RelayMcpTruthError("relay_unavailable");
    }
    if (entry.protocolVersion < RELAY_MCP_TRUTH_PROTOCOL_VERSION) {
      throw new RelayMcpTruthError("relay_protocol_unsupported");
    }
    // See preflightMcp: this check is deliberately immediately before the
    // pending/send seam and is bound to this registration generation.
    if (entry.desktopSessionId === undefined || entry.desktopSessionId === "") {
      throw new RelayMcpTruthError("relay_unavailable");
    }
    if (entry.desktopSessionId !== request.expectedDesktopSessionId) {
      throw new RelayMcpTruthError("relay_replaced");
    }
    const key = mcpPendingKey(relayId, request.operation.operationId);
    if (this.pendingMcpConfigures.has(key)) {
      throw new RelayMcpTruthError("mcp_duplicate_operation");
    }
    const timeoutMs = boundedMcpTruthTimeout(request.timeoutMs);
    return new Promise<RelayMcpConfigureResultMessage>((resolve, reject) => {
      const pending: PendingMcpConfigure = {
        relayId,
        connectionGeneration: entry.connectionGeneration,
        operationId: request.operation.operationId,
        digest: request.operation.digest,
        targetName: request.operation.targetName,
        phase: request.operation.phase,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingMcpConfigures.get(key) !== pending) return;
          this.pendingMcpConfigures.delete(key);
          reject(new RelayMcpTruthError("mcp_configure_timeout"));
        }, timeoutMs),
      };
      this.pendingMcpConfigures.set(key, pending);
      try {
        entry.send({
          type: "relay:configure-mcp",
          servers: [...request.servers],
          operation: request.operation,
        });
      } catch {
        clearTimeout(pending.timer);
        this.pendingMcpConfigures.delete(key);
        reject(new RelayMcpTruthError("relay_unavailable"));
      }
    });
  }

  /** Accept only the exact preflight result for the currently pending request. */
  acceptMcpPreflightResult(relayId: string, result: RelayMcpPreflightResultMessage): boolean {
    const key = mcpPendingKey(relayId, result.requestId);
    const pending = this.pendingMcpPreflights.get(key);
    const current = this.relays.get(relayId);
    if (!pending) return false;
    if (
      pending.relayId !== relayId ||
      current === undefined ||
      pending.connectionGeneration !== current.connectionGeneration ||
      pending.digest !== result.digest ||
      pending.targetName !== result.targetName ||
      !matchesPendingMcpPreflight(pending, result)
    ) {
      clearTimeout(pending.timer);
      this.pendingMcpPreflights.delete(key);
      pending.reject(new RelayMcpTruthError("mcp_response_mismatch"));
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingMcpPreflights.delete(key);
    pending.resolve(result);
    return true;
  }

  /** Accept only the exact configure outcome for the currently pending operation. */
  acceptMcpConfigureResult(relayId: string, result: RelayMcpConfigureResultMessage): boolean {
    const key = mcpPendingKey(relayId, result.operationId);
    const pending = this.pendingMcpConfigures.get(key);
    const current = this.relays.get(relayId);
    if (!pending) return false;
    if (
      pending.relayId !== relayId ||
      current === undefined ||
      pending.connectionGeneration !== current.connectionGeneration ||
      pending.digest !== result.digest ||
      pending.targetName !== result.targetName ||
      !matchesPendingMcpConfigure(pending, result)
    ) {
      clearTimeout(pending.timer);
      this.pendingMcpConfigures.delete(key);
      pending.reject(new RelayMcpTruthError("mcp_response_mismatch"));
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingMcpConfigures.delete(key);
    pending.resolve(result);
    return true;
  }

  /**
   * construct dynamic provenance exclusively from the currently
   * authenticated relay socket, then ask Electron to resolve and prepare the
   * approved request against local OpenSSH state. No caller can supply a grant,
   * identity, session id, pairing reference, or capability revision.
   */
  async prepareStructuredSsh(
    relayId: string,
    invocation: RelaySshPrepareInvocation,
  ): Promise<RelaySshPrepareResponseV1> {
    const entry = this.relays.get(relayId);
    if (
      entry === undefined ||
      entry.capabilities.profile !== "desktop-agent" ||
      !hasStructuredSshOperationReadiness(entry.capabilities, invocation.operation) ||
      entry.protocolVersion < RELAY_SSH_PREPARE_PROTOCOL_VERSION ||
      entry.desktopSessionId === undefined || entry.desktopSessionId === "" ||
      entry.relaySessionId === undefined || entry.relaySessionId === "" ||
      entry.pairingGenerationRef === undefined || entry.pairingGenerationRef === "" ||
      entry.userId !== invocation.userId
    ) {
      throw new RelaySshPrepareError(entry === undefined ? "relay_unavailable" : "topology_stale");
    }
    const rawRequest = {
      version: RELAY_SSH_PREPARE_VERSION,
      requestId: `ssh-prepare-${randomUUID()}`,
      toolCallId: invocation.toolCallId,
      approvedRequestDigest: invocation.approvedRequestDigest,
      operation: invocation.operation,
      approvedRequest: invocation.approvedRequest,
      subject: {
        instanceId: invocation.instanceId,
        userId: entry.userId,
        actorId: invocation.actorId,
        actorRole: invocation.actorRole,
        agentId: invocation.agentId,
        executionEntrypoint: invocation.executionEntrypoint,
        relayId: entry.relayId,
        relaySessionId: entry.relaySessionId,
        desktopSessionId: entry.desktopSessionId,
        pairingGenerationRef: entry.pairingGenerationRef,
        capabilityRevision: entry.capabilityRevision,
      },
    } as const;
    const parsed = parseRelaySshPrepareRequest(rawRequest);
    if (!parsed.ok) throw new RelaySshPrepareError("topology_stale");
    const request = parsed.request;
    const key = sshPreparePendingKey(relayId, request.requestId);
    if (this.pendingSshPrepares.has(key)) throw new RelaySshPrepareError("ssh_prepare_duplicate");
    const timeoutMs = boundedSshPrepareTimeout(invocation.timeoutMs);
    return new Promise<RelaySshPrepareResponseV1>((resolve, reject) => {
      const pending: PendingSshPrepare = {
        relayId,
        connectionGeneration: entry.connectionGeneration,
        request,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingSshPrepares.get(key) !== pending) return;
          this.pendingSshPrepares.delete(key);
          reject(new RelaySshPrepareError("ssh_prepare_timeout"));
        }, timeoutMs),
      };
      this.pendingSshPrepares.set(key, pending);
      try {
        entry.send({ type: "relay:ssh-prepare", request });
      } catch {
        clearTimeout(pending.timer);
        this.pendingSshPrepares.delete(key);
        reject(new RelaySshPrepareError("relay_unavailable"));
      }
    });
  }

  /** Accept an Electron result only for the same current authenticated socket topology. */
  acceptSshPrepared(relayId: string, message: RelaySshPreparedMessage): boolean {
    const key = sshPreparePendingKey(relayId, message.requestId);
    const pending = this.pendingSshPrepares.get(key);
    const current = this.relays.get(relayId);
    if (pending === undefined) return false;
    const subject = pending.request.subject;
    const currentMatches = current !== undefined &&
      pending.connectionGeneration === current.connectionGeneration &&
      current.userId === subject.userId &&
      current.relaySessionId === subject.relaySessionId &&
      current.pairingGenerationRef === subject.pairingGenerationRef &&
      current.desktopSessionId === subject.desktopSessionId &&
      current.capabilityRevision === subject.capabilityRevision &&
      current.capabilities.profile === "desktop-agent" &&
      hasStructuredSshAuthExecReadiness(current.capabilities);
    if (!currentMatches) {
      clearTimeout(pending.timer);
      this.pendingSshPrepares.delete(key);
      pending.reject(new RelaySshPrepareError("topology_stale"));
      return false;
    }
    if (message.status === "error") {
      clearTimeout(pending.timer);
      this.pendingSshPrepares.delete(key);
      pending.reject(new RelaySshPrepareError(message.errorCode, message.failure));
      return true;
    }
    const parsed = parseRelaySshPrepareResponse(message.response);
    if (!parsed.ok || !sameSshPrepareRequestAndResponse(pending.request, parsed.response)) {
      clearTimeout(pending.timer);
      this.pendingSshPrepares.delete(key);
      pending.reject(new RelaySshPrepareError("ssh_prepare_response_mismatch"));
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingSshPrepares.delete(key);
    pending.resolve(parsed.response);
    return true;
  }

  unregister(relayId: string): Promise<void> {
    // capture the entry before deletion so the onUnregister hook
    // can fail-closed any server-side state bound to this relay (e.g.
    // invalidate a Full Workstation session). The hook is invoked on every
    // unregister path: explicit `relay:disconnect`, socket close, and the
    // heartbeat-timeout `sweepStale` sweep — so re-pair / disconnect /
    // silent loss all collapse to the same fail-closed seam.
    const entry = this.relays.get(relayId);
    const previousRemotePresence = entry ? snapshotRemotePresence(entry) : null;
    if (entry && this.onUnregister) {
      try {
        this.onUnregister({
          relayId: entry.relayId,
          userId: entry.userId,
          desktopSessionId: entry.desktopSessionId ?? null,
        });
      } catch {
        // Swallow — a callback error must never surface to the
        // unregister caller or block pending-dispatch cleanup below.
      }
    }
    if (entry) {
      // A heartbeat expiry can retire a still-open socket. Ask that exact
      // Desktop to stop its scanner children before removing transport state.
      for (const [correlationId, pending] of this.pending) {
        if (pending.toolName !== "security_scan" || !pending.dispatched
          || !correlationId.startsWith(`${relayId}:`)
          || pending.connectionGeneration !== entry.connectionGeneration) continue;
        try { entry.send({ type: "relay:cancel", correlationId }); } catch { /* disconnected */ }
      }
    }
    if (entry) this.invalidatePublishedClaudeConnectionContext(relayId, entry.userId);
    this.relays.delete(relayId);
    this.rejectPendingMcpForRelay(relayId, "relay_disconnected");
    this.rejectPendingSshForRelay(relayId, "relay_disconnected");
    this.clearCodexState(relayId, "CODEX_RELAY_UNAVAILABLE");
    this.clearClaudeConnectionState(relayId, "CLAUDE_CONNECTION_UNAVAILABLE");
    this.clearClaudeExecutionState(relayId, "CLAUDE_EXECUTION_UNAVAILABLE");
    this.rejectPendingDispatchesForRelay(
      relayId,
      "disconnect",
      `Relay ${relayId} disconnected during dispatch`,
    );
    // The entry is gone before this fires. Retaining the previous snapshot is
    // what lets a projector retract the exact host/generation on disconnect.
    if (entry) {
      this.notifyRemotePresenceChanged(relayId, previousRemotePresence, null);
    }
    return Promise.resolve();
  }

  /**
   * Dispatch a tool call to a specific relay. Returns a promise that resolves
   * when the relay sends back a result, or rejects on timeout/disconnect.
   */
  async dispatch(
    relayId: string,
    request: {
      toolName: string;
      args: Record<string, unknown>;
      impact: "read-only" | "low" | "high" | "destructive";
      approvalObtained: boolean;
      /** exact Relay provenance for a hosted MCP tool. */
      hostedBy?: string | undefined;
      allowedRoots?: string[] | undefined;
      /**
       * protocol v9 — optional resolver input only. The registry stores
       * and forwards it without treating roots or grant ids as authority.
       */
      desktopFilesystemGrantRequest?: RelayDesktopFilesystemGrantRequest | undefined;
      /** opaque generic-shell binding metadata; local relay state remains authority. */
      workstationShellBinding?: RelayWorkstationShellBinding | undefined;
      /** server-owned marker for a live-session-admitted uncontained raw shell. */
      uncontainedHostCommandsSession?: true | undefined;
      /** validated, secret-free structured SSH admission metadata. */
      sshBinding?: RelaySshDispatchBindingV1 | undefined;
      timeout?: number | undefined;
      /**
       * Per-turn sandbox profile ( Sprint 1 G5.4). Optional at
       * the type level for the G5.4.a foundation commit; release
       * builds will require it once G5.4.c lands the relay-side
       * guard + policy-resolver construction.
       */
      sandboxProfile?: RelaySandboxProfile | undefined;
      /** computer_use / desktop / fs / local-file / structured SSH — server-set execution classes. */
      executionClass?: "computer_use" | "desktop" | "fs" | "browser" | "local-file" | "real_workstation" | "structured-ssh" | undefined;
      /** Narrow observer for the exact pending security scan. */
      onSecurityScanProgress?: ((progress: RelaySecurityScanProgressMessage) => void) | undefined;
      /** local server observer for paired Desktop raw-shell progress. */
      onRunShellProgress?: ((progress: RelayRunShellProgressMessage) => void) | undefined;
      /** observer for one exact structured SSH pending dispatch. */
      onStructuredSshProgress?: ((progress: RelayStructuredSshProgressMessage) => void) | undefined;
      /** Server-local enclosing Job cancellation; never copied to the wire frame. */
      signal?: AbortSignal | undefined;
      /** exact semantic computer binding; already parsed at server admission. */
      desktopAutomationBinding?: NonNullable<
        Extract<RelayServerMessage, { type: "relay:dispatch" }>["desktopAutomationBinding"]
      > | undefined;
      /** signed-catalogue Host request; forwarded opaquely to Electron. */
      computerUseRequest?: NonNullable<
        Extract<RelayServerMessage, { type: "relay:dispatch" }>["computerUseRequest"]
      > | undefined;
      /** server-local exact Task continuation fence; never serialized. */
      requiredRelaySessionId?: string | undefined;
      requiredDesktopSessionId?: string | undefined;
      requiredPairingGeneration?: string | undefined;
    },
  ): Promise<RelayDispatchResult> {
    const entry = this.relays.get(relayId);
    if (!entry) {
      throw new Error(`Relay ${relayId} is not connected`);
    }
    if (
      (request.requiredRelaySessionId !== undefined
        && entry.relaySessionId !== request.requiredRelaySessionId)
      || (request.requiredDesktopSessionId !== undefined
        && entry.desktopSessionId !== request.requiredDesktopSessionId)
      || (request.requiredPairingGeneration !== undefined
        && entry.pairingGeneration !== request.requiredPairingGeneration)
    ) {
      throw new Error("Task continuation relay topology changed before dispatch");
    }
    if (request.signal?.aborted) {
      throw new Error("Dispatch cancelled");
    }
    if (request.hostedBy !== undefined && request.hostedBy !== relayId) {
      throw new Error("Hosted MCP dispatch Relay binding changed before dispatch");
    }

    const isComputerUseDispatch = request.executionClass === "computer_use";
    if (isComputerUseDispatch || request.desktopAutomationBinding !== undefined) {
      const binding = request.desktopAutomationBinding;
      const authorize = this.authorizeDesktopAutomationDispatch;
      const snapshot = entry.desktopAutomationSnapshot;
      if (
        !isComputerUseDispatch
        || binding === undefined
        || entry.protocolVersion < RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION
        || entry.capabilities.computerUseSemanticVersion !== COMPUTER_USE_SEMANTIC_VERSION
        || entry.capabilities.canControlDesktop !== true
        || snapshot === undefined
        || entry.userId !== binding.originHumanId
        || relayId !== binding.relayId
        || entry.pairingGenerationRef !== binding.pairingGeneration
        || entry.desktopSessionId !== binding.desktopSessionId
        || snapshot.agentId !== binding.originAgentId
        || snapshot.installationEpoch !== binding.installationEpoch
        || snapshot.grantGeneration !== binding.grantGeneration
        || snapshot.provider !== binding.provider
        || snapshot.providerGeneration !== binding.providerGeneration
        || authorize === undefined
      ) {
        throw new Error("Desktop automation dispatch authorization denied");
      }
      let authorized = false;
      try {
        authorized = await authorize({
          userId: entry.userId,
          agentId: binding.originAgentId,
          toolName: request.toolName,
        });
      } catch {
        authorized = false;
      }
      if (!authorized) throw new Error("Desktop automation dispatch authorization denied");
      if (request.signal?.aborted) throw new Error("Dispatch cancelled");
    }

    const correlationId = `${relayId}:${randomUUID()}`;
    // Scanner startup runs the owned probes. Its lifetime belongs to the
    // durable Task's abort signal and relay liveness, not the generic RPC
    // deadline. Keep explicit caller deadlines and malformed calls bounded.
    const scan = request.toolName === "security_scan"
      ? securityScanRelayRequestSchema.safeParse(request.args) : null;
    const taskOwnedScanStart = scan?.success === true
      && scan.data.operation.operation === "start"
      && request.signal !== undefined && request.timeout === undefined;
    const hueSetup = request.toolName === "hue_lights" && request.args["action"] === "setup";
    const timeoutMs = request.timeout ?? (hueSetup
      ? OPENHUE_SETUP_TIMEOUT_MS + HUE_SETUP_RESULT_RECEIPT_GRACE_MS
      : DISPATCH_DEFAULT_TIMEOUT_MS);
    const rawRunShellCommand = isRawRunShellCommand(request);
    const structuredSshDispatch = isStructuredSshDispatch(request);
    const effectfulDesktopAutomation = isEffectfulDesktopAutomationDispatch(request);
    // Admitted Computer Use and Browser UI mutations belong to the invoking
    // turn and executor lifecycle, not a generic RPC stopwatch. Keep explicit
    // caller deadlines and the fallback when no cancellation owner is supplied.
    const signalOwnedDesktopAutomation = effectfulDesktopAutomation &&
      request.signal !== undefined && request.timeout === undefined;
    // The relay still receives exactly `request.timeout`; only this server
    // registry waits a little longer for Electron's final process receipt.
    const receiptDeadlineMs = timeoutMs +
      (rawRunShellCommand ? this.runShellResultReceiptGraceMs : 0);

    return new Promise<RelayDispatchResult>((resolve, reject) => {
      const timer = taskOwnedScanStart || signalOwnedDesktopAutomation ? undefined : setTimeout(() => {
        const pending = this.pending.get(correlationId);
        if (pending === undefined) return;
        if (pending.effectfulDesktopAutomation && pending.dispatched) {
          this.beginDesktopAutomationReceiptGrace(correlationId, pending, "timeout");
          return;
        }
        if (pending.toolName === "security_scan" && pending.dispatched) {
          // Preserve the cancellation frame even when the receipt deadline
          // expires; losing the wait must not orphan the local probes.
          try { entry.send({ type: "relay:cancel", correlationId }); } catch { /* disconnected */ }
        }
        this.expirePendingDispatch(
          correlationId,
          pending,
          "timeout",
          `Relay dispatch timed out after ${timeoutMs}ms (tool: ${request.toolName})`,
        );
      }, receiptDeadlineMs);

      const pending: PendingDispatch = {
        resolve,
        reject,
        timer,
        dispatched: false,
        toolName: request.toolName,
        rawRunShellCommand,
        realWorkstationRawRunShell:
          rawRunShellCommand && request.executionClass === "real_workstation",
        structuredSshDispatch,
        effectfulDesktopAutomation,
        ...(request.sshBinding !== undefined ? { structuredSshOperation: request.sshBinding.operation } : {}),
        connectionGeneration: entry.connectionGeneration,
        ...(request.toolName === "security_scan" && request.onSecurityScanProgress ? { onSecurityScanProgress: request.onSecurityScanProgress } : {}),
        ...(request.onRunShellProgress !== undefined
          ? { onRunShellProgress: request.onRunShellProgress }
          : {}),
        ...(structuredSshDispatch &&
          entry.protocolVersion >= RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION &&
          request.sshBinding?.operation !== "auth" &&
          request.onStructuredSshProgress !== undefined
          ? { onStructuredSshProgress: request.onStructuredSshProgress }
          : {}),
        lastRunShellProgressSequence: -1,
        runShellProgressEnds: { stdout: 0, stderr: 0 },
        lastStructuredSshProgressSequence: -1,
        structuredSshProgressEnds: { stdout: 0, stderr: 0 },
        structuredSshTransferStarted: false,
        lastStructuredSshTransferBytes: 0,
      };
      this.pending.set(correlationId, pending);

      // Mark immediately before handing the frame to the transport. Every
      // loss after this seam is indeterminate for run_shell, including a
      // synchronous unregister triggered by a transport implementation.
      pending.dispatched = true;
      try {
        entry.send({
          type: "relay:dispatch",
          correlationId,
          toolName: request.toolName,
          args: request.args,
          timeout: request.timeout,
          impact: request.impact,
          approvalObtained: request.approvalObtained,
          ...(request.hostedBy !== undefined &&
          entry.protocolVersion >= RELAY_MCP_DISPATCH_PROVENANCE_PROTOCOL_VERSION
            ? { hostedBy: request.hostedBy }
            : {}),
          ...(request.allowedRoots !== undefined ? { allowedRoots: request.allowedRoots } : {}),
          ...(request.desktopFilesystemGrantRequest !== undefined &&
          entry.protocolVersion >= DESKTOP_FILESYSTEM_GRANT_REQUEST_PROTOCOL_VERSION
            ? { desktopFilesystemGrantRequest: request.desktopFilesystemGrantRequest }
            : {}),
          ...(request.workstationShellBinding !== undefined
            ? { workstationShellBinding: request.workstationShellBinding }
            : {}),
          ...(request.uncontainedHostCommandsSession === true
            ? { uncontainedHostCommandsSession: true as const }
            : {}),
          ...(request.sshBinding !== undefined ? { sshBinding: request.sshBinding } : {}),
          ...(request.desktopAutomationBinding !== undefined
            ? { desktopAutomationBinding: request.desktopAutomationBinding }
            : {}),
          ...(request.computerUseRequest !== undefined
            ? { computerUseRequest: request.computerUseRequest }
            : {}),
          ...(request.sandboxProfile !== undefined ? { sandboxProfile: request.sandboxProfile } : {}),
          ...(request.executionClass !== undefined ? { executionClass: request.executionClass } : {}),
        });
        if (request.signal) {
          const onAbort = () => this.cancelDispatch(correlationId);
          pending.abortSignal = request.signal;
          pending.abortListener = onAbort;
          request.signal.addEventListener("abort", onAbort, { once: true });
          // Cover an abort that raced the synchronous send/listener install.
          if (request.signal.aborted) onAbort();
        }
      } catch (error) {
        // A synchronous send failure is pre-dispatch: it gives no evidence
        // Electron received the frame, so preserve the ordinary error path.
        pending.dispatched = false;
        clearTimeout(timer);
        this.pending.delete(correlationId);
        this.detachPendingAbort(pending);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * typed convenience for the `fs` execution class. Wraps
   * `dispatch` with the fixed `toolName:"fs"` + `executionClass:"fs"`
   * envelope (approval already happened server-side; impact reflects
   * read vs mutate so the relay can log it), then unwraps
   * `result.result` to a `RelayFsResult`. A transport error (timeout /
   * relay disconnect) is mapped to a `{ ok:false }` result so callers
   * have a single error shape to branch on.
   */
  async fsDispatch(
    relayId: string,
    req: RelayFsRequest,
    opts: { mutating: boolean; timeoutMs?: number },
  ): Promise<RelayFsResult> {
    try {
      const result = await this.dispatch(relayId, {
        toolName: "fs",
        args: req as unknown as Record<string, unknown>,
        impact: opts.mutating ? "destructive" : "read-only",
        approvalObtained: true,
        allowedRoots: req.allowedRoots,
        executionClass: "fs",
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      });
      if (result.status === "error") {
        return {
          ok: false,
          message: result.error ?? `relay fs op ${req.op} failed`,
        };
      }
      const inner = result.result as RelayFsResult | undefined;
      if (!inner || typeof inner !== "object" || typeof inner.ok !== "boolean") {
        return {
          ok: false,
          message: `relay fs op ${req.op} returned a malformed result`,
        };
      }
      return inner;
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * typed convenience for the `local-file` execution class. Wraps
   * `dispatch` with the fixed `toolName:"local-file"` +
   * `executionClass:"local-file"` envelope, then unwraps `result.result`
   * to a `RelayLocalFileResult`. Transport errors map to `{ ok:false }`
   * mirroring `fsDispatch`.
   */
  async localFileDispatch(
    relayId: string,
    req: RelayLocalFileRequest,
    opts: {
      mutating: boolean;
      approvalObtained: boolean;
      timeoutMs?: number;
      sandboxProfile?: RelaySandboxProfile;
      /**
       * (protocol v9) — optional grant reference carried as OUTER
       * relay-dispatch metadata. It never widens `allowedRoots` and is never
       * treated as authority here: the registry only stores and forwards it so
       * the relay-local resolver can re-validate the live grant. Omitted for
       * mutating/ambiguous commands, preserving the earlier baseline.
       */
      desktopFilesystemGrantRequest?: RelayDesktopFilesystemGrantRequest | undefined;
      requiredRelaySessionId?: string;
      requiredDesktopSessionId?: string;
      requiredPairingGeneration?: string;
    },
  ): Promise<RelayLocalFileResult> {
    try {
      const result = await this.dispatch(relayId, {
        toolName: "local-file",
        args: req as unknown as Record<string, unknown>,
        impact: opts.mutating ? "destructive" : "read-only",
        approvalObtained: opts.approvalObtained,
        allowedRoots: [...req.allowedRoots],
        executionClass: "local-file",
        ...(opts.sandboxProfile === undefined ? {} : { sandboxProfile: opts.sandboxProfile }),
        ...(opts.desktopFilesystemGrantRequest !== undefined
          ? { desktopFilesystemGrantRequest: opts.desktopFilesystemGrantRequest }
          : {}),
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        ...(opts.requiredRelaySessionId !== undefined
          ? { requiredRelaySessionId: opts.requiredRelaySessionId }
          : {}),
        ...(opts.requiredDesktopSessionId !== undefined
          ? { requiredDesktopSessionId: opts.requiredDesktopSessionId }
          : {}),
        ...(opts.requiredPairingGeneration !== undefined
          ? { requiredPairingGeneration: opts.requiredPairingGeneration }
          : {}),
      });
      if (result.status === "error") {
        const err: RelayLocalFileResult = {
          ok: false,
          message: result.error ?? "relay local-file dispatch failed",
        };
        if (result.errorCode !== undefined) {
          return { ok: false, code: result.errorCode, message: err.message };
        }
        return err;
      }
      const inner = result.result as RelayLocalFileResult | undefined;
      if (!inner || typeof inner !== "object" || typeof inner.ok !== "boolean") {
        return {
          ok: false,
          message: "relay local-file dispatch returned a malformed result",
        };
      }
      return inner;
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * dedicated v8 apply-patch transport. This deliberately does not
   * reuse `RelayLocalFileRequest`: it carries one strict high-level operation
   * and no `allowedRoots` mirror. The request is parsed before sending, while
   * relay output is parsed before returning. Desktop resolves the asserted
   * Current Folder against its local main-process state.
   */
  async applyPatchDispatch(
    relayId: string,
    req: RelayLocalApplyPatchRequest,
    opts: {
      sandboxProfile: RelaySandboxProfile;
      requiredRelaySessionId?: string;
      requiredDesktopSessionId?: string;
      requiredPairingGeneration?: string;
    },
  ): Promise<RelayLocalApplyPatchResult> {
    const entry = this.relays.get(relayId);
    const parsedRequest = parseRelayLocalApplyPatchRequest(req);
    if (entry === undefined || !parsedRequest.ok) {
      throw new ApplyPatchRelayDispatchError("runtime_unavailable");
    }
    if (!canRelayExecuteApplyPatch(entry.protocolVersion, entry.capabilities)) {
      throw new ApplyPatchRelayDispatchError("runtime_unavailable");
    }

    try {
      const result = await this.dispatch(relayId, {
        toolName: "local-file",
        args: parsedRequest.request as unknown as Record<string, unknown>,
        impact: "destructive",
        approvalObtained: true,
        executionClass: "local-file",
        sandboxProfile: opts.sandboxProfile,
        ...(opts.requiredRelaySessionId !== undefined
          ? { requiredRelaySessionId: opts.requiredRelaySessionId }
          : {}),
        ...(opts.requiredDesktopSessionId !== undefined
          ? { requiredDesktopSessionId: opts.requiredDesktopSessionId }
          : {}),
        ...(opts.requiredPairingGeneration !== undefined
          ? { requiredPairingGeneration: opts.requiredPairingGeneration }
          : {}),
      });
      if (result.status !== "ok") {
        throw new ApplyPatchRelayDispatchError(
          stableApplyPatchRelayErrorCode(result.errorCode),
          safeApplyPatchRelayFailureReason(result.errorCode),
        );
      }
      const parsedResult = parseRelayLocalApplyPatchResult(result.result);
      if (!parsedResult.ok) {
        throw new ApplyPatchRelayDispatchError("runtime_unavailable");
      }
      return parsedResult.result;
    } catch (error) {
      if (error instanceof ApplyPatchRelayDispatchError) throw error;
      throw new ApplyPatchRelayDispatchError("runtime_unavailable");
    }
  }

  /**
   * internal port: dispatch only to the caller-pinned, authenticated
   * owner relay. This method intentionally has no discovery or fallback path.
   */
  async browserResearchReadDispatch(
    relayId: string,
    actorId: string,
    req: RelayBrowserResearchReadRequest,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<import("@nautilo/relay").BrowserPageReadResult> {
    const entry = this.relays.get(relayId);
    const parsedRequest = parseRelayBrowserResearchReadRequest(req);
    if (entry === undefined || entry.userId !== actorId || !parsedRequest.ok ||
      !canRelayExecuteBrowserResearchRead(entry.protocolVersion, entry.capabilities)) {
      throw new BrowserResearchReadRelayDispatchError("runtime_unavailable");
    }
    try {
      const result = await this.dispatch(relayId, {
        toolName: "browser_research_read",
        args: parsedRequest.request as unknown as Record<string, unknown>,
        impact: "read-only",
        approvalObtained: true,
        executionClass: "browser",
        ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (result.status !== "ok") {
        if (result.errorCode === "browser_research_cancelled") throw new BrowserResearchReadRelayDispatchError("cancelled");
        if (result.errorCode === "browser_research_alternate") throw new BrowserResearchReadRelayDispatchError("alternate");
        if (result.errorCode === "browser_research_expired") throw new BrowserResearchReadRelayDispatchError("expired");
        if (result.errorCode === "browser_research_consent_wall") throw new BrowserResearchReadRelayDispatchError("consent_wall");
        throw new BrowserResearchReadRelayDispatchError("transport_failed");
      }
      const parsedResult = parseRelayBrowserResearchReadResult(result.result);
      if (!parsedResult.ok) throw new BrowserResearchReadRelayDispatchError("invalid_result");
      return parsedResult.result;
    } catch (error) {
      if (error instanceof BrowserResearchReadRelayDispatchError) throw error;
      throw new BrowserResearchReadRelayDispatchError("transport_failed");
    }
  }

  /**
   * internal port: inspect only an immutable snapshot on the exact
   * authenticated owner relay. It is intentionally a separate method from
   * v12 URL/continuation reads; neither method discovers another relay.
   */
  async browserResearchSnapshotInspectionDispatch(
    relayId: string,
    actorId: string,
    req: RelayBrowserResearchSnapshotInspectionRequest,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<import("@nautilo/relay").BrowserPageSnapshotInspectionResult> {
    const entry = this.relays.get(relayId);
    const parsedRequest = parseRelayBrowserResearchSnapshotInspectionRequest(req);
    if (entry === undefined || entry.userId !== actorId || !parsedRequest.ok ||
      !canRelayExecuteBrowserResearchSnapshotInspection(entry.protocolVersion, entry.capabilities)) {
      throw new BrowserResearchSnapshotInspectionRelayDispatchError("runtime_unavailable");
    }
    try {
      const result = await this.dispatch(relayId, {
        // Electron recognizes this as a strict `snapshot` v13 operation before
        // normal read handling. Keeping the established internal name avoids a
        // second generic browser execution surface.
        toolName: "browser_research_read",
        args: parsedRequest.request as unknown as Record<string, unknown>,
        impact: "read-only",
        approvalObtained: true,
        executionClass: "browser",
        ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (result.status !== "ok") {
        const code = result.errorCode;
        if (code === "BROWSER_PAGE_SNAPSHOT_EXPIRED") throw new BrowserResearchSnapshotInspectionRelayDispatchError("expired");
        if (code === "BROWSER_PAGE_SNAPSHOT_EVICTED") throw new BrowserResearchSnapshotInspectionRelayDispatchError("evicted");
        if (code === "BROWSER_PAGE_SNAPSHOT_UNAVAILABLE") throw new BrowserResearchSnapshotInspectionRelayDispatchError("unavailable");
        if (code === "BROWSER_PAGE_SNAPSHOT_OFFSET_INVALID") throw new BrowserResearchSnapshotInspectionRelayDispatchError("invalid_offset");
        if (code === "BROWSER_PAGE_SNAPSHOT_RESOURCE_LIMIT") throw new BrowserResearchSnapshotInspectionRelayDispatchError("resource_limit");
        throw new BrowserResearchSnapshotInspectionRelayDispatchError("transport_failed");
      }
      const parsedResult = parseRelayBrowserResearchSnapshotInspectionResult(result.result);
      if (!parsedResult.ok) throw new BrowserResearchSnapshotInspectionRelayDispatchError("invalid_result");
      return parsedResult.result;
    } catch (error) {
      if (error instanceof BrowserResearchSnapshotInspectionRelayDispatchError) throw error;
      throw new BrowserResearchSnapshotInspectionRelayDispatchError("transport_failed");
    }
  }

  async browserResearchConsentRecoveryDispatch(
    relayId: string,
    actorId: string,
    req: import("@nautilo/relay").RelayBrowserResearchConsentRecoveryRequest,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<import("@nautilo/relay").BrowserResearchConsentRecoveryResult> {
    const entry = this.relays.get(relayId);
    const parsedRequest = parseRelayBrowserResearchConsentRecoveryRequest(req);
    if (entry === undefined || entry.userId !== actorId || !parsedRequest.ok ||
      !canRelayExecuteBrowserResearchConsentRecovery(entry.protocolVersion, entry.capabilities)) {
      throw new BrowserResearchConsentRecoveryRelayDispatchError("runtime_unavailable");
    }
    try {
      const result = await this.dispatch(relayId, {
        toolName: "browser_research_read",
        args: parsedRequest.request as unknown as Record<string, unknown>,
        impact: "read-only",
        approvalObtained: true,
        executionClass: "browser",
        ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (result.status !== "ok") {
        if (result.errorCode === "browser_research_expired") throw new BrowserResearchConsentRecoveryRelayDispatchError("expired");
        if (result.errorCode === "browser_research_recovery_failed") throw new BrowserResearchConsentRecoveryRelayDispatchError("operation_failed");
        throw new BrowserResearchConsentRecoveryRelayDispatchError("transport_failed");
      }
      const parsedResult = parseRelayBrowserResearchConsentRecoveryResult(result.result);
      if (!parsedResult.ok) throw new BrowserResearchConsentRecoveryRelayDispatchError("invalid_result");
      return parsedResult.result;
    } catch (error) {
      if (error instanceof BrowserResearchConsentRecoveryRelayDispatchError) throw error;
      throw new BrowserResearchConsentRecoveryRelayDispatchError("transport_failed");
    }
  }

  /** fixed-host search discovery on the exact authenticated Desktop relay. */
  async browserResearchSearchDispatch(
    relayId: string,
    actorId: string,
    req: RelayBrowserResearchSearchRequest,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<import("@nautilo/relay").BrowserResearchSearchResult> {
    const entry = this.relays.get(relayId);
    const parsedRequest = parseRelayBrowserResearchSearchRequest(req);
    if (entry === undefined || entry.userId !== actorId || !parsedRequest.ok ||
      !canRelayExecuteBrowserResearchSearch(entry.protocolVersion, entry.capabilities)) {
      throw new BrowserResearchSearchRelayDispatchError("runtime_unavailable");
    }
    try {
      const result = await this.dispatch(relayId, {
        toolName: "browser_research_search",
        args: parsedRequest.request as unknown as Record<string, unknown>,
        impact: "read-only",
        approvalObtained: true,
        executionClass: "browser",
        ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      if (result.status !== "ok") {
        if (result.errorCode === "browser_research_cancelled") throw new BrowserResearchSearchRelayDispatchError("cancelled");
        throw new BrowserResearchSearchRelayDispatchError("transport_failed");
      }
      const parsedResult = parseRelayBrowserResearchSearchResult(result.result);
      if (!parsedResult.ok) throw new BrowserResearchSearchRelayDispatchError("invalid_result");
      return parsedResult.result;
    } catch (error) {
      if (error instanceof BrowserResearchSearchRelayDispatchError) throw error;
      throw new BrowserResearchSearchRelayDispatchError("transport_failed");
    }
  }

  /**
   * Called by the server endpoint when a relay:result message arrives.
   */
  resolveDispatch(correlationId: string, result: RelayDispatchResult): void {
    const p = this.pending.get(correlationId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(correlationId);
    this.detachPendingAbort(p);
    if (p.effectfulDesktopAutomation && p.receiptGraceReason !== undefined && result.status === "error") {
      // Older Relay Hosts discard the callback on abort. That transport error
      // is not the executor's effect receipt, nor proof of a Human Stop. Keep
      // the initiating reason and the post-dispatch unknown-outcome contract.
      p.reject(new RelayDispatchOutcomeUnknownError("desktop-automation", p.receiptGraceReason));
      return;
    }
    p.resolve(result);
  }

  /** Only the pending scan may receive progress; final results remain canonical. */
  acceptSecurityScanProgress(progress: RelaySecurityScanProgressMessage): void {
    const pending = this.pending.get(progress.correlationId);
    if (pending?.toolName !== "security_scan" || pending.abortSignal?.aborted) return;
    try { pending.onSecurityScanProgress?.(progress); } catch { /* Observation cannot fail the dispatch. */ }
  }

  acceptRunShellProgress(progress: RelayRunShellProgressMessage): void {
    const pending = this.pending.get(progress.correlationId);
    if (!pending?.onRunShellProgress) return;
    // WebSocket delivery is ordered, but make duplicate/out-of-order frames
    // harmless at this server boundary. Exact offsets also make renderer
    // reconciliation deterministic and prohibit replay amplification.
    if (
      progress.sequence !== pending.lastRunShellProgressSequence + 1 ||
      progress.offsetBytes !== pending.runShellProgressEnds[progress.stream]
    ) return;
    pending.lastRunShellProgressSequence = progress.sequence;
    pending.runShellProgressEnds[progress.stream] = progress.endOffsetBytes;
    try {
      pending.onRunShellProgress(progress);
    } catch {
      // UI/event projection is observational. A consumer fault must never
      // break relay endpoint processing or the eventual canonical result.
    }
  }

  /**
   * accept only in-order observations for an exact pending
   * structured-SSH dispatch. The callback is intentionally observational:
   * any failure is isolated from the authoritative final result.
   */
  acceptStructuredSshProgress(progress: RelayStructuredSshProgressMessage): void {
    const pending = this.pending.get(progress.correlationId);
    if (
      !pending?.structuredSshDispatch ||
      pending.structuredSshOperation === "auth" ||
      pending.structuredSshOperation !== progress.operation ||
      !pending.onStructuredSshProgress
    ) return;
    if (progress.sequence !== pending.lastStructuredSshProgressSequence + 1) return;
    if (progress.kind === "exec-output") {
      if (progress.offsetBytes !== pending.structuredSshProgressEnds[progress.stream]) return;
      pending.structuredSshProgressEnds[progress.stream] = progress.endOffsetBytes;
    } else {
      if (
        (progress.phase === "starting" && (pending.structuredSshTransferStarted || progress.transferredBytes !== 0)) ||
        (progress.phase === "transferring" && !pending.structuredSshTransferStarted) ||
        progress.transferredBytes < pending.lastStructuredSshTransferBytes ||
        (pending.structuredSshTransferTotal !== undefined &&
          progress.totalBytes !== undefined && progress.totalBytes !== pending.structuredSshTransferTotal)
      ) return;
      pending.structuredSshTransferStarted = true;
      pending.lastStructuredSshTransferBytes = progress.transferredBytes;
      if (progress.totalBytes !== undefined) pending.structuredSshTransferTotal = progress.totalBytes;
    }
    pending.lastStructuredSshProgressSequence = progress.sequence;
    try {
      pending.onStructuredSshProgress(progress);
    } catch {
      // Progress is never authority or outcome. A UI/event observer cannot
      // reject, retry, cancel, or otherwise alter the canonical receipt.
    }
  }

  /**
   * Cancel an in-flight dispatch. Ordinary tools retain the historical
   * immediate rejection. A dispatched raw run_shell first forwards cancel,
   * then waits one bounded receipt grace for Electron's canonical cancelled
   * result; mutating Computer Use and Browser frames share their existing
   * canonical-receipt grace, including UI effects such as hover or scroll.
   * Repeated cancel calls do not extend either grace. A dispatched structured
   * SSH frame remains on its existing timeout policy, but a cancel without a
   * synchronously returned canonical result is effect-unknown.
   */
  cancelDispatch(correlationId: string): void {
    const p = this.pending.get(correlationId);
    if (!p) return;
    if (p.effectfulDesktopAutomation && p.dispatched) {
      this.beginDesktopAutomationReceiptGrace(correlationId, p, "cancel");
      return;
    }
    if (p.rawRunShellCommand && p.dispatched) {
      if (p.receiptGraceReason !== undefined) return;
      p.receiptGraceReason = "cancel";
      clearTimeout(p.timer);
      for (const entry of this.relays.values()) {
        if (correlationId.startsWith(entry.relayId + ":")) {
          try {
            entry.send({ type: "relay:cancel", correlationId });
          } catch {
            // The original raw command crossed dispatch. Even an outbound
            // cancel send fault cannot prove the child outcome, so retain the
            // same bounded receipt window rather than inventing cancellation.
          }
          break;
        }
      }
      // A transport may synchronously deliver the final result while sending
      // cancel. In that case resolveDispatch already removed this pending row.
      if (this.pending.get(correlationId) !== p) return;
      p.timer = setTimeout(() => {
        this.expirePendingDispatch(correlationId, p, "cancel", "Dispatch cancelled");
      }, this.runShellResultReceiptGraceMs);
      return;
    }
    if (p.structuredSshDispatch && p.dispatched) {
      // Let a transport that synchronously delivers the canonical result win,
      // but do not add a new SSH receipt grace or alter its timeout policy.
      for (const entry of this.relays.values()) {
        if (correlationId.startsWith(entry.relayId + ":")) {
          try {
            entry.send({ type: "relay:cancel", correlationId });
          } catch {
            // The SSH dispatch already crossed the send seam. A failed cancel
            // cannot prove that the broker did not execute the operation.
          }
          break;
        }
      }
      if (this.pending.get(correlationId) !== p) return;
      clearTimeout(p.timer);
      this.pending.delete(correlationId);
      this.detachPendingAbort(p);
      p.reject(pendingDispatchError(p, "cancel", "Dispatch cancelled"));
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(correlationId);
    this.detachPendingAbort(p);
    p.reject(pendingDispatchError(p, "cancel", "Dispatch cancelled"));

    for (const entry of this.relays.values()) {
      if (correlationId.startsWith(entry.relayId + ":")) {
        entry.send({ type: "relay:cancel", correlationId });
        break;
      }
    }
  }

  private beginDesktopAutomationReceiptGrace(
    correlationId: string,
    pending: PendingDispatch,
    reason: "cancel" | "timeout",
  ): void {
    if (pending.receiptGraceReason !== undefined) return;
    pending.receiptGraceReason = reason;
    clearTimeout(pending.timer);
    for (const entry of this.relays.values()) {
      if (!correlationId.startsWith(entry.relayId + ":")) continue;
      try {
        entry.send({ type: "relay:cancel", correlationId });
      } catch {
        // The mutation crossed the send seam. A failed cancel cannot prove
        // whether Electron applied it, so preserve the canonical-receipt wait.
      }
      break;
    }
    // A synchronous transport may already have delivered the final receipt.
    if (this.pending.get(correlationId) !== pending) return;
    pending.timer = setTimeout(() => {
      this.expirePendingDispatch(
        correlationId,
        pending,
        reason,
        reason === "cancel" ? "Dispatch cancelled" : "Dispatch timed out",
      );
    }, this.desktopAutomationResultReceiptGraceMs);
  }

  listConnected(): Promise<string[]> {
    return Promise.resolve(Array.from(this.relays.keys()));
  }

  /**
   * snapshot the exact currently live relays owned by `userId` whose
   * server-derived pairing generation is one of the rows a completed DB
   * lifecycle transaction revoked. The registry remains the sole live-relay
   * registry; this method deliberately does not unregister or close anything.
   *
   * The caller snapshots before it invalidates Full Workstation sessions and
   * asks the websocket endpoint to close the owned socket. Matching both user
   * and generation prevents an equal opaque row id supplied by another caller
   * from affecting a foreign live relay.
   */
  snapshotLiveRelaysForPairingGenerations(input: {
    userId: string;
    pairingGenerations: readonly string[];
  }): readonly LiveRelayPairingGenerationSnapshot[] {
    const generations = new Set(
      input.pairingGenerations.filter((generation) => generation.length > 0),
    );
    if (generations.size === 0) return [];

    const snapshots: LiveRelayPairingGenerationSnapshot[] = [];
    for (const entry of this.relays.values()) {
      if (
        entry.userId !== input.userId ||
        entry.pairingGeneration === undefined ||
        !generations.has(entry.pairingGeneration)
      ) {
        continue;
      }
      snapshots.push({
        relayId: entry.relayId,
        userId: entry.userId,
        desktopSessionId: entry.desktopSessionId ?? null,
        pairingGeneration: entry.pairingGeneration,
      });
    }
    return snapshots;
  }

  /**
   * bounded, owner-filtered bulk snapshot for remote-host projection.
   * This intentionally returns every exact live match, including duplicate
   * pairing generations: choosing one here would turn a split-brain condition
   * into accidental authority. The server must join these rows to the
   * caller's durable bindings and mark duplicates unavailable/fail closed.
   */
  snapshotForUser(userId: string): RemotePresenceRelaySnapshot[] {
    const snapshots: RemotePresenceRelaySnapshot[] = [];
    for (const entry of this.relays.values()) {
      if (entry.userId !== userId) continue;
      const snapshot = snapshotRemotePresence(entry);
      if (snapshot !== null) snapshots.push(snapshot);
    }
    return snapshots;
  }

  /**
   * exact live, owner-filtered bindings used only to construct a
   * semantic Computer use invocation binding. No API/presence caller receives
   * this tuple. Missing pairing/session identities are excluded instead of
   * guessed; a caller must still reject duplicate exact matches.
   */
  snapshotForComputerUse(userId: string): ComputerUseRelaySnapshot[] {
    const snapshots: ComputerUseRelaySnapshot[] = [];
    for (const entry of this.relays.values()) {
      if (
        entry.userId !== userId
        || entry.capabilities.profile !== "desktop-agent"
        || !entry.pairingGeneration
        || !entry.pairingGenerationRef
        || !entry.desktopSessionId
      ) continue;
      snapshots.push({
        relayId: entry.relayId,
        userId: entry.userId,
        pairingGeneration: entry.pairingGeneration,
        pairingGenerationRef: entry.pairingGenerationRef,
        desktopSessionId: entry.desktopSessionId,
        canControlDesktop: entry.capabilities.canControlDesktop === true,
        desktopAutomation: entry.desktopAutomationSnapshot
          ? structuredClone(entry.desktopAutomationSnapshot)
          : null,
      });
    }
    return snapshots;
  }

  findByCapability(capability: string): string[] {
    const results: string[] = [];
    for (const [id, entry] of this.relays) {
      const caps = entry.capabilities as Record<string, unknown>;
      if (
        caps[capability] === true ||
        (capability === "canUseStructuredSsh" && hasStructuredSshAuthExecReadiness(entry.capabilities)) ||
        (capability === "canUseStructuredSshCopy" && hasStructuredSshCopyReadiness(entry.capabilities)) ||
        (capability === "canConfigureStructuredSsh" && hasConfigurableStructuredSsh(entry.capabilities)) ||
        (capability === "canConfigureStructuredSshCopy" && hasConfigurableStructuredSshCopy(entry.capabilities))
      ) {
        results.push(id);
      }
    }
    return results;
  }

  findByCapabilityForUser(capability: string, userId: string): string[] {
    const results: string[] = [];
    for (const [id, entry] of this.relays) {
      if (entry.userId !== userId) continue;
      const caps = entry.capabilities as Record<string, unknown>;
      if (
        caps[capability] === true ||
        (capability === "canUseStructuredSsh" && hasStructuredSshAuthExecReadiness(entry.capabilities)) ||
        (capability === "canUseStructuredSshCopy" && hasStructuredSshCopyReadiness(entry.capabilities)) ||
        (capability === "canConfigureStructuredSsh" && hasConfigurableStructuredSsh(entry.capabilities)) ||
        (capability === "canConfigureStructuredSshCopy" && hasConfigurableStructuredSshCopy(entry.capabilities))
      ) {
        results.push(id);
      }
    }
    return results;
  }

  updatePresence(relayId: string): void {
    const entry = this.relays.get(relayId);
    if (entry) {
      entry.lastSeen = Date.now();
    }
  }

  /**
   * dedicated outbound route. This bypasses `dispatch` completely so a
   * Codex native operation cannot acquire Tool impact, approval, sandbox, or
   * workstation-grant semantics by accident.
   * @internal Transport only. Never register this raw envelope API as a Genie tool.
   */
  sendCodex(relayId: string, message: RelayCodexServerMessage): RelayCodexRouteResult {
    const entry = this.relays.get(relayId);
    if (!entry || !this.matchesCodexScope(entry, message.scope)) {
      return { ok: false, error: entry ? "CODEX_CONTEXT_STALE" : "CODEX_RELAY_UNAVAILABLE" };
    }
    entry.send(message);
    return { ok: true };
  }

  /**
   * Sends a command and correlates its one exact response. Identical retries
   * share the pending promise or return the retained outcome; a reused id with
   * different content fails closed.
   * @internal Future Genie tools must call CodexRelaySemanticAdapter instead.
   */
  sendCodexCommand(
    relayId: string,
    command: RelayCodexCommandMessage,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<RelayCodexCommandResponseMessage> {
    const entry = this.relays.get(relayId);
    if (!entry) return Promise.reject(new Error("CODEX_RELAY_UNAVAILABLE"));
    if (!this.matchesCodexScope(entry, command.scope)) {
      return Promise.reject(new Error("CODEX_CONTEXT_STALE"));
    }
    this.pruneCodexReplay();
    const key = this.codexCommandKey(command.scope, command.commandId);
    const fingerprint = JSON.stringify(command);
    const outcome = this.codexCommandOutcomes.get(key);
    if (outcome) {
      return outcome.fingerprint === fingerprint
        ? Promise.resolve(outcome.response)
        : Promise.reject(new Error("CODEX_CORRELATION_REPLAY"));
    }
    const existing = this.pendingCodexCommands.get(key);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.reject(new Error("CODEX_CORRELATION_REPLAY"));
    }
    if (this.pendingCodexCommands.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) {
      return Promise.reject(new Error("CODEX_QUEUE_FULL"));
    }
    const timeoutMs = options.timeoutMs ?? 15_000;
    let resolvePromise: (response: RelayCodexCommandResponseMessage) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<RelayCodexCommandResponseMessage>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      this.pendingCodexCommands.delete(key);
      rejectPromise(new Error("CODEX_TIMEOUT"));
    }, timeoutMs);
    this.pendingCodexCommands.set(key, {
      command,
      fingerprint,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
      promise,
    });
    entry.send(command);
    return promise;
  }

  /** Register a private server-side consumer for accepted v8 frames. */
  onCodexMessage(listener: (relayId: string, message: RelayCodexClientMessage) => void): () => void {
    this.codexListeners.add(listener);
    return () => this.codexListeners.delete(listener);
  }

  /**
   * Register a private server-side observer for a relay's Codex-context
   * invalidation. Listeners run synchronously from the canonical cleanup path;
   * an observer failure is isolated so it cannot block fail-closed cleanup.
   */
  onCodexContextInvalidated(
    listener: (relayId: string, errorCode: string) => void,
  ): () => void {
    this.codexContextInvalidationListeners.add(listener);
    return () => this.codexContextInvalidationListeners.delete(listener);
  }

  /**
   * Exact current authenticated desktop-session topology, with no client
   * user-id authority. This is a registry/server seam only: callers must
   * still apply feature-specific admission and authorization policy.
   */
  getAuthenticatedDesktopSession(
    relayId: string,
    userId?: string,
  ): RelayAuthenticatedDesktopSessionSnapshot | null {
    const entry = this.relays.get(relayId);
    if (
      !entry || entry.protocolVersion < CODEX_RELAY_PROTOCOL_VERSION ||
      entry.capabilities.profile !== "desktop-agent" ||
      entry.userId === "" || entry.relaySessionId === undefined || entry.relaySessionId === "" ||
      entry.pairingGenerationRef === undefined || entry.pairingGenerationRef === "" ||
      entry.desktopSessionId === undefined || entry.desktopSessionId === "" ||
      (userId !== undefined && entry.userId !== userId)
    ) return null;
    return {
      relayId: entry.relayId,
      userId: entry.userId,
      relaySessionId: entry.relaySessionId,
      pairingGenerationRef: entry.pairingGenerationRef,
      desktopSessionId: entry.desktopSessionId,
      selectedProtocolVersion: entry.protocolVersion,
      capabilityRevision: entry.capabilityRevision,
    };
  }

  /** Exact authenticated v8 Codex scope/status, with no client user-id authority. */
  getCodexSession(relayId: string, userId?: string): RelayCodexSessionSnapshot | null {
    const session = this.getAuthenticatedDesktopSession(relayId, userId);
    const entry = this.relays.get(relayId);
    if (session === null || entry === undefined || entry.capabilities.codex?.hostKind !== "electron") {
      return null;
    }
    return {
      ...session,
      status: entry.codexStatus ?? null,
    };
  }

  /**
   * Exact current v18 Claude execution socket scope. This is a read-only
   * admission seam: it neither opens nor observes an execution.
   */
  getClaudeExecutionSession(
    relayId: string,
    userId: string,
  ): RelayClaudeExecutionSocketScope | null {
    const session = this.getAuthenticatedDesktopSession(relayId, userId);
    const entry = this.relays.get(relayId);
    return session !== null && entry !== undefined && supportsClaudeExecution(entry)
      ? claudeExecutionScope(session)
      : null;
  }

  /**
   * Current acknowledged Claude Connections route. Until the endpoint has
   * installed the authenticated socket and sent its acknowledgement, this
   * deliberately returns null even when the registered capability is eligible.
   */
  getClaudeConnectionContext(relayId: string, userId?: string): RelayClaudeConnectionContextSnapshot | null {
    const published = this.publishedClaudeConnectionContexts.get(relayId) ?? null;
    if (published === null || (userId !== undefined && published.userId !== userId)) return null;
    const current = this.getCurrentClaudeConnectionContext(relayId, published.userId);
    return current !== null && sameClaudeConnectionContext(published, current) ? current : null;
  }

  /** Current entry eligibility used exclusively to prepare a post-ACK publication. */
  private getCurrentClaudeConnectionContext(
    relayId: string,
    userId?: string,
  ): RelayClaudeConnectionContextSnapshot | null {
    const session = this.getAuthenticatedDesktopSession(relayId, userId);
    const entry = this.relays.get(relayId);
    return session !== null && entry !== undefined && supportsClaudeConnection(entry)
      ? session
      : null;
  }

  /** Claude-specific reconnect/revision seam for a later controller auto-discovery loop. */
  onClaudeConnectionContext(
    listener: (relayId: string, userId: string, context: RelayClaudeConnectionContextSnapshot | null) => void,
  ): () => void {
    this.claudeConnectionContextListeners.add(listener);
    return () => this.claudeConnectionContextListeners.delete(listener);
  }

  /** Endpoint calls this only after its acknowledgement has crossed the active socket seam. */
  publishClaudeConnectionContext(relayId: string, userId: string): boolean {
    const current = this.getCurrentClaudeConnectionContext(relayId, userId);
    if (current === null) return false;
    const previous = this.publishedClaudeConnectionContexts.get(relayId) ?? null;
    this.publishedClaudeConnectionContexts.set(relayId, current);
    this.notifyClaudeConnectionContext(relayId, userId, previous, current);
    return true;
  }

  /** Authenticated ACP readiness session; v13 remains readiness-only. */
  getAcpSession(relayId: string, userId?: string): RelayAcpSessionSnapshot | null {
    const entry = this.relays.get(relayId);
    if (
      !entry || entry.protocolVersion < ACP_RELAY_READINESS_PROTOCOL_VERSION ||
      entry.capabilities.profile !== "desktop-agent" || entry.capabilities.acp?.hostKind !== "electron" ||
      entry.relaySessionId === undefined || entry.pairingGenerationRef === undefined ||
      entry.desktopSessionId === undefined || (userId !== undefined && entry.userId !== userId)
    ) return null;
    return {
      relayId: entry.relayId,
      userId: entry.userId,
      relaySessionId: entry.relaySessionId,
      pairingGenerationRef: entry.pairingGenerationRef,
      desktopSessionId: entry.desktopSessionId,
      selectedProtocolVersion: entry.protocolVersion,
      capabilityRevision: entry.capabilityRevision,
    };
  }

  /** Registration-aware authenticated session lookup. OpenCode is a v15-only
   * family; Hermes retains its original v13 readiness lookup. */
  getAcpSessionForRegistration(
    relayId: string,
    userId: string,
    registrationId: AcpRegistrationId,
  ): RelayAcpSessionSnapshot | null {
    const session = this.getAcpSession(relayId, userId);
    const entry = this.relays.get(relayId);
    return session && entry && supportsAcpRegistration(entry, registrationId, false)
      ? session
      : null;
  }

  /**
   * One bounded, server-correlated v17 account/catalog discovery request.
   * This is transport state only: its result is not persisted or projected.
   */
  requestClaudeConnectionDiscovery(input: {
    relayId: string;
    userId: string;
    profileRef: string;
    timeoutMs?: number;
  }): Promise<RelayClaudeConnectionDiscoveryResult> {
    if (!isClaudeConnectionUuid(input.profileRef) || !isBoundedClaudeConnectionTimeout(input.timeoutMs)) {
      return Promise.reject(new Error("CLAUDE_CONNECTION_REQUEST_INVALID"));
    }
    const session = this.getAuthenticatedDesktopSession(input.relayId, input.userId);
    const entry = this.relays.get(input.relayId);
    const published = this.publishedClaudeConnectionContexts.get(input.relayId) ?? null;
    if (!session || !entry || !supportsClaudeConnection(entry) || published === null || !sameClaudeConnectionContext(published, session)) {
      return Promise.reject(new Error("CLAUDE_CONNECTION_UNAVAILABLE"));
    }
    const scope = claudeConnectionScope(published);
    const key = this.claudeConnectionDiscoveryKey(scope, input.profileRef);
    const existing = this.pendingClaudeConnectionDiscoveries.get(key);
    if (existing) return existing.promise;
    const command: RelayClaudeConnectionDiscoverCommand = {
      type: "relay:claude-connection-discover",
      version: CLAUDE_CONNECTION_PROTOCOL_VERSION,
      correlationId: randomUUID(),
      scope,
      profileRef: input.profileRef,
    };
    const parsedCommand = parseRelayClaudeConnectionDiscoverCommand(command);
    if (parsedCommand === null) return Promise.reject(new Error("CLAUDE_CONNECTION_REQUEST_INVALID"));
    const fingerprint = JSON.stringify(parsedCommand);
    if (this.pendingClaudeConnectionDiscoveries.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) {
      return Promise.reject(new Error("CLAUDE_CONNECTION_QUEUE_FULL"));
    }
    let resolvePromise: (result: RelayClaudeConnectionDiscoveryResult) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<RelayClaudeConnectionDiscoveryResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      this.pendingClaudeConnectionDiscoveries.delete(key);
      rejectPromise(new Error("CLAUDE_CONNECTION_TIMEOUT"));
    }, input.timeoutMs ?? CLAUDE_CONNECTION_DISCOVERY_TIMEOUT_MS);
    this.pendingClaudeConnectionDiscoveries.set(key, {
      relayId: entry.relayId,
      command: parsedCommand,
      fingerprint,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
      promise,
    });
    try {
      entry.send(parsedCommand);
    } catch {
      clearTimeout(timer);
      this.pendingClaudeConnectionDiscoveries.delete(key);
      rejectPromise(new Error("CLAUDE_CONNECTION_UNAVAILABLE"));
    }
    return promise;
  }

  /** Endpoint-only inbound result admission. Never writes connection state. */
  acceptClaudeConnectionDiscoveryResult(input: {
    relayId: string;
    userId: string;
    message: RelayClaudeConnectionDiscoveryResult;
  }): RelayClaudeConnectionRouteResult {
    let message: RelayClaudeConnectionDiscoveryResult | null = null;
    try {
      message = parseRelayClaudeConnectionDiscoveryResult(
        JSON.parse(JSON.stringify(input.message)) as unknown,
      );
    } catch {
      message = null;
    }
    const entry = this.relays.get(input.relayId);
    if (!entry || entry.userId !== input.userId || !supportsClaudeConnection(entry) || message === null || !this.matchesClaudeConnectionScope(entry, message.scope)) {
      return { ok: false, error: entry ? "CLAUDE_CONNECTION_CONTEXT_STALE" : "CLAUDE_CONNECTION_UNAVAILABLE" };
    }
    const key = this.claudeConnectionDiscoveryKey(message.scope, message.profileRef);
    const pending = this.pendingClaudeConnectionDiscoveries.get(key);
    if (!pending || pending.command.correlationId !== message.correlationId || pending.command.profileRef !== message.profileRef || !sameClaudeConnectionScope(pending.command.scope, message.scope)) {
      return { ok: false, error: "CLAUDE_CONNECTION_CORRELATION_REPLAY" };
    }
    clearTimeout(pending.timer);
    this.pendingClaudeConnectionDiscoveries.delete(key);
    pending.resolve(message);
    entry.lastSeen = Date.now();
    return { ok: true };
  }

  /**
   * Opens one non-durable Claude execution lane on the relay's current v18
   * Desktop socket. The Desktop host owns execution semantics; this registry
   * only binds the two wire frames to the authenticated socket lifetime.
   */
  openClaudeExecution(input: {
    relayId: string;
    userId: string;
    prompt: string;
    model: string;
    /** CAS fence from the controller's just-admitted v18 execution session. */
    expectedScope: RelayClaudeExecutionSocketScope;
  }): RelayClaudeExecutionOpenResult {
    const captured = captureClaudeExecutionOpenInput(input);
    if (captured === null) return frozenClaudeExecutionOpenFailure("CLAUDE_EXECUTION_INVALID");
    const entry = this.relays.get(captured.relayId);
    if (entry === undefined || !supportsClaudeExecution(entry)) {
      return frozenClaudeExecutionOpenFailure("CLAUDE_EXECUTION_UNAVAILABLE");
    }
    const session = this.getAuthenticatedDesktopSession(captured.relayId, captured.userId);
    if (session === null) return frozenClaudeExecutionOpenFailure("CLAUDE_EXECUTION_CONTEXT_STALE");
    const scope = claudeExecutionScope(session);
    // Bind controller admission to the same authenticated socket snapshot
    // before observing lane occupancy or minting/sending a start command.
    if (!sameClaudeExecutionScope(captured.expectedScope, scope)) {
      return frozenClaudeExecutionOpenFailure("CLAUDE_EXECUTION_CONTEXT_STALE");
    }
    const previous = this.activeClaudeExecutions.get(entry.relayId);
    if (previous !== undefined && !previous.streamClosed) {
      return frozenClaudeExecutionOpenFailure("CLAUDE_EXECUTION_BUSY");
    }

    const executionRef = randomUUID();
    const command = parseRelayClaudeExecutionCommand({
      type: "relay:claude-execution-command",
      scope,
      executionRef,
      action: { kind: "start", prompt: captured.prompt, model: captured.model },
    });
    if (command === null) return frozenClaudeExecutionOpenFailure("CLAUDE_EXECUTION_INVALID");

    if (previous?.streamClosed) {
      // Only an admitted successor supersedes the old receipt. Invalid new
      // input cannot cancel it. No live execution or lane is held by this wait.
      previous.steerWaiter?.reject(new Error("CLAUDE_EXECUTION_CONTEXT_STALE"));
      previous.steerWaiter = null;
      this.retireClaudeExecution(previous);
    }

    const active: ActiveClaudeExecution = {
      relayId: entry.relayId,
      userId: entry.userId,
      connectionGeneration: entry.connectionGeneration,
      scope: command.scope,
      executionRef: command.executionRef,
      queue: [],
      firstEvent: true,
      streamClosed: false,
      streamError: null,
      overflowed: false,
      interactionRef: null,
      interactionDelivered: false,
      nextWaiter: null,
      responseWaiter: null,
      interruptWaiter: null,
      steerWaiter: null,
    };
    this.activeClaudeExecutions.set(active.relayId, active);
    try {
      entry.send(command);
    } catch {
      this.clearClaudeExecutionState(active.relayId, "CLAUDE_EXECUTION_UNAVAILABLE");
      return frozenClaudeExecutionOpenFailure("CLAUDE_EXECUTION_UNAVAILABLE");
    }

    const control: RelayClaudeExecutionControl = Object.freeze({
      executionRef: active.executionRef,
      next: () => this.nextClaudeExecution(active),
      respond: (interactionRef: string, response: RelayClaudeExecutionResponse) =>
        this.respondClaudeExecution(active, interactionRef, response),
      steer: (prompt: string) => this.steerClaudeExecution(active, prompt),
      interrupt: () => this.interruptClaudeExecution(active),
    });
    return Object.freeze({ ok: true as const, control });
  }

  /** Endpoint-only admission for one strict-parsed current-socket event. */
  acceptClaudeExecutionEvent(input: {
    relayId: string;
    userId: string;
    message: RelayClaudeExecutionDesktopEvent;
  }): RelayClaudeExecutionRouteResult {
    let relayId: string;
    let userId: string;
    let message: RelayClaudeExecutionDesktopEvent | null;
    try {
      relayId = input.relayId;
      userId = input.userId;
      message = parseRelayClaudeExecutionDesktopEvent(input.message);
    } catch {
      return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
    }
    if (message === null) return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
    const entry = this.relays.get(relayId);
    const active = this.activeClaudeExecutions.get(relayId);
    if (entry === undefined || active === undefined || entry.userId !== userId || !this.isCurrentClaudeExecution(active, entry)) {
      return frozenClaudeExecutionRouteFailure(entry === undefined ? "CLAUDE_EXECUTION_UNAVAILABLE" : "CLAUDE_EXECUTION_CONTEXT_STALE");
    }
    if (message.executionRef !== active.executionRef || !sameClaudeExecutionScope(message.scope, active.scope)) {
      return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_CONTEXT_STALE");
    }
    return this.acceptCurrentClaudeExecutionEvent(active, message.event);
  }

  private nextClaudeExecution(active: ActiveClaudeExecution): Promise<RelayClaudeExecutionEvent | null> {
    if (active.streamError !== null) return Promise.reject(active.streamError);
    const next = active.queue.shift() ?? null;
    if (next !== null) {
      this.noteDeliveredClaudeExecutionEvent(active, next);
      return Promise.resolve(next);
    }
    if (active.streamClosed) return Promise.resolve(null);
    if (active.nextWaiter !== null) return Promise.reject(new Error("CLAUDE_EXECUTION_NEXT_PENDING"));
    return new Promise<RelayClaudeExecutionEvent | null>((resolve, reject) => {
      active.nextWaiter = { resolve, reject };
    });
  }

  private respondClaudeExecution(
    active: ActiveClaudeExecution,
    interactionRef: string,
    response: RelayClaudeExecutionResponse,
  ): Promise<"accepted" | "rejected"> {
    if (
      active.streamClosed || active.streamError !== null ||
      !active.interactionDelivered || active.interactionRef !== interactionRef || active.responseWaiter !== null
    ) return Promise.reject(new Error("CLAUDE_EXECUTION_CONTEXT_STALE"));
    const command = parseRelayClaudeExecutionCommand({
      type: "relay:claude-execution-command",
      scope: active.scope,
      executionRef: active.executionRef,
      action: { kind: "respond", interactionRef, response },
    });
    if (command === null) return Promise.reject(new Error("CLAUDE_EXECUTION_INVALID"));
    let resolvePromise: (outcome: "accepted" | "rejected") => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<"accepted" | "rejected">((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    active.responseWaiter = { interactionRef, resolve: resolvePromise, reject: rejectPromise, promise };
    if (!this.sendCurrentClaudeExecutionCommand(active, command)) {
      this.clearClaudeExecutionState(active.relayId, "CLAUDE_EXECUTION_CONTEXT_STALE");
    }
    return promise;
  }

  private interruptClaudeExecution(
    active: ActiveClaudeExecution,
    allowOverflowedStream = false,
  ): Promise<"acknowledged" | "uncertain"> {
    if (active.interruptWaiter !== null) return active.interruptWaiter.promise;
    if (active.streamClosed || (!allowOverflowedStream && active.streamError !== null) || !this.isCurrentClaudeExecution(active)) {
      return Promise.reject(new Error("CLAUDE_EXECUTION_CONTEXT_STALE"));
    }
    const command = parseRelayClaudeExecutionCommand({
      type: "relay:claude-execution-command",
      scope: active.scope,
      executionRef: active.executionRef,
      action: { kind: "interrupt" },
    });
    if (command === null) return Promise.reject(new Error("CLAUDE_EXECUTION_INVALID"));
    let resolvePromise: (outcome: "acknowledged" | "uncertain") => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<"acknowledged" | "uncertain">((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    active.interruptWaiter = { resolve: resolvePromise, reject: rejectPromise, promise, receiptReceived: false };
    if (!this.sendCurrentClaudeExecutionCommand(active, command)) {
      this.clearClaudeExecutionState(active.relayId, "CLAUDE_EXECUTION_UNAVAILABLE");
    }
    return promise;
  }

  private steerClaudeExecution(active: ActiveClaudeExecution, prompt: string): Promise<"accepted"> {
    if (active.firstEvent || active.streamClosed || active.streamError !== null || !this.isCurrentClaudeExecution(active)) {
      return Promise.reject(new Error("CLAUDE_EXECUTION_CONTEXT_STALE"));
    }
    if (active.steerWaiter !== null) return Promise.reject(new Error("CLAUDE_EXECUTION_STEER_PENDING"));
    const command = parseRelayClaudeExecutionCommand({
      type: "relay:claude-execution-command",
      scope: active.scope,
      executionRef: active.executionRef,
      action: { kind: "steer", steerRef: randomUUID(), prompt },
    });
    if (command === null || command.action.kind !== "steer") return Promise.reject(new Error("CLAUDE_EXECUTION_INVALID"));
    let resolvePromise: (outcome: "accepted") => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<"accepted">((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    active.steerWaiter = { steerRef: command.action.steerRef, resolve: resolvePromise, reject: rejectPromise, promise };
    if (!this.sendCurrentClaudeExecutionCommand(active, command)) {
      this.clearClaudeExecutionState(active.relayId, "CLAUDE_EXECUTION_UNAVAILABLE");
    }
    return promise;
  }

  private acceptCurrentClaudeExecutionEvent(
    active: ActiveClaudeExecution,
    event: RelayClaudeExecutionEvent,
  ): RelayClaudeExecutionRouteResult {
    if (active.streamClosed) {
      // Only an admitted, exactly correlated receipt can outlive the stream.
      if (event.kind === "steer_receipt") return this.acceptClaudeExecutionSteerReceipt(active, event);
      return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
    }
    if (active.overflowed) {
      if (event.kind === "steer_receipt") return this.acceptClaudeExecutionSteerReceipt(active, event);
      if (event.kind === "interrupt_receipt") return this.acceptClaudeExecutionInterruptReceipt(active, event);
      if (event.kind === "settled") {
        this.finishClaudeExecutionStream(active);
        return Object.freeze({ ok: true as const });
      }
      return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
    }
    if (active.firstEvent) {
      if (event.kind !== "started" && event.kind !== "unavailable") {
        return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
      }
      active.firstEvent = false;
      this.enqueueClaudeExecutionEvent(active, event);
      if (event.kind === "unavailable") this.finishClaudeExecutionStream(active);
      return Object.freeze({ ok: true as const });
    }
    if (event.kind === "started" || event.kind === "unavailable") {
      return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
    }
    if (event.kind === "interaction_accepted" || event.kind === "interaction_rejected") {
      const waiter = active.responseWaiter;
      if (waiter === null || waiter.interactionRef !== event.interactionRef) {
        return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
      }
      active.responseWaiter = null;
      active.interactionRef = null;
      active.interactionDelivered = false;
      waiter.resolve(event.kind === "interaction_accepted" ? "accepted" : "rejected");
      return Object.freeze({ ok: true as const });
    }
    if (event.kind === "interrupt_receipt") return this.acceptClaudeExecutionInterruptReceipt(active, event);
    if (event.kind === "steer_receipt") return this.acceptClaudeExecutionSteerReceipt(active, event);
    if (event.kind === "interaction") {
      if (active.interactionRef !== null) return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
      active.interactionRef = event.interaction.interactionRef;
      active.interactionDelivered = false;
    }
    this.enqueueClaudeExecutionEvent(active, event);
    if (event.kind === "settled") this.finishClaudeExecutionStream(active);
    return Object.freeze({ ok: true as const });
  }

  private acceptClaudeExecutionInterruptReceipt(
    active: ActiveClaudeExecution,
    event: Extract<RelayClaudeExecutionEvent, { kind: "interrupt_receipt" }>,
  ): RelayClaudeExecutionRouteResult {
    const waiter = active.interruptWaiter;
    if (waiter === null || waiter.receiptReceived) {
      return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
    }
    waiter.receiptReceived = true;
    waiter.resolve(event.outcome);
    return Object.freeze({ ok: true as const });
  }

  private acceptClaudeExecutionSteerReceipt(
    active: ActiveClaudeExecution,
    event: Extract<RelayClaudeExecutionEvent, { kind: "steer_receipt" }>,
  ): RelayClaudeExecutionRouteResult {
    const waiter = active.steerWaiter;
    if (waiter === null || waiter.steerRef !== event.steerRef) {
      return frozenClaudeExecutionRouteFailure("CLAUDE_EXECUTION_PROTOCOL_INVALID");
    }
    active.steerWaiter = null;
    if (event.outcome === "accepted") waiter.resolve("accepted");
    else waiter.reject(new Error("CLAUDE_EXECUTION_STEER_REJECTED"));
    if (active.streamClosed) this.retireClaudeExecution(active);
    return Object.freeze({ ok: true as const });
  }

  private enqueueClaudeExecutionEvent(active: ActiveClaudeExecution, event: RelayClaudeExecutionEvent): void {
    const waiter = active.nextWaiter;
    if (waiter !== null) {
      active.nextWaiter = null;
      this.noteDeliveredClaudeExecutionEvent(active, event);
      waiter.resolve(event);
      return;
    }
    if (active.queue.length >= CLAUDE_EXECUTION_MAX_QUEUED_EVENTS) {
      this.overflowClaudeExecution(active);
      return;
    }
    active.queue.push(event);
  }

  private noteDeliveredClaudeExecutionEvent(active: ActiveClaudeExecution, event: RelayClaudeExecutionEvent): void {
    if (event.kind === "interaction" && active.interactionRef === event.interaction.interactionRef) {
      active.interactionDelivered = true;
    }
  }

  private overflowClaudeExecution(active: ActiveClaudeExecution): void {
    active.overflowed = true;
    active.queue.length = 0;
    active.interactionRef = null;
    active.interactionDelivered = false;
    const error = new Error("CLAUDE_EXECUTION_BACKPRESSURE");
    active.streamError = error;
    if (active.nextWaiter !== null) {
      active.nextWaiter.reject(error);
      active.nextWaiter = null;
    }
    if (active.responseWaiter !== null) {
      active.responseWaiter.reject(error);
      active.responseWaiter = null;
    }
    void this.interruptClaudeExecution(active, true).catch(() => undefined);
  }

  private finishClaudeExecutionStream(active: ActiveClaudeExecution): void {
    active.streamClosed = true;
    if (active.responseWaiter !== null) {
      active.responseWaiter.reject(new Error("CLAUDE_EXECUTION_CONTEXT_STALE"));
      active.responseWaiter = null;
    }
    if (active.interruptWaiter !== null && !active.interruptWaiter.receiptReceived) {
      active.interruptWaiter.resolve("uncertain");
      active.interruptWaiter.receiptReceived = true;
    }
    if (active.interruptWaiter !== null) {
      active.interruptWaiter = null;
    }
    // Keep the existing single receipt owner on this authenticated socket,
    // not a live execution or replay history. Receipt, successor admission or
    // socket/capability invalidation retires it. Stream reads already see EOF.
    if (active.steerWaiter === null) this.retireClaudeExecution(active);
  }

  private retireClaudeExecution(active: ActiveClaudeExecution): void {
    if (this.activeClaudeExecutions.get(active.relayId) === active) {
      this.activeClaudeExecutions.delete(active.relayId);
    }
  }

  private clearClaudeExecutionState(relayId: string, errorCode: string): void {
    const active = this.activeClaudeExecutions.get(relayId);
    if (active === undefined) return;
    this.activeClaudeExecutions.delete(relayId);
    if (active.streamClosed) {
      // Disconnect invalidates the unresolved receipt, not an already received
      // authoritative result still queued for its existing stream consumer.
      active.steerWaiter?.reject(new Error(errorCode));
      active.steerWaiter = null;
      return;
    }
    active.queue.length = 0;
    active.streamClosed = true;
    active.streamError = new Error(errorCode);
    active.interactionRef = null;
    active.interactionDelivered = false;
    if (active.nextWaiter !== null) {
      active.nextWaiter.reject(active.streamError);
      active.nextWaiter = null;
    }
    if (active.responseWaiter !== null) {
      active.responseWaiter.reject(active.streamError);
      active.responseWaiter = null;
    }
    if (active.interruptWaiter !== null && !active.interruptWaiter.receiptReceived) {
      active.interruptWaiter.reject(active.streamError);
    }
    if (active.interruptWaiter !== null) {
      active.interruptWaiter = null;
    }
    if (active.steerWaiter !== null) {
      active.steerWaiter.reject(active.streamError);
      active.steerWaiter = null;
    }
  }

  private isCurrentClaudeExecution(active: ActiveClaudeExecution, entry?: RelayEntry): boolean {
    const current = entry ?? this.relays.get(active.relayId);
    return current !== undefined && this.activeClaudeExecutions.get(active.relayId) === active &&
      current.connectionGeneration === active.connectionGeneration && current.userId === active.userId &&
      supportsClaudeExecution(current) && sameClaudeExecutionScope(claudeExecutionScopeFromEntry(current), active.scope);
  }

  private sendCurrentClaudeExecutionCommand(
    active: ActiveClaudeExecution,
    command: RelayClaudeExecutionCommand,
  ): boolean {
    const entry = this.relays.get(active.relayId);
    if (entry === undefined || !this.isCurrentClaudeExecution(active, entry) || !sameClaudeExecutionScope(command.scope, active.scope)) return false;
    try {
      entry.send(command);
      return true;
    } catch {
      return false;
    }
  }

  /** One bounded, correlated readiness probe for a built-in ACP registration. */
  requestAcpReadiness(input: {
    relayId: string;
    userId: string;
    requestId: string;
    registrationId: AcpRegistrationId;
    timeoutMs?: number;
  }): Promise<AcpReadinessState> {
    if (!isBoundedAcpOpaqueId(input.requestId)) return Promise.reject(new Error("ACP_REQUEST_INVALID"));
    if (!isBoundedAcpReadinessTimeout(input.timeoutMs, input.registrationId)) {
      return Promise.reject(new Error("ACP_REQUEST_INVALID"));
    }
    const session = this.getAcpSession(input.relayId, input.userId);
    if (!session) return Promise.reject(new Error("ACP_RELAY_UNAVAILABLE"));
    const entry = this.relays.get(input.relayId);
    const registrations = entry?.capabilities.acp?.registrations;
    if (!entry || !registrations?.some((registrationId) => registrationId === input.registrationId)
      || (input.registrationId === "opencode-acp"
        && session.selectedProtocolVersion < OPENCODE_ACP_RELAY_PROTOCOL_VERSION)) {
      return Promise.reject(new Error("ACP_RELAY_UNAVAILABLE"));
    }
    const command: RelayAcpReadinessCommand = {
      type: "relay:acp-readiness",
      requestId: input.requestId,
      registrationId: input.registrationId,
      scope: {
        relayId: session.relayId,
        relaySessionId: session.relaySessionId,
        desktopSessionId: session.desktopSessionId,
        pairingGenerationRef: session.pairingGenerationRef,
        selectedProtocolVersion: session.selectedProtocolVersion,
        capabilityRevision: session.capabilityRevision,
      },
    };
    const key = `acp:${JSON.stringify(command.registrationId)}:${this.codexScopeKey(command.scope)}:${JSON.stringify(command.requestId)}`;
    const fingerprint = JSON.stringify(command);
    const existing = this.pendingAcpReadiness.get(key);
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.reject(new Error("ACP_CORRELATION_REPLAY"));
    if (this.pendingAcpReadiness.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) return Promise.reject(new Error("ACP_QUEUE_FULL"));
    let resolvePromise: (state: AcpReadinessState) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<AcpReadinessState>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const timer = setTimeout(() => {
      this.pendingAcpReadiness.delete(key);
      rejectPromise(new Error("ACP_TIMEOUT"));
    }, input.timeoutMs ?? acpReadinessTimeoutMs(input.registrationId));
    this.pendingAcpReadiness.set(key, {
      relayId: session.relayId,
      scope: command.scope,
      command,
      fingerprint,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
      promise,
    });
    try {
      entry.send(command);
    } catch {
      clearTimeout(timer);
      this.pendingAcpReadiness.delete(key);
      rejectPromise(new Error("ACP_RELAY_UNAVAILABLE"));
    }
    return promise;
  }

  /** Server-private preparation primitive. Slice 3 supplies canonical binding/job authority. */
  requestAcpPrepare(input: {
    relayId: string; userId: string; requestId: string; binding: AcpBindingScope; timeoutMs?: number;
    registrationId?: AcpRegistrationId;
  }): Promise<AcpWorkspaceReceipt> {
    if (!isBoundedAcpOpaqueId(input.requestId) || !isRelayAcpBindingScope(input.binding) || !isBoundedAcpPrepareTimeout(input.timeoutMs)) return Promise.reject(new Error("ACP_REQUEST_INVALID"));
    const registrationId = input.registrationId ?? "hermes-acp";
    const session = this.getAcpSession(input.relayId, input.userId);
    const entry = this.relays.get(input.relayId);
    if (!session || !entry || !supportsAcpRegistration(entry, registrationId, true)) return Promise.reject(new Error("ACP_RELAY_UNAVAILABLE"));
    const command: RelayAcpPrepareCommand = { type: "relay:acp-prepare", requestId: input.requestId, registrationId, scope: acpSocket(session), binding: input.binding };
    const key = `acp-prepare:${JSON.stringify(command.registrationId)}:${this.codexScopeKey(command.scope)}:${JSON.stringify(command.requestId)}`;
    const fingerprint = JSON.stringify(command);
    const existing = this.pendingAcpPrepares.get(key);
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.reject(new Error("ACP_CORRELATION_REPLAY"));
    if (this.pendingAcpPrepares.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) return Promise.reject(new Error("ACP_QUEUE_FULL"));
    let resolvePromise: (workspace: AcpWorkspaceReceipt) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<AcpWorkspaceReceipt>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const timer = setTimeout(() => { this.pendingAcpPrepares.delete(key); rejectPromise(new Error("ACP_TIMEOUT")); }, input.timeoutMs ?? 5_000);
    this.pendingAcpPrepares.set(key, { relayId: input.relayId, command, fingerprint, resolve: resolvePromise, reject: rejectPromise, timer, promise });
    try { entry.send(command); } catch { clearTimeout(timer); this.pendingAcpPrepares.delete(key); rejectPromise(new Error("ACP_RELAY_UNAVAILABLE")); }
    return promise;
  }

  /** Starts only a receipt that the same exact v14 relay previously prepared. */
  requestAcpStart(input: {
    relayId: string; userId: string; scope: AcpExecutionScope; prompt: string; timeoutMs?: number;
    registrationId?: "hermes-acp"; executionProfile?: never;
  } | {
    relayId: string; userId: string; scope: AcpExecutionScope; prompt: string; timeoutMs?: number;
    registrationId: "opencode-acp"; executionProfile: AcpExecutionProfile;
  }): Promise<RelayAcpStartedResult> {
    if (!isBoundedAcpStartTimeout(input.timeoutMs, input.registrationId ?? "hermes-acp") || !isBoundedAcpPrompt(input.prompt)
      || (input.registrationId === "opencode-acp" && !isAcpExecutionProfile(input.executionProfile))
      || (input.registrationId !== "opencode-acp" && input.executionProfile !== undefined)) return Promise.reject(new Error("ACP_REQUEST_INVALID"));
    const registrationId = input.registrationId ?? "hermes-acp";
    const session = this.getAcpSession(input.relayId, input.userId);
    const scopeKey = acpExecutionScopeKey(registrationId, input.scope);
    const prepared = this.preparedAcpExecutions.get(scopeKey);
    const entry = this.relays.get(input.relayId);
    if (!session || !entry || !supportsAcpRegistration(entry, registrationId, true) || !prepared || prepared.registrationId !== registrationId || prepared.relayId !== input.relayId || prepared.expiresAt <= Date.now() || !sameAcpExecutionScope(prepared.scope, input.scope) || !sameAcpSocketScope(acpSocket(session), input.scope.socket)) return Promise.reject(new Error("ACP_CONTEXT_STALE"));
    const command: RelayAcpStartCommand = input.registrationId === "opencode-acp"
      ? { type: "relay:acp-start", registrationId: "opencode-acp", scope: input.scope, prompt: input.prompt, executionProfile: input.executionProfile }
      : { type: "relay:acp-start", registrationId: "hermes-acp", scope: input.scope, prompt: input.prompt };
    const key = `acp-start:${scopeKey}`;
    const fingerprint = JSON.stringify(command);
    const existing = this.pendingAcpStarts.get(key);
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : Promise.reject(new Error("ACP_CORRELATION_REPLAY"));
    if (this.pendingAcpStarts.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) return Promise.reject(new Error("ACP_QUEUE_FULL"));
    let resolvePromise: (started: RelayAcpStartedResult) => void = () => undefined;
    let rejectPromise: (error: Error) => void = () => undefined;
    const promise = new Promise<RelayAcpStartedResult>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const timer = setTimeout(() => { this.pendingAcpStarts.delete(key); rejectPromise(new Error("ACP_TIMEOUT")); }, input.timeoutMs ?? acpExecutionStartTimeoutMs(registrationId));
    this.pendingAcpStarts.set(key, { relayId: input.relayId, command, fingerprint, resolve: resolvePromise, reject: rejectPromise, timer, promise });
    try { entry.send(command); } catch { clearTimeout(timer); this.pendingAcpStarts.delete(key); rejectPromise(new Error("ACP_RELAY_UNAVAILABLE")); }
    return promise;
  }

  /** Slice 3 consumes this bounded typed stream; it never exposes raw ACP. */
  subscribeAcpExecution(scope: AcpExecutionScope, process: AcpProcessScope, registrationId: AcpRegistrationId = "hermes-acp"): RelayAcpExecutionSubscription | null {
    const turn = this.acpTurns.get(acpTurnKey(registrationId, scope, process));
    if (!turn || turn.subscriberAttached) return null;
    if (turn.faultRetentionTimer !== undefined) {
      clearTimeout(turn.faultRetentionTimer);
      turn.faultRetentionTimer = undefined;
    }
    const semanticHistory = turn.retained.filter((event): event is RelayAcpSemanticEvent => event.type === "relay:acp-semantic");
    turn.retained.length = 0;
    turn.retainedBytes = 0;
    const subscriber: AcpSubscriber = { queue: semanticHistory, inFlight: new Map(), queuedBytes: semanticHistory.reduce((total, event) => total + acpEventBytes(event), 0), inFlightBytes: 0, waiter: null, nextPending: false, terminalDelivered: false, closed: false };
    turn.subscribers.add(subscriber);
    turn.subscriberAttached = true;
    return this.createAcpSubscription(turn, subscriber);
  }

  /** Exact broker-owned fault containment; never guesses from an uncorrelated frame. */
  containAcpExecution(scope: AcpExecutionScope, process: AcpProcessScope, registrationId: AcpRegistrationId = "hermes-acp"): boolean {
    const turn = this.acpTurns.get(acpTurnKey(registrationId, scope, process));
    if (!turn || !sameAcpExecutionScope(turn.scope, scope) || !sameAcpProcessScope(turn.process, process)) return false;
    return this.faultAcpTurn(turn);
  }

  acceptAcpMessage(input: { relayId: string; userId: string; message: RelayAcpClientMessage }): RelayAcpRouteResult {
    const message = input.message;
    if (message.type === "relay:acp-prepared") return this.acceptAcpPrepared({ ...input, message });
    if (message.type === "relay:acp-started") return this.acceptAcpStarted({ ...input, message });
    if (message.type === "relay:acp-start-failed") return this.acceptAcpStartFailed({ ...input, message });
    if (message.type === "relay:acp-semantic" || message.type === "relay:acp-terminal") return this.acceptAcpTurnEvent({ ...input, message });
    if (message.type !== "relay:acp-readiness-result") return { ok: false, error: "ACP_CORRELATION_REPLAY" };
    const entry = this.relays.get(input.relayId);
    if (!entry || entry.userId !== input.userId) return { ok: false, error: "ACP_RELAY_UNAVAILABLE" };
    if (!this.matchesAcpScope(entry, message.scope, ACP_RELAY_READINESS_PROTOCOL_VERSION)) return { ok: false, error: "ACP_CONTEXT_STALE" };
    const key = `acp:${JSON.stringify(message.registrationId)}:${this.codexScopeKey(message.scope)}:${JSON.stringify(message.requestId)}`;
    const pending = this.pendingAcpReadiness.get(key);
    if (!pending || !isRelayAcpReadinessResultForCommand(pending.command, message)) return { ok: false, error: "ACP_CORRELATION_REPLAY" };
    clearTimeout(pending.timer);
    this.pendingAcpReadiness.delete(key);
    pending.resolve(message.state);
    entry.lastSeen = Date.now();
    return { ok: true };
  }

  private acceptAcpPrepared(input: { relayId: string; userId: string; message: RelayAcpPreparedResult }): RelayAcpRouteResult {
    const entry = this.relays.get(input.relayId);
    if (!entry || entry.userId !== input.userId || !supportsAcpRegistration(entry, input.message.registrationId, true) || !this.matchesAcpScope(entry, input.message.scope, ACP_RELAY_PROTOCOL_VERSION)) return { ok: false, error: "ACP_CONTEXT_STALE" };
    const key = `acp-prepare:${JSON.stringify(input.message.registrationId)}:${this.codexScopeKey(input.message.scope)}:${JSON.stringify(input.message.requestId)}`;
    const pending = this.pendingAcpPrepares.get(key);
    if (!pending || pending.command.registrationId !== input.message.registrationId || !sameAcpSocketScope(pending.command.scope, input.message.scope) || !sameAcpBindingScope(pending.command.binding, input.message.binding)) return { ok: false, error: "ACP_CORRELATION_REPLAY" };
    if (Date.parse(input.message.workspace.workspaceExpiresAt) <= Date.now()) return { ok: false, error: "ACP_CONTEXT_STALE" };
    clearTimeout(pending.timer);
    this.pendingAcpPrepares.delete(key);
    const scope: AcpExecutionScope = { socket: input.message.scope, binding: input.message.binding, workspace: input.message.workspace };
    this.putBounded(this.preparedAcpExecutions, acpExecutionScopeKey(input.message.registrationId, scope), { relayId: input.relayId, registrationId: input.message.registrationId, scope, expiresAt: Date.parse(input.message.workspace.workspaceExpiresAt) });
    pending.resolve(input.message.workspace);
    entry.lastSeen = Date.now();
    return { ok: true };
  }

  private acceptAcpStarted(input: { relayId: string; userId: string; message: RelayAcpStartedResult }): RelayAcpRouteResult {
    const entry = this.relays.get(input.relayId);
    if (!entry || entry.userId !== input.userId || !supportsAcpRegistration(entry, input.message.registrationId, true) || !this.matchesAcpScope(entry, input.message.scope.socket, ACP_RELAY_PROTOCOL_VERSION)) return { ok: false, error: "ACP_CONTEXT_STALE" };
    const key = `acp-start:${acpExecutionScopeKey(input.message.registrationId, input.message.scope)}`;
    const pending = this.pendingAcpStarts.get(key);
    const turnKey = acpTurnKey(input.message.registrationId, input.message.scope, input.message.process);
    const duplicateTurn = this.acpTurns.get(turnKey);
    if (!pending || pending.command.registrationId !== input.message.registrationId || !sameAcpExecutionScope(pending.command.scope, input.message.scope)) {
      if (duplicateTurn && sameAcpExecutionScope(duplicateTurn.scope, input.message.scope) && sameAcpProcessScope(duplicateTurn.process, input.message.process)) this.faultAcpTurn(duplicateTurn);
      return { ok: false, error: "ACP_CORRELATION_REPLAY" };
    }
    if (input.message.eventSequence !== 1) return { ok: false, error: "ACP_EVENT_OUT_OF_ORDER" };
    const existingTurn = this.acpTurns.get(turnKey);
    if (existingTurn) { this.faultAcpTurn(existingTurn); return { ok: false, error: "ACP_CORRELATION_REPLAY" }; }
    if (this.acpTurns.size >= this.acpMaxTurns) {
      clearTimeout(pending.timer);
      this.pendingAcpStarts.delete(key);
      pending.reject(new Error("ACP_BACKPRESSURE"));
      return { ok: false, error: "ACP_BACKPRESSURE" };
    }
    clearTimeout(pending.timer);
    this.pendingAcpStarts.delete(key);
    this.preparedAcpExecutions.delete(acpExecutionScopeKey(input.message.registrationId, input.message.scope));
    this.acpTurns.set(turnKey, {
      key: turnKey, relayId: input.relayId, registrationId: input.message.registrationId, scope: input.message.scope, process: input.message.process,
      capabilities: input.message.capabilities, lastSequence: 1, terminal: null,
      retained: [], retainedBytes: 0, subscribers: new Set(), startedEventId: input.message.eventId, subscriberAttached: false, faultRetentionTimer: undefined,
    });
    pending.resolve(input.message);
    entry.lastSeen = Date.now();
    return { ok: true };
  }

  private acceptAcpStartFailed(input: { relayId: string; userId: string; message: RelayAcpStartFailedResult }): RelayAcpRouteResult {
    const entry = this.relays.get(input.relayId);
    const message = input.message;
    if (!entry || entry.userId !== input.userId || !supportsAcpRegistration(entry, "opencode-acp", true)
      || !this.matchesAcpScope(entry, message.scope.socket, OPENCODE_ACP_RELAY_PROTOCOL_VERSION)) return { ok: false, error: "ACP_CONTEXT_STALE" };
    const scopeKey = acpExecutionScopeKey("opencode-acp", message.scope);
    const key = `acp-start:${scopeKey}`;
    const pending = this.pendingAcpStarts.get(key);
    if (!pending || pending.relayId !== input.relayId || pending.command.registrationId !== "opencode-acp"
      || !sameAcpExecutionScope(pending.command.scope, message.scope)) return { ok: false, error: "ACP_CORRELATION_REPLAY" };
    clearTimeout(pending.timer);
    this.pendingAcpStarts.delete(key);
    this.preparedAcpExecutions.delete(scopeKey);
    pending.reject(new AcpStartFailedError(message.stage));
    entry.lastSeen = Date.now();
    return { ok: true };
  }

  private acceptAcpTurnEvent(input: { relayId: string; userId: string; message: RelayAcpSemanticEvent | RelayAcpTerminalEvent }): RelayAcpRouteResult {
    const entry = this.relays.get(input.relayId);
    const event = input.message;
    if (!entry || entry.userId !== input.userId || !supportsAcpRegistration(entry, event.registrationId, true) || !this.matchesAcpScope(entry, event.scope.socket, ACP_RELAY_PROTOCOL_VERSION)) return { ok: false, error: "ACP_CONTEXT_STALE" };
    const turn = this.acpTurns.get(acpTurnKey(event.registrationId, event.scope, event.process));
    if (!turn || turn.registrationId !== event.registrationId || !sameAcpExecutionScope(turn.scope, event.scope) || !sameAcpProcessScope(turn.process, event.process)) return { ok: false, error: "ACP_CORRELATION_REPLAY" };
    if (event.type === "relay:acp-semantic" && event.capabilities.requests !== turn.capabilities.requests) {
      this.faultAcpTurn(turn);
      return { ok: false, error: "ACP_CONTEXT_STALE" };
    }
    if (turn.terminal !== null) return { ok: false, error: "ACP_TERMINAL_FENCED" };
    if (event.eventId === turn.startedEventId || this.isAcpEventIdActive(turn, event.eventId)) { this.faultAcpTurn(turn); return { ok: false, error: "ACP_CORRELATION_REPLAY" }; }
    if (event.eventSequence <= turn.lastSequence) { this.faultAcpTurn(turn); return { ok: false, error: "ACP_CORRELATION_REPLAY" }; }
    if (event.eventSequence !== turn.lastSequence + 1) { this.faultAcpTurn(turn); return { ok: false, error: "ACP_EVENT_OUT_OF_ORDER" }; }
    const eventBytes = acpEventBytes(event);
    if (eventBytes > this.acpEventQueueMaxBytes) { this.faultAcpTurn(turn); return { ok: false, error: "ACP_BACKPRESSURE" }; }
    if (event.type === "relay:acp-semantic" && turn.subscriberAttached && turn.subscribers.size === 0) { this.faultAcpTurn(turn); return { ok: false, error: "ACP_BACKPRESSURE" }; }
    if (event.type === "relay:acp-semantic") {
      if (!turn.subscriberAttached) {
        turn.retainedBytes -= this.removeSupersededAcpProvisional(turn.retained, event);
      }
      for (const subscriber of turn.subscribers) {
        const removedBytes = this.removeSupersededAcpProvisional(subscriber.queue, event);
        subscriber.queuedBytes -= removedBytes;
      }
    }
    if (event.type === "relay:acp-semantic" && !turn.subscriberAttached && (turn.retained.length >= this.acpEventQueueMaxEntries || turn.retainedBytes + eventBytes > this.acpEventQueueMaxBytes)) { this.faultAcpTurn(turn); return { ok: false, error: "ACP_BACKPRESSURE" }; }
    for (const subscriber of turn.subscribers) {
      if (subscriber.closed) continue;
      if (event.type === "relay:acp-terminal") continue;
      const count = subscriber.queue.length + subscriber.inFlight.size;
      const bytes = subscriber.queuedBytes + subscriber.inFlightBytes;
      if (count >= this.acpEventQueueMaxEntries || bytes + eventBytes > this.acpEventQueueMaxBytes) { this.faultAcpTurn(turn); return { ok: false, error: "ACP_BACKPRESSURE" }; }
    }
    if (event.type === "relay:acp-semantic" && !turn.subscriberAttached) {
      turn.retained.push(event);
      turn.retainedBytes += eventBytes;
    }
    turn.lastSequence = event.eventSequence;
    if (event.type === "relay:acp-terminal") {
      turn.terminal = event;
      this.armPreSubscriberTerminalRetention(turn);
    }
    for (const subscriber of turn.subscribers) {
      if (event.type === "relay:acp-semantic") this.enqueueAcpSubscriber(subscriber, event, eventBytes);
      else this.flushAcpWaiter(turn, subscriber);
    }
    if (event.type === "relay:acp-terminal") this.maybeRetireAcpTurn(turn);
    entry.lastSeen = Date.now();
    return { ok: true };
  }

  /**
   * Provisional ACP updates are latest-state UI hints, not transcript truth.
   * A prompt has one provisional text stream, so its latest queued delta
   * supersedes older queued deltas even if the provider rotates message IDs.
   * Tool summaries coalesce only by exact vendor item. Handed-but-unacknowledged
   * updates, distinct tools, assistant candidates, and terminals remain
   * lossless and bounded.
   */
  private removeSupersededAcpProvisional(
    queue: RelayAcpExecutionEvent[],
    incoming: RelayAcpSemanticEvent,
  ): number {
    if (incoming.payload.kind === "assistant_completed") return 0;
    let removedBytes = 0;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const queued = queue[index];
      if (
        queued?.type === "relay:acp-semantic" &&
        queued.payload.kind === incoming.payload.kind &&
        (
          incoming.payload.kind === "output_delta" ||
          (incoming.payload.vendorItemId !== null && queued.payload.vendorItemId === incoming.payload.vendorItemId)
        )
      ) {
        removedBytes += acpEventBytes(queued);
        queue.splice(index, 1);
      }
    }
    return removedBytes;
  }

  private faultAcpTurn(turn: AcpTurnBroker, sendContain = true): boolean {
    if (turn.terminal !== null) return false;
    const entry = this.relays.get(turn.relayId);
    const terminal: RelayAcpTerminalEvent = {
      type: "relay:acp-terminal", registrationId: turn.registrationId, scope: turn.scope, process: turn.process,
      status: "failed", code: "upstream_failure", eventId: randomUUID(), eventSequence: turn.lastSequence + 1,
    };
    turn.lastSequence = terminal.eventSequence;
    turn.terminal = terminal;
    turn.retained.length = 0;
    turn.retainedBytes = 0;
    for (const subscriber of turn.subscribers) {
      subscriber.queue.length = 0;
      subscriber.queuedBytes = 0;
      this.flushAcpWaiter(turn, subscriber);
    }
    if (sendContain && entry && entry.protocolVersion >= ACP_RELAY_PROTOCOL_VERSION) {
      const command: RelayAcpContainCommand = {
        type: "relay:acp-contain", registrationId: turn.registrationId, containmentRef: randomUUID(),
        scope: turn.scope, process: turn.process, code: "upstream_failure",
      };
      try { entry.send(command); } catch { /* Subscriber still receives the stable local fault. */ }
    }
    // Preserve the pre-subscribe race briefly, then recover capacity if no
    // consumer ever attaches to observe the stable terminal.
    this.armPreSubscriberTerminalRetention(turn);
    this.maybeRetireAcpTurn(turn);
    return true;
  }

  private armPreSubscriberTerminalRetention(turn: AcpTurnBroker): void {
    if (turn.subscriberAttached || turn.faultRetentionTimer !== undefined) return;
    turn.faultRetentionTimer = setTimeout(() => {
      if (!turn.subscriberAttached && this.acpTurns.get(turn.key) === turn) this.acpTurns.delete(turn.key);
    }, ACP_EXECUTION_START_TIMEOUT_MS);
  }

  private createAcpSubscription(turn: AcpTurnBroker, subscriber: AcpSubscriber): RelayAcpExecutionSubscription {
    return {
      next: () => this.nextAcpSubscription(turn, subscriber),
      acknowledge: (eventId, eventSequence) => {
        const key = acpEventIdentityKey(eventId, eventSequence);
        const event = subscriber.inFlight.get(key);
        if (!event) return;
        subscriber.inFlight.delete(key);
        subscriber.inFlightBytes -= acpEventBytes(event);
        this.flushAcpWaiter(turn, subscriber);
        this.maybeRetireAcpTurn(turn);
      },
      close: () => { subscriber.closed = true; subscriber.queue.length = 0; subscriber.queuedBytes = 0; subscriber.inFlight.clear(); subscriber.inFlightBytes = 0; subscriber.waiter?.(null); subscriber.waiter = null; subscriber.nextPending = false; turn.subscribers.delete(subscriber); this.maybeRetireAcpTurn(turn); },
    };
  }

  private nextAcpSubscription(turn: AcpTurnBroker, subscriber: AcpSubscriber): Promise<RelayAcpExecutionEvent | null> {
    if (subscriber.closed) return Promise.resolve(null);
    if (subscriber.nextPending) return Promise.reject(new Error("ACP_SUBSCRIPTION_NEXT_CONCURRENT"));
    const event = subscriber.queue.shift();
    if (event) {
      subscriber.queuedBytes -= acpEventBytes(event);
      subscriber.inFlight.set(acpEventIdentityKey(event.eventId, event.eventSequence), event);
      subscriber.inFlightBytes += acpEventBytes(event);
      return Promise.resolve(event);
    }
    if (turn.terminal !== null && subscriber.inFlight.size === 0 && !subscriber.terminalDelivered) {
      subscriber.terminalDelivered = true;
      subscriber.inFlight.set(acpEventIdentityKey(turn.terminal.eventId, turn.terminal.eventSequence), turn.terminal);
      subscriber.inFlightBytes += acpEventBytes(turn.terminal);
      return Promise.resolve(turn.terminal);
    }
    if (turn.terminal !== null && subscriber.inFlight.size === 0) return Promise.resolve(null);
    return new Promise((resolve) => { subscriber.nextPending = true; subscriber.waiter = resolve; this.flushAcpWaiter(turn, subscriber); });
  }

  private enqueueAcpSubscriber(subscriber: AcpSubscriber, event: RelayAcpExecutionEvent, bytes: number): void {
    if (subscriber.closed) return;
    if (subscriber.waiter !== null) {
      const waiter = subscriber.waiter;
      subscriber.waiter = null;
      subscriber.nextPending = false;
      subscriber.inFlight.set(acpEventIdentityKey(event.eventId, event.eventSequence), event);
      subscriber.inFlightBytes += bytes;
      waiter(event);
      return;
    }
    subscriber.queue.push(event);
    subscriber.queuedBytes += bytes;
  }

  private flushAcpWaiter(turn: AcpTurnBroker, subscriber: AcpSubscriber): void {
    if (subscriber.closed || subscriber.waiter === null || subscriber.queue.length > 0 || subscriber.inFlight.size > 0 || turn.terminal === null || subscriber.terminalDelivered) return;
    const waiter = subscriber.waiter;
    subscriber.waiter = null;
    subscriber.nextPending = false;
    subscriber.terminalDelivered = true;
    subscriber.inFlight.set(acpEventIdentityKey(turn.terminal.eventId, turn.terminal.eventSequence), turn.terminal);
    subscriber.inFlightBytes += acpEventBytes(turn.terminal);
    waiter(turn.terminal);
  }

  private maybeRetireAcpTurn(turn: AcpTurnBroker): void {
    if (turn.terminal === null || !turn.subscriberAttached) return;
    const subscriber = turn.subscribers.values().next().value;
    if (subscriber !== undefined && !subscriber.closed && (!subscriber.terminalDelivered || subscriber.inFlight.size !== 0)) return;
    if (this.acpTurns.get(turn.key) === turn) {
      if (turn.faultRetentionTimer !== undefined) clearTimeout(turn.faultRetentionTimer);
      this.acpTurns.delete(turn.key);
    }
  }

  private isAcpEventIdActive(turn: AcpTurnBroker, eventId: string): boolean {
    for (const event of turn.retained) if (event.eventId === eventId) return true;
    for (const subscriber of turn.subscribers) {
      if (subscriber.queue.some((event) => event.eventId === eventId)) return true;
      for (const event of subscriber.inFlight.values()) if (event.eventId === eventId) return true;
    }
    return false;
  }

  /** Wire acknowledgement data; valid only for this currently live v8 socket. */
  getV8Acknowledgement(relayId: string): { relaySessionId: string; pairingGenerationRef: string } | null {
    const entry = this.relays.get(relayId);
    if (!entry || entry.protocolVersion < CODEX_RELAY_PROTOCOL_VERSION || !entry.relaySessionId || !entry.pairingGenerationRef) return null;
    return { relaySessionId: entry.relaySessionId, pairingGenerationRef: entry.pairingGenerationRef };
  }

  /**
   * Accept an already strict-parsed v8 client frame only from its registered
   * authenticated socket/user. Replay/event state is separate and bounded.
   */
  acceptCodexMessage(input: { relayId: string; userId: string; message: RelayCodexClientMessage }): RelayCodexRouteResult {
    const entry = this.relays.get(input.relayId);
    if (!entry || entry.userId !== input.userId) return { ok: false, error: "CODEX_RELAY_UNAVAILABLE" };
    const frame = input.message;
    const frameScope = frame.type === "relay:codex-status" ? frame.socket : frame.scope;
    if (!this.matchesCodexScope(entry, frameScope)) return { ok: false, error: "CODEX_CONTEXT_STALE" };
    if (frame.type === "relay:codex-status") {
      if (frame.capabilityRevision !== entry.capabilityRevision) return { ok: false, error: "CODEX_CONTEXT_STALE" };
      entry.codexStatus = frame.status;
    }
    if (frame.type === "relay:codex-command-response") {
      return this.acceptCodexCommandResponse(entry, frame);
    }
    const fingerprint = this.codexFingerprint(frame);
    this.pruneCodexReplay();
    if (frame.type === "relay:codex-event" && fingerprint !== null) {
      const existingReplay = this.codexReplay.get(fingerprint.identity);
      if (existingReplay !== undefined) {
        return existingReplay.fingerprint === fingerprint.content
          ? { ok: true }
          : { ok: false, error: "CODEX_CORRELATION_REPLAY" };
      }
      const sequenceKey = this.codexEventStreamKey(frame.scope);
      const priorSequence = this.codexEventSequences.get(sequenceKey);
      if (
        priorSequence !== undefined &&
        frame.eventSequence <= Number(priorSequence.fingerprint)
      ) {
        return { ok: false, error: "CODEX_CORRELATION_REPLAY" };
      }
      const terminalKey = frame.event.kind === "turn_completed" &&
        "threadId" in frame.scope &&
        "turnId" in frame.scope
        ? this.codexTerminalOutcomeKey(frame.scope)
        : null;
      const priorTerminal = terminalKey === null
        ? undefined
        : this.codexTurnOutcomes.get(terminalKey);
      if (priorTerminal !== undefined) {
        return priorTerminal.fingerprint === fingerprint.content
          ? { ok: true }
          : { ok: false, error: "CODEX_CORRELATION_REPLAY" };
      }
      this.putBounded(this.codexReplay, fingerprint.identity, {
        fingerprint: fingerprint.content,
        expiresAt: Date.now() + CODEX_RELAY_REPLAY_CACHE_TTL_MS,
      });
      this.putBounded(this.codexEventSequences, sequenceKey, {
        fingerprint: String(frame.eventSequence),
        expiresAt: Date.now() + CODEX_RELAY_REPLAY_CACHE_TTL_MS,
      });
      if (terminalKey !== null) {
        this.putBounded(this.codexTurnOutcomes, terminalKey, {
          fingerprint: fingerprint.content,
          expiresAt: Date.now() + CODEX_RELAY_REPLAY_CACHE_TTL_MS,
        });
      }
      entry.lastSeen = Date.now();
      for (const listener of this.codexListeners) listener(entry.relayId, frame);
      return { ok: true };
    }
    if (fingerprint !== null) {
      const identity = fingerprint.identity;
      const existing = this.codexReplay.get(identity);
      if (existing !== undefined) {
        return existing.fingerprint === fingerprint.content
          ? { ok: true }
          : { ok: false, error: "CODEX_CORRELATION_REPLAY" };
      }
      if (this.codexReplay.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) {
        const oldest = this.codexReplay.keys().next().value;
        if (typeof oldest === "string") this.codexReplay.delete(oldest);
      }
      this.codexReplay.set(identity, { fingerprint: fingerprint.content, expiresAt: Date.now() + CODEX_RELAY_REPLAY_CACHE_TTL_MS });
    }
    entry.lastSeen = Date.now();
    for (const listener of this.codexListeners) listener(entry.relayId, frame);
    return { ok: true };
  }

  private matchesCodexScope(entry: RelayEntry, scope: V8SocketScope): boolean {
    const capabilityRevision = (scope as V8SocketScope & { capabilityRevision?: unknown }).capabilityRevision;
    return entry.protocolVersion >= CODEX_RELAY_PROTOCOL_VERSION && entry.capabilities.profile === "desktop-agent" &&
      entry.capabilities.codex?.hostKind === "electron" &&
      entry.relaySessionId === scope.relaySessionId &&
      entry.pairingGenerationRef === scope.pairingGenerationRef &&
      entry.desktopSessionId === scope.desktopSessionId &&
      entry.relayId === scope.relayId && scope.selectedProtocolVersion === entry.protocolVersion &&
      (capabilityRevision === undefined || capabilityRevision === entry.capabilityRevision);
  }

  private matchesAcpScope(entry: RelayEntry, scope: AcpSocketScope, minimumProtocolVersion: number): boolean {
    return entry.protocolVersion >= minimumProtocolVersion && entry.capabilities.profile === "desktop-agent"
      && entry.capabilities.acp?.hostKind === "electron"
      && entry.relaySessionId === scope.relaySessionId && entry.pairingGenerationRef === scope.pairingGenerationRef
      && entry.desktopSessionId === scope.desktopSessionId && entry.relayId === scope.relayId
      && scope.selectedProtocolVersion === entry.protocolVersion && scope.capabilityRevision === entry.capabilityRevision;
  }

  private acceptCodexCommandResponse(
    entry: RelayEntry,
    response: RelayCodexCommandResponseMessage,
  ): RelayCodexRouteResult {
    this.pruneCodexReplay();
    const content = JSON.stringify(response);
    for (const retained of this.codexCommandOutcomes.values()) {
      if (
        retained.response.commandId !== response.commandId ||
        retained.response.scope.relayId !== response.scope.relayId ||
        retained.response.scope.relaySessionId !== response.scope.relaySessionId
      ) continue;
      return JSON.stringify(retained.response) === content
        ? { ok: true }
        : { ok: false, error: "CODEX_CORRELATION_REPLAY" };
    }
    let pendingEntry: readonly [string, PendingCodexCommand] | null = null;
    for (const candidate of this.pendingCodexCommands) {
      if (
        candidate[1].command.commandId === response.commandId &&
        isRelayCodexCommandResponseForCommand(candidate[1].command, response)
      ) {
        pendingEntry = candidate;
        break;
      }
    }
    if (!pendingEntry) {
      return { ok: false, error: "CODEX_CORRELATION_REPLAY" };
    }
    const [key, pending] = pendingEntry;
    clearTimeout(pending.timer);
    this.pendingCodexCommands.delete(key);
    this.putBounded(this.codexCommandOutcomes, key, {
      fingerprint: pending.fingerprint,
      response,
      expiresAt: Date.now() + CODEX_RELAY_REPLAY_CACHE_TTL_MS,
    });
    entry.lastSeen = Date.now();
    pending.resolve(response);
    for (const listener of this.codexListeners) listener(entry.relayId, response);
    return { ok: true };
  }

  private codexScopeKey(scope: V8SocketScope): string {
    const record = scope as unknown as Record<string, unknown>;
    const keys = [
      "relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef",
      "selectedProtocolVersion", "capabilityRevision", "profileHandle",
      "profileGeneration", "accountGeneration", "runtimeGeneration",
      "childGeneration", "workspace", "bindingId", "bindingGeneration",
      "taskId", "jobId", "threadId", "turnId", "eventId",
      "itemId", "requestRef", "callRef",
    ];
    return keys
      .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
      .map((key) => `${key}=${JSON.stringify(record[key])}`)
      .join("&");
  }

  private codexGenerationContextKey(scope: V8SocketScope): string {
    const record = scope as unknown as Record<string, unknown>;
    const keys = [
      "relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef",
      "selectedProtocolVersion", "capabilityRevision", "profileHandle",
      "profileGeneration", "accountGeneration", "runtimeGeneration",
      "childGeneration",
    ];
    return keys
      .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
      .map((key) => `${key}=${JSON.stringify(record[key])}`)
      .join("&");
  }

  private codexEventStreamKey(scope: V8SocketScope): string {
    const record = scope as unknown as Record<string, unknown>;
    const streamFields = ["bindingGeneration"];
    return [
      this.codexGenerationContextKey(scope),
      ...streamFields
        .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
        .map((key) => `${key}=${JSON.stringify(record[key])}`),
    ].join("&");
  }

  private codexTerminalOutcomeKey(
    scope: V8SocketScope & { readonly threadId: string; readonly turnId: string },
  ): string {
    return [
      this.codexGenerationContextKey(scope),
      `threadId=${JSON.stringify(scope.threadId)}`,
      `turnId=${JSON.stringify(scope.turnId)}`,
    ].join("&");
  }

  private codexCommandKey(scope: V8SocketScope, commandId: string): string {
    return `command:${this.codexScopeKey(scope)}:${JSON.stringify(commandId)}`;
  }

  private claudeConnectionDiscoveryKey(scope: RelayClaudeConnectionScope, profileRef: string): string {
    return `claude-connection:${this.codexScopeKey(scope as unknown as V8SocketScope)}:${JSON.stringify(profileRef)}`;
  }

  private matchesClaudeConnectionScope(entry: RelayEntry, scope: RelayClaudeConnectionScope): boolean {
    return supportsClaudeConnection(entry) &&
      entry.relayId === scope.relayId &&
      entry.relaySessionId === scope.relaySessionId &&
      entry.desktopSessionId === scope.desktopSessionId &&
      entry.pairingGenerationRef === scope.pairingGenerationRef &&
      entry.protocolVersion === scope.selectedProtocolVersion &&
      entry.capabilityRevision === scope.capabilityRevision;
  }

  private clearClaudeConnectionState(relayId: string, errorCode: string): void {
    for (const [key, pending] of this.pendingClaudeConnectionDiscoveries) {
      if (pending.relayId !== relayId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(errorCode));
      this.pendingClaudeConnectionDiscoveries.delete(key);
    }
  }

  private notifyClaudeConnectionContext(
    relayId: string,
    userId: string,
    previous: RelayClaudeConnectionContextSnapshot | null,
    next: RelayClaudeConnectionContextSnapshot | null,
  ): void {
    if (sameClaudeConnectionContext(previous, next)) return;
    for (const listener of this.claudeConnectionContextListeners) {
      try { listener(relayId, userId, next); } catch { /* observer only */ }
    }
  }

  private invalidatePublishedClaudeConnectionContext(relayId: string, userId: string): void {
    const previous = this.publishedClaudeConnectionContexts.get(relayId) ?? null;
    if (previous === null) return;
    this.publishedClaudeConnectionContexts.delete(relayId);
    this.notifyClaudeConnectionContext(relayId, userId, previous, null);
  }

  private putBounded<T>(map: Map<string, T>, key: string, value: T): void {
    if (map.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) {
      const oldest = map.keys().next().value;
      if (typeof oldest === "string") map.delete(oldest);
    }
    map.set(key, value);
  }

  private clearCodexState(relayId: string, errorCode: string): void {
    for (const [key, pending] of this.pendingAcpReadiness) {
      if (pending.relayId !== relayId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(errorCode === "CODEX_CONTEXT_STALE" ? "ACP_CONTEXT_STALE" : "ACP_RELAY_UNAVAILABLE"));
      this.pendingAcpReadiness.delete(key);
    }
    for (const [key, pending] of this.pendingAcpPrepares) {
      if (pending.relayId !== relayId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(errorCode === "CODEX_CONTEXT_STALE" ? "ACP_CONTEXT_STALE" : "ACP_RELAY_UNAVAILABLE"));
      this.pendingAcpPrepares.delete(key);
    }
    for (const [key, pending] of this.pendingAcpStarts) {
      if (pending.relayId !== relayId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(pending.command.registrationId === "opencode-acp"
        ? "ACP_SOCKET_GENERATION_LOST"
        : errorCode === "CODEX_CONTEXT_STALE" ? "ACP_CONTEXT_STALE" : "ACP_RELAY_UNAVAILABLE"));
      this.pendingAcpStarts.delete(key);
    }
    for (const [key, prepared] of this.preparedAcpExecutions) {
      if (prepared.relayId === relayId) this.preparedAcpExecutions.delete(key);
    }
    for (const turn of this.acpTurns.values()) {
      if (turn.relayId !== relayId) continue;
      this.faultAcpTurn(turn, false);
    }
    for (const [key, pending] of this.pendingCodexCommands) {
      if (pending.command.scope.relayId !== relayId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(errorCode));
      this.pendingCodexCommands.delete(key);
    }
    const belongsToRelay = (key: string) =>
      key.includes(`relayId=${JSON.stringify(relayId)}`);
    for (const key of this.codexReplay.keys()) if (belongsToRelay(key)) this.codexReplay.delete(key);
    for (const key of this.codexEventSequences.keys()) if (belongsToRelay(key)) this.codexEventSequences.delete(key);
    for (const key of this.codexCommandOutcomes.keys()) if (belongsToRelay(key)) this.codexCommandOutcomes.delete(key);
    for (const key of this.codexTurnOutcomes.keys()) if (belongsToRelay(key)) this.codexTurnOutcomes.delete(key);
    for (const listener of this.codexContextInvalidationListeners) {
      try {
        listener(relayId, errorCode);
      } catch {
        // Observer failures must not block canonical fail-closed cleanup.
      }
    }
  }

  private codexFingerprint(message: RelayCodexClientMessage): { identity: string; content: string } | null {
    if (message.type === "relay:codex-event") {
      return {
        identity: `event:${this.codexScopeKey(message.scope)}:${message.eventSequence}`,
        content: JSON.stringify(message),
      };
    }
    if (message.type === "relay:codex-request") {
      return {
        identity: `request:${this.codexScopeKey(message.scope)}:${message.scope.requestRef}`,
        content: JSON.stringify(message),
      };
    }
    return null;
  }

  private pruneCodexReplay(): void {
    const now = Date.now();
    for (const [key, value] of this.codexReplay) if (value.expiresAt <= now) this.codexReplay.delete(key);
    for (const [key, value] of this.codexEventSequences) if (value.expiresAt <= now) this.codexEventSequences.delete(key);
    for (const [key, value] of this.codexCommandOutcomes) if (value.expiresAt <= now) this.codexCommandOutcomes.delete(key);
    for (const [key, value] of this.codexTurnOutcomes) if (value.expiresAt <= now) this.codexTurnOutcomes.delete(key);
  }

  getCapabilities(relayId: string): RelayCapabilities | null {
    const capabilities = this.relays.get(relayId)?.capabilities;
    return capabilities ? copyRelayCapabilities(capabilities) : null;
  }

  /**
   * the relay's validated advisory active-grant snapshot, or null when
   * none was advertised (or it was malformed and dropped at registration). This
   * is discovery data only; callers must never treat it as authority. The
   * relay-local resolver reloads live local grants and decides every access, so
   * a stale or revoked entry here fails closed on the relay.
   */
  getDesktopFilesystemGrantSnapshot(relayId: string): RelayDesktopFilesystemGrantSnapshot | null {
    const snapshot = this.relays.get(relayId)?.desktopFilesystemGrantSnapshot;
    return snapshot ? structuredClone(snapshot) : null;
  }

  /**
   * the relay's validated advisory Workstation Profile binding snapshot,
   * or null when none was advertised (or it was malformed and dropped at
   * registration). This is advisory binding data only; callers must never
   * treat it as compiled-profile authority. The desktop relay's live compiled
   * profile remains final, so a stale or revoked binding here fails closed on
   * the relay.
   */
  getWorkstationProfileSnapshot(relayId: string): RelayWorkstationProfileSnapshot | null {
    const snapshot = this.relays.get(relayId)?.workstationProfileSnapshot;
    return snapshot ? structuredClone(snapshot) : null;
  }

  /** protocol version a relay registered with (null if unknown). */
  getProtocolVersion(relayId: string): number | null {
    return this.relays.get(relayId)?.protocolVersion ?? null;
  }

  /** protocol v7 — the relay's desktop session id, or null if none. */
  getDesktopSessionId(relayId: string): string | null {
    return this.relays.get(relayId)?.desktopSessionId ?? null;
  }

  /** server-minted identity of the currently connected socket. */
  getRelaySessionId(relayId: string): string | null {
    const value = this.relays.get(relayId)?.relaySessionId;
    return value && value.length > 0 ? value : null;
  }

  /** late report-back checks must not revive a heartbeat-stale relay. */
  isRelayHeartbeatFresh(relayId: string, now = Date.now()): boolean {
    const entry = this.relays.get(relayId);
    return entry !== undefined && now - entry.lastSeen <= HEARTBEAT_TIMEOUT_MS;
  }

  /** protocol v7 — the relay's current capability revision (null if unknown). */
  getCapabilityRevision(relayId: string): number | null {
    return this.relays.get(relayId)?.capabilityRevision ?? null;
  }

  /**
   * the relay's server-derived `pairingGeneration` (the
   * validated relay-token row id stamped at register), or null when the
   * relay is not connected or never carried one. The binding provider
   * reads this to populate the authoritative Full Workstation binding and
   * the plan-admission re-validation reads it as the live relay fingerprint
   * field. A null/empty value makes a relay ineligible for a Full Workstation
   * session — the generation is never client-authored.
   */
  getPairingGeneration(relayId: string): string | null {
    const value = this.relays.get(relayId)?.pairingGeneration;
    if (value === undefined || value === "") return null;
    return value;
  }

  getUserId(relayId: string): string | null {
    return this.relays.get(relayId)?.userId ?? null;
  }

  /**
   * 4.1.3 — snapshot a connected relay for focused-local-file
   * validation. Returns `null` when the relay is not currently connected
   * (the local-file resolver fails closed in that case — no read, no
   * upload, no fallback device switch). The snapshot carries the relay's
   * owner id match + protocol version + capability profile so the resolver
   * can enforce sender ownership, protocol v4+, `profile:"desktop-agent"`,
   * and `localFileExecution:true` without ever touching byte transport.
   */
  snapshotForFocusedResource(
    relayId: string,
    actorId: string,
  ): FocusedResourceRelaySnapshot | null {
    const entry = this.relays.get(relayId);
    if (!entry) return null;
    return {
      ownedByActor: entry.userId === actorId,
      protocolVersion: entry.protocolVersion,
      profile: entry.capabilities.profile,
      localFileExecution: entry.capabilities.localFileExecution === true,
      applyPatchExecution: entry.capabilities.applyPatchExecution === true,
      allowedRoots: [...(entry.capabilities.allowedRoots ?? [])],
      canRunOffice: entry.capabilities.canRunOffice === true,
    };
  }

  /**
   * reconnect/session split-brain fix — the LIVE active Full
   * Workstation session for a user (looked up via the injected
   * `getActiveWorkstationSession` constructor option), or `null` when no
   * session is active or no lookup was wired. Exposed so the agent tools
   * node's no-plan `run_shell` gate can fail closed for an active session
   * even when the selected relay's profile snapshot is absent — defense in
   * depth behind the snapshot-cleared invalidation seam. The registry
   * never owns session state; it only delegates the lookup.
   */
  getActiveWorkstationSession(userId: string): RelayActiveWorkstationSessionView | null {
    return this.getActiveWorkstationSessionFn?.(userId) ?? null;
  }

  private sweepStale(): void {
    const now = Date.now();
    for (const [id, entry] of this.relays) {
      if (now - entry.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        void this.unregister(id);
      }
    }
  }
}

function isBoundedAcpOpaqueId(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 512;
}

/** Account/model observation includes an SDK startup exchange plus scheduling margin. */
const CLAUDE_CONNECTION_DISCOVERY_TIMEOUT_MS = 15_000;

function isBoundedClaudeConnectionTimeout(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= CLAUDE_CONNECTION_DISCOVERY_TIMEOUT_MS);
}

function isClaudeConnectionUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function supportsClaudeConnection(entry: RelayEntry): boolean {
  const capability = entry.capabilities.claude;
  return entry.protocolVersion >= CLAUDE_CONNECTION_PROTOCOL_VERSION &&
    entry.capabilities.profile === "desktop-agent" && capability?.version === 1 &&
    capability.hostKind === "electron" && capability.registrations.length === 1 &&
    capability.registrations[0] === "claude-agent-sdk";
}

function supportsClaudeExecution(entry: RelayEntry): boolean {
  return entry.protocolVersion >= CLAUDE_EXECUTION_PROTOCOL_VERSION &&
    entry.capabilities.profile === "desktop-agent" &&
    entry.capabilities.claudeExecution?.version === 2;
}

function claudeExecutionScope(
  session: RelayAuthenticatedDesktopSessionSnapshot,
): RelayClaudeExecutionSocketScope {
  return Object.freeze({
    relayId: session.relayId,
    relaySessionId: session.relaySessionId,
    desktopSessionId: session.desktopSessionId,
    pairingGenerationRef: session.pairingGenerationRef,
    selectedProtocolVersion: session.selectedProtocolVersion,
    capabilityRevision: session.capabilityRevision,
  });
}

function claudeExecutionScopeFromEntry(entry: RelayEntry): RelayClaudeExecutionSocketScope {
  return Object.freeze({
    relayId: entry.relayId,
    relaySessionId: entry.relaySessionId ?? "",
    desktopSessionId: entry.desktopSessionId ?? "",
    pairingGenerationRef: entry.pairingGenerationRef ?? "",
    selectedProtocolVersion: entry.protocolVersion,
    capabilityRevision: entry.capabilityRevision,
  });
}

function sameClaudeExecutionScope(
  left: RelayClaudeExecutionSocketScope,
  right: RelayClaudeExecutionSocketScope,
): boolean {
  return left.relayId === right.relayId &&
    left.relaySessionId === right.relaySessionId &&
    left.desktopSessionId === right.desktopSessionId &&
    left.pairingGenerationRef === right.pairingGenerationRef &&
    left.selectedProtocolVersion === right.selectedProtocolVersion &&
    left.capabilityRevision === right.capabilityRevision;
}

function captureClaudeExecutionOpenInput(input: {
  relayId: string;
  userId: string;
  prompt: string;
  model: string;
  expectedScope: RelayClaudeExecutionSocketScope;
}): Readonly<{
  relayId: string;
  userId: string;
  prompt: string;
  model: string;
  expectedScope: RelayClaudeExecutionSocketScope;
}> | null {
  try {
    if (typeof input !== "object" || input === null || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 5 || !keys.every((key) => typeof key === "string" && ["relayId", "userId", "prompt", "model", "expectedScope"].includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const relayId = descriptors["relayId"];
    const userId = descriptors["userId"];
    const prompt = descriptors["prompt"];
    const model = descriptors["model"];
    const expectedScope = descriptors["expectedScope"];
    if (
      relayId === undefined || userId === undefined || prompt === undefined || model === undefined || expectedScope === undefined ||
      !("value" in relayId) || !("value" in userId) || !("value" in prompt) || !("value" in model) || !("value" in expectedScope) ||
      !relayId.enumerable || !userId.enumerable || !prompt.enumerable || !model.enumerable || !expectedScope.enumerable ||
      typeof relayId.value !== "string" || typeof userId.value !== "string" ||
      typeof prompt.value !== "string" || typeof model.value !== "string"
    ) return null;
    const scope = captureClaudeExecutionScope(expectedScope.value);
    return scope === null ? null : Object.freeze({
      relayId: relayId.value,
      userId: userId.value,
      prompt: prompt.value,
      model: model.value,
      expectedScope: scope,
    });
  } catch {
    return null;
  }
}

function captureClaudeExecutionScope(value: unknown): RelayClaudeExecutionSocketScope | null {
  const parsed = parseRelayClaudeExecutionCommand({
    type: "relay:claude-execution-command",
    scope: value,
    executionRef: "scope-capture",
    action: { kind: "interrupt" },
  });
  return parsed?.scope ?? null;
}

function frozenClaudeExecutionOpenFailure(
  error: Extract<RelayClaudeExecutionOpenResult, { ok: false }>['error'],
): RelayClaudeExecutionOpenResult {
  return Object.freeze({ ok: false as const, error });
}

function frozenClaudeExecutionRouteFailure(
  error: Extract<RelayClaudeExecutionRouteResult, { ok: false }>['error'],
): RelayClaudeExecutionRouteResult {
  return Object.freeze({ ok: false as const, error });
}

function claudeConnectionScope(session: RelayAuthenticatedDesktopSessionSnapshot): RelayClaudeConnectionScope {
  return {
    relayId: session.relayId,
    relaySessionId: session.relaySessionId,
    desktopSessionId: session.desktopSessionId,
    pairingGenerationRef: session.pairingGenerationRef,
    selectedProtocolVersion: session.selectedProtocolVersion,
    capabilityRevision: session.capabilityRevision,
  };
}

function sameClaudeConnectionScope(left: RelayClaudeConnectionScope, right: RelayClaudeConnectionScope): boolean {
  return left.relayId === right.relayId && left.relaySessionId === right.relaySessionId &&
    left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef &&
    left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision;
}

function sameClaudeConnectionContext(
  left: RelayClaudeConnectionContextSnapshot | null,
  right: RelayClaudeConnectionContextSnapshot | null,
): boolean {
  return left === right || (left !== null && right !== null &&
    left.relayId === right.relayId && left.userId === right.userId &&
    left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId &&
    left.pairingGenerationRef === right.pairingGenerationRef &&
    left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision);
}

/** Local-folder preparation remains a short, low-cost operation. */
const ACP_PREPARE_TIMEOUT_MAX_MS = 5_000;
/**
 * Hermes readiness performs two sequential, Desktop-owned probes: the exact
 * executable/version probe (3s) and the authenticated provider check (5s).
 * The relay envelope must outlive those bounded operations plus response
 * delivery; a universal 5s timeout can never represent a cold successful
 * check and produces a late correlation replay instead.
 */
export const HERMES_ACP_READINESS_TIMEOUT_MS = 10_000;
const OPENCODE_ACP_READINESS_TIMEOUT_MS = 5_000;
/**
 * Launch confirmation covers the locked 10s Electron launch/readiness window
 * plus relay scheduling margin. It is deliberately one fixed bound: a caller
 * cannot shorten an admitted launch below the platform's own deadline.
 */
const ACP_EXECUTION_START_TIMEOUT_MS = 15_000;
/** 30s OpenCode handshake + 15s containment + 5s relay scheduling margin. */
export const OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS = 50_000;

function acpReadinessTimeoutMs(registrationId: AcpRegistrationId): number {
  return registrationId === "hermes-acp"
    ? HERMES_ACP_READINESS_TIMEOUT_MS
    : OPENCODE_ACP_READINESS_TIMEOUT_MS;
}

function isBoundedAcpReadinessTimeout(value: number | undefined, registrationId: AcpRegistrationId): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= acpReadinessTimeoutMs(registrationId));
}

function isBoundedAcpPrepareTimeout(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= ACP_PREPARE_TIMEOUT_MAX_MS);
}

function acpExecutionStartTimeoutMs(registrationId: AcpRegistrationId): number {
  return registrationId === "opencode-acp" ? OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS : ACP_EXECUTION_START_TIMEOUT_MS;
}

function isBoundedAcpStartTimeout(value: number | undefined, registrationId: AcpRegistrationId): boolean {
  return value === undefined || value === acpExecutionStartTimeoutMs(registrationId);
}

function isBoundedAcpPrompt(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 64 * 1024;
}

function boundedAcpLimit(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= minimum
    ? Math.min(value, maximum)
    : fallback;
}

function acpSocket(session: RelayAcpSessionSnapshot): AcpSocketScope {
  return {
    relayId: session.relayId, relaySessionId: session.relaySessionId,
    desktopSessionId: session.desktopSessionId, pairingGenerationRef: session.pairingGenerationRef,
    selectedProtocolVersion: session.selectedProtocolVersion, capabilityRevision: session.capabilityRevision,
  };
}

function acpExecutionScopeKey(registrationId: AcpRegistrationId, scope: AcpExecutionScope): string {
  return [
    registrationId,
    acpSocketKey(scope.socket),
    scope.binding.bindingId, scope.binding.bindingGeneration, scope.binding.ownerId,
    scope.binding.taskId, scope.binding.taskRunId, scope.binding.jobId,
    scope.binding.profileId, scope.binding.profileGeneration,
    scope.binding.postureId, scope.binding.postureGeneration,
    scope.workspace.workspaceReceiptId, scope.workspace.workspaceRevision,
    scope.workspace.workspaceFingerprint, scope.workspace.workspaceExpiresAt,
  ].map((value) => JSON.stringify(value)).join("|");
}

function acpTurnKey(registrationId: AcpRegistrationId, scope: AcpExecutionScope, process: AcpProcessScope): string {
  return [
    acpExecutionScopeKey(registrationId, scope), process.connectionId, process.processGeneration,
    process.acpSessionId, process.turnGeneration, process.turnRef,
  ].map((value) => JSON.stringify(value)).join("|");
}

function supportsAcpRegistration(
  entry: RelayEntry,
  registrationId: AcpRegistrationId,
  execution: boolean,
): boolean {
  if (entry.capabilities.profile !== "desktop-agent"
    || entry.capabilities.acp?.hostKind !== "electron"
    || !entry.capabilities.acp.registrations.some((candidate) => candidate === registrationId)) return false;
  const minimum = registrationId === "opencode-acp"
    ? OPENCODE_ACP_RELAY_PROTOCOL_VERSION
    : execution ? ACP_RELAY_PROTOCOL_VERSION : ACP_RELAY_READINESS_PROTOCOL_VERSION;
  return entry.protocolVersion >= minimum;
}

function isAcpExecutionProfile(value: unknown): value is AcpExecutionProfile {
  return value === "interactive" || value === "autonomous" || value === "plan";
}

function acpSocketKey(scope: AcpSocketScope): string {
  return [
    scope.relayId, scope.relaySessionId, scope.desktopSessionId,
    scope.pairingGenerationRef, scope.selectedProtocolVersion, scope.capabilityRevision,
  ].map((value) => JSON.stringify(value)).join("|");
}

function sameAcpSocketScope(left: AcpSocketScope, right: AcpSocketScope): boolean {
  return left.relayId === right.relayId && left.relaySessionId === right.relaySessionId
    && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef
    && left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision;
}

function sameAcpBindingScope(left: AcpBindingScope, right: AcpBindingScope): boolean {
  return left.bindingId === right.bindingId && left.bindingGeneration === right.bindingGeneration
    && left.ownerId === right.ownerId && left.taskId === right.taskId && left.taskRunId === right.taskRunId
    && left.jobId === right.jobId && left.profileId === right.profileId && left.profileGeneration === right.profileGeneration
    && left.postureId === right.postureId && left.postureGeneration === right.postureGeneration;
}

function sameAcpExecutionScope(left: AcpExecutionScope, right: AcpExecutionScope): boolean {
  return sameAcpSocketScope(left.socket, right.socket) && sameAcpBindingScope(left.binding, right.binding)
    && left.workspace.workspaceReceiptId === right.workspace.workspaceReceiptId
    && left.workspace.workspaceRevision === right.workspace.workspaceRevision
    && left.workspace.workspaceFingerprint === right.workspace.workspaceFingerprint
    && left.workspace.workspaceExpiresAt === right.workspace.workspaceExpiresAt;
}

function sameAcpProcessScope(left: AcpProcessScope, right: AcpProcessScope): boolean {
  return left.connectionId === right.connectionId && left.processGeneration === right.processGeneration
    && left.acpSessionId === right.acpSessionId && left.turnGeneration === right.turnGeneration
    && left.turnRef === right.turnRef;
}

function acpEventBytes(event: RelayAcpExecutionEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function acpEventIdentityKey(eventId: string, eventSequence: number): string {
  return `${JSON.stringify(eventId)}|${JSON.stringify(eventSequence)}`;
}
