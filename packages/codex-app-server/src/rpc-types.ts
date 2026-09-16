export const REVIEWED_CLIENT_METHODS = [
  "initialize", "thread/start", "thread/resume", "thread/read",
  "thread/archive", "thread/list", "thread/unarchive", "turn/start",
  "turn/interrupt", "turn/steer", "collaborationMode/list", "model/list", "account/login/start",
  "account/login/cancel", "account/logout", "account/read",
  "account/rateLimits/read", "account/usage/read", "getAuthStatus",
] as const;
export type ReviewedClientMethod = (typeof REVIEWED_CLIENT_METHODS)[number];

export type SemanticJson =
  | null | boolean | number | string
  | readonly SemanticJson[]
  | { readonly [key: string]: SemanticJson };
export type PlanType =
  | "free" | "go" | "plus" | "pro" | "prolite" | "team"
  | "self_serve_business_usage_based" | "business"
  | "enterprise_cbp_usage_based" | "enterprise" | "ent26" | "edu" | "unknown";
export type AuthMode =
  | "apikey" | "chatgpt" | "chatgptAuthTokens"
  | "agentIdentity" | "personalAccessToken" | "bedrockApiKey" | "headers";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
/** Nautilo's deliberately compact product selection for the generated mode preset. */
export type CodexCollaborationMode = "work" | "plan";
export interface CollaborationModePresetProjection {
  readonly name: string;
  readonly mode: "default" | "plan" | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}
export interface ClientRequestParamsMap {
  initialize: {
    readonly clientName: string;
    readonly clientTitle: string;
    readonly clientVersion: string;
    readonly experimentalApi: boolean;
    readonly requestAttestation?: boolean | undefined;
  };
  "thread/start": {
    readonly model?: string | null | undefined;
    readonly cwd?: string | null | undefined;
    readonly approvalPolicy?: ApprovalPolicy | null | undefined;
    readonly sandbox?: SandboxMode | null | undefined;
    readonly permissions?: string | null | undefined;
  };
  "thread/resume": {
    readonly threadId: string;
    readonly model?: string | null | undefined;
    readonly cwd?: string | null | undefined;
    readonly excludeTurns?: boolean | undefined;
  };
  "thread/read": { readonly threadId: string; readonly includeTurns?: boolean | undefined };
  "thread/archive": { readonly threadId: string };
  "thread/list": {
    readonly cursor?: string | null | undefined;
    readonly limit?: number | null | undefined;
    readonly archived?: boolean | null | undefined;
    readonly searchTerm?: string | null | undefined;
  };
  "thread/unarchive": { readonly threadId: string };
  "turn/start": {
    readonly threadId: string;
    readonly text: string;
    readonly clientUserMessageId?: string | null | undefined;
    readonly cwd?: string | null | undefined;
    readonly approvalPolicy?: ApprovalPolicy | null | undefined;
    readonly permissions?: string | null | undefined;
    readonly model?: string | null | undefined;
    /** Required at Nautilo's handwritten boundary: never inherit a prior turn mode. */
    readonly collaborationMode: CodexCollaborationMode;
    /** Decoded result of collaborationMode/list selected for the compact mode. */
    readonly collaborationModePreset: CollaborationModePresetProjection;
    /** Actual model selected for the bound thread when the preset leaves model null. */
    readonly selectedThreadModel: string;
  };
  "turn/interrupt": { readonly threadId: string; readonly turnId: string };
  "turn/steer": {
    readonly threadId: string;
    readonly text: string;
    readonly expectedTurnId: string;
    readonly clientUserMessageId?: string | null | undefined;
  };
  "collaborationMode/list": undefined;
  "model/list": {
    readonly cursor?: string | null | undefined;
    readonly limit?: number | null | undefined;
    readonly includeHidden?: boolean | null | undefined;
  };
  "account/login/start":
    | { readonly type: "apiKey"; readonly apiKey: string }
    | { readonly type: "chatgpt"; readonly streamlined?: boolean | undefined }
    | { readonly type: "chatgptDeviceCode" };
  "account/login/cancel": { readonly loginId: string };
  "account/logout": undefined;
  "account/read": { readonly refreshToken?: boolean | undefined };
  "account/rateLimits/read": undefined;
  "account/usage/read": undefined;
  getAuthStatus: { readonly refreshToken?: boolean | undefined };
}

