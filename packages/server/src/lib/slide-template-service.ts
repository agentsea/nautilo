import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getArtifactsRoot } from "@nautilo/config";
import {
  attachArtifactToNamespace,
  db,
  findArtifactByIdForNamespaces,
  findArtifactReconciliationIdentity,
  getArtifactNamespaces,
  insertArtifact,
  listArtifactsForExactNamespacePage,
  markArtifactDeletedForExactNamespace,
  type Artifact,
  type ArtifactReconciliationIdentity,
  type Database,
  type ExactNamespaceArtifactPageCursor,
} from "@nautilo/db";
import type {
  SlideTemplateContentDto,
  SlideTemplateListPageDto,
  SlideTemplateSummaryDto,
} from "@nautilo/api-client";
import {
  assertCanWriteArtifacts,
  findActorByOwnerId,
  findAgentOwnerPrivateRoom,
  findPersonalAgentsForUser,
} from "@nautilo/trust";
import { eventBus } from "@nautilo/runtime";
import { MAX_DOCUMENT_BYTES } from "@nautilo/writer-proposal-core";
import type { ArtifactWriteAdmissionInput } from "@nautilo/trust";

export type AssertCanWriteArtifacts = (input: ArtifactWriteAdmissionInput) => Promise<void>;
export const SLIDE_TEMPLATE_PATH_PREFIX = "Design/My Templates/";
export const SLIDE_TEMPLATE_MIME_TYPE = "application/vnd.nautilo.slide-template+html";
const SLIDE_TEMPLATE_SUFFIX = ".slide-template.html";
// Same transport batch as the ordinary Workspace list. The cursor removes any
// total collection ceiling; callers continue until nextCursor is null.
export const SLIDE_TEMPLATE_PAGE_BATCH = 500;
// Keep template paths inside the ordinary Workspace Artifact path contract.
const WORKSPACE_ARTIFACT_PATH_MAX_CHARS = 4096;
// A JSON string can expand each input byte to a six-byte \u00XX escape. This
// transport allowance is derived from the canonical document and path caps;
// valid decoded content remains bounded by MAX_DOCUMENT_BYTES below.
export const SLIDE_TEMPLATE_REQUEST_BODY_MAX_BYTES =
  MAX_DOCUMENT_BYTES * 6 + WORKSPACE_ARTIFACT_PATH_MAX_CHARS * 6 +
  Buffer.byteLength(JSON.stringify({ name: "", content: "" }), "utf8");

export type TemplateArtifactPageInput = Readonly<{
  namespaceId: string;
  pageSize: number;
  cursor?: ExactNamespaceArtifactPageCursor;
}>;

export type PersistTemplateInput = Readonly<{
  templateId: string;
  name: string;
  content: string;
  namespaceId: string;
}>;

type PersistTemplateDependencies = Readonly<{
  artifactsRoot(): string;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  read?(path: string): Promise<string>;
  transaction<T>(callback: (tx: Database) => Promise<T>): Promise<T>;
  commit?(input: PersistTemplateInput, absolutePath: string): Promise<Artifact>;
  findCreated(
    templateId: string,
  ): Promise<{ artifact: ArtifactReconciliationIdentity; namespaceIds: string[] } | null>;
}>;

/** Publish complete bytes exclusively; a killed writer never leaves a partial
 * deterministic claim that every subsequent retry would refuse. */
