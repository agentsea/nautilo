import { z } from "zod";
import { claudePermissionDetailSchema } from "./claude";

/**
 * Browser-safe Codex contracts. These schemas intentionally contain only
 * human-facing state: host/session authority, opaque home handles, workspace
 * receipts, provider thread ids, generations, and transport cursors stay on
 * the server.
 */
export const codexPostureSchema = z.enum([
  "codex_default",
  "prompted_workspace",
  "full_access_headless",
]);
export const codexAuthStateSchema = z.enum([
  "signed_out",
  "login_pending",
  "signed_in",
  "expired",
  "error",
]);
export const codexRegistrationStateSchema = z.enum(["provisional", "registered"]);
export const codexReconciliationStateSchema = z.enum(["current", "reconnecting", "cleanup_required"]);
export const codexFreshnessSchema = z.enum(["live", "cached", "stale"]);
export const codexBindingStateSchema = z.enum([
  "opening",
  "active",
  "queued",
  "awaiting_approval",
  "awaiting_input",
  "needs_rebind",
  "completed",
  "cancelled",
  "errored",
  "recovery_required",
  "archived",
]);

export const codexRateWindowSchema = z
  .object({
    usedPercent: z.number().min(0).max(100),
    windowDurationMins: z.number().int().nonnegative().nullable(),
    resetsAt: z.iso.datetime().nullable(),
  })
  .strict();

