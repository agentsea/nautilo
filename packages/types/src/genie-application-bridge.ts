/**
 * D513 — closed browser/server-safe contracts for semantic Genie guidance.
 *
 * This module deliberately contains no routes, selectors, client sessions,
 * persistence, or mutation authority. Channels resolve the semantic target
 * locally; the server remains authoritative for any domain operation.
 */
import { z } from "zod";
import {
  APPLICATION_CATALOGUE_TARGET_IDS_V1,
  GENERATED_APPLICATION_CATALOGUE_V1,
} from "./generated/application-catalogue-v1";

export const GENIE_APPLICATION_BRIDGE_VERSION_V1 = 1 as const;
/** Closed, product-declared client surface. It informs guidance only, never authority. */
export const initiatingClientSurfaceV1Schema = z.enum([
  "workbench.browser",
  "workbench.desktop",
  "mobile.native",
  "mobile.web",
  "unknown",
]);
export type InitiatingClientSurfaceV1 = z.infer<typeof initiatingClientSurfaceV1Schema>;

/** Old, malformed, or absent client declarations fail closed without rejecting auth. */
export function parseInitiatingClientSurfaceV1(value: unknown): InitiatingClientSurfaceV1 {
  return initiatingClientSurfaceV1Schema.safeParse(value).data ?? "unknown";
}
export const GUIDE_USER_QUERY_MAX_CHARS_V1 = 160;
export const GUIDE_USER_QUERY_MAX_UTF8_BYTES_V1 = 160;
export const GUIDE_USER_MAX_DISCOVERY_RESULTS_V1 = 5;
export const GENIE_HANDOFF_MAX_CONTEXT_ENTRIES_V1 = 8;
export const GENIE_HANDOFF_MAX_CONTEXT_UTF8_BYTES_V1 = 16 * 1024;
export const GENIE_RECOVERY_TEXT_MAX_CHARS_V1 = 512;
export const GENIE_RECOVERY_TEXT_MAX_UTF8_BYTES_V1 = 1_024;
/** One foreground binding attempt per accepted ordinary Human send. Enforced in Phase 3.2. */
export const CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE = 60;
/** Bindings are memory-only and expire after fifteen minutes. Enforced in Phase 3.2. */
export const CLIENT_ACTION_BINDING_TTL_MS = 15 * 60 * 1_000;
/** Derived from the rolling admission rate and the binding lifetime. */
export const CLIENT_ACTION_MAX_LIVE_BINDINGS_PER_SOCKET =
  CLIENT_ACTION_BINDING_ADMISSIONS_PER_MINUTE * (CLIENT_ACTION_BINDING_TTL_MS / 60_000);
export const UI_ACTION_EVENT_TTL_MS = 30_000;
/** Maximum one-minute burst retained for 30-second automatic action events. Enforced in Phase 3.4. */
export const UI_ACTION_MAX_RETAINED_IDS_PER_SOCKET = 60;

const textEncoder = new TextEncoder();
const SEMANTIC_TEXT_FORBIDDEN = /[\\/#<>`]|\b(?:https?:|javascript:|data:)/iu;
const SEMANTIC_TEXT_SELECTOR_OR_EXECUTABLE = /(?:\b(?:document|window)\s*\.|\b(?:queryselector|addeventlistener|onclick|onchange|eval)\b|(?:^|[\s>+~])(?:[A-Za-z][\w-]*)?(?:\[[^\]]+\]|:[A-Za-z-]+(?:\([^)]*\))?))/iu;
const COMPONENT_NAME = /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const SECRET_CONTEXT_KEY = /(?:access[_-]?token|api[_-]?key|apikey|auth(?:orization)?|bearer|cookie|credential(?:s)?|pass(?:word|wd)?|private[_-]?key|secret|session[_-]?token|token)/iu;
const SECRET_SHAPED_VALUE = /(?:\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16})\b|\b(?:basic|bearer)\s+[A-Za-z0-9._~+/-]{8,}\b|(?:access[_ -]?token|api[_ -]?key|apikey|authorization|credential|pass(?:word|wd)?|private[_ -]?key|secret|session[_ -]?token|token)\s*[:=]\s*[^\s"']{8,})/iu;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,119}$/;
const CONTEXT_KEY = /^[a-z][a-zA-Z0-9]{0,63}$/;
const SENSITIVE_URL_CREDENTIAL_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "authcode",
  "bearer",
  "clientsecret",
  "code",
  "cookie",
  "credential",
  "idtoken",
  "oauthcode",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "signature",
  "sig",
  "token",
]);
const SENSITIVE_URL_CREDENTIAL_SUFFIX = /(?:accesstoken|refreshtoken|idtoken|sessiontoken|authtoken|authorizationtoken|credentialtoken|clientsecret|privatekey|apikey|password|bearertoken|signature|sig)$/u;
const SENSITIVE_URL_CODE_VARIANT = /^(?:x(?:oauth|auth|access|session|api|client|refresh|id)?|oauth\d*|oidc|sso|auth(?:orization)?|access|client|device|verification)code$/u;

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isNormalizedPlainText(value: string): boolean {
  return value === value.normalize("NFC").trim() && !CONTROL_CHARACTER.test(value);
}

