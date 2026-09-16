import { z } from "zod";
import type {
  ClientRequestParamsMap,
  ClientResponseMap,
  EnabledServerNotificationMethod,
  EnabledServerRequestMethod,
  HiddenThreadItemProjection,
  ReviewedClientMethod,
  RpcDecodedError,
  RpcRuntimeDecoder,
  SemanticJson,
  ServerNotificationParamsMap,
  ServerRequestParamsMap,
  ServerRequestResponseMap,
  ThreadItemProjection,
} from "./rpc-types";
import { CodexRpcError, buildUncheckedClientWireParams } from "./rpc-types";

export const REVIEWED_JSON_LIMITS = Object.freeze({
  maxDepth: 128,
  maxNodes: 1_000_000,
});
export type ReviewedJson = SemanticJson;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertReviewedJson(
  value: unknown,
  limits: { readonly maxDepth: number; readonly maxNodes: number } =
    REVIEWED_JSON_LIMITS,
): asserts value is ReviewedJson {
  const work: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (work.length > 0) {
    const current = work.pop()!;
    nodes += 1;
    if (nodes > limits.maxNodes || current.depth > limits.maxDepth) {
      throw new TypeError("reviewed JSON exceeds limits");
    }
    const candidate = current.value;
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) continue;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new TypeError("reviewed JSON number is not finite");
      continue;
    }
    if (Array.isArray(candidate)) {
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        work.push({ value: candidate[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(candidate)) throw new TypeError("reviewed JSON is not plain");
    const values = Object.values(candidate);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      work.push({ value: values[index], depth: current.depth + 1 });
    }
  }
}

const reviewedJsonSchema = z.custom<ReviewedJson>((value) => {
  try {
    assertReviewedJson(value);
    return true;
  } catch {
    return false;
  }
});
const finiteNumber = z.number().finite();
const nonNegativeInteger = finiteNumber.int().nonnegative();
const stringOrNull = z.string().nullable();
const emptySchema = z.object({});
const planTypeSchema = z.enum([
  "free", "go", "plus", "pro", "prolite", "team",
  "self_serve_business_usage_based", "business",
  "enterprise_cbp_usage_based", "enterprise", "ent26", "edu", "unknown",
]);
const authModeSchema = z.enum([
  "apikey", "chatgpt", "chatgptAuthTokens", "agentIdentity", "personalAccessToken",
  "bedrockApiKey", "headers",
]);
const commandStatusSchema = z.enum(["inProgress", "completed", "failed", "declined"]);
const patchStatusSchema = z.enum(["inProgress", "completed", "failed", "declined"]);
const collaborationModeKindSchema = z.enum(["default", "plan"]);
const collaborationModePresetSchema = z.object({
  name: z.string().min(1).max(128),
  mode: collaborationModeKindSchema.nullable().default(null),
  model: z.string().min(1).max(512).nullable().default(null),
  reasoningEffort: z.string().min(1).max(64).nullable().default(null),
});
const collaborationModePresetWireSchema = z.object({
  name: z.string().min(1).max(128),
  mode: collaborationModeKindSchema.nullable().default(null),
  model: z.string().min(1).max(512).nullable().default(null),
  reasoning_effort: z.string().min(1).max(64).nullable().default(null),
}).transform((value) => ({
  name: value.name,
  mode: value.mode,
  model: value.model,
  reasoningEffort: value.reasoning_effort,
}));
const fileChangeKindSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add") }),
  z.object({ type: z.literal("delete") }),
  z.object({ type: z.literal("update"), move_path: stringOrNull.default(null) }),
]);
const fileChangeSchema = z.object({
  path: z.string(),
  kind: fileChangeKindSchema,
  diff: z.string(),
});
const threadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("notLoaded") }),
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("systemError") }),
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])),
  }),
]);
const turnErrorSchema = z.object({
  message: z.string(),
  additionalDetails: stringOrNull.default(null),
});

const hiddenUnknown: HiddenThreadItemProjection = Object.freeze({
  type: "hidden",
  reason: "unknown_thread_item",
});
const hiddenUnconsumed: HiddenThreadItemProjection = Object.freeze({
  type: "hidden",
  reason: "unconsumed_thread_item",
});
export type HiddenThreadItem = HiddenThreadItemProjection;

