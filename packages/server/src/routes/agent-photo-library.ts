import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharp from "sharp";
import { error as logError } from "@nautilo/logger";
import {
  getServerDirectDb,
} from "../lib/server-direct-db";
import {
  AgentPhotoLibraryError,
  type AgentPhotoLibraryAuthority,
} from "../lib/agent-photo-library-service";
import { createProductionAgentPhotoLibraryService } from "../lib/agent-photo-library-production";
import { AgentPhotoLibraryCreateCoordinator } from "../lib/agent-photo-library-create-coordinator";
import { AgentPhotoLibraryReadService } from "../lib/agent-photo-library-read-service";
import {
  createPhotoLibraryCursorCodec,
  type PhotoLibraryCursorCodec,
  type PhotoLibraryProjection,
} from "../photo-library/photo-library-cursor";
import { hasCompleteOwnedAvatarMedia, readStrictOwnedAvatarMedia } from "../photo-library/strict-avatar-media";
import { requirePairingPepper } from "../remote-control/pairing-secrets";
import { AGENT_AVATAR_PRESET_IDS } from "@nautilo/types";
import { requestIsVersioned, setMediaCacheHeaders } from "./_helpers/avatar";
import { findPersonalAgentsForUser } from "@nautilo/trust";
import { eq, nautiloInstanceIdentity, type AgentPhotoSelectionOrigin, type DirectDatabase } from "@nautilo/db";
import {
  composeAvatarPrompt,
  generateImages,
  getDefaultImageModel,
  resolveProviderKey,
  setManageAvatarPhotoLibraryPort,
} from "@nautilo/agent";

const DEFAULT_PAGE_LIMIT = 24;
const MAX_PAGE_LIMIT = 48;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_DIMENSION = 8192;

type RouteAuthority = AgentPhotoLibraryAuthority;

export interface AgentPhotoLibraryRouteDeps {
  readonly db?: DirectDatabase;
  readonly now?: () => Date;
  readonly cursorCodec?: PhotoLibraryCursorCodec;
  readonly resolvePersonalAgentId?: (input: { userId: string; effectiveAgentId: string | null }) => Promise<string | null>;
  /** Test seam for the server/viewer scope revalidation boundary. */
  readonly afterAuthorityResolved?: (authority: RouteAuthority) => void | Promise<void>;
  readonly readMedia?: typeof readStrictOwnedAvatarMedia;
  readonly blobExists?: (input: {
    entryId: string;
    kind: "generated" | "uploaded";
    blobId: string;
    mediaMimeType: string;
    mediaByteSize: number;
    mediaSha256: string;
  }) => boolean | Promise<boolean>;
  readonly createService?: ReturnType<typeof createProductionAgentPhotoLibraryService>;
  readonly createCoordinator?: Pick<AgentPhotoLibraryCreateCoordinator, "produceStageAndFinalize">;
  readonly generateImages?: typeof generateImages;
  readonly getDefaultImageModel?: typeof getDefaultImageModel;
  readonly resolveProviderKey?: typeof resolveProviderKey;
  readonly composeAvatarPrompt?: typeof composeAvatarPrompt;
}

function operationIdFrom(request: FastifyRequest): string | null {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" ? value : null;
}

function originFrom(request: FastifyRequest): AgentPhotoSelectionOrigin {
  const value = request.headers["x-agent-photo-origin"];
  return value === "workbench" || value === "mobile" || value === "desktop_wizard"
    || value === "cli_setup"
    || value === "manage_avatar" || value === "bundle_import"
    ? value
    : "workbench";
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function normalizeUpload(request: FastifyRequest): Promise<Buffer | null> {
  const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  if (!part || part.fieldname !== "file" || !["image/png", "image/jpeg", "image/webp"].includes(part.mimetype ?? "")) return null;
  const source = await part.toBuffer();
  if (source.length < 1 || source.length > MAX_UPLOAD_BYTES) return null;
  const metadata = await sharp(source).metadata();
  if ((metadata.width ?? 0) > MAX_UPLOAD_DIMENSION || (metadata.height ?? 0) > MAX_UPLOAD_DIMENSION) return null;
  return sharp(source).rotate().resize(256, 256, { fit: "cover", position: "center" }).png({ compressionLevel: 9 }).toBuffer();
}

function errorEnvelope(
  code: string,
  message: string,
  retryable: boolean,
  extras: Record<string, unknown> = {},
) {
  return { error: { code, message, retryable, ...extras } };
}

function statusFor(error: AgentPhotoLibraryError): number {
  switch (error.code) {
    case "photo_forbidden": return 403;
    case "photo_not_found": return 404;
    case "photo_deleted":
    case "photo_blob_missing": return 410;
    case "selection_conflict":
    case "stale_library_revision":
    case "undo_conflict":
    case "stale_viewer_scope": return 409;
    case "idempotency_mismatch":
    case "library_capacity_reached":
    case "deleted_library_capacity_reached": return 409;
    case "photo_library_unavailable": return 503;
    default: return 400;
  }
}

function sendLibraryError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentPhotoLibraryError) {
    return reply.code(statusFor(error)).send(errorEnvelope(
      error.code,
      error.message,
      error.retryable,
      {
        ...(error.current ? { current: error.current } : {}),
        ...(error.scope ? { scope: error.scope } : {}),
      },
    ));
  }
  logError("[agent-photo-library] read request failed", {
    error: error instanceof Error ? error.name : typeof error,
  });
  return reply.code(503).send(errorEnvelope(
    "photo_library_unavailable",
    "The photo library is temporarily unavailable",
    true,
  ));
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof value !== "string" || !/^[0-9]{1,2}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_PAGE_LIMIT ? parsed : null;
}