type WireBuilderMap = {
  [M in ReviewedClientMethod]: (params: ClientRequestParamsMap[M]) => unknown;
};

const CLIENT_WIRE_BUILDERS: WireBuilderMap = {
  initialize: (params) => ({
    clientInfo: {
      name: params.clientName,
      title: params.clientTitle,
      version: params.clientVersion,
    },
    capabilities: {
      experimentalApi: params.experimentalApi,
      requestAttestation: params.requestAttestation ?? false,
    },
  }),
  "thread/start": (params) => ({
    model: params.model,
    cwd: params.cwd,
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox,
    permissions: params.permissions,
  }),
  "thread/resume": (params) => ({
    threadId: params.threadId,
    model: params.model,
    cwd: params.cwd,
    excludeTurns: params.excludeTurns,
  }),
  "thread/read": (params) => ({ threadId: params.threadId, includeTurns: params.includeTurns }),
  "thread/archive": (params) => ({ threadId: params.threadId }),
  "thread/list": (params) => ({ ...params }),
  "thread/unarchive": (params) => ({ threadId: params.threadId }),
  "turn/start": (params) => ({
    threadId: params.threadId,
    clientUserMessageId: params.clientUserMessageId,
    input: [{ type: "text", text: params.text, text_elements: [] }],
    cwd: params.cwd,
    approvalPolicy: params.approvalPolicy,
    permissions: params.permissions,
    model: params.model,
    collaborationMode: {
      mode: params.collaborationMode === "work" ? "default" : "plan",
      settings: {
        model: params.collaborationModePreset.model ?? params.selectedThreadModel,
        reasoning_effort: params.collaborationModePreset.reasoningEffort,
        // The generated contract defines null as the selected mode's built-ins.
        developer_instructions: null,
      },
    },
  }),
  "turn/interrupt": (params) => ({ ...params }),
  "turn/steer": (params) => ({
    threadId: params.threadId,
    clientUserMessageId: params.clientUserMessageId,
    input: [{ type: "text", text: params.text, text_elements: [] }],
    expectedTurnId: params.expectedTurnId,
  }),
  "collaborationMode/list": () => ({}),
  "model/list": (params) => ({ ...params }),
  "account/login/start": (params) => params.type === "chatgpt"
    ? { type: "chatgpt", codexStreamlinedLogin: params.streamlined }
    : params,
  "account/login/cancel": (params) => ({ loginId: params.loginId }),
  "account/logout": () => undefined,
  "account/read": (params) => ({ refreshToken: params.refreshToken }),
  "account/rateLimits/read": () => undefined,
  "account/usage/read": () => undefined,
  getAuthStatus: (params) => ({
    includeToken: false,
    refreshToken: params.refreshToken ?? false,
  }),
};

export function buildUncheckedClientWireParams<M extends ReviewedClientMethod>(
  method: M,
  params: ClientRequestParamsMap[M],
): unknown {
  return CLIENT_WIRE_BUILDERS[method](params);
}
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type ThreadStatus =
  | { readonly type: "notLoaded" | "idle" | "systemError" }
  | { readonly type: "active"; readonly activeFlags: readonly ("waitingOnApproval" | "waitingOnUserInput")[] };