function isSafeSemanticText(value: string): boolean {
  return isNormalizedPlainText(value)
    && !SEMANTIC_TEXT_FORBIDDEN.test(value)
    && !SEMANTIC_TEXT_SELECTOR_OR_EXECUTABLE.test(value)
    && !COMPONENT_NAME.test(value);
}

function hasUnsafeHandoffControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 8 || codePoint === 11 || codePoint === 12) return true;
    if ((codePoint >= 14 && codePoint <= 31) || codePoint === 127) return true;
  }
  return false;
}

function safeText(maxChars: number, maxBytes: number) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine(isNormalizedPlainText, "must be NFC-normalized, trimmed plain text without control characters")
    .refine((value) => utf8Bytes(value) <= maxBytes, `must not exceed ${maxBytes} UTF-8 bytes`);
}

function semanticText(maxChars: number, maxBytes: number) {
  return safeText(maxChars, maxBytes)
    .refine(isSafeSemanticText, "must contain semantic text only, not a route, selector, or executable value");
}

function handoffText(maxChars: number, maxBytes: number) {
  return z.string()
    .min(1)
    .max(maxChars)
    .refine((value) => value === value.normalize("NFC").trim() && !hasUnsafeHandoffControlCharacter(value), {
      message: "must be NFC-normalized, trimmed text without unsafe control characters",
    })
    .refine((value) => utf8Bytes(value) <= maxBytes, `must not exceed ${maxBytes} UTF-8 bytes`)
    .refine((value) => !SECRET_SHAPED_VALUE.test(value), "contains a secret-shaped value");
}

function normalizedUrlCredentialKey(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "))
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^a-z0-9]/gu, "");
  } catch {
    return null;
  }
}

function isSensitiveUrlCredentialKey(value: string): boolean {
  const key = normalizedUrlCredentialKey(value);
  if (!key) return true;
  return SENSITIVE_URL_CREDENTIAL_KEYS.has(key)
    || SENSITIVE_URL_CREDENTIAL_SUFFIX.test(key)
    || SENSITIVE_URL_CODE_VARIANT.test(key);
}

function hasSensitiveBrowserFragment(value: string): boolean {
  let fragment: string;
  try {
    fragment = decodeURIComponent(value.startsWith("#") ? value.slice(1) : value);
  } catch {
    return true;
  }
  if (SECRET_SHAPED_VALUE.test(fragment)) return true;
  return fragment.split(/[?&;]/u).some((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return false;
    return isSensitiveUrlCredentialKey(part.slice(0, separator));
  });
}

function isSafeBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && [...url.searchParams.keys()].every((key) => !isSensitiveUrlCredentialKey(key))
      && !hasSensitiveBrowserFragment(url.hash);
  } catch {
    return false;
  }
}

export const uiTargetIdSchema = z.enum(APPLICATION_CATALOGUE_TARGET_IDS_V1);
export type UiTargetId = z.infer<typeof uiTargetIdSchema>;

export const UI_TARGET_IDS_V1 = uiTargetIdSchema.options;

export const uiPresentationSchema = z.enum(["link", "reveal", "spotlight"]);
export type UiPresentation = z.infer<typeof uiPresentationSchema>;

export const automaticUiPresentationSchema = z.enum(["reveal", "spotlight"]);
export type AutomaticUiPresentation = z.infer<typeof automaticUiPresentationSchema>;

