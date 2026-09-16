/**
 * D515 browser-viewer qualification receipt contract.
 *
 * This records a bounded physical-browser observation. It is deliberately not
 * a renderer policy: validation and eligibility never enable a format.
 */
export const SHARED_BROWSER_VIEWER_RECEIPT_SCHEMA_VERSION =
  "nautilo.shared-browser-viewer-qualification.v2";

export const SHARED_BROWSER_VIEWER_FORMATS = ["pdf", "docx", "xlsx", "pptx"] as const;

export type SharedBrowserViewerFormat = (typeof SHARED_BROWSER_VIEWER_FORMATS)[number];
export type SharedBrowserViewerRenderKind = "pages" | "sheets" | "slides";

type ReceiptAsset = {
  readonly status: "loaded";
  readonly kind: "pdf-worker" | "renderer-module" | "renderer-wasm";
  readonly url: string;
  readonly mimeType: string;
  readonly sha256: string;
};

export interface SharedBrowserViewerQualificationReceipt {
  readonly schemaVersion: typeof SHARED_BROWSER_VIEWER_RECEIPT_SCHEMA_VERSION;
  readonly format: SharedBrowserViewerFormat;
  readonly runtime: {
    readonly name: string;
    readonly device: string;
    readonly os: string;
    readonly browser: string;
    readonly browserFamily: "safari" | "chromium";
  };
  readonly physical: boolean;
  /** Three immutable identities bind evidence to the deployed export. */
  readonly build: {
    readonly sourceRevision: string;
    readonly mobileExportSha256: string;
    readonly serverImageDigest: string;
  };
  readonly fixture: {
    readonly id: string;
    readonly class: "representative" | "boundary";
    readonly sha256: string;
    readonly declaredSourceBytes: number;
    readonly observedSourceBytes: number;
    readonly metadataBytes: number;
  };
  /** Host-configured ceilings are evidence, never policy values. */
  readonly host: {
    readonly metadataCapBytes: number;
    readonly sourceCapBytes: number;
    readonly maxActiveAcquisitions: number;
    readonly ooxmlEntryCap: number;
    readonly ooxmlInflatedBytesCap: number;
  };
  readonly acquisition: {
    readonly declaredBytes: number;
    readonly observedBytes: number;
    /** The client must be configured to make redirects a hard error. */
    readonly redirectMode: "error";
    readonly attempts: number;
    readonly maxActiveAcquisitions: number;
    readonly outcome: "completed" | "failed";
  };
  readonly parser: {
    readonly cloneCount: number;
    readonly cloneBytes: number;
    readonly masterDetachedAfterHandoff: boolean;
    readonly parserDetached: boolean;
  };
  /** Required for OOXML and forbidden for PDF; actual inflation is never inferred. */
  readonly archive?: {
    readonly entries: number;
    readonly declaredInflatedBytes: number;
    readonly actualInflatedBytes: number | "unknown";
  };
  readonly rendered: {
    readonly kind: SharedBrowserViewerRenderKind;
    readonly count: number;
    readonly interaction: {
      readonly rotation: "observed";
      readonly zoom: "observed";
      readonly layout: "observed";
    };
    readonly canvas: {
      readonly status: "observed" | "not-used";
      readonly pixelWidth?: number;
      readonly pixelHeight?: number;
      readonly devicePixelRatio?: number;
    };
  };
  readonly deadlines: {
    readonly acquisition: { readonly configuredMs: number; readonly elapsedMs: number; readonly outcome: "met" | "missed" };
    readonly parse: { readonly configuredMs: number; readonly elapsedMs: number; readonly outcome: "met" | "missed" };
    readonly render: { readonly configuredMs: number; readonly elapsedMs: number; readonly outcome: "met" | "missed" };
    readonly cleanup: { readonly configuredMs: number; readonly elapsedMs: number; readonly outcome: "met" | "missed" };
    readonly worker: { readonly configuredMs: number; readonly elapsedMs: number; readonly outcome: "met" | "missed" };
    readonly total: { readonly configuredMs: number; readonly elapsedMs: number; readonly outcome: "met" | "missed" };
  };
  readonly lifecycle: {
    readonly replacementCleanupObserved: boolean;
    readonly failureCleanupObserved: boolean;
    readonly closeObserved: boolean;
    readonly destroyCalls: number;
    readonly postCloseWaitMs: number;
    readonly postCloseReclaimed: boolean;
  };
  /** Every renderer-loaded asset is listed; URLs are same-origin `/mobile/` paths only. */
  readonly assets: readonly ReceiptAsset[];
  readonly memory:
    | {
      readonly status: "observed";
      readonly methodology: "performance-memory" | "browser-instrumentation";
      readonly beforeBytes: number;
      readonly peakBytes: number;
      readonly afterBytes: number;
    }
    | {
      readonly status: "unknown";
      readonly reason: "api-unavailable" | "browser-restricted";
    };
}