const agentMessageItemSchema = z.object({
  type: z.literal("agentMessage"),
  id: z.string(),
  text: z.string(),
  phase: z.enum(["commentary", "final_answer"]).nullable().default(null),
});
const commandItemSchema = z.object({
  type: z.literal("commandExecution"),
  id: z.string(),
  command: z.string(),
  cwd: z.string(),
  processId: stringOrNull.default(null),
  status: commandStatusSchema,
  aggregatedOutput: stringOrNull.default(null),
  exitCode: finiteNumber.int().nullable().default(null),
  durationMs: finiteNumber.nonnegative().nullable().default(null),
});
const fileItemSchema = z.object({
  type: z.literal("fileChange"),
  id: z.string(),
  changes: z.array(fileChangeSchema),
  status: patchStatusSchema,
});
const hookPromptFragmentSchema = z.object({ text: z.string() });
const byteRangeSchema = z.object({
  start: nonNegativeInteger,
  end: nonNegativeInteger,
});
const textElementSchema = z.object({
  byteRange: byteRangeSchema,
  placeholder: stringOrNull.default(null),
});
const imageDetailSchema = z.enum(["auto", "low", "high", "original"]);
const textUserInputSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  text_elements: z.array(textElementSchema).default([]),
});
const imageUserInputSchema = z.object({
  type: z.literal("image"),
  detail: imageDetailSchema.nullable().default(null),
  url: z.string(),
});
const localImageUserInputSchema = z.object({
  type: z.literal("localImage"),
  detail: imageDetailSchema.nullable().default(null),
  path: z.string(),
});
const skillUserInputSchema = z.object({
  type: z.literal("skill"),
  name: z.string(),
  path: z.string(),
});
const mentionUserInputSchema = z.object({
  type: z.literal("mention"),
  name: z.string(),
  path: z.string(),
});
const userMessageContentSchema = z.unknown().transform((value) => {
  assertReviewedJson(value);
  if (!isPlainObject(value) || typeof value["type"] !== "string") {
    throw new TypeError("malformed user message content");
  }
  switch (value["type"]) {
    case "text": return textUserInputSchema.parse(value);
    case "image": return imageUserInputSchema.parse(value);
    case "localImage": return localImageUserInputSchema.parse(value);
    case "skill": return skillUserInputSchema.parse(value);
    case "mention": return mentionUserInputSchema.parse(value);
    default:
      // Future variants are bounded above, then discarded with the hidden item.
      return Object.freeze({ type: value["type"] });
  }
});
const unconsumedItemSchemas = Object.freeze({
  userMessage: z.object({
    type: z.literal("userMessage"),
    id: z.string(),
    clientId: stringOrNull.default(null),
    content: z.array(userMessageContentSchema),
  }),
  hookPrompt: z.object({ type: z.literal("hookPrompt"), id: z.string(), fragments: z.array(hookPromptFragmentSchema) }),
  plan: z.object({ type: z.literal("plan"), id: z.string(), text: z.string() }),
  reasoning: z.object({ type: z.literal("reasoning"), id: z.string(), summary: z.array(z.string()).default([]), content: z.array(z.string()).default([]) }),
  mcpToolCall: z.object({ type: z.literal("mcpToolCall"), id: z.string(), server: z.string(), tool: z.string(), status: z.string(), arguments: reviewedJsonSchema }),
  collabAgentToolCall: z.object({ type: z.literal("collabAgentToolCall"), id: z.string(), senderThreadId: z.string(), receiverThreadIds: z.array(z.string()) }),
  webSearch: z.object({ type: z.literal("webSearch"), id: z.string(), query: z.string() }),
  imageView: z.object({ type: z.literal("imageView"), id: z.string(), path: z.string() }),
  imageGeneration: z.object({ type: z.literal("imageGeneration"), id: z.string(), status: z.string(), result: z.string() }),
  enteredReviewMode: z.object({ type: z.literal("enteredReviewMode"), id: z.string(), review: z.string() }),
  exitedReviewMode: z.object({ type: z.literal("exitedReviewMode"), id: z.string(), review: z.string() }),
  contextCompaction: z.object({ type: z.literal("contextCompaction"), id: z.string() }),
  dynamicToolCall: z.object({ type: z.literal("dynamicToolCall"), id: z.string() }),
});

export function decodeThreadItem(value: unknown): ThreadItemProjection {
  if (!isPlainObject(value) || typeof value["type"] !== "string") {
    throw new TypeError("malformed thread item");
  }
  switch (value["type"]) {
    case "agentMessage": return agentMessageItemSchema.parse(value);
    case "commandExecution": return commandItemSchema.parse(value);
    case "fileChange": return fileItemSchema.parse(value);
    case "dynamicToolCall": unconsumedItemSchemas.dynamicToolCall.parse(value); return hiddenUnconsumed;
    case "userMessage": unconsumedItemSchemas.userMessage.parse(value); return hiddenUnconsumed;
    case "hookPrompt": unconsumedItemSchemas.hookPrompt.parse(value); return hiddenUnconsumed;
    case "plan": unconsumedItemSchemas.plan.parse(value); return hiddenUnconsumed;
    case "reasoning": unconsumedItemSchemas.reasoning.parse(value); return hiddenUnconsumed;
    case "mcpToolCall": unconsumedItemSchemas.mcpToolCall.parse(value); return hiddenUnconsumed;
    case "collabAgentToolCall": unconsumedItemSchemas.collabAgentToolCall.parse(value); return hiddenUnconsumed;
    case "webSearch": unconsumedItemSchemas.webSearch.parse(value); return hiddenUnconsumed;
    case "imageView": unconsumedItemSchemas.imageView.parse(value); return hiddenUnconsumed;
    case "imageGeneration": unconsumedItemSchemas.imageGeneration.parse(value); return hiddenUnconsumed;
    case "enteredReviewMode": unconsumedItemSchemas.enteredReviewMode.parse(value); return hiddenUnconsumed;
    case "exitedReviewMode": unconsumedItemSchemas.exitedReviewMode.parse(value); return hiddenUnconsumed;
    case "contextCompaction": unconsumedItemSchemas.contextCompaction.parse(value); return hiddenUnconsumed;
    default: return hiddenUnknown;
  }
}

