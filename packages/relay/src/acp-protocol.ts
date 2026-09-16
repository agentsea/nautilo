import { ACP_RELAY_CAPABILITY_VERSION, type RelayAcpCapability } from "./types";
import { classifyRelayTopLevelType } from "./codex-protocol";

/**
 * v13 carried only Hermes readiness. v14 adds a typed, semantic execution
 * lane; it never carries ACP JSON-RPC, local paths, commands, environments,
 * credentials, provider/model data, permission answers, or Stop.
 */
export const ACP_RELAY_PROTOCOL_VERSION = 14 as const;
export const ACP_RELAY_READINESS_PROTOCOL_VERSION = 13 as const;
/** OpenCode joins the built-in ACP family without changing Hermes v13/v14. */
export const OPENCODE_ACP_RELAY_PROTOCOL_VERSION = 15 as const;
export const ACP_RELAY_MAX_FRAME_BYTES = 256 * 1024;
/** v13 readiness must retain its original, deliberately small admission cap. */
export const ACP_RELAY_READINESS_MAX_FRAME_BYTES = 8 * 1024;
export const ACP_RELAY_MAX_OPAQUE_ID_BYTES = 512;
export const ACP_RELAY_MAX_TEXT_BYTES = 64 * 1024;
export const ACP_RELAY_MAX_COMMANDS = 100;

export type AcpReadinessState = "ready" | "missing" | "incompatible" | "authentication_required" | "unavailable";
export type AcpRegistrationId = "hermes-acp" | "opencode-acp";
export type AcpExecutionProfile = "interactive" | "autonomous" | "plan";
/** Closed Electron-only progress fact for a rejected OpenCode launch. */
export const ACP_START_FAILURE_STAGES = ["accepted", "launch_admitted", "initialized", "session_started", "prompt_admitted"] as const;
export type AcpStartFailureStage = typeof ACP_START_FAILURE_STAGES[number];
export type AcpSocketScope = Readonly<{ relayId: string; relaySessionId: string; desktopSessionId: string; pairingGenerationRef: string; selectedProtocolVersion: number; capabilityRevision: number }>;
/** Server-authored authority, intentionally separate from Electron's path receipt. */
export type AcpBindingScope = Readonly<{ bindingId: string; bindingGeneration: string; ownerId: string; taskId: string; taskRunId: string; jobId: string; profileId: string; profileGeneration: string; postureId: string; postureGeneration: string }>;
/** Opaque receipt facts returned by Electron; no local path or filesystem identity leaks. */
export type AcpWorkspaceReceipt = Readonly<{ workspaceReceiptId: string; workspaceRevision: string; workspaceFingerprint: string; workspaceExpiresAt: string }>;
export type AcpExecutionScope = Readonly<{ socket: AcpSocketScope; binding: AcpBindingScope; workspace: AcpWorkspaceReceipt }>;
export type AcpProcessScope = Readonly<{ connectionId: string; processGeneration: number; acpSessionId: string; turnGeneration: number; turnRef: string }>;
export type AcpExecutionCapabilities = Readonly<{ requests: "supported" | "unsupported" }>;

export type RelayAcpReadinessCommand = Readonly<{ type: "relay:acp-readiness"; requestId: string; scope: AcpSocketScope; registrationId: AcpRegistrationId }>;
export type RelayAcpReadinessResult = Readonly<{ type: "relay:acp-readiness-result"; requestId: string; scope: AcpSocketScope; registrationId: AcpRegistrationId; state: AcpReadinessState }>;
/** Electron prepares and locally validates one Current Folder receipt. */
export type RelayAcpPrepareCommand = Readonly<{ type: "relay:acp-prepare"; requestId: string; registrationId: AcpRegistrationId; scope: AcpSocketScope; binding: AcpBindingScope }>;
export type RelayAcpPreparedResult = Readonly<{ type: "relay:acp-prepared"; requestId: string; registrationId: AcpRegistrationId; scope: AcpSocketScope; binding: AcpBindingScope; workspace: AcpWorkspaceReceipt }>;
/** The sole ordinary-turn command: static registration plus bounded text. */
export type RelayAcpStartCommand =
  | Readonly<{ type: "relay:acp-start"; registrationId: "hermes-acp"; scope: AcpExecutionScope; prompt: string }>
  | Readonly<{ type: "relay:acp-start"; registrationId: "opencode-acp"; scope: AcpExecutionScope; prompt: string; executionProfile: AcpExecutionProfile }>;