export const codexRateLimitsSchema = z
  .object({
    primary: codexRateWindowSchema.nullable(),
    secondary: codexRateWindowSchema.nullable(),
    plan: z
      .enum([
        "free",
        "go",
        "plus",
        "pro",
        "prolite",
        "team",
        "business",
        "enterprise",
        "edu",
        "usage_based",
        "unknown",
      ])
      .nullable(),
    credits: z
      .object({
        hasCredits: z.boolean(),
        unlimited: z.boolean(),
        balance: z.string().max(64).nullable(),
      })
      .strict()
      .nullable(),
    spendControl: z
      .object({
        limit: z.string().max(64),
        used: z.string().max(64),
        remainingPercent: z.number().min(0).max(100),
        resetsAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    reached: z
      .enum([
        "rate_limit_reached",
        "credits_depleted",
        "usage_limit_reached",
      ])
      .nullable(),
    observedAt: z.iso.datetime(),
    freshness: codexFreshnessSchema,
  })
  .strict();

export const codexUsageSchema = z
  .object({
    summary: z
      .object({
        lifetimeTokens: z.string().regex(/^\d{1,32}$/).nullable(),
        peakDailyTokens: z.string().regex(/^\d{1,32}$/).nullable(),
        longestRunningTurnSec: z.string().regex(/^\d{1,32}$/).nullable(),
        currentStreakDays: z.string().regex(/^\d{1,32}$/).nullable(),
        longestStreakDays: z.string().regex(/^\d{1,32}$/).nullable(),
      })
      .strict(),
    daily: z
      .array(
        z
          .object({
            startDate: z.iso.date(),
            tokens: z.string().regex(/^\d{1,32}$/),
          })
          .strict(),
      )
      .max(31),
    observedAt: z.iso.datetime(),
    freshness: codexFreshnessSchema,
  })
  .strict();

export const codexModelCatalogSchema = z.object({
  models: z.array(z.object({
    id: z.string().min(1).max(512),
    model: z.string().min(1).max(512),
    displayName: z.string().min(1).max(256),
    description: z.string().max(4_096),
    isDefault: z.boolean(),
  }).strict()).max(1_000),
  preferredModelId: z.string().min(1).max(512).nullable(),
}).strict();

export const codexProfileSchema = z
  .object({
    id: z.uuid(),
    label: z.string().min(1).max(120),
    /** Provider-reported display identity; never an auth token or local path. */
    accountEmail: z.string().min(3).max(320).nullable().optional(),
    authState: codexAuthStateSchema,
    registrationState: codexRegistrationStateSchema,
    reconciliationState: codexReconciliationStateSchema,
    planType: z.string().max(120).nullable(),
    rateLimits: codexRateLimitsSchema.nullable(),
    usage: codexUsageSchema.nullable(),
    usageObservedAt: z.iso.datetime().nullable(),
    lastErrorCode: z.string().max(96).nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const codexUserPreferenceSchema = z
  .object({
    enabled: z.boolean(),
    profileId: z.uuid().nullable(),
    posture: codexPostureSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => !value.enabled || value.profileId !== null, {
    message: "An enabled Codex preference requires a profile",
    path: ["profileId"],
  });

export const codexBindingSchema = z
  .object({
    id: z.uuid(),
    taskId: z.uuid(),
    roomId: z.uuid(),
    laneKey: z.string().min(1).max(512),
    bindingKind: z.literal("task"),
    state: codexBindingStateSchema,
    selectedModel: z.string().max(256).nullable(),
    posture: codexPostureSchema,
    revision: z.number().int().nonnegative(),
    archivedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.state === "archived") === (value.archivedAt !== null),
    {
      message: "Archived state and archivedAt must agree",
      path: ["archivedAt"],
    },
  );

export const codexRuntimeSummarySchema = z
  .object({
    state: z.enum([
      "absent",
      "installing",
      "ready",
      "limited",
      "incompatible",
      "draining",
      "failed",
      "unavailable",
    ]),
    available: z.boolean(),
    /** Opaque host generation used only for an explicit runtime activation. */
    runtimeGeneration: z.number().int().nonnegative().nullable(),
    source: z.enum(["external", "managed"]).optional(),
    version: z.string().max(128).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/).optional(),
    installation: z.object({
      phase: z.enum(["resolving", "downloading", "verifying", "staging", "activating", "ready", "cancelled", "failed"]),
      receivedBytes: z.number().int().safe().nonnegative(),
      totalBytes: z.number().int().safe().nonnegative(),
      canCancel: z.boolean(),
      code: z.enum(["CODEX_RUNTIME_NOT_FOUND", "CODEX_RUNTIME_NOT_EXECUTABLE", "CODEX_RUNTIME_WRONG_ARCHITECTURE", "CODEX_RUNTIME_UNHEALTHY", "CODEX_RUNTIME_TIMEOUT", "CODEX_RUNTIME_CANCELLED", "CODEX_RUNTIME_IDENTITY_CHANGED", "CODEX_RUNTIME_SCHEMA_INVALID", "CODEX_RUNTIME_INCOMPATIBLE", "CODEX_RUNTIME_STANDALONE_UNSUPPORTED", "CODEX_RUNTIME_VERSION_INVALID", "CODEX_RUNTIME_OUTPUT_LIMIT", "CODEX_RUNTIME_PATH_INVALID", "CODEX_RUNTIME_EXECUTABLE_LIMIT", "CODEX_RUNTIME_PLATFORM_UNSUPPORTED", "CODEX_RUNTIME_ARTIFACT_INVALID", "CODEX_RUNTIME_SIGNATURE_INVALID", "CODEX_RUNTIME_INSTALL_FAILED"]).optional(),
    }).strict().superRefine((value, context) => {
      if (value.receivedBytes > value.totalBytes) context.addIssue({ code: "custom", message: "receivedBytes cannot exceed totalBytes", path: ["receivedBytes"] });
      const cancellable = ["resolving", "downloading", "verifying", "staging"] as const;
      if (value.canCancel !== cancellable.includes(value.phase as typeof cancellable[number])) context.addIssue({ code: "custom", message: "canCancel must match the exact installer phase", path: ["canCancel"] });
      if ((value.phase === "failed" || value.phase === "cancelled") && value.code === undefined) context.addIssue({ code: "custom", message: "terminal failed/cancelled receipts require a stable code", path: ["code"] });
    }).optional(),
    compatibilityDiagnostics: z.array(z.object({
      feature: z.enum(["core", "steer", "approvals", "request_user_input", "collaboration_modes"]),
      reason: z.enum(["missing_member", "missing_field", "changed_field_shape"]),
    }).strict()).min(1).max(5).optional(),
    /**
     * The exact current desktop runtime advertises generated collaboration
     * modes. This is an availability projection only; the server samples the
     * same relay session again before it admits a Plan task.
     */
    collaborationModeAvailable: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "installing" && value.source !== "managed") context.addIssue({ code: "custom", message: "an installing runtime must be managed", path: ["source"] });
    const installation = value.installation;
    if (!installation) return;
    if (value.source !== "managed") context.addIssue({ code: "custom", message: "installation receipts require the managed runtime", path: ["source"] });
    const expectedState = installation.phase === "ready" ? "ready" : installation.phase === "failed" ? "failed" : installation.phase === "cancelled" ? "absent" : "installing";
    if (value.state !== expectedState) context.addIssue({ code: "custom", message: "runtime state must match the installation receipt", path: ["state"] });
  });

/** Connections-safe status only; no host path, auth URL, or home handle. */
export const codexConnectionSummarySchema = z.object({
  runtime: codexRuntimeSummarySchema,
  profiles: z.array(codexProfileSchema),
}).strict();
export const codexLoginStartSchema = z.object({ loginRef: z.string().min(1).max(512) }).strict();
export const codexProfileConnectSchema = z.object({
  profile: codexProfileSchema,
  loginRef: z.string().min(1).max(512),
}).strict();
export const codexAccountStatusSchema = z.object({
  authState: codexAuthStateSchema,
  profile: codexProfileSchema,
}).strict();
export const codexAccountLoginCancelSchema = z.union([
  codexAccountStatusSchema,
  z.object({ state: z.literal("profile_removed") }).strict(),
]);

/** Semantic owner-default mutations only; the server derives authority. */
export const codexUserPreferenceMutationSchema = z
  .object({
    profileId: z.uuid().nullable(),
    enabled: z.boolean(),
    posture: codexPostureSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => !value.enabled || value.profileId !== null, {
    message: "Enabling Codex requires a profile",
    path: ["profileId"],
  });
export const codexProfileRenameSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const codexBindingRequestSchema = z
  .object({
    selectedModel: z.string().min(1).max(256).nullable().optional(),
  })
  .strict();

/**
 * Browser-safe native Codex request. Host-local command text, filesystem
 * paths, relay/binding identity, and upstream JSON-RPC ids never cross this
 * boundary. The request id belongs to the envelope/event, not this payload.
 */
const codexApprovalDecisionSchema = z.enum([
  "approve",
  "approve_for_session",
  "deny",
  "cancel",
]);
const codexHostLocalDetailStateSchema = z.enum(["not_provided", "host_local_only"]);
const codexRequestReasonSchema = codexHostLocalDetailStateSchema;
const codexRequestOptionsSchema = z.array(codexApprovalDecisionSchema).min(1).max(4);

/** The sole request kind that has bounded durable recovery facts. */
export const codexUserInputRequestSchema = z.object({
  kind: z.literal("user_input_required"),
  // The relay accepts an empty question list and empty option arrays; the
  // browser contract preserves those decoded shapes exactly.
  questions: z.array(z.object({
    id: z.string().min(1).max(512),
    header: z.string().max(128),
    prompt: z.string().max(4_096),
    secret: z.boolean(),
    allowOther: z.boolean(),
    multiSelect: z.boolean().optional(),
    options: z.array(z.object({
      id: z.string().min(1).max(512),
      label: z.string().max(256),
      description: z.string().max(1_024).nullable(),
    }).strict()).max(4).nullable(),
  }).strict()).max(4),
  autoResolutionMs: z.number().int().nonnegative().max(300_000).nullable(),
}).strict();

/** Live-only local permission selection used by the Claude harness. */
export const codexPermissionSelectionRequestSchema = z.object({
  kind: z.literal("permission_selection_required"),
  detail: claudePermissionDetailSchema.optional(),
  options: z.array(z.object({
    id: z.string().min(1).max(512),
    label: z.string().max(256),
    semanticHint: z.string().max(256).nullable(),
  }).strict()).min(1).max(4),
  tool: z.object({
    title: z.string().max(320).nullable(),
    kind: z.string().max(320).nullable(),
  }).strict(),
}).strict();

/** Kept separate until the live Claude response route is composed in H2. */
export const codexPermissionSelectionResponseSchema = z.object({
  kind: z.literal("permission_selection_required"),
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("selected"), optionId: z.string().min(1).max(512) }).strict(),
    z.object({ kind: z.literal("cancelled") }).strict(),
  ]),
}).strict();