export interface TurnErrorProjection {
  readonly message: string;
  readonly additionalDetails: string | null;
}
export interface HiddenThreadItemProjection {
  readonly type: "hidden";
  readonly reason: "unknown_thread_item" | "unconsumed_thread_item";
}
export type ThreadItemProjection =
  | { readonly type: "agentMessage"; readonly id: string; readonly text: string; readonly phase: "commentary" | "final_answer" | null }
  | { readonly type: "commandExecution"; readonly id: string; readonly command: string; readonly cwd: string; readonly processId: string | null; readonly status: string; readonly aggregatedOutput: string | null; readonly exitCode: number | null; readonly durationMs: number | null }
  | { readonly type: "fileChange"; readonly id: string; readonly changes: readonly FileChangeProjection[]; readonly status: string }
  | HiddenThreadItemProjection;
export interface FileChangeProjection {
  readonly path: string;
  readonly kind:
    | { readonly type: "add" | "delete" }
    | { readonly type: "update"; readonly move_path: string | null };
  readonly diff: string;
}
export interface TurnProjection {
  readonly id: string;
  readonly items: readonly ThreadItemProjection[];
  readonly itemsView: "notLoaded" | "summary" | "full";
  readonly status: TurnStatus;
  readonly error: TurnErrorProjection | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
}
export interface ThreadProjection {
  readonly id: string;
  readonly status: ThreadStatus;
  readonly turns: readonly TurnProjection[];
}
export interface RateLimitWindowProjection {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}
export interface CreditsProjection {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}
export interface SpendLimitProjection {
  readonly limit: string;
  readonly used: string;
  readonly remainingPercent: number;
  readonly resetsAt: number;
}
export interface RateLimitProjection {
  readonly limitId: string | null;
  readonly limitName: string | null;
  readonly primary: RateLimitWindowProjection | null;
  readonly secondary: RateLimitWindowProjection | null;
  readonly credits: CreditsProjection | null;
  readonly individualLimit: SpendLimitProjection | null;
  readonly planType: PlanType | null;
  readonly rateLimitReachedType:
    | "rate_limit_reached"
    | "workspace_owner_credits_depleted"
    | "workspace_member_credits_depleted"
    | "workspace_owner_usage_limit_reached"
    | "workspace_member_usage_limit_reached"
    | null;
}
export interface UsageSummaryProjection {
  readonly lifetimeTokens: number | string | null;
  readonly peakDailyTokens: number | string | null;
  readonly longestRunningTurnSec: number | string | null;
  readonly currentStreakDays: number | string | null;
  readonly longestStreakDays: number | string | null;
}

export interface ClientResponseMap {
  initialize: { readonly userAgent: string; readonly codexHome: string; readonly platformFamily: string; readonly platformOs: string };
  "thread/start": { readonly thread: ThreadProjection; readonly model: string; readonly cwd: string };
  "thread/resume": { readonly thread: ThreadProjection; readonly model: string; readonly cwd: string };
  "thread/read": { readonly thread: ThreadProjection };
  "thread/archive": Record<string, never>;
  "thread/list": { readonly data: readonly ThreadProjection[]; readonly nextCursor: string | null; readonly backwardsCursor: string | null };
  "thread/unarchive": { readonly thread: ThreadProjection };
  "turn/start": { readonly turn: TurnProjection };
  "turn/interrupt": Record<string, never>;
  "turn/steer": { readonly turnId?: string | undefined };
  "collaborationMode/list": { readonly data: readonly CollaborationModePresetProjection[] };
  "model/list": { readonly data: readonly { readonly id: string; readonly model: string; readonly displayName: string; readonly description: string; readonly hidden: boolean; readonly isDefault: boolean }[]; readonly nextCursor: string | null };
  "account/login/start":
    | { readonly type: "apiKey" | "chatgptAuthTokens" }
    | { readonly type: "chatgpt"; readonly loginId: string; readonly authUrl: string }
    | { readonly type: "chatgptDeviceCode"; readonly loginId?: string | undefined; readonly verificationUrl: string; readonly userCode: string };
  "account/login/cancel": { readonly status: "notFound" | "canceled" };
  "account/logout": Record<string, never>;
  "account/read": {
    readonly account:
      | { readonly type: "apiKey" | "amazonBedrock" }
      | { readonly type: "chatgpt"; readonly email: string | null; readonly planType: PlanType }
      | null;
    readonly requiresOpenaiAuth: boolean;
  };
  "account/rateLimits/read": { readonly rateLimits: RateLimitProjection; readonly rateLimitsByLimitId: Readonly<Record<string, RateLimitProjection>> | null };
  "account/usage/read": { readonly summary: UsageSummaryProjection; readonly dailyUsageBuckets: readonly { readonly startDate: string; readonly tokens: number | string }[] | null };
  getAuthStatus: { readonly authMethod: AuthMode | null; readonly requiresOpenaiAuth: boolean | null };
}