export async function writeSlideTemplateBytes(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

const defaultPersistDependencies: PersistTemplateDependencies = {
  artifactsRoot: getArtifactsRoot,
  write: writeSlideTemplateBytes,
  remove: async (path) => rm(path, { force: true }),
  read: async (path) => readFile(path, "utf8"),
  transaction: async (callback) => db.transaction(async (tx) => callback(tx as unknown as Database)),
  findCreated: async (templateId) => {
    const artifact = await findArtifactReconciliationIdentity(templateId);
    return artifact
      ? { artifact, namespaceIds: await getArtifactNamespaces(artifact.id) }
      : null;
  },
};

export interface SlideTemplateRouteService {
  resolvePrivateNamespace(userId: string, actorId: string): Promise<string | null>;
  listPage(input: TemplateArtifactPageInput): Promise<Artifact[]>;
  findById(templateId: string, namespaceId: string): Promise<Artifact | null>;
  getNamespaceIds(artifactInternalId: string): Promise<string[]>;
  read(storageUri: string): Promise<string>;
  persist(input: PersistTemplateInput): Promise<Artifact>;
  remove(artifactInternalId: string, namespaceId: string): Promise<Artifact | null>;
  assertCanWriteArtifacts: AssertCanWriteArtifacts;
  publish(event: Parameters<typeof eventBus.emit>[0]): void;
  /** Includes deleted rows solely for deterministic retry reconciliation. */
  findIdentity?(templateId: string): Promise<{
    artifact: ArtifactReconciliationIdentity;
    namespaceIds: string[];
  } | null>;
}

function storagePath(storageUri: string): string | null {
  if (!storageUri.startsWith("file://")) return null;
  const path = storageUri.slice("file://".length);
  return path.startsWith("/") ? path : null;
}

export function normalizeTemplateName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  // eslint-disable-next-line no-control-regex -- Artifact paths reject control characters.
  if (normalized.length === 0 || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

export function templatePath(templateId: string, name: string): string | null {
  const encodedName = Buffer.from(name, "utf8").toString("base64url");
  const path = `${SLIDE_TEMPLATE_PATH_PREFIX}${templateId}.${encodedName}${SLIDE_TEMPLATE_SUFFIX}`;
  return path.length <= WORKSPACE_ARTIFACT_PATH_MAX_CHARS ? path : null;
}

export function templateSummary(artifact: Artifact): SlideTemplateSummaryDto | null {
  if (artifact.mimeType !== SLIDE_TEMPLATE_MIME_TYPE) return null;
  const prefix = `${SLIDE_TEMPLATE_PATH_PREFIX}${artifact.artifactId}.`;
  if (!artifact.path.startsWith(prefix) || !artifact.path.endsWith(SLIDE_TEMPLATE_SUFFIX)) return null;
  const encodedName = artifact.path.slice(prefix.length, -SLIDE_TEMPLATE_SUFFIX.length);
  if (encodedName.length === 0) return null;
  try {
    const name = Buffer.from(encodedName, "base64url").toString("utf8");
    if (Buffer.from(name, "utf8").toString("base64url") !== encodedName) return null;
    const normalized = normalizeTemplateName(name);
    if (normalized === null || normalized !== name) return null;
    return { id: artifact.artifactId, name };
  } catch {
    return null;
  }
}

function isReconciledTemplateArtifact(
  artifact: ArtifactReconciliationIdentity,
  input: PersistTemplateInput,
  absolutePath: string,
): artifact is Artifact {
  const expectedPath = templatePath(input.templateId, input.name);
  return expectedPath !== null &&
    artifact.artifactId === input.templateId &&
    artifact.path === expectedPath &&
    artifact.storageUri === `file://${absolutePath}` &&
    artifact.mimeType === SLIDE_TEMPLATE_MIME_TYPE &&
    artifact.size === Buffer.byteLength(input.content, "utf8") &&
    artifact.deletedAt === null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeTemplateJson(value: unknown): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "number" && !Number.isFinite(current)) return false;
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
      pending.push(child);
    }
  }
  return true;
}

/**
 * Validate the stable presentation HTML envelope without importing the
 * optional first-party Slides engine into server startup. The Slides parser
 * performs the complete model validation before insertion; this boundary
 * proves that stored bytes are canonical, inert presentation data with the
 * one-slide template shape rather than an arbitrary private Artifact write.
 */