export interface SharedBrowserViewerReceiptValidation {
  readonly valid: boolean;
  readonly receipt?: SharedBrowserViewerQualificationReceipt;
  readonly errors: readonly string[];
}

export interface SharedBrowserViewerQualificationEligibility {
  readonly eligible: boolean;
  readonly reason: "invalid-receipt" | "non-physical-runtime" | "incomplete-boundary-evidence" | "eligible-for-separate-approval";
  readonly validation: SharedBrowserViewerReceiptValidation;
}

export interface SharedBrowserViewerAvailability {
  readonly available: false;
  readonly reason: "no-approved-qualification-policy";
}

const REQUIRED_RENDER_KIND: Record<SharedBrowserViewerFormat, SharedBrowserViewerRenderKind> = {
  pdf: "pages",
  docx: "pages",
  xlsx: "sheets",
  pptx: "slides",
};
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function safeEvidenceLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && value.trim() === value
    && !/[\\/?#@\r\n]/.test(value) && !/^(unknown|n\/?a)$/i.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isSafeFinite(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

/** Only deployment-root-relative assets may appear in a receipt. */
export function isSafeSharedBrowserViewerAssetUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  if (!value.startsWith("/mobile/") || /[%?#\\\r\n]/.test(value)) return false;
  const segments = value.split("/").slice(2);
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== "."
    && segment !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment));
}

function formatOf(value: unknown): SharedBrowserViewerFormat | null {
  return typeof value === "string" && (SHARED_BROWSER_VIEWER_FORMATS as readonly string[]).includes(value)
    ? value as SharedBrowserViewerFormat : null;
}

function renderKindOf(value: unknown): SharedBrowserViewerRenderKind | null {
  return value === "pages" || value === "sheets" || value === "slides" ? value : null;
}

function isArchiveValid(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["entries", "declaredInflatedBytes", "actualInflatedBytes"])
    && isSafeInteger(value.entries, 1) && isSafeInteger(value.declaredInflatedBytes, 1)
    && (value.actualInflatedBytes === "unknown" || isSafeInteger(value.actualInflatedBytes, 1));
}

function isAssetValid(value: unknown): value is ReceiptAsset {
  if (!isRecord(value) || !hasOnlyKeys(value, ["status", "kind", "url", "mimeType", "sha256"])
    || value.status !== "loaded" || !isSafeSharedBrowserViewerAssetUrl(value.url)
    || typeof value.mimeType !== "string" || !MIME_TYPE_PATTERN.test(value.mimeType)
    || typeof value.sha256 !== "string" || !SHA_256_PATTERN.test(value.sha256)) return false;
  return (value.kind === "pdf-worker" && (value.mimeType === "text/javascript" || value.mimeType === "application/javascript"))
    || (value.kind === "renderer-module" && (value.mimeType === "text/javascript" || value.mimeType === "application/javascript"))
    || (value.kind === "renderer-wasm" && value.mimeType === "application/wasm");
}

function isDeadlineValid(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["configuredMs", "elapsedMs", "outcome"])
    && isSafeFinite(value.configuredMs, 1) && isSafeFinite(value.elapsedMs, 0)
    && (value.outcome === "met" || value.outcome === "missed");
}

