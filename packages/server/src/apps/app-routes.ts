import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAppsRoot } from "@nautilo/config";
import { findArtifactByIdForNamespaces, findArtifactByInternalIdForNamespaces } from "@nautilo/db";
import {
  envelopeMutableNamespaces,
  getUserCapabilities,
  isScopeMemoryEnvelope,
  isUuidString,
  type NamespaceMemoryEnvelope,
} from "@nautilo/trust";
import { warn } from "@nautilo/logger";
import { validateClientPath } from "../messaging/attachments";
import { invokeAppTool, normalizeAppToolMutationPath, APP_TOOL_MAX_MESSAGE_BYTES } from "./app-tool-runner";
import type {
  AppToolCompletedHostMutation,
  AppToolInvokeResult,
  AppToolRunnerContext,
} from "./app-tool-types";
import { type AgentToolsBuildStatus } from "./app-builder";
import {
  resolveFirstPartyHostCapabilities,
  type MiniAppHostCapabilities,
} from "./first-party-host-capabilities";
import { buildMiniAppRuntimeSrcDoc } from "./app-runtime-html";
import { publishAppSourceEvent, subscribeAppSourceEvents } from "./app-source-events";
import {
  createLiveAppToolRegistrationOptions,
  registerAppToolsForApp,
} from "./app-tool-registration";
import {
  AppNotFoundError,
  AppSourceConflictError,
  AppSourceNotFileError,
  AppSourceNotFoundError,
  AppSourcePathError,
  AppSourceTooLargeError,
  listAppSourceTree,
  readAppSourceFile,
  writeAppSourceFile,
} from "./app-source-store";
import { type RegisteredMiniApp } from "./app-registry";
import { InstalledAppRegistry, installedAppRegistry } from "./installed-app-registry";
import { MiniAppRuntimeBuildCache } from "./runtime-build-cache";
import { setAppDisabled } from "./app-state-store";
import type { MiniAppManifest } from "./app-manifest";
import {
  liveMiniAppSessionRegistry,
  type LiveMiniAppSessionRegistry,
} from "./live-mini-app-session-registry";
import {
  getLiveReviewExtension,
  isLiveReviewEnabled,
  getLiveAppSessionExtension,
  isDirectMutationLiveReviewExtension,
} from "./live-review-extension-registry";
import { liveAppCommandBroker } from "./live-app-command-broker";
import "./first-party-live-review-extensions";
import { hasFirstPartyAssetAuthority } from "./first-party-asset-authority";
import {
  appsDetailWeakETagFromProjection,
  appsListWeakETagFromProjection,
} from "./apps-conditional-http";
import { sendPrivateConditionalRead } from "../http/conditional-http";
import type {
  ApplyAcceptedLiveProposalRequest,
  ApplyAcceptedLiveProposalResponse,
  InvalidateLiveProposalReviewRequest,
  InvalidateLiveProposalReviewResponse,
  IssueLiveMiniAppSessionRequest,
  LiveDocumentVersion,
  RefreshLiveMiniAppSessionRequest,
  ResolveLiveProposalReviewRequest,
  ResolveLiveProposalReviewResponse,
  ListPendingLiveProposalReviewsResponse,
} from "@nautilo/types";
import {
  parseArtifactDocumentVersion,
  parseLiveDocumentVersion,
} from "@nautilo/types";
import {
  MAX_DOCUMENT_BYTES,
  validateAcceptedOperationSelection,
} from "@nautilo/writer-proposal-core";
import {
  LiveLocalDocumentAuthority,
  type LiveLocalRelayRegistryPort,
  parseHostLocalShaDocumentVersion,
} from "./live-local-document-authority";
import type {
  LiveMiniAppSessionArtifactBinding,
  LiveMiniAppSessionBinding,
  LiveMiniAppSessionCurrentFileBinding,
  LiveMiniAppSessionRefreshExpected,
} from "./live-mini-app-session-registry";
import { verifyAcceptedLiveReviewContent } from "./live-review-accepted-content";
import { createWorkspaceEditorSnapshotOperationId } from "../document-mutations/workspace-editor-save-service";
import { createLiveArtifactProposalClientMutationId } from "./live-artifact-proposal-acceptance";
import {
  videoHostAttestationRegistry,
  type VideoHostAttestationRegistry,
} from "./video-host-attestation-registry";

export interface PublicMiniAppDto {
  id: string;
  name: string | null;
  /** D344 — optional one-line description from the manifest (Apps panel rows). */
  description: string | null;
  display: MiniAppManifest["display"] | null;
  version: string | null;
  status: RegisteredMiniApp["status"];
  /** D344 — ISO "installed at" (manifest mtime proxy) for Apps-page sorting. */
  installedAt: string | null;
  sourceHash: string | null;
  /** D343 — false when the operator has disabled this app. Disabled apps stay
   *  installed (AI reference, file associations) but are hidden from the agent
   *  tool catalog and any user-facing "enabled" affordance reflects this. */
  enabled: boolean;
  fileAssociations: MiniAppManifest["fileAssociations"] | null;
  createActions: MiniAppManifest["createActions"] | null;
  contentAssociations: MiniAppManifest["contentAssociations"] | null;
  conversions: MiniAppManifest["conversions"] | null;
  agentToolsDeclared: boolean;
  canEditSource: boolean;
}

export interface MiniAppRuntimeDto {
  appId: string;
  sourceHash: string;
  srcDoc: string;
  agentToolsBuild: AgentToolsBuildStatus;
  /** Server-issued only after exact first-party runtime-byte attestation. */
  hostCapabilities?: MiniAppHostCapabilities;
  manifest: {
    id: string;
    name: string;
    version: string;
    fileAssociations: MiniAppManifest["fileAssociations"];
    capabilities: MiniAppManifest["capabilities"];
    agent?: MiniAppManifest["agent"];
    /** Bounded host lifecycle flag; never exposes live-review implementation. */
    liveReview?: { enabled: true };
    conversions?: MiniAppManifest["conversions"];
  };
}

export interface MiniAppCreateTemplateDto {
  appId: string;
  actionId: string;
  content: string;
  mimeType: string;
  sha256: string;
}

export interface AppRoutesDeps {
  appsRoot?: string | (() => string);
  getCapabilities?: typeof getUserCapabilities;
  findArtifactForNamespaces?: typeof findArtifactByInternalIdForNamespaces;
  findArtifactByIdForNamespaces?: typeof findArtifactByIdForNamespaces;
  liveSessionRegistry?: LiveMiniAppSessionRegistry;
  installedAppRegistry?: InstalledAppRegistry;
  runtimeBuildCache?: MiniAppRuntimeBuildCache;
  relayRegistry?: LiveLocalRelayRegistryPort;
  liveLocalDocumentAuthority?: LiveLocalDocumentAuthority;
  getLiveLocalDocumentAuthority?: () => LiveLocalDocumentAuthority | null;
  peekLiveSessionBinding?: (token: string) => LiveMiniAppSessionBinding | null;
  registerAppToolsForApp?: typeof registerAppToolsForApp;
  invokeAppTool?: typeof invokeAppTool;
  /**
   * App-neutral owner for Task lifecycle state.  App routes validate the
   * Writer/document boundary only; the composed port records the durable
   * proposal receipt and finalizes the Task without a direct DB dependency.
   */
  liveReviewLifecycle?: LiveReviewLifecyclePort;
  /** Canonical Workspace Artifact writer supplied by server composition.
   * It must verify/apply the preflighted operations against the current
   * Artifact revision through the existing idempotent mutation service. */
  acceptLiveArtifactProposal?: LiveArtifactProposalAcceptancePort;
  resolveHostCapabilities?: typeof resolveFirstPartyHostCapabilities;
  videoHostAttestationRegistry?: VideoHostAttestationRegistry;
}

export type LiveReviewLifecycleProposal = {
  ownerId: string;
  sessionId: string;
  proposalId: string;
  documentVersion: LiveDocumentVersion;
};

export type LiveReviewLifecycleResolution =
  | { outcome: "accepted"; documentVersion: LiveDocumentVersion }
  | { outcome: "rejected" };

export type LiveReviewLifecycleResolveResult =
  | { status: "not_found" }
  | { status: "conflict" }
  | { status: "resolved"; binding: unknown; finalizeNow: boolean };

export type LiveReviewLifecycleAdmission =
  | { status: "not_task" }
  | { status: "pending"; binding: unknown }
  | { status: "invalidated" };

export type LiveReviewLifecycleReceiptResult =
  | { status: "recorded" }
  | { status: "not_found" | "conflict" };

/** Narrow composition seam; generic app routes do not import Writer runtime. */
export interface LiveReviewLifecyclePort {
  isPendingReview(input: LiveReviewLifecycleProposal): boolean;
  /**
   * Exact Task-owned reviews remain lifecycle-filtered; foreground reviews
   * have no Task binding and must remain replayable after iframe reconnect.
   */
  reviewProposalState?(input: LiveReviewLifecycleProposal): "pending" | "closed" | "not_task";
  /** Recheck the exact Task review immediately before bytes are written. */
  admitAcceptedProposal(input: LiveReviewLifecycleProposal): LiveReviewLifecycleAdmission;
  releaseAcceptanceClaim(input: LiveReviewLifecycleProposal): void;
  /** Reserve one deterministic D448 operation before the canonical Artifact write. */
  reserveAcceptedWorkspaceOperation?(input: LiveReviewLifecycleProposal & {
    operationId: string;
    clientMutationId: string;
    artifactInternalId: string;
  }, admissionBinding: unknown): Promise<{ status: "reserved" | "same" | "not_found" | "stale" | "conflict" }>;
  /** Release only a definitely uncommitted D448 reservation. */
  releaseAcceptedWorkspaceOperation?(input: LiveReviewLifecycleProposal & {
    operationId: string;
    clientMutationId: string;
    artifactInternalId: string;
  }, admissionBinding: unknown): Promise<void>;
  /** Persists only the exact canonical-save receipt; it must not transition
   * the Task while the process-local session fence is still stale. */
  recordAcceptedReceipt(input: LiveReviewLifecycleProposal & {
    resultDocumentVersion: LiveDocumentVersion;
  }, admissionBinding: unknown): Promise<LiveReviewLifecycleReceiptResult>;
  /** Advances only the existing process-local Task live context after the
   * session registry commits the canonical version and before receipt/final. */
  advanceAcceptedReviewContinuation(
    binding: unknown,
    resultDocumentVersion: LiveDocumentVersion,
  ): boolean;
  failAcceptedReviewContinuation(
    binding: unknown,
    code: "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE",
  ): LiveReviewLifecycleResolveResult;
  resolveReview(input: LiveReviewLifecycleProposal & {
    resolution: LiveReviewLifecycleResolution;
  }): LiveReviewLifecycleResolveResult;
  /** Terminal non-authorizing invalidation for the exact waiting review. */
  failReview(input: LiveReviewLifecycleProposal, code: string): LiveReviewLifecycleResolveResult;
  finalizeReview(binding: unknown): Promise<void>;
  failReviewsForSession(sessionId: string, code: string): readonly unknown[];
}

