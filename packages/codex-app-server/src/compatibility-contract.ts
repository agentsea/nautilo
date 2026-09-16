export type CompatibilityState =
  | "certified"
  | "compatible_uncertified"
  | "limited"
  | "incompatible";

export type CompatibilityFeature =
  | "core"
  | "steer"
  | "approvals"
  | "request_user_input"
  | "collaboration_modes";

export type JsonShapeKind =
  | "array"
  | "boolean"
  | "null"
  | "number"
  | "object"
  | "string";

export interface ObservedFieldShape {
  required: boolean;
  kinds: JsonShapeKind[];
  literals?: Array<string | number | boolean | null>;
}

export interface ProtocolObservation {
  members: Record<string, string[]>;
  fields: Record<string, ObservedFieldShape>;
}

export interface VerifiedProtocolObservation {
  readonly schemaFingerprint: string;
  readonly executable: VerifiedExecutableEvidence | null;
  readonly observation: ProtocolObservation;
}

export interface VerifiedExecutableEvidence {
  readonly fingerprint: string;
  readonly byteLength: number;
}

export interface CompatibilityReason {
  feature: CompatibilityFeature;
  code: "missing_member" | "missing_field" | "changed_field_shape";
  target: string;
}

export interface CompatibilityResult {
  state: CompatibilityState;
  features: Record<CompatibilityFeature, boolean>;
  reasons: CompatibilityReason[];
}

export interface StableCompatibilityResult {
  readonly compatible: boolean;
  readonly reasons: readonly CompatibilityReason[];
}

interface MemberRequirement {
  feature: CompatibilityFeature;
  surface: string;
  member: string;
}

export interface FieldRequirement {
  feature: CompatibilityFeature;
  path: string;
  /** The side whose accepted wire shape this requirement describes. */
  direction: "nautilo_to_runtime" | "runtime_to_nautilo";
  required: boolean;
  kinds: JsonShapeKind[];
  literals?: readonly (string | number | boolean | null)[];
}

/**
 * Named schema objects Nautilo serializes into app-server requests or
 * responses. Every other consumed projection is decoded by a Nautilo
 * validator. Keeping this classification beside the compatibility manifest
 * makes requiredness and union comparisons follow the actual receiver.
 */
const NAUTILO_TO_RUNTIME_TYPES = new Set([
  "InitializeParams",
  "InitializeCapabilities",
  "ThreadStartParams",
  "TurnStartParams",
  "CollaborationMode",
  "TextUserInput",
  "ImageUserInput",
  "LocalImageUserInput",
  "MentionUserInput",
  "SkillUserInput",
  "CommandExecutionRequestApprovalResponse",
  "FileChangeRequestApprovalResponse",
  "ApplyPatchApprovalResponse",
  "ExecCommandApprovalResponse",
  "PermissionsRequestApprovalResponse",
  "GrantedPermissionProfile",
  "ToolRequestUserInputResponse",
  "ToolRequestUserInputAnswer",
]);

function fieldDirection(
  path: string,
): FieldRequirement["direction"] {
  const separator = path.indexOf(".");
  const typeName = separator === -1 ? path : path.slice(0, separator);
  return NAUTILO_TO_RUNTIME_TYPES.has(typeName)
    ? "nautilo_to_runtime"
    : "runtime_to_nautilo";
}

export const CERTIFIED_ANCHOR_ID = "codex-app-server@0.146.0";
export const CERTIFIED_EXECUTABLE_FINGERPRINT =
  "sha256:ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02";
export const CERTIFIED_SCHEMA_FINGERPRINT =
  "sha256:9db7ac39730e01ec6942886fba92f02c992ac0c18d9d39d748e2f0065c980961";

const VERIFIED_OBSERVATIONS = new WeakSet<object>();
const VERIFIED_EXECUTABLES = new WeakSet<object>();

function deepFreezeClone<T>(value: T): T {
  const clone = structuredClone(value);
  if (clone === null || typeof clone !== "object") return clone;
  const work: object[] = [clone as object];
  const seen = new Set<object>();
  while (work.length > 0) {
    const current = work.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") work.push(child as object);
    }
    Object.freeze(current);
  }
  return clone;
}

export interface ExecutableByteVerifier {
  update(chunk: Uint8Array): void;
  finish(): VerifiedExecutableEvidence;
}

/** Incremental verifier for host adapters; it never retains executable bytes. */
export function createExecutableByteVerifier(): ExecutableByteVerifier {
  const hash = createHash("sha256");
  let byteLength = 0;
  let finished = false;

  return Object.freeze({
    update(chunk: Uint8Array): void {
      if (finished) throw new Error("executable verifier is already finished");
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("executable chunk must be bytes");
      }
      const nextByteLength = byteLength + chunk.byteLength;
      if (!Number.isSafeInteger(nextByteLength)) {
        throw new RangeError("executable byte length is unsafe");
      }
      hash.update(chunk);
      byteLength = nextByteLength;
    },
    finish(): VerifiedExecutableEvidence {
      if (finished) throw new Error("executable verifier is already finished");
      finished = true;
      const evidence = Object.freeze({
        fingerprint: `sha256:${hash.digest("hex")}`,
        byteLength,
      });
      VERIFIED_EXECUTABLES.add(evidence);
      return evidence;
    },
  });
}

export function verifyExecutableBytes(
  chunks: Iterable<Uint8Array>,
): VerifiedExecutableEvidence {
  const verifier = createExecutableByteVerifier();
  for (const chunk of chunks) verifier.update(chunk);
  return verifier.finish();
}

function isVerifiedExecutableEvidence(
  value: object,
): value is VerifiedExecutableEvidence {
  return VERIFIED_EXECUTABLES.has(value);
}

