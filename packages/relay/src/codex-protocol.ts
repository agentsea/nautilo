import {
  CODEX_RELAY_MAX_FRAME_BYTES,
} from "./constants";
import {
  CODEX_RELAY_CAPABILITY_VERSION,
  type RelayCodexCapability,
} from "./types";

/** D453 v8. Kept separate from generic relay dispatch on purpose. */
export const CODEX_RELAY_PROTOCOL_VERSION = 8 as const;
/** v17 carries streamed assistant completions without truncating canonical text. */
export const CODEX_STREAMED_COMPLETION_PROTOCOL_VERSION = 17 as const;
/** Codex was introduced in relay v8 and remains available in additive successors. */
export function isCodexRelayProtocolVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= CODEX_RELAY_PROTOCOL_VERSION;
}
/** Product-wide reviewed managed-runtime artifact; browser callers never supply it. */
export const CODEX_REVIEWED_RUNTIME_ARTIFACT_REF = "catalog-revision-k7p4m2v9x8d6";
export const CODEX_RELAY_MAX_OPAQUE_ID_BYTES = 512;
export const CODEX_RELAY_MAX_TEXT_BYTES = 64 * 1024;
export const CODEX_RELAY_MAX_EVENT_BYTES = 64 * 1024;

export type CodexCompatibility =
  | "certified" | "compatible_uncertified" | "limited" | "incompatible";
export type CodexCompatibilityDiagnostic = {
  readonly feature: "core" | "steer" | "approvals" | "request_user_input" | "collaboration_modes";
  readonly reason: "missing_member" | "missing_field" | "changed_field_shape";
};
export type CodexStableErrorCode =
  | "CODEX_RELAY_UNAVAILABLE" | "CODEX_CAPABILITY_UNAVAILABLE"
  | "CODEX_CONTEXT_INVALID" | "CODEX_CONTEXT_STALE" | "CODEX_WORKSPACE_STALE"
  | "CODEX_PROFILE_UNAVAILABLE" | "CODEX_RUNTIME_UNAVAILABLE" | "CODEX_RUNTIME_INCOMPATIBLE"
  | "CODEX_CHILD_START_FAILED" | "CODEX_CHILD_CRASHED" | "CODEX_CHILD_DRAINING"
  | "CODEX_FRAME_INVALID" | "CODEX_FRAME_TOO_LARGE" | "CODEX_QUEUE_FULL"
  | "CODEX_TIMEOUT" | "CODEX_CANCELLED" | "CODEX_GENERATION_STALE"
  | "CODEX_CORRELATION_REPLAY"
  | "CODEX_APPROVAL_EXPIRED" | "CODEX_INPUT_UNSUPPORTED" | "CODEX_INPUT_EXPIRED"
  | "CODEX_UNCERTAIN_SIDE_EFFECT" | "CODEX_UPSTREAM_FAILURE";

/** Reviewed runtime-manager outcomes only; raw installation errors never cross the relay. */
export type CodexRuntimeInstallCode =
  | "CODEX_RUNTIME_NOT_FOUND"
  | "CODEX_RUNTIME_NOT_EXECUTABLE"
  | "CODEX_RUNTIME_WRONG_ARCHITECTURE"
  | "CODEX_RUNTIME_UNHEALTHY"
  | "CODEX_RUNTIME_TIMEOUT"
  | "CODEX_RUNTIME_CANCELLED"
  | "CODEX_RUNTIME_IDENTITY_CHANGED"
  | "CODEX_RUNTIME_SCHEMA_INVALID"
  | "CODEX_RUNTIME_INCOMPATIBLE"
  | "CODEX_RUNTIME_STANDALONE_UNSUPPORTED"
  | "CODEX_RUNTIME_VERSION_INVALID"
  | "CODEX_RUNTIME_OUTPUT_LIMIT"
  | "CODEX_RUNTIME_PATH_INVALID"
  | "CODEX_RUNTIME_EXECUTABLE_LIMIT"
  | "CODEX_RUNTIME_PLATFORM_UNSUPPORTED"
  | "CODEX_RUNTIME_ARTIFACT_INVALID"
  | "CODEX_RUNTIME_SIGNATURE_INVALID"
  | "CODEX_RUNTIME_INSTALL_FAILED";
export type CodexRuntimeInstallPhase =
  | "absent" | "resolving" | "downloading" | "verifying" | "staging"
  | "activating" | "ready" | "rollback" | "cancelled" | "failed";
export type CodexRuntimeInstallation = {
  readonly phase: CodexRuntimeInstallPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly canCancel: boolean;
  readonly code?: CodexRuntimeInstallCode;
};

export type CodexFeatureGates = {
  readonly stableConversation: boolean; readonly explicitSteer: boolean;
  readonly codexApprovals: boolean; readonly requestUserInput: boolean;
  /** Absent only on a pre-Plan desktop; callers must treat absence as false. */
  readonly collaborationMode?: boolean;
};
export type WorkspaceReceipt = {
  readonly workspaceRef: string; readonly revision: number; readonly fingerprint: string;
  readonly issuedAt: string; readonly expiresAt: string;
};
export type V8SocketScope = {
  readonly relayId: string; readonly relaySessionId: string; readonly desktopSessionId: string;
  readonly pairingGenerationRef: string; readonly selectedProtocolVersion: number;
};
export type HostScope = V8SocketScope & { readonly capabilityRevision: number };
export type ProfileLaunchScope = HostScope & {
  readonly profileHandle: string; readonly profileGeneration: number;
  readonly accountGeneration: number; readonly runtimeGeneration: number;
};
export type ProfileScope = ProfileLaunchScope & { readonly childGeneration: number };
export type BindingOpenScope = ProfileScope & {
  readonly workspace: WorkspaceReceipt; readonly bindingId: string;
  readonly bindingGeneration: number; readonly taskId: string; readonly jobId: string;
};
export type BindingIdentityScope = ProfileScope & {
  readonly bindingId: string; readonly bindingGeneration: number; readonly taskId: string;
  readonly jobId: string; readonly threadId: string;
};
export type BindingScope = BindingIdentityScope & { readonly workspace: WorkspaceReceipt };
export type TurnScope = BindingScope & { readonly turnId: string };
export type TurnEventScope = TurnScope & { readonly eventId: string };
export type ItemScope = TurnEventScope & { readonly itemId: string };
export type ProfileEventScope = ProfileScope & { readonly eventId: string };
export type RequestScope = ItemScope & { readonly requestRef: string };

export type CodexPosture =
  | { readonly kind: "codex_default"; readonly anchorMode: "default" }
  | { readonly kind: "prompted_workspace"; readonly anchorMode: "workspace-write"; readonly approvalPolicy: "on-request" }
  | { readonly kind: "full_access_headless"; readonly anchorMode: "danger-full-access"; readonly approvalPolicy: "never" };
export type CodexRuntimeCommand =
  | { readonly kind: "runtime_inspect" }
  | { readonly kind: "runtime_install"; readonly artifactRef: string }
  | { readonly kind: "runtime_cancel_install"; readonly installRef: string }
  | { readonly kind: "runtime_activate"; readonly runtimeGeneration: number }
  | { readonly kind: "runtime_rollback" }
  | { readonly kind: "runtime_remove"; readonly runtimeGeneration: number };
export type CodexProfileCommand =
  | { readonly kind: "profile_create"; readonly profileHandle: string; readonly profileGeneration: number }
  | { readonly kind: "profile_remove"; readonly profileHandle: string; readonly profileGeneration: number };
export type CodexAccountCommand =
  | { readonly kind: "account_login_start" }
  | { readonly kind: "account_login_cancel"; readonly loginRef: string }
  | { readonly kind: "account_read" } | { readonly kind: "account_logout" }
  | { readonly kind: "account_rate_limits_read" } | { readonly kind: "account_usage_read" }
  | { readonly kind: "model_list" };