export type LiveArtifactProposalAcceptanceInput = {
  /** Authenticated namespace authority from this exact HTTP request, never
   * reconstructed from a session binding or client-provided target. */
  envelope: NamespaceMemoryEnvelope;
  binding: LiveMiniAppSessionArtifactBinding;
  sessionId: string;
  proposalId: string;
  requestId: string;
  /** Route-computed deterministic D448 correlation, never client supplied. */
  clientMutationId?: string;
  documentVersion: Extract<LiveDocumentVersion, { kind: "artifact_revision" }>;
  acceptedContent: string;
  selectedOperations: readonly unknown[];
};

export type LiveArtifactProposalAcceptancePort = (
  input: LiveArtifactProposalAcceptanceInput,
) => Promise<
  | { ok: true; result: ApplyAcceptedLiveProposalResponse }
  | { ok: false; code: string }
>;

function resolveAppsRoot(deps?: AppRoutesDeps): string {
  const root = deps?.appsRoot ?? getAppsRoot;
  return typeof root === "function" ? root() : root;
}

async function canManageAppSource(
  userId: string,
  getCapabilities: typeof getUserCapabilities,
): Promise<boolean> {
  try {
    const caps = await getCapabilities(userId);
    return caps.includes("manage_server_operations");
  } catch {
    return false;
  }
}

function toPublicMiniAppDto(
  app: RegisteredMiniApp,
  canEditSource: boolean,
): PublicMiniAppDto {
  if (!app.manifest) {
    return {
      id: app.id,
      name: null,
      description: null,
      display: null,
      version: null,
      status: app.status,
      installedAt: app.installedAt,
      sourceHash: app.sourceHash,
      enabled: app.enabled,
      fileAssociations: null,
      createActions: null,
      contentAssociations: null,
      conversions: null,
      agentToolsDeclared: false,
      canEditSource,
    };
  }

  return {
    id: app.manifest.id,
    name: app.manifest.name,
    description: app.manifest.description ?? null,
    display: app.manifest.display ?? null,
    version: app.manifest.version,
    status: app.status,
    installedAt: app.installedAt,
    sourceHash: app.sourceHash,
    enabled: app.enabled,
    fileAssociations: app.manifest.fileAssociations,
    createActions: app.manifest.createActions ?? null,
    contentAssociations: app.manifest.contentAssociations ?? null,
    conversions: app.manifest.conversions ?? null,
    agentToolsDeclared: (app.manifest.agent?.tools?.length ?? 0) > 0,
    canEditSource,
  };
}

function requireSessionUserId(request: FastifyRequest): string | null {
  const userId = request.sessionUserId;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

async function requireManageAppSourceAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  getCapabilities: typeof getUserCapabilities,
): Promise<boolean> {
  const userId = requireSessionUserId(request);
  if (!userId) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  if (!(await canManageAppSource(userId, getCapabilities))) {
    reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

function parseSourceFilePathQuery(query: unknown): string | null {
  if (!query || typeof query !== "object") return null;
  const pathValue = (query as { path?: unknown }).path;
  return typeof pathValue === "string" ? pathValue : null;
}

function toRuntimeManifestDto(manifest: MiniAppManifest): MiniAppRuntimeDto["manifest"] {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    fileAssociations: manifest.fileAssociations,
    capabilities: manifest.capabilities,
    ...(manifest.agent ? { agent: manifest.agent } : {}),
    ...(manifest.liveReview?.enabled ? { liveReview: { enabled: true } } : {}),
    ...(manifest.conversions ? { conversions: manifest.conversions } : {}),
  };
}

/**
 * M205 — derive a fallback conversion target path from the source path + the
 * manifest-declared target extension (source stem + extension, same folder).
 * The UI normally supplies an explicit target; this is the fallback when it
 * doesn't (e.g. the agent path or a bare request).
 */
export function deriveConversionTargetPath(sourcePath: string, extension: string): string {
  const norm = sourcePath.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const dir = slash >= 0 ? norm.slice(0, slash + 1) : "";
  const base = slash >= 0 ? norm.slice(slash + 1) : norm;
  const dot = base.lastIndexOf(".");
  // dot > 0 → drop extension (report.docx → report); dot === 0 → leading-dot
  // file with no real stem (.docx → ""); dot < 0 → no extension, keep base.
  const stem = dot > 0 ? base.slice(0, dot) : dot === 0 ? "" : base;
  return `${dir}${stem.length > 0 ? stem : "document"}${extension}`;
}

type DesignExportScope = { pageHandle: string; nodeHandles?: string[] };

function isCanonicalDesignHandle(value: unknown, prefix: "page:" | "node:"): value is string {
  if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  const encoded = value.slice(prefix.length);
  if (encoded.length === 0) return false;
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 && !Array.from(decoded).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && encodeURIComponent(decoded) === encoded;
  } catch {
    return false;
  }
}

function parseDesignExportScope(value: unknown): DesignExportScope | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "scope must be { pageHandle, nodeHandles? }" };
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => key !== "pageHandle" && key !== "nodeHandles");
  if (unknown) return { error: `unknown scope field: ${unknown}` };
  if (!isCanonicalDesignHandle(record["pageHandle"], "page:")) {
    return { error: "scope.pageHandle must be a canonical public Design page handle" };
  }
  if (record["nodeHandles"] === undefined) return { pageHandle: record["pageHandle"] };
  if (!Array.isArray(record["nodeHandles"]) || record["nodeHandles"].length === 0) {
    return { error: "scope.nodeHandles must be a non-empty array when provided" };
  }
  if (!record["nodeHandles"].every((handle) => isCanonicalDesignHandle(handle, "node:"))) {
    return { error: "scope.nodeHandles must contain canonical public Design node handles" };
  }
  return { pageHandle: record["pageHandle"], nodeHandles: [...record["nodeHandles"]] };
}

function recoveredConversionResult(
  appId: string,
  toolId: string,
  target: { surface: "workspace" | "currentFolder"; path: string },
  scope: DesignExportScope | undefined,
  result: Extract<AppToolInvokeResult, { ok: false }>,
): Record<string, unknown> | null {
  const expectedMethod =
    appId === "nautilo-design" && toolId === "export-svg"
      ? "document.createDocument"
      : appId === "nautilo-design" && toolId === "export-png"
        ? "document.createRasterFromSvg"
        : null;
  const mutations = result.completedHostMutations ?? [];
  if (expectedMethod === null || mutations.length !== 1) return null;
  const [mutation] = mutations;
  if (
    mutation?.method !== expectedMethod ||
    mutation.target.surface !== target.surface ||
    mutation.target.path !== normalizeAppToolMutationPath(target.surface, target.path) ||
    mutation.receipt.ok !== true
  ) {
    return null;
  }
  return {
    ok: true,
    status: "exported",
    artifactPath: mutation.receipt.artifactPath,
    displayPath: mutation.receipt.artifactPath,
    sha256: mutation.receipt.sha256,
    byteLength: mutation.receipt.byteLength,
    ...(scope ? { scope } : {}),
  };
}

function conversionFailureBody(result: Extract<AppToolInvokeResult, { ok: false }>): Record<string, unknown> {
  const mutations: readonly AppToolCompletedHostMutation[] = result.completedHostMutations ?? [];
  if (mutations.length === 0) {
    return { error: result.error, code: result.code ?? "tool_error" };
  }
  const allConfirmed = mutations.every((mutation) => mutation.receipt.ok);
  const changedPaths = [...new Set(mutations.map((mutation) =>
    mutation.receipt.ok
      ? mutation.receipt.artifactPath
      : mutation.receipt.displayPath ?? mutation.target.path,
  ))];
  return {
    ok: false,
    status: "completed_host_mutation",
    error: `${allConfirmed ? "Confirmed output created" : "Output state changed"} at ${changedPaths.join(", ")}. Check ${
      changedPaths.length === 1 ? "this file" : "these files"
    } before retrying. ${result.error}`,
    code: result.code ?? "tool_error",
    stateChanged: true,
    retrySafe: false,
    completedHostMutations: mutations,
  };
}