export const codexRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command_approval_required"),
    options: codexRequestOptionsSchema,
    reason: codexRequestReasonSchema,
    command: z.object({
      detail: codexHostLocalDetailStateSchema,
      actionKinds: z.array(z.enum(["read", "list_files", "search", "unknown"])).max(16),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("network_approval_required"),
    options: codexRequestOptionsSchema,
    reason: codexRequestReasonSchema,
    network: z.object({
      host: z.string().min(1).max(253),
      protocol: z.enum(["http", "https", "socks5Tcp", "socks5Udp"]),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("file_change_approval_required"),
    options: codexRequestOptionsSchema,
    reason: codexRequestReasonSchema,
    grantRoot: codexHostLocalDetailStateSchema,
  }).strict(),
  z.object({
    kind: z.literal("permissions_approval_required"),
    reason: codexRequestReasonSchema,
    permissions: z.object({
      network: z.object({ enabled: z.boolean().nullable() }).strict().nullable(),
      fileSystem: z.object({
        readPathCount: z.number().int().nonnegative().max(10_000),
        writePathCount: z.number().int().nonnegative().max(10_000),
        entryCount: z.number().int().nonnegative().max(10_000),
        pathDetail: codexHostLocalDetailStateSchema,
      }).strict().nullable(),
    }).strict(),
  }).strict(),
  codexPermissionSelectionRequestSchema,
  codexUserInputRequestSchema,
]);

/**
 * Browser response body for a native Codex request. `requestId` is derived
 * from the URL and `ownerId` from the authenticated session; neither can be
 * provided by the browser.
 */
