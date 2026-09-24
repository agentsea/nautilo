/**
 * M088C Phase 1 — envelope-gated workspace artifact HTTP API + SSE.
 *
 * Delete visibility for SSE uses namespace id snapshots on the bus payload
 * (§1.8 option b) so subscribers filter without re-querying soft-deleted rows.
 */

import { workspaceSharingRoutes, type WorkspaceSharingService } from "./workspace-sharing";

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { join, dirname, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getArtifactsRoot } from "@nautilo/config";
import {
  attachArtifactToNamespace,
  findArtifactByInternalIdForNamespaces,
  findArtifactByIdForNamespaces,
  findArtifactByPathForNamespaces,
  getArtifactNamespaces,
  getArtifactStateForNamespaces,
  getNamespacesForArtifactIds,
  insertArtifact,
  listArtifactPageForNamespaces,
  listArtifactsForNamespaces,
  listDiscussionRoomsForArtifact,
  markArtifactDeleted,
  setArtifactState,
  createDiscussionRoomForArtifact,
  appendPendingArtifactEvent,
  findOpenPingTask,
  updateArtifactPath,
  type AppendPendingArtifactEventResult,
  type Artifact,
} from "@nautilo/db";
import {
  ATTACHMENT_POLICY,
  classifyArtifactUpload,
  mimeFromExtensionOr,
} from "@nautilo/attachments";
import { warn } from "@nautilo/logger";
import {
  createTask as runtimeCreateTask,
  createArtifactEventTaskCreationProvenance,
  eventBus,
  getPlaintextTaskCreationAdmission,
  getMaintenanceGate,
  getTaskObserver,
} from "@nautilo/runtime";
import { getServerDirectDb } from "../lib/server-direct-db";
import type { ServerEvent, DocumentPatchRequest, DocumentPatchRejected } from "@nautilo/types";
import { validateWorkspaceLogicalPath as validateLogicalPath } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import {
  envelopeFactsForArtifacts,
  type WorkspaceArtifactCreatedSink,
} from "@nautilo/agent";
import { sendPrivateConditionalRead } from "../http/conditional-http";
import {
  artifactListScopeGenerationDigest,
  ensureWorkspaceArtifactListGenerationSubscription,
} from "../lib/workspace-artifact-list-generation";
import { workspaceArtifactListWeakETagFromProjection } from "../lib/workspace-artifacts-conditional-http";
import {
  envelopeMutableNamespaces,
  envelopeReadableNamespaces,
  envelopeWritableNamespaces,
  isScopeMemoryEnvelope,
  findPersonalAgentsForUser,
  findAgentActorForAgent,
  isUuidString,
} from "@nautilo/trust";
import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy";
import {
  saveWorkspaceEditorPatch,
  saveWorkspaceEditorSnapshot,
} from "../document-mutations/workspace-editor-save-service";
import { requestWorkspaceDocumentMutationOutboxPump } from "../document-mutations/workspace-document-mutation-runtime";
import { readWorkspaceAuthoredChange } from "../document-mutations/workspace-authored-change";
import {
  requireAgentInvocation,
  type AssertCanInvokeAgent,
} from "../lib/agent-invocation-admission";
import {
  requireArtifactWrite,
  type AssertCanWriteArtifacts,
} from "../lib/artifact-write-admission";
import {
  isMaintenanceDrainError,
  replyMaintenanceRejection,
} from "../lib/maintenance-rejection";

const SCOPE_REJECTION_MESSAGE =
  "Artifact scope mode is not implemented yet; use namespace context or wait for M088 Phase 4.";
const ARTIFACT_KEYSET_PAGINATION = "keyset_v1";

type ArtifactListCursor = Readonly<{
  v: 1;
  scope: string;
  snapshotAt: string;
  createdAt: string;
  id: string;
}>;

function encodeArtifactListCursor(cursor: ArtifactListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeArtifactListCursor(raw: string): ArtifactListCursor | null {
  if (raw.length === 0) return null;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== raw) return null;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "createdAt,id,scope,snapshotAt,v" ||
      value["v"] !== 1 ||
      typeof value["scope"] !== "string" ||
      value["scope"].length === 0 ||
      typeof value["snapshotAt"] !== "string" ||
      typeof value["createdAt"] !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value["createdAt"]) ||
      typeof value["id"] !== "string" ||
      !isUuidString(value["id"])
    ) return null;
    // Date truncates PostgreSQL microseconds; validate its millisecond prefix
    // while keeping the original six-digit timestamp for the keyset comparison.
    const createdAtMillis = value["createdAt"].slice(0, -4) + "Z";
    const createdAt = new Date(createdAtMillis);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== createdAtMillis) {
      return null;
    }
    const snapshotAt = new Date(value["snapshotAt"]);
    if (!Number.isFinite(snapshotAt.getTime()) || snapshotAt.toISOString() !== value["snapshotAt"]) {
      return null;
    }
    const cursor = value as ArtifactListCursor;
    return encodeArtifactListCursor(cursor) === raw ? cursor : null;
  } catch {
    return null;
  }
}

export const WORKSPACE_EDITOR_RECOVERY_RESPONSE = Object.freeze({
  error: "recovery_required" as const,
  retryable: true as const,
  message:
    "Mutation outcome requires recovery. Retry with identical requestId and clientMutationId values, including any omitted value.",
});

function uploadCapBytes(): number {
  const raw = process.env["NAUTILO_ARTIFACT_UPLOAD_MAX_MB"];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  // Uploads are streamed to disk. An explicit operator policy still applies;
  // do not impose a second implicit media-size quota when none was configured.
  return Number.isFinite(n) && n > 0 ? n * 1024 * 1024 : Infinity;
}

/**
 * D362 — blank-document templates for `POST /api/office/new`. Each kind maps
 * to a committed OOXML template minted by LibreOffice, its file extension,
 * MIME type, and the LibreOffice-style default "Untitled …" base name.
 */
const OFFICE_TEMPLATE_SPECS: Record<
  string,
  { templateFile: string; ext: string; mimeType: string; defaultBase: string }
> = {
  writer: {
    templateFile: "blank.docx",
    ext: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    defaultBase: "Untitled Document",
  },
  calc: {
    templateFile: "blank.xlsx",
    ext: "xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    defaultBase: "Untitled Spreadsheet",
  },
  impress: {
    templateFile: "blank.pptx",
    ext: "pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    defaultBase: "Untitled Presentation",
  },
};

/** Absolute path to a committed office template asset. */
function officeTemplatePath(templateFile: string): string {
  return join(import.meta.dir, "..", "..", "assets", "office-templates", templateFile);
}

function rowToDto(row: Artifact, namespaceIds: string[], mutableNamespaceIds: readonly string[]) {
  return {
    id: row.id,
    artifactId: row.artifactId,
    path: row.path,
    mimeType: row.mimeType ?? "application/octet-stream",
    size: row.size ?? 0,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    namespaceIds,
    canWrite: namespaceIds.some((namespaceId) => mutableNamespaceIds.includes(namespaceId)),
  };
}

function absPathFromStorageUri(storageUri: string): string | null {
  if (!storageUri.startsWith("file://")) return null;
  const rest = storageUri.slice("file://".length);
  if (!rest.startsWith("/")) return null;
  return rest;
}

/** D356 — bulk zip export caps (in-memory zipSync; keep bounded). */
const EXPORT_MAX_FILES = 200;
const EXPORT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/**
 * HTTP body cap for the text-artifact save (`PUT /content`) and patch
 * (`POST /patch`) routes. Sized above the `USER_SAVE_TEXT_LIMIT_BYTES` content
 * cap (50 MB, the officecli `.docx` ceiling) with headroom for the JSON patch
 * envelope + escaping, so office/Writer documents with inline images aren't
 * rejected at the HTTP layer before the content-cap check runs.
 */
const ARTIFACT_SAVE_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * D356 — make a zip entry name from a logical artifact path, preserving folder
 * structure but de-duping collisions within the batch (`foo.md`, `foo (2).md`).
 */