/** @internal Only schema-observation may construct provenance-bearing evidence. */
export function createVerifiedProtocolObservation(
  schemaFingerprint: string,
  executable: VerifiedExecutableEvidence | null,
  observation: ProtocolObservation,
): VerifiedProtocolObservation {
  if (
    executable !== null &&
    !isVerifiedExecutableEvidence(executable)
  ) {
    throw new TypeError("executable evidence is not verified");
  }
  const evidence = Object.freeze({
    schemaFingerprint,
    executable,
    observation: deepFreezeClone(observation),
  });
  VERIFIED_OBSERVATIONS.add(evidence);
  return evidence;
}

/** @internal */
export function isVerifiedProtocolObservation(
  value: object,
): value is VerifiedProtocolObservation {
  return VERIFIED_OBSERVATIONS.has(value);
}

export const DEFAULT_SCHEMA_PROBE_LIMITS = Object.freeze({
  timeoutMs: 5_000,
  maxFiles: 4_096,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxJsonDepth: 128,
  maxJsonNodes: 1_000_000,
});

const MEMBER_REQUIREMENTS: readonly MemberRequirement[] = [
  { feature: "core", surface: "client_request", member: "initialize" },
  { feature: "core", surface: "client_request", member: "thread/start" },
  { feature: "core", surface: "client_request", member: "thread/resume" },
  { feature: "core", surface: "client_request", member: "thread/read" },
  { feature: "core", surface: "client_request", member: "thread/archive" },
  { feature: "core", surface: "client_request", member: "thread/list" },
  { feature: "core", surface: "client_request", member: "thread/unarchive" },
  { feature: "core", surface: "client_request", member: "turn/start" },
  { feature: "core", surface: "client_request", member: "turn/interrupt" },
  { feature: "core", surface: "client_request", member: "model/list" },
  {
    feature: "core",
    surface: "client_request",
    member: "account/login/start",
  },
  { feature: "core", surface: "client_request", member: "account/read" },
  { feature: "core", surface: "client_request", member: "account/login/cancel" },
  { feature: "core", surface: "client_request", member: "account/logout" },
  {
    feature: "core",
    surface: "client_request",
    member: "account/rateLimits/read",
  },
  {
    feature: "core",
    surface: "client_request",
    member: "account/usage/read",
  },
  { feature: "core", surface: "server_notification", member: "error" },
  {
    feature: "core",
    surface: "server_notification",
    member: "thread/started",
  },
  {
    feature: "core",
    surface: "server_notification",
    member: "turn/started",
  },
  {
    feature: "core",
    surface: "server_notification",
    member: "turn/completed",
  },
  {
    feature: "core",
    surface: "server_notification",
    member: "item/started",
  },
  {
    feature: "core",
    surface: "server_notification",
    member: "item/completed",
  },
  {
    feature: "core",
    surface: "server_notification",
    member: "item/agentMessage/delta",
  },
  { feature: "core", surface: "server_notification", member: "account/login/completed" },
  { feature: "core", surface: "server_notification", member: "account/rateLimits/updated" },
  { feature: "core", surface: "server_notification", member: "account/updated" },
  { feature: "core", surface: "server_notification", member: "item/commandExecution/outputDelta" },
  { feature: "core", surface: "server_notification", member: "item/commandExecution/terminalInteraction" },
  { feature: "core", surface: "server_notification", member: "item/fileChange/outputDelta" },
  { feature: "core", surface: "server_notification", member: "item/fileChange/patchUpdated" },
  { feature: "core", surface: "server_notification", member: "serverRequest/resolved" },
  { feature: "core", surface: "server_notification", member: "thread/closed" },
  { feature: "core", surface: "server_notification", member: "thread/status/changed" },
  { feature: "core", surface: "server_notification", member: "thread/tokenUsage/updated" },
  { feature: "core", surface: "server_notification", member: "turn/diff/updated" },
  {
    feature: "approvals",
    surface: "server_request",
    member: "item/commandExecution/requestApproval",
  },
  {
    feature: "approvals",
    surface: "server_request",
    member: "item/fileChange/requestApproval",
  },
  { feature: "approvals", surface: "server_request", member: "applyPatchApproval" },
  { feature: "approvals", surface: "server_request", member: "execCommandApproval" },
  {
    feature: "approvals",
    surface: "server_request",
    member: "item/permissions/requestApproval",
  },
  {
    feature: "approvals",
    surface: "response",
    member: "CommandExecutionRequestApprovalResponse",
  },
  {
    feature: "approvals",
    surface: "response",
    member: "FileChangeRequestApprovalResponse",
  },
  { feature: "approvals", surface: "response", member: "ApplyPatchApprovalResponse" },
  { feature: "approvals", surface: "response", member: "ExecCommandApprovalResponse" },
  {
    feature: "approvals",
    surface: "response",
    member: "PermissionsRequestApprovalResponse",
  },
  { feature: "core", surface: "thread_item", member: "agentMessage" },
  { feature: "core", surface: "thread_item", member: "commandExecution" },
  { feature: "core", surface: "thread_item", member: "fileChange" },
  { feature: "steer", surface: "client_request", member: "turn/steer" },
  {
    feature: "collaboration_modes",
    surface: "client_request",
    member: "collaborationMode/list",
  },
  {
    feature: "request_user_input",
    surface: "server_request",
    member: "item/tool/requestUserInput",
  },
  {
    feature: "request_user_input",
    surface: "response",
    member: "ToolRequestUserInputResponse",
  },
];

type UndirectedFieldRequirement = Omit<FieldRequirement, "direction">;

