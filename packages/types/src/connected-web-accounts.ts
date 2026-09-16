import { z } from "zod";

/** Browser-safe lifecycle states. Provider coordinates never belong in this contract. */
export const connectedWebAccountStatusSchema = z.enum([
  "connecting",
  "connected",
  "busy",
  "attention_needed",
  "expired",
  "revoked",
  "provider_unavailable",
  "error",
]);
export type ConnectedWebAccountStatus = z.infer<typeof connectedWebAccountStatusSchema>;

export const connectedWebAccountIdSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime({ offset: true });
const serviceSchema = z.string().trim().min(1).max(128);
const originSchema = z.string().url().max(2_048);
const labelSchema = z.string().trim().min(1).max(256);

/**
 * The only projection a Human-facing route may return. In particular it has
 * no profile, browser, run, live-view, CDP, or provider execution field.
 */
export const connectedWebAccountSchema = z.object({
  id: connectedWebAccountIdSchema,
  service: serviceSchema,
  origin: originSchema,
  label: labelSchema,
  status: connectedWebAccountStatusSchema,
  lastVerifiedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
}).strict();
export type ConnectedWebAccount = z.infer<typeof connectedWebAccountSchema>;

/**
 * Safe feature readiness for the authenticated owner. It discloses no key
 * value, provider account, workspace, browser, or credential metadata.
 */
export const connectedWebAccountProviderSetupStatusSchema = z.enum([
  "ready",
  "api_key_required",
  "api_key_invalid",
]);
export type ConnectedWebAccountProviderSetupStatus = z.infer<typeof connectedWebAccountProviderSetupStatusSchema>;

export const connectedWebAccountListResponseSchema = z.object({
  accounts: z.array(connectedWebAccountSchema),
  providerSetupStatus: connectedWebAccountProviderSetupStatusSchema,
}).strict();
export type ConnectedWebAccountListResponse = z.infer<typeof connectedWebAccountListResponseSchema>;

/** Pending creation is metadata-only until the server-side provider creates a profile. */
export const connectedWebAccountCreateRequestSchema = z.object({
  service: serviceSchema,
  origin: originSchema,
  label: labelSchema,
  /** Existing account by default; only an explicit Human action creates another profile. */
  createAnother: z.boolean().default(false),
}).strict();
export type ConnectedWebAccountCreateRequest = z.infer<typeof connectedWebAccountCreateRequestSchema>;

/** A short-lived owner-only capability for the foreground sign-in window. */
export const connectedWebAccountLoginSchema = z.object({
  liveViewUrl: z.string().url(),
  expiresAt: isoTimestampSchema,
}).strict();
export type ConnectedWebAccountLogin = z.infer<typeof connectedWebAccountLoginSchema>;

export const connectedWebAccountLoginResponseSchema = z.object({
  account: connectedWebAccountSchema,
  login: connectedWebAccountLoginSchema,
  /** Lets Cancel discard a never-finished new profile without revoking a reconnect. */
  createdNewAccount: z.boolean(),
}).strict();
export type ConnectedWebAccountLoginResponse = z.infer<typeof connectedWebAccountLoginResponseSchema>;

/** The Browser can request completion; server-side provider verification selects the state. */
export const connectedWebAccountFinishRequestSchema = z.object({}).strict();
export type ConnectedWebAccountFinishRequest = z.infer<typeof connectedWebAccountFinishRequestSchema>;

export const connectedWebAccountReconnectRequestSchema = z.object({}).strict();
export type ConnectedWebAccountReconnectRequest = z.infer<typeof connectedWebAccountReconnectRequestSchema>;

/** Opens the saved, owner-only website profile at its durable connected origin. */
export const connectedWebAccountOpenPageRequestSchema = z.object({}).strict();
export type ConnectedWebAccountOpenPageRequest = z.infer<typeof connectedWebAccountOpenPageRequestSchema>;

/** Stops the active owner-only website page without revoking its saved profile. */
export const connectedWebAccountClosePageRequestSchema = z.object({}).strict();
export type ConnectedWebAccountClosePageRequest = z.infer<typeof connectedWebAccountClosePageRequestSchema>;