function isRenderedValid(value: unknown, format: SharedBrowserViewerFormat | null): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "count", "interaction", "canvas"])
    || !isSafeInteger(value.count, 1) || !renderKindOf(value.kind)
    || (format !== null && value.kind !== REQUIRED_RENDER_KIND[format])) return false;
  const interaction = value.interaction;
  const canvas = value.canvas;
  if (!isRecord(interaction) || !hasOnlyKeys(interaction, ["rotation", "zoom", "layout"])
    || interaction.rotation !== "observed" || interaction.zoom !== "observed" || interaction.layout !== "observed") return false;
  if (!isRecord(canvas) || !hasOnlyKeys(canvas, ["status", "pixelWidth", "pixelHeight", "devicePixelRatio"])
    || (canvas.status !== "observed" && canvas.status !== "not-used")) return false;
  return canvas.status === "not-used"
    ? canvas.pixelWidth === undefined && canvas.pixelHeight === undefined && canvas.devicePixelRatio === undefined
    : isSafeInteger(canvas.pixelWidth, 1) && isSafeInteger(canvas.pixelHeight, 1) && isSafeFinite(canvas.devicePixelRatio, 0.01);
}

function isMemoryValid(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "observed") {
    return hasOnlyKeys(value, ["status", "methodology", "beforeBytes", "peakBytes", "afterBytes"])
      && (value.methodology === "performance-memory" || value.methodology === "browser-instrumentation")
      && isSafeInteger(value.beforeBytes, 0) && isSafeInteger(value.peakBytes, 0)
      && isSafeInteger(value.afterBytes, 0) && value.peakBytes >= value.beforeBytes
      && value.afterBytes <= value.peakBytes && value.afterBytes <= value.beforeBytes;
  }
  return hasOnlyKeys(value, ["status", "reason"]) && value.status === "unknown"
    && (value.reason === "api-unavailable" || value.reason === "browser-restricted");
}

