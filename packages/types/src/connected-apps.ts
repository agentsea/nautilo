import { z } from "zod";
import { TOOL_CATEGORIES } from "./tool-catalog";

export const CONNECTION_PROVIDER_CATALOG_SIGNING_DOMAIN_V1 =
  "nautilo-connection-provider-catalog-v1";

export const ConnectionProviderCatalogPointerSchema = z.object({
  catalogVersion: z.string().regex(/^\d{4}\.\d{2}\.\d{2}\.\d+$/u),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  signature: z.string().min(1),
  signingKeyId: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/u),
}).strict();
export type ConnectionProviderCatalogPointer = z.infer<typeof ConnectionProviderCatalogPointerSchema>;

export const ConnectedAppProviderIdSchema = z.string()
  .regex(/^[a-z][a-z0-9_-]*$/u)
  .min(1);
export type ConnectedAppProviderId = z.infer<typeof ConnectedAppProviderIdSchema>;

export const ConnectedAppLifecycleSchema = z.enum([
  "pilot",
  "available",
  "disabled",
  "withdrawn",
]);
export type ConnectedAppLifecycle = z.infer<typeof ConnectedAppLifecycleSchema>;

const ConnectedAppJsonSchemaDocumentSchema = z.record(z.string(), z.unknown())
  .refine((value) => value["type"] !== undefined || value["anyOf"] !== undefined || value["oneOf"] !== undefined, {
    message: "tool schema must declare type, anyOf, or oneOf",
  });

const ConnectedAppJsonPointerSchema = z.string()
  .regex(/^\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*$/u);

const ConnectedAppReconciliationInputValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("output_pointer"), pointer: ConnectedAppJsonPointerSchema }).strict(),
]);

export const ConnectedAppReconciliationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("exact_field"),
    followupOperationId: z.string().min(1),
    followupInput: z.record(z.string().min(1), ConnectedAppReconciliationInputValueSchema),
    sourcePointer: ConnectedAppJsonPointerSchema,
    followupPointer: ConnectedAppJsonPointerSchema,
  }).strict(),
  z.object({
    kind: z.literal("collection_contains"),
    followupOperationId: z.string().min(1),
    followupInput: z.record(z.string().min(1), ConnectedAppReconciliationInputValueSchema),
    sourcePointer: ConnectedAppJsonPointerSchema,
    collectionPointer: ConnectedAppJsonPointerSchema,
    itemPointer: ConnectedAppJsonPointerSchema,
  }).strict(),
]);
export type ConnectedAppReconciliation = z.infer<typeof ConnectedAppReconciliationSchema>;

const ConnectedAppAsyncLifecycleSchema = z.object({
  startActionId: z.string().min(1),
  statusActionId: z.string().min(1),
  statusInput: z.record(z.string().min(1), ConnectedAppJsonPointerSchema),
}).strict();

const ConnectedAppPresentationHostSchema = z.string()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);

const ConnectedAppPresentationUrlFieldSchema = z.object({
  pointer: ConnectedAppJsonPointerSchema,
  allowedHosts: z.array(ConnectedAppPresentationHostSchema).min(1),
}).strict();

/**
 * Signed, declarative result mapping. It may select already-schema-validated
 * fields, but it cannot name a renderer, provide markup, or execute code.
 */
export const ConnectedAppResultPresentationContractSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entity"),
    titlePointer: ConnectedAppJsonPointerSchema,
    fallbackTitle: z.string().min(1),
    subtitlePointer: ConnectedAppJsonPointerSchema.optional(),
    image: ConnectedAppPresentationUrlFieldSchema.extend({
      alt: z.string().min(1),
      widthPointer: ConnectedAppJsonPointerSchema.optional(),
      heightPointer: ConnectedAppJsonPointerSchema.optional(),
    }).strict().optional(),
    links: z.array(ConnectedAppPresentationUrlFieldSchema.extend({
      label: z.string().min(1),
    }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("artifact_import"),
    identityPointer: ConnectedAppJsonPointerSchema,
    statusPointer: ConnectedAppJsonPointerSchema,
    readyValue: z.string().min(1),
    failedValue: z.string().min(1),
    urlsPointer: ConnectedAppJsonPointerSchema,
    allowedHosts: z.array(ConnectedAppPresentationHostSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal("transit_artifact_import"),
    filePointer: ConnectedAppJsonPointerSchema,
    fileIdPointer: ConnectedAppJsonPointerSchema,
    namePointer: ConnectedAppJsonPointerSchema,
    mimeTypePointer: ConnectedAppJsonPointerSchema,
    sizeBytesPointer: ConnectedAppJsonPointerSchema,
  }).strict(),
]);
export type ConnectedAppResultPresentationContract = z.infer<typeof ConnectedAppResultPresentationContractSchema>;