const threadItemSchema: z.ZodType<ThreadItemProjection> =
  z.unknown().transform(decodeThreadItem);
const turnSchema = z.object({
  id: z.string(),
  items: z.array(threadItemSchema),
  itemsView: z.enum(["notLoaded", "summary", "full"]).default("full"),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  error: turnErrorSchema.nullable().default(null),
  startedAt: finiteNumber.nullable().default(null),
  completedAt: finiteNumber.nullable().default(null),
  durationMs: finiteNumber.nonnegative().nullable().default(null),
});
const threadSchema = z.object({
  id: z.string(),
  status: threadStatusSchema,
  turns: z.array(turnSchema),
});
const modelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
});
const accountSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("apiKey") }),
  z.object({ type: z.literal("amazonBedrock") }),
  z.object({ type: z.literal("chatgpt"), email: z.string().nullable(), planType: planTypeSchema }),
]);
const rateWindowSchema = z.object({
  usedPercent: finiteNumber.min(0).max(100),
  windowDurationMins: finiteNumber.nonnegative().nullable().default(null),
  resetsAt: finiteNumber.nullable().default(null),
});
const creditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: stringOrNull.default(null),
});
const spendLimitSchema = z.object({
  limit: z.string(),
  used: z.string(),
  remainingPercent: finiteNumber.min(0).max(100),
  resetsAt: finiteNumber,
});
const reachedTypeSchema = z.enum([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);
const rateLimitSchema = z.object({
  limitId: stringOrNull.default(null),
  limitName: stringOrNull.default(null),
  primary: rateWindowSchema.nullable().default(null),
  secondary: rateWindowSchema.nullable().default(null),
  credits: creditsSchema.nullable().default(null),
  individualLimit: spendLimitSchema.nullable().default(null),
  planType: planTypeSchema.nullable().default(null),
  rateLimitReachedType: reachedTypeSchema.nullable().default(null),
});
const integerWireSchema = z.union([
  nonNegativeInteger,
  z.string().regex(/^\d+$/).max(32),
]);
const usageSummarySchema = z.object({
  lifetimeTokens: integerWireSchema.nullable().default(null),
  peakDailyTokens: integerWireSchema.nullable().default(null),
  longestRunningTurnSec: integerWireSchema.nullable().default(null),
  currentStreakDays: integerWireSchema.nullable().default(null),
  longestStreakDays: integerWireSchema.nullable().default(null),
});
const usageBucketSchema = z.object({
  startDate: z.string(),
  tokens: integerWireSchema,
});

type ClientRequestSchemas = {
  [M in ReviewedClientMethod]: z.ZodType<ClientRequestParamsMap[M]>
};
export const CLIENT_REQUEST_SCHEMAS: Readonly<ClientRequestSchemas> = Object.freeze({
  initialize: z.object({
    clientName: z.string().min(1),
    clientTitle: z.string().min(1),
    clientVersion: z.string().min(1),
    experimentalApi: z.boolean(),
    requestAttestation: z.boolean().optional(),
  }),
  "thread/start": z.object({
    model: stringOrNull.optional(),
    cwd: stringOrNull.optional(),
    approvalPolicy: z.enum(["untrusted", "on-failure", "on-request", "never"]).nullable().optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullable().optional(),
    permissions: stringOrNull.optional(),
  }),
  "thread/resume": z.object({
    threadId: z.string(), model: stringOrNull.optional(), cwd: stringOrNull.optional(),
    excludeTurns: z.boolean().optional(),
  }),
  "thread/read": z.object({ threadId: z.string(), includeTurns: z.boolean().optional() }),
  "thread/archive": z.object({ threadId: z.string() }),
  "thread/list": z.object({
    cursor: stringOrNull.optional(),
    limit: finiteNumber.int().positive().max(1_000).nullable().optional(),
    archived: z.boolean().nullable().optional(),
    searchTerm: stringOrNull.optional(),
  }),
  "thread/unarchive": z.object({ threadId: z.string() }),
  "turn/start": z.object({
    threadId: z.string(), text: z.string(), clientUserMessageId: stringOrNull.optional(),
    cwd: stringOrNull.optional(),
    approvalPolicy: z.enum(["untrusted", "on-failure", "on-request", "never"]).nullable().optional(),
    permissions: stringOrNull.optional(), model: stringOrNull.optional(),
    collaborationMode: z.enum(["work", "plan"]),
    collaborationModePreset: collaborationModePresetSchema,
    selectedThreadModel: z.string().min(1).max(512),
  }).superRefine((value, context) => {
    const expected = value.collaborationMode === "work" ? "default" : "plan";
    if (value.collaborationModePreset.mode !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collaborationModePreset", "mode"],
        message: "collaboration preset does not match the requested mode",
      });
    }
  }),
  "turn/interrupt": z.object({ threadId: z.string(), turnId: z.string() }),
  "turn/steer": z.object({
    threadId: z.string(), text: z.string(), expectedTurnId: z.string(),
    clientUserMessageId: stringOrNull.optional(),
  }),
  "collaborationMode/list": z.undefined(),
  "model/list": z.object({
    cursor: stringOrNull.optional(),
    limit: finiteNumber.int().positive().max(1_000).nullable().optional(),
    includeHidden: z.boolean().nullable().optional(),
  }),
  "account/login/start": z.discriminatedUnion("type", [
    z.object({ type: z.literal("apiKey"), apiKey: z.string().min(1) }),
    z.object({ type: z.literal("chatgpt"), streamlined: z.boolean().optional() }),
    z.object({ type: z.literal("chatgptDeviceCode") }),
  ]),
  "account/login/cancel": z.object({ loginId: z.string() }),
  "account/logout": z.undefined(),
  "account/read": z.object({ refreshToken: z.boolean().optional() }),
  "account/rateLimits/read": z.undefined(),
  "account/usage/read": z.undefined(),
  getAuthStatus: z.object({ refreshToken: z.boolean().optional() }),
});