/** Strictly validate redaction-safe, format-specific physical evidence. */
export function validateSharedBrowserViewerQualificationReceipt(value: unknown): SharedBrowserViewerReceiptValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["receipt must be an object"] };
  if (!hasOnlyKeys(value, ["schemaVersion", "format", "runtime", "physical", "build", "fixture", "host", "acquisition", "parser", "archive", "rendered", "deadlines", "lifecycle", "assets", "memory"])) errors.push("receipt contains an unknown field");
  if (value.schemaVersion !== SHARED_BROWSER_VIEWER_RECEIPT_SCHEMA_VERSION) errors.push("receipt schemaVersion is unsupported");
  const format = formatOf(value.format);
  if (!format) errors.push("receipt format is unsupported");

  const runtime = value.runtime;
  if (!isRecord(runtime) || !hasOnlyKeys(runtime, ["name", "device", "os", "browser", "browserFamily"])
    || !safeEvidenceLabel(runtime.name) || !safeEvidenceLabel(runtime.device) || !safeEvidenceLabel(runtime.os)
    || !safeEvidenceLabel(runtime.browser) || (runtime.browserFamily !== "safari" && runtime.browserFamily !== "chromium")) errors.push("receipt runtime is invalid");
  if (typeof value.physical !== "boolean") errors.push("receipt physical must be boolean");

  const build = value.build;
  if (!isRecord(build) || !hasOnlyKeys(build, ["sourceRevision", "mobileExportSha256", "serverImageDigest"])
    || typeof build.sourceRevision !== "string" || !GIT_REVISION_PATTERN.test(build.sourceRevision)
    || typeof build.mobileExportSha256 !== "string" || !SHA_256_PATTERN.test(build.mobileExportSha256)
    || typeof build.serverImageDigest !== "string" || !IMAGE_DIGEST_PATTERN.test(build.serverImageDigest)) errors.push("receipt build identity is invalid");

  const fixture = value.fixture;
  if (!isRecord(fixture) || !hasOnlyKeys(fixture, ["id", "class", "sha256", "declaredSourceBytes", "observedSourceBytes", "metadataBytes"])
    || !isSafeIdentifier(fixture.id) || (fixture.class !== "representative" && fixture.class !== "boundary")
    || typeof fixture.sha256 !== "string" || !SHA_256_PATTERN.test(fixture.sha256)
    || !isSafeInteger(fixture.declaredSourceBytes, 1) || !isSafeInteger(fixture.observedSourceBytes, 1)
    || !isSafeInteger(fixture.metadataBytes, 0)) errors.push("receipt fixture class or byte evidence is invalid");

  const host = value.host;
  if (!isRecord(host) || !hasOnlyKeys(host, ["metadataCapBytes", "sourceCapBytes", "maxActiveAcquisitions", "ooxmlEntryCap", "ooxmlInflatedBytesCap"])
    || !isSafeInteger(host.metadataCapBytes, 1) || !isSafeInteger(host.sourceCapBytes, 1)
    || !isSafeInteger(host.maxActiveAcquisitions, 1) || !isSafeInteger(host.ooxmlEntryCap, 1)
    || !isSafeInteger(host.ooxmlInflatedBytesCap, 1)) errors.push("receipt host caps or concurrency evidence is invalid");

  const acquisition = value.acquisition;
  if (!isRecord(acquisition) || !hasOnlyKeys(acquisition, ["declaredBytes", "observedBytes", "redirectMode", "attempts", "maxActiveAcquisitions", "outcome"])
    || !isSafeInteger(acquisition.declaredBytes, 1) || !isSafeInteger(acquisition.observedBytes, 1)
    || acquisition.redirectMode !== "error" || !isSafeInteger(acquisition.attempts, 1)
    || !isSafeInteger(acquisition.maxActiveAcquisitions, 1)
    || (acquisition.outcome !== "completed" && acquisition.outcome !== "failed")) errors.push("receipt acquisition evidence is invalid");

  const parser = value.parser;
  if (!isRecord(parser) || !hasOnlyKeys(parser, ["cloneCount", "cloneBytes", "masterDetachedAfterHandoff", "parserDetached"])
    || !isSafeInteger(parser.cloneCount, 0) || !isSafeInteger(parser.cloneBytes, 0)
    || typeof parser.masterDetachedAfterHandoff !== "boolean" || typeof parser.parserDetached !== "boolean"
    || (parser.cloneCount === 0 && (parser.cloneBytes !== 0 || parser.masterDetachedAfterHandoff || parser.parserDetached))) errors.push("receipt parser clone evidence is invalid");

  if (format === "pdf" ? value.archive !== undefined : !isArchiveValid(value.archive)) errors.push("receipt OOXML archive evidence is invalid");
  if (!isRenderedValid(value.rendered, format)) errors.push("receipt rendered interaction or canvas evidence is invalid");

  const deadlines = value.deadlines;
  if (!isRecord(deadlines) || !hasOnlyKeys(deadlines, ["acquisition", "parse", "render", "cleanup", "worker", "total"])
    || !isDeadlineValid(deadlines.acquisition) || !isDeadlineValid(deadlines.parse)
    || !isDeadlineValid(deadlines.render) || !isDeadlineValid(deadlines.cleanup)
    || !isDeadlineValid(deadlines.worker) || !isDeadlineValid(deadlines.total)) errors.push("receipt configured deadline evidence is invalid");

  const lifecycle = value.lifecycle;
  if (!isRecord(lifecycle) || !hasOnlyKeys(lifecycle, ["replacementCleanupObserved", "failureCleanupObserved", "closeObserved", "destroyCalls", "postCloseWaitMs", "postCloseReclaimed"])
    || typeof lifecycle.replacementCleanupObserved !== "boolean" || typeof lifecycle.failureCleanupObserved !== "boolean"
    || typeof lifecycle.closeObserved !== "boolean" || !isSafeInteger(lifecycle.destroyCalls, 0)
    || !isSafeFinite(lifecycle.postCloseWaitMs, 1)
    || typeof lifecycle.postCloseReclaimed !== "boolean") errors.push("receipt lifecycle evidence is invalid");

  const assets = value.assets;
  if (!Array.isArray(assets) || assets.length === 0 || !assets.every(isAssetValid)
    || new Set(assets.map((asset) => isRecord(asset) ? asset.url : "")).size !== assets.length) errors.push("receipt full asset evidence is invalid");
  if (!isMemoryValid(value.memory)) errors.push("receipt memory evidence is invalid");

  if (errors.length > 0 || !format) return { valid: false, errors };
  return { valid: true, errors: [], receipt: value as unknown as SharedBrowserViewerQualificationReceipt };
}