export const connectedWebAccountClosePageResponseSchema = z.object({
  account: connectedWebAccountSchema,
}).strict();
export type ConnectedWebAccountClosePageResponse = z.infer<typeof connectedWebAccountClosePageResponseSchema>;

export const connectedWebAccountCancelLoginRequestSchema = z.object({}).strict();
export type ConnectedWebAccountCancelLoginRequest = z.infer<typeof connectedWebAccountCancelLoginRequestSchema>;

export const connectedWebAccountCancelLoginResponseSchema = z.object({
  account: connectedWebAccountSchema,
}).strict();
export type ConnectedWebAccountCancelLoginResponse = z.infer<typeof connectedWebAccountCancelLoginResponseSchema>;

/** Strict Human-facing projection of one active hosted read. */
export const connectedWebAccountReadActivitySchema = z.object({
  accountId: connectedWebAccountIdSchema,
  stage: z.enum(["starting", "planning", "browsing", "saving", "finishing"]),
  canWatch: z.boolean(),
}).strict();
export type ConnectedWebAccountReadActivity = z.infer<typeof connectedWebAccountReadActivitySchema>;

/** Bearer capability returned only to the authenticated owner's local UI. */
export const connectedWebAccountReadWatchRequestSchema = z.object({}).strict();
export type ConnectedWebAccountReadWatchRequest = z.infer<typeof connectedWebAccountReadWatchRequestSchema>;

export const connectedWebAccountReadWatchSchema = z.object({
  liveViewUrl: z.string().url(),
}).strict();
export type ConnectedWebAccountReadWatch = z.infer<typeof connectedWebAccountReadWatchSchema>;

export const connectedWebAccountCancelReadRequestSchema = z.object({}).strict();
export type ConnectedWebAccountCancelReadRequest = z.infer<typeof connectedWebAccountCancelReadRequestSchema>;

export const connectedWebAccountCancelReadResponseSchema = z.object({
  account: connectedWebAccountSchema,
}).strict();
export type ConnectedWebAccountCancelReadResponse = z.infer<typeof connectedWebAccountCancelReadResponseSchema>;

/** Exact LangGraph tool delivery identity; never a provider run/session locator. */
export const connectedWebAccountActionDeliveryIdSchema = z.string().trim().min(1).max(256);
export type ConnectedWebAccountActionDeliveryId = z.infer<typeof connectedWebAccountActionDeliveryIdSchema>;

const connectedWebAccountActionTerminalSchema = z.enum([
  "completed", "ambiguous", "cancelled", "authentication_required", "failed",
]);

/** Strict, provider-free projection for one exact bounded action delivery. */
export const connectedWebAccountActionActivitySchema = z.object({
  deliveryId: connectedWebAccountActionDeliveryIdSchema,
  accountId: connectedWebAccountIdSchema,
  action: z.literal("save_item"),
  stage: z.enum(["starting", "planning", "browsing", "saving", "finishing"]),
  canWatch: z.boolean(),
  canStop: z.boolean(),
  terminal: connectedWebAccountActionTerminalSchema.nullable(),
}).strict();
export type ConnectedWebAccountActionActivity = z.infer<typeof connectedWebAccountActionActivitySchema>;

/** Provider-free lifecycle language shared by the Workbench and Genie tool contract. */
export const connectedWebOperationDriverSchema = z.enum(["hosted", "checking", "direct", "human"]);
export type ConnectedWebOperationDriver = z.infer<typeof connectedWebOperationDriverSchema>;

export const connectedWebOperationLifecycleSchema = z.enum(["admitted", "running", "attention", "terminal"]);
export type ConnectedWebOperationLifecycle = z.infer<typeof connectedWebOperationLifecycleSchema>;

/** Deliberately small status projection; provider/browser coordinates never appear here. */
export const connectedWebOperationSafeActivitySchema = z.object({
  phase: z.enum(["starting", "working", "checking", "attention", "finishing"]),
  code: z.string().trim().min(1).max(128),
  summary: z.string().trim().min(1).max(512),
}).strict();
export type ConnectedWebOperationSafeActivity = z.infer<typeof connectedWebOperationSafeActivitySchema>;