type ResponseSchemas = { [M in ReviewedClientMethod]: z.ZodType<ClientResponseMap[M]> };
export const CLIENT_RESPONSE_SCHEMAS: Readonly<ResponseSchemas> = Object.freeze({
  initialize: z.object({ userAgent: z.string(), codexHome: z.string(), platformFamily: z.string(), platformOs: z.string() }),
  "thread/start": z.object({ thread: threadSchema, model: z.string(), cwd: z.string() }),
  "thread/resume": z.object({ thread: threadSchema, model: z.string(), cwd: z.string() }),
  "thread/read": z.object({ thread: threadSchema }),
  "thread/archive": emptySchema,
  "thread/list": z.object({
    data: z.array(threadSchema),
    nextCursor: stringOrNull.default(null),
    backwardsCursor: stringOrNull.default(null),
  }),
  "thread/unarchive": z.object({ thread: threadSchema }),
  "turn/start": z.object({ turn: turnSchema }),
  "turn/interrupt": emptySchema,
  "turn/steer": z.object({ turnId: z.string().optional() }),
  "collaborationMode/list": z.object({
    data: z.array(collaborationModePresetWireSchema).max(8),
  }).superRefine((value, context) => {
    const modes = value.data
      .map((preset) => preset.mode)
      .filter((mode): mode is "default" | "plan" => mode !== null);
    if (new Set(modes).size !== modes.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: "collaboration mode presets must not duplicate a mode",
      });
    }
  }),
  "model/list": z.object({
    data: z.array(modelSchema),
    nextCursor: stringOrNull.default(null),
  }),
  "account/login/start": z.discriminatedUnion("type", [
    z.object({ type: z.literal("apiKey") }),
    z.object({ type: z.literal("chatgpt"), loginId: z.string(), authUrl: z.string().url() }),
    z.object({ type: z.literal("chatgptDeviceCode"), loginId: z.string().optional(), verificationUrl: z.string().url(), userCode: z.string() }),
    z.object({ type: z.literal("chatgptAuthTokens") }),
  ]),
  "account/login/cancel": z.object({ status: z.enum(["notFound", "canceled"]) }),
  "account/logout": emptySchema,
  "account/read": z.object({ account: accountSchema.nullable().default(null), requiresOpenaiAuth: z.boolean() }),
  "account/rateLimits/read": z.object({ rateLimits: rateLimitSchema, rateLimitsByLimitId: z.record(z.string(), rateLimitSchema).nullable().default(null) }),
  "account/usage/read": z.object({ summary: usageSummarySchema, dailyUsageBuckets: z.array(usageBucketSchema).max(366).nullable().default(null) }),
  getAuthStatus: z.object({ authMethod: authModeSchema.nullable(), requiresOpenaiAuth: z.boolean().nullable() }),
});