export function appRoutes(app: FastifyInstance, deps?: AppRoutesDeps): void {
  const getCapabilities = deps?.getCapabilities ?? getUserCapabilities;
  const findArtifactForNamespaces =
    deps?.findArtifactForNamespaces ?? findArtifactByInternalIdForNamespaces;
  const sessionRegistry = deps?.liveSessionRegistry ?? liveMiniAppSessionRegistry;
  const registry = deps?.installedAppRegistry ?? installedAppRegistry;
  const runtimeBuildCache = deps?.runtimeBuildCache ?? new MiniAppRuntimeBuildCache();
  const liveReviewLifecycle = deps?.liveReviewLifecycle;
  const acceptLiveArtifactProposal = deps?.acceptLiveArtifactProposal;
  const invokeAppToolForRoute = deps?.invokeAppTool ?? invokeAppTool;
  const videoAttestations = deps?.videoHostAttestationRegistry ?? videoHostAttestationRegistry;

  async function getInstalledApps(appsRoot: string): Promise<readonly RegisteredMiniApp[]> {
    return registry.getSnapshot(appsRoot);
  }

  async function buildAppRuntime(app: RegisteredMiniApp, appsRoot: string) {
    return runtimeBuildCache.build(app, appsRoot);
  }

  const sessionBindingByToken = new Map<string, LiveMiniAppSessionBinding>();
  const peekLiveSessionBinding =
    deps?.peekLiveSessionBinding ?? ((token: string) => sessionBindingByToken.get(token) ?? null);

  const getLocalDocumentAuthority =
    deps?.getLiveLocalDocumentAuthority ??
    (() => deps?.liveLocalDocumentAuthority ?? null);
  const registerHotAppTools =
    deps?.registerAppToolsForApp ?? registerAppToolsForApp;
  const hotAppToolRegistrationOptions = createLiveAppToolRegistrationOptions(
    getLocalDocumentAuthority,
  );
  const acceptedProposalInflight = new Map<
    string,
    {
      fingerprint: string;
      promise: Promise<
        | { ok: true; result: ApplyAcceptedLiveProposalResponse }
        | { ok: false; code: string }
      >;
    }
  >();

  type LiveReviewRouteContext = {
    appId: string;
    userId: string;
    envelope: NamespaceMemoryEnvelope;
  };

  const requireLiveReviewRouteContext = async (
    request: FastifyRequest<{ Params: { appId: string } }>,
    reply: FastifyReply,
  ): Promise<LiveReviewRouteContext | null> => {
    const installed = await getInstalledApps(resolveAppsRoot(deps));
    const installedApp = installed.find((entry) => entry.id === request.params.appId);
    if (
      !installedApp?.enabled ||
      !installedApp.manifest ||
      !isLiveReviewEnabled(installedApp.manifest)
    ) {
      reply.code(404).send({ error: "live session unavailable for app" });
      return null;
    }
    const userId = requireSessionUserId(request);
    const env = request.memoryEnvelope;
    if (!userId || !env) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    if (isScopeMemoryEnvelope(env) || env.ownerId !== userId) {
      reply.code(403).send({ error: "Live review session requires authorized namespace context" });
      return null;
    }
    return { appId: installedApp.id, userId, envelope: env };
  };

  const parseIssueLiveSessionRequest = (
    body: unknown,
  ): IssueLiveMiniAppSessionRequest | null => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const clientSessionId = (body as { clientSessionId?: unknown }).clientSessionId;
    if (clientSessionId !== undefined && (typeof clientSessionId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientSessionId))) return null;
    const issuanceToken = (body as { issuanceToken?: unknown }).issuanceToken;
    if (clientSessionId !== undefined && (typeof issuanceToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(issuanceToken))) return null;
    if (clientSessionId === undefined && issuanceToken !== undefined) return null;
    const cleanup = typeof clientSessionId === "string" && typeof issuanceToken === "string" ? { clientSessionId, issuanceToken } : {};
    const targetKind = (body as { targetKind?: unknown }).targetKind;
    const documentVersion = parseLiveDocumentVersion(
      (body as { documentVersion?: unknown }).documentVersion,
    );
    if (!documentVersion) return null;
    if (targetKind === "artifact") {
      const artifactId = (body as { artifactId?: unknown }).artifactId;
      const artifactVersion = parseArtifactDocumentVersion(documentVersion);
      if (typeof artifactId !== "string" || artifactId.length === 0 || !artifactVersion) {
        return null;
      }
      return { ...cleanup, targetKind: "artifact", artifactId, documentVersion: artifactVersion };
    }
    if (targetKind === "currentFile") {
      const relayIdHint = (body as { relayIdHint?: unknown }).relayIdHint;
      const currentFolder = (body as { currentFolder?: unknown }).currentFolder;
      const relativePath = (body as { relativePath?: unknown }).relativePath;
      const localVersion = parseHostLocalShaDocumentVersion(documentVersion);
      if (
        typeof relayIdHint !== "string" ||
        relayIdHint.length === 0 ||
        typeof currentFolder !== "string" ||
        currentFolder.length === 0 ||
        typeof relativePath !== "string" ||
        relativePath.length === 0 ||
        !localVersion
      ) {
        return null;
      }
      return {
        ...cleanup,
        targetKind: "currentFile",
        relayIdHint,
        currentFolder,
        relativePath,
        documentVersion: localVersion,
      };
    }
    return null;
  };

  const resolveArtifactLiveSessionBinding = async (
    request: FastifyRequest,
    reply: FastifyReply,
    route: LiveReviewRouteContext,
    issue: Extract<IssueLiveMiniAppSessionRequest, { targetKind: "artifact" }>,
  ): Promise<LiveMiniAppSessionArtifactBinding | null> => {
    const env = request.memoryEnvelope;
    if (!env) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    const namespaceIds = envelopeMutableNamespaces(env);
    const artifact = await findArtifactForNamespaces({
      internalId: issue.artifactId,
      readableNamespaceIds: namespaceIds,
    });
    if (!artifact) {
      reply.code(404).send({ error: "session_closed" });
      return null;
    }
    if (artifact.revision !== issue.documentVersion.revision) {
      reply.code(409).send({ error: "stale_version" });
      return null;
    }
    return {
      targetKind: "artifact",
      appId: route.appId,
      userId: route.userId,
      namespaceIds,
      artifactId: artifact.id,
      documentId: artifact.id,
      documentVersion: issue.documentVersion,
    };
  };

  const resolveCurrentFileLiveSessionBinding = async (
    reply: FastifyReply,
    route: LiveReviewRouteContext,
    issue: Extract<IssueLiveMiniAppSessionRequest, { targetKind: "currentFile" }>,
  ): Promise<LiveMiniAppSessionCurrentFileBinding | null> => {
    const localDocumentAuthority = getLocalDocumentAuthority();
    if (!localDocumentAuthority) {
      reply.code(503).send({ error: "relay_unavailable" });
      return null;
    }
    try {
      const resolved = await localDocumentAuthority.resolveCurrentFileIssue({
        appId: route.appId,
        userId: route.userId,
        relayIdHint: issue.relayIdHint,
        currentFolder: issue.currentFolder,
        relativePath: issue.relativePath,
        documentVersion: issue.documentVersion,
      });
      if (!resolved.ok) {
        const status =
          resolved.code === "stale_version"
            ? 409
            : resolved.code === "relay_unavailable"
              ? 503
              : 403;
        reply.code(status).send({ error: resolved.code });
        return null;
      }
      return resolved.binding;
    } catch {
      reply.code(503).send({ error: "relay_unavailable" });
      return null;
    }
  };

  const resolveLiveSessionIssueBinding = async (
    request: FastifyRequest<{ Params: { appId: string } }>,
    reply: FastifyReply,
    body: unknown,
  ): Promise<LiveMiniAppSessionBinding | null> => {
    const route = await requireLiveReviewRouteContext(request, reply);
    if (!route) return null;
    const issue = parseIssueLiveSessionRequest(body);
    if (!issue) {
      reply.code(400).send({ error: "invalid live session request" });
      return null;
    }
    if (issue.targetKind === "artifact") {
      return resolveArtifactLiveSessionBinding(request, reply, route, issue);
    }
    return resolveCurrentFileLiveSessionBinding(reply, route, issue);
  };

  const toRefreshExpected = (
    binding: LiveMiniAppSessionBinding,
  ): LiveMiniAppSessionRefreshExpected => {
    if (binding.targetKind === "artifact") {
      return {
        targetKind: "artifact",
        appId: binding.appId,
        userId: binding.userId,
        artifactId: binding.artifactId,
        documentId: binding.documentId,
      };
    }
    return {
      targetKind: "currentFile",
      appId: binding.appId,
      userId: binding.userId,
      localTargetId: binding.localTargetId,
    };
  };

  const resolveLiveSessionRefreshBinding = async (
    request: FastifyRequest<{ Params: { appId: string } }>,
    reply: FastifyReply,
    body: RefreshLiveMiniAppSessionRequest,
  ): Promise<{
    binding: LiveMiniAppSessionBinding;
    documentVersion: LiveDocumentVersion;
    token: string;
  } | null> => {
    const route = await requireLiveReviewRouteContext(request, reply);
    if (!route) return null;
    const token = body.sessionToken;
    if (typeof token !== "string" || token.length === 0) {
      reply.code(400).send({ error: "sessionToken is required" });
      return null;
    }
    const existing = peekLiveSessionBinding(token);
    if (!existing || existing.appId !== route.appId || existing.userId !== route.userId) {
      reply.code(409).send({ error: "session_closed" });
      return null;
    }
    if (body.targetKind === "artifact") {
      const artifactBinding = await resolveArtifactLiveSessionBinding(request, reply, route, body);
      if (!artifactBinding) return null;
      if (
        existing.targetKind !== "artifact" ||
        existing.artifactId !== artifactBinding.artifactId ||
        existing.documentId !== artifactBinding.documentId
      ) {
        reply.code(409).send({ error: "session_closed" });
        return null;
      }
      return { binding: artifactBinding, documentVersion: body.documentVersion, token };
    }
    const localDocumentAuthority = getLocalDocumentAuthority();
    if (!localDocumentAuthority) {
      reply.code(503).send({ error: "relay_unavailable" });
      return null;
    }
    if (existing.targetKind !== "currentFile") {
      reply.code(409).send({ error: "session_closed" });
      return null;
    }
    try {
      const refreshed = await localDocumentAuthority.refreshCurrentFileBinding({
        appId: route.appId,
        userId: route.userId,
        currentFolder: body.currentFolder,
        relativePath: body.relativePath,
        documentVersion: body.documentVersion,
        existing,
      });
      if (!refreshed.ok) {
        const status =
          refreshed.code === "stale_version"
            ? 409
            : refreshed.code === "relay_unavailable"
              ? 503
              : 403;
        reply.code(status).send({ error: refreshed.code });
        return null;
      }
      return {
        binding: refreshed.binding,
        documentVersion: body.documentVersion,
        token,
      };
    } catch {
      reply.code(503).send({ error: "relay_unavailable" });
      return null;
    }
  };

  app.get("/api/apps", async (request, reply) => {
    const userId = requireSessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const appsRoot = resolveAppsRoot(deps);
    const installed = await getInstalledApps(appsRoot);
    const canEdit = await canManageAppSource(userId, getCapabilities);
    const body = {
      apps: installed.map((entry) => toPublicMiniAppDto(entry, canEdit)),
    };
    const etag = appsListWeakETagFromProjection(registry.getGeneration(), body);
    return sendPrivateConditionalRead(request, reply, etag, body);
  });

  app.get<{ Params: { appId: string } }>("/api/apps/:appId", async (request, reply) => {
    const userId = requireSessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const appsRoot = resolveAppsRoot(deps);
    const installed = await getInstalledApps(appsRoot);
    const match = installed.find((entry) => entry.id === request.params.appId);
    if (!match) {
      return reply.code(404).send({ error: "app not found" });
    }

    const canEdit = await canManageAppSource(userId, getCapabilities);
    const body = toPublicMiniAppDto(match, canEdit);
    const etag = appsDetailWeakETagFromProjection(registry.getGeneration(), body);
    return sendPrivateConditionalRead(request, reply, etag, body);
  });

  app.get<{ Params: { appId: string } }>(
    "/api/apps/:appId/runtime",
    async (request, reply) => {
      const userId = requireSessionUserId(request);
      if (!userId) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const appsRoot = resolveAppsRoot(deps);
      const installed = await getInstalledApps(appsRoot);
      const match = installed.find((entry) => entry.id === request.params.appId);
      if (!match) {
        return reply.code(404).send({ error: "app not found" });
      }

      const build = await buildAppRuntime(match, appsRoot);
      if (!build.ok) {
        if (build.status === "invalid_manifest" || build.status === "needs_dependencies") {
          return reply.code(409).send({
            error: "app_runtime_unavailable",
            status: build.status,
            message: build.message,
          });
        }
        return reply.code(500).send({
          error: "app_runtime_unavailable",
          status: build.status,
          message: build.message,
        });
      }

      const srcDoc = buildMiniAppRuntimeSrcDoc({
        appId: build.appId,
        html: build.html,
        styles: build.styles,
        bundleJs: build.bundleJs,
      });

      const payload: MiniAppRuntimeDto = {
        appId: build.appId,
        sourceHash: build.sourceHash,
        srcDoc,
        agentToolsBuild: build.agentToolsBuild,
        manifest: toRuntimeManifestDto(build.manifest),
        ...((await hasFirstPartyAssetAuthority({
          appId: build.appId,
          appRoot: match.root,
          sourceHash: build.sourceHash,
        }))
          ? { hostCapabilities: { assets: true as const } }
          : {}),
      };

      const hostCapabilities = await (
        deps?.resolveHostCapabilities ?? resolveFirstPartyHostCapabilities
      )(match, build);
      if (hostCapabilities) payload.hostCapabilities = { ...payload.hostCapabilities, ...hostCapabilities };

      return payload;
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/video-host-attestation",
    async (request, reply) => {
      if (request.params.appId !== "nautilo-video") return reply.code(404).send({ error: "Not found" });
      const userId = requireSessionUserId(request);
      const env = request.memoryEnvelope;
      const body = request.body as { roomId?: unknown; projectArtifactId?: unknown; sourceHash?: unknown } | undefined;
      if (!userId || !env) return reply.code(401).send({ error: "Authentication required" });
      if (isScopeMemoryEnvelope(env) || env.ownerId !== userId || env.writableNamespaces.length !== 1 ||
          typeof body?.roomId !== "string" || body.roomId !== env.roomId ||
          typeof body.projectArtifactId !== "string" || typeof body.sourceHash !== "string" ||
          !/^[a-f0-9]{64}$/u.test(body.sourceHash)) return reply.code(404).send({ error: "Not found" });
      const appsRoot = resolveAppsRoot(deps);
      const installed = await getInstalledApps(appsRoot);
      const match = installed.find((entry) => entry.id === "nautilo-video");
      if (!match?.enabled || !match.manifest) return reply.code(404).send({ error: "Not found" });
      const build = await buildAppRuntime(match, appsRoot);
      if (!build.ok) return reply.code(409).send({ error: "Video runtime unavailable" });
      const capabilities = await (deps?.resolveHostCapabilities ?? resolveFirstPartyHostCapabilities)(match, build);
      if (capabilities?.videoGeneration !== true || body.sourceHash !== build.sourceHash) return reply.code(403).send({ error: "First-party Video runtime required" });
      const namespaceId = env.writableNamespaces[0]!;
      const artifact = await (deps?.findArtifactByIdForNamespaces ?? findArtifactByIdForNamespaces)({
        artifactId: body.projectArtifactId,
        readableNamespaceIds: [namespaceId],
      });
      if (!artifact || !artifact.path.endsWith(".video.html")) return reply.code(404).send({ error: "Not found" });
      const issued = videoAttestations.issue({
        userId, sourceHash: build.sourceHash, roomId: env.roomId, namespaceId,
        projectArtifactInternalId: artifact.id, projectArtifactId: artifact.artifactId, projectRevision: artifact.revision,
      });
      return reply.send({ attestationToken: issued.token, expiresAt: issued.expiresAt });
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/video-host-attestation/revoke",
    async (request, reply) => {
      if (request.params.appId !== "nautilo-video") return reply.code(404).send({ error: "Not found" });
      const userId = requireSessionUserId(request);
      if (!userId) return reply.code(401).send({ error: "Authentication required" });
      const token = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)["attestationToken"] : undefined;
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(token)) return reply.code(400).send({ error: "Malformed attestation token" });
      if (!videoAttestations.revokeForUser(token, userId)) return reply.code(404).send({ error: "Not found" });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/live-session/prepare",
    async (request, reply) => {
      const route = await requireLiveReviewRouteContext(request, reply);
      if (!route) return;
      const clientSessionId = request.body && typeof request.body === "object"
        ? (request.body as { clientSessionId?: unknown }).clientSessionId : undefined;
      if (typeof clientSessionId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientSessionId)) {
        return reply.code(400).send({ error: "invalid clientSessionId" });
      }
      return reply.send({ issuanceToken: sessionRegistry.prepareForClient(clientSessionId, route) });
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/live-session",
    async (request, reply) => {
      const binding = await resolveLiveSessionIssueBinding(request, reply, request.body);
      if (!binding) return;
      const preparation = parseIssueLiveSessionRequest(request.body);
      const issued = preparation?.clientSessionId && preparation.issuanceToken
        ? sessionRegistry.issueForClient(binding, preparation.clientSessionId, preparation.issuanceToken)
        : sessionRegistry.issue(binding);
      if (!issued) return reply.code(409).send({ error: "session_closed" });
      sessionBindingByToken.set(issued.token, binding);
      return reply.send({
        sessionToken: issued.token,
        sessionId: issued.sessionId,
        documentVersion: binding.documentVersion,
        expiresAt: issued.expiresAt,
      });
    },
  );

  // Exact-session, transient delivery. A disconnect consumes no later command;
  // no Room broadcast, durable job, media path or session token enters payloads.
  for (const operation of ["receive-command", "complete-command"] as const) {
    app.post<{ Params: { appId: string } }>(
      `/api/apps/:appId/live-session/${operation}`,
      async (request, reply) => {
        const route = await requireLiveReviewRouteContext(request, reply);
        if (!route) return;
        const extension = getLiveAppSessionExtension(route.appId);
        const policy = extension && isDirectMutationLiveReviewExtension(extension) ? extension.sessionCommands : undefined;
        if (!policy) return reply.code(404).send({ error: "unavailable" });
        const body = request.body as { sessionToken?: unknown; requestId?: unknown; result?: unknown } | null;
        if (!body || typeof body.sessionToken !== "string") return reply.code(400).send({ error: "invalid_request" });
        const open = sessionRegistry.validateOpenForSubject(body.sessionToken, { appId: route.appId, userId: route.userId });
        if (!open.ok) return reply.code(409).send({ error: "session_closed" });
        if (operation === "complete-command") {
          const result = policy.parseResult(body.result);
          if (typeof body.requestId !== "string" || !result) return reply.code(400).send({ error: "invalid_request" });
          return reply.send({ accepted: liveAppCommandBroker.complete(open.sessionId, body.requestId, result) });
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        reply.raw.once("close", abort);
        // This attempt may not outlive the already-issued session capability.
        const expiry = setTimeout(abort, Math.max(0, open.expiresAt - Date.now()));
        try {
          const command = await liveAppCommandBroker.listen(open.sessionId, controller.signal);
          const renewed = !command && controller.signal.aborted && sessionRegistry.validateOpenForSubject(body.sessionToken, {
            appId: route.appId, userId: route.userId,
          }).ok;
          return reply.send({ command, ...(renewed ? { renewed: true } : {}) });
        } finally {
          clearTimeout(expiry);
          reply.raw.removeListener("close", abort);
          controller.abort();
        }
      },
    );
  }

  type ParsedApplyAcceptedRequest = Omit<
    ApplyAcceptedLiveProposalRequest,
    "documentVersion"
  > & { documentVersion: LiveDocumentVersion };

  const parseApplyAcceptedRequest = (
    body: unknown,
  ): ParsedApplyAcceptedRequest | null => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const allowed = new Set([
      "requestId",
      "sessionToken",
      "proposalId",
      "documentVersion",
      "acceptedContent",
      "acceptedOperationIndexes",
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key))) return null;
    const opaqueId = (
      value: unknown,
      min: number,
      max: number,
    ): value is string =>
      typeof value === "string" &&
      value.length >= min &&
      value.length <= max &&
      /^[A-Za-z0-9_-]+$/.test(value);
    const documentVersion = parseLiveDocumentVersion(record["documentVersion"]);
    const indexes = record["acceptedOperationIndexes"];
    if (
      !opaqueId(record["requestId"], 1, 128) ||
      !opaqueId(record["sessionToken"], 32, 128) ||
      !opaqueId(record["proposalId"], 32, 128) ||
      !documentVersion ||
      typeof record["acceptedContent"] !== "string" ||
      !Array.isArray(indexes) ||
      indexes.length === 0 ||
      indexes.length > 10_000 ||
      !indexes.every((index) => Number.isSafeInteger(index) && (index as number) >= 0)
    ) {
      return null;
    }
    for (let position = 0; position < indexes.length; position++) {
      if (position > 0 && (indexes[position - 1] as number) >= (indexes[position] as number)) {
        return null;
      }
    }
    if (Buffer.byteLength(record["acceptedContent"], "utf8") > MAX_DOCUMENT_BYTES) {
      return null;
    }
    return {
      requestId: record["requestId"],
      sessionToken: record["sessionToken"],
      proposalId: record["proposalId"],
      documentVersion,
      acceptedContent: record["acceptedContent"],
      acceptedOperationIndexes: indexes as number[],
    };
  };

  const parseResolveReviewRequest = (
    body: unknown,
  ): ResolveLiveProposalReviewRequest | null => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const allowed = new Set([
      "sessionToken",
      "proposalId",
      "documentVersion",
      "outcome",
      "resultDocumentVersion",
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key))) return null;
    const sessionToken = record["sessionToken"];
    const proposalId = record["proposalId"];
    const documentVersion = parseLiveDocumentVersion(record["documentVersion"]);
    const outcome = record["outcome"];
    const resultDocumentVersion = record["resultDocumentVersion"] === undefined
      ? undefined
      : parseLiveDocumentVersion(record["resultDocumentVersion"]);
    if (
      typeof sessionToken !== "string" || sessionToken.length < 32 || sessionToken.length > 128 ||
      typeof proposalId !== "string" || proposalId.length < 32 || proposalId.length > 128 ||
      !documentVersion ||
      (outcome !== "accepted" && outcome !== "rejected") ||
      (outcome === "accepted" && !resultDocumentVersion) ||
      (outcome === "rejected" && resultDocumentVersion !== undefined)
    ) return null;
    return {
      sessionToken,
      proposalId,
      documentVersion,
      outcome,
      ...(resultDocumentVersion ? { resultDocumentVersion } : {}),
    };
  };

  const parseInvalidateReviewRequest = (
    body: unknown,
  ): InvalidateLiveProposalReviewRequest | null => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const allowed = new Set(["sessionToken", "proposalId", "documentVersion", "reason"]);
    if (Object.keys(record).some((key) => !allowed.has(key))) return null;
    const sessionToken = record["sessionToken"];
    const proposalId = record["proposalId"];
    const documentVersion = parseLiveDocumentVersion(record["documentVersion"]);
    const reason = record["reason"];
    if (
      typeof sessionToken !== "string" || sessionToken.length < 32 || sessionToken.length > 128 ||
      typeof proposalId !== "string" || proposalId.length < 32 || proposalId.length > 128 ||
      !documentVersion ||
      (reason !== "human_changed" && reason !== "stale_version" && reason !== "remote_changed" &&
        reason !== "session_closed" && reason !== "no_effective_change")
    ) return null;
    return { sessionToken, proposalId, documentVersion, reason };
  };

  const liveReviewInvalidationCode = (
    reason: InvalidateLiveProposalReviewRequest["reason"],
  ): string => `LIVE_WRITER_REVIEW_${reason.toUpperCase()}`;

  const acceptanceFailureStatus = (code: string): number => {
    if (code === "relay_unavailable") return 503;
    if (code === "local_target_forbidden") return 403;
    return 409;
  };

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/live-session/apply-accepted",
    { bodyLimit: MAX_DOCUMENT_BYTES + 256 * 1024 },
    async (request, reply) => {
      const route = await requireLiveReviewRouteContext(request, reply);
      if (!route) return;
      const rawAcceptedContent =
        request.body && typeof request.body === "object" && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)["acceptedContent"]
          : null;
      if (
        typeof rawAcceptedContent === "string" &&
        Buffer.byteLength(rawAcceptedContent, "utf8") > MAX_DOCUMENT_BYTES
      ) {
        return reply.code(413).send({ error: "payload_too_large" });
      }
      const body = parseApplyAcceptedRequest(request.body);
      if (!body) return reply.code(400).send({ error: "invalid_request" });

      const open = sessionRegistry.validateOpenForSubject(body.sessionToken, {
        appId: route.appId,
        userId: route.userId,
      });
      if (!open.ok) return reply.code(409).send({ error: "session_closed" });

      const proposal = sessionRegistry.lookupProposal({
        sessionId: open.sessionId,
        proposalId: body.proposalId,
        documentVersion: body.documentVersion,
      });
      if (!proposal.ok) {
        const code =
          proposal.code === "proposal_not_found" ||
          proposal.code === "acceptance_conflict"
            ? "proposal_closed"
            : proposal.code;
        return reply.code(acceptanceFailureStatus(code)).send({ error: code });
      }

      const submittedAcceptedBytes = Buffer.from(body.acceptedContent, "utf8");
      const acceptedContentSha256 = createHash("sha256")
        .update(submittedAcceptedBytes)
        .digest("hex");
      const cached = proposal.record.acceptance;
      if (cached) {
        const identical =
          cached.requestId === body.requestId &&
          cached.acceptedContentSha256 === acceptedContentSha256 &&
          cached.acceptedOperationIndexes.length ===
            body.acceptedOperationIndexes.length &&
          cached.acceptedOperationIndexes.every(
            (index, position) => index === body.acceptedOperationIndexes[position],
          );
        if (!identical) {
          return reply.code(409).send({ error: "proposal_closed" });
        }
        // The byte write may have committed before a renderer callback or
        // response was lost.  Re-enter the server-owned receipt/finalizer
        // path on an identical retry; this never writes the document again.
        if (liveReviewLifecycle) {
          const cachedProposal = {
            ownerId: route.userId,
            sessionId: open.sessionId,
            proposalId: body.proposalId,
            documentVersion: body.documentVersion,
          } satisfies LiveReviewLifecycleProposal;
          const admission = liveReviewLifecycle.admitAcceptedProposal(cachedProposal);
          if (admission.status === "invalidated") {
            // The canonical write and cache receipt already won. A terminal
            // Task may have removed its process-local binding before this
            // exact lost-response retry; that must not turn the saved result
            // into a false acceptance error or trigger another write. It also
            // must not leave Writer's only visible-review slot occupied by a
            // saved change whose Task can no longer verify it.
            sessionRegistry.completeProposalReview({
              sessionId: open.sessionId,
              proposalId: body.proposalId,
              outcome: "accepted",
            });
            return reply.send(cached.result);
          }
          try {
            if (admission.status === "pending") {
              const receipt = await liveReviewLifecycle.recordAcceptedReceipt({
                ...cachedProposal,
                resultDocumentVersion: cached.result.documentVersion,
              }, admission.binding);
              const advanced = receipt.status === "recorded" &&
                liveReviewLifecycle.advanceAcceptedReviewContinuation(
                  admission.binding,
                  cached.result.documentVersion,
                );
              const resolved = advanced
                ? liveReviewLifecycle.resolveReview({
                    ...cachedProposal,
                    resolution: {
                      outcome: "accepted",
                      documentVersion: cached.result.documentVersion,
                    },
                  })
                : liveReviewLifecycle.failAcceptedReviewContinuation(
                    admission.binding,
                    "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE",
                  );
              if (resolved.status === "resolved" && resolved.finalizeNow) {
                await liveReviewLifecycle.finalizeReview(resolved.binding);
              }
            }
          } finally {
            if (admission.status === "pending") {
              liveReviewLifecycle.releaseAcceptanceClaim(cachedProposal);
            }
          }
        }
        // The canonical-save receipt is already in the registry.  Do not
        // depend on a renderer callback to release Writer's one visible
        // review owner: an identical reconnect must be able to repair a
        // lost response without leaving the session permanently busy.
        sessionRegistry.completeProposalReview({
          sessionId: open.sessionId,
          proposalId: body.proposalId,
          outcome: "accepted",
        });
        return reply.send(cached.result);
      }

      if (proposal.record.turnId.length === 0) {
        return reply.code(409).send({ error: "stale_version" });
      }
      if (
        open.binding.targetKind === "currentFile" &&
        (body.documentVersion.kind !== "local_sha" ||
          open.binding.documentVersion.sha256 !== body.documentVersion.sha256)
      ) return reply.code(409).send({ error: "stale_version" });
      if (
        open.binding.targetKind === "artifact" &&
        (body.documentVersion.kind !== "artifact_revision" ||
          open.binding.documentVersion.revision !== body.documentVersion.revision)
      ) return reply.code(409).send({ error: "stale_version" });
      const acceptedSelection = validateAcceptedOperationSelection(
        body.acceptedOperationIndexes,
        proposal.record.operations.length,
        proposal.record.operationMetadata,
      );
      if (!acceptedSelection.ok) {
        return reply.code(409).send({ error: "acceptance_conflict" });
      }
      const selectedOperations = body.acceptedOperationIndexes.map(
        (index) => proposal.record.operations[index],
      );
      const inflightKey = `${open.sessionId}:${body.proposalId}`;
      const fingerprint = [
        body.requestId,
        JSON.stringify(body.documentVersion),
        acceptedContentSha256,
        body.acceptedOperationIndexes.join(","),
      ].join(":");
      const existingInflight = acceptedProposalInflight.get(inflightKey);
      if (existingInflight) {
        if (existingInflight.fingerprint !== fingerprint) {
          return reply.code(409).send({ error: "proposal_closed" });
        }
        const settled = await existingInflight.promise;
        return settled.ok
          ? reply.send(settled.result)
          : reply.code(acceptanceFailureStatus(settled.code)).send({ error: settled.code });
      }
      const acceptanceProposal = {
        ownerId: route.userId,
        sessionId: open.sessionId,
        proposalId: body.proposalId,
        documentVersion: body.documentVersion,
      } satisfies LiveReviewLifecycleProposal;
      const acceptanceAdmission = liveReviewLifecycle?.admitAcceptedProposal(acceptanceProposal)
        ?? { status: "not_task" as const };
      if (acceptanceAdmission.status === "invalidated") {
        return reply.code(409).send({ error: "proposal_closed" });
      }
      const currentBinding = open.binding;

      const operation = (async () => {
        const failSavedContinuation = async (): Promise<void> => {
          if (!liveReviewLifecycle || acceptanceAdmission.status !== "pending") return;
          const failed = liveReviewLifecycle.failAcceptedReviewContinuation(
            acceptanceAdmission.binding,
            "LIVE_WRITER_VERIFICATION_SESSION_UNAVAILABLE",
          );
          if (failed.status === "resolved" && failed.finalizeNow) {
            await liveReviewLifecycle.finalizeReview(failed.binding);
          }
        };
        const recordAcceptedReceipt = async (
          result: ApplyAcceptedLiveProposalResponse,
        ): Promise<boolean> => {
          if (!liveReviewLifecycle || acceptanceAdmission.status !== "pending") return true;
          const receipt = await liveReviewLifecycle.recordAcceptedReceipt({
            ownerId: route.userId,
            sessionId: open.sessionId,
            proposalId: body.proposalId,
            documentVersion: body.documentVersion,
            resultDocumentVersion: result.documentVersion,
          }, acceptanceAdmission.binding);
          return receipt.status === "recorded";
        };
        const continueAcceptedReview = async (
          result: ApplyAcceptedLiveProposalResponse,
        ): Promise<void> => {
          if (!liveReviewLifecycle || acceptanceAdmission.status !== "pending") return;
          if (!liveReviewLifecycle.advanceAcceptedReviewContinuation(
            acceptanceAdmission.binding,
            result.documentVersion,
          )) {
            await failSavedContinuation();
            return;
          }
          const resolved = liveReviewLifecycle.resolveReview({
            ownerId: route.userId,
            sessionId: open.sessionId,
            proposalId: body.proposalId,
            documentVersion: body.documentVersion,
            resolution: { outcome: "accepted", documentVersion: result.documentVersion },
          });
          if (resolved.status !== "resolved") {
            await failSavedContinuation();
            return;
          }
          if (resolved.finalizeNow) await liveReviewLifecycle.finalizeReview(resolved.binding);
        };
        const completeAcceptedProposal = (): void => {
          // This is called only after the canonical write has won. It closes
          // the accepted review even when later Task bookkeeping fails, and
          // is idempotent so renderer acknowledgement may safely follow.
          sessionRegistry.completeProposalReview({
            sessionId: open.sessionId,
            proposalId: body.proposalId,
            outcome: "accepted",
          });
        };
        const settleSavedAcceptance = async <T extends ApplyAcceptedLiveProposalResponse>(
          result: T,
          commitSessionPostimage: () => boolean,
        ): Promise<{ ok: true; result: T }> => {
          // A canonical Writer write has already won at this point. Lifecycle
          // bookkeeping can still fail (including a durable receipt/finalizer
          // race), but it must neither turn the HTTP result into a false
          // failed save nor retain Writer's single visible review owner.
          let failureFinalizationAttempted = false;
          const finalizeSavedFailure = async (): Promise<void> => {
            failureFinalizationAttempted = true;
            await failSavedContinuation();
          };
          try {
            // The session postimage is about canonical document identity, not
            // Task continuation. Once bytes have saved, attempt it even if
            // receipt recording/finalization is unavailable so the same open
            // Writer surface can begin its next review at the saved version.
            let receiptRecorded = false;
            let sessionPostimageCommitted = false;
            try {
              receiptRecorded = await recordAcceptedReceipt(result);
            } catch {
              // Continue to the session fence below; the Task failure is
              // finalized only after both independent post-save facts were
              // attempted.
            }
            try {
              sessionPostimageCommitted = commitSessionPostimage();
            } catch {
              // Fall through to the exact Task failure while preserving this
              // canonical save in the HTTP response.
            }
            if (!receiptRecorded || !sessionPostimageCommitted) {
              await finalizeSavedFailure();
              return { ok: true, result };
            }
            await continueAcceptedReview(result);
            return { ok: true, result };
          } catch {
            // The post-write Task lifecycle is authoritative for its own
            // truthful error. Preserve the canonical-write receipt for the
            // Human even if that finalizer itself is unavailable.
            if (!failureFinalizationAttempted) {
              try {
                await finalizeSavedFailure();
              } catch {
                // Do not let a second lifecycle failure misreport a canonical
                // document save as an HTTP acceptance failure.
              }
            }
            return { ok: true, result };
          } finally {
            // Idempotently release only this accepted proposal, including
            // receipt and finalizer failures, so the next Writer proposal is
            // not blocked behind a save that already won.
            try {
              completeAcceptedProposal();
            } catch {
              // Registry completion is contained: it must never falsify the
              // already-canonical save response.
            }
          }
        };
        if (currentBinding.targetKind === "artifact") {
          const artifactDocumentVersion = body.documentVersion;
          if (!acceptLiveArtifactProposal || artifactDocumentVersion.kind !== "artifact_revision") {
            return { ok: false as const, code: "relay_unavailable" };
          }
          // Resolve through the request's mutable namespaces immediately
          // before invoking the canonical Artifact writer.  The session's
          // artifact id is routing lineage only, never write authority.
          const writableArtifact = await findArtifactForNamespaces({
            internalId: currentBinding.artifactId,
            readableNamespaceIds: envelopeMutableNamespaces(route.envelope),
          });
          if (!writableArtifact) return { ok: false as const, code: "local_target_forbidden" };
          const clientMutationId = createLiveArtifactProposalClientMutationId({
            artifactInternalId: currentBinding.artifactId,
            sessionId: open.sessionId,
            proposalId: body.proposalId,
            requestId: body.requestId,
          });
          const workspaceOperationId = createWorkspaceEditorSnapshotOperationId({
            artifactId: currentBinding.artifactId,
            humanId: route.userId,
            clientMutationId,
          });
          const workspaceReservation = liveReviewLifecycle && acceptanceAdmission.status === "pending"
            ? await liveReviewLifecycle.reserveAcceptedWorkspaceOperation?.({
                ...acceptanceProposal,
                operationId: workspaceOperationId,
                clientMutationId,
                artifactInternalId: currentBinding.artifactId,
              }, acceptanceAdmission.binding)
            : undefined;
          if (
            workspaceReservation &&
            workspaceReservation.status !== "reserved" &&
            workspaceReservation.status !== "same"
          ) return { ok: false as const, code: "proposal_closed" };
          const releaseWorkspaceReservation = async (): Promise<void> => {
            if (
              !liveReviewLifecycle ||
              acceptanceAdmission.status !== "pending" ||
              !workspaceReservation
            ) return;
            await liveReviewLifecycle.releaseAcceptedWorkspaceOperation?.({
              ...acceptanceProposal,
              operationId: workspaceOperationId,
              clientMutationId,
              artifactInternalId: currentBinding.artifactId,
            }, acceptanceAdmission.binding);
          };
          const written = await acceptLiveArtifactProposal({
            envelope: route.envelope,
            binding: currentBinding,
            sessionId: open.sessionId,
            proposalId: body.proposalId,
            requestId: body.requestId,
            clientMutationId,
            documentVersion: artifactDocumentVersion,
            acceptedContent: body.acceptedContent,
            selectedOperations,
          });
          if (!written.ok) {
            // A transport/recovery-required outcome is deliberately unknown:
            // retain the reservation so retry/restart can prove the one D448
            // operation instead of risking a duplicate write.
            if (written.code !== "relay_unavailable") await releaseWorkspaceReservation();
            return written;
          }
          if (
            written.result.documentVersion.kind !== "artifact_revision" ||
            written.result.documentVersion.revision <= artifactDocumentVersion.revision
          ) return { ok: false as const, code: "stale_version" };
          return settleSavedAcceptance(written.result, () => {
            const committed = sessionRegistry.commitArtifactAcceptance(
              body.sessionToken,
              {
                sessionId: open.sessionId,
                proposalId: body.proposalId,
                documentVersion: artifactDocumentVersion,
              },
              {
                requestId: body.requestId,
                acceptedContentSha256,
                acceptedOperationIndexes: body.acceptedOperationIndexes,
                result: written.result,
              },
            );
            if (!committed.ok) return false;
            sessionBindingByToken.set(body.sessionToken, committed.binding);
            return true;
          });
        }
        const localDocumentVersion = body.documentVersion;
        if (localDocumentVersion.kind !== "local_sha") {
          return { ok: false as const, code: "stale_version" };
        }
        const authority = getLocalDocumentAuthority();
        if (!authority) return { ok: false as const, code: "relay_unavailable" };

        const canonical = await authority.readCurrentFileCanonical(currentBinding);
        if (!canonical.ok) {
          return { ok: false as const, code: canonical.status };
        }
        const extension = getLiveReviewExtension(route.appId);
        if (!extension) {
          return { ok: false as const, code: "acceptance_conflict" };
        }
        const verified = verifyAcceptedLiveReviewContent({
          canonicalContent: canonical.content,
          acceptedContent: body.acceptedContent,
          selectedOperations,
          extension,
        });
        if (!verified.ok) {
          return { ok: false as const, code: "acceptance_conflict" };
        }
        const canonicalAcceptedBytes = Buffer.from(verified.canonicalAcceptedContent, "utf8");

        const written = await authority.writeAccepted({
          binding: currentBinding,
          bytes: canonicalAcceptedBytes,
          agentId: proposal.record.agentId,
          turnId: proposal.record.turnId,
          clientMutationId: body.requestId,
        });
        if (!written.ok) return written;

        const result: ApplyAcceptedLiveProposalResponse = {
          documentVersion: { kind: "local_sha", sha256: written.sha256 },
          contentSha256: written.sha256,
          localRevisionRef: written.localRevisionRef,
        };
        return settleSavedAcceptance(result, () => {
          const committed = sessionRegistry.commitCurrentFileAcceptance(
            body.sessionToken,
            {
              sessionId: open.sessionId,
              proposalId: body.proposalId,
              documentVersion: localDocumentVersion,
            },
            {
              requestId: body.requestId,
              acceptedContentSha256,
              acceptedOperationIndexes: body.acceptedOperationIndexes,
              result,
            },
          );
          if (!committed.ok) return false;
          sessionBindingByToken.set(body.sessionToken, committed.binding);
          return true;
        });
      })();
      acceptedProposalInflight.set(inflightKey, { fingerprint, promise: operation });
      try {
        const settled = await operation;
        return settled.ok
          ? reply.send(settled.result)
          : reply.code(acceptanceFailureStatus(settled.code)).send({ error: settled.code });
      } finally {
        if (acceptedProposalInflight.get(inflightKey)?.promise === operation) {
          acceptedProposalInflight.delete(inflightKey);
        }
        if (acceptanceAdmission.status === "pending") {
          liveReviewLifecycle?.releaseAcceptanceClaim(acceptanceProposal);
        }
      }
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/live-session/reviews",
    async (request, reply) => {
      const route = await requireLiveReviewRouteContext(request, reply);
      if (!route) return;
      const token =
        request.body && typeof request.body === "object" && !Array.isArray(request.body)
          ? (request.body as { sessionToken?: unknown }).sessionToken
          : null;
      if (typeof token !== "string" || token.length < 32 || token.length > 128) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const open = sessionRegistry.validateOpenForSubject(token, {
        appId: route.appId,
        userId: route.userId,
      });
      if (!open.ok) return reply.code(409).send({ error: "session_closed" });
      const proposals = sessionRegistry
        .listProposalsForSession({
          sessionId: open.sessionId,
          documentVersion: open.binding.documentVersion,
        })
        .filter((proposal) => {
          const lifecycleProposal = {
            ownerId: route.userId,
            sessionId: open.sessionId,
            proposalId: proposal.proposalId,
            documentVersion: proposal.documentVersion,
          };
          const state = liveReviewLifecycle?.reviewProposalState?.(lifecycleProposal);
          if (state !== undefined) return state !== "closed";
          // Compatibility for composed ports that predate foreground replay:
          // no lifecycle port means the proposal is foreground-owned.
          return liveReviewLifecycle?.isPendingReview(lifecycleProposal) ?? true;
        })
        .map((proposal) => ({
          proposalId: proposal.proposalId,
          appId: route.appId,
          sessionId: proposal.sessionId,
          documentVersion: proposal.documentVersion,
          operations: [...proposal.deliveryOperations],
        }));
      const response: ListPendingLiveProposalReviewsResponse = { proposals };
      return reply.send(response);
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/live-session/resolve-review",
    async (request, reply) => {
      const route = await requireLiveReviewRouteContext(request, reply);
      if (!route) return;
      const body = parseResolveReviewRequest(request.body);
      if (!body) return reply.code(400).send({ error: "invalid_request" });
      const open = sessionRegistry.validateOpenForSubject(body.sessionToken, {
        appId: route.appId,
        userId: route.userId,
      });
      if (!open.ok) return reply.code(409).send({ error: "session_closed" });
      const validated = sessionRegistry.validateProposalReviewResolution({
        sessionId: open.sessionId,
        proposalId: body.proposalId,
        documentVersion: body.documentVersion,
        outcome: body.outcome,
        ...(body.resultDocumentVersion
          ? { resultDocumentVersion: body.resultDocumentVersion }
          : {}),
      });
      if (!validated.ok) return reply.code(409).send({ error: validated.code });
      const resolved = liveReviewLifecycle?.resolveReview({
        ownerId: route.userId,
        sessionId: open.sessionId,
        proposalId: body.proposalId,
        documentVersion: body.documentVersion,
        resolution: body.outcome === "accepted"
          ? { outcome: "accepted", documentVersion: body.resultDocumentVersion! }
          : { outcome: "rejected" },
      }) ?? { status: "not_found" as const };
      if (resolved.status === "conflict") {
        return reply.code(409).send({ error: "proposal_closed" });
      }
      // Accepted outcomes reach here only after the proposal registry has a
      // canonical-save receipt; rejection has no write receipt by definition.
      // The exact lifecycle outcome is recorded before the visible Writer
      // review slot is released.
      const completed = sessionRegistry.completeProposalReview({
        sessionId: open.sessionId,
        proposalId: body.proposalId,
        outcome: body.outcome,
      });
      if (!completed.ok) return reply.code(409).send({ error: completed.code });
      if (resolved.status === "not_found") {
        const response: ResolveLiveProposalReviewResponse = {
          ok: true,
          taskStatus: "not_task",
        };
        return reply.send(response);
      }
      if (resolved.finalizeNow) {
        await liveReviewLifecycle!.finalizeReview(resolved.binding);
      }
      const response: ResolveLiveProposalReviewResponse = {
        ok: true,
        taskStatus: resolved.finalizeNow
          ? body.outcome === "accepted" ? "pending" : "cancelled"
          : "running",
      };
      return reply.send(response);
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/live-session/invalidate-review",
    async (request, reply) => {
      const route = await requireLiveReviewRouteContext(request, reply);
      if (!route) return;
      const body = parseInvalidateReviewRequest(request.body);
      if (!body) return reply.code(400).send({ error: "invalid_request" });
      // An invalidation deliberately allows the current session binding to
      // have advanced: the supplied version is the immutable proposal base,
      // not a request to write that old document.
      const open = sessionRegistry.validateOpenForSubject(body.sessionToken, {
        appId: route.appId,
        userId: route.userId,
      });
      if (!open.ok) return reply.code(409).send({ error: "session_closed" });
      const validated = sessionRegistry.validateProposalReviewInvalidation({
        sessionId: open.sessionId,
        proposalId: body.proposalId,
        documentVersion: body.documentVersion,
      });
      if (!validated.ok) return reply.code(409).send({ error: validated.code });
      const proposal = {
        ownerId: route.userId,
        sessionId: open.sessionId,
        proposalId: body.proposalId,
        documentVersion: body.documentVersion,
      } satisfies LiveReviewLifecycleProposal;
      const resolved = liveReviewLifecycle?.failReview(
        proposal,
        liveReviewInvalidationCode(body.reason),
      ) ?? { status: "not_found" as const };
      if (resolved.status === "conflict") {
        return reply.code(409).send({ error: "proposal_closed" });
      }
      // Resolve the durable Task before releasing Writer's sole review owner.
      // The same exact invalidation may be replayed after a renderer callback
      // loss; registry completion and lifecycle resolution are both idempotent.
      const completed = sessionRegistry.completeProposalReview({
        sessionId: open.sessionId,
        proposalId: body.proposalId,
        outcome: "rejected",
      });
      if (!completed.ok) return reply.code(409).send({ error: completed.code });
      if (resolved.status === "resolved" && resolved.finalizeNow) {
        await liveReviewLifecycle!.finalizeReview(resolved.binding);
      }
      const response: InvalidateLiveProposalReviewResponse = {
        ok: true,
        taskStatus: resolved.status === "not_found"
          ? "not_task"
          : resolved.finalizeNow ? "failed" : "running",
      };
      return reply.send(response);
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/live-session/refresh",
    async (request, reply) => {
      const parsed = parseIssueLiveSessionRequest(request.body);
      if (!parsed) {
        return reply.code(400).send({ error: "invalid live session request" });
      }
      const token =
        request.body && typeof request.body === "object"
          ? (request.body as { sessionToken?: unknown }).sessionToken
          : null;
      if (typeof token !== "string" || token.length === 0) {
        return reply.code(400).send({ error: "sessionToken is required" });
      }
      const refreshBody = { ...parsed, sessionToken: token } satisfies RefreshLiveMiniAppSessionRequest;
      const resolved = await resolveLiveSessionRefreshBinding(request, reply, refreshBody);
      if (!resolved) return;
      const existing = peekLiveSessionBinding(resolved.token);
      if (!existing) {
        return reply.code(409).send({ error: "session_closed" });
      }
      const refreshed = sessionRegistry.refresh(
        resolved.token,
        resolved.documentVersion,
        toRefreshExpected(existing),
      );
      if (!refreshed.ok) return reply.code(409).send({ error: refreshed.code });
      sessionBindingByToken.set(resolved.token, refreshed.binding);
      return reply.send({
        sessionToken: resolved.token,
        sessionId: refreshed.sessionId,
        documentVersion: refreshed.binding.documentVersion,
        expiresAt: refreshed.expiresAt,
      });
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/live-session/revoke",
    async (request, reply) => {
      // Cleanup must remain available after an app is disabled/uninstalled.
      // Exact subject/session binding below grants no document access.
      const userId = requireSessionUserId(request);
      const env = request.memoryEnvelope;
      if (!userId || !env) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (isScopeMemoryEnvelope(env) || env.ownerId !== userId) {
        return reply.code(403).send({ error: "Live review session requires authorized namespace context" });
      }
      const clientSessionId = request.body && typeof request.body === "object"
        ? (request.body as { clientSessionId?: unknown }).clientSessionId : undefined;
      if (clientSessionId !== undefined) {
        if (typeof clientSessionId !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientSessionId)) {
          return reply.code(400).send({ error: "invalid clientSessionId" });
        }
        const finalize: Array<() => Promise<unknown>> = [];
        const tokens = sessionRegistry.cancelForClient(clientSessionId, { appId: request.params.appId, userId }, (sessionId) => {
          const failed = liveReviewLifecycle?.failReviewsForSession(sessionId, "LIVE_WRITER_REVIEW_SESSION_CLOSED") ?? [];
          for (const binding of failed) finalize.push(() => liveReviewLifecycle!.finalizeReview(binding));
        });
        for (const token of tokens) sessionBindingByToken.delete(token);
        for (const finish of finalize) await finish();
        return reply.send({ ok: true });
      }
      const token =
        request.body && typeof request.body === "object"
          ? (request.body as { sessionToken?: unknown }).sessionToken
          : null;
      if (typeof token !== "string" || token.length === 0) {
        return reply.code(400).send({ error: "sessionToken is required" });
      }
      const open = sessionRegistry.validateOpenForSubject(token, {
        appId: request.params.appId,
        userId,
      });
      if (!open.ok) return reply.code(409).send({ error: "session_closed" });
      const failed = liveReviewLifecycle?.failReviewsForSession(
        open.sessionId,
        "LIVE_WRITER_REVIEW_SESSION_CLOSED",
      ) ?? [];
      // Mark exact Task bindings terminal before registry revocation drops the
      // process-local proposal lineage. Finalization below is idempotent and
      // may safely race the model finishing its leg.
      const revoked = sessionRegistry.revokeForSubject(token, {
        appId: request.params.appId,
        userId,
      });
      if (!revoked) return reply.code(409).send({ error: "session_closed" });
      sessionBindingByToken.delete(token);
      for (const binding of failed) {
        await liveReviewLifecycle!.finalizeReview(binding);
      }
      return reply.send({ ok: true });
    },
  );

  // M205 — generic, format-agnostic conversion invocation. Both the UI and the
  // agent drive the SAME deployed conversion tool; this route is the UI's entry
  // point. Verified session only (no manage_server_settings). The referenced
  // tool + the office.run host primitive enforce capability + zone gates.
  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/conversions/run",
    // Prepared binary exports share the deployed worker wire capacity. The
    // worker still checks its complete JSON envelope before starting execution.
    { bodyLimit: APP_TOOL_MAX_MESSAGE_BYTES },
    async (request, reply) => {
      const userId = requireSessionUserId(request);
      if (!userId) return reply.code(401).send({ error: "unauthorized" });
      const env = request.memoryEnvelope;
      if (!env) return reply.code(401).send({ error: "Authentication required" });
      if (isScopeMemoryEnvelope(env)) {
        return reply.code(501).send({ error: "Scope-restricted sessions cannot run conversions." });
      }
      const ownerId = env.ownerId;
      const agentId = env.agentId;
      if (!ownerId || !agentId) return reply.code(403).send({ error: "Agent context required" });

      const body = (request.body ?? {}) as Record<string, unknown>;
      const actionId = typeof body["actionId"] === "string" ? body["actionId"] : "";
      const direction = body["direction"];
      const overwrite = body["overwrite"] === true;
      const acknowledgedSourceSha256 = body["acknowledgedSourceSha256"];
      const preparedExport = body["preparedExport"];
      const workspaceDestination = body["workspaceDestination"];
      const roomId = body["roomId"];
      if (!actionId) return reply.code(400).send({ error: "actionId is required" });
      if (
        acknowledgedSourceSha256 !== undefined &&
        (typeof acknowledgedSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(acknowledgedSourceSha256))
      ) {
        return reply.code(400).send({ error: "acknowledgedSourceSha256 must be a lowercase SHA-256" });
      }
      if (direction !== "import" && direction !== "export") {
        return reply.code(400).send({ error: 'direction must be "import" or "export"' });
      }
      if (roomId !== undefined && (typeof roomId !== "string" || !isUuidString(roomId))) {
        return reply.code(400).send({ error: "roomId must be a valid room id" });
      }
      if (typeof roomId === "string" && env.roomId !== roomId) {
        return reply.code(403).send({ error: "Requested room context is unavailable" });
      }

      const source = body["source"];
      const sourceSurface = (source as { surface?: unknown } | null)?.surface;
      const sourcePath = (source as { path?: unknown } | null)?.path;
      if (
        !source ||
        typeof source !== "object" ||
        (sourceSurface !== "workspace" && sourceSurface !== "currentFolder") ||
        typeof sourcePath !== "string" ||
        sourcePath.length === 0
      ) {
        return reply.code(400).send({ error: "source must be { surface, path }" });
      }

      const target = body["target"];
      const targetSurface = (target as { surface?: unknown } | null)?.surface;
      const targetPathRaw = (target as { path?: unknown } | null)?.path;

      let currentFolder: string | null = null;
      let workspacePath: string | null = null;
      try {
        currentFolder = validateClientPath(
          typeof body["currentFolder"] === "string" ? body["currentFolder"] : null,
          "currentFolder",
        );
        workspacePath = validateClientPath(
          typeof body["workspacePath"] === "string" ? body["workspacePath"] : null,
          "workspacePath",
        );
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }

      const appsRoot = resolveAppsRoot(deps);
      const installed = await getInstalledApps(appsRoot);
      const match = installed.find((entry) => entry.id === request.params.appId);
      if (!match || !match.manifest) return reply.code(404).send({ error: "app not found" });
      if (!match.enabled) return reply.code(403).send({ error: "app disabled" });

      const conversions = match.manifest.conversions;
      let toolId: string;
      let toolArgs: unknown;
      if (direction === "import") {
        if (workspaceDestination !== undefined) return reply.code(400).send({ error: "Imports cannot select an export destination" });
        if (preparedExport !== undefined) return reply.code(400).send({ error: "Imports cannot accept prepared exports" });
        if (body["scope"] !== undefined) {
          return reply.code(400).send({ error: "scope is only supported by Nautilo Design image export" });
        }
        const entry = conversions?.import?.find((e) => e.id === actionId);
        if (!entry) {
          return reply.code(404).send({ error: `unknown import conversion: ${actionId}` });
        }
        if (!entry.sourceSurfaces.includes(sourceSurface)) {
          return reply
            .code(400)
            .send({ error: `source.surface "${sourceSurface}" not allowed for "${actionId}"` });
        }
        toolId = entry.tool;
        const resolvedTargetPath =
          typeof targetPathRaw === "string" && targetPathRaw.length > 0
            ? targetPathRaw
            : deriveConversionTargetPath(sourcePath, entry.target.extension);
        toolArgs = {
          source: { surface: sourceSurface, path: sourcePath },
          targetPath: resolvedTargetPath,
          overwrite,
          ...(typeof acknowledgedSourceSha256 === "string" ? { acknowledgedSourceSha256 } : {}),
        };
      } else {
        const entry = conversions?.export?.find((e) => e.id === actionId);
        if (!entry) {
          return reply.code(404).send({ error: `unknown export conversion: ${actionId}` });
        }
        if (
          (targetSurface !== "workspace" && targetSurface !== "currentFolder") ||
          typeof targetPathRaw !== "string" ||
          targetPathRaw.length === 0
        ) {
          return reply.code(400).send({ error: "target must be { surface, path } for export" });
        }
        if (!entry.targetSurfaces.includes(targetSurface)) {
          return reply
            .code(400)
            .send({ error: `target.surface "${targetSurface}" not allowed for "${actionId}"` });
        }
        if (workspaceDestination !== undefined && (
          entry.selectWorkspaceDestination !== true || sourceSurface !== "workspace" || targetSurface !== "workspace" ||
          (workspaceDestination !== "current" && workspaceDestination !== "source")
        )) {
          return reply.code(400).send({ error: "This action does not accept that workspace destination" });
        }
        if (entry.prepareInApp === true) {
          if (!preparedExport || typeof preparedExport !== "object" || Array.isArray(preparedExport)) {
            return reply.code(400).send({ error: "This export must be prepared in the open app" });
          }
          const prepared = preparedExport as Record<string, unknown>;
          if (prepared["mimeType"] !== entry.to.mimeType || prepared["encoding"] !== "base64" ||
            typeof prepared["content"] !== "string" || typeof prepared["sourceSha256"] !== "string" ||
            !/^[a-f0-9]{64}$/.test(prepared["sourceSha256"]) || !Array.isArray(prepared["warnings"]) ||
            !prepared["warnings"].every((warning: unknown) => typeof warning === "string")) {
            return reply.code(400).send({ error: "Invalid prepared export" });
          }
          const bytes = Buffer.from(prepared["content"], "base64");
          if (!bytes.length || bytes.toString("base64") !== prepared["content"] || bytes.length !== prepared["byteLength"]) {
            return reply.code(400).send({ error: "Incomplete prepared export bytes" });
          }
        } else if (preparedExport !== undefined) {
          return reply.code(400).send({ error: "This action does not accept prepared exports" });
        }
        toolId = entry.tool;
        let scope: DesignExportScope | undefined;
        if (body["scope"] !== undefined) {
          if (
            match.id !== "nautilo-design" ||
            (toolId !== "export-svg" && toolId !== "export-png")
          ) {
            return reply.code(400).send({ error: "scope is only supported by Nautilo Design image export" });
          }
          const parsedScope = parseDesignExportScope(body["scope"]);
          if ("error" in parsedScope) return reply.code(400).send({ error: parsedScope.error });
          scope = parsedScope;
        }
        toolArgs = {
          source: { surface: sourceSurface, path: sourcePath },
          target: { surface: targetSurface, path: targetPathRaw },
          overwrite,
          ...(typeof acknowledgedSourceSha256 === "string" ? { acknowledgedSourceSha256 } : {}),
          ...(scope ? { scope } : {}),
          ...(preparedExport !== undefined ? { preparedExport } : {}),
          ...(workspaceDestination !== undefined ? { workspaceDestination } : {}),
        };
      }

      const build = await buildAppRuntime(match, appsRoot);
      if (!build.ok || build.agentToolsBuild.status !== "ok") {
        return reply.code(500).send({ error: "app_runtime_unavailable" });
      }
      const toolManifest = (build.manifest.agent?.tools ?? []).find((t) => t.id === toolId);
      if (!toolManifest) {
        return reply.code(500).send({ error: `conversion tool not found: ${toolId}` });
      }
      const bundlePath = join(build.cacheDir, build.agentToolsBuild.outputFile);

      const context: AppToolRunnerContext = {
        ownerId,
        userId,
        agentId,
        memoryAccessEnvelope: env,
        ...(currentFolder ? { currentFolder } : {}),
        ...(workspacePath ? { workspacePath } : {}),
      };

      const result = await invokeAppToolForRoute({
        appId: match.id,
        appRoot: match.root,
        appsRoot,
        sourceHash: build.sourceHash,
        cacheDir: build.cacheDir,
        bundlePath,
        manifest: build.manifest,
        tool: toolManifest,
        args: toolArgs,
        context,
      });

      if (!result.ok) {
        if (direction === "export") {
          const recovered = recoveredConversionResult(
            match.id,
            toolId,
            { surface: targetSurface as "workspace" | "currentFolder", path: targetPathRaw as string },
            (toolArgs as { scope?: DesignExportScope }).scope,
            result,
          );
          if (recovered) return reply.send({ ok: true, result: recovered });
        }
        return reply.code(422).send(conversionFailureBody(result));
      }
      return reply.send({ ok: true, result: result.result });
    },
  );

  app.get<{ Params: { appId: string; actionId: string } }>(
    "/api/apps/:appId/create-templates/:actionId",
    async (request, reply) => {
      const userId = requireSessionUserId(request);
      if (!userId) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      const appsRoot = resolveAppsRoot(deps);
      const installed = await getInstalledApps(appsRoot);
      const match = installed.find((entry) => entry.id === request.params.appId);
      if (!match?.manifest) {
        return reply.code(404).send({ error: "app not found" });
      }
      const action = (match.manifest.createActions ?? []).find(
        (entry) => entry.id === request.params.actionId,
      );
      if (!action) {
        return reply.code(404).send({ error: "create action not found" });
      }

      try {
        const file = await readAppSourceFile(appsRoot, match.id, action.template.path);
        return {
          appId: match.id,
          actionId: action.id,
          content: file.content,
          mimeType: action.mimeType,
          sha256: file.sha256,
        } satisfies MiniAppCreateTemplateDto;
      } catch (err) {
        if (err instanceof AppSourcePathError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof AppSourceNotFoundError || err instanceof AppSourceNotFileError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof AppSourceTooLargeError) {
          return reply.code(413).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { appId: string } }>(
    "/api/apps/:appId/source/tree",
    async (request, reply) => {
      if (!(await requireManageAppSourceAccess(request, reply, getCapabilities))) {
        return;
      }

      const appsRoot = resolveAppsRoot(deps);
      try {
        const files = await listAppSourceTree(appsRoot, request.params.appId);
        return { files };
      } catch (err) {
        if (err instanceof AppNotFoundError) {
          return reply.code(404).send({ error: "app not found" });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { appId: string }; Querystring: { path?: string } }>(
    "/api/apps/:appId/source/file",
    async (request, reply) => {
      if (!(await requireManageAppSourceAccess(request, reply, getCapabilities))) {
        return;
      }

      const relPath = parseSourceFilePathQuery(request.query);
      if (relPath === null) {
        return reply.code(400).send({ error: "path query parameter is required" });
      }

      const appsRoot = resolveAppsRoot(deps);
      try {
        return await readAppSourceFile(appsRoot, request.params.appId, relPath);
      } catch (err) {
        if (err instanceof AppNotFoundError) {
          return reply.code(404).send({ error: "app not found" });
        }
        if (err instanceof AppSourcePathError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof AppSourceNotFoundError) {
          return reply.code(404).send({ error: "file not found" });
        }
        if (err instanceof AppSourceNotFileError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof AppSourceTooLargeError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { appId: string }; Querystring: { path?: string } }>(
    "/api/apps/:appId/source/file",
    { bodyLimit: 256 * 1024 },
    async (request, reply) => {
      if (!(await requireManageAppSourceAccess(request, reply, getCapabilities))) {
        return;
      }

      const relPath = parseSourceFilePathQuery(request.query);
      if (relPath === null) {
        return reply.code(400).send({ error: "path query parameter is required" });
      }

      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return reply.code(400).send({ error: "request body must be a JSON object" });
      }
      const content = (body as { content?: unknown }).content;
      const baseSha256 = (body as { baseSha256?: unknown }).baseSha256;
      if (typeof content !== "string") {
        return reply.code(400).send({ error: "content must be a string" });
      }
      if (typeof baseSha256 !== "string" || baseSha256.length === 0) {
        return reply.code(400).send({ error: "baseSha256 is required" });
      }

      const appsRoot = resolveAppsRoot(deps);
      try {
        const result = await writeAppSourceFile(
          appsRoot,
          request.params.appId,
          relPath,
          content,
          baseSha256,
        );

        publishAppSourceEvent({
          type: "changed",
          appId: request.params.appId,
          sourceHash: result.sourceHash,
        });
        if (result.status === "invalid_manifest" || result.status === "needs_dependencies") {
          publishAppSourceEvent({
            type: "status",
            appId: request.params.appId,
            status: result.status,
          });
        }
        try {
          await registerHotAppTools(
            appsRoot,
            request.params.appId,
            hotAppToolRegistrationOptions,
          );
        } catch (err) {
          warn(
            `[app-tools] source-save refresh failed for ${request.params.appId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        return result;
      } catch (err) {
        if (err instanceof AppNotFoundError) {
          return reply.code(404).send({ error: "app not found" });
        }
        if (err instanceof AppSourcePathError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof AppSourceNotFileError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof AppSourceTooLargeError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof AppSourceConflictError) {
          return reply.code(409).send({
            error: "conflict",
            currentSha256: err.currentSha256,
          });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/disable",
    async (request, reply) => {
      if (!(await requireManageAppSourceAccess(request, reply, getCapabilities))) {
        return;
      }

      const appsRoot = resolveAppsRoot(deps);
      const installed = await getInstalledApps(appsRoot);
      const match = installed.find((entry) => entry.id === request.params.appId);
      if (!match) {
        return reply.code(404).send({ error: "app not found" });
      }

      try {
        await setAppDisabled(appsRoot, request.params.appId, true);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : "invalid app id",
        });
      }

      try {
        await registerHotAppTools(
          appsRoot,
          request.params.appId,
          hotAppToolRegistrationOptions,
        );
      } catch (err) {
        warn(
          `[app-tools] disable refresh failed for ${request.params.appId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const refreshed = await getInstalledApps(appsRoot);
      const updated = refreshed.find((entry) => entry.id === request.params.appId);
      if (!updated) {
        return reply.code(404).send({ error: "app not found" });
      }
      const canEdit = await canManageAppSource(
        requireSessionUserId(request) ?? "",
        getCapabilities,
      );
      return toPublicMiniAppDto(updated, canEdit);
    },
  );

  app.post<{ Params: { appId: string } }>(
    "/api/apps/:appId/enable",
    async (request, reply) => {
      if (!(await requireManageAppSourceAccess(request, reply, getCapabilities))) {
        return;
      }

      const appsRoot = resolveAppsRoot(deps);
      const installed = await getInstalledApps(appsRoot);
      const match = installed.find((entry) => entry.id === request.params.appId);
      if (!match) {
        return reply.code(404).send({ error: "app not found" });
      }

      try {
        await setAppDisabled(appsRoot, request.params.appId, false);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : "invalid app id",
        });
      }

      try {
        await registerHotAppTools(
          appsRoot,
          request.params.appId,
          hotAppToolRegistrationOptions,
        );
      } catch (err) {
        warn(
          `[app-tools] enable refresh failed for ${request.params.appId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const refreshed = await getInstalledApps(appsRoot);
      const updated = refreshed.find((entry) => entry.id === request.params.appId);
      if (!updated) {
        return reply.code(404).send({ error: "app not found" });
      }
      const canEdit = await canManageAppSource(
        requireSessionUserId(request) ?? "",
        getCapabilities,
      );
      return toPublicMiniAppDto(updated, canEdit);
    },
  );

  app.get("/api/apps/events", async (request, reply) => {
    const userId = requireSessionUserId(request);
    if (!userId) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const writeEvent = (payload: { type: string }) => {
      reply.raw.write(`event: ${payload.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const unsubscribe = subscribeAppSourceEvents((event) => {
      writeEvent(event);
    });

    reply.raw.write(": connected\n\n");

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": keepalive\n\n");
      } catch {
        /* ignore */
      }
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