export function validTemplateContent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > MAX_DOCUMENT_BYTES) return false;
  const match = /^<!doctype html>\n<html><head><meta charset="utf-8"><title>Presentation<\/title><\/head><body>\n<script id="manifest" type="application\/vnd\.nautilo\.document\+json">([^<]*)<\/script>\n<script id="wafflebase-presentation" type="application\/vnd\.wafflebase\.presentation\+json">([^<]*)<\/script>\n<\/body><\/html>$/.exec(value);
  if (!match) return false;
  try {
    const manifest: unknown = JSON.parse(match[1]!);
    const payload: unknown = JSON.parse(match[2]!);
    if (!isRecord(manifest) || !isRecord(payload) || !isSafeTemplateJson(payload)) return false;
    if (
      Object.keys(manifest).length !== 5 ||
      manifest["documentType"] !== "presentation" ||
      manifest["editor"] !== "wafflebase" ||
      manifest["payloadId"] !== "wafflebase-presentation" ||
      manifest["payloadFormat"] !== "application/vnd.wafflebase.presentation+json" ||
      manifest["version"] !== "1.0"
    ) return false;
    if (
      !isRecord(payload["meta"]) ||
      typeof payload["meta"]["title"] !== "string" ||
      typeof payload["meta"]["themeId"] !== "string" ||
      typeof payload["meta"]["masterId"] !== "string" ||
      !Array.isArray(payload["themes"]) ||
      !Array.isArray(payload["masters"]) ||
      !Array.isArray(payload["layouts"]) ||
      !Array.isArray(payload["slides"]) ||
      payload["slides"].length !== 1 ||
      !Array.isArray(payload["guides"])
    ) return false;
    // serializeSlideHtml emits minified safe-script JSON. Requiring the same
    // representation rejects executable markup hidden in otherwise valid data.
    const canonicalManifest = JSON.stringify(manifest).replace(/</g, "\\u003c");
    const canonicalPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
    return match[1] === canonicalManifest && match[2] === canonicalPayload;
  } catch {
    return false;
  }
}

function cursorScope(userId: string, namespaceId: string): string {
  return createHash("sha256")
    .update(userId)
    .update("\0")
    .update(namespaceId)
    .update("\0")
    .update(SLIDE_TEMPLATE_PATH_PREFIX)
    .digest("hex");
}

export function encodeCursor(
  artifact: Artifact,
  userId: string,
  namespaceId: string,
): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    updatedAt: artifact.updatedAt.toISOString(),
    id: artifact.id,
    scope: cursorScope(userId, namespaceId),
  }), "utf8").toString("base64url");
}

export function decodeSlideTemplateCursor(
  value: unknown,
  userId: string,
  namespaceId: string,
): ExactNamespaceArtifactPageCursor | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).some((key) =>
        key !== "version" && key !== "updatedAt" && key !== "id" && key !== "scope") ||
      record["version"] !== 1 ||
      typeof record["updatedAt"] !== "string" ||
      typeof record["id"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record["id"]) ||
      record["scope"] !== cursorScope(userId, namespaceId)
    ) return null;
    const updatedAt = new Date(record["updatedAt"]);
    if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== record["updatedAt"]) return null;
    return { updatedAt, id: record["id"] };
  } catch {
    return null;
  }
}

async function defaultResolvePrivateNamespace(
  userId: string,
  actorId: string,
): Promise<string | null> {
  const actor = await findActorByOwnerId(userId);
  if (!actor || actor.id !== actorId) return null;
  const personalAgents = await findPersonalAgentsForUser(userId);
  const personalAgentId = personalAgents[0]?.agentId;
  if (!personalAgentId) return null;
  return (await findAgentOwnerPrivateRoom(userId, personalAgentId))?.namespaceId ?? null;
}