export const ConnectedAppArtifactInputContractSchema = z.object({
  kind: z.literal("workspace_artifact_to_transit_file"),
  modelField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
  providerField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
}).strict();
export type ConnectedAppArtifactInputContract = z.infer<typeof ConnectedAppArtifactInputContractSchema>;

export const ConnectedAppOperationContractSchema = z.object({
  toolName: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  sourceActionId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)),
  category: z.enum(TOOL_CATEGORIES),
  discoveryCategories: z.array(z.enum(TOOL_CATEGORIES)),
  impact: z.enum(["read-only", "low", "high", "destructive"]),
  effect: z.enum(["read", "write"]),
  requiresApproval: z.boolean(),
  approvalLevel: z.enum(["prove_it", "confirm", "standing"]).optional(),
  sourceSchemaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceInputSchema: ConnectedAppJsonSchemaDocumentSchema.optional(),
  inputSchema: ConnectedAppJsonSchemaDocumentSchema,
  outputSchema: ConnectedAppJsonSchemaDocumentSchema,
  inputRules: z.array(z.object({
    kind: z.literal("mutually_exclusive"),
    fields: z.array(z.string().min(1)).min(2),
  }).strict()).optional(),
  reconciliation: ConnectedAppReconciliationSchema.optional(),
  asyncLifecycle: ConnectedAppAsyncLifecycleSchema.optional(),
  resultPresentation: ConnectedAppResultPresentationContractSchema.optional(),
  artifactInput: ConnectedAppArtifactInputContractSchema.optional(),
}).strict().superRefine((operation, context) => {
  if (new Set(operation.discoveryCategories).size !== operation.discoveryCategories.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "discovery categories must be distinct" });
  }
  if (operation.discoveryCategories.includes(operation.category)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "primary category must not be repeated in discovery categories" });
  }
  if (operation.artifactInput) {
    const properties = operation.inputSchema["properties"];
    const sourceProperties = operation.sourceInputSchema?.["properties"];
    const required = operation.inputSchema["required"];
    if (!operation.sourceInputSchema) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact input requires the exact sourceInputSchema" });
    }
    if (!properties || typeof properties !== "object" || Array.isArray(properties)
      || !(operation.artifactInput.modelField in properties)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact input modelField must exist in inputSchema properties" });
    }
    if (!Array.isArray(required) || !required.includes(operation.artifactInput.modelField)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact input modelField must be required" });
    }
    if (operation.artifactInput.modelField === operation.artifactInput.providerField
      || (properties && typeof properties === "object" && !Array.isArray(properties)
        && operation.artifactInput.providerField in properties)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact input providerField must remain model-hidden" });
    }
    if (!sourceProperties || typeof sourceProperties !== "object" || Array.isArray(sourceProperties)
      || !(operation.artifactInput.providerField in sourceProperties)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact input providerField must exist in sourceInputSchema properties" });
    }
    if (sourceProperties && typeof sourceProperties === "object" && !Array.isArray(sourceProperties)
      && operation.artifactInput.modelField in sourceProperties) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "artifact input modelField must not alter the reviewed source schema" });
    }
  } else if (operation.sourceInputSchema) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sourceInputSchema requires an artifact input transformation" });
  }
  if (operation.effect === "read") {
    if (operation.impact !== "read-only" || operation.requiresApproval || operation.approvalLevel !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "read operations must be read-only and omit approvalLevel" });
    }
    return;
  }
  if (!operation.requiresApproval || !operation.approvalLevel || operation.approvalLevel === "standing") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "write operations require explicit confirm or prove_it approval" });
  }
  if (operation.impact === "read-only") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "write operations cannot have read-only impact" });
  }
  if (operation.impact === "destructive" && operation.approvalLevel !== "prove_it") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "destructive operations require prove_it approval" });
  }
});
export type ConnectedAppOperationContract = z.infer<typeof ConnectedAppOperationContractSchema>;

export const ConnectionProviderDescriptorSchema = z.object({
  id: ConnectedAppProviderIdSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
  searchTerms: z.array(z.string().min(1)),
  iconUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === "https://media.nautilo.ai"
      && url.pathname.startsWith("/connections/icons/") && !url.search && !url.hash;
  }, { message: "icon URL must use the immutable Nautilo connection-icon lane" }).nullable(),
  shortMark: z.string().min(1).max(3),
  sortOrder: z.number().int(),
  lifecycle: ConnectedAppLifecycleSchema,
  defaultEnabled: z.boolean(),
  service: z.string().min(1),
  supportedDrivers: z.array(z.enum(["oomol_hosted", "openconnector_local", "nautilo_native"])).min(1),
  setup: z.object({
    kind: z.literal("oauth_client"),
    providerSetupUrl: z.string().url(),
    scopes: z.array(z.string().min(1)),
    acceptsAdminToken: z.boolean(),
  }).strict(),
  operations: z.array(ConnectedAppOperationContractSchema),
}).strict();
export type ConnectionProviderDescriptor = z.infer<typeof ConnectionProviderDescriptorSchema>;