const legacyApprovalBase = {
  conversationId: z.string(),
  callId: z.string(),
};
const approvalBase = {
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  startedAtMs: finiteNumber.nonnegative().optional(),
  reason: stringOrNull.optional(),
};
const fileSystemSpecialPathExactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root") }),
  z.object({ kind: z.literal("minimal") }),
  z.object({ kind: z.literal("tmpdir") }),
  z.object({ kind: z.literal("slash_tmp") }),
  z.object({ kind: z.literal("project_roots"), subpath: stringOrNull }),
  z.object({ kind: z.literal("unknown"), path: z.string(), subpath: stringOrNull }),
]);
const fileSystemPathExactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: z.string() }),
  z.object({ type: z.literal("glob_pattern"), pattern: z.string() }),
  z.object({ type: z.literal("special"), value: fileSystemSpecialPathExactSchema }),
]);
const fileSystemSandboxEntryExactSchema = z.object({
  path: fileSystemPathExactSchema,
  access: z.enum(["read", "write", "deny"]),
});
// The generated entry/path union is deliberately opaque to the compatibility
// manifest: it is validated exactly here, while only its named parent field is
// structurally admitted. This avoids treating invented inline object names as
// upstream protocol components.
const fileSystemSandboxEntrySchema = z.custom<z.infer<typeof fileSystemSandboxEntryExactSchema>>(
  (value) => fileSystemSandboxEntryExactSchema.safeParse(value).success,
).transform((value) => fileSystemSandboxEntryExactSchema.parse(value));
const fileSystemPermissionsSchema = z.object({
  read: z.array(z.string()).nullable().default(null),
  write: z.array(z.string()).nullable().default(null),
  globScanMaxDepth: nonNegativeInteger.min(1).nullable().optional(),
  entries: z.array(fileSystemSandboxEntrySchema).nullable().optional(),
});
const networkPermissionsSchema = z.object({
  enabled: z.boolean().nullable().default(null),
});
const permissionsSchema = z.object({
  network: networkPermissionsSchema.nullable().default(null),
  fileSystem: fileSystemPermissionsSchema.nullable().default(null),
});
const baseDecisionSchema = z.enum(["accept", "acceptForSession", "decline", "cancel"]);
const networkPolicyAmendmentExactSchema = z.object({
  host: z.string(),
  action: z.enum(["allow", "deny"]),
});
const networkPolicyAmendmentSchema = z.custom<z.infer<typeof networkPolicyAmendmentExactSchema>>(
  (value) => networkPolicyAmendmentExactSchema.safeParse(value).success,
).transform((value) => networkPolicyAmendmentExactSchema.parse(value));
const commandDecisionExactSchema = z.union([
  baseDecisionSchema,
  z.object({
    acceptWithExecpolicyAmendment: z.object({
      execpolicy_amendment: z.array(z.string()),
    }),
  }),
  z.object({
    applyNetworkPolicyAmendment: z.object({
      network_policy_amendment: networkPolicyAmendmentSchema,
    }),
  }),
]);
const commandDecisionSchema = z.custom<z.infer<typeof commandDecisionExactSchema>>(
  (value) => commandDecisionExactSchema.safeParse(value).success,
).transform((value) => commandDecisionExactSchema.parse(value));
const commandActionExactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read"), command: z.string(), name: z.string(), path: z.string() }),
  z.object({ type: z.literal("listFiles"), command: z.string(), path: stringOrNull }),
  z.object({ type: z.literal("search"), command: z.string(), query: stringOrNull, path: stringOrNull }),
  z.object({ type: z.literal("unknown"), command: z.string() }),
]);
const commandActionSchema = z.custom<z.infer<typeof commandActionExactSchema>>(
  (value) => commandActionExactSchema.safeParse(value).success,
).transform((value) => commandActionExactSchema.parse(value));
const networkApprovalContextExactSchema = z.object({
  host: z.string(),
  protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
});
const networkApprovalContextSchema = z.custom<z.infer<typeof networkApprovalContextExactSchema>>(
  (value) => networkApprovalContextExactSchema.safeParse(value).success,
).transform((value) => networkApprovalContextExactSchema.parse(value));
const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
});
const questionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(questionOptionSchema).nullable(),
});
// The protocol response is a map keyed by question id, so duplicates would be
// unanswerable without silently overwriting one answer.
const questionsSchema = z.array(questionSchema).superRefine((questions, context) => {
  const seen = new Set<string>();
  questions.forEach((question, index) => {
    if (seen.has(question.id)) {
      context.addIssue({
        code: "custom",
        message: "request_user_input question ids must be unique",
        path: [index, "id"],
      });
      return;
    }
    seen.add(question.id);
  });
});

type RequestSchemas = { [M in EnabledServerRequestMethod]: z.ZodType<ServerRequestParamsMap[M]> };
export const SERVER_REQUEST_SCHEMAS: Readonly<RequestSchemas> = Object.freeze({
  applyPatchApproval: z.object({
    ...legacyApprovalBase,
    reason: stringOrNull.default(null),
    grantRoot: stringOrNull.default(null),
  }),
  execCommandApproval: z.object({
    ...legacyApprovalBase,
    approvalId: stringOrNull.default(null),
    command: z.array(z.string()),
    cwd: z.string(),
    reason: stringOrNull.default(null),
  }),
  "item/commandExecution/requestApproval": z.object({
    ...approvalBase,
    approvalId: stringOrNull.optional(),
    command: stringOrNull.optional(),
    cwd: stringOrNull.optional(),
    networkApprovalContext: networkApprovalContextSchema.nullable().optional(),
    commandActions: z.array(commandActionSchema).nullable().optional(),
    proposedExecpolicyAmendment: z.array(z.string()).nullable().optional(),
    proposedNetworkPolicyAmendments: z.array(networkPolicyAmendmentSchema).nullable().optional(),
    availableDecisions: z.array(commandDecisionSchema).nullable().optional(),
    additionalPermissions: permissionsSchema.nullable().optional(),
  }),
  "item/fileChange/requestApproval": z.object({
    ...approvalBase,
    grantRoot: stringOrNull.optional(),
  }),
  "item/permissions/requestApproval": z.object({
    ...approvalBase,
    environmentId: stringOrNull.default(null),
    cwd: z.string(),
    permissions: permissionsSchema,
  }),
  "item/tool/requestUserInput": z.object({
    threadId: z.string(), turnId: z.string(), itemId: z.string(),
    questions: questionsSchema,
  }).passthrough().transform((value) =>
    z.object({
      threadId: z.string(), turnId: z.string(), itemId: z.string(),
      // The wire field is optional under serde defaults; preserve compatibility
      // with releases that omit it while using it when present.
      autoResolutionMs: nonNegativeInteger.nullable().optional(),
      questions: questionsSchema,
    }).parse(value),
  ),
});