export const ENABLED_SERVER_REQUEST_METHODS = [
  "applyPatchApproval", "execCommandApproval",
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
] as const;
export type EnabledServerRequestMethod =
  (typeof ENABLED_SERVER_REQUEST_METHODS)[number];

export interface ApprovalRequestProjection {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly startedAtMs?: number | undefined;
  readonly reason?: string | null | undefined;
}

/** A bounded semantic projection of the generated CommandAction union. */
export type CommandActionProjection =
  | { readonly type: "read"; readonly command: string; readonly name: string; readonly path: string }
  | { readonly type: "listFiles"; readonly command: string; readonly path: string | null }
  | { readonly type: "search"; readonly command: string; readonly query: string | null; readonly path: string | null }
  | { readonly type: "unknown"; readonly command: string };

export interface NetworkApprovalContextProjection {
  readonly host: string;
  readonly protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
}

export interface NetworkPolicyAmendmentProjection {
  readonly host: string;
  readonly action: "allow" | "deny";
}

export type FileSystemPathProjection =
  | { readonly type: "path"; readonly path: string }
  | { readonly type: "glob_pattern"; readonly pattern: string }
  | {
    readonly type: "special";
    readonly value:
      | { readonly kind: "root" | "minimal" | "tmpdir" | "slash_tmp" }
      | { readonly kind: "project_roots"; readonly subpath: string | null }
      | { readonly kind: "unknown"; readonly path: string; readonly subpath: string | null };
  };

export interface FileSystemSandboxEntryProjection {
  readonly path: FileSystemPathProjection;
  readonly access: "read" | "write" | "deny";
}

export interface FileSystemPermissionsProjection {
  readonly read: readonly string[] | null;
  readonly write: readonly string[] | null;
  readonly globScanMaxDepth?: number | null | undefined;
  readonly entries?: readonly FileSystemSandboxEntryProjection[] | null | undefined;
}

export interface PermissionProfileProjection {
  readonly network: { readonly enabled: boolean | null } | null;
  readonly fileSystem: FileSystemPermissionsProjection | null;
}

export type CommandExecutionApprovalDecisionProjection =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | {
    readonly acceptWithExecpolicyAmendment: {
      readonly execpolicy_amendment: readonly string[];
    };
  }
  | {
    readonly applyNetworkPolicyAmendment: {
      readonly network_policy_amendment: NetworkPolicyAmendmentProjection;
    };
  };