export type RelayCodexCommandMessage =
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: HostScope; readonly command: CodexRuntimeCommand | { readonly kind: "profile_create"; readonly profileHandle: string; readonly profileGeneration: number } }
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: ProfileLaunchScope; readonly command: { readonly kind: "profile_remove"; readonly profileHandle: string; readonly profileGeneration: number } }
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: ProfileScope; readonly command: CodexAccountCommand }
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: ProfileLaunchScope; readonly command: { readonly kind: "ensure_profile_child"; readonly posture: CodexPosture } }
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: BindingOpenScope; readonly command: { readonly kind: "open_binding"; readonly model?: string; readonly posture: CodexPosture; readonly workingDirectory?: string } }
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: BindingIdentityScope; readonly command: { readonly kind: "rebind_binding"; readonly nextBindingGeneration: number; readonly successorWorkspace: WorkspaceReceipt } }
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: BindingScope; readonly command: { readonly kind: "resume_binding" } | { readonly kind: "release_binding" } | { readonly kind: "start_turn"; readonly userText: string; readonly turnInputRef: string; readonly collaborationMode?: "plan" } }
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: TurnScope; readonly command: { readonly kind: "steer_turn"; readonly userText: string; readonly actorRef: string } | { readonly kind: "interrupt_turn"; readonly reason: "user_stop" | "deadline" | "drain" } }
  | { readonly type: "relay:codex-command"; readonly commandId: string; readonly scope: ProfileScope; readonly command: { readonly kind: "drain_profile"; readonly deadlineAt: string } | { readonly kind: "terminate_child"; readonly reason: "interrupt_escalation" | "host_shutdown" } };
export type RelayCodexCancelMessage = { readonly type: "relay:codex-cancel"; readonly scope: TurnScope; readonly reason: "job_stop" | "deadline" | "profile_removed" | "generation_replaced" | "relay_disconnect" };
export type RelayCodexCreditMessage = { readonly type: "relay:codex-credit"; readonly scope: ProfileScope; readonly throughEventSequence: number; readonly grantEvents: number; readonly grantBytes: number };
/** Base decisions that can be represented without synthesizing a policy amendment. */
export type CodexBaseApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
/**
 * The desktop may know a reason, command, cwd, or file root that is unsafe to
 * send across the relay. A later host-local renderer can resolve this token;
 * browser consumers must not assume the omitted value is available.
 */