const legacyDecisionSchema = z.enum([
  "approved", "approved_for_session", "denied", "timed_out", "abort",
]);
const grantedPermissionsSchema = z.object({
  network: networkPermissionsSchema.optional(),
  fileSystem: fileSystemPermissionsSchema.optional(),
});
const userInputAnswerSchema = z.object({
  answers: z.array(z.string()).max(1_024),
});
type ServerResponseSchemas = {
  [M in EnabledServerRequestMethod]: z.ZodType<ServerRequestResponseMap[M]>
};
export const SERVER_REQUEST_RESPONSE_SCHEMAS:
Readonly<ServerResponseSchemas> = Object.freeze({
  applyPatchApproval: z.object({ decision: legacyDecisionSchema }),
  execCommandApproval: z.object({ decision: legacyDecisionSchema }),
  "item/commandExecution/requestApproval": z.object({ decision: commandDecisionSchema }),
  "item/fileChange/requestApproval": z.object({ decision: baseDecisionSchema }),
  "item/permissions/requestApproval": z.object({
    permissions: grantedPermissionsSchema,
    scope: z.enum(["turn", "session"]),
    strictAutoReview: z.boolean().optional(),
  }),
  "item/tool/requestUserInput": z.object({
    answers: z.record(
      z.string(),
      userInputAnswerSchema,
    ),
  }),
});

const itemDeltaSchema = z.object({
  threadId: z.string(), turnId: z.string(), itemId: z.string(), delta: z.string(),
});
const itemLifecycleBase = {
  item: threadItemSchema,
  threadId: z.string(),
  turnId: z.string(),
};
const threadTokenUsageSchema = z.object({
  modelContextWindow: finiteNumber.nonnegative().nullable().default(null),
});
type NotificationSchemas = {
  [M in EnabledServerNotificationMethod]: z.ZodType<ServerNotificationParamsMap[M]>
};
export const SERVER_NOTIFICATION_SCHEMAS: Readonly<NotificationSchemas> = Object.freeze({
  "account/login/completed": z.object({
    loginId: stringOrNull.default(null),
    success: z.boolean(),
    error: stringOrNull.default(null),
  }),
  "account/rateLimits/updated": z.object({ rateLimits: rateLimitSchema }),
  "account/updated": z.object({ authMode: authModeSchema.nullable().default(null), planType: planTypeSchema.nullable().default(null) }),
  "item/agentMessage/delta": itemDeltaSchema,
  "item/commandExecution/outputDelta": itemDeltaSchema,
  "item/commandExecution/terminalInteraction": z.object({
    threadId: z.string(), turnId: z.string(), itemId: z.string(),
    processId: z.string(), stdin: z.string(),
  }),
  "item/completed": z.object({ ...itemLifecycleBase, completedAtMs: finiteNumber.nonnegative() }),
  "item/fileChange/outputDelta": itemDeltaSchema,
  "item/fileChange/patchUpdated": z.object({
    threadId: z.string(), turnId: z.string(), itemId: z.string(),
    changes: z.array(fileChangeSchema),
  }),
  "item/started": z.object({ ...itemLifecycleBase, startedAtMs: finiteNumber.nonnegative() }),
  "serverRequest/resolved": z.object({ threadId: z.string(), requestId: z.union([z.string(), finiteNumber]) }),
  "thread/closed": z.object({ threadId: z.string() }),
  "thread/started": z.object({ thread: threadSchema }),
  "thread/status/changed": z.object({ threadId: z.string(), status: threadStatusSchema }),
  "thread/tokenUsage/updated": z.object({
    threadId: z.string(), turnId: z.string(),
    tokenUsage: threadTokenUsageSchema,
  }),
  "turn/completed": z.object({ threadId: z.string(), turn: turnSchema }),
  "turn/diff/updated": z.object({ threadId: z.string(), turnId: z.string(), diff: z.string() }),
  "turn/started": z.object({ threadId: z.string(), turn: turnSchema }),
});