/** A complete physical receipt can be reviewed; it never turns a viewer on itself. */
export function sharedBrowserViewerQualificationEligibility(value: unknown): SharedBrowserViewerQualificationEligibility {
  const validation = validateSharedBrowserViewerQualificationReceipt(value);
  if (!validation.valid || !validation.receipt) return { eligible: false, reason: "invalid-receipt", validation };
  const receipt = validation.receipt;
  if (!receipt.physical) return { eligible: false, reason: "non-physical-runtime", validation };
  const archiveComplete = receipt.format === "pdf" || typeof receipt.archive?.actualInflatedBytes === "number";
  const deadlinesMet = Object.values(receipt.deadlines).every((deadline) => deadline.outcome === "met" && deadline.elapsedMs <= deadline.configuredMs);
  const bytesAgree = receipt.fixture.declaredSourceBytes === receipt.fixture.observedSourceBytes
    && receipt.acquisition.declaredBytes === receipt.acquisition.observedBytes
    && receipt.acquisition.declaredBytes === receipt.fixture.observedSourceBytes;
  const underCaps = receipt.fixture.metadataBytes <= receipt.host.metadataCapBytes
    && receipt.acquisition.observedBytes <= receipt.host.sourceCapBytes
    && (receipt.format === "pdf" || (receipt.archive!.entries <= receipt.host.ooxmlEntryCap
      && receipt.archive!.declaredInflatedBytes <= receipt.host.ooxmlInflatedBytesCap
      && typeof receipt.archive!.actualInflatedBytes === "number"
      && receipt.archive!.actualInflatedBytes <= receipt.host.ooxmlInflatedBytesCap));
  const lifecycleComplete = receipt.lifecycle.replacementCleanupObserved && receipt.lifecycle.failureCleanupObserved
    && receipt.lifecycle.closeObserved && receipt.lifecycle.destroyCalls === 1 && receipt.lifecycle.postCloseReclaimed;
  const requiredAssetLoaded = receipt.format === "pdf"
    ? receipt.assets.some((asset) => asset.kind === "pdf-worker")
    : receipt.assets.some((asset) => asset.kind === "renderer-wasm");
  const evidenceComplete = receipt.host.maxActiveAcquisitions === 1 && receipt.acquisition.redirectMode === "error"
    && receipt.acquisition.attempts === 1 && receipt.acquisition.maxActiveAcquisitions === 1
    && receipt.acquisition.outcome === "completed" && receipt.parser.cloneCount <= 1
    && (receipt.parser.cloneCount === 0 || (receipt.parser.cloneBytes === receipt.acquisition.observedBytes
      && receipt.parser.masterDetachedAfterHandoff && receipt.parser.parserDetached)) && archiveComplete && bytesAgree && underCaps
    && deadlinesMet && lifecycleComplete && requiredAssetLoaded && receipt.memory.status === "observed";
  return evidenceComplete
    ? { eligible: true, reason: "eligible-for-separate-approval", validation }
    : { eligible: false, reason: "incomplete-boundary-evidence", validation };
}

/** Every format remains unavailable until a separately reviewed policy exists. */
export function sharedBrowserViewerAvailability(_format: SharedBrowserViewerFormat): SharedBrowserViewerAvailability {
  return { available: false, reason: "no-approved-qualification-policy" };
}