export const connectedWebOperationSafeReceiptSchema = z.object({
  outcome: z.enum(["completed", "cancelled", "failed", "attention_required", "ambiguous"]),
  code: z.string().trim().min(1).max(128),
  summary: z.string().trim().min(1).max(512),
}).strict();
export type ConnectedWebOperationSafeReceipt = z.infer<typeof connectedWebOperationSafeReceiptSchema>;

/** Exact owner-route identity for a durable supervised operation. */
export const connectedWebOperationIdSchema = z.string().uuid();
export type ConnectedWebOperationId = z.infer<typeof connectedWebOperationIdSchema>;

/** Provider-free terminal text result. This is the same safe completed-read shape used by the card. */
export const connectedWebOperationTerminalReadResultSchema = z.object({
  ok: z.literal(true),
  status: z.literal("completed"),
  account: z.object({
    id: connectedWebAccountIdSchema,
    label: labelSchema,
    service: serviceSchema,
    origin: originSchema,
  }).strict().nullable(),
  page: z.object({ ref: connectedWebAccountIdSchema, title: labelSchema, origin: originSchema }).strict(),
  read: z.object({
    answer: z.string().trim().min(1).max(8_000),
    facts: z.array(z.object({ label: z.string().trim().min(1).max(256), value: z.string().trim().min(1).max(1_024) }).strict()).max(32),
    completeness: z.enum(["complete", "partial", "unknown"]),
    provenance: z.enum(["authenticated_website", "user_connected_website", "public_website"]),
    origin: originSchema,
  }).strict().nullable(),
  cost: z.object({ currency: z.literal("USD"), amountUsd: z.number().finite().nonnegative().nullable(), state: z.enum(["actual", "unknown"]) }).strict(),
  outputs: z.array(z.never()).max(0),
  outputsTruncated: z.literal(false),
}).strict().superRefine((value, context) => {
  const origin = new URL(value.page.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== value.page.origin || origin.username || origin.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "terminal page must have an HTTP origin" });
  }
  if (value.account !== null && (value.page.ref !== value.account.id || value.page.title !== value.account.label || value.page.origin !== value.account.origin)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "terminal page must match account" });
  }
  if (value.read !== null && (value.read.origin !== value.page.origin || (value.read.provenance === "public_website") !== (value.account === null))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "terminal read origin must match account" });
  }
  if ((value.cost.state === "actual") !== (value.cost.amountUsd !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "terminal cost state must match amount" });
  }
});
export type ConnectedWebOperationTerminalReadResult = z.infer<typeof connectedWebOperationTerminalReadResultSchema>;

/** Action descriptions are provider reports, never reasoning or verified findings. */
export const connectedWebActivityEntrySchema = z.object({
  id: z.number().int().positive().safe(),
  occurredAt: z.string().datetime({ offset: true }),
  source: z.literal("browser_agent"),
  status: z.enum(["pending", "running", "completed", "error"]),
  summary: connectedWebOperationSafeActivitySchema.shape.summary.refine((text) =>
    !/\b(?:https?|wss?|cdp):\/\/|\b(?:passwords?|passcodes?|secrets?|cookies?|authorization|bearer|tokens?|credentials?|api[ _-]?keys?)\b|[\r\n]/iu.test(text)),
}).strict();
export const connectedWebActivityPageSchema = z.object({
  entries: z.array(connectedWebActivityEntrySchema),
  /** Local ledger cursor, not a provider event ID. Entries are oldest-first within each page. */
  before: z.number().int().positive().safe().nullable(),
  hasMore: z.boolean(),
}).strict();
export type ConnectedWebActivityPage = z.infer<typeof connectedWebActivityPageSchema>;