/**
 * A Channel's declared disposition for one semantic target. Route resolution,
 * focus, highlighting, and fallback copy remain channel-local implementation
 * details and never cross this shared contract.
 */
export const uiTargetDispositionV1Schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("supported") }).strict(),
  z.object({
    status: z.literal("unsupported"),
    fallbackText: semanticText(512, 1_024),
  }).strict(),
]);
export type UiTargetDispositionV1 = z.infer<typeof uiTargetDispositionV1Schema>;

export type UiTargetDispositionMapV1 = Readonly<Record<UiTargetId, UiTargetDispositionV1>>;

/** Exhaustive route-free Channel adapter declaration for the finite v1 target set. */
export const uiTargetDispositionMapV1Schema = z.record(z.string(), uiTargetDispositionV1Schema)
  .superRefine((value, context) => {
    const actual = Object.keys(value).sort();
    const expected = [...UI_TARGET_IDS_V1].sort();
    for (const target of expected) {
      if (!(target in value)) context.addIssue({ code: "custom", path: [target], message: "missing target disposition" });
    }
    for (const target of actual) {
      if (!UI_TARGET_IDS_V1.includes(target as UiTargetId)) context.addIssue({ code: "custom", path: [target], message: "unknown target disposition" });
    }
  });

export const uiTargetChannelAdapterV1Schema = z.object({
  dispositions: uiTargetDispositionMapV1Schema,
}).strict();
export type UiTargetChannelAdapterV1 = z.infer<typeof uiTargetChannelAdapterV1Schema>;

/** Safe, client-independent target metadata. It intentionally contains no route-like data. */
export const uiTargetDefinitionV1Schema = z.object({
  target: uiTargetIdSchema,
  label: semanticText(80, 160),
  menuPath: z.array(semanticText(80, 160)).min(1).max(4),
  description: semanticText(280, 512),
  discoveryTerms: z.array(semanticText(48, 96)).min(1).max(8),
}).strict();
export type UiTargetDefinitionV1 = z.infer<typeof uiTargetDefinitionV1Schema>;

const applicationCatalogueVersionPatternV1 = /^(\d{4})-(\d{2})-(\d{2})\.([1-9]\d{0,5})$/u;
function parseApplicationCatalogueVersionV1(value: string): [number, number, number, number] | null {
  const match = applicationCatalogueVersionPatternV1.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const revision = Number(match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return [year, month, day, revision];
}
export const applicationCatalogueVersionV1Schema = z.string()
  .regex(applicationCatalogueVersionPatternV1)
  .refine((value) => parseApplicationCatalogueVersionV1(value) !== null, "must be a canonical catalogue release date and positive revision");

const applicationCatalogueFields = {
  version: z.literal(GENIE_APPLICATION_BRIDGE_VERSION_V1),
  catalogueVersion: applicationCatalogueVersionV1Schema,
  publishedAt: z.string().datetime({ offset: true }),
  provenance: z.enum(["bundled", "remote"]),
  targets: z.array(uiTargetDefinitionV1Schema).min(1).max(128),
};
function exactApplicationTargetSet(value: { targets: readonly UiTargetDefinitionV1[] }, context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, definition] of value.targets.entries()) {
    if (seen.has(definition.target)) context.addIssue({ code: "custom", path: ["targets", index, "target"], message: "catalogue targets must be unique" });
    seen.add(definition.target);
  }
  if (seen.size !== UI_TARGET_IDS_V1.length || UI_TARGET_IDS_V1.some((target) => !seen.has(target))) {
    context.addIssue({ code: "custom", path: ["targets"], message: "catalogue target set must exactly match installed support" });
  }
}
export const applicationCatalogueV1Schema = z.object(applicationCatalogueFields).strict().superRefine(exactApplicationTargetSet);
export type ApplicationCatalogueV1 = z.infer<typeof applicationCatalogueV1Schema>;
/** Signed artifacts carry metadata only; served provenance is stamped locally. */
export const applicationCatalogueMetadataSnapshotV1Schema = z.object({
  version: applicationCatalogueFields.version,
  catalogueVersion: applicationCatalogueFields.catalogueVersion,
  publishedAt: applicationCatalogueFields.publishedAt,
  targets: applicationCatalogueFields.targets,
}).strict().superRefine(exactApplicationTargetSet);