/** Server fault-containment command: exact opaque turn identity, no diagnostics or user Stop. */
export type RelayAcpContainCommand = Readonly<{ type: "relay:acp-contain"; registrationId: AcpRegistrationId; containmentRef: string; scope: AcpExecutionScope; process: AcpProcessScope; code: "upstream_failure" }>;
/** Per-turn event identity makes relay replay and backpressure deterministic. */
export type AcpEventIdentity = Readonly<{ eventId: string; eventSequence: number }>;
export type RelayAcpStartedResult = Readonly<{ type: "relay:acp-started"; registrationId: AcpRegistrationId; scope: AcpExecutionScope; process: AcpProcessScope; capabilities: AcpExecutionCapabilities } & AcpEventIdentity>;
/** v15-only closed failure before a process/session identity exists. */
export type RelayAcpStartFailedResult = Readonly<{ type: "relay:acp-start-failed"; registrationId: "opencode-acp"; scope: AcpExecutionScope; stage: AcpStartFailureStage }>;
export type AcpSemanticPayload =
  | Readonly<{ kind: "output_delta"; vendorItemId: string | null; text: string }>
  | Readonly<{ kind: "assistant_completed"; vendorItemId: string | null; text: string }>
  | Readonly<{ kind: "command_summary"; vendorItemId: string | null; commands: readonly Readonly<{ summary: string; status: "completed" | "failed" | "running" }>[] }>
  /** v15 OpenCode-only, fixed-shape local process health transition. */
  | Readonly<{ kind: "runtime_status"; state: "possibly_stalled" | "healthy"; vendorItemId?: never }>;
export type RelayAcpSemanticEvent = Readonly<{ type: "relay:acp-semantic"; registrationId: AcpRegistrationId; scope: AcpExecutionScope; process: AcpProcessScope; capabilities: AcpExecutionCapabilities; payload: AcpSemanticPayload } & AcpEventIdentity>;
/** Terminal is separate so an event stream can establish one exact close. */
export type RelayAcpTerminalEvent = Readonly<{ type: "relay:acp-terminal"; registrationId: AcpRegistrationId; scope: AcpExecutionScope; process: AcpProcessScope; status: "completed" | "failed" | "interrupted"; code?: "invalid_request" | "process_lost" | "upstream_failure" | "user_stop" } & AcpEventIdentity>;

export type RelayAcpClientMessage = RelayAcpReadinessResult | RelayAcpPreparedResult | RelayAcpStartedResult | RelayAcpStartFailedResult | RelayAcpSemanticEvent | RelayAcpTerminalEvent;
export type RelayAcpServerMessage = RelayAcpReadinessCommand | RelayAcpPrepareCommand | RelayAcpStartCommand | RelayAcpContainCommand;
export type AcpParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: "ACP_FRAME_INVALID" };