function uniqueZipEntryName(logicalPath: string, used: Set<string>): string {
  const name = logicalPath.replace(/^\/+/, "") || "artifact";
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  let candidate = `${base} (${i})${ext}`;
  while (used.has(candidate)) {
    i += 1;
    candidate = `${base} (${i})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

function parseRangeHeader(
  rangeHeader: string | undefined,
  fileSize: number,
): { ok: true; start: number; end: number } | { ok: false; status: 416 } | { ok: false; status: 400 } {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return { ok: false, status: 400 };
  }
  const spec = rangeHeader.slice("bytes=".length).trim();
  const dash = spec.indexOf("-");
  if (dash < 0) return { ok: false, status: 400 };
  const startStr = spec.slice(0, dash).trim();
  const endStr = spec.slice(dash + 1).trim();
  let start: number;
  let end: number;
  if (startStr === "") {
    if (endStr === "") return { ok: false, status: 400 };
    const suffixLen = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { ok: false, status: 400 };
    start = Math.max(0, fileSize - suffixLen);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    if (!Number.isFinite(start) || start < 0) return { ok: false, status: 400 };
    if (endStr === "") {
      end = fileSize - 1;
    } else {
      end = Number.parseInt(endStr, 10);
      if (!Number.isFinite(end) || end < 0) return { ok: false, status: 400 };
    }
  }
  if (start >= fileSize || end < start) {
    return { ok: false, status: 416 };
  }
  end = Math.min(end, fileSize - 1);
  return { ok: true, start, end };
}

function isMultipartTooLarge(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const o = err as { statusCode?: number; code?: string };
  return o.statusCode === 413 || o.code === "FST_REQ_FILE_TOO_LARGE";
}

function parseIfMatchRevision(header: string | undefined): number | null {
  if (header === undefined || header.length === 0) return null;
  const trimmed = header.trim().replace(/^W\//i, "");
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

function readUtf8TextBody(body: unknown): string | null {
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return null;
}

function parseCheckpointHeader(header: string | string[] | undefined): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  return raw === "1";
}

function parseBaseSha256Header(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.length === 0) return null;
  return raw.trim();
}

function parseContentTypeMime(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.length === 0) return undefined;
  const semi = raw.indexOf(";");
  const base = (semi >= 0 ? raw.slice(0, semi) : raw).trim();
  return base.length > 0 ? base : undefined;
}

export function parseDocumentPatchRequestBody(
  body: unknown,
): { ok: true; request: DocumentPatchRequest } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "JSON body required" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b["requestId"] !== "string" || b["requestId"].length === 0) {
    return { ok: false, reason: "requestId is required" };
  }
  if (typeof b["baseSha256"] !== "string" || b["baseSha256"].length === 0) {
    return { ok: false, reason: "baseSha256 is required" };
  }
  if (b["baseRevision"] !== null && typeof b["baseRevision"] !== "number") {
    return { ok: false, reason: "baseRevision must be a number or null" };
  }
  if (!b["patch"] || typeof b["patch"] !== "object") {
    return { ok: false, reason: "patch is required" };
  }
  const patch = b["patch"] as Record<string, unknown>;
  if (patch["kind"] !== "anchored_text") {
    return { ok: false, reason: "patch.kind must be anchored_text" };
  }
  if (typeof patch["oldString"] !== "string" || typeof patch["newString"] !== "string") {
    return { ok: false, reason: "patch.oldString and patch.newString must be strings" };
  }
  const target = b["target"];
  if (!target || typeof target !== "object") {
    return { ok: false, reason: "target is required" };
  }
  const t = target as Record<string, unknown>;
  if (t["kind"] !== "artifact" && t["kind"] !== "currentFile") {
    return { ok: false, reason: "target.kind must be artifact or currentFile" };
  }
  if (t["kind"] === "artifact") {
    if (typeof t["artifactInternalId"] !== "string" || typeof t["path"] !== "string") {
      return { ok: false, reason: "artifact target requires artifactInternalId and path" };
    }
  }
  return {
    ok: true,
    request: body as DocumentPatchRequest,
  };
}

export function patchRejectionStatus(rejection: DocumentPatchRejected): number {
  switch (rejection.kind) {
    case "anchor_not_found":
    case "anchor_ambiguous":
    case "stale_base_unrebaseable":
      return 409;
    case "forbidden":
      return 403;
    case "too_large":
      return 413;
    case "unsupported":
    default:
      return 400;
  }
}

function parseArtifactMimeHeader(
  artifactMimeHeader: string | string[] | undefined,
  contentTypeHeader: string | string[] | undefined,
): string | undefined {
  return parseContentTypeMime(artifactMimeHeader) ?? parseContentTypeMime(contentTypeHeader);
}

const TEXT_PATCH_EXTENSIONS = new Set([
  "bash",
  "cjs",
  "css",
  "csv",
  "htm",
  "html",
  "ini",
  "js",
  "json",
  "jsonl",
  "jsx",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "py",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "tsv",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

export function isTextLikePatchTarget(mimeType: string | null | undefined, logicalPath: string): boolean {
  const normalizedMime = (mimeType ?? mimeFromExtensionOr(logicalPath))
    .toLowerCase()
    .split(";")[0]!
    .trim();

  if (normalizedMime.startsWith("text/")) return true;
  if (
    normalizedMime === "application/json" ||
    normalizedMime === "application/xml" ||
    normalizedMime === "application/xhtml+xml" ||
    normalizedMime === "application/yaml" ||
    normalizedMime === "application/x-yaml" ||
    normalizedMime === "application/toml" ||
    normalizedMime === "application/javascript" ||
    normalizedMime === "application/typescript" ||
    normalizedMime === "image/svg+xml" ||
    normalizedMime.includes("markdown") ||
    normalizedMime.endsWith("+json") ||
    normalizedMime.endsWith("+xml")
  ) {
    return true;
  }

  const lastSegment = logicalPath.toLowerCase().split("/").pop() ?? logicalPath.toLowerCase();
  const dot = lastSegment.lastIndexOf(".");
  const ext = dot >= 0 ? lastSegment.slice(dot + 1) : "";
  return TEXT_PATCH_EXTENSIONS.has(ext);
}

/**
 * This is deliberately a pure discriminator.  It must run before a global
 * ServerEvent enters the per-connection queue or triggers envelope/artifact
 * reads: unrelated runtime traffic is not Workspace SSE work.
 */
export function isWorkspaceArtifactSseEvent(event: ServerEvent): boolean {
  if (event.type === "workspace.artifact.changed" || event.type === "workspace.artifact.renamed" || event.type === "workspace.artifact.deleted") return true;
  // Direct live mini-app mutations still use the anchored patch writer and
  // therefore emit this exact canonical delta. Keep it on the Workspace SSE
  // lane so an already-open surface can advance without a blind reload.
  if (event.type === "document.patch.applied") {
    return event.target.kind === "artifact";
  }
  if (
    event.type !== "document.mutation.committed" ||
    (event.mutation !== "create" && event.mutation !== "update") ||
    event.after?.identity?.kind !== "workspace_artifact" ||
    event.path?.after?.kind !== "workspace_artifact"
  ) {
    return false;
  }
  if (event.mutation === "create") return true;
  return event.before?.identity?.kind === "workspace_artifact" &&
    event.path?.before?.kind === "workspace_artifact";
}

/**
 * D442 Phase 4.1 — optional service seam for the discussion-rooms route.
 * Production omits it (the default falls back to the imported
 * `listDiscussionRoomsForArtifact`); hermetic route unit tests inject a
 * mock here so the contract can be exercised without a DB. Mirrors the
 * `RoomsRouteService` injection pattern in `routes/rooms.ts`.
 */
export type WorkspaceArtifactsRouteService = {
  /** Best-effort post-attachment observer for Human upload/Office creation. */
  onArtifactCreated?: WorkspaceArtifactCreatedSink;
  readonly readAuthoredChange?: typeof readWorkspaceAuthoredChange;
  /** Rebuilds SSE and download policy at delivery time after membership changes. */
  readonly buildCurrentEnvelope?: (
    actorId: string,
    agentId: string | undefined,
    roomId: string,
  ) => Promise<MemoryAccessEnvelope>;
  listDiscussionRoomsForArtifact?: typeof listDiscussionRoomsForArtifact;
  /**
   * D442 Phase 4.2 — atomic room-create + artifact-attach. Optional so
   * hermetic route unit tests can inject a mock without a DB; production
   * falls back to the imported `createDiscussionRoomForArtifact`.
   */
  createDiscussionRoomForArtifact?: typeof createDiscussionRoomForArtifact;
  /** Optional so hermetic route unit tests can inject a mock personal-agent list. */
  findPersonalAgentsForUser?: typeof findPersonalAgentsForUser;
  /** Optional so hermetic route unit tests can inject a mock agent-actor lookup. */
  findAgentActorForAgent?: typeof findAgentActorForAgent;
  /** M254 test seam; production resolves current canonical RBAC state. */
  assertCanInvokeAgent?: AssertCanInvokeAgent;
  /** M259 test seam; production resolves current canonical RBAC state. */
  assertCanWriteArtifacts?: AssertCanWriteArtifacts;
  /** M254 hermetic ping-admission seams. */
  findArtifactByInternalIdForNamespaces?: typeof findArtifactByInternalIdForNamespaces;
  findArtifactByIdForNamespaces?: typeof findArtifactByIdForNamespaces;
  getArtifactNamespaces?: typeof getArtifactNamespaces;
  appendPendingArtifactEvent?: typeof appendPendingArtifactEvent;
  /** M322 hermetic policy seam for opt-in plaintext Artifact pagination. */
  loadEncryptionPolicy?: typeof currentStrictShadowPolicy;
  /** M322 frozen Artifact-share adapter; production composition is mandatory in plaintext mode. */
  contentAccessCoordinator?: WorkspaceSharingService["contentAccessCoordinator"];
  /** M322 deterministic snapshot cutoff for hermetic pagination tests. */
  now?: () => Date;
};

export function workspaceArtifactsRoutes(
  app: FastifyInstance,
  service: WorkspaceArtifactsRouteService = {},
) {
  workspaceSharingRoutes(app, {
    ...(service.contentAccessCoordinator
      ? { contentAccessCoordinator: service.contentAccessCoordinator } : {}),
    ...(service.loadEncryptionPolicy ? { loadEncryptionPolicy: service.loadEncryptionPolicy } : {}),
  });
  ensureWorkspaceArtifactListGenerationSubscription();
  const resolveDiscussionRooms = service.listDiscussionRoomsForArtifact ?? listDiscussionRoomsForArtifact;
  const resolveCreateDiscussionRoom =
    service.createDiscussionRoomForArtifact ?? createDiscussionRoomForArtifact;
  const resolvePersonalAgents = service.findPersonalAgentsForUser ?? findPersonalAgentsForUser;
  const resolveAgentActor = service.findAgentActorForAgent ?? findAgentActorForAgent;
  const resolveEventArtifact = service.findArtifactByInternalIdForNamespaces ??
    findArtifactByInternalIdForNamespaces;
  const resolveEventArtifactNamespaces = service.getArtifactNamespaces ?? getArtifactNamespaces;
  const appendEvent = service.appendPendingArtifactEvent ?? appendPendingArtifactEvent;

  async function observeHumanArtifactCreated(input: {
    request: FastifyRequest;
    artifactInternalId: string;
    namespaceId: string;
  }): Promise<void> {
    const userId = input.request.sessionUserId;
    if (!userId || !service.onArtifactCreated) return;
    try {
      await service.onArtifactCreated({
        artifactInternalId: input.artifactInternalId,
        namespaceId: input.namespaceId,
        actor: { kind: "human", userId },
        occurrenceKey: `artifact.added:create:${input.artifactInternalId}`,
      });
    } catch {
      try {
        warn("[workspace-artifacts] artifact creation observer failed after attachment");
      } catch {
        // Diagnostics are best effort too; the Artifact is already attached.
      }
    }
  }

  function isExactHumanRoomEnvelope(
    request: FastifyRequest,
    env: MemoryAccessEnvelope,
  ): boolean {
    return !isScopeMemoryEnvelope(env)
      && !env.agentId
      && typeof request.sessionUserId === "string"
      && request.sessionUserId.length > 0
      && env.ownerId === request.sessionUserId
      && env.actorId.length > 0
      && env.roomId.length > 0;
  }

  async function admitArtifactRead(
    request: FastifyRequest,
    reply: FastifyReply,
    env: MemoryAccessEnvelope,
  ): Promise<"agent" | "human" | null> {
    if (env.agentId) return "agent";
    if (!isExactHumanRoomEnvelope(request, env)) {
      reply.code(403).send({ error: "Agent context required" });
      return null;
    }
    try {
      const policy = await (service.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
      if (policy.mode === "plaintext_only") return "human";
    } catch {
      reply.code(503).send({ error: "Artifact access is temporarily unavailable" });
      return null;
    }
    reply.code(403).send({ error: "Agent context required" });
    return null;
  }

  async function currentDownloadEnvelope(
    request: FastifyRequest,
    original: MemoryAccessEnvelope,
  ): Promise<MemoryAccessEnvelope> {
    if (!service.buildCurrentEnvelope) {
      throw Object.assign(new Error("Artifact access is temporarily unavailable"), {
        statusCode: 503, code: "artifact_read_authority_unavailable",
      });
    }
    let current: MemoryAccessEnvelope;
    try {
      current = await service.buildCurrentEnvelope(original.actorId, original.agentId || undefined, original.roomId);
    } catch {
      throw Object.assign(new Error("Artifact access is temporarily unavailable"), {
        statusCode: 503, code: "artifact_read_authority_unavailable",
      });
    }
    if (isScopeMemoryEnvelope(current) || current.actorId !== original.actorId
      || current.ownerId !== original.ownerId || current.roomId !== original.roomId
      || current.agentId !== original.agentId || request.sessionUserId !== current.ownerId
      || envelopeReadableNamespaces(current).length === 0) {
      throw Object.assign(new Error("Artifact access withdrawn"), {
        statusCode: 403, code: "artifact_access_withdrawn",
      });
    }
    // Human-only reads remain restricted to the existing plaintext policy.
    if (!current.agentId) {
      const policy = await (service.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
      if (policy.mode !== "plaintext_only") {
        throw Object.assign(new Error("Artifact access withdrawn"), {
          statusCode: 403, code: "artifact_access_withdrawn",
        });
      }
    }
    return current;
  }

  async function assertDownloadArtifact(current: MemoryAccessEnvelope, original: Artifact): Promise<void> {
    const row = await resolveEventArtifact({ internalId: original.id,
      readableNamespaceIds: envelopeReadableNamespaces(current) });
    if (!row || row.storageUri !== original.storageUri) {
      throw Object.assign(new Error("Artifact access withdrawn"), {
        statusCode: 403, code: "artifact_access_withdrawn",
      });
    }
  }

  async function requireWorkspaceArtifactWrite(
    request: FastifyRequest,
    reply: FastifyReply,
    input: { artifactId?: string; namespaceId?: string } = {},
  ): Promise<boolean> {
    const humanUserId = request.sessionUserId ?? request.memoryEnvelope?.ownerId ?? "";
    if (!humanUserId) {
      reply.code(401).send({ error: "Authentication required" });
      return false;
    }
    return requireArtifactWrite(
      {
        humanUserId,
        ...(request.memoryEnvelope?.roomId ? { roomId: request.memoryEnvelope.roomId } : {}),
        ...input,
      },
      reply,
      service.assertCanWriteArtifacts,
    );
  }
  // M180 — PUT …/content accepts raw UTF-8 text bodies (not JSON).
  app.addContentTypeParser(
    /^text\//,
    { parseAs: "string", bodyLimit: ARTIFACT_SAVE_BODY_LIMIT_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );
  app.get("/api/workspace/artifacts", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const q = request.query as {
      pathPrefix?: string;
      limit?: string;
      pagination?: string;
      cursor?: string;
    };
    const limitN = q.limit ? Math.min(Math.max(Number.parseInt(q.limit, 10) || 500, 1), 2000) : 500;
    const readable = envelopeReadableNamespaces(env);

    if (q.pagination === undefined) {
      const admission = await admitArtifactRead(request, reply, env);
      if (!admission) return;

      const rows = await listArtifactsForNamespaces({
        readableNamespaceIds: readable,
        ...(q.pathPrefix ? { pathPrefix: q.pathPrefix } : {}),
        limit: limitN,
      });

      // M088C item 7: single batched query instead of N per-row lookups.
      const nsByArtifact = await getNamespacesForArtifactIds(rows.map((r) => r.id));
      const mutable = envelopeMutableNamespaces(env);
      const readableSet = admission === "human" ? new Set(readable) : null;
      const dtos = rows.map((r) => rowToDto(
        r,
        (nsByArtifact.get(r.id) ?? []).filter(
          (namespaceId) => readableSet === null || readableSet.has(namespaceId),
        ),
        mutable,
      ));

      const body = { artifacts: dtos };
      const etag = workspaceArtifactListWeakETagFromProjection(
        {
          readableNamespaceIds: readable,
          viewerActorId: env.actorId,
          agentId: env.agentId,
          roomId: env.roomId,
          ...(q.pathPrefix ? { pathPrefix: q.pathPrefix } : {}),
          limit: limitN,
        },
        body,
      );
      return sendPrivateConditionalRead(request, reply, etag, body);
    }

    if (q.pagination !== ARTIFACT_KEYSET_PAGINATION) {
      return reply.code(400).send({
        error: "Unsupported Artifact list pagination mode",
        code: "invalid_artifact_list_pagination",
      });
    }
    if (!env.agentId && !isExactHumanRoomEnvelope(request, env)) {
      return reply.code(403).send({ error: "Agent context required" });
    }
    const policy = await (service.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
    if (policy.mode !== "plaintext_only") {
      return reply.code(409).send({
        error: "Complete Artifact inventory pagination is unavailable in the current encryption mode",
        code: "artifact_list_pagination_unavailable",
      });
    }

    const scope = artifactListScopeGenerationDigest({
      readableNamespaceIds: readable,
      viewerActorId: env.actorId,
      agentId: env.agentId,
      roomId: env.roomId,
      ...(q.pathPrefix ? { pathPrefix: q.pathPrefix } : {}),
      limit: limitN,
    });
    const cursor = q.cursor === undefined ? null : decodeArtifactListCursor(q.cursor);
    if (q.cursor !== undefined && cursor === null) {
      return reply.code(400).send({
        error: "Invalid Artifact list cursor",
        code: "invalid_artifact_list_cursor",
      });
    }
    if (cursor !== null && cursor.scope !== scope) {
      return reply.code(409).send({
        error: "Artifact inventory changed while it was loading",
        code: "stale_artifact_list_cursor",
      });
    }

    const snapshotAt = cursor ? new Date(cursor.snapshotAt) : (service.now ?? (() => new Date()))();
    const page = await listArtifactPageForNamespaces({
      readableNamespaceIds: readable,
      ...(q.pathPrefix ? { pathPrefix: q.pathPrefix } : {}),
      limit: limitN,
      snapshotAt,
      ...(cursor ? { after: { createdAt: cursor.createdAt, id: cursor.id } } : {}),
    });
    const nsByArtifact = await getNamespacesForArtifactIds(page.artifacts.map((r) => r.id));
    const finalPolicy = await (service.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
    if (finalPolicy.mode !== "plaintext_only" || finalPolicy.revision !== policy.revision) {
      return reply.code(409).send({
        error: "Encryption policy changed while the Artifact inventory was loading",
        code: "artifact_list_pagination_unavailable",
      });
    }
    const mutable = envelopeMutableNamespaces(env);
    const readableSet = new Set(readable);
    const dtos = page.artifacts.map((r) => rowToDto(
      r,
      (nsByArtifact.get(r.id) ?? []).filter((namespaceId) => readableSet.has(namespaceId)),
      mutable,
    ));
    const body = {
      artifacts: dtos,
      nextCursor: page.next
        ? encodeArtifactListCursor({
            v: 1,
            scope,
            snapshotAt: page.next.snapshotAt.toISOString(),
            createdAt: page.next.createdAt,
            id: page.next.id,
          })
        : null,
    };
    const etag = workspaceArtifactListWeakETagFromProjection(
      {
        readableNamespaceIds: readable,
        viewerActorId: env.actorId,
        agentId: env.agentId,
        roomId: env.roomId,
        ...(q.pathPrefix ? { pathPrefix: q.pathPrefix } : {}),
        limit: limitN,
      },
      body,
    );
    return sendPrivateConditionalRead(request, reply, etag, body);
  });

  app.get("/api/workspace/artifacts/events", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const admission = await admitArtifactRead(request, reply, env);
    if (!admission) return;
    const subscribedActorId = env.actorId;
    const subscribedAgentId = env.agentId || undefined;
    const subscribedRoomId = env.roomId;
    const subscribedUserId = admission === "human" ? request.sessionUserId : undefined;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    const heartbeatRef: { current?: ReturnType<typeof setInterval> } = {};
    const closeStream = () => {
      if (closed) return;
      closed = true;
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      eventBus.off(handler);
      try { reply.raw.end(); } catch { /* stream is already gone */ }
    };
    const writeEvent = (eventName: string, payload: unknown) => {
      if (closed) return;
      reply.raw.write(`event: ${eventName}\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const deliver = async (event: ServerEvent): Promise<void> => {
      if (closed) return;
      // Never use subscribe-time Namespace IDs for a long-lived stream:
      // committed events can contain anchored text. Rebuild the envelope
      // from stable authenticated subject/lane coordinates on every delivery
      // so a post-subscribe revocation fails closed.
      if (!service.buildCurrentEnvelope) {
        closeStream();
        return;
      }
      const currentEnvelope = await service.buildCurrentEnvelope(
        subscribedActorId,
        subscribedAgentId,
        subscribedRoomId,
      );
      if (closed || isScopeMemoryEnvelope(currentEnvelope)) {
        closeStream();
        return;
      }
      if (subscribedUserId !== undefined) {
        let policy: Awaited<ReturnType<typeof currentStrictShadowPolicy>>;
        try {
          policy = await (service.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
        } catch {
          closeStream();
          return;
        }
        if (policy.mode !== "plaintext_only" || currentEnvelope.agentId
          || currentEnvelope.ownerId !== subscribedUserId
          || currentEnvelope.actorId !== subscribedActorId
          || currentEnvelope.roomId !== subscribedRoomId) {
          closeStream();
          return;
        }
      }
      const readableNow = envelopeReadableNamespaces(currentEnvelope);
      if (event.type === "workspace.artifact.changed" || event.type === "workspace.artifact.renamed") {
        const vis = await findArtifactByInternalIdForNamespaces({
          internalId: event.id,
          readableNamespaceIds: readableNow,
        });
        if (!vis || closed) return;
        if (event.type === "workspace.artifact.changed") {
          writeEvent("changed", {
            id: event.id,
            artifactId: event.artifactId,
            path: event.path,
            ...(event.clientMutationId ? { clientMutationId: event.clientMutationId } : {}),
            ...(event.reloadRequired ? { reloadRequired: true } : {}),
          });
        } else {
          writeEvent("renamed", { id: event.id, oldPath: event.oldPath, newPath: event.newPath });
        }
      } else if (event.type === "document.patch.applied") {
        if (event.target.kind !== "artifact") return;
        const vis = await findArtifactByInternalIdForNamespaces({
          internalId: event.target.artifactInternalId,
          readableNamespaceIds: readableNow,
        });
        if (!vis || closed) return;
        writeEvent("document.patch.applied", event);
      } else if (event.type === "document.mutation.committed") {
        if (
          (event.mutation !== "create" && event.mutation !== "update") ||
          event.after.identity.kind !== "workspace_artifact"
        ) return;
        const vis = await findArtifactByInternalIdForNamespaces({
          internalId: event.after.identity.artifactId,
          readableNamespaceIds: readableNow,
        });
        if (!vis || closed) return;
        writeEvent("document.mutation.committed", event);
      } else if (event.type === "workspace.artifact.deleted") {
        if (event.namespaceIds.some((ns) => readableNow.includes(ns))) {
          writeEvent("deleted", { id: event.id, artifactId: event.artifactId });
        }
      }
    };

    // A fresh policy lookup is asynchronous. Serialize delivery per
    // connection so later committed events cannot overtake earlier ones when
    // their authorization queries resolve at different speeds.
    let delivery = Promise.resolve();
    const handler = (event: ServerEvent): void => {
      if (!isWorkspaceArtifactSseEvent(event)) return;
      delivery = delivery.then(() => deliver(event)).catch((err: unknown) => {
        warn(`[workspace-artifacts] SSE handler: ${err instanceof Error ? err.message : String(err)}`);
        closeStream();
      });
    };

    eventBus.on(handler);

    heartbeatRef.current = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(": keepalive\n\n");
      } catch {
        /* ignore */
      }
    }, 15000);

    request.raw.on("close", () => {
      closeStream();
    });
  });

  // Resolve an exact public identity, without depending on a truncated inventory.
  // The same namespace envelope and indistinguishable 404 apply as for internal IDs.
  app.get("/api/workspace/artifacts/by-public-id/:artifactId", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const admission = await admitArtifactRead(request, reply, env);
    if (!admission) return;
    const { artifactId } = request.params as { artifactId: string };
    const row = await (service.findArtifactByIdForNamespaces ?? findArtifactByIdForNamespaces)({ artifactId, readableNamespaceIds: envelopeReadableNamespaces(env) });
    if (!row) return reply.code(404).send({ error: "Not found" });
    const namespaceIds = (await resolveEventArtifactNamespaces(row.id)).filter(
      (namespaceId) => admission === "agent"
        || envelopeReadableNamespaces(env).includes(namespaceId),
    );
    return reply.send(rowToDto(row, namespaceIds, envelopeMutableNamespaces(env)));
  });

  app.get("/api/workspace/artifacts/:id", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    if (!await admitArtifactRead(request, reply, env)) return;
    const { id } = request.params as { id: string };
    const readable = envelopeReadableNamespaces(env);
    const row = await findArtifactByInternalIdForNamespaces({
      internalId: id,
      readableNamespaceIds: readable,
    });
    if (!row) return reply.code(404).send({ error: "Not found" });
    const namespaceIds = (await getArtifactNamespaces(row.id)).filter(
      (namespaceId) => env.agentId || readable.includes(namespaceId),
    );
    return reply.send(rowToDto(row, namespaceIds, envelopeMutableNamespaces(env)));
  });

  app.get("/api/workspace/artifacts/:id/authored-change", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const env = request.memoryEnvelope;
    if (!env || !request.sessionUserId) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    if (!env.agentId || !env.roomId) return reply.code(403).send({ error: "Room and agent context required" });
    const q = request.query as Record<string, unknown>;
    if (Object.keys(q).some((key) => !["roomId", "expectedSha256", "expectedRevision"].includes(key)) ||
        q["roomId"] !== env.roomId || typeof q["expectedSha256"] !== "string" ||
        !/^[a-f0-9]{64}$/.test(q["expectedSha256"]) || typeof q["expectedRevision"] !== "string" ||
        !/^\d+$/.test(q["expectedRevision"]) || !Number.isSafeInteger(Number(q["expectedRevision"]))) {
      return reply.code(400).send({ error: "Expected current document version and Room" });
    }
    const { id } = request.params as { id: string };
    return reply.send(await (service.readAuthoredChange ?? readWorkspaceAuthoredChange)({
      envelope: env, sessionUserId: request.sessionUserId, artifactId: id,
      expectedRevision: Number(q["expectedRevision"]), expectedSha256: q["expectedSha256"],
    }));
  });

  // ─── D442 Phase 4.1 — artifact discussion-room candidates ────────────
  //
  // Discover eligible discussion rooms for a specific readable artifact
  // WITHOUT exposing raw namespaces as UI and WITHOUT client-side
  // guessed-room probing. The server returns only rooms that:
  //   1. back a namespace attached to the artifact,
  //   2. whose namespace is in the viewer's envelope-readable set
  //      (authorization — unreadable attachments never resolve to a
  //      room), and
  //   3. where the viewer is currently a member (stale-envelope /
  //      revoked-membership denial — `room_members` is the source of
  //      truth, not the envelope).
  // The response carries `{ id, label, kind }` per room; no namespace ids.
  // See `listDiscussionRoomsForArtifact` in @nautilo/db for the single
  // SQL round-trip that fuses the three gates.
  app.get("/api/workspace/artifacts/:id/discussion-rooms", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });
    const { id } = request.params as { id: string };
    const readable = envelopeReadableNamespaces(env);
    // 404 on missing OR not-currently-readable artifact — same gate + same
    // indistinguishable null as the sibling GET /:id, so existence of an
    // unreadable artifact is not leaked here.
    const row = await findArtifactByInternalIdForNamespaces({
      internalId: id,
      readableNamespaceIds: readable,
    });
    if (!row) return reply.code(404).send({ error: "Not found" });
    const rooms = await resolveDiscussionRooms({
      artifactInternalId: row.id,
      readableNamespaceIds: readable,
      viewerActorId: env.actorId,
    });
    return reply.send({ rooms });
  });

  // ─── D442 Phase 4.2 — "Start a new conversation" from an artifact ────
  //
  // Atomically mints a server-authorized conversational discussion Room
  // (kind='private') for the caller + the caller's personal agent AND
  // attaches the artifact to that Room's Namespace in a single DB
  // transaction (see `createDiscussionRoomForArtifact` in `@nautilo/db`).
  // The artifact MUST be readable
  // for the viewer's envelope (404 otherwise — same indistinguishable
  // null as GET /:id, so existence of an unreadable artifact is never
  // leaked). The caller MUST be currently authorized (envelope present
  // + agentId); the personal agent is resolved SERVER-SIDE from the
  // caller's user id, never trusted from the client request body.
  //
  // Body (all optional): `{ label?: string }`. When absent the room
  // label defaults to the artifact's path basename (truncated to 80).
  // Returns the safe `{ id, label, kind }` projection of the new room;
  // no namespace id is exposed to the client.
  app.post("/api/workspace/artifacts/:id/discussion-rooms", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });

    const { id } = request.params as { id: string };
    const readable = envelopeReadableNamespaces(env);
    // 404 on missing OR not-currently-readable artifact — same gate and
    // same indistinguishable null as the sibling GET /:id and GET
    // /:id/discussion-rooms routes, so existence of an unreadable
    // artifact is not leaked here.
    const row = await findArtifactByInternalIdForNamespaces({
      internalId: id,
      readableNamespaceIds: readable,
    });
    if (!row) return reply.code(404).send({ error: "Not found" });

    if (!(await requireWorkspaceArtifactWrite(request, reply, { artifactId: row.id }))) {
      return;
    }

    const body = (request.body ?? {}) as { label?: unknown };
    const requestedLabel = typeof body.label === "string" ? body.label.trim() : "";
    const fallbackBase = (row.path.split("/").pop() ?? "").trim();
    const label = (
      requestedLabel.length > 0
        ? requestedLabel
        : fallbackBase.length > 0
          ? fallbackBase
          : "Discussion"
    ).slice(0, 80);
    if (label.length === 0) {
      return reply.code(400).send({ error: "label must not be empty" });
    }

    const ownerUserId = request.sessionUserId ?? env.ownerId;
    if (!ownerUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    let personalAgentId: string;
    try {
      const personal = await resolvePersonalAgents(ownerUserId);
      const first = personal[0];
      if (!first?.agentId) {
        return reply.code(400).send({ error: "no_default_agent", code: "no_default_agent" });
      }
      personalAgentId = first.agentId;
    } catch (err) {
      warn(
        `[workspace-artifacts] findPersonalAgentsForUser failed for ${ownerUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return reply.code(500).send({ error: "agent_resolution_failed", code: "agent_resolution_failed" });
    }

    const agentActor = await resolveAgentActor(personalAgentId);
    if (!agentActor) {
      warn(
        `[workspace-artifacts] no agent-actor for personal agent ${personalAgentId}`,
      );
      return reply.code(500).send({ error: "agent_resolution_failed", code: "agent_resolution_failed" });
    }

    try {
      const room = await resolveCreateDiscussionRoom({
        ownerUserId,
        ownerActorId: env.actorId,
        agentActorId: agentActor.id,
        label,
        artifactInternalId: row.id,
      });
      // The artifact's namespace set changed (it now also attaches to
      // the new Room's Namespace); notify SSE subscribers so any open
      // viewer re-fetches the candidate list. Mirrors the emit the
      // artifact-create route fires after `attachArtifactToNamespace`.
      eventBus.emit({
        type: "workspace.artifact.changed",
        id: row.id,
        artifactId: row.artifactId,
        path: row.path,
      });
      return reply.code(201).send(room);
    } catch (err) {
      warn(
        `[workspace-artifacts] createDiscussionRoomForArtifact failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return reply.code(500).send({ error: "Failed to create discussion room" });
    }
  });

  app.get("/api/workspace/artifacts/:id/bytes", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    if (!await admitArtifactRead(request, reply, env)) return;
    const { id } = request.params as { id: string };
    const readable = envelopeReadableNamespaces(env);
    const row = await findArtifactByInternalIdForNamespaces({
      internalId: id,
      readableNamespaceIds: readable,
    });
    if (!row) return reply.code(404).send({ error: "Not found" });
    const abs = absPathFromStorageUri(row.storageUri);
    if (!abs) return reply.code(500).send({ error: "Invalid storage URI" });
    let size = row.size ?? 0;
    try {
      const st = await fsStat(abs);
      size = st.size;
    } catch {
      warn(`[workspace-artifacts] stat failed for ${abs}`);
      // Do not commit a successful streaming response for a path that cannot
      // be opened. Once reply.hijack()/writeHead(200) runs, createReadStream's
      // later ENOENT aborts the body after headers and leaves clients with a
      // transport failure instead of a bounded unavailable-file response.
      return reply.code(404).send({
        error: "Artifact bytes are unavailable",
        code: "artifact_bytes_unavailable",
      });
    }
    await assertDownloadArtifact(await currentDownloadEnvelope(request, env), row);
    // Revalidate on the stream's existing backpressure boundary. No timer or
    // cached subscription grants permission to deliver the next file chunk.
    async function* authorizedChunks(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        await assertDownloadArtifact(await currentDownloadEnvelope(request, env!), row!);
        yield chunk;
      }
    }
    const mimeType = row.mimeType ?? "application/octet-stream";
    const rangeRaw = request.headers.range;
    if (!rangeRaw) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": String(size),
      });
      const rs = createReadStream(abs);
      await pipeline(rs, authorizedChunks, reply.raw);
      return;
    }
    const parsed = parseRangeHeader(rangeRaw, size);
    if (parsed.ok === false) {
      if (parsed.status === 416) {
        reply.hijack();
        reply.raw.writeHead(416, {
          "Content-Range": `bytes */${size}`,
        });
        reply.raw.end();
        return;
      }
      return reply.code(400).send({ error: "Invalid Range header" });
    }
    const { start, end } = parsed;
    const sliceLen = end - start + 1;
    reply.hijack();
    reply.raw.writeHead(206, {
      "Content-Type": mimeType,
      "Content-Length": String(sliceLen),
      "Content-Range": `bytes ${start}-${end}/${size}`,
    });
    const rs = createReadStream(abs, { start, end });
    await pipeline(rs, authorizedChunks, reply.raw);
  });

  app.put(
    "/api/workspace/artifacts/:id/content",
    { bodyLimit: ARTIFACT_SAVE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const env = request.memoryEnvelope;
      if (!env) return reply.code(401).send({ error: "Authentication required" });
      if (isScopeMemoryEnvelope(env)) {
        return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
      }
      const agentId = env.agentId;
      if (!agentId) return reply.code(403).send({ error: "Agent context required" });

      const { id } = request.params as { id: string };
      const mutable = envelopeMutableNamespaces(env);
      const row = await findArtifactByInternalIdForNamespaces({
        internalId: id,
        readableNamespaceIds: mutable,
      });
      if (!row) {
        const readable = envelopeReadableNamespaces(env);
        const readableRow = await findArtifactByInternalIdForNamespaces({
          internalId: id,
          readableNamespaceIds: readable,
        });
        if (readableRow) {
          return reply.code(403).send({ error: "Artifact is not writable in this context" });
        }
        return reply.code(404).send({ error: "Not found" });
      }

      if (!(await requireWorkspaceArtifactWrite(request, reply, { artifactId: row.id }))) {
        return;
      }

      const newText = readUtf8TextBody(request.body);
      if (newText === null) {
        return reply.code(400).send({ error: "Expected raw UTF-8 text body" });
      }

      const baseRevision = parseIfMatchRevision(
        typeof request.headers["if-match"] === "string"
          ? request.headers["if-match"]
          : request.headers["if-match"]?.[0],
      );
      const baseSha256 = parseBaseSha256Header(request.headers["x-base-sha256"]);
      const checkpoint = parseCheckpointHeader(request.headers["x-checkpoint"]);
      const mimeType = parseArtifactMimeHeader(
        request.headers["x-artifact-mime-type"],
        request.headers["content-type"],
      );
      const clientMutationIdHeader = request.headers["x-client-mutation-id"];
      const clientMutationId = Array.isArray(clientMutationIdHeader)
        ? clientMutationIdHeader[0]
        : clientMutationIdHeader;

      const result = await saveWorkspaceEditorSnapshot({
        envelope: env,
        artifact: row,
        ...(request.sessionUserId ? { sessionUserId: request.sessionUserId } : {}),
        newText,
        baseRevision,
        baseSha256,
        checkpoint,
        ...(mimeType ? { mimeType } : {}),
        ...(clientMutationId && clientMutationId.length > 0 ? { clientMutationId } : {}),
      }, {
        onCommitted: requestWorkspaceDocumentMutationOutboxPump,
      });

      if (!result.ok) {
        switch (result.code) {
          case "conflict":
            return reply.code(409).send({
              error: "external_change",
              currentSha256: result.currentSha256,
            });
          case "not_found":
            return reply.code(404).send({ error: result.message });
          case "forbidden":
            return reply.code(403).send({ error: result.message });
          case "too_large":
            return reply.code(413).send({ error: result.message });
          case "recovery_required":
            return reply.code(503).send(WORKSPACE_EDITOR_RECOVERY_RESPONSE);
          case "error":
          default:
            return reply.code(500).send({ error: result.message });
        }
      }

      return reply.send({
        id: row.id,
        revision: result.revision,
        size: result.size,
        sha256: result.sha256,
      });
    },
  );

  app.post(
    "/api/workspace/artifacts/:id/patch",
    { bodyLimit: ARTIFACT_SAVE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const env = request.memoryEnvelope;
      if (!env) return reply.code(401).send({ error: "Authentication required" });
      if (isScopeMemoryEnvelope(env)) {
        return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
      }
      const agentId = env.agentId;
      if (!agentId) return reply.code(403).send({ error: "Agent context required" });

      const { id } = request.params as { id: string };
      const parsedBody = parseDocumentPatchRequestBody(request.body);
      if (!parsedBody.ok) {
        return reply.code(400).send({ error: parsedBody.reason });
      }
      const patchRequest = parsedBody.request;

      if (
        patchRequest.target.kind === "artifact" &&
        patchRequest.target.artifactInternalId !== id
      ) {
        return reply.code(400).send({ error: "target.artifactInternalId must match route id" });
      }
      if (patchRequest.target.kind === "currentFile") {
        return reply.code(400).send({ error: "currentFile patch targets are not supported on this route" });
      }

      const mutable = envelopeMutableNamespaces(env);
      const row = await findArtifactByInternalIdForNamespaces({
        internalId: id,
        readableNamespaceIds: mutable,
      });
      if (!row) {
        const readable = envelopeReadableNamespaces(env);
        const readableRow = await findArtifactByInternalIdForNamespaces({
          internalId: id,
          readableNamespaceIds: readable,
        });
        if (readableRow) {
          return reply.code(403).send({ error: "Artifact is not writable in this context" });
        }
        return reply.code(404).send({ error: "Not found" });
      }

      if (!(await requireWorkspaceArtifactWrite(request, reply, { artifactId: row.id }))) {
        return;
      }

      if (!isTextLikePatchTarget(row.mimeType, row.path)) {
        return reply.code(400).send({
          kind: "unsupported",
          reason: "Document patch protocol only supports text-like workspace artifacts.",
        });
      }

      const result = await saveWorkspaceEditorPatch({
        envelope: env,
        artifact: row,
        requestId: patchRequest.requestId,
        baseRevision: patchRequest.baseRevision,
        baseSha256: patchRequest.baseSha256,
        patch: patchRequest.patch,
        checkpoint: patchRequest.checkpoint ?? false,
        ...(patchRequest.mimeType ? { mimeType: patchRequest.mimeType } : {}),
        ...(patchRequest.clientMutationId ? { clientMutationId: patchRequest.clientMutationId } : {}),
        ...(request.sessionUserId ? { sessionUserId: request.sessionUserId } : {}),
      }, {
        onCommitted: requestWorkspaceDocumentMutationOutboxPump,
      });

      if (!result.ok) {
        if ("code" in result && result.code === "recovery_required") {
          return reply.code(503).send(WORKSPACE_EDITOR_RECOVERY_RESPONSE);
        }
        if ("rejection" in result) {
          return reply.code(patchRejectionStatus(result.rejection)).send(result.rejection);
        }
        return reply.code(404).send({ error: result.message });
      }

      return reply.send(result.applied);
    },
  );

  app.post("/api/workspace/artifacts", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });

    const factsResult = envelopeFactsForArtifacts(env);
    if (!factsResult.ok) return reply.code(403).send({ error: factsResult.reason });
    const writable = envelopeWritableNamespaces(env);
    const mutable = envelopeMutableNamespaces(env);
    if (writable.length === 0) {
      return reply.code(403).send({ error: "No writable namespace for artifact create" });
    }
    if (!(await requireWorkspaceArtifactWrite(request, reply, { namespaceId: writable[0]! }))) {
      return;
    }

    const cap = uploadCapBytes();
    let uploadedPath: string | null = null;
    let fileFilename = "upload.bin";
    let fileMimetype = "";
    const fields: Record<string, string> = {};
    // M088C item 6: track whether we successfully attached the row to
    // the DB. On any earlier non-2xx exit OR thrown exception the
    // uploaded file would otherwise be orphaned under <artifactsRoot>.
    let attached = false;
    const discardOrphanUpload = async (): Promise<void> => {
      if (attached || !uploadedPath) return;
      const orphanPath = uploadedPath;
      uploadedPath = null;
      try {
        await rm(orphanPath, { force: true });
      } catch (err) {
        warn(
          `[workspace-artifacts] orphan cleanup failed for ${orphanPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    try {
      try {
        for await (const part of request.parts({
          limits: { fileSize: cap, files: 1 },
        })) {
          if (part.type === "file") {
            if (part.fieldname !== "file") {
              return reply.code(400).send({ error: 'multipart field "file" required' });
            }
            fileFilename = part.filename ?? "upload.bin";
            fileMimetype = part.mimetype ?? "";
            const externalArtifactId = randomUUID();
            const root = getArtifactsRoot();
            await mkdir(root, { recursive: true });
            const absPath = join(root, externalArtifactId);
            uploadedPath = absPath;
            await mkdir(dirname(absPath), { recursive: true });
            await pipeline(part.file, createWriteStream(absPath));
          } else {
            const v = part.value;
            fields[part.fieldname] = typeof v === "string" ? v : String(v);
          }
        }
      } catch (err) {
        if (isMultipartTooLarge(err)) {
          await discardOrphanUpload();
          return reply.code(413).send({ error: "upload exceeds configured size cap" });
        }
        warn(`[workspace-artifacts] multipart: ${err instanceof Error ? err.message : String(err)}`);
        await discardOrphanUpload();
        return reply.code(400).send({ error: "multipart parse failed" });
      }

      if (!uploadedPath) {
        return reply.code(400).send({ error: 'multipart part "file" required' });
      }

      const pathCheck = validateLogicalPath(fields["path"]);
      if (!pathCheck.ok) {
        await discardOrphanUpload();
        return reply.code(400).send({ error: pathCheck.reason });
      }

      const collision = await findArtifactByPathForNamespaces({
        path: pathCheck.path,
        readableNamespaceIds: mutable,
      });
      if (collision) {
        await discardOrphanUpload();
        return reply.code(409).send({ error: "An artifact already exists at this path" });
      }

      const st = await fsStat(uploadedPath);
      const mimeField = fields["mimeType"]?.trim();
      const mimeType =
        mimeField && mimeField.length > 0
          ? mimeField
          : fileMimetype && fileMimetype.length > 0
            ? fileMimetype
            : mimeFromExtensionOr(fileFilename);

      const sniffLen = Math.min(ATTACHMENT_POLICY.maxSniffBytes, st.size);
      const headBuf = Buffer.alloc(sniffLen);
      if (sniffLen > 0) {
        const fh = await open(uploadedPath, "r");
        try {
          await fh.read(headBuf, 0, sniffLen, 0);
        } finally {
          await fh.close();
        }
      }
      const uploadClass = classifyArtifactUpload({
        filename: pathCheck.path,
        headBytes: new Uint8Array(headBuf),
      });
      if (!uploadClass.ok) {
        await discardOrphanUpload();
        return reply.code(415).send({ error: uploadClass.reason, code: uploadClass.code });
      }

      const externalArtifactId = basename(uploadedPath);
      const storageUri = `file://${uploadedPath}`;
      const created = await insertArtifact({
        artifactId: externalArtifactId,
        path: pathCheck.path,
        storageUri,
        mimeType,
        size: st.size,
      });
      await attachArtifactToNamespace({
        artifactId: created.id,
        namespaceId: writable[0]!,
      });
      attached = true;
      await observeHumanArtifactCreated({
        request,
        artifactInternalId: created.id,
        namespaceId: writable[0]!,
      });
      eventBus.emit({
        type: "workspace.artifact.changed",
        id: created.id,
        artifactId: created.artifactId,
        path: created.path,
      });
      const namespaceIds = await getArtifactNamespaces(created.id);
      return reply.send(rowToDto(created, namespaceIds, envelopeMutableNamespaces(env)));
    } finally {
      await discardOrphanUpload();
    }
  });

  // D362 — create a blank LibreOffice document from a committed template.
  //
  // The three blank templates (`blank.docx` / `blank.xlsx` / `blank.pptx`)
  // were minted once by LibreOffice itself (valid OOXML) and live under
  // `packages/server/assets/office-templates/`. "New" copies the template
  // bytes into a fresh workspace artifact and returns the same DTO shape as
  // upload, so the workbench opens it through the normal office surface.
  // JSON body (not multipart) — there is no user file to stream.
  app.post("/api/office/new", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });

    const factsResult = envelopeFactsForArtifacts(env);
    if (!factsResult.ok) return reply.code(403).send({ error: factsResult.reason });
    const writable = envelopeWritableNamespaces(env);
    const mutable = envelopeMutableNamespaces(env);
    if (writable.length === 0) {
      return reply.code(403).send({ error: "No writable namespace for document create" });
    }
    if (!(await requireWorkspaceArtifactWrite(request, reply, { namespaceId: writable[0]! }))) {
      return;
    }

    const body = (request.body ?? {}) as { kind?: unknown; name?: unknown };
    const kind = typeof body.kind === "string" ? body.kind.trim() : "";
    const spec = OFFICE_TEMPLATE_SPECS[kind];
    if (!spec) {
      return reply.code(400).send({ error: `kind must be one of: ${Object.keys(OFFICE_TEMPLATE_SPECS).join(", ")}` });
    }

    // Load the committed template bytes. Resolved relative to this source
    // file; the server runs from source (bun), so `import.meta.dir` is stable.
    let templateBytes: Buffer;
    try {
      templateBytes = await readFile(officeTemplatePath(spec.templateFile));
    } catch (err) {
      warn(`[office] blank template read failed for ${kind}: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(500).send({ error: "Blank template unavailable" });
    }

    // Resolve the logical path. An explicit `name` is the caller's
    // responsibility (409 on collision). An auto-generated "Untitled …" name
    // mirrors LibreOffice's convention and is disambiguated with a " (n)"
    // suffix — `Untitled Document`, `Untitled Document (1)`, `(2)`, … — so
    // repeated "New" clicks never collide and never 409 in the common case.
    const requestedName = typeof body.name === "string" ? body.name.trim() : "";
    const withExt = (base: string): string =>
      base.toLowerCase().endsWith(`.${spec.ext}`) ? base : `${base}.${spec.ext}`;
    const isPathFree = async (candidate: string): Promise<boolean> => {
      const existing = await findArtifactByPathForNamespaces({
        path: candidate,
        readableNamespaceIds: mutable,
      });
      return !existing;
    };

    let finalPath: string;
    if (requestedName.length > 0) {
      const pc = validateLogicalPath(withExt(requestedName));
      if (!pc.ok) return reply.code(400).send({ error: pc.reason });
      if (!(await isPathFree(pc.path))) {
        return reply.code(409).send({ error: "An artifact already exists at this path" });
      }
      finalPath = pc.path;
    } else {
      const UNTITLED_CAP = 1000;
      let candidate = withExt(spec.defaultBase);
      let n = 1;
      while (!(await isPathFree(candidate))) {
        if (n > UNTITLED_CAP) {
          return reply.code(409).send({ error: "Too many untitled documents; name one explicitly." });
        }
        candidate = withExt(`${spec.defaultBase} (${n})`);
        n += 1;
      }
      const pc = validateLogicalPath(candidate);
      if (!pc.ok) return reply.code(400).send({ error: pc.reason });
      finalPath = pc.path;
    }

    const externalArtifactId = randomUUID();
    const root = getArtifactsRoot();
    const absPath = join(root, externalArtifactId);
    let attached = false;
    try {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, templateBytes);

      const created = await insertArtifact({
        artifactId: externalArtifactId,
        path: finalPath,
        storageUri: `file://${absPath}`,
        mimeType: spec.mimeType,
        size: templateBytes.byteLength,
      });
      await attachArtifactToNamespace({ artifactId: created.id, namespaceId: writable[0]! });
      attached = true;
      await observeHumanArtifactCreated({
        request,
        artifactInternalId: created.id,
        namespaceId: writable[0]!,
      });
      eventBus.emit({
        type: "workspace.artifact.changed",
        id: created.id,
        artifactId: created.artifactId,
        path: created.path,
      });
      const namespaceIds = await getArtifactNamespaces(created.id);
      return reply.send(rowToDto(created, namespaceIds, envelopeMutableNamespaces(env)));
    } catch (err) {
      warn(`[office] blank create failed for ${kind}: ${err instanceof Error ? err.message : String(err)}`);
      if (!attached) {
        try {
          await rm(absPath, { force: true });
        } catch {
          /* best-effort orphan cleanup */
        }
      }
      return reply.code(500).send({ error: "Failed to create document" });
    }
  });

  // D356 — bulk export: zip the selected artifacts (by internal id) into a
  // single download. One request, one save dialog — no per-file fan-out.
  app.post("/api/workspace/artifacts/export", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });
    const readable = envelopeReadableNamespaces(env);

    const body = request.body as { ids?: unknown };
    const rawIds = Array.isArray(body?.ids) ? body.ids : null;
    if (!rawIds || rawIds.length === 0) {
      return reply.code(400).send({ error: "ids must be a non-empty array" });
    }
    const ids = rawIds.filter((x): x is string => typeof x === "string" && x.length > 0);
    if (ids.length === 0) {
      return reply.code(400).send({ error: "ids must contain at least one string id" });
    }
    if (ids.length > EXPORT_MAX_FILES) {
      return reply.code(400).send({ error: `Too many files selected (max ${EXPORT_MAX_FILES})` });
    }

    const files: Record<string, Uint8Array> = {};
    const exportedArtifacts: Artifact[] = [];
    const usedNames = new Set<string>();
    let totalBytes = 0;
    for (const id of ids) {
      const row = await findArtifactByInternalIdForNamespaces({
        internalId: id,
        readableNamespaceIds: readable,
      });
      if (!row) continue; // skip inaccessible/missing — partial export beats hard fail
      const abs = absPathFromStorageUri(row.storageUri);
      if (!abs) continue;
      await assertDownloadArtifact(await currentDownloadEnvelope(request, env), row);
      let bytes: Buffer;
      try {
        bytes = await readFile(abs);
      } catch (err) {
        warn(
          `[workspace-artifacts] export read failed for ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > EXPORT_MAX_TOTAL_BYTES) {
        return reply.code(413).send({ error: "Selected artifacts exceed the export size limit" });
      }
      files[uniqueZipEntryName(row.path, usedNames)] = new Uint8Array(bytes);
      exportedArtifacts.push(row);
    }
    if (Object.keys(files).length === 0) {
      return reply.code(404).send({ error: "No accessible artifacts to export" });
    }
    // Nothing leaves the server until every included file is still readable.
    const current = await currentDownloadEnvelope(request, env);
    for (const artifact of exportedArtifacts) await assertDownloadArtifact(current, artifact);
    const finalEnvelope = await currentDownloadEnvelope(request, env);
    const finalReadable = new Set(envelopeReadableNamespaces(finalEnvelope));
    if (envelopeReadableNamespaces(current).some(namespaceId => !finalReadable.has(namespaceId))) {
      throw Object.assign(new Error("Artifact access changed during export"), {
        statusCode: 403, code: "artifact_access_withdrawn",
      });
    }
    const zipped = zipSync(files);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", 'attachment; filename="artifacts.zip"');
    return reply.send(Buffer.from(zipped));
  });

  app.patch("/api/workspace/artifacts/:id", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });
    const { id } = request.params as { id: string };
    const mutable = envelopeMutableNamespaces(env);
    const row = await findArtifactByInternalIdForNamespaces({
      internalId: id,
      readableNamespaceIds: mutable,
    });
    if (!row) return reply.code(404).send({ error: "Not found" });

    if (!(await requireWorkspaceArtifactWrite(request, reply, { artifactId: row.id }))) {
      return;
    }

    const body = request.body as { newPath?: unknown };
    const pathCheck = validateLogicalPath(body?.newPath);
    if (!pathCheck.ok) return reply.code(400).send({ error: pathCheck.reason });

    if (pathCheck.path === row.path) {
      const namespaceIds = await getArtifactNamespaces(row.id);
      return reply.send(rowToDto(row, namespaceIds, mutable));
    }

    const other = await findArtifactByPathForNamespaces({
      path: pathCheck.path,
      readableNamespaceIds: mutable,
    });
    if (other && other.id !== row.id) {
      return reply.code(409).send({ error: "Path already in use" });
    }

    const oldPath = row.path;
    const updated = await updateArtifactPath({ id: row.id, newPath: pathCheck.path });
    if (!updated) return reply.code(404).send({ error: "Not found" });
    eventBus.emit({
      type: "workspace.artifact.renamed",
      id: updated.id,
      artifactId: updated.artifactId,
      oldPath,
      newPath: pathCheck.path,
    });
    const namespaceIds = await getArtifactNamespaces(updated.id);
    return reply.send(rowToDto(updated, namespaceIds, mutable));
  });

  // ─── D121-P3 — artifact state bridge ────────────────────────────────
  //
  // GET  /api/workspace/artifacts/:id/state/:key — read state value
  // PUT  /api/workspace/artifacts/:id/state/:key — write state value
  //
  // The `:id` URL parameter is the artifact's **internal row uuid**
  // (matches the convention of every other workspace-artifacts route
  // and what the API client passes from `OpenFileTarget`). The state
  // row stores the artifact's **external `artifactId`** (text); we
  // resolve the row first to map between them.
  //
  // Reads apply the subset rule via `envelopeReadableNamespaces`
  // exactly like the other GET routes (M082). Writes target the
  // namespace the artifact attaches to that overlaps the envelope's
  // writable set; if no overlap, 403. That matches the D121 §D-3
  // contract: "writes target the current-Room namespace."
  //
  // 404 for unknown artifact (or one outside the caller's read
  // visibility). 404 for unknown key on GET — distinct from 200 with
  // `value: null` so the iframe-side client can branch cleanly
  // (first-render vs cleared-key).

  function validateStateKey(k: unknown): { ok: true; key: string } | { ok: false; reason: string } {
    if (typeof k !== "string") return { ok: false, reason: "key must be a string" };
    if (k.length === 0) return { ok: false, reason: "key is empty" };
    if (k.length > 512) return { ok: false, reason: "key > 512 chars" };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(k)) return { ok: false, reason: "key contains control characters" };
    return { ok: true, key: k };
  }

  app.get("/api/workspace/artifacts/:id/state/:key", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env))
      return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });
    // Fastify auto-decodes path params once. The earlier code called
    // decodeURIComponent again, which corrupts any key that legitimately
    // contains a `%`-encoded character (e.g. a key the client encoded as
    // `foo%2520bar` to store the literal `foo%20bar` would arrive as
    // `foo%20bar` after Fastify's decode and become `foo bar` after a
    // second decode). Use the param as-is.
    const { id, key } = request.params as { id: string; key: string };
    const keyCheck = validateStateKey(key);
    if (!keyCheck.ok) return reply.code(400).send({ error: keyCheck.reason });
    const readable = envelopeReadableNamespaces(env);
    const row = await findArtifactByInternalIdForNamespaces({
      internalId: id,
      readableNamespaceIds: readable,
    });
    if (!row) return reply.code(404).send({ error: "Not found" });
    const stateRow = await getArtifactStateForNamespaces({
      readableNamespaceIds: readable,
      agentId,
      artifactId: row.artifactId,
      key: keyCheck.key,
    });
    if (!stateRow) return reply.code(404).send({ error: "Key not set" });
    return reply.send({
      artifactId: row.artifactId,
      key: keyCheck.key,
      value: stateRow.value,
      namespaceId: stateRow.namespaceId,
      updatedAt: stateRow.updatedAt.toISOString(),
    });
  });

  app.put(
    "/api/workspace/artifacts/:id/state/:key",
    // State can carry an exact editor recovery envelope. Keep its transport
    // aligned with the existing Artifact save boundary instead of inheriting
    // Fastify's smaller generic JSON default. This reuses an existing transport
    // constraint; it does not establish product authority for the byte count.
    { bodyLimit: ARTIFACT_SAVE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const env = request.memoryEnvelope;
      if (!env) return reply.code(401).send({ error: "Authentication required" });
      if (isScopeMemoryEnvelope(env))
        return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
      const agentId = env.agentId;
      if (!agentId) return reply.code(403).send({ error: "Agent context required" });
      // See GET handler: Fastify auto-decodes path params; do NOT decode a
      // second time (would corrupt keys containing literal `%`-sequences).
      const { id, key } = request.params as { id: string; key: string };
      const keyCheck = validateStateKey(key);
      if (!keyCheck.ok) return reply.code(400).send({ error: keyCheck.reason });

      // The body is a JSON envelope: `{ value: <anything-json-serializable> }`.
      // We accept `value: null` (clear-ish state but still a write); the
      // iframe can use the same key for "checked / unchecked" boolean
      // pairs without inventing a parallel API.
      const body = (request.body ?? {}) as { value?: unknown };
      if (!("value" in body)) {
        return reply.code(400).send({ error: "body.value is required (may be null)" });
      }

      const writable = envelopeWritableNamespaces(env);
      if (writable.length === 0) {
        return reply.code(403).send({
          error: "No writable namespace in this envelope; cannot persist state.",
        });
      }

      // Prefer writing state into a namespace the current envelope can write.
      // If the artifact is only readable from this room context (for example,
      // the user opened an artifact created in another room), fall back to the
      // artifact's readable attachment so the sandbox bridge still works for the
      // visible artifact instead of failing solely because the active room moved.
      const readable = envelopeReadableNamespaces(env);
      const row = await findArtifactByInternalIdForNamespaces({
        internalId: id,
        readableNamespaceIds: readable,
      });
      if (!row) return reply.code(404).send({ error: "Not found" });

      const attached = await getArtifactNamespaces(row.id);
      const targetNamespace =
        attached.find((n) => writable.includes(n)) ??
        attached.find((n) => readable.includes(n));
      if (!targetNamespace) {
        return reply.code(403).send({
          error: "Artifact is not attached to any namespace you can access.",
        });
      }

      if (!(await requireWorkspaceArtifactWrite(request, reply, {
        artifactId: row.id,
        namespaceId: targetNamespace,
      }))) {
        return;
      }

      const stateRow = await setArtifactState({
        namespaceId: targetNamespace,
        agentId,
        artifactId: row.artifactId,
        key: keyCheck.key,
        value: body.value,
      });
      return reply.send({
        artifactId: row.artifactId,
        key: keyCheck.key,
        value: stateRow.value,
        namespaceId: stateRow.namespaceId,
        updatedAt: stateRow.updatedAt.toISOString(),
      });
    },
  );

  // ─── D261 P6b — artifact event back-channel (channel 3) ───────────────

  const PENDING_EVENT_PAYLOAD_MAX_BYTES = 32 * 1024;

  function validateEventTopic(
    t: unknown,
  ): { ok: true; topic: string } | { ok: false; reason: string } {
    if (typeof t !== "string") return { ok: false, reason: "topic must be a string" };
    if (t.length === 0) return { ok: false, reason: "topic is empty" };
    if (t.length > 128) return { ok: false, reason: "topic > 128 chars" };
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(t)) return { ok: false, reason: "topic contains control characters" };
    return { ok: true, topic: t };
  }

  function validateEventPayload(
    p: unknown,
  ): { ok: true; payload: unknown } | { ok: false; reason: string } {
    let serialized: string;
    try {
      serialized = JSON.stringify(p);
    } catch {
      return { ok: false, reason: "payload must be JSON-serializable" };
    }
    if (serialized.length > PENDING_EVENT_PAYLOAD_MAX_BYTES) {
      return { ok: false, reason: "payload exceeds 32KB serialized size cap" };
    }
    return { ok: true, payload: p };
  }

  type ArtifactEventEnqueueOk = {
    ok: true;
    ownerId: string;
    agentId: string;
    roomId: string;
    row: Artifact;
    topic: string;
    eventRow: AppendPendingArtifactEventResult;
    invocationAuthority?: ReturnType<typeof createAcceptedInvocationAuthority>;
  };

  async function enqueueArtifactEvent(
    request: FastifyRequest,
    reply: FastifyReply,
    artifactInternalId: string,
    body: { topic?: unknown; payload?: unknown },
    wakesAgent = false,
  ): Promise<ArtifactEventEnqueueOk | { ok: false }> {
    const env = request.memoryEnvelope;
    if (!env) {
      await reply.code(401).send({ error: "Authentication required" });
      return { ok: false };
    }
    if (isScopeMemoryEnvelope(env)) {
      await reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
      return { ok: false };
    }
    const agentId = env.agentId;
    if (!agentId) {
      await reply.code(403).send({ error: "Agent context required" });
      return { ok: false };
    }
    const ownerId = request.sessionUserId ?? env.ownerId ?? "";
    if (!ownerId) {
      await reply.code(401).send({ error: "Authentication required" });
      return { ok: false };
    }

    const topicCheck = validateEventTopic(body.topic);
    if (!topicCheck.ok) {
      await reply.code(400).send({ error: topicCheck.reason });
      return { ok: false };
    }
    if (!("payload" in body)) {
      await reply.code(400).send({ error: "body.payload is required" });
      return { ok: false };
    }
    const payloadCheck = validateEventPayload(body.payload);
    if (!payloadCheck.ok) {
      await reply.code(400).send({ error: payloadCheck.reason });
      return { ok: false };
    }

    const writable = envelopeWritableNamespaces(env);
    if (writable.length === 0) {
      await reply.code(403).send({
        error: "No writable namespace in this envelope; cannot append artifact events.",
      });
      return { ok: false };
    }

    const readable = envelopeReadableNamespaces(env);
    const row = await resolveEventArtifact({
      internalId: artifactInternalId,
      readableNamespaceIds: readable,
    });
    if (!row) {
      await reply.code(404).send({ error: "Not found" });
      return { ok: false };
    }

    const attached = await resolveEventArtifactNamespaces(row.id);
    const targetNamespace =
      attached.find((n) => writable.includes(n)) ??
      attached.find((n) => readable.includes(n));
    if (!targetNamespace) {
      await reply.code(403).send({
        error: "Artifact is not attached to any namespace you can access.",
      });
      return { ok: false };
    }

    if (!(await requireWorkspaceArtifactWrite(request, reply, {
      artifactId: row.id,
      namespaceId: targetNamespace,
    }))) {
      return { ok: false };
    }

    let invocationAuthority: ReturnType<typeof createAcceptedInvocationAuthority> | undefined;
    if (wakesAgent) {
      if (!(await requireAgentInvocation(
        {
          humanUserId: ownerId,
          origin: "task_create",
          roomId: env.roomId,
          agentId,
        },
        reply,
        service.assertCanInvokeAgent,
      ))) return { ok: false };
      try {
        await getMaintenanceGate().assertAcceptingNewWork();
      } catch (error) {
        if (isMaintenanceDrainError(error)) {
          replyMaintenanceRejection(reply, error);
          return { ok: false };
        }
        throw error;
      }
      invocationAuthority = createAcceptedInvocationAuthority(ownerId);
    }

    const eventRow = await appendEvent({
      namespaceId: targetNamespace,
      agentId,
      artifactId: row.artifactId,
      topic: topicCheck.topic,
      payload: payloadCheck.payload,
    });

    return {
      ok: true,
      ownerId,
      agentId,
      roomId: env.roomId,
      row,
      topic: topicCheck.topic,
      eventRow,
      ...(invocationAuthority ? { invocationAuthority } : {}),
    };
  }

  function artifactEventResponse(
    row: Artifact,
    topic: string,
    eventRow: AppendPendingArtifactEventResult,
    extra: Record<string, unknown> = {},
  ) {
    return {
      ok: true,
      artifactId: row.artifactId,
      topic,
      id: eventRow.id,
      createdAt: eventRow.createdAt.toISOString(),
      ...(eventRow.droppedCount > 0 ? { droppedCount: eventRow.droppedCount } : {}),
      ...extra,
    };
  }

  app.post("/api/workspace/artifacts/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { topic?: unknown; payload?: unknown };
    const enqueued = await enqueueArtifactEvent(request, reply, id, body);
    if (!enqueued.ok) return;
    return reply.send(
      artifactEventResponse(enqueued.row, enqueued.topic, enqueued.eventRow),
    );
  });

  app.post("/api/workspace/artifacts/:id/events/ping", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { topic?: unknown; payload?: unknown };
    const enqueued = await enqueueArtifactEvent(request, reply, id, body, true);
    if (!enqueued.ok) return;

    const {
      ownerId,
      agentId,
      roomId,
      row,
      topic,
      eventRow,
      invocationAuthority,
    } = enqueued;
    if (!invocationAuthority) throw new TypeError("waking ping requires invocation authority");
    const openPing = await findOpenPingTask(getServerDirectDb(), {
      ownerId,
      agentId,
      artifactId: row.artifactId,
    });
    if (openPing) {
      return reply.send(
        artifactEventResponse(row, topic, eventRow, { woke: false }),
      );
    }

    await runtimeCreateTask(
      {
        db: getServerDirectDb(),
        observer: getTaskObserver() ?? { kick() {} },
        invocationAuthority,
        provenance: createArtifactEventTaskCreationProvenance({
          ownerId,
          artifactId: row.artifactId,
          roomId,
        }),
        admission: getPlaintextTaskCreationAdmission(),
      },
      {
        ownerId,
        requestorId: ownerId,
        agentId,
        preset: "ping",
        prompt:
          `[ARTIFACT EVENT @${row.artifactId}] path="${row.path}" topic="${topic}". ` +
          `An interactive artifact you authored signaled you. ` +
          `Call read_artifact_events on its workspace path to drain pending events, then react.`,
        scheduleKind: "now",
        targetChat: "last_in_namespace",
        ...(roomId ? { targetRoomId: roomId } : {}),
        targetUserIds: [ownerId],
        useScope: false,
        toolsMode: "whitelist",
        toolsWhitelist: ["read_artifact_events"],
        awaitResponse: false,
        resultDelivery: "wake",
        metadata: { artifactId: row.artifactId, topic, source: "artifact_ping" },
      },
    );

    return reply.send(
      artifactEventResponse(row, topic, eventRow, { woke: true }),
    );
  });

  app.delete("/api/workspace/artifacts/:id", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    if (isScopeMemoryEnvelope(env)) return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });
    const { id } = request.params as { id: string };
    const mutable = envelopeMutableNamespaces(env);
    const row = await findArtifactByInternalIdForNamespaces({
      internalId: id,
      readableNamespaceIds: mutable,
    });
    if (!row) return reply.code(404).send({ error: "Not found" });

    if (!(await requireWorkspaceArtifactWrite(request, reply, { artifactId: row.id }))) {
      return;
    }
    const namespaceIds = await getArtifactNamespaces(row.id);
    const deleted = await markArtifactDeleted({ id: row.id });
    if (!deleted) return reply.code(404).send({ error: "Not found" });
    eventBus.emit({
      type: "workspace.artifact.deleted",
      id: row.id,
      artifactId: row.artifactId,
      namespaceIds,
    });
    return reply.send({ ok: true });
  });
}