function parseProjection(value: unknown): PhotoLibraryProjection | null {
  if (value === undefined || value === "recent") return "recent";
  return value === "deleted" ? "deleted" : null;
}

function defaultBlobExists(input: {
  entryId: string;
  kind: "generated" | "uploaded";
  blobId: string;
  mediaMimeType: string;
  mediaByteSize: number;
  mediaSha256: string;
}): Promise<boolean> {
  return hasCompleteOwnedAvatarMedia(input);
}

async function resolveAuthority(
  db: DirectDatabase,
  request: FastifyRequest,
  resolvePersonalAgentId: (input: { userId: string; effectiveAgentId: string | null }) => Promise<string | null>,
): Promise<RouteAuthority> {
  const viewerUserId = request.sessionUserId;
  if (!viewerUserId) {
    throw new AgentPhotoLibraryError({
      code: "photo_forbidden",
      message: "Agent photo access requires an authenticated session",
      retryable: false,
    });
  }
  const agentId = await resolvePersonalAgentId({
    userId: viewerUserId,
    effectiveAgentId: request.memoryEnvelope?.agentId ?? null,
  });
  if (!agentId) {
    throw new AgentPhotoLibraryError({
      code: "photo_forbidden",
      message: "Agent photo access is not available for this viewer",
      retryable: false,
    });
  }
  const [identity] = await db
    .select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  if (!identity) {
    throw new AgentPhotoLibraryError({
      code: "photo_library_unavailable",
      message: "The Server identity is unavailable",
      retryable: true,
    });
  }
  return {
    serverInstanceId: identity.serverInstanceId,
    viewerUserId,
    ownerUserId: viewerUserId,
    agentId,
  };
}