export const ConnectionProviderCatalogSchema = z.object({
  version: z.literal(2),
  catalogVersion: z.string().regex(/^\d{4}\.\d{2}\.\d{2}\.\d+$/u),
  publishedAt: z.string().datetime({ offset: true }),
  oauthClientMetadata: z.object({
    url: z.literal("https://media.nautilo.ai/connections/oauth-client.json"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  providers: z.array(ConnectionProviderDescriptorSchema).superRefine((providers, context) => {
    if (new Set(providers.map((provider) => provider.id)).size !== providers.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "provider ids must be unique" });
    }
    const toolNames = providers.flatMap((provider) => provider.operations.map((operation) => operation.toolName));
    if (new Set(toolNames).size !== toolNames.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "tool names must be unique" });
    }
    const actionIds = providers.flatMap((provider) => provider.operations.map((operation) => operation.sourceActionId));
    if (new Set(actionIds).size !== actionIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "source action ids must be unique" });
    }
    for (const provider of providers) {
      const providerActionIds = new Set(provider.operations.map((operation) => operation.sourceActionId));
      for (const operation of provider.operations) {
        const followup = operation.reconciliation?.followupOperationId;
        if (followup && !providerActionIds.has(followup)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `reconciliation target ${followup} is not in provider ${provider.id}`,
          });
        }
        const lifecycle = operation.asyncLifecycle;
        if (lifecycle && (
          lifecycle.startActionId !== operation.sourceActionId
          || !providerActionIds.has(lifecycle.statusActionId)
        )) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `async lifecycle actions must be admitted by provider ${provider.id}`,
          });
        }
      }
    }
  }),
}).strict();
export type ConnectionProviderCatalog = z.infer<typeof ConnectionProviderCatalogSchema>;

export function canonicalConnectionProviderCatalogSigningPayloadV1(
  catalogVersion: string,
  artifactSha256: string,
): string {
  return `${CONNECTION_PROVIDER_CATALOG_SIGNING_DOMAIN_V1}\n` +
    `catalogVersion=${catalogVersion}\n` +
    `artifactSha256=${artifactSha256}\n`;
}

export const ConnectedAppDriverKindSchema = z.enum([
  "oomol_hosted",
  "openconnector_local",
  "nautilo_native",
]);
export type ConnectedAppDriverKind = z.infer<typeof ConnectedAppDriverKindSchema>;

export const ConnectedAppStatusSchema = z.enum([
  "not_connected",
  "connecting",
  "connected",
  "reconnect_required",
  "error",
]);
export type ConnectedAppStatus = z.infer<typeof ConnectedAppStatusSchema>;

export const ConnectedAppProviderSetupStatusSchema = z.enum([
  "managed",
  "setup_required",
  "ready",
  "error",
]);
export type ConnectedAppProviderSetupStatus = z.infer<typeof ConnectedAppProviderSetupStatusSchema>;

export const ConnectedAppCapabilitySchema = z.object({
  operationId: z.string().min(1),
  label: z.string().min(1),
  effect: z.enum(["read", "write"]),
  requiresApproval: z.boolean(),
}).strict();
export type ConnectedAppCapability = z.infer<typeof ConnectedAppCapabilitySchema>;

export const ConnectedAppAccountSchema = z.object({
  displayName: z.string().min(1).nullable(),
  username: z.string().min(1).nullable(),
  email: z.string().email().nullable(),
  avatarUrl: z.string().url().nullable(),
  workspaceName: z.string().min(1).nullable(),
  kind: z.enum(["user", "bot", "service_account", "unknown"]),
}).strict();
export type ConnectedAppAccount = z.infer<typeof ConnectedAppAccountSchema>;

export const ConnectedAppDescriptorSchema = z.object({
  id: ConnectedAppProviderIdSchema,
  displayName: z.string().min(1),
  description: z.string().min(1),
  searchTerms: z.array(z.string().min(1)),
  iconUrl: z.string().url().nullable(),
  shortMark: z.string().min(1).max(3),
  sortOrder: z.number().int(),
  lifecycle: ConnectedAppLifecycleSchema,
  providerSetupUrl: z.string().url(),
  acceptsAdminToken: z.boolean(),
  experimental: z.boolean(),
  defaultEnabled: z.boolean(),
  driverKind: ConnectedAppDriverKindSchema,
  providerReady: z.boolean(),
  providerSetupStatus: ConnectedAppProviderSetupStatusSchema,
  canManageProviderSetup: z.boolean(),
  status: ConnectedAppStatusSchema,
  attemptId: z.string().uuid().nullable(),
  account: ConnectedAppAccountSchema.nullable(),
  capabilities: z.array(ConnectedAppCapabilitySchema),
  custodyLabel: z.string().min(1),
  limitation: z.string().min(1).nullable(),
  lastErrorCode: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative().nullable(),
}).strict();
export type ConnectedAppDescriptor = z.infer<typeof ConnectedAppDescriptorSchema>;