export const COMPATIBILITY_PROJECTION_SCHEMAS:
Readonly<Record<string, z.ZodType>> = Object.freeze({
  InitializeResponse: CLIENT_RESPONSE_SCHEMAS.initialize,
  ThreadStartResponse: CLIENT_RESPONSE_SCHEMAS["thread/start"],
  ThreadResumeResponse: CLIENT_RESPONSE_SCHEMAS["thread/resume"],
  ThreadReadResponse: CLIENT_RESPONSE_SCHEMAS["thread/read"],
  ThreadListResponse: CLIENT_RESPONSE_SCHEMAS["thread/list"],
  ThreadUnarchiveResponse: CLIENT_RESPONSE_SCHEMAS["thread/unarchive"],
  TurnStartResponse: CLIENT_RESPONSE_SCHEMAS["turn/start"],
  TurnSteerResponse: CLIENT_RESPONSE_SCHEMAS["turn/steer"],
  CollaborationModeListResponse: CLIENT_RESPONSE_SCHEMAS["collaborationMode/list"],
  CollaborationModeMask: collaborationModePresetWireSchema,
  ModelListResponse: CLIENT_RESPONSE_SCHEMAS["model/list"],
  "ApiKeyv2::LoginAccountResponse|Chatgptv2::LoginAccountResponse|ChatgptDeviceCodev2::LoginAccountResponse|ChatgptAuthTokensv2::LoginAccountResponse":
    CLIENT_RESPONSE_SCHEMAS["account/login/start"],
  CancelLoginAccountResponse: CLIENT_RESPONSE_SCHEMAS["account/login/cancel"],
  GetAccountResponse: CLIENT_RESPONSE_SCHEMAS["account/read"],
  GetAccountRateLimitsResponse: CLIENT_RESPONSE_SCHEMAS["account/rateLimits/read"],
  GetAccountTokenUsageResponse: CLIENT_RESPONSE_SCHEMAS["account/usage/read"],
  "NotLoadedThreadStatus|IdleThreadStatus|SystemErrorThreadStatus|ActiveThreadStatus":
    threadStatusSchema,
  FileUpdateChange: fileChangeSchema,
  "AddPatchChangeKind|DeletePatchChangeKind|UpdatePatchChangeKind":
    fileChangeKindSchema,
  TurnError: turnErrorSchema,
  AgentMessageThreadItem: agentMessageItemSchema,
  CommandExecutionThreadItem: commandItemSchema,
  FileChangeThreadItem: fileItemSchema,
  Turn: turnSchema,
  Thread: threadSchema,
  Model: modelSchema,
  "ApiKeyAccount|ChatgptAccount|AmazonBedrockAccount": accountSchema,
  RateLimitWindow: rateWindowSchema,
  CreditsSnapshot: creditsSchema,
  SpendControlLimitSnapshot: spendLimitSchema,
  RateLimitSnapshot: rateLimitSchema,
  AccountTokenUsageSummary: usageSummarySchema,
  AccountTokenUsageDailyBucket: usageBucketSchema,
  ThreadTokenUsage: threadTokenUsageSchema,
  "AdditionalPermissionProfile|RequestPermissionProfile": permissionsSchema,
  AdditionalNetworkPermissions: networkPermissionsSchema,
  AdditionalFileSystemPermissions: fileSystemPermissionsSchema,
  GrantedPermissionProfile: grantedPermissionsSchema,
  ToolRequestUserInputQuestion: questionSchema,
  ToolRequestUserInputOption: questionOptionSchema,
  ToolRequestUserInputAnswer: userInputAnswerSchema,
  UserMessageThreadItem: unconsumedItemSchemas.userMessage,
  TextUserInput: textUserInputSchema,
  ImageUserInput: imageUserInputSchema,
  LocalImageUserInput: localImageUserInputSchema,
  SkillUserInput: skillUserInputSchema,
  MentionUserInput: mentionUserInputSchema,
  TextElement: textElementSchema,
  ByteRange: byteRangeSchema,
  HookPromptThreadItem: unconsumedItemSchemas.hookPrompt,
  HookPromptFragment: hookPromptFragmentSchema,
  PlanThreadItem: unconsumedItemSchemas.plan,
  ReasoningThreadItem: unconsumedItemSchemas.reasoning,
  McpToolCallThreadItem: unconsumedItemSchemas.mcpToolCall,
  CollabAgentToolCallThreadItem: unconsumedItemSchemas.collabAgentToolCall,
  WebSearchThreadItem: unconsumedItemSchemas.webSearch,
  ImageViewThreadItem: unconsumedItemSchemas.imageView,
  ImageGenerationThreadItem: unconsumedItemSchemas.imageGeneration,
  EnteredReviewModeThreadItem: unconsumedItemSchemas.enteredReviewMode,
  ExitedReviewModeThreadItem: unconsumedItemSchemas.exitedReviewMode,
  ContextCompactionThreadItem: unconsumedItemSchemas.contextCompaction,
  ApplyPatchApprovalParams: SERVER_REQUEST_SCHEMAS.applyPatchApproval,
  ExecCommandApprovalParams: SERVER_REQUEST_SCHEMAS.execCommandApproval,
  CommandExecutionRequestApprovalParams:
    SERVER_REQUEST_SCHEMAS["item/commandExecution/requestApproval"],
  FileChangeRequestApprovalParams:
    SERVER_REQUEST_SCHEMAS["item/fileChange/requestApproval"],
  PermissionsRequestApprovalParams:
    SERVER_REQUEST_SCHEMAS["item/permissions/requestApproval"],
  ToolRequestUserInputParams:
    SERVER_REQUEST_SCHEMAS["item/tool/requestUserInput"],
  ApplyPatchApprovalResponse: SERVER_REQUEST_RESPONSE_SCHEMAS.applyPatchApproval,
  ExecCommandApprovalResponse: SERVER_REQUEST_RESPONSE_SCHEMAS.execCommandApproval,
  CommandExecutionRequestApprovalResponse:
    SERVER_REQUEST_RESPONSE_SCHEMAS["item/commandExecution/requestApproval"],
  FileChangeRequestApprovalResponse:
    SERVER_REQUEST_RESPONSE_SCHEMAS["item/fileChange/requestApproval"],
  PermissionsRequestApprovalResponse:
    SERVER_REQUEST_RESPONSE_SCHEMAS["item/permissions/requestApproval"],
  ToolRequestUserInputResponse:
    SERVER_REQUEST_RESPONSE_SCHEMAS["item/tool/requestUserInput"],
  AccountLoginCompletedNotification:
    SERVER_NOTIFICATION_SCHEMAS["account/login/completed"],
  AccountRateLimitsUpdatedNotification:
    SERVER_NOTIFICATION_SCHEMAS["account/rateLimits/updated"],
  AccountUpdatedNotification: SERVER_NOTIFICATION_SCHEMAS["account/updated"],
  AgentMessageDeltaNotification:
    SERVER_NOTIFICATION_SCHEMAS["item/agentMessage/delta"],
  CommandExecutionOutputDeltaNotification:
    SERVER_NOTIFICATION_SCHEMAS["item/commandExecution/outputDelta"],
  TerminalInteractionNotification:
    SERVER_NOTIFICATION_SCHEMAS["item/commandExecution/terminalInteraction"],
  ItemCompletedNotification: SERVER_NOTIFICATION_SCHEMAS["item/completed"],
  FileChangeOutputDeltaNotification:
    SERVER_NOTIFICATION_SCHEMAS["item/fileChange/outputDelta"],
  FileChangePatchUpdatedNotification:
    SERVER_NOTIFICATION_SCHEMAS["item/fileChange/patchUpdated"],
  ItemStartedNotification: SERVER_NOTIFICATION_SCHEMAS["item/started"],
  ServerRequestResolvedNotification:
    SERVER_NOTIFICATION_SCHEMAS["serverRequest/resolved"],
  ThreadClosedNotification: SERVER_NOTIFICATION_SCHEMAS["thread/closed"],
  ThreadStartedNotification: SERVER_NOTIFICATION_SCHEMAS["thread/started"],
  ThreadStatusChangedNotification:
    SERVER_NOTIFICATION_SCHEMAS["thread/status/changed"],
  ThreadTokenUsageUpdatedNotification:
    SERVER_NOTIFICATION_SCHEMAS["thread/tokenUsage/updated"],
  TurnCompletedNotification: SERVER_NOTIFICATION_SCHEMAS["turn/completed"],
  TurnDiffUpdatedNotification: SERVER_NOTIFICATION_SCHEMAS["turn/diff/updated"],
  TurnStartedNotification: SERVER_NOTIFICATION_SCHEMAS["turn/started"],
});