export type CodexHostLocalDetailState = "not_provided" | "host_local_only";
export type CodexCommandActionKind = "read" | "list_files" | "search" | "unknown";
export type CodexInputOption = {
  /** Deterministic opaque local token; it is never the upstream answer label. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
};
export type CodexInputQuestion = {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly isOther: boolean;
  readonly isSecret: boolean;
  readonly options: readonly CodexInputOption[] | null;
};
export type RelayCodexRequestResponseMessage =
  | { readonly type: "relay:codex-request-response"; readonly scope: RequestScope; readonly response: { readonly kind: "command_approval" | "network_approval" | "file_change_approval"; readonly decision: CodexBaseApprovalDecision } }
  | { readonly type: "relay:codex-request-response"; readonly scope: RequestScope; readonly response: { readonly kind: "permissions_approval"; readonly grants: { readonly network: boolean; readonly fileSystem: boolean }; readonly scope: "turn" | "session" } }
  | { readonly type: "relay:codex-request-response"; readonly scope: RequestScope; readonly response: { readonly kind: "user_input"; readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>> } }
  ;

export type CodexSafeAccountPlan = "free" | "go" | "plus" | "pro" | "prolite" | "team" | "business" | "enterprise" | "ent26" | "edu" | "unknown" | "self_serve_business_usage_based" | "enterprise_cbp_usage_based";
export type CodexSafeRateLimitWindow = { readonly usedPercent: number; readonly windowDurationMins: number | null; readonly resetsAt: string | null };
export type CodexSafeRateLimits = { readonly primary: CodexSafeRateLimitWindow | null; readonly secondary: CodexSafeRateLimitWindow | null; readonly plan: "free" | "go" | "plus" | "pro" | "prolite" | "team" | "business" | "enterprise" | "edu" | "usage_based" | "unknown" | null; readonly credits: { readonly hasCredits: boolean; readonly unlimited: boolean; readonly balance: string | null } | null; readonly spendControl: { readonly limit: string; readonly used: string; readonly remainingPercent: number; readonly resetsAt: string } | null; readonly reached: "rate_limit_reached" | "credits_depleted" | "usage_limit_reached" | null; readonly observedAt: string; readonly freshness: "live" | "cached" | "stale" };
export type CodexSafeAccountUsage = { readonly summary: { readonly lifetimeTokens: string | null; readonly peakDailyTokens: string | null; readonly longestRunningTurnSec: string | null; readonly currentStreakDays: string | null; readonly longestStreakDays: string | null }; readonly daily: readonly { readonly startDate: string; readonly tokens: string }[]; readonly observedAt: string; readonly freshness: "live" | "cached" | "stale" };
export type CodexSafeModelCatalog = { readonly models: readonly { readonly id: string; readonly model: string; readonly displayName: string; readonly description: string; readonly isDefault: boolean }[] };
export type CodexAdminResult =
  | { readonly kind: "runtime_status"; readonly state: "absent" | "installing" | "ready" | "incompatible" | "draining" | "failed"; readonly runtimeGeneration?: number; readonly installRef?: string }
  | { readonly kind: "profile_status"; readonly state: "created"; readonly profileHandle: string; readonly profileGeneration: number; readonly homeHandle: string }
  | { readonly kind: "profile_status"; readonly state: "removed"; readonly profileHandle: string; readonly profileGeneration: number }
  | { readonly kind: "login_started"; readonly loginRef: string; readonly state: "waiting_for_browser" }
  | { readonly kind: "account_status"; readonly state: "signed_in" | "signed_out" | "reauth_required"; readonly accountGeneration: number; readonly accountEmail?: string | null; readonly planType?: CodexSafeAccountPlan | null }
  | { readonly kind: "rate_limits_status"; readonly value: CodexSafeRateLimits }
  | { readonly kind: "account_usage_status"; readonly value: CodexSafeAccountUsage }
  | { readonly kind: "model_catalog_status"; readonly value: CodexSafeModelCatalog };
type CodexRejectedResult = { readonly kind: "rejected"; readonly code: CodexStableErrorCode };
type CodexRuntimeStatusResult = Extract<CodexAdminResult, { readonly kind: "runtime_status" }>;
type CodexProfileStatusResult = Extract<CodexAdminResult, { readonly kind: "profile_status" }>;
type CodexAccountResult = Exclude<
  CodexAdminResult,
  CodexRuntimeStatusResult | CodexProfileStatusResult
>;
export type RelayCodexHostCommandResponse = { readonly type: "relay:codex-command-response"; readonly commandId: string; readonly scope: HostScope; readonly result: CodexRuntimeStatusResult | Extract<CodexProfileStatusResult, { readonly state: "created" }> | CodexRejectedResult };
export type RelayCodexProfileLaunchCommandResponse = { readonly type: "relay:codex-command-response"; readonly commandId: string; readonly scope: ProfileLaunchScope; readonly result: Extract<CodexProfileStatusResult, { readonly state: "removed" }> | CodexRejectedResult };
export type RelayCodexProfileCommandResponse = { readonly type: "relay:codex-command-response"; readonly commandId: string; readonly scope: ProfileScope; readonly result: CodexAccountResult | { readonly kind: "child_ready" | "drained" | "terminated" } | CodexRejectedResult };
export type RelayCodexBindingOpenCommandResponse = { readonly type: "relay:codex-command-response"; readonly commandId: string; readonly scope: BindingOpenScope; readonly result: CodexRejectedResult };
export type RelayCodexBindingCommandResponse = { readonly type: "relay:codex-command-response"; readonly commandId: string; readonly scope: BindingScope; readonly result: { readonly kind: "binding_ready" | "binding_rebound" | "binding_released" } | CodexRejectedResult };
export type RelayCodexTurnCommandResponse = { readonly type: "relay:codex-command-response"; readonly commandId: string; readonly scope: TurnScope; readonly result: { readonly kind: "accepted" | "turn_started" | "interrupted" } | CodexRejectedResult };
export type RelayCodexCommandResponseMessage =
  | RelayCodexHostCommandResponse
  | RelayCodexProfileLaunchCommandResponse
  | RelayCodexProfileCommandResponse
  | RelayCodexBindingOpenCommandResponse
  | RelayCodexBindingCommandResponse
  | RelayCodexTurnCommandResponse;
export type RelayCodexRequestMessage =
  | { readonly type: "relay:codex-request"; readonly scope: RequestScope; readonly request: {
      readonly kind: "command_approval";
      readonly choices: readonly CodexBaseApprovalDecision[];
      readonly reason: CodexHostLocalDetailState;
      readonly command: { readonly detail: CodexHostLocalDetailState; readonly actionKinds: readonly CodexCommandActionKind[] };
      readonly expiresAt: string;
    } }
  | { readonly type: "relay:codex-request"; readonly scope: RequestScope; readonly request: {
      readonly kind: "network_approval";
      readonly choices: readonly CodexBaseApprovalDecision[];
      readonly reason: CodexHostLocalDetailState;
      readonly network: { readonly host: string; readonly protocol: "http" | "https" | "socks5Tcp" | "socks5Udp" };
      readonly expiresAt: string;
    } }
  | { readonly type: "relay:codex-request"; readonly scope: RequestScope; readonly request: {
      readonly kind: "file_change_approval";
      readonly choices: readonly CodexBaseApprovalDecision[];
      readonly reason: CodexHostLocalDetailState;
      readonly grantRoot: CodexHostLocalDetailState;
      readonly expiresAt: string;
    } }
  | { readonly type: "relay:codex-request"; readonly scope: RequestScope; readonly request: {
      readonly kind: "permissions_approval";
      readonly reason: CodexHostLocalDetailState;
      readonly permissions: {
        readonly network: { readonly enabled: boolean | null } | null;
        readonly fileSystem: { readonly readPathCount: number; readonly writePathCount: number; readonly entryCount: number; readonly pathDetail: CodexHostLocalDetailState } | null;
      };
      readonly expiresAt: string;
    } }
  | { readonly type: "relay:codex-request"; readonly scope: RequestScope; readonly request: { readonly kind: "user_input"; readonly questions: readonly CodexInputQuestion[]; readonly autoResolutionMs: number | null; readonly expiresAt: string } }
  ;
export type CodexRelayEvent =
  | { readonly kind: "child_status"; readonly state: "starting" | "ready" | "draining" | "stopped" | "crashed"; readonly code?: CodexStableErrorCode }
  | { readonly kind: "turn_status"; readonly state: "queued" | "running" | "completed" | "failed" | "interrupted" | "uncertain"; readonly code?: CodexStableErrorCode }
  | { readonly kind: "message_delta"; readonly text: string; readonly sequence: number }
  /** Bounded decoded projection; never an upstream JSON-RPC envelope. */
  | { readonly kind: "assistant_item_completed"; readonly text: string | null; readonly phase: "commentary" | "final_answer" | null; readonly sequence: number }
  /**
   * Bounded assistant-item projection from `turn/completed`. `itemsView`
   * preserves whether that projection may replace ordered item completions.
   * The paired host excludes hidden items and raw upstream errors.
   */
  | { readonly kind: "turn_completed"; readonly status: "completed" | "failed" | "interrupted" | "uncertain"; readonly itemsView: "notLoaded" | "summary" | "full"; readonly assistantItems: readonly { readonly itemId: string; readonly text: string | null; readonly phase: "commentary" | "final_answer" | null }[]; readonly code?: CodexStableErrorCode }
  | { readonly kind: "progress"; readonly phase: "thinking" | "tool" | "waiting" | "finalizing"; readonly sequence: number }
  | { readonly kind: "command_summary" | "patch_summary"; readonly summary: string; readonly sequence: number }
  | { readonly kind: "usage_status"; readonly state: "updated" | "rate_limited" | "unavailable" };
export type RelayCodexEventMessage =
  | { readonly type: "relay:codex-event"; readonly scope: ProfileEventScope; readonly eventSequence: number; readonly event: Extract<CodexRelayEvent, { readonly kind: "child_status" }> }
  | { readonly type: "relay:codex-event"; readonly scope: TurnEventScope; readonly eventSequence: number; readonly event: Extract<CodexRelayEvent, { readonly kind: "turn_status" | "progress" | "usage_status" | "turn_completed" }> }
  | { readonly type: "relay:codex-event"; readonly scope: ItemScope; readonly eventSequence: number; readonly event: Extract<CodexRelayEvent, { readonly kind: "message_delta" | "assistant_item_completed" | "command_summary" | "patch_summary" }> };
export type CodexHostStatus = { readonly state: "ready" | "limited" | "runtime_unavailable" | "runtime_incompatible" | "supervisor_unavailable" | "workspace_unavailable"; readonly compatibility?: CodexCompatibility; readonly features?: CodexFeatureGates; readonly runtimeGeneration?: number; readonly runtime?: { readonly state: "absent" | "installing" | "ready" | "incompatible" | "draining" | "failed"; /** Relay/server private cancellation authority; browser DTOs omit it. */ readonly installRef?: string; readonly source?: "external" | "managed"; readonly version?: string; readonly installation?: CodexRuntimeInstallation; readonly compatibilityDiagnostics?: readonly CodexCompatibilityDiagnostic[] }; readonly profiles?: readonly { readonly profileHandle: string; readonly profileGeneration: number; readonly accountGeneration: number; readonly state: "signed_out" | "signed_in" | "reauth_required" | "busy" | "draining"; readonly childGeneration?: number; readonly rateLimits?: CodexSafeRateLimits; readonly usage?: CodexSafeAccountUsage }[]; readonly workspace: { readonly state: "bound"; readonly receipt: WorkspaceReceipt } | { readonly state: "unavailable" | "stale" } };
export type RelayCodexStatusMessage = { readonly type: "relay:codex-status"; readonly socket: V8SocketScope; readonly capabilityRevision: number; readonly status: CodexHostStatus };
export type RelayCodexClientMessage = RelayCodexStatusMessage | RelayCodexCommandResponseMessage | RelayCodexRequestMessage | RelayCodexEventMessage;
export type RelayCodexServerMessage = RelayCodexCommandMessage | RelayCodexCancelMessage | RelayCodexCreditMessage | RelayCodexRequestResponseMessage;
export type RelayRegisteredV8 = { readonly type: "relay:registered"; readonly relayId: string; readonly protocolVersion: number; readonly relaySessionId: string; readonly pairingGenerationRef: string; readonly selectedProtocolVersion: number };

export type CodexParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CodexStableErrorCode };
const textEncoder = new TextEncoder();
const stableCodes = new Set<string>(["CODEX_RELAY_UNAVAILABLE","CODEX_CAPABILITY_UNAVAILABLE","CODEX_CONTEXT_INVALID","CODEX_CONTEXT_STALE","CODEX_WORKSPACE_STALE","CODEX_PROFILE_UNAVAILABLE","CODEX_RUNTIME_UNAVAILABLE","CODEX_RUNTIME_INCOMPATIBLE","CODEX_CHILD_START_FAILED","CODEX_CHILD_CRASHED","CODEX_CHILD_DRAINING","CODEX_FRAME_INVALID","CODEX_FRAME_TOO_LARGE","CODEX_QUEUE_FULL","CODEX_TIMEOUT","CODEX_CANCELLED","CODEX_GENERATION_STALE","CODEX_CORRELATION_REPLAY","CODEX_APPROVAL_EXPIRED","CODEX_INPUT_UNSUPPORTED","CODEX_INPUT_EXPIRED","CODEX_UNCERTAIN_SIDE_EFFECT","CODEX_UPSTREAM_FAILURE"]);
interface WireRecord extends Record<string, unknown> {
  type?: unknown; kind?: unknown; status?: unknown; state?: unknown; code?: unknown;
  relayId?: unknown; relaySessionId?: unknown; desktopSessionId?: unknown;
  pairingGenerationRef?: unknown; selectedProtocolVersion?: unknown; capabilityRevision?: unknown;
  workspaceRef?: unknown; revision?: unknown; fingerprint?: unknown; issuedAt?: unknown; expiresAt?: unknown;
  profileHandle?: unknown; profileGeneration?: unknown; accountGeneration?: unknown;
  runtimeGeneration?: unknown; childGeneration?: unknown; bindingGeneration?: unknown;
  bindingId?: unknown; taskId?: unknown; jobId?: unknown; threadId?: unknown;
  turnId?: unknown; eventId?: unknown; itemId?: unknown;
  requestRef?: unknown; workspace?: unknown; socket?: unknown; scope?: unknown;
  commandId?: unknown; command?: unknown; result?: unknown; response?: unknown; request?: unknown;
  event?: unknown; eventSequence?: unknown; throughEventSequence?: unknown; grantEvents?: unknown; grantBytes?: unknown;
  anchorMode?: unknown; approvalPolicy?: unknown; posture?: unknown;
  model?: unknown;
  artifactRef?: unknown; installRef?: unknown; loginRef?: unknown;
  nextBindingGeneration?: unknown; successorWorkspace?: unknown;
  userText?: unknown; turnInputRef?: unknown; collaborationMode?: unknown; actorRef?: unknown; reason?: unknown; deadlineAt?: unknown;
  text?: unknown; sequence?: unknown; phase?: unknown; assistantItems?: unknown;
  value?: unknown; content?: unknown; decision?: unknown; answers?: unknown; grants?: unknown;
  id?: unknown; header?: unknown; question?: unknown; isOther?: unknown; isSecret?: unknown; options?: unknown;
  label?: unknown; tokens?: unknown; rateLimits?: unknown; usage?: unknown; receipt?: unknown;
  accountEmail?: unknown; planType?: unknown;
  models?: unknown; displayName?: unknown; isDefault?: unknown;
  category?: unknown; choices?: unknown; questions?: unknown; input?: unknown; autoResolutionMs?: unknown;
  network?: unknown; fileSystem?: unknown; grantRoot?: unknown;
  detail?: unknown; actionKinds?: unknown; host?: unknown; protocol?: unknown;
  enabled?: unknown; readPathCount?: unknown; writePathCount?: unknown; entryCount?: unknown; pathDetail?: unknown;
  version?: unknown; hostKind?: unknown; maxProfiles?: unknown; maxActiveTurns?: unknown;
  usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown;
  primary?: unknown; secondary?: unknown; plan?: unknown; credits?: unknown; spendControl?: unknown;
  reached?: unknown; observedAt?: unknown; freshness?: unknown; hasCredits?: unknown;
  unlimited?: unknown; balance?: unknown; limit?: unknown; used?: unknown; remainingPercent?: unknown;
  summary?: unknown; daily?: unknown; lifetimeTokens?: unknown; peakDailyTokens?: unknown;
  longestRunningTurnSec?: unknown; currentStreakDays?: unknown; longestStreakDays?: unknown;
  startDate?: unknown; compatibility?: unknown; features?: unknown; runtime?: unknown; profiles?: unknown;
  stableConversation?: unknown; explicitSteer?: unknown; codexApprovals?: unknown;
  requestUserInput?: unknown;
  source?: unknown; installation?: unknown; receivedBytes?: unknown; totalBytes?: unknown; canCancel?: unknown;
}
/** Untrusted JSON is read dynamically and reconstructed only after exact validation. */
const isRecord = (v: unknown): v is WireRecord =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const bytes = (v: string) => textEncoder.encode(v).byteLength;
const str = (v: unknown, max = CODEX_RELAY_MAX_OPAQUE_ID_BYTES): v is string => typeof v === "string" && v.length > 0 && bytes(v) <= max;
const nonNegative = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === "string" && (values as readonly string[]).includes(v);
function exact(v: unknown, required: readonly string[], optional: readonly string[] = []): v is WireRecord {
  return isRecord(v) && required.every((key) => Object.prototype.hasOwnProperty.call(v, key)) && Object.keys(v).every((key) => required.includes(key) || optional.includes(key));
}
const normalizedIso = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 32 &&
  Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v;