export const ConnectedAppsResponseSchema = z.object({
  status: z.literal("ok"),
  /** Exact Room whose Namespace owns the returned personal connection state. */
  scopeRoomId: z.string().uuid(),
  apps: z.array(ConnectedAppDescriptorSchema),
}).strict();
export type ConnectedAppsResponse = z.infer<typeof ConnectedAppsResponseSchema>;

export const ConnectedAppProviderSetupSchema = z.object({
  providerId: ConnectedAppProviderIdSchema,
  driverKind: z.literal("openconnector_local"),
  status: z.enum(["setup_required", "ready", "error"]),
  callbackUrl: z.string().url(),
  /** OAuth scopes are catalog policy, not a secret; expose them for setup. */
  oauthScopes: z.array(z.string().min(1)),
  clientId: z.string().min(1).nullable(),
  adminAuthenticationConfigured: z.boolean(),
  lastErrorCode: z.string().min(1).nullable(),
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type ConnectedAppProviderSetup = z.infer<typeof ConnectedAppProviderSetupSchema>;

export const ConnectedAppProviderSetupRequestSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  adminToken: z.string().min(1).optional(),
}).strict().refine(
  (value) => (value.clientId === undefined) === (value.clientSecret === undefined),
  { message: "clientId and clientSecret must be supplied together" },
);
export type ConnectedAppProviderSetupRequest = z.infer<typeof ConnectedAppProviderSetupRequestSchema>;

export const ConnectedAppDisconnectResponseSchema = z.object({
  status: z.literal("disconnected"),
  providerId: ConnectedAppProviderIdSchema,
}).strict();
export type ConnectedAppDisconnectResponse = z.infer<typeof ConnectedAppDisconnectResponseSchema>;

export const ConnectedAppOAuthStartResponseSchema = z.object({
  status: z.literal("authorization_required"),
  providerId: ConnectedAppProviderIdSchema,
  attemptId: z.string().uuid(),
  authorizationUrl: z.string().url().refine((value) => value.startsWith("https://")),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type ConnectedAppOAuthStartResponse = z.infer<typeof ConnectedAppOAuthStartResponseSchema>;

export const ConnectedAppOAuthAttemptResponseSchema = z.object({
  status: z.enum(["connecting", "connected", "failed", "expired"]),
  providerId: ConnectedAppProviderIdSchema,
  account: ConnectedAppAccountSchema.nullable(),
  errorCode: z.string().min(1).nullable(),
}).strict();
export type ConnectedAppOAuthAttemptResponse = z.infer<typeof ConnectedAppOAuthAttemptResponseSchema>;

export const ConnectedAppToolReceiptSchema = z.object({
  providerId: ConnectedAppProviderIdSchema,
  operationId: z.string().min(1),
  executionId: z.string().min(1),
  profileId: z.string().uuid(),
  effect: z.enum(["read", "write"]),
  reconciliation: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("confirmed"),
      operationId: z.string().min(1),
      executionId: z.string().min(1),
      errorCode: z.null(),
    }).strict(),
    z.object({
      status: z.literal("unconfirmed"),
      operationId: z.string().min(1),
      executionId: z.null(),
      errorCode: z.string().min(1),
    }).strict(),
  ]).nullable(),
  presentation: z.discriminatedUnion("kind", [
    z.object({
      version: z.literal(1),
      kind: z.literal("entity"),
      title: z.string().min(1),
      subtitle: z.string().min(1).nullable(),
      preview: z.object({
        ref: z.string().regex(/^[A-Za-z0-9_-]+$/u),
        alt: z.string().min(1),
        width: z.number().int().positive().nullable(),
        height: z.number().int().positive().nullable(),
      }).strict().nullable(),
      links: z.array(z.object({
        label: z.string().min(1),
        url: z.string().url().refine((value) => value.startsWith("https://")),
      }).strict()),
    }).strict(),
    z.object({
      version: z.literal(1),
      kind: z.literal("artifact_import"),
      status: z.string().min(1),
      state: z.enum(["pending", "ready", "failed", "partial", "import_failed"]),
      artifacts: z.array(z.object({
        artifactId: z.string().min(1),
        path: z.string().min(1),
        mime: z.string().min(1),
        bytes: z.number().int().nonnegative(),
      }).strict()),
      errorCode: z.string().min(1).nullable(),
    }).strict(),
  ]).optional(),
  result: z.unknown(),
}).strict();
export type ConnectedAppToolReceipt = z.infer<typeof ConnectedAppToolReceiptSchema>;