export const APPLICATION_CATALOGUE_SIGNING_DOMAIN_V1 = "nautilo-application-catalogue-v1";
export const applicationCatalogueReleasePointerV1Schema = z.object({
  catalogueVersion: applicationCatalogueFields.catalogueVersion,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u, "must be canonical 64-byte base64 Ed25519 signature"),
  signingKeyId: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u),
}).strict();
export type ApplicationCatalogueReleasePointerV1 = z.infer<typeof applicationCatalogueReleasePointerV1Schema>;
export function canonicalApplicationCatalogueSigningPayloadV1(catalogueVersion: string, artifactSha256: string): string {
  return `${APPLICATION_CATALOGUE_SIGNING_DOMAIN_V1}\ncatalogueVersion=${catalogueVersion}\nartifactSha256=${artifactSha256}\n`;
}
export function immutableApplicationCatalogueFilenameV1(catalogueVersion: string): string {
  return `application-catalogue-${catalogueVersion}.json`;
}
export function compareApplicationCatalogueVersionV1(left: string, right: string): number {
  const a = parseApplicationCatalogueVersionV1(left);
  const b = parseApplicationCatalogueVersionV1(right);
  if (!a || !b) throw new Error("invalid application catalogue version");
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

/** The discovery result omits registry-only matching terms. */
export const uiTargetDiscoveryResultV1Schema = z.object({
  target: uiTargetIdSchema,
  label: semanticText(80, 160),
  menuPath: z.array(semanticText(80, 160)).min(1).max(4),
  description: semanticText(280, 512),
}).strict();
export type UiTargetDiscoveryResultV1 = z.infer<typeof uiTargetDiscoveryResultV1Schema>;

/**
 * The finite v1 catalogue is semantic only. Navigation and control handling
 * belong to each client adapter, never this shared contract.
 */
/**
 * Checked-in generated metadata is still untrusted input: validate it at
 * import time so an accidental/manual edit cannot broaden the shared
 * semantic contract. Executable behaviour is intentionally absent.
 */
export const BUNDLED_APPLICATION_CATALOGUE_V1 = applicationCatalogueV1Schema.parse(GENERATED_APPLICATION_CATALOGUE_V1);
export const UI_TARGET_DEFINITIONS_V1 = BUNDLED_APPLICATION_CATALOGUE_V1.targets;

if (
  UI_TARGET_DEFINITIONS_V1.length !== UI_TARGET_IDS_V1.length
  || new Set(UI_TARGET_DEFINITIONS_V1.map((definition) => definition.target)).size !== UI_TARGET_IDS_V1.length
  || UI_TARGET_DEFINITIONS_V1.some((definition) => !UI_TARGET_IDS_V1.includes(definition.target))
) {
  throw new Error("Generated application catalogue must contain every bundled target exactly once");
}

const guideUserDiscoveryArgsV1Schema = z.object({
  version: z.literal(GENIE_APPLICATION_BRIDGE_VERSION_V1),
  query: semanticText(GUIDE_USER_QUERY_MAX_CHARS_V1, GUIDE_USER_QUERY_MAX_UTF8_BYTES_V1),
}).strict();

const guideUserGuidanceArgsV1Schema = z.object({
  version: z.literal(GENIE_APPLICATION_BRIDGE_VERSION_V1),
  target: uiTargetIdSchema,
  presentation: uiPresentationSchema,
  confirmed: z.boolean(),
}).strict();

/** The only v1 tool inputs: bounded discovery or one approved semantic action. */
export const guideUserArgsV1Schema = z.union([
  guideUserDiscoveryArgsV1Schema,
  guideUserGuidanceArgsV1Schema,
]);
export type GuideUserArgsV1 = z.infer<typeof guideUserArgsV1Schema>;

const guideUserDiscoveryResultV1Schema = z.object({
  version: z.literal(GENIE_APPLICATION_BRIDGE_VERSION_V1),
  kind: z.literal("discovery"),
  targets: z.array(uiTargetDiscoveryResultV1Schema).max(GUIDE_USER_MAX_DISCOVERY_RESULTS_V1),
}).strict().superRefine((value, context) => {
  const seen = new Set<UiTargetId>();
  for (const [index, target] of value.targets.entries()) {
    if (seen.has(target.target)) {
      context.addIssue({ code: "custom", path: ["targets", index, "target"], message: "discovery targets must be unique" });
    }
    seen.add(target.target);
  }
});

const guideUserGuidanceResultV1Schema = z.object({
  version: z.literal(GENIE_APPLICATION_BRIDGE_VERSION_V1),
  kind: z.literal("guidance"),
  actionId: z.string().regex(OPAQUE_ID, "must be a bounded opaque action id"),
  target: uiTargetIdSchema,
  presentation: uiPresentationSchema,
  fallbackText: semanticText(512, 1_024).refine(
    (value) => !/\b(?:opened|opening|revealed|spotlighted|navigated|shown)\b/iu.test(value),
    "must describe a clickable fallback without claiming it opened",
  ),
}).strict();

/** Rehydratable guide_user result: ranked discovery or a durable fallback action. */
export const guideUserResultV1Schema = z.union([
  guideUserDiscoveryResultV1Schema,
  guideUserGuidanceResultV1Schema,
]);
export type GuideUserResultV1 = z.infer<typeof guideUserResultV1Schema>;

function uiActionEventV1SchemaAt(now: () => number) {
  return z.object({
    type: z.literal("ui.action.v1"),
    actionId: z.string().regex(OPAQUE_ID, "must be a bounded opaque action id"),
    target: uiTargetIdSchema,
    presentation: automaticUiPresentationSchema,
    expiresAt: z.string().max(32).refine((value) => {
      const date = new Date(value);
      const expiresAt = date.getTime();
      const currentTime = now();
      return Number.isFinite(expiresAt)
        && Number.isFinite(currentTime)
        && date.toISOString() === value
        && expiresAt > currentTime
        && expiresAt <= currentTime + UI_ACTION_EVENT_TTL_MS;
    }, "must be a finite future UTC timestamp within the action event TTL"),
  }).strict();
}

/** Exact-client event payload. `link` is excluded: automatic delivery is singular and non-durable. */
export const uiActionEventV1Schema = uiActionEventV1SchemaAt(() => Date.now());
export type UiActionEventV1 = z.infer<typeof uiActionEventV1Schema>;

/**
 * Socket-local, server-minted control frame. It is not a ServerEvent and is
 * never room- or user-broadcast. A 128-bit random value encoded as base64url
 * is exactly 22 characters.
 */
export const clientSessionEventV1Schema = z.object({
  type: z.literal("client.session.v1"),
  clientActionSessionId: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{21}$/u,
    "must be a portable 128-bit base64url opaque client-action session id",
  ),
}).strict();
export type ClientSessionEventV1 = z.infer<typeof clientSessionEventV1Schema>;