const normalizedDate = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T00:00:00.000Z`)) &&
  new Date(Date.parse(`${v}T00:00:00.000Z`)).toISOString().startsWith(v);
function code(v: unknown): v is CodexStableErrorCode { return typeof v === "string" && stableCodes.has(v); }
function scope(v: unknown, level: "host" | "launch" | "profile" | "bindingOpen" | "bindingIdentity" | "binding" | "turn" | "turnEvent" | "item" | "profileEvent" | "request"): boolean {
  const base = ["relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef", "selectedProtocolVersion", "capabilityRevision"];
  const extra: Record<string, string[]> = { host: [], launch: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration"], profile: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration"], bindingOpen: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration","workspace","bindingId","bindingGeneration","taskId","jobId"], bindingIdentity: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration","bindingId","bindingGeneration","taskId","jobId","threadId"], binding: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration","bindingId","bindingGeneration","taskId","jobId","threadId","workspace"], turn: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration","bindingId","bindingGeneration","taskId","jobId","threadId","workspace","turnId"], turnEvent: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration","bindingId","bindingGeneration","taskId","jobId","threadId","workspace","turnId","eventId"], item: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration","bindingId","bindingGeneration","taskId","jobId","threadId","workspace","turnId","eventId","itemId"], profileEvent: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration","eventId"], request: ["profileHandle","profileGeneration","accountGeneration","runtimeGeneration","childGeneration","bindingId","bindingGeneration","taskId","jobId","threadId","workspace","turnId","eventId","itemId","requestRef"] };
  if (!exact(v, [...base, ...(extra[level] ?? [])])) return false;
  const r = v as Record<string, unknown>;
  if (!str(r["relayId"]) || !str(r["relaySessionId"]) || !str(r["desktopSessionId"]) || !str(r["pairingGenerationRef"]) || !isCodexRelayProtocolVersion(r["selectedProtocolVersion"]) || !nonNegative(r["capabilityRevision"])) return false;
  for (const key of ["profileHandle","bindingId","taskId","jobId","threadId","turnId","eventId","itemId","requestRef"]) if (key in r && !str(r[key])) return false;
  for (const key of ["profileGeneration","accountGeneration","runtimeGeneration","childGeneration","bindingGeneration"]) if (key in r && !nonNegative(r[key])) return false;
  return !("workspace" in r) || receipt(r["workspace"]);
}
function receipt(v: unknown): v is WorkspaceReceipt { return exact(v,["workspaceRef","revision","fingerprint","issuedAt","expiresAt"]) && str(v.workspaceRef) && nonNegative(v.revision) && str(v.fingerprint) && normalizedIso(v.issuedAt) && normalizedIso(v.expiresAt); }
function socketScope(v: unknown): v is V8SocketScope { return exact(v,["relayId","relaySessionId","desktopSessionId","pairingGenerationRef","selectedProtocolVersion"]) && str(v.relayId) && str(v.relaySessionId) && str(v.desktopSessionId) && str(v.pairingGenerationRef) && isCodexRelayProtocolVersion(v.selectedProtocolVersion); }
function posture(v: unknown): v is CodexPosture { return (exact(v,["kind","anchorMode"]) && v.kind === "codex_default" && v.anchorMode === "default") || (exact(v,["kind","anchorMode","approvalPolicy"]) && v.kind === "prompted_workspace" && v.anchorMode === "workspace-write" && v.approvalPolicy === "on-request") || (exact(v,["kind","anchorMode","approvalPolicy"]) && v.kind === "full_access_headless" && v.anchorMode === "danger-full-access" && v.approvalPolicy === "never"); }
function command(v: unknown): { level: Parameters<typeof scope>[1] } | null {
  if (!isRecord(v) || !str(v.kind)) return null;
  const kind = v.kind;
  if (["runtime_inspect","runtime_rollback"].includes(kind) && exact(v,["kind"])) return { level: "host" };
  if (kind === "runtime_install" && exact(v,["kind","artifactRef"]) && str(v.artifactRef)) return { level: "host" };
  if (kind === "runtime_cancel_install" && exact(v,["kind","installRef"]) && str(v.installRef)) return { level: "host" };
  if (["runtime_activate","runtime_remove"].includes(kind) && exact(v,["kind","runtimeGeneration"]) && nonNegative(v.runtimeGeneration)) return { level: "host" };
  if (kind === "profile_create" && exact(v,["kind","profileHandle","profileGeneration"]) && str(v.profileHandle) && nonNegative(v.profileGeneration)) return { level: "host" };
  if (kind === "profile_remove" && exact(v,["kind","profileHandle","profileGeneration"]) && str(v.profileHandle) && nonNegative(v.profileGeneration)) return { level: "launch" };
  if (["account_login_start","account_read","account_logout","account_rate_limits_read","account_usage_read","model_list"].includes(kind) && exact(v,["kind"])) return { level: "profile" };
  if (kind === "account_login_cancel" && exact(v,["kind","loginRef"]) && str(v.loginRef)) return { level: "profile" };
  if (kind === "ensure_profile_child" && exact(v,["kind","posture"]) && posture(v.posture)) return { level: "launch" };
  if (kind === "open_binding" && exact(v,["kind","posture"],["model","workingDirectory"]) && posture(v.posture) && (v.model === undefined || str(v.model)) && (v["workingDirectory"] === undefined || str(v["workingDirectory"], 4096))) return { level: "bindingOpen" };
  if (kind === "rebind_binding" && exact(v,["kind","nextBindingGeneration","successorWorkspace"]) && nonNegative(v.nextBindingGeneration) && receipt(v.successorWorkspace)) return { level: "bindingIdentity" };
  if (["resume_binding","release_binding"].includes(kind) && exact(v,["kind"])) return { level: "binding" };
  if (kind === "start_turn" && exact(v,["kind","userText","turnInputRef"],["collaborationMode"]) && str(v.userText,CODEX_RELAY_MAX_TEXT_BYTES) && str(v.turnInputRef) && (v.collaborationMode === undefined || v.collaborationMode === "plan")) return { level: "binding" };
  if (kind === "steer_turn" && exact(v,["kind","userText","actorRef"]) && str(v.userText,CODEX_RELAY_MAX_TEXT_BYTES) && str(v.actorRef)) return { level: "turn" };
  if (kind === "interrupt_turn" && exact(v,["kind","reason"]) && oneOf(v.reason,["user_stop","deadline","drain"] as const)) return { level: "turn" };
  if (kind === "drain_profile" && exact(v,["kind","deadlineAt"]) && normalizedIso(v.deadlineAt)) return { level: "profile" };
  if (kind === "terminate_child" && exact(v,["kind","reason"]) && oneOf(v.reason,["interrupt_escalation","host_shutdown"] as const)) return { level: "profile" };
  return null;
}
function answers(v: unknown): boolean { return isRecord(v) && Object.keys(v).length <= 3 && bytes(JSON.stringify(v)) <= 16 * 1024 && Object.entries(v).every(([id, a]) => str(id) && exact(a,["answers"]) && Array.isArray(a.answers) && a.answers.length <= 4 && a.answers.every((x) => str(x,4096))); }
function baseApprovalChoices(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.length <= 4 &&
    new Set(v).size === v.length &&
    v.every((choice) => oneOf(choice, ["accept", "acceptForSession", "decline", "cancel"] as const));
}
function hostLocalDetail(v: unknown): boolean { return oneOf(v, ["not_provided", "host_local_only"] as const); }
function permissionGrants(v: unknown): boolean {
  return exact(v, ["network", "fileSystem"]) &&
    typeof v.network === "boolean" && typeof v.fileSystem === "boolean";
}
function requestResponse(v: unknown): { level: "request" } | null {
  if (!isRecord(v) || !str(v.kind)) return null;
  if (["command_approval", "network_approval", "file_change_approval"].includes(v.kind) &&
    exact(v, ["kind", "decision"]) &&
    oneOf(v.decision, ["accept", "acceptForSession", "decline", "cancel"] as const)) return { level: "request" };
  if (v.kind === "permissions_approval" && exact(v, ["kind", "grants", "scope"]) &&
    permissionGrants(v.grants) && oneOf(v.scope, ["turn", "session"] as const)) return { level: "request" };
  if (v.kind === "user_input" && exact(v,["kind","answers"]) && answers(v.answers)) return { level: "request" };
  return null;
}
function inputOption(v: unknown): boolean {
  return exact(v, ["id", "label", "description"]) && str(v.id) && str(v.label, 256) && str(v["description"], 1024);
}
function question(v: unknown): boolean {
  if (!exact(v, ["id", "header", "question", "isOther", "isSecret", "options"]) ||
    !str(v.id) || !str(v.header, 128) || !str(v.question, 4096) ||
    typeof v.isOther !== "boolean" || typeof v.isSecret !== "boolean") return false;
  if (v.options === null) return true;
  if (!Array.isArray(v.options) || v.options.length > 3 || !v.options.every(inputOption)) return false;
  const ids = v.options.map((option: unknown) => (option as { readonly id: unknown }).id);
  return new Set(ids).size === ids.length;
}
function commandPresentation(v: unknown): boolean {
  return exact(v, ["detail", "actionKinds"]) && hostLocalDetail(v.detail) &&
    Array.isArray(v.actionKinds) && v.actionKinds.length <= 16 &&
    v.actionKinds.every((kind) => oneOf(kind, ["read", "list_files", "search", "unknown"] as const));
}
function networkPresentation(v: unknown): boolean {
  return exact(v, ["host", "protocol"]) && str(v.host, 253) &&
    oneOf(v.protocol, ["http", "https", "socks5Tcp", "socks5Udp"] as const);
}
function permissionPresentation(v: unknown): boolean {
  if (!exact(v, ["network", "fileSystem"])) return false;
  const network = v.network === null || (exact(v.network, ["enabled"]) && (typeof v.network.enabled === "boolean" || v.network.enabled === null));
  const fileSystem = v.fileSystem === null || (exact(v.fileSystem, ["readPathCount", "writePathCount", "entryCount", "pathDetail"]) &&
    nonNegative(v.fileSystem.readPathCount) && nonNegative(v.fileSystem.writePathCount) &&
    nonNegative(v.fileSystem.entryCount) && hostLocalDetail(v.fileSystem.pathDetail));
  return network && fileSystem;
}
function relayRequest(v: unknown): { level: "request" } | null {
  if (!isRecord(v) || !str(v.kind)) return null;
  if (v.kind === "command_approval" && exact(v, ["kind", "choices", "reason", "command", "expiresAt"]) &&
    baseApprovalChoices(v.choices) && hostLocalDetail(v.reason) && commandPresentation(v.command) && normalizedIso(v.expiresAt)) return { level: "request" };
  if (v.kind === "network_approval" && exact(v, ["kind", "choices", "reason", "network", "expiresAt"]) &&
    baseApprovalChoices(v.choices) && hostLocalDetail(v.reason) && networkPresentation(v.network) && normalizedIso(v.expiresAt)) return { level: "request" };
  if (v.kind === "file_change_approval" && exact(v, ["kind", "choices", "reason", "grantRoot", "expiresAt"]) &&
    baseApprovalChoices(v.choices) && hostLocalDetail(v.reason) && hostLocalDetail(v.grantRoot) && normalizedIso(v.expiresAt)) return { level: "request" };
  if (v.kind === "permissions_approval" && exact(v, ["kind", "reason", "permissions", "expiresAt"]) &&
    hostLocalDetail(v.reason) && permissionPresentation(v["permissions"]) && normalizedIso(v.expiresAt)) return { level: "request" };
  if (v.kind === "user_input" && exact(v,["kind","questions","autoResolutionMs","expiresAt"]) && Array.isArray(v.questions) && v.questions.length <= 3 && v.questions.every(question) && (v.autoResolutionMs === null || nonNegative(v.autoResolutionMs)) && normalizedIso(v.expiresAt)) return { level: "request" };
  return null;
}
function completedAssistantItem(v: unknown, protocolVersion: number): boolean {
  return exact(v, ["itemId", "text", "phase"]) &&
    str(v.itemId) &&
    (str(v.text, 16 * 1024) ||
      (protocolVersion >= CODEX_STREAMED_COMPLETION_PROTOCOL_VERSION && v.text === null)) &&
    (v.phase === null || oneOf(v.phase, ["commentary", "final_answer"] as const));
}

function event(v: unknown, protocolVersion: number): { level: "profileEvent" | "turnEvent" | "item" } | null {
  if (!isRecord(v) || !str(v.kind)) return null;
  const k = v.kind;
  if (k === "child_status" && exact(v,["kind","state"],["code"]) && oneOf(v.state,["starting","ready","draining","stopped","crashed"] as const) && (v.code === undefined || code(v.code))) return { level:"profileEvent" };
  if (k === "turn_status" && exact(v,["kind","state"],["code"]) && oneOf(v.state,["queued","running","completed","failed","interrupted","uncertain"] as const) && (v.code === undefined || code(v.code))) return { level:"turnEvent" };
  if (k === "progress" && exact(v,["kind","phase","sequence"]) && oneOf(v.phase,["thinking","tool","waiting","finalizing"] as const) && nonNegative(v.sequence)) return { level:"turnEvent" };
  if (k === "usage_status" && exact(v,["kind","state"]) && oneOf(v.state,["updated","rate_limited","unavailable"] as const)) return { level:"turnEvent" };
  if (k === "turn_completed" && exact(v,["kind","status","itemsView","assistantItems"],["code"]) && oneOf(v.status,["completed","failed","interrupted","uncertain"] as const) && oneOf(v["itemsView"],["notLoaded","summary","full"] as const) && Array.isArray(v.assistantItems) && v.assistantItems.length <= 32 && v.assistantItems.every((item) => completedAssistantItem(item, protocolVersion)) && (v.code === undefined || code(v.code))) return { level:"turnEvent" };
  if (k === "message_delta" && exact(v,["kind","text","sequence"]) && str(v.text,16*1024) && nonNegative(v.sequence)) return { level:"item" };
  if (k === "assistant_item_completed" && exact(v,["kind","text","phase","sequence"]) && (str(v.text,16*1024) || (protocolVersion >= CODEX_STREAMED_COMPLETION_PROTOCOL_VERSION && v.text === null)) && (v.phase === null || oneOf(v.phase,["commentary","final_answer"] as const)) && nonNegative(v.sequence)) return { level:"item" };
  if (["command_summary","patch_summary"].includes(k) && exact(v,["kind","summary","sequence"]) && str(v.summary,4096) && nonNegative(v.sequence)) return { level:"item" };
  return null;
}
function capability(v: unknown): v is RelayCodexCapability { return exact(v,["version","hostKind","maxProfiles","maxActiveTurns"]) && v.version === CODEX_RELAY_CAPABILITY_VERSION && v.hostKind === "electron" && v.maxProfiles === 4 && v.maxActiveTurns === 4; }
export function parseRelayCodexCapability(v: unknown): CodexParseResult<RelayCodexCapability> { return capability(v) ? {ok:true,value:v} : {ok:false,error:"CODEX_FRAME_INVALID"}; }
const decimal = (v: unknown, max = 32): boolean => typeof v === "string" && /^\d+$/.test(v) && v.length <= max;
function safeRateWindow(v: unknown): boolean { return exact(v,["usedPercent","windowDurationMins","resetsAt"]) && typeof v.usedPercent === "number" && Number.isFinite(v.usedPercent) && v.usedPercent >= 0 && v.usedPercent <= 100 && (v.windowDurationMins === null || nonNegative(v.windowDurationMins)) && (v.resetsAt === null || normalizedIso(v.resetsAt)); }
function safeRateLimits(v: unknown): boolean { return exact(v,["primary","secondary","plan","credits","spendControl","reached","observedAt","freshness"]) && (v.primary===null||safeRateWindow(v.primary)) && (v.secondary===null||safeRateWindow(v.secondary)) && (v.plan===null || oneOf(v.plan,["free","go","plus","pro","prolite","team","business","enterprise","edu","usage_based","unknown"] as const)) && (v.credits===null || (exact(v.credits,["hasCredits","unlimited","balance"]) && typeof v.credits.hasCredits==="boolean" && typeof v.credits.unlimited==="boolean" && (v.credits.balance===null||str(v.credits.balance,64)))) && (v.spendControl===null || (exact(v.spendControl,["limit","used","remainingPercent","resetsAt"]) && str(v.spendControl.limit,64) && str(v.spendControl.used,64) && typeof v.spendControl.remainingPercent === "number" && Number.isFinite(v.spendControl.remainingPercent) && v.spendControl.remainingPercent >= 0 && v.spendControl.remainingPercent <= 100 && normalizedIso(v.spendControl.resetsAt))) && (v.reached===null || oneOf(v.reached,["rate_limit_reached","credits_depleted","usage_limit_reached"] as const)) && normalizedIso(v.observedAt) && oneOf(v.freshness,["live","cached","stale"] as const); }
function safeUsage(v: unknown): boolean { return exact(v,["summary","daily","observedAt","freshness"]) && exact(v.summary,["lifetimeTokens","peakDailyTokens","longestRunningTurnSec","currentStreakDays","longestStreakDays"]) && Object.values(v.summary).every(x=>x===null||decimal(x)) && Array.isArray(v.daily) && v.daily.length<=31 && v.daily.every(x=>exact(x,["startDate","tokens"])&&normalizedDate(x.startDate)&&decimal(x.tokens)) && normalizedIso(v.observedAt) && oneOf(v.freshness,["live","cached","stale"] as const); }
function safeModelCatalog(v: unknown): boolean { return exact(v,["models"]) && Array.isArray(v.models) && v.models.length<=1_000 && v.models.every(item=>exact(item,["id","model","displayName","description","isDefault"])&&str(item.id)&&str(item.model)&&str(item.displayName,256)&&typeof item["description"]==="string"&&bytes(item["description"])<=4_096&&typeof item.isDefault==="boolean"); }
const safeDisplayIdentity = (v: unknown): v is string => str(v, 320) && Array.from(v).every((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
});
const safeSemver = (v: unknown): v is string => typeof v === "string" && v.length <= 128 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(v);
const runtimeInstallCode = (v: unknown): v is CodexRuntimeInstallCode => oneOf(v, ["CODEX_RUNTIME_NOT_FOUND","CODEX_RUNTIME_NOT_EXECUTABLE","CODEX_RUNTIME_WRONG_ARCHITECTURE","CODEX_RUNTIME_UNHEALTHY","CODEX_RUNTIME_TIMEOUT","CODEX_RUNTIME_CANCELLED","CODEX_RUNTIME_IDENTITY_CHANGED","CODEX_RUNTIME_SCHEMA_INVALID","CODEX_RUNTIME_INCOMPATIBLE","CODEX_RUNTIME_STANDALONE_UNSUPPORTED","CODEX_RUNTIME_VERSION_INVALID","CODEX_RUNTIME_OUTPUT_LIMIT","CODEX_RUNTIME_PATH_INVALID","CODEX_RUNTIME_EXECUTABLE_LIMIT","CODEX_RUNTIME_PLATFORM_UNSUPPORTED","CODEX_RUNTIME_ARTIFACT_INVALID","CODEX_RUNTIME_SIGNATURE_INVALID","CODEX_RUNTIME_INSTALL_FAILED"] as const);
function runtimeInstallation(v: unknown): v is CodexRuntimeInstallation {
  if (!exact(v,["phase","receivedBytes","totalBytes","canCancel"],["code"]) || !oneOf(v.phase,["absent","resolving","downloading","verifying","staging","activating","ready","rollback","cancelled","failed"] as const) || !nonNegative(v.receivedBytes) || !nonNegative(v.totalBytes) || v.receivedBytes > v.totalBytes || typeof v.canCancel !== "boolean" || (v.code !== undefined && !runtimeInstallCode(v.code))) return false;
  if (v.canCancel !== ["resolving","downloading","verifying","staging"].includes(v.phase)) return false;
  if ((v.phase === "failed" || v.phase === "cancelled") && v.code === undefined) return false;
  return true;
}
function runtimeStatus(v: unknown): boolean {
  if (!isRecord(v) || !exact(v,["state"],["installRef","source","version","installation","compatibilityDiagnostics"]) || !oneOf(v.state,["absent","installing","ready","incompatible","draining","failed"] as const) || (v.installRef !== undefined && !str(v.installRef)) || (v.source !== undefined && !oneOf(v.source,["external","managed"] as const)) || (v.version !== undefined && !safeSemver(v.version)) || (v.installation !== undefined && !runtimeInstallation(v.installation)) || (v["compatibilityDiagnostics"] !== undefined && !compatibilityDiagnostics(v["compatibilityDiagnostics"]))) return false;
  if (v.state === "installing") return v.source === "managed" && v.installRef !== undefined && (v.installation === undefined || ["resolving","downloading","verifying","staging","activating"].includes(v.installation.phase));
  if (v.installRef !== undefined) return false;
  if (v.installation !== undefined) {
    if (v.source !== "managed" || !["ready","failed","cancelled"].includes(v.installation.phase)) return false;
    if (v.installation.phase === "ready" && v.state !== "ready") return false;
    if (v.installation.phase === "failed" && v.state !== "failed") return false;
    if (v.installation.phase === "cancelled" && v.state !== "absent") return false;
  }
  return true;
}
function compatibilityDiagnostics(v: unknown): v is readonly CodexCompatibilityDiagnostic[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 5 && v.every((item) =>
    exact(item, ["feature", "reason"]) &&
    oneOf(item["feature"], ["core", "steer", "approvals", "request_user_input", "collaboration_modes"] as const) &&
    oneOf(item.reason, ["missing_member", "missing_field", "changed_field_shape"] as const));
}
function status(v: unknown): boolean {
  if (!isRecord(v) || !str(v.state) || !oneOf(v.state,["ready","limited","runtime_unavailable","runtime_incompatible","supervisor_unavailable","workspace_unavailable"] as const)) return false;
  const allowed=["state","compatibility","features","runtimeGeneration","runtime","profiles","workspace"];
  if (!Object.keys(v).every(k=>allowed.includes(k)) || !isRecord(v.workspace)) return false;
  if (v.compatibility!==undefined && !oneOf(v.compatibility,["certified","compatible_uncertified","limited","incompatible"] as const)) return false;
  if (v.features!==undefined && (!exact(v.features,["stableConversation","explicitSteer","codexApprovals","requestUserInput"],["collaborationMode"]) || !Object.values(v.features).every(x=>typeof x==="boolean"))) return false;
  if (v.runtimeGeneration!==undefined && !nonNegative(v.runtimeGeneration)) return false;
  if (v.runtime!==undefined && !runtimeStatus(v.runtime)) return false;
  if (v.profiles!==undefined) {
    if (!Array.isArray(v.profiles) || v.profiles.length>4) return false;
    for (const profile of v.profiles) {
      if (!exact(profile,["profileHandle","profileGeneration","accountGeneration","state"],["childGeneration","rateLimits","usage"]) || !str(profile.profileHandle) || !nonNegative(profile.profileGeneration) || !nonNegative(profile.accountGeneration) || !oneOf(profile.state,["signed_out","signed_in","reauth_required","busy","draining"] as const) || ((profile.state === "busy" || profile.state === "draining") && profile.childGeneration === undefined) || (profile.childGeneration!==undefined&&(!nonNegative(profile.childGeneration)||profile.childGeneration===0)) || (profile.rateLimits!==undefined&&!safeRateLimits(profile.rateLimits)) || (profile.usage!==undefined&&!safeUsage(profile.usage))) return false;
    }
  }
  return (exact(v.workspace,["state","receipt"]) && v.workspace.state === "bound" && receipt(v.workspace.receipt)) || (exact(v.workspace,["state"]) && oneOf(v.workspace.state,["unavailable","stale"] as const));
}
function commandResult(v: unknown): ("host" | "launch" | "profile" | "bindingOpen" | "binding" | "turn")[] | null {
  if (!isRecord(v) || !str(v.kind)) return null;
  if (v.kind === "rejected" && exact(v,["kind","code"]) && code(v.code)) return ["host","launch","profile","bindingOpen","binding","turn"];
  if (["child_ready","drained","terminated"].includes(v.kind) && exact(v,["kind"])) return ["profile"];
  if (["binding_ready","binding_rebound","binding_released"].includes(v.kind) && exact(v,["kind"])) return ["binding"];
  if (["accepted","turn_started","interrupted"].includes(v.kind) && exact(v,["kind"])) return ["turn"];
  if (v.kind === "runtime_status" && exact(v,["kind","state"],["runtimeGeneration","installRef"]) && oneOf(v.state,["absent","installing","ready","incompatible","draining","failed"] as const) && (v.runtimeGeneration===undefined||nonNegative(v.runtimeGeneration)) && (v.installRef===undefined||str(v.installRef))) return ["host"];
  if (v.kind === "profile_status" && exact(v,["kind","state","profileHandle","profileGeneration","homeHandle"]) && v.state === "created" && str(v.profileHandle) && nonNegative(v.profileGeneration) && str(v["homeHandle"])) return ["host"];
  if (v.kind === "profile_status" && exact(v,["kind","state","profileHandle","profileGeneration"]) && v.state === "removed" && str(v.profileHandle) && nonNegative(v.profileGeneration)) return ["launch"];
  if (v.kind === "login_started" && exact(v,["kind","loginRef","state"]) && str(v.loginRef) && v.state === "waiting_for_browser") return ["profile"];
  if (v.kind === "account_status" && exact(v,["kind","state","accountGeneration"],["accountEmail","planType"]) && oneOf(v.state,["signed_in","signed_out","reauth_required"] as const) && nonNegative(v.accountGeneration) && (v.accountEmail === undefined || v.accountEmail === null || safeDisplayIdentity(v.accountEmail)) && (v.planType === undefined || v.planType === null || oneOf(v.planType,["free","go","plus","pro","prolite","team","business","enterprise","ent26","edu","unknown","self_serve_business_usage_based","enterprise_cbp_usage_based"] as const))) return ["profile"];
  // The bounded rate/usage projections are carried only after the host has
  // normalized them. This relay layer additionally forbids unknown wrapper keys.
  if (v.kind === "rate_limits_status" && exact(v,["kind","value"]) && safeRateLimits(v.value)) return ["profile"];
  if (v.kind === "account_usage_status" && exact(v,["kind","value"]) && safeUsage(v.value)) return ["profile"];
  if (v.kind === "model_catalog_status" && exact(v,["kind","value"]) && safeModelCatalog(v.value)) return ["profile"];
  return null;
}
/** Strict parser for client→server Codex frames. Unknown keys reject the whole frame. */
export function parseRelayCodexClientMessage(v: unknown): CodexParseResult<RelayCodexClientMessage> { if (!isRecord(v) || !str(v.type)) return {ok:false,error:"CODEX_FRAME_INVALID"}; if (v.type==="relay:codex-status" && exact(v,["type","socket","capabilityRevision","status"]) && socketScope(v.socket) && nonNegative(v.capabilityRevision) && status(v.status)) return {ok:true,value:v as RelayCodexStatusMessage}; if (v.type==="relay:codex-command-response" && exact(v,["type","commandId","scope","result"]) && str(v.commandId)) { const levels=commandResult(v.result); if (levels && levels.some(level=>scope(v.scope,level))) return {ok:true,value:v as RelayCodexCommandResponseMessage}; } if (v.type==="relay:codex-request" && exact(v,["type","scope","request"]) ) { const parsed=relayRequest(v.request); if(parsed&&scope(v.scope,parsed.level)) return {ok:true,value:v as RelayCodexRequestMessage}; } if (v.type==="relay:codex-event" && exact(v,["type","scope","eventSequence","event"]) && nonNegative(v.eventSequence) && isRecord(v.event) && isRecord(v.scope) && isCodexRelayProtocolVersion(v.scope["selectedProtocolVersion"])) { const parsed=event(v.event, v.scope["selectedProtocolVersion"]); if(parsed&&scope(v.scope,parsed.level) && bytes(JSON.stringify(v))<=CODEX_RELAY_MAX_EVENT_BYTES) return {ok:true,value:v as RelayCodexEventMessage}; } return {ok:false,error:"CODEX_FRAME_INVALID"}; }
/** Strict parser for server→relay Codex frames. */
export function parseRelayCodexServerMessage(v: unknown): CodexParseResult<RelayCodexServerMessage> { if (!isRecord(v) || !str(v.type)) return {ok:false,error:"CODEX_FRAME_INVALID"}; if(v.type==="relay:codex-command"&&exact(v,["type","commandId","scope","command"])&&str(v.commandId)){const c=command(v.command);if(c&&scope(v.scope,c.level))return {ok:true,value:v as RelayCodexCommandMessage};} if(v.type==="relay:codex-cancel"&&exact(v,["type","scope","reason"])&&scope(v.scope,"turn")&&oneOf(v.reason,["job_stop","deadline","profile_removed","generation_replaced","relay_disconnect"] as const))return {ok:true,value:v as RelayCodexCancelMessage}; if(v.type==="relay:codex-credit"&&exact(v,["type","scope","throughEventSequence","grantEvents","grantBytes"])&&scope(v.scope,"profile")&&nonNegative(v.throughEventSequence)&&nonNegative(v.grantEvents)&&nonNegative(v.grantBytes))return {ok:true,value:v as RelayCodexCreditMessage}; if(v.type==="relay:codex-request-response"&&exact(v,["type","scope","response"])){const p=requestResponse(v.response);if(p&&scope(v.scope,p.level))return {ok:true,value:v as RelayCodexRequestResponseMessage};} return {ok:false,error:"CODEX_FRAME_INVALID"}; }

/** @internal Exact host-response correlation shared by both relay endpoints. */
export function isRelayCodexCommandResponseForCommand(
  commandMessage: RelayCodexCommandMessage,
  response: RelayCodexCommandResponseMessage,
): boolean {
  if (commandMessage.commandId !== response.commandId) return false;
  const expected = commandMessage.scope as unknown as Record<string, unknown>;
  const actual = response.scope as unknown as Record<string, unknown>;
  const expectedKeys = Object.keys(expected);
  const sameKeys = (keys: readonly string[]) =>
    keys.every((key) => JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
  const exactScope = () =>
    Object.keys(actual).length === expectedKeys.length && sameKeys(expectedKeys);
  const commandKind = commandMessage.command.kind;
  if (response.result.kind === "rejected") {
    if (commandKind === "rebind_binding") {
      return sameKeys(expectedKeys.filter((key) => key !== "bindingGeneration")) &&
        actual["bindingGeneration"] === commandMessage.command.nextBindingGeneration &&
        JSON.stringify(actual["workspace"]) === JSON.stringify(commandMessage.command.successorWorkspace);
    }
    return exactScope();
  }
  if (commandKind.startsWith("runtime_")) {
    if (response.result.kind !== "runtime_status" || !exactScope()) return false;
    if (commandKind === "runtime_activate" || commandKind === "runtime_remove") {
      return response.result.runtimeGeneration === commandMessage.command.runtimeGeneration;
    }
    return true;
  }
  if (commandKind === "profile_create" || commandKind === "profile_remove") {
    return response.result.kind === "profile_status" &&
      response.result.state === (commandKind === "profile_create" ? "created" : "removed") &&
      response.result.profileHandle === commandMessage.command.profileHandle &&
      response.result.profileGeneration === commandMessage.command.profileGeneration &&
      exactScope();
  }
  if (commandKind === "account_login_start") return response.result.kind === "login_started" && exactScope();
  if (commandKind === "account_login_cancel" || commandKind === "account_read" || commandKind === "account_logout") {
    return response.result.kind === "account_status" && exactScope();
  }
  if (commandKind === "account_rate_limits_read") return response.result.kind === "rate_limits_status" && exactScope();
  if (commandKind === "account_usage_read") return response.result.kind === "account_usage_status" && exactScope();
  if (commandKind === "model_list") return response.result.kind === "model_catalog_status" && exactScope();
  if (commandKind === "drain_profile") return response.result.kind === "drained" && exactScope();
  if (commandKind === "terminate_child") return response.result.kind === "terminated" && exactScope();
  if (commandKind === "steer_turn") return response.result.kind === "accepted" && exactScope();
  if (commandKind === "interrupt_turn") return response.result.kind === "interrupted" && exactScope();
  if (commandKind === "ensure_profile_child") {
    return response.result.kind === "child_ready" &&
      sameKeys(expectedKeys) &&
      Number.isSafeInteger(actual["childGeneration"]);
  }
  if (commandKind === "open_binding") {
    return response.result.kind === "binding_ready" &&
      sameKeys(expectedKeys) &&
      typeof actual["threadId"] === "string";
  }
  if (commandKind === "rebind_binding") {
    return response.result.kind === "binding_rebound" &&
      sameKeys(expectedKeys.filter((key) => key !== "bindingGeneration" && key !== "workspace")) &&
      actual["bindingGeneration"] === commandMessage.command.nextBindingGeneration &&
      JSON.stringify(actual["workspace"]) === JSON.stringify(commandMessage.command.successorWorkspace);
  }
  if (commandKind === "release_binding") {
    return response.result.kind === "binding_released" && exactScope();
  }
  if (commandKind === "start_turn") {
    return response.result.kind === "turn_started" &&
      sameKeys(expectedKeys) &&
      typeof actual["turnId"] === "string" &&
      actual["turnId"].length > 0;
  }
  return commandKind === "resume_binding" &&
    response.result.kind === "binding_ready" &&
    sameKeys(expectedKeys);
}
export function isRelayCodexFrameType(type: string | null): boolean {
  return type === "relay:codex-status" ||
    type === "relay:codex-command" ||
    type === "relay:codex-command-response" ||
    type === "relay:codex-cancel" ||
    type === "relay:codex-credit" ||
    type === "relay:codex-request" ||
    type === "relay:codex-request-response" ||
    type === "relay:codex-event";
}

type ObjectScanFrame = {
  readonly kind: "object";
  readonly topLevel: boolean;
  readonly keys: Set<string>;
  state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd";
  key: string | null;
};
type ArrayScanFrame = {
  readonly kind: "array";
  state: "valueOrEnd" | "value" | "commaOrEnd";
};
type ScanFrame = ObjectScanFrame | ArrayScanFrame;
type JsonScanResult = { readonly valid: boolean; readonly type: string | null };

/**
 * Validates JSON structure, duplicate decoded keys, depth, and node count without
 * materializing the frame. The explicit stack prevents adversarial recursion.
 */
function scanJsonFrame(raw: string, stopAfterTopLevelType = false): JsonScanResult {
  let offset = 0;
  let nodes = 1;
  let topLevelType: string | null = null;
  const frames: ScanFrame[] = [];
  const whitespace = () => {
    while (offset < raw.length && /[\t\n\r ]/.test(raw[offset] ?? "")) offset++;
  };
  const readString = (decode = true): string | null => {
    if (raw[offset] !== "\"") return null;
    const start = offset++;
    while (offset < raw.length) {
      const character = raw[offset++];
      if (character === "\"") {
        if (!decode) return "";
        try {
          const decoded: unknown = JSON.parse(raw.slice(start, offset));
          return typeof decoded === "string" ? decoded : null;
        } catch {
          return null;
        }
      }
      if (character === "\\") {
        if (offset >= raw.length) return null;
        const escape = raw[offset++];
        if (escape === "u") {
          const digits = raw.slice(offset, offset + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) return null;
          offset += 4;
        } else if (!"\"\\/bfnrt".includes(escape ?? "")) {
          return null;
        }
      } else if (character !== undefined && character.charCodeAt(0) < 0x20) {
        return null;
      }
    }
    return null;
  };
  const pushValue = (parent: ScanFrame, topKey: string | null): boolean => {
    if (++nodes > 10_000) return false;
    const character = raw[offset];
    if (character === "\"") {
      const decoded = readString(topKey === "type");
      if (decoded === null) return false;
      if (topKey === "type") topLevelType = decoded;
      return true;
    }
    if (character === "{") {
      offset++;
      if (frames.length >= 64) return false;
      frames.push({ kind: "object", topLevel: false, keys: new Set(), state: "keyOrEnd", key: null });
      return true;
    }
    if (character === "[") {
      offset++;
      if (frames.length >= 64) return false;
      frames.push({ kind: "array", state: "valueOrEnd" });
      return true;
    }
    const primitive = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(offset));
    if (!primitive) return false;
    offset += primitive[0].length;
    void parent;
    return true;
  };

  whitespace();
  if (raw[offset++] !== "{") return { valid: false, type: null };
  frames.push({ kind: "object", topLevel: true, keys: new Set(), state: "keyOrEnd", key: null });
  while (frames.length > 0) {
    whitespace();
    const frame = frames[frames.length - 1];
    if (!frame) return { valid: false, type: null };
    if (frame.kind === "object") {
      if (frame.state === "keyOrEnd") {
        if (raw[offset] === "}") {
          offset++;
          frames.pop();
          continue;
        }
        frame.state = "key";
      }
      if (frame.state === "key") {
        const key = readString();
        if (key === null || frame.keys.has(key)) return { valid: false, type: null };
        frame.keys.add(key);
        frame.key = key;
        frame.state = "colon";
        continue;
      }
      if (frame.state === "colon") {
        if (raw[offset++] !== ":") return { valid: false, type: null };
        frame.state = "value";
        continue;
      }
      if (frame.state === "value") {
        frame.state = "commaOrEnd";
        const topKey = frame.topLevel ? frame.key : null;
        if (!pushValue(frame, topKey)) return { valid: false, type: null };
        if (stopAfterTopLevelType && topLevelType !== null) {
          return { valid: true, type: topLevelType };
        }
        continue;
      }
      if (raw[offset] === ",") {
        offset++;
        frame.state = "key";
        frame.key = null;
        continue;
      }
      if (raw[offset] === "}") {
        offset++;
        frames.pop();
        continue;
      }
      return { valid: false, type: null };
    }
    if (frame.state === "valueOrEnd") {
      if (raw[offset] === "]") {
        offset++;
        frames.pop();
        continue;
      }
      frame.state = "value";
    }
    if (frame.state === "value") {
      frame.state = "commaOrEnd";
      if (!pushValue(frame, null)) return { valid: false, type: null };
      continue;
    }
    if (raw[offset] === ",") {
      offset++;
      frame.state = "value";
      continue;
    }
    if (raw[offset] === "]") {
      offset++;
      frames.pop();
      continue;
    }
    return { valid: false, type: null };
  }
  whitespace();
  return { valid: offset === raw.length, type: topLevelType };
}

/** Bounded, Unicode-correct lexical top-level classifier. */
export function classifyRelayTopLevelType(raw: string): string | null {
  const scanned = scanJsonFrame(raw, true);
  return scanned.valid ? scanned.type : null;
}
/** Parse guard used before a v8 frame reaches JSON.parse consumers. */
export function parseRelayCodexJsonFrame(raw: string, direction: "client" | "server"): CodexParseResult<RelayCodexClientMessage | RelayCodexServerMessage> {
  if (bytes(raw) > CODEX_RELAY_MAX_FRAME_BYTES) return { ok: false, error: "CODEX_FRAME_TOO_LARGE" };
  const scanned = scanJsonFrame(raw);
  if (!scanned.valid || !isRelayCodexFrameType(scanned.type)) return { ok: false, error: "CODEX_FRAME_INVALID" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "CODEX_FRAME_INVALID" };
  }
  return direction === "client" ? parseRelayCodexClientMessage(value) : parseRelayCodexServerMessage(value);
}
