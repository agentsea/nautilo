import { z } from "zod";

/** Ephemeral owner-only approval detail; never a safety verdict or transcript. */
export const claudePermissionDetailSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("shown"), text: z.string().min(1).refine((text) => !/[\p{Cs}\p{Cc}\p{Cf}]/u.test(text.replace(/[\t\r\n]/g, ""))) }).strict(),
  z.object({ state: z.literal("withheld"), reason: z.enum(["sensitive", "unsupported", "invalid", "frame_limit", "incompatible"]) }).strict(),
]);
export type ClaudePermissionDetail = z.infer<typeof claudePermissionDetailSchema>;

/** Browser-safe, user-scoped Claude Connections projection. */
export const claudeConnectionApiProviderSchema = z.enum([
  "firstParty", "bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle", "gateway",
]);

export const claudeConnectionRuntimeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), version: z.string().min(1).max(320), executionQualified: z.boolean() }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
  z.object({ state: z.literal("incompatible"), version: z.string().min(1).max(320).optional() }).strict(),
  z.object({ state: z.literal("failure"), version: z.string().min(1).max(320).optional() }).strict(),
]);

export const claudeConnectionAccountSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("connected"),
    email: z.string().min(1).max(320).optional(),
    organization: z.string().min(1).max(320).optional(),
    subscriptionType: z.string().min(1).max(320).optional(),
    /** Presence-only credential fact; raw source strings never enter durable or browser state. */
    credentialsAvailable: z.literal(true).optional(),
    apiProvider: claudeConnectionApiProviderSchema.optional(),
  }).strict().refine((account) => account.email !== undefined || account.organization !== undefined || account.subscriptionType !== undefined || account.credentialsAvailable === true || account.apiProvider !== undefined),
  z.object({ state: z.literal("disconnected") }).strict(),
  z.object({ state: z.literal("unavailable") }).strict(),
]);

export const claudeConnectionModelSchema = z.object({
  id: z.string().min(1).max(320),
  resolvedModel: z.string().min(1).max(320).optional(),
  displayName: z.string().min(1).max(320),
  description: z.string().min(1).max(320),
  supportedEffortLevels: z.array(z.enum(["low", "medium", "high", "xhigh", "max"])).max(5).optional(),
  supportsEffort: z.boolean().optional(),
  supportsAdaptiveThinking: z.boolean().optional(),
  supportsFastMode: z.boolean().optional(),
  supportsAutoMode: z.boolean().optional(),
}).strict();
const claudeConnectionModelsSchema = z.array(claudeConnectionModelSchema)
  .refine((models) => new Set(models.map((model) => model.id)).size === models.length, "model ids must be unique");

export const claudeConnectionCatalogSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("complete"), complete: z.literal(true), models: claudeConnectionModelsSchema }).strict(),
  z.object({ state: z.literal("incomplete"), complete: z.literal(false), models: claudeConnectionModelsSchema }).strict(),
  z.object({ state: z.literal("unavailable"), complete: z.literal(false), models: z.array(z.never()).length(0) }).strict(),
]);

export const claudeConnectionStateSchema = z.enum(["disabled", "reconnecting", "connected", "unavailable"]);

export const claudeConnectionSummarySchema = z.object({
  enabled: z.boolean(),
  selectedModel: z.string().min(1).max(320).nullable(),
  /** A retained preference becomes admitted only by a fresh complete catalog. */
  selectedModelAdmitted: z.boolean(),
  runtime: claudeConnectionRuntimeSchema,
  account: claudeConnectionAccountSchema,
  catalog: claudeConnectionCatalogSchema,
  connectionState: claudeConnectionStateSchema,
  observedAt: z.iso.datetime().nullable(),
  observationStale: z.boolean(),
}).strict().superRefine((summary, context) => {
  if ((summary.connectionState === "disabled") !== !summary.enabled) context.addIssue({ code: "custom", message: "disabled state must exactly match disabled preference" });
  if (!summary.observationStale && summary.observedAt === null) context.addIssue({ code: "custom", message: "fresh observation requires timestamp" });
  if (summary.connectionState === "connected" && (summary.observationStale || !summary.enabled || summary.runtime.state !== "ready" || !summary.runtime.executionQualified || summary.account.state !== "connected")) context.addIssue({ code: "custom", message: "connected state requires enabled fresh execution-qualified truth" });
  if (!summary.enabled && summary.connectionState === "reconnecting") context.addIssue({ code: "custom", message: "disabled preference cannot reconnect" });
  if (summary.selectedModelAdmitted && (
    summary.selectedModel === null || summary.observationStale || summary.runtime.state !== "ready" || !summary.runtime.executionQualified ||
    summary.account.state !== "connected" || summary.catalog.state !== "complete" ||
    !summary.catalog.models.some((model) => (model.resolvedModel ?? model.id) === summary.selectedModel)
  )) context.addIssue({ code: "custom", message: "admitted model requires fresh complete usable catalog truth" });
});

export const claudeConnectionToggleSchema = z.object({ enabled: z.boolean() }).strict();
export const claudeConnectionSelectModelSchema = z.object({ modelId: z.string().min(1).max(320).nullable() }).strict();
export const claudeConnectionCheckSchema = z.object({}).strict();

export type ClaudeConnectionAccount = z.infer<typeof claudeConnectionAccountSchema>;
export type ClaudeConnectionCatalog = z.infer<typeof claudeConnectionCatalogSchema>;
export type ClaudeConnectionModel = z.infer<typeof claudeConnectionModelSchema>;
export type ClaudeConnectionRuntime = z.infer<typeof claudeConnectionRuntimeSchema>;
export type ClaudeConnectionSummary = z.infer<typeof claudeConnectionSummarySchema>;