const errorSchema: z.ZodType<RpcDecodedError> =
  z.object({ code: finiteNumber.int(), message: z.string() });
function parseMapped<M extends PropertyKey, T extends Record<M, unknown>, K extends M>(
  schemas: { readonly [P in M]: z.ZodType<T[P]> },
  method: K,
  value: unknown,
): T[K] {
  return schemas[method].parse(value);
}

export function buildClientWireParams<M extends ReviewedClientMethod>(
  method: M,
  value: ClientRequestParamsMap[M],
): unknown {
  try {
    const semantic = parseMapped<ReviewedClientMethod, ClientRequestParamsMap, M>(
      CLIENT_REQUEST_SCHEMAS,
      method,
      value,
    );
    return buildUncheckedClientWireParams(method, semantic);
  } catch {
    throw new CodexRpcError("invalid_frame");
  }
}

export const rpcRuntimeDecoder: RpcRuntimeDecoder = Object.freeze({
  decodeError(value: unknown): RpcDecodedError {
    return errorSchema.parse(value);
  },
  decodeClientResponse<M extends ReviewedClientMethod>(
    method: M,
    value: unknown,
  ): ClientResponseMap[M] {
    return parseMapped<ReviewedClientMethod, ClientResponseMap, M>(
      CLIENT_RESPONSE_SCHEMAS, method, value,
    );
  },
  decodeServerRequest<M extends EnabledServerRequestMethod>(
    method: M,
    value: unknown,
  ): ServerRequestParamsMap[M] {
    return parseMapped<EnabledServerRequestMethod, ServerRequestParamsMap, M>(
      SERVER_REQUEST_SCHEMAS, method, value,
    );
  },
  decodeServerRequestResponse<M extends EnabledServerRequestMethod>(
    method: M,
    value: unknown,
  ): ServerRequestResponseMap[M] {
    return parseMapped<
      EnabledServerRequestMethod,
      ServerRequestResponseMap,
      M
    >(SERVER_REQUEST_RESPONSE_SCHEMAS, method, value);
  },
  decodeServerNotification<M extends EnabledServerNotificationMethod>(
    method: M,
    value: unknown,
  ): ServerNotificationParamsMap[M] {
    return parseMapped<EnabledServerNotificationMethod, ServerNotificationParamsMap, M>(
      SERVER_NOTIFICATION_SCHEMAS, method, value,
    );
  },
});