export function parseRelayAcpCapability(value: unknown): AcpParseResult<RelayAcpCapability> {
  if (!isRecord(value) || !exact(value, ["version", "hostKind", "registrations"])
    || value["hostKind"] !== "electron" || !Array.isArray(value["registrations"])) return invalid();
  const legacy = value["version"] === 1 && value["registrations"].length === 1
    && value["registrations"][0] === "hermes-acp";
  const current = value["version"] === ACP_RELAY_CAPABILITY_VERSION && (
    (value["registrations"].length === 1 &&
      (value["registrations"][0] === "hermes-acp" || value["registrations"][0] === "opencode-acp")) ||
    (value["registrations"].length === 2 &&
      value["registrations"][0] === "hermes-acp" && value["registrations"][1] === "opencode-acp")
  );
  return legacy || current ? ok(value as unknown as RelayAcpCapability) : invalid();
}
/** Runtime admission helper for server-private prepare authority. */
export function isRelayAcpBindingScope(value: unknown): value is AcpBindingScope { return binding(value); }
export function parseRelayAcpJsonFrame(raw: string, direction: "client" | "server"): AcpParseResult<RelayAcpClientMessage | RelayAcpServerMessage> {
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > ACP_RELAY_MAX_FRAME_BYTES) return invalid();
  const type = classifyRelayTopLevelType(raw);
  const limit = isRelayAcpReadinessFrameType(type)
    ? ACP_RELAY_READINESS_MAX_FRAME_BYTES
    : ACP_RELAY_MAX_FRAME_BYTES;
  if (bytes > limit) return invalid();
  let value: unknown; try { value = JSON.parse(raw) as unknown; } catch { return invalid(); }
  return direction === "client" ? parseRelayAcpClientMessage(value) : parseRelayAcpServerMessage(value);
}
export function parseRelayAcpClientMessage(value: unknown): AcpParseResult<RelayAcpClientMessage> {
  if (!isRecord(value) || typeof value.type !== "string") return invalid();
  switch (value.type) {
    case "relay:acp-readiness-result": return exact(value, ["type", "requestId", "scope", "registrationId", "state"]) && identifier(value.requestId) && readinessScope(value.scope) && registrationForSocket(value.registrationId, value.scope) && readiness(value.state) ? ok(value as RelayAcpReadinessResult) : invalid();
    case "relay:acp-prepared": return exact(value, ["type", "requestId", "registrationId", "scope", "binding", "workspace"]) && identifier(value.requestId) && registrationForExecution(value.registrationId, value.scope) && binding(value.binding) && workspace(value.workspace) ? ok(value as RelayAcpPreparedResult) : invalid();
    case "relay:acp-started": return exact(value, ["type", "registrationId", "scope", "process", "capabilities", "eventId", "eventSequence"]) && registrationForExecution(value.registrationId, executionScopeSocket(value.scope)) && executionScope(value.scope) && process(value.process) && capabilities(value.capabilities) && eventIdentity(value) ? ok(value as RelayAcpStartedResult) : invalid();
    case "relay:acp-start-failed": return exact(value, ["type", "registrationId", "scope", "stage"]) && value.registrationId === "opencode-acp" && registrationForExecution(value.registrationId, executionScopeSocket(value.scope)) && executionScope(value.scope) && startFailureStage(value.stage) ? ok(value as RelayAcpStartFailedResult) : invalid();
    case "relay:acp-semantic": return exact(value, ["type", "registrationId", "scope", "process", "capabilities", "payload", "eventId", "eventSequence"]) && registrationForExecution(value.registrationId, executionScopeSocket(value.scope)) && executionScope(value.scope) && process(value.process) && capabilities(value.capabilities) && semantic(value.payload, value.registrationId, value.scope.socket) && eventIdentity(value) ? ok(value as RelayAcpSemanticEvent) : invalid();
    case "relay:acp-terminal": return exactTerminal(value) ? ok(value as RelayAcpTerminalEvent) : invalid();
    default: return invalid();
  }
}
export function parseRelayAcpServerMessage(value: unknown): AcpParseResult<RelayAcpServerMessage> {
  if (!isRecord(value) || typeof value.type !== "string") return invalid();
  switch (value.type) {
    case "relay:acp-readiness": return exact(value, ["type", "requestId", "scope", "registrationId"]) && identifier(value.requestId) && readinessScope(value.scope) && registrationForSocket(value.registrationId, value.scope) ? ok(value as RelayAcpReadinessCommand) : invalid();
    case "relay:acp-prepare": return exact(value, ["type", "requestId", "registrationId", "scope", "binding"]) && identifier(value.requestId) && registrationForExecution(value.registrationId, value.scope) && binding(value.binding) ? ok(value as RelayAcpPrepareCommand) : invalid();
    case "relay:acp-start": return exactStart(value) ? ok(value as RelayAcpStartCommand) : invalid();
    case "relay:acp-contain": return exact(value, ["type", "registrationId", "containmentRef", "scope", "process", "code"]) && registrationForExecution(value.registrationId, executionScopeSocket(value.scope)) && identifier(value["containmentRef"]) && executionScope(value.scope) && process(value.process) && value["code"] === "upstream_failure" ? ok(value as RelayAcpContainCommand) : invalid();
    default: return invalid();
  }
}
export function isRelayAcpFrameType(type: string | null): boolean { return type === "relay:acp-readiness" || type === "relay:acp-readiness-result" || type === "relay:acp-prepare" || type === "relay:acp-prepared" || type === "relay:acp-start" || type === "relay:acp-contain" || type === "relay:acp-started" || type === "relay:acp-start-failed" || type === "relay:acp-semantic" || type === "relay:acp-terminal"; }
export function isRelayAcpReadinessFrameType(type: string | null): boolean { return type === "relay:acp-readiness" || type === "relay:acp-readiness-result"; }
export function isRelayAcpReadinessResultForCommand(command: RelayAcpReadinessCommand, result: RelayAcpReadinessResult): boolean { return command.requestId === result.requestId && command.registrationId === result.registrationId && sameSocketScope(command.scope, result.scope); }