export interface ServerRequestParamsMap {
  applyPatchApproval: { readonly conversationId: string; readonly callId: string; readonly reason: string | null; readonly grantRoot: string | null };
  execCommandApproval: { readonly conversationId: string; readonly callId: string; readonly approvalId: string | null; readonly command: readonly string[]; readonly cwd: string; readonly reason: string | null };
  "item/commandExecution/requestApproval": ApprovalRequestProjection & {
    readonly approvalId?: string | null | undefined;
    readonly command?: string | null | undefined;
    readonly cwd?: string | null | undefined;
    readonly networkApprovalContext?: NetworkApprovalContextProjection | null | undefined;
    readonly commandActions?: readonly CommandActionProjection[] | null | undefined;
    readonly proposedExecpolicyAmendment?: readonly string[] | null | undefined;
    readonly proposedNetworkPolicyAmendments?: readonly NetworkPolicyAmendmentProjection[] | null | undefined;
    readonly availableDecisions?: readonly CommandExecutionApprovalDecisionProjection[] | null | undefined;
    readonly additionalPermissions?: PermissionProfileProjection | null | undefined;
  };
  "item/fileChange/requestApproval": ApprovalRequestProjection & { readonly grantRoot?: string | null | undefined };
  "item/permissions/requestApproval": ApprovalRequestProjection & {
    readonly environmentId: string | null;
    readonly cwd: string;
    readonly permissions: PermissionProfileProjection;
  };
  "item/tool/requestUserInput": { readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly autoResolutionMs?: number | null | undefined; readonly questions: readonly { readonly id: string; readonly header: string; readonly question: string; readonly isOther: boolean; readonly isSecret: boolean; readonly options: readonly { readonly label: string; readonly description: string }[] | null }[] };
}

export interface ServerRequestResponseMap {
  applyPatchApproval: { readonly decision: "approved" | "approved_for_session" | "denied" | "timed_out" | "abort" };
  execCommandApproval: { readonly decision: "approved" | "approved_for_session" | "denied" | "timed_out" | "abort" };
  "item/commandExecution/requestApproval": { readonly decision: CommandExecutionApprovalDecisionProjection };
  "item/fileChange/requestApproval": { readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" };
  "item/permissions/requestApproval": {
    readonly permissions: {
      readonly network?: { readonly enabled: boolean | null } | undefined;
      readonly fileSystem?: { readonly read: readonly string[] | null; readonly write: readonly string[] | null } | undefined;
    };
    readonly scope: "turn" | "session";
    readonly strictAutoReview?: boolean | undefined;
  };
  "item/tool/requestUserInput": {
    readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>>;
  };
}

export function buildServerRequestWireResponse<M extends EnabledServerRequestMethod>(
  method: M,
  response: ServerRequestResponseMap[M],
): unknown {
  if (
    (method === "applyPatchApproval" || method === "execCommandApproval") &&
    (response as ServerRequestResponseMap["applyPatchApproval"]).decision === "denied"
  ) {
    return { decision: { denied: { rejection: "Denied by user." } } };
  }
  return response;
}

export const ENABLED_SERVER_NOTIFICATION_METHODS = [
  "account/login/completed", "account/rateLimits/updated", "account/updated",
  "item/agentMessage/delta", "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction", "item/completed",
  "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "item/started",
  "serverRequest/resolved", "thread/closed", "thread/started",
  "thread/status/changed", "thread/tokenUsage/updated", "turn/completed",
  "turn/diff/updated", "turn/started",
] as const;
export type EnabledServerNotificationMethod =
  (typeof ENABLED_SERVER_NOTIFICATION_METHODS)[number];

export interface ServerNotificationParamsMap {
  "account/login/completed": { readonly loginId: string | null; readonly success: boolean; readonly error: string | null };
  "account/rateLimits/updated": { readonly rateLimits: RateLimitProjection };
  "account/updated": { readonly authMode: AuthMode | null; readonly planType: PlanType | null };
  "item/agentMessage/delta": ItemDeltaProjection;
  "item/commandExecution/outputDelta": ItemDeltaProjection;
  "item/commandExecution/terminalInteraction": { readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly processId: string; readonly stdin: string };
  "item/completed": { readonly item: ThreadItemProjection; readonly threadId: string; readonly turnId: string; readonly completedAtMs: number };
  "item/fileChange/outputDelta": ItemDeltaProjection;
  "item/fileChange/patchUpdated": { readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly changes: readonly FileChangeProjection[] };
  "item/started": { readonly item: ThreadItemProjection; readonly threadId: string; readonly turnId: string; readonly startedAtMs: number };
  "serverRequest/resolved": { readonly threadId: string; readonly requestId: string | number };
  "thread/closed": { readonly threadId: string };
  "thread/started": { readonly thread: ThreadProjection };
  "thread/status/changed": { readonly threadId: string; readonly status: ThreadStatus };
  "thread/tokenUsage/updated": { readonly threadId: string; readonly turnId: string; readonly tokenUsage: { readonly modelContextWindow: number | null } };
  "turn/completed": { readonly threadId: string; readonly turn: TurnProjection };
  "turn/diff/updated": { readonly threadId: string; readonly turnId: string; readonly diff: string };
  "turn/started": { readonly threadId: string; readonly turn: TurnProjection };
}
export interface ItemDeltaProjection {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly delta: string;
}

export type DecodedServerNotification = {
  [M in EnabledServerNotificationMethod]: {
    readonly method: M;
    readonly params: ServerNotificationParamsMap[M];
  };
}[EnabledServerNotificationMethod];

export interface RpcRuntimeDecoder {
  decodeError(value: unknown): RpcDecodedError;
  decodeClientResponse<M extends ReviewedClientMethod>(
    method: M,
    value: unknown,
  ): ClientResponseMap[M];
  decodeServerRequest<M extends EnabledServerRequestMethod>(
    method: M,
    value: unknown,
  ): ServerRequestParamsMap[M];
  decodeServerRequestResponse<M extends EnabledServerRequestMethod>(
    method: M,
    value: unknown,
  ): ServerRequestResponseMap[M];
  decodeServerNotification<M extends EnabledServerNotificationMethod>(
    method: M,
    value: unknown,
  ): ServerNotificationParamsMap[M];
}

export interface RpcDecodedError {
  readonly code: number;
  readonly message: string;
}

export interface RpcRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly retryOverload?: boolean;
}