export async function persistSlideTemplateArtifact(
  input: PersistTemplateInput,
  dependencies: PersistTemplateDependencies = defaultPersistDependencies,
): Promise<Artifact> {
  const path = templatePath(input.templateId, input.name);
  if (path === null) throw new TypeError("Template name is too long.");
  const root = dependencies.artifactsRoot();
  const absolutePath = join(root, input.templateId);
  const readExactBytes = async (): Promise<boolean> => {
    try { return await (dependencies.read ?? ((candidate) => readFile(candidate, "utf8")))(absolutePath) === input.content; }
    catch { return false; }
  };
  await mkdir(root, { recursive: true });
  try {
    await dependencies.write(absolutePath, input.content);
  } catch (writeError) {
    let committed: { artifact: ArtifactReconciliationIdentity; namespaceIds: string[] } | null;
    try { committed = await dependencies.findCreated(input.templateId); }
    catch { throw writeError; }
    if (committed) {
      if (isReconciledTemplateArtifact(committed.artifact, input, absolutePath) && committed.namespaceIds.length === 1 && committed.namespaceIds[0] === input.namespaceId && await readExactBytes()) return committed.artifact;
      throw writeError;
    }
    let orphanContent: string;
    try { orphanContent = await (dependencies.read ?? ((path) => readFile(path, "utf8")))(absolutePath); }
    catch { throw writeError; }
    if (orphanContent !== input.content) throw writeError;
    // Exact bytes without an Artifact row are a recoverable prior crash. The
    // transaction below adopts them; no caller may delete this shared claim.
  }
  try {
    const commit = dependencies.commit ?? (async (candidate: PersistTemplateInput, candidatePath: string) => dependencies.transaction(async (tx) => {
      const created = await insertArtifact({
        internalId: randomUUID(),
        artifactId: candidate.templateId,
        path: templatePath(candidate.templateId, candidate.name)!,
        storageUri: `file://${candidatePath}`,
        mimeType: SLIDE_TEMPLATE_MIME_TYPE,
        size: Buffer.byteLength(candidate.content, "utf8"),
      }, tx);
      await attachArtifactToNamespace({
        artifactId: created.id,
        namespaceId: candidate.namespaceId,
      }, tx);
      return created;
    }));
    return await commit(input, absolutePath);
  } catch (error) {
    // A transaction can commit and then lose its acknowledgement. Reconcile by
    // the generated canonical Artifact id before deciding these owned bytes are
    // orphaned. Lookup failure is uncertain and deliberately retains bytes.
    let committed: { artifact: ArtifactReconciliationIdentity; namespaceIds: string[] } | null;
    try {
      committed = await dependencies.findCreated(input.templateId);
    } catch {
      throw error;
    }
    if (committed) {
      if (
        isReconciledTemplateArtifact(committed.artifact, input, absolutePath) &&
        committed.namespaceIds.length === 1 &&
        committed.namespaceIds[0] === input.namespaceId &&
        await readExactBytes()
      ) return committed.artifact;
      throw error;
    }
    // Retain exact bytes after a proven-uncommitted failure: another
    // concurrent retry may already be adopting the same deterministic file.
    throw error;
  }
}

export const defaultSlideTemplateService: SlideTemplateRouteService = {
  resolvePrivateNamespace: defaultResolvePrivateNamespace,
  listPage: (input) => listArtifactsForExactNamespacePage({
    namespaceId: input.namespaceId,
    pathPrefix: SLIDE_TEMPLATE_PATH_PREFIX,
    mimeType: SLIDE_TEMPLATE_MIME_TYPE,
    pageSize: input.pageSize,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  }),
  findById: (templateId, namespaceId) => findArtifactByIdForNamespaces({
    artifactId: templateId,
    readableNamespaceIds: [namespaceId],
  }),
  getNamespaceIds: getArtifactNamespaces,
  read: async (storageUri) => {
    const path = storagePath(storageUri);
    if (!path) throw new Error("Template bytes are unavailable.");
    return readFile(path, "utf8");
  },
  persist: persistSlideTemplateArtifact,
  remove: (artifactInternalId, namespaceId) => markArtifactDeletedForExactNamespace({
    id: artifactInternalId,
    namespaceId,
  }),
  assertCanWriteArtifacts,
  publish: (event) => eventBus.emit(event),
  findIdentity: async (templateId) => {
    const artifact = await findArtifactReconciliationIdentity(templateId);
    return artifact ? { artifact, namespaceIds: await getArtifactNamespaces(artifact.id) } : null;
  },
};


export async function resolvePrivateSlideTemplateNamespace(
  userId: string,
  actorId: string,
  service: SlideTemplateRouteService = defaultSlideTemplateService,
): Promise<string | null> {
  return service.resolvePrivateNamespace(userId, actorId);
}

export async function listPrivateSlideTemplates(
  input: { userId: string; namespaceId: string; cursor?: unknown },
  service: SlideTemplateRouteService = defaultSlideTemplateService,
): Promise<SlideTemplateListPageDto> {
  const cursor = input.cursor === undefined
    ? undefined
    : decodeSlideTemplateCursor(input.cursor, input.userId, input.namespaceId);
  if (input.cursor !== undefined && !cursor) throw new TypeError("Invalid template cursor");
  const rows = await service.listPage({
    namespaceId: input.namespaceId,
    pageSize: SLIDE_TEMPLATE_PAGE_BATCH + 1,
    ...(cursor ? { cursor } : {}),
  });
  const hasNext = rows.length > SLIDE_TEMPLATE_PAGE_BATCH;
  const rawPage = rows.slice(0, SLIDE_TEMPLATE_PAGE_BATCH);
  const visible = rawPage.map(templateSummary).filter((value): value is SlideTemplateSummaryDto => value !== null);
  const last = rawPage.at(-1);
  return {
    templates: visible,
    nextCursor: hasNext && last ? encodeCursor(last, input.userId, input.namespaceId) : null,
  };
}