function exactTerminal(value: AcpRecord): boolean {
  const keys = value.code === undefined ? ["type", "registrationId", "scope", "process", "status", "eventId", "eventSequence"] : ["type", "registrationId", "scope", "process", "status", "code", "eventId", "eventSequence"];
  if (!exact(value, keys) || !registrationForExecution(value.registrationId, executionScopeSocket(value.scope)) || !executionScope(value.scope) || !process(value.process) || !eventIdentity(value)) return false;
  if (value.status === "completed") return value.code === undefined;
  if (value.status === "interrupted") return value.code === "user_stop";
  return value.status === "failed" && (value.code === "invalid_request" || value.code === "process_lost" || value.code === "upstream_failure");
}
function exactStart(value: AcpRecord): boolean {
  if (!executionScope(value.scope) || !text(value.prompt)) return false;
  if (value.registrationId === "hermes-acp") {
    return exact(value, ["type", "registrationId", "scope", "prompt"]);
  }
  return value.registrationId === "opencode-acp"
    && value.scope.socket.selectedProtocolVersion >= OPENCODE_ACP_RELAY_PROTOCOL_VERSION
    && exact(value, ["type", "registrationId", "scope", "prompt", "executionProfile"])
    && executionProfile(value.executionProfile);
}
function semantic(value: unknown, registrationId: unknown, socketScope: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "output_delta" || value.kind === "assistant_completed") return exact(value, ["kind", "vendorItemId", "text"]) && nullableIdentifier(value.vendorItemId) && text(value.text);
  if (value.kind === "command_summary") return exact(value, ["kind", "vendorItemId", "commands"]) && nullableIdentifier(value.vendorItemId) && Array.isArray(value.commands) && value.commands.length <= ACP_RELAY_MAX_COMMANDS && value.commands.every((item) => isRecord(item) && exact(item, ["summary", "status"]) && text(item.summary) && (item.status === "completed" || item.status === "failed" || item.status === "running"));
  return value.kind === "runtime_status" && registrationId === "opencode-acp" && executionSocket(socketScope) && socketScope.selectedProtocolVersion >= OPENCODE_ACP_RELAY_PROTOCOL_VERSION && exact(value, ["kind", "state"]) && (value.state === "possibly_stalled" || value.state === "healthy");
}
function executionScope(value: unknown): value is AcpExecutionScope { return isRecord(value) && exact(value, ["socket", "binding", "workspace"]) && executionSocket(value.socket) && binding(value.binding) && workspace(value.workspace); }
function readinessScope(value: unknown): value is AcpSocketScope { return socket(value, ACP_RELAY_READINESS_PROTOCOL_VERSION); }
function executionSocket(value: unknown): value is AcpSocketScope { return socket(value, ACP_RELAY_PROTOCOL_VERSION); }
function socket(value: unknown, minimum: number): value is AcpSocketScope { return isRecord(value) && exact(value, ["relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef", "selectedProtocolVersion", "capabilityRevision"]) && identifier(value.relayId) && identifier(value.relaySessionId) && identifier(value.desktopSessionId) && identifier(value.pairingGenerationRef) && typeof value.selectedProtocolVersion === "number" && Number.isSafeInteger(value.selectedProtocolVersion) && value.selectedProtocolVersion >= minimum && typeof value.capabilityRevision === "number" && Number.isSafeInteger(value.capabilityRevision) && value.capabilityRevision >= 0; }
function binding(value: unknown): value is AcpBindingScope { return isRecord(value) && exact(value, ["bindingId", "bindingGeneration", "ownerId", "taskId", "taskRunId", "jobId", "profileId", "profileGeneration", "postureId", "postureGeneration"]) && Object.values(value).every(identifier); }
function workspace(value: unknown): value is AcpWorkspaceReceipt { return isRecord(value) && exact(value, ["workspaceReceiptId", "workspaceRevision", "workspaceFingerprint", "workspaceExpiresAt"]) && identifier(value.workspaceReceiptId) && identifier(value.workspaceRevision) && identifier(value.workspaceFingerprint) && typeof value.workspaceExpiresAt === "string" && Number.isFinite(Date.parse(value.workspaceExpiresAt)); }
function process(value: unknown): value is AcpProcessScope { return isRecord(value) && exact(value, ["connectionId", "processGeneration", "acpSessionId", "turnGeneration", "turnRef"]) && identifier(value.connectionId) && identifier(value.acpSessionId) && identifier(value.turnRef) && typeof value.processGeneration === "number" && Number.isSafeInteger(value.processGeneration) && value.processGeneration > 0 && typeof value.turnGeneration === "number" && Number.isSafeInteger(value.turnGeneration) && value.turnGeneration > 0; }
function capabilities(value: unknown): value is AcpExecutionCapabilities { return isRecord(value) && exact(value, ["requests"]) && (value.requests === "supported" || value.requests === "unsupported"); }
function eventIdentity(value: AcpRecord): boolean { return identifier(value.eventId) && typeof value.eventSequence === "number" && Number.isSafeInteger(value.eventSequence) && value.eventSequence > 0; }
function executionScopeSocket(value: unknown): unknown { return isRecord(value) ? value.socket : undefined; }
function registrationForExecution(value: unknown, scope: unknown): value is AcpRegistrationId {
  if (!executionSocket(scope)) return false;
  return value === "hermes-acp"
    || (value === "opencode-acp" && scope.selectedProtocolVersion >= OPENCODE_ACP_RELAY_PROTOCOL_VERSION);
}
function registrationForSocket(value: unknown, scope: unknown): value is AcpRegistrationId {
  if (!readinessScope(scope)) return false;
  return value === "hermes-acp"
    || (value === "opencode-acp" && scope.selectedProtocolVersion >= OPENCODE_ACP_RELAY_PROTOCOL_VERSION);
}
function readiness(value: unknown): value is AcpReadinessState { return value === "ready" || value === "missing" || value === "incompatible" || value === "authentication_required" || value === "unavailable"; }
function executionProfile(value: unknown): value is AcpExecutionProfile { return value === "interactive" || value === "autonomous" || value === "plan"; }
export function isAcpStartFailureStage(value: unknown): value is AcpStartFailureStage { return typeof value === "string" && ACP_START_FAILURE_STAGES.includes(value as AcpStartFailureStage); }
function startFailureStage(value: unknown): value is AcpStartFailureStage { return isAcpStartFailureStage(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0") && new TextEncoder().encode(value).byteLength <= ACP_RELAY_MAX_TEXT_BYTES; }
function nullableIdentifier(value: unknown): boolean { return value === null || identifier(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0") && new TextEncoder().encode(value).byteLength <= ACP_RELAY_MAX_OPAQUE_ID_BYTES; }
function invalid(): AcpParseResult<never> { return { ok: false, error: "ACP_FRAME_INVALID" }; }
function ok<T>(value: T): AcpParseResult<T> { return { ok: true, value }; }
type AcpRecord = Record<string, unknown> & {
  type?: unknown; requestId?: unknown; scope?: unknown; registrationId?: unknown;
  state?: unknown; binding?: unknown; workspace?: unknown; process?: unknown;
  capabilities?: unknown; payload?: unknown; prompt?: unknown; message?: unknown;
  code?: unknown; status?: unknown; kind?: unknown; vendorItemId?: unknown;
  text?: unknown; commands?: unknown; socket?: unknown; relayId?: unknown;
  relaySessionId?: unknown; desktopSessionId?: unknown; pairingGenerationRef?: unknown;
  selectedProtocolVersion?: unknown; capabilityRevision?: unknown; bindingId?: unknown;
  bindingGeneration?: unknown; ownerId?: unknown; taskId?: unknown; taskRunId?: unknown;
  jobId?: unknown; profileId?: unknown; profileGeneration?: unknown; postureId?: unknown;
  postureGeneration?: unknown; workspaceReceiptId?: unknown; workspaceRevision?: unknown;
  workspaceFingerprint?: unknown; workspaceExpiresAt?: unknown; connectionId?: unknown;
  processGeneration?: unknown; acpSessionId?: unknown; turnGeneration?: unknown; turnRef?: unknown;
  requests?: unknown; summary?: unknown; eventId?: unknown; eventSequence?: unknown; executionProfile?: unknown; stage?: unknown;
};
function isRecord(value: unknown): value is AcpRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: AcpRecord, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function sameSocketScope(left: AcpSocketScope, right: AcpSocketScope): boolean { return left.relayId === right.relayId && left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef && left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision; }