/** Strict owner-facing state: it intentionally excludes refs, intent, events, and capabilities. */
export const connectedWebOperationProjectionSchema = z.object({
  operationId: connectedWebOperationIdSchema,
  driver: connectedWebOperationDriverSchema,
  lifecycle: connectedWebOperationLifecycleSchema,
  controlEpoch: z.number().int().positive(),
  activity: connectedWebOperationSafeActivitySchema,
  receipt: connectedWebOperationSafeReceiptSchema.nullable(),
  canWatch: z.boolean(),
  canStop: z.boolean(),
  result: connectedWebOperationTerminalReadResultSchema.nullable(),
  activityLog: connectedWebActivityPageSchema.optional(),
}).strict();
export type ConnectedWebOperationProjection = z.infer<typeof connectedWebOperationProjectionSchema>;

export const connectedWebOperationWatchRequestSchema = z.object({}).strict();
export const connectedWebOperationWatchSchema = z.object({ liveViewUrl: z.string().url() }).strict();
export const connectedWebOperationStopRequestSchema = z.object({}).strict();
export const connectedWebOperationStopResponseSchema = z.object({ operation: connectedWebOperationProjectionSchema }).strict();

/** Public/durable-card identity only; no raw intent, action identity, or provider reference. */
export const connectedWebOperationActivitySchema = z.object({
  operationId: z.string().uuid(),
  accountId: connectedWebAccountIdSchema,
  driver: connectedWebOperationDriverSchema,
  lifecycle: connectedWebOperationLifecycleSchema,
  activity: connectedWebOperationSafeActivitySchema,
  canWatch: z.boolean(),
  canStop: z.boolean(),
  canTakeControl: z.boolean(),
  receipt: connectedWebOperationSafeReceiptSchema.nullable(),
}).strict();
export type ConnectedWebOperationActivity = z.infer<typeof connectedWebOperationActivitySchema>;

export const connectedWebAccountActionWatchRequestSchema = z.object({}).strict();
export type ConnectedWebAccountActionWatchRequest = z.infer<typeof connectedWebAccountActionWatchRequestSchema>;
export const connectedWebAccountActionWatchSchema = z.object({ liveViewUrl: z.string().url() }).strict();
export type ConnectedWebAccountActionWatch = z.infer<typeof connectedWebAccountActionWatchSchema>;
export const connectedWebAccountStopActionRequestSchema = z.object({}).strict();
export type ConnectedWebAccountStopActionRequest = z.infer<typeof connectedWebAccountStopActionRequestSchema>;
export const connectedWebAccountStopActionResponseSchema = z.object({
  activity: connectedWebAccountActionActivitySchema,
}).strict();
export type ConnectedWebAccountStopActionResponse = z.infer<typeof connectedWebAccountStopActionResponseSchema>;

export const connectedWebAccountDisconnectResponseSchema = z.object({
  account: connectedWebAccountSchema,
  websiteSessionWarning: z.literal(
    "Disconnecting Nautilo does not sign you out of the website. Use the website's sign out other sessions control if needed.",
  ),
}).strict();
export type ConnectedWebAccountDisconnectResponse = z.infer<typeof connectedWebAccountDisconnectResponseSchema>;

export const connectedWebAccountErrorCodeSchema = z.enum([
  "connected_web_account_not_found",
  "connected_web_account_conflict",
  "connected_web_account_provider_unavailable",
]);
export type ConnectedWebAccountErrorCode = z.infer<typeof connectedWebAccountErrorCodeSchema>;

/** Public Browser Use receipts carry a URL, never a saved profile identity. */
export const publicBrowserReadActiveSchema = z.object({
  ok: z.literal(true),
  status: z.literal("active"),
  target: z.object({ url: originSchema, origin: originSchema }).strict(),
  operation: connectedWebOperationProjectionSchema.omit({ canWatch: true, canStop: true }).extend({
    result: connectedWebOperationTerminalReadResultSchema.nullable().optional(),
  }),
}).strict().refine((value) => {
  const url = new URL(value.target.url);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.origin === value.target.origin;
}, "Public target must have a matching HTTP origin and no credentials");
export type PublicBrowserReadActive = z.infer<typeof publicBrowserReadActiveSchema>;