/** D487 canonical owned Agent-photo read and mutation surface. */
export function agentPhotoLibraryRoutes(app: FastifyInstance, deps: AgentPhotoLibraryRouteDeps = {}): void {
  const db = deps.db ?? getServerDirectDb();
  const now = deps.now ?? (() => new Date());
  const resolvePersonalAgentId = deps.resolvePersonalAgentId ?? (async ({ userId, effectiveAgentId }) => {
    const owned = await findPersonalAgentsForUser(userId);
    if (effectiveAgentId !== null) {
      return owned.some((agent) => agent.agentId === effectiveAgentId) ? effectiveAgentId : null;
    }
    return owned[0]?.agentId ?? null;
  });
  const readService = new AgentPhotoLibraryReadService({
    db,
    blobExists: deps.blobExists ?? defaultBlobExists,
    now,
  });
  const mutationService = deps.createService ?? createProductionAgentPhotoLibraryService(db);
  const createCoordinator = deps.createCoordinator
    ?? new AgentPhotoLibraryCreateCoordinator(mutationService);
  const generateAvatarImages = deps.generateImages ?? generateImages;
  const getImageModel = deps.getDefaultImageModel ?? getDefaultImageModel;
  const providerKey = deps.resolveProviderKey ?? resolveProviderKey;
  const avatarPrompt = deps.composeAvatarPrompt ?? composeAvatarPrompt;
  const readMedia = deps.readMedia ?? readStrictOwnedAvatarMedia;
  let cursorCodec: PhotoLibraryCursorCodec | null = deps.cursorCodec ?? null;
  const codec = (): PhotoLibraryCursorCodec => {
    if (!cursorCodec) cursorCodec = createPhotoLibraryCursorCodec(requirePairingPepper(), now);
    return cursorCodec;
  };
  const authorityFor = async (request: FastifyRequest): Promise<RouteAuthority> => {
    const authority = await resolveAuthority(db, request, resolvePersonalAgentId);
    await deps.afterAuthorityResolved?.(authority);
    return authority;
  };
  const authorityForTool = async (input: {
    ownerId: string;
    agentId: string;
  }): Promise<RouteAuthority> => {
    const [identity] = await db
      .select({
        serverInstanceId: nautiloInstanceIdentity.serverInstanceId,
      })
      .from(nautiloInstanceIdentity)
      .where(eq(nautiloInstanceIdentity.id, "self"))
      .limit(1);
    if (!identity) {
      throw new AgentPhotoLibraryError({
        code: "photo_library_unavailable",
        message: "The Server identity is unavailable",
        retryable: true,
      });
    }
    return {
      serverInstanceId: identity.serverInstanceId,
      viewerUserId: input.ownerId,
      ownerUserId: input.ownerId,
      agentId: input.agentId,
    };
  };
  const generateOwnedPhotos = async (input: {
    authority: RouteAuthority;
    operationId: string;
    origin: AgentPhotoSelectionOrigin;
    prompt: string;
    count: number;
  }) => {
    const policy = getImageModel();
    const openaiKey =
      providerKey("openai", { ownerId: input.authority.ownerUserId }) ?? "";
    const googleKey =
      providerKey("google", { ownerId: input.authority.ownerUserId }) ?? "";
    const openrouterKey =
      providerKey("openrouter", { ownerId: input.authority.ownerUserId }) ?? "";
    const veniceKey =
      providerKey("venice", { ownerId: input.authority.ownerUserId }) ?? "";
    if (!{ openai: openaiKey, google: googleKey, openrouter: openrouterKey, venice: veniceKey }[policy.provider]) {
      throw new AgentPhotoLibraryError({
        code: "invalid_photo_request",
        message: "The configured image provider is unavailable",
        retryable: false,
      });
    }
    const result = await createCoordinator.produceStageAndFinalize({
      authority: input.authority,
      operationId: input.operationId,
      origin: input.origin,
      source: "generation",
      slotCount: input.count,
      semantics: Array.from({ length: input.count }, (_, batchOrdinal) => ({
        avatarKind: "generated" as const,
        prompt: input.prompt,
        provider: policy.provider,
        model: policy.apiModel,
        batchOrdinal,
      })),
      produceCandidates: async () => {
        const generated = await generateAvatarImages(
          {
            model: policy.apiModel,
            prompt: avatarPrompt(input.prompt),
            count: input.count,
            size: "1024x1024",
            quality: "low",
            background: "opaque",
            format: "png",
          },
          { openaiKey, googleKey, openrouterKey, veniceKey },
          policy.provider,
        );
        if (
          generated.bytes.length !== input.count ||
          generated.bytes.some((bytes) => !bytes.length)
        ) {
          throw new Error(
            "The image provider returned an incomplete photo batch",
          );
        }
        return generated.bytes.map((bytes) => ({
          kind: "generated" as const,
          bytes,
        }));
      },
    });
    return { result, policy };
  };

  setManageAvatarPhotoLibraryPort({
    current: async (input) => {
      const current = await readService.current(await authorityForTool(input));
      return { selectionRevision: current.scope.selectionRevision };
    },
    generate: async (input) => {
      const { result, policy } = await generateOwnedPhotos({
        authority: await authorityForTool(input),
        operationId: input.operationId,
        origin: "manage_avatar",
        prompt: input.prompt,
        count: input.count,
      });
      return {
        selectionRevision: result.scope.selectionRevision,
        model: policy.apiModel,
        provider: policy.provider,
        candidates: result.entries.map((entry) => ({
          entryId: entry.id,
          thumbnailUrl: entry.media.thumbnailUrl,
          fullUrl: entry.media.fullUrl,
        })),
      };
    },
    select: async (input) => {
      await mutationService.select({
        authority: await authorityForTool(input),
        operationId: input.operationId,
        expectedSelectionRevision: input.expectedSelectionRevision,
        origin: "manage_avatar",
        target: input.target,
      });
    },
  });

  app.get("/api/profile/agent-photo-library/current", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to view your photo library", false));
    }
    try {
      const current = await readService.current(await authorityFor(request));
      return reply.send({ current, scope: current.scope });
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });

  app.get<{ Querystring: { projection?: string; limit?: string; cursor?: string } }>(
    "/api/profile/agent-photo-library",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to view your photo library", false));
      }
      const projection = parseProjection(request.query.projection);
      const limit = parseLimit(request.query.limit);
      if (!projection || !limit) {
        return reply.code(400).send(errorEnvelope("invalid_photo_request", "Use a page limit from 1 to 48 and a valid projection", false));
      }
      try {
        const authority = await authorityFor(request);
        let cursor: { createdAtMicros: string; id: string } | undefined;
        let expectedLibraryRevision: string | undefined;
        if (request.query.cursor !== undefined) {
          const decoded = codec().decode(request.query.cursor);
          if (!decoded.ok) {
            return reply.code(400).send(errorEnvelope("invalid_cursor", "The photo-library page cursor is invalid or expired", false));
          }
          const snapshot = decoded.value;
          if (
            snapshot.serverInstanceId !== authority.serverInstanceId ||
            snapshot.viewerUserId !== authority.viewerUserId ||
            snapshot.agentId !== authority.agentId ||
            snapshot.projection !== projection
          ) {
            return reply.code(400).send(errorEnvelope("invalid_cursor", "The photo-library page cursor is for another scope", false));
          }
          cursor = { createdAtMicros: snapshot.createdAtMicros, id: snapshot.id };
          expectedLibraryRevision = snapshot.libraryRevision;
        }
        const result = await readService.list(authority, {
          projection,
          limit,
          ...(cursor ? { cursor } : {}),
          ...(expectedLibraryRevision ? { expectedLibraryRevision } : {}),
        });
        const nextCursor = result.next
          ? codec().issue({
            serverInstanceId: result.scope.serverInstanceId,
            viewerUserId: result.scope.viewerUserId,
            agentId: result.scope.agentId,
            projection,
            libraryRevision: result.scope.libraryRevision,
            createdAtMicros: result.next.createdAtMicros,
            id: result.next.id,
          })
          : null;
        return reply.send({ entries: result.entries, nextCursor, scope: result.scope });
      } catch (error) {
        return sendLibraryError(reply, error);
      }
    },
  );

  app.get("/api/profile/agent-photo-library/presets", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to view your photo library", false));
    }
    try {
      const result = await readService.presets(await authorityFor(request));
      return reply.send({
        presets: AGENT_AVATAR_PRESET_IDS.map((id) => ({
          id,
          thumbnailUrl: `/api/onboarding/images/avatars/${id}.webp`,
        })),
        scope: result.scope,
      });
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });

  app.get<{ Params: { entryId: string } }>(
    "/api/profile/agent-photo-library/entries/:entryId",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to view your photo library", false));
      }
      try {
        return reply.send(await readService.entry(await authorityFor(request), request.params.entryId));
      } catch (error) {
        return sendLibraryError(reply, error);
      }
    },
  );

  app.get<{ Params: { entryId: string }; Querystring: { size?: string } }>(
    "/api/profile/agent-photo-library/entries/:entryId/media",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to view your photo library", false));
      }
      const size = request.query.size ?? "thumb";
      if (size !== "thumb" && size !== "full") {
        return reply.code(400).send(errorEnvelope("invalid_photo_request", "Media size must be thumb or full", false));
      }
      try {
        const result = await readService.media(
          await authorityFor(request),
          request.params.entryId,
          size,
          async (entry) => {
            if (entry.avatarKind !== "generated" && entry.avatarKind !== "uploaded") return null;
            const media = await readMedia({
              entryId: entry.id,
              kind: entry.avatarKind,
              blobId: entry.blobId,
              variant: size,
              mediaByteSize: entry.mediaByteSize,
              mediaSha256: entry.mediaSha256,
              mediaMimeType: entry.mediaMimeType,
            });
            return media.ok ? media : null;
          },
        );
        const media = result.media;
        setMediaCacheHeaders(reply, {
          visibility: "private",
          etag: media.etag,
          versioned: requestIsVersioned(request),
        });
        reply.type(media.contentType);
        return reply.send(media.bytes);
      } catch (error) {
        return sendLibraryError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>("/api/profile/agent-photo-library/select", async (request, reply) => {
    if (!request.sessionUserId) return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to change your Agent photo", false));
    const body = objectBody(request.body);
    const operationId = operationIdFrom(request);
    if (!body || !operationId || typeof body["expectedSelectionRevision"] !== "string") {
      return reply.code(400).send(errorEnvelope("invalid_photo_request", "An idempotency key, selection revision, and target are required", false));
    }
    const target = objectBody(body["target"]);
    if (!target || (target["kind"] !== "clear" && target["kind"] !== "preset" && target["kind"] !== "entry")) {
      return reply.code(400).send(errorEnvelope("invalid_photo_request", "The photo selection target is invalid", false));
    }
    try {
      const value = await mutationService.select({
        authority: await authorityFor(request),
        operationId,
        expectedSelectionRevision: body["expectedSelectionRevision"],
        origin: originFrom(request),
        target: target["kind"] === "clear"
          ? { kind: "clear" }
          : target["kind"] === "preset" && typeof target["presetId"] === "string"
            ? { kind: "preset", presetId: target["presetId"] }
            : target["kind"] === "entry" && typeof target["entryId"] === "string"
              ? { kind: "entry", entryId: target["entryId"] }
              : (() => { throw new AgentPhotoLibraryError({ code: "invalid_photo_request", message: "The photo selection target is invalid", retryable: false }); })(),
      });
      return reply.send(value);
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/profile/agent-photo-library/undo", async (request, reply) => {
    if (!request.sessionUserId) return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to change your Agent photo", false));
    const body = objectBody(request.body);
    const operationId = operationIdFrom(request);
    if (!body || !operationId || typeof body["expectedSelectionRevision"] !== "string" || typeof body["revisionId"] !== "string") {
      return reply.code(400).send(errorEnvelope("invalid_photo_request", "An idempotency key, selection revision, and revision id are required", false));
    }
    try {
      return reply.send(await mutationService.undo({ authority: await authorityFor(request), operationId, expectedSelectionRevision: body["expectedSelectionRevision"], revisionId: body["revisionId"], origin: originFrom(request) }));
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });

  for (const operation of ["delete", "restore"] as const) {
    app.post<{ Params: { entryId: string } }>(`/api/profile/agent-photo-library/entries/:entryId/${operation}`, async (request, reply) => {
      if (!request.sessionUserId) return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to change your Agent photo", false));
      const operationId = operationIdFrom(request);
      if (!operationId) return reply.code(400).send(errorEnvelope("invalid_photo_request", "An idempotency key is required", false));
      try {
        const input = { authority: await authorityFor(request), operationId, entryId: request.params.entryId, origin: originFrom(request) };
        return reply.send(operation === "delete" ? await mutationService.delete(input) : await mutationService.restore(input));
      } catch (error) {
        return sendLibraryError(reply, error);
      }
    });
  }

  app.post("/api/profile/agent-photo-library/upload", async (request, reply) => {
    if (!request.sessionUserId) return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to add an Agent photo", false));
    const operationId = operationIdFrom(request);
    if (!operationId) return reply.code(400).send(errorEnvelope("invalid_photo_request", "An idempotency key is required", false));
    try {
      const bytes = await normalizeUpload(request);
      if (!bytes) return reply.code(400).send(errorEnvelope("invalid_photo_request", "Upload one supported image within the photo limits", false));
      // The create reservation fingerprints the normalized payload before any
      // staging/publish work, so a retry cannot bind different bytes later.
      const media = {
        mimeType: "image/png" as const,
        byteSize: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const result = await createCoordinator.produceStageAndFinalize({
        authority: await authorityFor(request), operationId, origin: originFrom(request), source: "upload", slotCount: 1,
        semantics: [{ avatarKind: "uploaded", media }],
        produceCandidates: () => Promise.resolve([{ kind: "uploaded", bytes }]),
      });
      return reply.code(201).send(result);
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });

  app.post<{ Body: unknown }>("/api/profile/agent-photo-library/generate", async (request, reply) => {
    if (!request.sessionUserId) return reply.code(401).send(errorEnvelope("authentication_required", "Sign in to generate an Agent photo", false));
    const operationId = operationIdFrom(request);
    const body = objectBody(request.body);
    const prompt = typeof body?.["prompt"] === "string" ? body["prompt"].trim() : "";
    const count = body?.["count"] === undefined ? 1 : body["count"];
    if (
      !operationId
      || !prompt
      || prompt.length > 500
      || typeof count !== "number"
      || !Number.isInteger(count)
      || count < 1
      || count > 4
    ) {
      return reply.code(400).send(errorEnvelope(
        "invalid_photo_request",
        "An idempotency key, prompt of at most 500 characters, and count from 1 to 4 are required",
        false,
      ));
    }
    try {
      const { result } = await generateOwnedPhotos({
        authority: await authorityFor(request),
        operationId,
        origin: originFrom(request),
        prompt,
        count,
      });
      return reply.code(201).send(result);
    } catch (error) {
      return sendLibraryError(reply, error);
    }
  });
}