export async function readPrivateSlideTemplate(
  templateId: string,
  namespaceId: string,
  service: SlideTemplateRouteService = defaultSlideTemplateService,
): Promise<SlideTemplateContentDto | null> {
  const found = await requireExactTemplate(templateId, namespaceId, service);
  if (!found) return null;
  const content = await service.read(found.artifact.storageUri);
  if (!validTemplateContent(content)) throw new TypeError("Template content is invalid");
  return { content };
}

export async function savePrivateSlideTemplate(
  input: { userId: string; namespaceId: string; name: unknown; content: unknown; templateId?: string },
  service: SlideTemplateRouteService = defaultSlideTemplateService,
): Promise<
  | { ok: true; template: SlideTemplateSummaryDto; stateChanged: boolean; warnings?: string[] }
  | { ok: false; code: string; phase: "admission" | "persist" | "reconcile"; retrySafe: boolean; stateChanged: false | "unknown"; recoveryActions: string[]; message: string }
> {
  const name = normalizeTemplateName(input.name);
  if (!name || !validTemplateContent(input.content)) return { ok: false, code: "INVALID_TEMPLATE", phase: "admission", retrySafe: false, stateChanged: false, recoveryActions: ["Correct the template name or content."], message: "Template content is invalid." };
  const templateId = input.templateId ?? randomUUID();
  if (templatePath(templateId, name) === null) return { ok: false, code: "INVALID_TEMPLATE_NAME", phase: "admission", retrySafe: false, stateChanged: false, recoveryActions: ["Use a shorter template name."], message: "Template name is too long." };
  const desired = { templateId, name, content: input.content, namespaceId: input.namespaceId };
  const reconcile = async () => service.findIdentity?.(templateId) ?? null;
  const matchesExisting = async (existing: NonNullable<Awaited<ReturnType<typeof reconcile>>>): Promise<boolean> => {
    const summary = templateSummary(existing.artifact as Artifact);
    if (existing.artifact.deletedAt !== null || summary?.id !== templateId || summary.name !== name || existing.namespaceIds.length !== 1 || existing.namespaceIds[0] !== input.namespaceId) return false;
    try { return await service.read(existing.artifact.storageUri!) === input.content; }
    catch { return false; }
  };
  if (input.templateId && service.findIdentity) {
    let existing;
    try { existing = await reconcile(); }
    catch { return { ok: false, code: "TEMPLATE_RECONCILIATION_UNAVAILABLE", phase: "reconcile", retrySafe: false, stateChanged: "unknown", recoveryActions: ["Check the private template library before retrying."], message: "Template save state could not be determined." }; }
    if (existing) {
      if (await matchesExisting(existing)) {
        return { ok: true, template: { id: templateId, name }, stateChanged: false };
      }
      return { ok: false, code: "TEMPLATE_IDENTITY_CONFLICT", phase: "admission", retrySafe: false, stateChanged: false, recoveryActions: ["Start a new tool invocation."], message: "Template retry identity is already in use." };
    }
  }
  try { await service.assertCanWriteArtifacts({ humanUserId: input.userId, namespaceId: input.namespaceId }); }
  catch { return { ok: false, code: "TEMPLATE_WRITE_DENIED", phase: "admission", retrySafe: false, stateChanged: false, recoveryActions: ["Restore private Workspace write access."], message: "Template save is not authorized." }; }
  let created: Artifact;
  try { created = await service.persist(desired); }
  catch {
    if (!service.findIdentity) return { ok: false, code: "TEMPLATE_SAVE_FAILED", phase: "persist", retrySafe: false, stateChanged: "unknown", recoveryActions: ["Check the private template library before retrying."], message: "Template save state could not be determined." };
    try {
      const existing = await reconcile();
      if (existing && await matchesExisting(existing)) return { ok: true, template: { id: templateId, name }, stateChanged: false };
      if (!existing) return { ok: false, code: "TEMPLATE_SAVE_FAILED", phase: "persist", retrySafe: true, stateChanged: false, recoveryActions: ["Retry the same tool invocation."], message: "Template was not saved." };
      return { ok: false, code: "TEMPLATE_IDENTITY_CONFLICT", phase: "reconcile", retrySafe: false, stateChanged: false, recoveryActions: ["Start a new tool invocation."], message: "Template retry identity is already in use." };
    } catch { return { ok: false, code: "TEMPLATE_RECONCILIATION_UNAVAILABLE", phase: "reconcile", retrySafe: false, stateChanged: "unknown", recoveryActions: ["Check the private template library before retrying."], message: "Template save state could not be determined." }; }
  }
  try { service.publish({ type: "workspace.artifact.changed", id: created.id, artifactId: created.artifactId, path: created.path }); }
  catch { return { ok: true, template: { id: created.artifactId, name }, stateChanged: true, warnings: ["Template was saved, but its change notification was not published."] }; }
  return { ok: true, template: { id: created.artifactId, name }, stateChanged: true };
}