const BASE_FIELD_REQUIREMENTS: readonly UndirectedFieldRequirement[] = [
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.threadId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.turnId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.itemId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.command",
    required: false,
    kinds: ["null", "string"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.cwd",
    required: false,
    kinds: ["null", "string"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.availableDecisions",
    required: false,
    kinds: ["array", "null"],
    literals: ["accept", "acceptForSession", "decline", "cancel"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.networkApprovalContext",
    required: false,
    kinds: ["null", "object"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.commandActions",
    required: false,
    kinds: ["array", "null"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.proposedExecpolicyAmendment",
    required: false,
    kinds: ["array", "null"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalParams.proposedNetworkPolicyAmendments",
    required: false,
    kinds: ["array", "null"],
  },
  {
    feature: "approvals",
    path: "FileChangeRequestApprovalParams.threadId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "approvals",
    path: "FileChangeRequestApprovalParams.turnId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "approvals",
    path: "FileChangeRequestApprovalParams.itemId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "approvals",
    path: "FileChangeRequestApprovalParams.reason",
    required: false,
    kinds: ["null", "string"],
  },
  {
    feature: "approvals",
    path: "FileChangeRequestApprovalParams.grantRoot",
    required: false,
    kinds: ["null", "string"],
  },
  {
    feature: "approvals",
    path: "CommandExecutionRequestApprovalResponse.decision",
    required: true,
    kinds: ["object", "string"],
    literals: ["accept", "acceptForSession", "decline", "cancel"],
  },
  {
    feature: "approvals",
    path: "FileChangeRequestApprovalResponse.decision",
    required: true,
    kinds: ["string"],
    literals: ["accept", "acceptForSession", "decline", "cancel"],
  },
  {
    feature: "core",
    path: "InitializeParams.clientInfo",
    required: true,
    kinds: ["object"],
  },
  {
    feature: "core",
    path: "InitializeCapabilities.experimentalApi",
    required: true,
    kinds: ["boolean"],
  },
  {
    feature: "core",
    path: "ThreadStartParams.cwd",
    required: false,
    kinds: ["null", "string"],
  },
  {
    feature: "core",
    path: "TurnStartParams.threadId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "core",
    path: "TurnStartParams.input",
    required: true,
    kinds: ["array"],
  },
  {
    feature: "collaboration_modes",
    path: "TurnStartParams.collaborationMode",
    required: false,
    kinds: ["null", "object"],
  },
  {
    feature: "collaboration_modes",
    path: "CollaborationMode.mode",
    required: true,
    kinds: ["string"],
    literals: ["default", "plan"],
  },
  {
    feature: "collaboration_modes",
    path: "CollaborationMode.settings",
    required: true,
    kinds: ["object"],
  },
  {
    feature: "collaboration_modes",
    path: "Settings.model",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "collaboration_modes",
    path: "Settings.reasoning_effort",
    required: false,
    kinds: ["null", "string"],
  },
  {
    feature: "collaboration_modes",
    path: "Settings.developer_instructions",
    required: false,
    kinds: ["null", "string"],
  },
  {
    feature: "core",
    path: "TurnInterruptParams.threadId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "core",
    path: "TurnInterruptParams.turnId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "steer",
    path: "TurnSteerParams.expectedTurnId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputParams.threadId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputParams.turnId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputParams.itemId",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputParams.questions",
    required: true,
    kinds: ["array"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputQuestion.id",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputQuestion.header",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputQuestion.question",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputQuestion.isOther",
    required: true,
    kinds: ["boolean"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputQuestion.isSecret",
    required: true,
    kinds: ["boolean"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputQuestion.options",
    required: true,
    kinds: ["array", "null"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputOption.label",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputOption.description",
    required: true,
    kinds: ["string"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputResponse.answers",
    required: true,
    kinds: ["object"],
  },
  {
    feature: "request_user_input",
    path: "ToolRequestUserInputAnswer.answers",
    required: true,
    kinds: ["array"],
  },
];

type CompactFieldRequirement = readonly [
  feature: CompatibilityFeature,
  path: string,
  required: boolean,
  kinds: readonly JsonShapeKind[],
  literals?: readonly (string | number | boolean | null)[],
];

const CONSUMED_PROJECTION_FIELDS: readonly CompactFieldRequirement[] = [
  ["approvals", "ApplyPatchApprovalParams.conversationId", true, ["string"]],
  ["approvals", "ApplyPatchApprovalParams.callId", true, ["string"]],
  ["approvals", "ApplyPatchApprovalParams.reason", false, ["null", "string"]],
  ["approvals", "ApplyPatchApprovalParams.grantRoot", false, ["null", "string"]],
  ["approvals", "ExecCommandApprovalParams.conversationId", true, ["string"]],
  ["approvals", "ExecCommandApprovalParams.callId", true, ["string"]],
  ["approvals", "ExecCommandApprovalParams.approvalId", false, ["null", "string"]],
  ["approvals", "ExecCommandApprovalParams.command", true, ["array"]],
  ["approvals", "ExecCommandApprovalParams.cwd", true, ["string"]],
  ["approvals", "ExecCommandApprovalParams.reason", false, ["null", "string"]],
  ["approvals", "CommandExecutionRequestApprovalParams.startedAtMs", false, ["number"]],
  ["approvals", "CommandExecutionRequestApprovalParams.reason", false, ["null", "string"]],
  ["approvals", "CommandExecutionRequestApprovalParams.approvalId", false, ["null", "string"]],
  ["approvals", "CommandExecutionRequestApprovalParams.additionalPermissions", false, ["null", "object"]],
  ["approvals", "NetworkApprovalContext.host", true, ["string"]],
  ["approvals", "NetworkApprovalContext.protocol", true, ["string"], ["http", "https", "socks5Tcp", "socks5Udp"]],
  ["approvals", "NetworkPolicyAmendment.host", true, ["string"]],
  ["approvals", "NetworkPolicyAmendment.action", true, ["string"], ["allow", "deny"]],
  ["approvals", "FileChangeRequestApprovalParams.startedAtMs", false, ["number"]],
  ["approvals", "PermissionsRequestApprovalParams.threadId", true, ["string"]],
  ["approvals", "PermissionsRequestApprovalParams.turnId", true, ["string"]],
  ["approvals", "PermissionsRequestApprovalParams.itemId", true, ["string"]],
  ["approvals", "PermissionsRequestApprovalParams.startedAtMs", false, ["number"]],
  ["approvals", "PermissionsRequestApprovalParams.reason", false, ["null", "string"]],
  ["approvals", "PermissionsRequestApprovalParams.environmentId", false, ["null", "string"]],
  ["approvals", "PermissionsRequestApprovalParams.cwd", true, ["string"]],
  ["approvals", "PermissionsRequestApprovalParams.permissions", true, ["object"]],
  ["approvals", "AdditionalPermissionProfile.network", false, ["null", "object"]],
  ["approvals", "AdditionalPermissionProfile.fileSystem", false, ["null", "object"]],
  ["approvals", "RequestPermissionProfile.network", false, ["null", "object"]],
  ["approvals", "RequestPermissionProfile.fileSystem", false, ["null", "object"]],
  ["approvals", "AdditionalNetworkPermissions.enabled", false, ["boolean", "null"]],
  ["approvals", "AdditionalFileSystemPermissions.read", false, ["array", "null"]],
  ["approvals", "AdditionalFileSystemPermissions.write", false, ["array", "null"]],
  ["approvals", "AdditionalFileSystemPermissions.globScanMaxDepth", false, ["null", "number"]],
  ["approvals", "AdditionalFileSystemPermissions.entries", false, ["array", "null"]],
  ["approvals", "GrantedPermissionProfile.network", false, ["null", "object"]],
  ["approvals", "GrantedPermissionProfile.fileSystem", false, ["null", "object"]],
  ["core", "Thread.id", true, ["string"]],
  ["core", "Thread.status", true, ["object"]],
  ["core", "NotLoadedThreadStatus.type", true, ["string"], ["notLoaded"]],
  ["core", "IdleThreadStatus.type", true, ["string"], ["idle"]],
  ["core", "SystemErrorThreadStatus.type", true, ["string"], ["systemError"]],
  ["core", "ActiveThreadStatus.type", true, ["string"], ["active"]],
  ["core", "ActiveThreadStatus.activeFlags", true, ["array"], [
    "waitingOnApproval", "waitingOnUserInput",
  ]],
  ["core", "Thread.turns", true, ["array"]],
  ["core", "Turn.id", true, ["string"]],
  ["core", "Turn.items", true, ["array"]],
  ["core", "Turn.itemsView", false, ["string"], ["notLoaded", "summary", "full"]],
  ["core", "Turn.status", true, ["string"], ["completed", "interrupted", "failed", "inProgress"]],
  ["core", "Turn.error", false, ["null", "object"]],
  ["core", "Turn.startedAt", false, ["null", "number"]],
  ["core", "Turn.completedAt", false, ["null", "number"]],
  ["core", "Turn.durationMs", false, ["null", "number"]],
  ["core", "TurnError.message", true, ["string"]],
  ["core", "TurnError.additionalDetails", false, ["null", "string"]],
  ["core", "Model.id", true, ["string"]],
  ["core", "Model.model", true, ["string"]],
  ["core", "Model.displayName", true, ["string"]],
  ["core", "Model.description", true, ["string"]],
  ["core", "Model.hidden", true, ["boolean"]],
  ["core", "Model.isDefault", true, ["boolean"]],
  ["core", "InitializeResponse.userAgent", true, ["string"]],
  ["core", "InitializeResponse.codexHome", true, ["string"]],
  ["core", "InitializeResponse.platformFamily", true, ["string"]],
  ["core", "InitializeResponse.platformOs", true, ["string"]],
  ["core", "ThreadStartResponse.thread", true, ["object"]],
  ["core", "ThreadStartResponse.model", true, ["string"]],
  ["core", "ThreadStartResponse.cwd", true, ["string"]],
  ["core", "ThreadResumeResponse.thread", true, ["object"]],
  ["core", "ThreadResumeResponse.model", true, ["string"]],
  ["core", "ThreadResumeResponse.cwd", true, ["string"]],
  ["core", "ThreadReadResponse.thread", true, ["object"]],
  ["core", "ThreadListResponse.data", true, ["array"]],
  ["core", "ThreadListResponse.nextCursor", false, ["null", "string"]],
  ["core", "ThreadListResponse.backwardsCursor", false, ["null", "string"]],
  ["core", "ThreadUnarchiveResponse.thread", true, ["object"]],
  ["core", "TurnStartResponse.turn", true, ["object"]],
  ["steer", "TurnSteerResponse.turnId", false, ["string"]],
  ["collaboration_modes", "CollaborationModeListResponse.data", true, ["array"]],
  ["collaboration_modes", "CollaborationModeMask.name", true, ["string"]],
  ["collaboration_modes", "CollaborationModeMask.mode", false, ["null", "string"], ["default", "plan"]],
  ["collaboration_modes", "CollaborationModeMask.model", false, ["null", "string"]],
  ["collaboration_modes", "CollaborationModeMask.reasoning_effort", false, ["null", "string"]],
  ["core", "ModelListResponse.data", true, ["array"]],
  ["core", "ModelListResponse.nextCursor", false, ["null", "string"]],
  ["core", "CancelLoginAccountResponse.status", true, ["string"], ["notFound", "canceled"]],
  ["core", "ApiKeyv2::LoginAccountResponse.type", true, ["string"], ["apiKey"]],
  ["core", "Chatgptv2::LoginAccountResponse.type", true, ["string"], ["chatgpt"]],
  ["core", "Chatgptv2::LoginAccountResponse.loginId", true, ["string"]],
  ["core", "Chatgptv2::LoginAccountResponse.authUrl", true, ["string"]],
  ["core", "ChatgptDeviceCodev2::LoginAccountResponse.type", true, ["string"], ["chatgptDeviceCode"]],
  ["core", "ChatgptDeviceCodev2::LoginAccountResponse.loginId", false, ["string"]],
  ["core", "ChatgptDeviceCodev2::LoginAccountResponse.verificationUrl", true, ["string"]],
  ["core", "ChatgptDeviceCodev2::LoginAccountResponse.userCode", true, ["string"]],
  ["core", "ChatgptAuthTokensv2::LoginAccountResponse.type", true, ["string"], ["chatgptAuthTokens"]],
  ["core", "GetAccountResponse.account", false, ["null", "object"]],
  ["core", "GetAccountResponse.requiresOpenaiAuth", true, ["boolean"]],
  ["core", "ChatgptAccount.type", true, ["string"], ["chatgpt"]],
  ["core", "ChatgptAccount.email", true, ["null", "string"]],
  ["core", "ChatgptAccount.planType", true, ["string"], [
    "free", "go", "plus", "pro", "prolite", "team",
    "self_serve_business_usage_based", "business",
    "enterprise_cbp_usage_based", "enterprise", "ent26", "edu", "unknown",
  ]],
  ["core", "ApiKeyAccount.type", true, ["string"], ["apiKey"]],
  ["core", "AmazonBedrockAccount.type", true, ["string"], ["amazonBedrock"]],
  ["core", "GetAccountRateLimitsResponse.rateLimits", true, ["object"]],
  ["core", "GetAccountRateLimitsResponse.rateLimitsByLimitId", false, ["null", "object"]],
  ["core", "GetAccountTokenUsageResponse.summary", true, ["object"]],
  ["core", "GetAccountTokenUsageResponse.dailyUsageBuckets", false, ["array", "null"]],
  ["core", "RateLimitSnapshot.limitId", false, ["null", "string"]],
  ["core", "RateLimitSnapshot.limitName", false, ["null", "string"]],
  ["core", "RateLimitSnapshot.primary", false, ["null", "object"]],
  ["core", "RateLimitSnapshot.secondary", false, ["null", "object"]],
  ["core", "RateLimitSnapshot.credits", false, ["null", "object"]],
  ["core", "RateLimitSnapshot.individualLimit", false, ["null", "object"]],
  ["core", "RateLimitSnapshot.planType", false, ["null", "string"], [
    "free", "go", "plus", "pro", "prolite", "team",
    "self_serve_business_usage_based", "business",
    "enterprise_cbp_usage_based", "enterprise", "ent26", "edu", "unknown",
  ]],
  ["core", "RateLimitSnapshot.rateLimitReachedType", false, ["null", "string"], [
    "rate_limit_reached",
    "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
  ]],
  ["core", "RateLimitWindow.usedPercent", true, ["number"]],
  ["core", "RateLimitWindow.windowDurationMins", false, ["null", "number"]],
  ["core", "RateLimitWindow.resetsAt", false, ["null", "number"]],
  ["core", "CreditsSnapshot.hasCredits", true, ["boolean"]],
  ["core", "CreditsSnapshot.unlimited", true, ["boolean"]],
  ["core", "CreditsSnapshot.balance", false, ["null", "string"]],
  ["core", "SpendControlLimitSnapshot.limit", true, ["string"]],
  ["core", "SpendControlLimitSnapshot.used", true, ["string"]],
  ["core", "SpendControlLimitSnapshot.remainingPercent", true, ["number"]],
  ["core", "SpendControlLimitSnapshot.resetsAt", true, ["number"]],
  ["core", "AccountTokenUsageSummary.lifetimeTokens", false, ["null", "number"]],
  ["core", "AccountTokenUsageSummary.peakDailyTokens", false, ["null", "number"]],
  ["core", "AccountTokenUsageSummary.longestRunningTurnSec", false, ["null", "number"]],
  ["core", "AccountTokenUsageSummary.currentStreakDays", false, ["null", "number"]],
  ["core", "AccountTokenUsageSummary.longestStreakDays", false, ["null", "number"]],
  ["core", "AccountTokenUsageDailyBucket.startDate", true, ["string"]],
  ["core", "AccountTokenUsageDailyBucket.tokens", true, ["number"]],
  ["core", "ThreadStartedNotification.thread", true, ["object"]],
  ["core", "TurnStartedNotification.threadId", true, ["string"]],
  ["core", "TurnStartedNotification.turn", true, ["object"]],
  ["core", "TurnCompletedNotification.threadId", true, ["string"]],
  ["core", "TurnCompletedNotification.turn", true, ["object"]],
  ["core", "AccountRateLimitsUpdatedNotification.rateLimits", true, ["object"]],
  ["core", "AccountUpdatedNotification.authMode", false, ["null", "string"], [
    "apikey", "chatgpt", "chatgptAuthTokens", "agentIdentity",
    "personalAccessToken", "bedrockApiKey", "headers",
  ]],
  ["core", "AccountUpdatedNotification.planType", false, ["null", "string"], [
    "free", "go", "plus", "pro", "prolite", "team",
    "self_serve_business_usage_based", "business",
    "enterprise_cbp_usage_based", "enterprise", "ent26", "edu", "unknown",
  ]],
  ["core", "AccountLoginCompletedNotification.loginId", false, ["null", "string"]],
  ["core", "AccountLoginCompletedNotification.success", true, ["boolean"]],
  ["core", "AccountLoginCompletedNotification.error", false, ["null", "string"]],
  ["core", "AgentMessageDeltaNotification.threadId", true, ["string"]],
  ["core", "AgentMessageDeltaNotification.turnId", true, ["string"]],
  ["core", "AgentMessageDeltaNotification.itemId", true, ["string"]],
  ["core", "AgentMessageDeltaNotification.delta", true, ["string"]],
  ["core", "CommandExecutionOutputDeltaNotification.threadId", true, ["string"]],
  ["core", "CommandExecutionOutputDeltaNotification.turnId", true, ["string"]],
  ["core", "CommandExecutionOutputDeltaNotification.itemId", true, ["string"]],
  ["core", "CommandExecutionOutputDeltaNotification.delta", true, ["string"]],
  ["core", "FileChangeOutputDeltaNotification.threadId", true, ["string"]],
  ["core", "FileChangeOutputDeltaNotification.turnId", true, ["string"]],
  ["core", "FileChangeOutputDeltaNotification.itemId", true, ["string"]],
  ["core", "FileChangeOutputDeltaNotification.delta", true, ["string"]],
  ["core", "TerminalInteractionNotification.threadId", true, ["string"]],
  ["core", "TerminalInteractionNotification.turnId", true, ["string"]],
  ["core", "TerminalInteractionNotification.itemId", true, ["string"]],
  ["core", "TerminalInteractionNotification.processId", true, ["string"]],
  ["core", "TerminalInteractionNotification.stdin", true, ["string"]],
  ["core", "ItemCompletedNotification.item", true, ["object"]],
  ["core", "ItemCompletedNotification.threadId", true, ["string"]],
  ["core", "ItemCompletedNotification.turnId", true, ["string"]],
  ["core", "ItemCompletedNotification.completedAtMs", true, ["number"]],
  ["core", "FileChangePatchUpdatedNotification.threadId", true, ["string"]],
  ["core", "FileChangePatchUpdatedNotification.turnId", true, ["string"]],
  ["core", "FileChangePatchUpdatedNotification.itemId", true, ["string"]],
  ["core", "FileChangePatchUpdatedNotification.changes", true, ["array"]],
  ["core", "ItemStartedNotification.item", true, ["object"]],
  ["core", "ItemStartedNotification.threadId", true, ["string"]],
  ["core", "ItemStartedNotification.turnId", true, ["string"]],
  ["core", "ItemStartedNotification.startedAtMs", true, ["number"]],
  ["core", "ServerRequestResolvedNotification.threadId", true, ["string"]],
  ["core", "ServerRequestResolvedNotification.requestId", true, ["number", "string"]],
  ["core", "ThreadClosedNotification.threadId", true, ["string"]],
  ["core", "ThreadStatusChangedNotification.threadId", true, ["string"]],
  ["core", "ThreadStatusChangedNotification.status", true, ["object"]],
  ["core", "ThreadTokenUsageUpdatedNotification.threadId", true, ["string"]],
  ["core", "ThreadTokenUsageUpdatedNotification.turnId", true, ["string"]],
  ["core", "ThreadTokenUsageUpdatedNotification.tokenUsage", true, ["object"]],
  ["core", "ThreadTokenUsage.modelContextWindow", false, ["null", "number"]],
  ["core", "TurnDiffUpdatedNotification.threadId", true, ["string"]],
  ["core", "TurnDiffUpdatedNotification.turnId", true, ["string"]],
  ["core", "TurnDiffUpdatedNotification.diff", true, ["string"]],
  ["core", "AgentMessageThreadItem.type", true, ["string"], ["agentMessage"]],
  ["core", "AgentMessageThreadItem.id", true, ["string"]],
  ["core", "AgentMessageThreadItem.text", true, ["string"]],
  ["core", "AgentMessageThreadItem.phase", false, ["null", "string"], ["commentary", "final_answer"]],
  ["core", "CommandExecutionThreadItem.type", true, ["string"], ["commandExecution"]],
  ["core", "CommandExecutionThreadItem.id", true, ["string"]],
  ["core", "CommandExecutionThreadItem.command", true, ["string"]],
  ["core", "CommandExecutionThreadItem.cwd", true, ["string"]],
  ["core", "CommandExecutionThreadItem.processId", false, ["null", "string"]],
  ["core", "CommandExecutionThreadItem.status", true, ["string"], ["inProgress", "completed", "failed", "declined"]],
  ["core", "CommandExecutionThreadItem.aggregatedOutput", false, ["null", "string"]],
  ["core", "CommandExecutionThreadItem.exitCode", false, ["null", "number"]],
  ["core", "CommandExecutionThreadItem.durationMs", false, ["null", "number"]],
  ["core", "FileChangeThreadItem.type", true, ["string"], ["fileChange"]],
  ["core", "FileChangeThreadItem.id", true, ["string"]],
  ["core", "FileChangeThreadItem.changes", true, ["array"]],
  ["core", "FileChangeThreadItem.status", true, ["string"], ["inProgress", "completed", "failed", "declined"]],
  ["core", "FileUpdateChange.path", true, ["string"]],
  ["core", "FileUpdateChange.kind", true, ["object"]],
  ["core", "FileUpdateChange.diff", true, ["string"]],
  ["core", "AddPatchChangeKind.type", true, ["string"], ["add"]],
  ["core", "DeletePatchChangeKind.type", true, ["string"], ["delete"]],
  ["core", "UpdatePatchChangeKind.type", true, ["string"], ["update"]],
  ["core", "UpdatePatchChangeKind.move_path", false, ["null", "string"]],
  ["core", "UserMessageThreadItem.type", true, ["string"], ["userMessage"]],
  ["core", "UserMessageThreadItem.id", true, ["string"]],
  ["core", "UserMessageThreadItem.clientId", false, ["null", "string"]],
  ["core", "UserMessageThreadItem.content", true, ["array"]],
  ["core", "TextUserInput.type", true, ["string"], ["text"]],
  ["core", "TextUserInput.text", true, ["string"]],
  ["core", "TextUserInput.text_elements", false, ["array"]],
  ["core", "ImageUserInput.type", true, ["string"], ["image"]],
  ["core", "ImageUserInput.detail", false, ["null", "string"], [
    "auto", "low", "high", "original",
  ]],
  ["core", "ImageUserInput.url", true, ["string"]],
  ["core", "LocalImageUserInput.type", true, ["string"], ["localImage"]],
  ["core", "LocalImageUserInput.detail", false, ["null", "string"], [
    "auto", "low", "high", "original",
  ]],
  ["core", "LocalImageUserInput.path", true, ["string"]],
  ["core", "SkillUserInput.type", true, ["string"], ["skill"]],
  ["core", "SkillUserInput.name", true, ["string"]],
  ["core", "SkillUserInput.path", true, ["string"]],
  ["core", "MentionUserInput.type", true, ["string"], ["mention"]],
  ["core", "MentionUserInput.name", true, ["string"]],
  ["core", "MentionUserInput.path", true, ["string"]],
  ["core", "TextElement.byteRange", true, ["object"]],
  ["core", "TextElement.placeholder", false, ["null", "string"]],
  ["core", "ByteRange.start", true, ["number"]],
  ["core", "ByteRange.end", true, ["number"]],
  ["core", "HookPromptThreadItem.type", true, ["string"], ["hookPrompt"]],
  ["core", "HookPromptThreadItem.id", true, ["string"]],
  ["core", "HookPromptThreadItem.fragments", true, ["array"]],
  ["core", "HookPromptFragment.text", true, ["string"]],
  ["core", "PlanThreadItem.type", true, ["string"], ["plan"]],
  ["core", "PlanThreadItem.id", true, ["string"]],
  ["core", "PlanThreadItem.text", true, ["string"]],
  ["core", "ReasoningThreadItem.type", true, ["string"], ["reasoning"]],
  ["core", "ReasoningThreadItem.id", true, ["string"]],
  ["core", "ReasoningThreadItem.summary", false, ["array"]],
  ["core", "ReasoningThreadItem.content", false, ["array"]],
  ["core", "McpToolCallThreadItem.type", true, ["string"], ["mcpToolCall"]],
  ["core", "McpToolCallThreadItem.id", true, ["string"]],
  ["core", "McpToolCallThreadItem.server", true, ["string"]],
  ["core", "McpToolCallThreadItem.tool", true, ["string"]],
  ["core", "McpToolCallThreadItem.status", true, ["string"]],
  ["core", "McpToolCallThreadItem.arguments", true, ["array", "boolean", "null", "number", "object", "string"]],
  ["core", "CollabAgentToolCallThreadItem.type", true, ["string"], ["collabAgentToolCall"]],
  ["core", "CollabAgentToolCallThreadItem.id", true, ["string"]],
  ["core", "CollabAgentToolCallThreadItem.senderThreadId", true, ["string"]],
  ["core", "CollabAgentToolCallThreadItem.receiverThreadIds", true, ["array"]],
  ["core", "WebSearchThreadItem.type", true, ["string"], ["webSearch"]],
  ["core", "WebSearchThreadItem.id", true, ["string"]],
  ["core", "WebSearchThreadItem.query", true, ["string"]],
  ["core", "ImageViewThreadItem.type", true, ["string"], ["imageView"]],
  ["core", "ImageViewThreadItem.id", true, ["string"]],
  ["core", "ImageViewThreadItem.path", true, ["string"]],
  ["core", "ImageGenerationThreadItem.type", true, ["string"], ["imageGeneration"]],
  ["core", "ImageGenerationThreadItem.id", true, ["string"]],
  ["core", "ImageGenerationThreadItem.status", true, ["string"]],
  ["core", "ImageGenerationThreadItem.result", true, ["string"]],
  ["core", "EnteredReviewModeThreadItem.type", true, ["string"], ["enteredReviewMode"]],
  ["core", "EnteredReviewModeThreadItem.id", true, ["string"]],
  ["core", "EnteredReviewModeThreadItem.review", true, ["string"]],
  ["core", "ExitedReviewModeThreadItem.type", true, ["string"], ["exitedReviewMode"]],
  ["core", "ExitedReviewModeThreadItem.id", true, ["string"]],
  ["core", "ExitedReviewModeThreadItem.review", true, ["string"]],
  ["core", "ContextCompactionThreadItem.type", true, ["string"], ["contextCompaction"]],
  ["core", "ContextCompactionThreadItem.id", true, ["string"]],
  ["approvals", "ApplyPatchApprovalResponse.decision", true, ["object", "string"], ["approved", "approved_for_session", "timed_out", "abort"]],
  ["approvals", "ExecCommandApprovalResponse.decision", true, ["object", "string"], ["approved", "approved_for_session", "timed_out", "abort"]],
  ["approvals", "PermissionsRequestApprovalResponse.permissions", true, ["object"]],
  ["approvals", "PermissionsRequestApprovalResponse.scope", false, ["string"], ["turn", "session"]],
  ["approvals", "PermissionsRequestApprovalResponse.strictAutoReview", false, ["boolean", "null"]],
] as const;

export const CONSUMED_FIELD_REQUIREMENTS: readonly FieldRequirement[] =
  Object.freeze([
    ...BASE_FIELD_REQUIREMENTS.map((requirement) => ({
      ...requirement,
      direction: fieldDirection(requirement.path),
    })),
    ...CONSUMED_PROJECTION_FIELDS.map(
      ([feature, path, required, kinds, literals]) => ({
        feature,
        path,
        direction: fieldDirection(path),
        required,
        kinds: [...kinds],
        ...(literals === undefined ? {} : { literals }),
      }),
    ),
  ]);

const FEATURES: readonly CompatibilityFeature[] = [
  "core",
  "steer",
  "approvals",
  "request_user_input",
  "collaboration_modes",
];

function sameKinds(
  observed: readonly JsonShapeKind[],
  required: readonly JsonShapeKind[],
): boolean {
  const observedSet = new Set(observed);
  return (
    observedSet.size === required.length &&
    required.every((kind) => observedSet.has(kind))
  );
}

function senderValuesFitReceiver<T>(
  sender: readonly T[] | undefined,
  receiver: readonly T[] | undefined,
): boolean {
  if (receiver === undefined) return true;
  if (sender === undefined) return false;
  const accepted = new Set(receiver);
  return sender.every((value) => accepted.has(value));
}

function fieldShapeCompatible(
  observed: ObservedFieldShape,
  requirement: FieldRequirement,
): boolean {
  if (requirement.direction === "nautilo_to_runtime") {
    // Nautilo is the sender: every value it may serialize must be accepted by
    // the runtime, and a field Nautilo may omit cannot become required.
    return (!observed.required || requirement.required) &&
      senderValuesFitReceiver(requirement.kinds, observed.kinds) &&
      senderValuesFitReceiver(requirement.literals, observed.literals);
  }
  // The runtime is the sender: every value it may emit must pass Nautilo's
  // decoder, and a field Nautilo requires cannot become optional.
  return (!requirement.required || observed.required) &&
    senderValuesFitReceiver(observed.kinds, requirement.kinds) &&
    senderValuesFitReceiver(observed.literals, requirement.literals);
}

export function evaluateCompatibility(
  input: ProtocolObservation | VerifiedProtocolObservation,
): CompatibilityResult {
  const evidence = "observation" in input ? input : undefined;
  const observation: ProtocolObservation =
    evidence?.observation ?? (input as ProtocolObservation);
  const reasons: CompatibilityReason[] = [];

  for (const requirement of MEMBER_REQUIREMENTS) {
    if (!observation.members[requirement.surface]?.includes(requirement.member)) {
      reasons.push({
        feature: requirement.feature,
        code: "missing_member",
        target: `${requirement.surface}:${requirement.member}`,
      });
    }
  }

  for (const requirement of CONSUMED_FIELD_REQUIREMENTS) {
    const observed = observation.fields[requirement.path];
    if (!observed) {
      // An absent runtime-owned optional field can never violate Nautilo's
      // decoder. Outbound and required inbound fields remain load-bearing.
      if (
        requirement.direction === "runtime_to_nautilo" &&
        !requirement.required
      ) continue;
      reasons.push({
        feature: requirement.feature,
        code: "missing_field",
        target: requirement.path,
      });
      continue;
    }
    if (!fieldShapeCompatible(observed, requirement)) {
      reasons.push({
        feature: requirement.feature,
        code: "changed_field_shape",
        target: requirement.path,
      });
    }
  }

  const features = Object.fromEntries(
    FEATURES.map((feature) => [
      feature,
      !reasons.some((reason) => reason.feature === feature),
    ]),
  ) as Record<CompatibilityFeature, boolean>;

  let state: CompatibilityState;
  if (!features.core || !features.steer) {
    state = "incompatible";
  } else if (
    !features.approvals ||
    !features.request_user_input ||
    !features.collaboration_modes
  ) {
    state = "limited";
  } else if (
    evidence !== undefined &&
    VERIFIED_OBSERVATIONS.has(evidence) &&
    evidence.schemaFingerprint === CERTIFIED_SCHEMA_FINGERPRINT &&
    evidence.executable !== null &&
    isVerifiedExecutableEvidence(evidence.executable) &&
    evidence.executable.fingerprint === CERTIFIED_EXECUTABLE_FINGERPRINT
  ) {
    state = "certified";
  } else {
    state = "compatible_uncertified";
  }

  return { state, features, reasons };
}

/**
 * The reviewed anchor's stable schema intentionally differs from its
 * experimental schema at these exact projections. Every other required
 * member and field remains load-bearing for stable admission.
 */
const REVIEWED_STABLE_FIELD_SHAPES: Readonly<
  Record<string, ObservedFieldShape | null>
> = Object.freeze({
  "CommandExecutionRequestApprovalParams.availableDecisions": null,
  "InitializeCapabilities.experimentalApi": {
    required: false,
    kinds: ["boolean"],
  },
  "ToolRequestUserInputQuestion.isOther": {
    required: false,
    kinds: ["boolean"],
  },
  "ToolRequestUserInputQuestion.isSecret": {
    required: false,
    kinds: ["boolean"],
  },
  "ToolRequestUserInputQuestion.options": {
    required: false,
    kinds: ["array", "null"],
  },
  "CommandExecutionRequestApprovalParams.startedAtMs": {
    required: true,
    kinds: ["number"],
  },
  "CommandExecutionRequestApprovalParams.additionalPermissions": null,
  "FileChangeRequestApprovalParams.startedAtMs": {
    required: true,
    kinds: ["number"],
  },
  "PermissionsRequestApprovalParams.startedAtMs": {
    required: true,
    kinds: ["number"],
  },
  "TurnSteerResponse.turnId": {
    required: true,
    kinds: ["string"],
  },
  "ChatgptDeviceCodev2::LoginAccountResponse.loginId": {
    required: true,
    kinds: ["string"],
  },
});

export function evaluateStableCompatibility(
  input: ProtocolObservation | VerifiedProtocolObservation,
): StableCompatibilityResult {
  const observation =
    "observation" in input ? input.observation : input;
  const reasons = evaluateCompatibility(input).reasons.filter((reason) => {
    // Collaboration modes are an experimental-only turn setting. Stable
    // admission deliberately proves the common protocol without requiring it.
    if (reason.feature === "collaboration_modes") return false;
    if (!Object.hasOwn(REVIEWED_STABLE_FIELD_SHAPES, reason.target)) return true;
    const expected = REVIEWED_STABLE_FIELD_SHAPES[reason.target];
    if (expected === undefined) return true;
    const observed = observation.fields[reason.target];
    if (expected === null)
      return observed !== undefined || reason.code !== "missing_field";
    return !(
      observed !== undefined &&
      observed.required === expected.required &&
      sameKinds(observed.kinds, expected.kinds) &&
      (expected.literals === undefined ||
        expected.literals.every((literal) =>
          observed.literals?.includes(literal),
        ))
    );
  });
  return Object.freeze({
    compatible: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}
import { createHash } from "node:crypto";