export const codexRequestResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command_approval_required"),
    decision: codexApprovalDecisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("network_approval_required"),
    decision: codexApprovalDecisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("file_change_approval_required"),
    decision: codexApprovalDecisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("permissions_approval_required"),
    grants: z.object({ network: z.boolean(), fileSystem: z.boolean() }).strict(),
    scope: z.enum(["turn", "session"]),
  }).strict(),
  z.object({
    kind: z.literal("user_input_required"),
    answers: z.record(
      z.string().min(1).max(512),
      z.array(z.string().min(1).max(4_096)).min(1).max(5),
    ).refine((answers) => Object.keys(answers).length <= 4, {
      message: "At most four question answers are allowed",
    }).refine((answers) => new TextEncoder().encode(JSON.stringify(answers)).byteLength <= 16 * 1024, {
      message: "Answer payload exceeds 16 KiB",
    }),
  }).strict(),
]);

export const codexRequestResponseReceiptSchema = z
  .object({ requestId: z.string().min(1).max(512) })
  .strict();

/** Owner-private realtime payloads for the ephemeral native request handshake. */
export const codexRequestEventSchema = z.object({
  type: z.literal("codex.request"),
  ownerId: z.string().min(1).max(512),
  requestId: z.string().min(1).max(512),
  taskId: z.string().min(1).max(512),
  jobId: z.string().min(1).max(512),
  roomId: z.string().min(1).max(512),
  expiresAt: z.iso.datetime().nullable(),
  request: codexRequestSchema,
}).strict();
export const codexRequestResolvedEventSchema = z.object({
  type: z.literal("codex.request.resolved"),
  ownerId: z.string().min(1).max(512),
  requestId: z.string().min(1).max(512),
}).strict();

/**
 * Recovery read for the current Room. A live local broker closure yields an
 * actionable item; a newly lost closure yields one explicitly unavailable
 * item so the browser can explain the restart without rendering an answer
 * affordance. Terminal facts remain server-private.
 */
export const codexUserInputRequestEventSchema = z.object({
  type: z.literal("codex.request"),
  ownerId: z.string().min(1).max(512),
  requestId: z.string().min(1).max(512),
  taskId: z.string().min(1).max(512),
  jobId: z.string().min(1).max(512),
  roomId: z.string().min(1).max(512),
  // Recovery facts cannot be actioned without the one-shot expiry fence.
  expiresAt: z.iso.datetime(),
  request: codexUserInputRequestSchema,
}).strict();

export const codexRoomRequestListSchema = z.object({
  roomId: z.string().min(1).max(512),
  items: z.array(z.object({
    availability: z.enum(["actionable", "unavailable"]),
    event: codexUserInputRequestEventSchema,
  }).strict()).max(16),
}).strict();

export type CodexPosture = z.infer<typeof codexPostureSchema>;
export type CodexAuthState = z.infer<typeof codexAuthStateSchema>;
export type CodexBindingState = z.infer<typeof codexBindingStateSchema>;
export type CodexProfile = z.infer<typeof codexProfileSchema>;
export type CodexUserPreference = z.infer<typeof codexUserPreferenceSchema>;
export type CodexBinding = z.infer<typeof codexBindingSchema>;
export type CodexRuntimeSummary = z.infer<typeof codexRuntimeSummarySchema>;
export type CodexConnectionProfile = z.infer<typeof codexProfileSchema>;
export type CodexConnectionSummary = z.infer<typeof codexConnectionSummarySchema>;
export type CodexModelCatalog = z.infer<typeof codexModelCatalogSchema>;
export type CodexLoginStart = z.infer<typeof codexLoginStartSchema>;
export type CodexAccountStatus = z.infer<typeof codexAccountStatusSchema>;
export type CodexUserPreferenceMutation = z.infer<
  typeof codexUserPreferenceMutationSchema
>;
export type CodexRequest = z.infer<typeof codexRequestSchema>;
export type CodexUserInputRequest = z.infer<typeof codexUserInputRequestSchema>;
export type CodexRequestResponse =
  | z.infer<typeof codexRequestResponseSchema>
  | z.infer<typeof codexPermissionSelectionResponseSchema>;
export type CodexRequestResponseReceipt = z.infer<typeof codexRequestResponseReceiptSchema>;
export type CodexRequestEvent = z.infer<typeof codexRequestEventSchema>;
export type CodexRequestResolvedEvent = z.infer<typeof codexRequestResolvedEventSchema>;
export type CodexUserInputRequestEvent = z.infer<typeof codexUserInputRequestEventSchema>;
export type CodexRoomRequestList = z.infer<typeof codexRoomRequestListSchema>;