export const genieRecoveryRequirementSchema = z.enum([
  "human_enablement",
  "pin",
  "login",
  "desktop",
]);
export type GenieRecoveryRequirement = z.infer<typeof genieRecoveryRequirementSchema>;

/** Semantic recovery metadata only; it neither names a route nor grants authority. */
export const genieRecoveryV1Schema = z.object({
  target: uiTargetIdSchema,
  requirement: genieRecoveryRequirementSchema,
  domainTool: z.string().regex(TOOL_NAME, "must be a bounded domain tool name").optional(),
}).strict();
export type GenieRecoveryV1 = z.infer<typeof genieRecoveryV1Schema>;

/** Durable old-client fallback plus semantic recovery metadata. */
export const genieRecoveryResultV1Schema = z.object({
  version: z.literal(GENIE_APPLICATION_BRIDGE_VERSION_V1),
  text: semanticText(GENIE_RECOVERY_TEXT_MAX_CHARS_V1, GENIE_RECOVERY_TEXT_MAX_UTF8_BYTES_V1),
  recovery: genieRecoveryV1Schema,
}).strict();
export type GenieRecoveryResultV1 = z.infer<typeof genieRecoveryResultV1Schema>;

export const genieHandoffSourceSchema = z.union([uiTargetIdSchema, z.literal("browser.page")]);
export type GenieHandoffSource = z.infer<typeof genieHandoffSourceSchema>;

export const genieHandoffDeliverySchema = z.enum([
  "draft-current-room",
  "send-current-room",
  "send-new-room",
]);
export type GenieHandoffDelivery = z.infer<typeof genieHandoffDeliverySchema>;