export async function removePrivateSlideTemplate(
  input: { userId: string; namespaceId: string; templateId: string },
  service: SlideTemplateRouteService = defaultSlideTemplateService,
): Promise<{ ok: true; stateChanged: boolean; warnings?: string[] } | { ok: false; code: string; phase: "admission" | "remove" | "reconcile"; retrySafe: boolean; stateChanged: false | "unknown"; recoveryActions: string[]; message: string }> {
  const found = await requireExactTemplate(input.templateId, input.namespaceId, service);
  if (!found) {
    try {
      const prior = await service.findIdentity?.(input.templateId);
      if (prior && prior.artifact.deletedAt !== null && prior.namespaceIds.length === 1 && prior.namespaceIds[0] === input.namespaceId && templateSummary(prior.artifact as Artifact)) return { ok: true, stateChanged: false };
    } catch { return { ok: false, code: "TEMPLATE_RECONCILIATION_UNAVAILABLE", phase: "reconcile", retrySafe: false, stateChanged: "unknown", recoveryActions: ["Check the private template library before retrying."], message: "Template removal state could not be determined." }; }
    return { ok: false, code: "TEMPLATE_NOT_FOUND", phase: "admission", retrySafe: false, stateChanged: false, recoveryActions: [], message: "Template not found." };
  }
  try { await service.assertCanWriteArtifacts({
    humanUserId: input.userId, artifactId: found.artifact.id, namespaceId: input.namespaceId,
  }); } catch { return { ok: false, code: "TEMPLATE_WRITE_DENIED", phase: "admission", retrySafe: false, stateChanged: false, recoveryActions: ["Restore private Workspace write access."], message: "Template removal is not authorized." }; }
  let deleted: Artifact | null;
  try { deleted = await service.remove(found.artifact.id, input.namespaceId); }
  catch { return { ok: false, code: "TEMPLATE_REMOVE_FAILED", phase: "remove", retrySafe: false, stateChanged: "unknown", recoveryActions: ["Check the private template library before retrying."], message: "Template removal state could not be determined." }; }
  if (!deleted) return { ok: false, code: "TEMPLATE_REMOVE_FAILED", phase: "remove", retrySafe: true, stateChanged: false, recoveryActions: ["Retry the same removal."], message: "Template was not removed." };
  try { service.publish({ type: "workspace.artifact.deleted", id: deleted.id, artifactId: deleted.artifactId, namespaceIds: [input.namespaceId] }); }
  catch { return { ok: true, stateChanged: true, warnings: ["Template was removed, but its change notification was not published."] }; }
  return { ok: true, stateChanged: true };
}

export async function requireExactTemplate(
  templateId: string,
  namespaceId: string,
  service: SlideTemplateRouteService,
): Promise<{ artifact: Artifact; summary: SlideTemplateSummaryDto } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(templateId)) return null;
  const artifact = await service.findById(templateId, namespaceId);
  if (!artifact) return null;
  const summary = templateSummary(artifact);
  if (!summary) return null;
  const namespaceIds = await service.getNamespaceIds(artifact.id);
  if (namespaceIds.length !== 1 || namespaceIds[0] !== namespaceId) return null;
  return { artifact, summary };
}