export interface ServerRequestContext {
  readonly signal: AbortSignal;
  /** Exact JSON-RPC id emitted by the app-server for this inbound request. */
  readonly requestId: string | number;
  /** Exact client-owned timeout boundary for any correlated external proxy. */
  readonly expiresAt: string;
}

export type ServerRequestHandlers = {
  [M in EnabledServerRequestMethod]?: (
    params: ServerRequestParamsMap[M],
    context: ServerRequestContext,
  ) => Promise<ServerRequestResponseMap[M]> | ServerRequestResponseMap[M];
};

export type CodexRpcErrorCode =
  | "cancelled"
  | "closed"
  | "eof"
  | "frame_too_large"
  | "handler_failed"
  | "invalid_frame"
  | "invalid_json"
  | "invalid_utf8"
  | "overloaded"
  | "protocol_violation"
  | "queue_full"
  | "remote_error"
  | "timeout"
  | "truncated_frame"
  | "transport_failed";

const ERROR_MESSAGES: Readonly<Record<CodexRpcErrorCode, string>> = Object.freeze({
  cancelled: "Codex request was cancelled",
  closed: "Codex RPC client is closed",
  eof: "Codex RPC transport reached end of stream",
  frame_too_large: "Codex RPC frame exceeded the size limit",
  handler_failed: "Codex server request could not be handled",
  invalid_frame: "Codex RPC frame was invalid",
  invalid_json: "Codex RPC frame was not valid JSON",
  invalid_utf8: "Codex RPC frame was not valid UTF-8",
  overloaded: "Codex app-server is overloaded",
  protocol_violation: "Codex RPC protocol violation",
  queue_full: "Codex RPC write queue is full",
  remote_error: "Codex app-server rejected the request",
  timeout: "Codex request timed out",
  truncated_frame: "Codex RPC stream ended with a truncated frame",
  transport_failed: "Codex RPC transport failed",
});

export class CodexRpcError extends Error {
  readonly code: CodexRpcErrorCode;
  readonly remoteCode?: number;

  constructor(code: CodexRpcErrorCode, remoteCode?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexRpcError";
    this.code = code;
    if (remoteCode !== undefined) this.remoteCode = remoteCode;
  }
}