const handoffContextSchema = z.record(
  z.string().regex(CONTEXT_KEY, "must be a bounded camelCase context key"),
  handoffText(4_096, 8_192),
).refine((context) => Object.keys(context).length <= GENIE_HANDOFF_MAX_CONTEXT_ENTRIES_V1, {
  message: `must contain at most ${GENIE_HANDOFF_MAX_CONTEXT_ENTRIES_V1} entries`,
}).refine((context) => utf8Bytes(JSON.stringify(context)) <= GENIE_HANDOFF_MAX_CONTEXT_UTF8_BYTES_V1, {
  message: `must not exceed ${GENIE_HANDOFF_MAX_CONTEXT_UTF8_BYTES_V1} UTF-8 bytes`,
}).superRefine((context, issueContext) => {
  for (const key of Object.keys(context)) {
    if (SECRET_CONTEXT_KEY.test(key)) {
      issueContext.addIssue({ code: "custom", message: "secret-bearing context fields are forbidden" });
    }
  }
});

/**
 * Application-to-Genie handoff. Context is a bounded flat string map only;
 * source-specific checks reject browser credential URLs before persistence.
 */
const genieHandoffV1InnerSchema = z.object({
  version: z.literal(GENIE_APPLICATION_BRIDGE_VERSION_V1),
  source: genieHandoffSourceSchema,
  intent: handoffText(2_048, 4_096),
  context: handoffContextSchema,
  delivery: genieHandoffDeliverySchema,
}).strict().superRefine((value, issueContext) => {
  if (value.source === "browser.page") {
    const url = value.context["url"];
    if (!url || !isSafeBrowserUrl(url)) {
      issueContext.addIssue({ code: "custom", path: ["context", "url"], message: "browser handoffs require a safe http(s) page URL without credentials or sensitive parameters" });
    }
  }
});
export type GenieHandoffV1 = z.infer<typeof genieHandoffV1InnerSchema>;

export class GenieHandoffValidationError extends Error {
  constructor() {
    super("Genie handoff contains an unsafe context field.");
    this.name = "GenieHandoffValidationError";
  }
}

function hasUnsafeHandoffContextKey(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = (value as Record<string, unknown>)["context"];
  return Boolean(context && typeof context === "object" && !Array.isArray(context)
    && Object.keys(context).some((key) => SECRET_CONTEXT_KEY.test(key) || !CONTEXT_KEY.test(key)));
}

/**
 * Public schema boundary: reject raw unsafe context keys before the strict
 * inner record schema can surface one of them in a path-bearing Zod issue.
 */
export const genieHandoffV1Schema = z.unknown().transform((value, context) => {
  if (hasUnsafeHandoffContextKey(value)) {
    context.addIssue({ code: "custom", message: "Genie handoff contains an unsafe context field." });
    return z.NEVER;
  }
  return value;
}).pipe(genieHandoffV1InnerSchema);

export function parseGuideUserArgsV1(value: unknown): GuideUserArgsV1 {
  return guideUserArgsV1Schema.parse(value);
}

export function parseUiTargetChannelAdapterV1(value: unknown): UiTargetChannelAdapterV1 {
  return uiTargetChannelAdapterV1Schema.parse(value);
}

export function parseGuideUserResultV1(value: unknown): GuideUserResultV1 {
  return guideUserResultV1Schema.parse(value);
}

/** `now` enables deterministic server tests; ordinary callers need no clock plumbing. */
export function parseUiActionEventV1(value: unknown, now = Date.now()): UiActionEventV1 {
  return uiActionEventV1SchemaAt(() => now).parse(value);
}

export function parseClientSessionEventV1(value: unknown): ClientSessionEventV1 {
  return clientSessionEventV1Schema.parse(value);
}

export function parseGenieRecoveryV1(value: unknown): GenieRecoveryV1 {
  return genieRecoveryV1Schema.parse(value);
}

export function parseGenieRecoveryResultV1(value: unknown): GenieRecoveryResultV1 {
  return genieRecoveryResultV1Schema.parse(value);
}

export function parseGenieHandoffV1(value: unknown): GenieHandoffV1 {
  if (hasUnsafeHandoffContextKey(value)) throw new GenieHandoffValidationError();
  return genieHandoffV1Schema.parse(value);
}
