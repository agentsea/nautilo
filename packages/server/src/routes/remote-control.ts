/**
 * D458 Wave 7.1 authenticated remote-controller ceremony surface.
 *
 * The browser receives only display-safe hosts/controllers and one-time
 * ceremony material. Relay credentials, Logto tokens, verifier digests, and
 * durable server identity are deliberately never projected from this module.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq, getSharedDirectDb, nautiloInstanceIdentity } from "@nautilo/db";
import { verifyLogtoActiveUserForAuthority } from "@nautilo/trust";
import { z } from "zod";
import { requireFreshLogtoAccessToken } from "../lib/logto-freshness";
import {
  derivePairingCeremonyContext,
  verifyRemoteControllerProof,
  type RemoteControllerProof,
} from "../remote-control/controller-proof";
import {
  digestPairingVerifier,
  mintPairingVerifierSecrets,
  pairingVerifierMatches,
  requirePairingPepper,
} from "../remote-control/pairing-secrets";
import {
  getRemotePairingStore,
  type RemotePairingStore,
} from "../remote-control/pairing-store";
import {
  projectRemoteHosts,
  type RemoteHostPresence,
  type ProjectedRemoteHost,
} from "../remote-control/host-projection";
import {
  admitOrdinaryOrigin,
  MOBILE_ORDINARY_ORIGIN_HEADER,
} from "../remote-control/ordinary-origin-admission";
import {
  HOST_FILE_DEFAULT_PAGE_SIZE,
  HOST_FILE_MAX_PAGE_SIZE,
  decodeHostFileCursor,
  encodeHostFileCursor,
  listHostFiles,
  normalizeHostFileRelativePath,
  readHostFilePreview,
  statHostFile,
  type HostFileErrorCode,
  type HostFileRootKind,
} from "../remote-control/host-file-surface";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const nonEmpty = z.string().trim().min(1);
const opaqueUuid = z.string().uuid();
const createRemotePairingChallengeRequestSchema = z.object({
  relayId: nonEmpty.max(256),
});
const consumeRemotePairingChallengeRequestSchema = z.object({
  challengeId: opaqueUuid,
  secret: nonEmpty.max(512),
  installationId: opaqueUuid,
  proof: z
    .object({
      // Keep the object strict, but let the cryptographic verifier see bad
      // encodings once an owner-scoped challenge id is known so those attempts
      // consume the same bounded retry budget as an invalid signature.
      algorithm: nonEmpty.max(128),
      ceremonyContext: nonEmpty.max(256),
      publicKey: nonEmpty.max(256),
      signature: nonEmpty.max(512),
    })
    .strict(),
  label: z.string().trim().min(1).max(200).optional(),
});
const prepareManualRemotePairingRequestSchema = z.object({
  manualCode: nonEmpty.max(64),
}).strict();
const renameRemoteControllerRequestSchema = z.object({
  label: z.string().trim().min(1).max(200),
});
const hostFileRootKindSchema = z.enum(["workspace", "current_folder", "paired_filesystem"]);
const hostFileRequestBaseSchema = z.object({
  remoteHostId: opaqueUuid,
  rootKind: hostFileRootKindSchema,
  relativePath: z.string().max(1024).default(""),
}).strict();
const listHostFilesRequestSchema = hostFileRequestBaseSchema.extend({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(HOST_FILE_MAX_PAGE_SIZE).optional(),
  includeHidden: z.boolean().default(false),
  query: z.string().trim().max(200).default(""),
}).strict();
const statHostFileRequestSchema = hostFileRequestBaseSchema;
const readHostFilePreviewRequestSchema = hostFileRequestBaseSchema;
const selectCurrentFolderRequestSchema = z.object({
  remoteHostId: opaqueUuid,
  sourceRootKind: hostFileRootKindSchema,
  relativePath: z.string().max(1024).default(""),
}).strict();

/** The narrow live snapshot needed by 7.1; 7.3 owns presence projection. */
export interface RemoteControlRelayRegistry {
  /** One bounded owner-filtered presence read; never call once per binding. */
  snapshotForUser(userId: string): readonly (RemoteHostPresence & {
    relayId: string;
    capabilityRevision?: number;
  })[];
  /** Server-private capability data; it is never projected to HTTP. */
  getCapabilities(relayId: string): Record<string, unknown> | null | undefined;
  /** Read-only, root-jailed Relay filesystem transport. */
  fsDispatch(
    relayId: string,
    request: {
      op: "readFile" | "readdir" | "stat" | "lstat";
      path: string;
      opts?: Record<string, unknown>;
      allowedRoots: string[];
    },
    options: { mutating: false; timeoutMs?: number },
  ): Promise<import("@nautilo/relay").RelayFsResult>;
  /** Exact-relay app-state mutation; Electron remains final authority. */
  dispatch?(relayId: string, request: {
    toolName: string;
    args: Record<string, unknown>;
    impact: "low";
    approvalObtained: true;
    executionClass: "desktop";
    timeout?: number;
  }): Promise<import("@nautilo/relay").RelayDispatchResult>;
}

export interface RemoteHostSnapshotCursor {
  streamId: string;
  sequence: number;
  snapshotRevision: number;
}

export interface RemoteControlRouteDeps {
  readonly registry: RemoteControlRelayRegistry;
  readonly store?: RemotePairingStore;
  readonly now?: () => Date;
  readonly getServerIdentity?: () => Promise<{
    serverInstanceId: string;
    serverBindingGeneration: number;
  } | null>;
  /**
   * 7.3 has no replay transport yet.  This explicit baseline cursor means
   * "snapshot only" rather than asserting any event has been observed; 7.4
   * replaces it with the realtime stream cursor without changing HTTP shape.
   */
  readonly getRemoteHostSnapshotCursor?: () => RemoteHostSnapshotCursor;
  /**
   * The presence-stream owner can provide the one canonical snapshot used by
   * both REST reconciliation and realtime sequencing. When absent, route
   * tests and the standalone baseline retain the direct projection fallback.
   */
  readonly getRemoteHostAuthoritativeSnapshot?: (userId: string) => Promise<{
    hosts: ProjectedRemoteHost[];
    cursor: RemoteHostSnapshotCursor;
  }>;
  /** Best-effort stream reconciliation after durable pairing authority changes. */
  readonly onRemoteHostMutation?: (userId: string) => void | Promise<void>;
  /**
   * Exact controller-binding revoke seam. The stream uses the binding id to
   * distinguish this deliberate revoke from unrelated coincident disconnects.
   */
  readonly onRemoteHostRevoked?: (input: {
    userId: string;
    remoteHostId: string;
  }) => void | Promise<void>;
  /** Test seam; production uses the fail-closed Logto management adapter. */
  readonly verifyActiveUser?: (sub: unknown) => Promise<"active" | "inactive" | "unavailable" | "invalid-subject">;
  /** Test seam around the shared one-use ordinary-origin verifier. */
  readonly admitOrigin?: typeof admitOrdinaryOrigin;
}

type RemoteRequest = FastifyRequest & {
  sessionUserId: string | null;
  sessionActorId: string | null;
  resolvedPrincipal: { logtoSub: string } | null;
};

function remoteDenied(reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: "remote_unavailable" });
}

async function requireRemoteIdentity(
  request: RemoteRequest,
  reply: FastifyReply,
  freshness: boolean,
  strictAuthority = false,
  verifyActiveUser: (sub: unknown) => Promise<"active" | "inactive" | "unavailable" | "invalid-subject"> = verifyLogtoActiveUserForAuthority,
): Promise<{ userId: string; actorId: string } | null> {
  if (!request.sessionUserId || !request.sessionActorId || !request.resolvedPrincipal) {
    await remoteDenied(reply);
    return null;
  }
  if (freshness && (await requireFreshLogtoAccessToken(request, reply))) return null;
  // A valid bearer and canonical local principal are necessary but insufficient
  // for a durable authority mutation: management-plane failure is denied.
  if (
    strictAuthority &&
    (await verifyActiveUser(request.resolvedPrincipal.logtoSub)) !== "active"
  ) {
    await remoteDenied(reply);
    return null;
  }
  return { userId: request.sessionUserId, actorId: request.sessionActorId };
}

async function defaultServerIdentity(): Promise<{
  serverInstanceId: string;
  serverBindingGeneration: number;
} | null> {
  const rows = await getSharedDirectDb()
    .select({
      serverInstanceId: nautiloInstanceIdentity.serverInstanceId,
      serverBindingGeneration: nautiloInstanceIdentity.serverBindingGeneration,
    })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  return rows[0] ?? null;
}

function parseBody<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  body: unknown,
): T | null {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

type PairingRelaySnapshot = RemoteHostPresence & {
  relayId: string;
  capabilityRevision?: number;
};

type HostFileResolution =
  | { readonly ok: true; readonly relayId: string; readonly root: string | null }
  | { readonly ok: false; readonly error: HostFileErrorCode };

/**
 * Explicit Computer browsing is deliberately bound to the submitted durable
 * controller binding. It does not use the agent's multi-host resolver or its
 * chooser cache, so browsing one Mac can never change ordinary-chat routing.
 */
async function resolveHostFileRoot(input: {
  readonly store: Pick<RemotePairingStore, "listActiveHostBindingsForController">;
  readonly registry: RemoteControlRelayRegistry;
  readonly userId: string;
  readonly actorId: string;
  readonly controllerInstallationId: string;
  readonly installationGeneration: number;
  readonly serverInstanceId: string;
  readonly serverBindingGeneration: number;
  readonly remoteHostId: string;
  readonly rootKind: HostFileRootKind;
}): Promise<HostFileResolution> {
  let bindings: Awaited<ReturnType<RemotePairingStore["listActiveHostBindingsForController"]>>;
  try {
    bindings = await input.store.listActiveHostBindingsForController({
      controllerInstallationId: input.controllerInstallationId,
      installationGeneration: input.installationGeneration,
      userId: input.userId,
      actorId: input.actorId,
      serverInstanceId: input.serverInstanceId,
      serverBindingGeneration: input.serverBindingGeneration,
    });
  } catch {
    return { ok: false, error: "transport" };
  }
  const binding = bindings.find((candidate) => candidate.bindingId === input.remoteHostId);
  // This proof is valid but no longer authorizes the requested durable binding.
  if (!binding) return { ok: false, error: "revoked" };
  const live = input.registry.snapshotForUser(input.userId).filter((candidate) =>
    candidate.pairingGeneration === binding.pairingGeneration &&
    candidate.userId === input.userId &&
    candidate.desktopSessionId !== null && candidate.desktopSessionId.trim() !== "",
  );
  // A missing or split live generation has no safe exact target.
  if (live.length !== 1) return { ok: false, error: "offline" };
  const relay = live[0]!;
  const capabilities = input.registry.getCapabilities(relay.relayId);
  if (
    !capabilities ||
    capabilities["profile"] !== "desktop-agent" ||
    (input.rootKind === "paired_filesystem"
      ? capabilities["canBrowsePairedFilesystem"] !== true
      : capabilities["canReadWorkspace"] !== true)
  ) return { ok: false, error: "unsupported" };
  // `paired_filesystem` is an Electron-owned opaque directory picker. Unlike
  // Workspace/Current Folder, the server never discovers or carries a root.
  if (input.rootKind === "paired_filesystem") return { ok: true, relayId: relay.relayId, root: null };
  const rootValue = input.rootKind === "workspace"
    ? capabilities["workspaceRoot"]
    : capabilities["currentFolderRoot"];
  if (input.rootKind === "current_folder" && (rootValue === null || rootValue === undefined || rootValue === "")) {
    return { ok: false, error: "no_current_folder" };
  }
  // Root capability values are private discovery data. Reject malformed/stale
  // values rather than ever echoing them or falling back to a hidden path.
  if (typeof rootValue !== "string" || !rootValue.startsWith("/") || rootValue.includes("\0")) {
    return { ok: false, error: "root_stale" };
  }
  return { ok: true, relayId: relay.relayId, root: rootValue };
}

async function listPairedFilesystemDirectories(input: {
  readonly registry: RemoteControlRelayRegistry;
  readonly relayId: string;
  readonly relativePath: string;
  readonly afterName: string | undefined;
  readonly limit: number;
  readonly includeHidden: boolean;
  readonly query: string;
}): Promise<
  | { readonly ok: true; readonly value: { readonly entries: Array<{ name: string; path: string; isDirectory: true; isFile: false; isSymbolicLink: false }>; readonly nextCursor: string | null } }
  | { readonly ok: false; readonly error: HostFileErrorCode }
> {
  if (!input.registry.dispatch) return { ok: false, error: "unsupported" };
  try {
    const result = await input.registry.dispatch(input.relayId, {
      toolName: "nautilo_paired_filesystem_directory",
      args: {
        rootKind: "paired_filesystem",
        operation: "list_directories",
        relativePath: input.relativePath,
        limit: input.limit,
        includeHidden: input.includeHidden,
        query: input.query,
        ...(input.afterName === undefined ? {} : { afterName: input.afterName }),
      },
      impact: "low",
      approvalObtained: true,
      executionClass: "desktop",
      timeout: 20_000,
    });
    if (result.status !== "ok") return { ok: false, error: "inaccessible" };
    const value = result.result as { entries?: unknown; nextCursor?: unknown } | undefined;
    if (!Array.isArray(value?.entries) || value.entries.length > input.limit || (value.nextCursor !== null && typeof value.nextCursor !== "string")) {
      return { ok: false, error: "transport" };
    }
    const entries: Array<{ name: string; path: string; isDirectory: true; isFile: false; isSymbolicLink: false }> = [];
    for (const item of value.entries) {
      if (!item || typeof item !== "object") return { ok: false, error: "transport" };
      const entry = item as Record<string, unknown>;
      const name = entry["name"];
      const entryPath = entry["path"];
      if (
        typeof name !== "string" || name.length === 0 || name.length > 255 || name.includes("\0") || name.includes("/") || name.includes("\\") || [...name].some((character) => character.codePointAt(0)! < 0x20) ||
        typeof entryPath !== "string" || normalizeHostFileRelativePath(entryPath) !== entryPath ||
        entry["isDirectory"] !== true || entry["isFile"] !== false || entry["isSymbolicLink"] !== false
      ) return { ok: false, error: "transport" };
      entries.push({ name, path: entryPath, isDirectory: true, isFile: false, isSymbolicLink: false });
    }
    const nextCursor = value.nextCursor === null ? null : encodeHostFileCursor(value.nextCursor);
    if (value.nextCursor !== null && nextCursor === null) return { ok: false, error: "transport" };
    return { ok: true, value: { entries, nextCursor } };
  } catch {
    return { ok: false, error: "transport" };
  }
}

function hostFileError(reply: FastifyReply, error: HostFileErrorCode): FastifyReply {
  const status = error === "revoked" ? 403 : error === "transport" ? 503 : 409;
  return reply.code(status).send({ error });
}

/**
 * Select one complete live tuple from one registry snapshot.  A generated
 * pairing id with multiple live owners is split identity, never a tie-break.
 */
function selectLivePairingRelay(
  snapshot: readonly PairingRelaySnapshot[],
  userId: string,
  relayId: string,
): PairingRelaySnapshot | null {
  const selected = snapshot.filter((entry) =>
    entry.relayId === relayId &&
    entry.userId === userId &&
    entry.desktopSessionId !== null && entry.desktopSessionId.trim() !== "" &&
    entry.pairingGeneration !== "" &&
    entry.capabilities !== null &&
    typeof entry.capabilities === "object" &&
    (entry.capabilities as { profile?: unknown }).profile === "desktop-agent",
  );
  if (selected.length !== 1) return null;
  const live = selected[0]!;
  const duplicates = snapshot.filter((entry) =>
    entry.pairingGeneration === live.pairingGeneration && entry.userId === userId,
  );
  return duplicates.length === 1 ? live : null;
}

/**
 * Registered inside createApp after the one process-local relay registry is
 * constructed. No route ever accepts a relay token, actor/user id, server id,
 * desktop session id, or pairing generation from the wire.
 */
export function remoteControlRoutes(app: FastifyInstance, deps: RemoteControlRouteDeps): void {
  const store = deps.store ?? getRemotePairingStore();
  const now = deps.now ?? (() => new Date());
  const getServerIdentity = deps.getServerIdentity ?? defaultServerIdentity;
  const verifyActiveUser = deps.verifyActiveUser ?? verifyLogtoActiveUserForAuthority;
  const admitOrigin = deps.admitOrigin ?? admitOrdinaryOrigin;
  const getRemoteHostSnapshotCursor = deps.getRemoteHostSnapshotCursor ?? (() => ({
    streamId: "remote-hosts-snapshot-only",
    sequence: 0,
    snapshotRevision: 0,
  }));
  const reconcileRemoteHostMutation = (userId: string): void => {
    if (!deps.onRemoteHostMutation) return;
    void Promise.resolve()
      .then(() => deps.onRemoteHostMutation?.(userId))
      .catch(() => {
        // Pairing already committed. Do not expose a stream failure to the
        // caller or undo durable authority; the next snapshot reconnects.
        app.log.warn("remote host mutation reconciliation failed");
      });
  };
  const reconcileRemoteHostRevocation = (input: {
    userId: string;
    remoteHostId: string;
  }): void => {
    if (!deps.onRemoteHostRevoked) {
      reconcileRemoteHostMutation(input.userId);
      return;
    }
    void Promise.resolve()
      .then(() => deps.onRemoteHostRevoked?.(input))
      .catch(() => {
        // The exact binding revoke already committed. Preserve the response and
        // let the next authoritative snapshot converge if publication fails.
        app.log.warn("remote host revoke reconciliation failed");
      });
  };

  app.get("/api/remote/hosts", async (request, reply) => {
    const identity = await requireRemoteIdentity(request as RemoteRequest, reply, false);
    if (!identity) return;
    const admitted = await admitOrigin({
      mobileHeader: request.headers[MOBILE_ORDINARY_ORIGIN_HEADER],
      electronHeader: undefined,
      sessionUserId: identity.userId,
      sessionActorId: identity.actorId,
      method: "GET",
      path: "/api/remote/hosts",
      body: null,
    });
    if (admitted.status !== "verified" || admitted.origin.kind !== "paired_mobile") {
      return remoteDenied(reply);
    }
    let scoped: Awaited<ReturnType<RemotePairingStore["listPairedHostRowsForController"]>>;
    try {
      scoped = await store.listPairedHostRowsForController({
        userId: admitted.origin.userId,
        actorId: admitted.origin.actorId,
        controllerInstallationId: admitted.origin.controllerInstallationId,
        installationGeneration: admitted.origin.installationGeneration,
        serverInstanceId: admitted.origin.serverInstanceId,
        serverBindingGeneration: admitted.origin.serverBindingGeneration,
      });
    } catch {
      return remoteDenied(reply);
    }
    const allowedIds = new Set(scoped.rows.map((row) => row.remoteHostId));
    try {
      const snapshot = deps.getRemoteHostAuthoritativeSnapshot
        ? await deps.getRemoteHostAuthoritativeSnapshot(identity.userId)
        : {
            hosts: projectRemoteHosts({
              userId: identity.userId,
              rows: scoped.rows,
              presence: deps.registry.snapshotForUser(identity.userId),
              nowMs: now().getTime(),
            }),
            cursor: getRemoteHostSnapshotCursor(),
          };
      return reply.send({
        controllerLabel: scoped.controllerLabel,
        hosts: snapshot.hosts.filter((host) => allowedIds.has(host.remoteHostId)),
        cursor: snapshot.cursor,
      });
    } catch {
      return remoteDenied(reply);
    }
  });

  /** A signed mobile POST binds host/root/path/pagination to one-use proof. */
  const admitHostFileRequest = async (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
  ) => {
    const identity = await requireRemoteIdentity(request as RemoteRequest, reply, false);
    if (!identity) return null;
    const admitted = await admitOrigin({
      mobileHeader: request.headers[MOBILE_ORDINARY_ORIGIN_HEADER],
      electronHeader: undefined,
      sessionUserId: identity.userId,
      sessionActorId: identity.actorId,
      method: "POST",
      path,
      body: request.body,
    });
    if (admitted.status !== "verified" || admitted.origin.kind !== "paired_mobile") {
      remoteDenied(reply);
      return null;
    }
    return admitted.origin;
  };

  app.post("/api/remote/host-files/list", async (request, reply) => {
    const origin = await admitHostFileRequest(request, reply, "/api/remote/host-files/list");
    if (!origin) return;
    const body = parseBody(listHostFilesRequestSchema, request.body);
    if (!body) return reply.code(400).send({ error: "invalid_request" });
    const relativePath = normalizeHostFileRelativePath(body.relativePath);
    const afterName = decodeHostFileCursor(body.cursor);
    if (relativePath === null || afterName === null) return reply.code(400).send({ error: "invalid_request" });
    const resolved = await resolveHostFileRoot({
      store,
      registry: deps.registry,
      ...origin,
      remoteHostId: body.remoteHostId,
      rootKind: body.rootKind,
    });
    if (!resolved.ok) return hostFileError(reply, resolved.error);
    if (body.rootKind === "paired_filesystem") {
      const result = await listPairedFilesystemDirectories({
        registry: deps.registry,
        relayId: resolved.relayId,
        relativePath,
        afterName,
        limit: body.limit ?? HOST_FILE_DEFAULT_PAGE_SIZE,
        includeHidden: body.includeHidden ?? false,
        query: body.query ?? "",
      });
      if (!result.ok) return hostFileError(reply, result.error);
      return reply.send(result.value);
    }
    if (resolved.root === null) return hostFileError(reply, "unsupported");
    const result = await listHostFiles({
      dispatch: deps.registry,
      relayId: resolved.relayId,
      root: resolved.root,
      relativePath,
      afterName,
      limit: body.limit ?? HOST_FILE_DEFAULT_PAGE_SIZE,
      includeHidden: body.includeHidden ?? false,
      query: body.query ?? "",
    });
    if (!result.ok) return hostFileError(reply, result.error);
    return reply.send(result.value);
  });

  app.post("/api/remote/host-files/stat", async (request, reply) => {
    const origin = await admitHostFileRequest(request, reply, "/api/remote/host-files/stat");
    if (!origin) return;
    const body = parseBody(statHostFileRequestSchema, request.body);
    if (!body) return reply.code(400).send({ error: "invalid_request" });
    const relativePath = normalizeHostFileRelativePath(body.relativePath);
    if (relativePath === null) return reply.code(400).send({ error: "invalid_request" });
    const resolved = await resolveHostFileRoot({
      store,
      registry: deps.registry,
      ...origin,
      remoteHostId: body.remoteHostId,
      rootKind: body.rootKind,
    });
    if (!resolved.ok) return hostFileError(reply, resolved.error);
    if (body.rootKind === "paired_filesystem" || resolved.root === null) return hostFileError(reply, "unsupported");
    const result = await statHostFile({
      dispatch: deps.registry,
      relayId: resolved.relayId,
      root: resolved.root,
      relativePath,
    });
    if (!result.ok) return hostFileError(reply, result.error);
    return reply.send({ entry: result.value });
  });

  app.post("/api/remote/host-files/read", async (request, reply) => {
    const origin = await admitHostFileRequest(request, reply, "/api/remote/host-files/read");
    if (!origin) return;
    const body = parseBody(readHostFilePreviewRequestSchema, request.body);
    if (!body) return reply.code(400).send({ error: "invalid_request" });
    const relativePath = normalizeHostFileRelativePath(body.relativePath);
    if (relativePath === null || relativePath === "") return reply.code(400).send({ error: "invalid_request" });
    const resolved = await resolveHostFileRoot({
      store,
      registry: deps.registry,
      ...origin,
      remoteHostId: body.remoteHostId,
      rootKind: body.rootKind,
    });
    if (!resolved.ok) return hostFileError(reply, resolved.error);
    if (body.rootKind === "paired_filesystem" || resolved.root === null) return hostFileError(reply, "unsupported");
    const result = await readHostFilePreview({
      dispatch: deps.registry,
      relayId: resolved.relayId,
      root: resolved.root,
      relativePath,
    });
    if (!result.ok) return hostFileError(reply, result.error);
    return reply.send({ entry: result.value.metadata, dataBase64: result.value.dataBase64 });
  });

  app.post("/api/remote/current-folder/select", async (request, reply) => {
    const origin = await admitHostFileRequest(request, reply, "/api/remote/current-folder/select");
    if (!origin) return;
    const body = parseBody(selectCurrentFolderRequestSchema, request.body);
    if (!body) return reply.code(400).send({ error: "invalid_request" });
    const relativePath = normalizeHostFileRelativePath(body.relativePath);
    if (relativePath === null) return reply.code(400).send({ error: "invalid_request" });
    const resolved = await resolveHostFileRoot({
      store,
      registry: deps.registry,
      ...origin,
      remoteHostId: body.remoteHostId,
      rootKind: body.sourceRootKind,
    });
    if (!resolved.ok) return hostFileError(reply, resolved.error);
    if (body.sourceRootKind === "paired_filesystem" && resolved.root !== null) {
      return hostFileError(reply, "transport");
    }
    if (!deps.registry.dispatch) return hostFileError(reply, "unsupported");
    try {
      const result = await deps.registry.dispatch(resolved.relayId, {
        toolName: "nautilo_current_folder_select",
        args: { sourceRootKind: body.sourceRootKind, relativePath },
        impact: "low",
        approvalObtained: true,
        executionClass: "desktop",
        timeout: 20_000,
      });
      if (result.status !== "ok") return hostFileError(reply, "inaccessible");
      const value = result.result as { ok?: unknown; label?: unknown } | undefined;
      if (value?.ok !== true || typeof value.label !== "string" || value.label.length === 0) {
        return hostFileError(reply, "transport");
      }
      return reply.send({ ok: true, label: value.label });
    } catch {
      return hostFileError(reply, "transport");
    }
  });

  app.get("/api/remote/controllers", async (request, reply) => {
    const identity = await requireRemoteIdentity(request as RemoteRequest, reply, false);
    if (!identity) return;
    const controllers = await store.listControllerBindingsForUser(identity.userId);
    return reply.send({
      controllers: controllers.map((controller) => ({
        bindingId: controller.bindingId,
        remoteHostId: controller.bindingId,
        installationId: controller.installationId,
        label: controller.label,
        createdAt: controller.createdAt.toISOString(),
        lastSeenAt: controller.lastSeenAt ? controller.lastSeenAt.toISOString() : null,
      })),
    });
  });

  app.post("/api/remote/challenges", async (request, reply) => {
    const identity = await requireRemoteIdentity(request as RemoteRequest, reply, true, true, verifyActiveUser);
    if (!identity) return;
    const denyChallenge = (reason: string) => {
      app.log.warn(
        { reason },
        "remote pairing challenge denied",
      );
      return remoteDenied(reply);
    };
    const body = parseBody(createRemotePairingChallengeRequestSchema, request.body);
    if (!body) return denyChallenge("invalid_request");
    // Read one immutable snapshot rather than three independent getters. A
    // relay re-register between those getters used to create a torn tuple.
    const live = selectLivePairingRelay(
      deps.registry.snapshotForUser(identity.userId),
      identity.userId,
      body.relayId,
    );
    if (!live) return denyChallenge("live_relay_tuple_unavailable");
    const desktopSessionId = live.desktopSessionId;
    if (!desktopSessionId || desktopSessionId.trim() === "") {
      return denyChallenge("desktop_session_unavailable");
    }
    let host: Awaited<ReturnType<RemotePairingStore["findActiveRelayForUser"]>>;
    try {
      host = await store.findActiveRelayForUser({
        relayTokenId: live.pairingGeneration,
        userId: identity.userId,
        actorId: identity.actorId,
      });
    } catch {
      return denyChallenge("active_relay_lookup_failed");
    }
    const serverIdentity = await getServerIdentity();
    if (!host || !serverIdentity || host.relayTokenId !== live.pairingGeneration) {
      return denyChallenge(
        !host
          ? "active_relay_unavailable"
          : !serverIdentity
            ? "server_identity_unavailable"
            : "relay_generation_mismatch",
      );
    }
    let pepper: string;
    try {
      pepper = requirePairingPepper();
    } catch {
      return denyChallenge("pairing_pepper_unavailable");
    }
    const secrets = mintPairingVerifierSecrets();
    const qrVerifierDigest = digestPairingVerifier(pepper, "qr", secrets.qrSecret);
    const manualVerifierDigest = digestPairingVerifier(pepper, "manual", secrets.manualCode);
    if (!qrVerifierDigest || !manualVerifierDigest) {
      return denyChallenge("pairing_verifier_digest_unavailable");
    }
    const createdAt = now();
    let challenge: { id: string; version: number };
    try {
      // Re-read once immediately before durable issuance.  The tuple must be
      // unchanged (including capability revision when supplied) so a socket
      // close/re-register cannot mint a challenge for a dead desktop session.
      const current = selectLivePairingRelay(
        deps.registry.snapshotForUser(identity.userId),
        identity.userId,
        body.relayId,
      );
      if (
        !current ||
        current.desktopSessionId !== desktopSessionId ||
        current.pairingGeneration !== live.pairingGeneration ||
        current.capabilityRevision !== live.capabilityRevision
      ) return denyChallenge("live_relay_tuple_changed");
      challenge = await store.createChallenge({
        serverInstanceId: serverIdentity.serverInstanceId,
        serverBindingGeneration: serverIdentity.serverBindingGeneration,
        userId: identity.userId,
        actorId: identity.actorId,
        relayTokenId: host.relayTokenId,
        hostInstallationId: host.hostInstallationId,
        desktopSessionId,
        pairingGeneration: live.pairingGeneration,
        qrVerifierDigest,
        manualVerifierDigest,
        expiresAt: new Date(createdAt.getTime() + CHALLENGE_TTL_MS),
      });
    } catch {
      return denyChallenge("challenge_persistence_failed");
    }
    const ceremonyContext = derivePairingCeremonyContext(pepper, {
      id: challenge.id,
      version: challenge.version,
      serverInstanceId: serverIdentity.serverInstanceId,
      serverBindingGeneration: serverIdentity.serverBindingGeneration,
      userId: identity.userId,
      actorId: identity.actorId,
      relayTokenId: host.relayTokenId,
      hostInstallationId: host.hostInstallationId,
      desktopSessionId,
      pairingGeneration: live.pairingGeneration,
    });
    const deepLink = `nautilo://remote/pair?challengeId=${encodeURIComponent(challenge.id)}&secret=${encodeURIComponent(secrets.qrSecret)}&ceremonyContext=${encodeURIComponent(ceremonyContext)}`;
    return reply.send({
      deepLink,
      challengeId: challenge.id,
      ceremonyContext,
      qrSecret: secrets.qrSecret,
      manualCode: secrets.manualCode,
      expiresAt: new Date(createdAt.getTime() + CHALLENGE_TTL_MS).toISOString(),
    });
  });

  /**
   * Manual pairing cannot sign until the phone knows the opaque challenge id
   * and ceremony context. This resolves only those non-secret inputs after
   * the same fresh, strict owner checks as consume; it never projects a code,
   * verifier digest, relay token, or a different user's challenge.
   */
  app.post("/api/remote/challenges/manual/prepare", async (request, reply) => {
    const identity = await requireRemoteIdentity(
      request as RemoteRequest,
      reply,
      true,
      true,
      verifyActiveUser,
    );
    if (!identity) return;
    const body = parseBody(prepareManualRemotePairingRequestSchema, request.body);
    if (!body) return remoteDenied(reply);
    const serverIdentity = await getServerIdentity();
    if (!serverIdentity) return remoteDenied(reply);
    let pepper: string;
    try {
      pepper = requirePairingPepper();
    } catch {
      return remoteDenied(reply);
    }
    const manualVerifierDigest = digestPairingVerifier(pepper, "manual", body.manualCode);
    if (!manualVerifierDigest) return remoteDenied(reply);
    let challenge: Awaited<ReturnType<RemotePairingStore["findChallengeForManualVerifier"]>>;
    try {
      challenge = await store.findChallengeForManualVerifier({
        manualVerifierDigest,
        userId: identity.userId,
        actorId: identity.actorId,
        serverInstanceId: serverIdentity.serverInstanceId,
        serverBindingGeneration: serverIdentity.serverBindingGeneration,
      });
    } catch {
      return remoteDenied(reply);
    }
    const current = now();
    if (
      !challenge ||
      !pairingVerifierMatches(challenge.manualVerifierDigest ?? "", manualVerifierDigest) ||
      challenge.consumedAt !== null ||
      challenge.revokedAt !== null ||
      challenge.failedAttempts >= 5 ||
      challenge.expiresAt.getTime() <= current.getTime()
    ) {
      return remoteDenied(reply);
    }
    return reply.send({
      challengeId: challenge.id,
      ceremonyContext: derivePairingCeremonyContext(pepper, challenge),
      expiresAt: challenge.expiresAt.toISOString(),
    });
  });

  app.post("/api/remote/challenges/consume", async (request, reply) => {
    const identity = await requireRemoteIdentity(request as RemoteRequest, reply, true, true, verifyActiveUser);
    if (!identity) return;
    const body = parseBody(consumeRemotePairingChallengeRequestSchema, request.body);
    if (!body) return remoteDenied(reply);
    let challenge: Awaited<ReturnType<RemotePairingStore["findChallengeForVerification"]>>;
    try {
      challenge = await store.findChallengeForVerification(body.challengeId);
    } catch {
      return remoteDenied(reply);
    }
    // Bind a verifier failure to the canonical owner/server *before* mutating
    // its retry budget.  Someone who knows or guesses a challenge UUID must
    // not be able to burn another user's one-time ceremony attempts.
    const serverIdentity = await getServerIdentity();
    const belongsToIdentity = challenge !== null && serverIdentity !== null &&
      challenge.userId === identity.userId &&
      challenge.actorId === identity.actorId &&
      challenge.serverInstanceId === serverIdentity.serverInstanceId &&
      challenge.serverBindingGeneration === serverIdentity.serverBindingGeneration;
    let pepper: string;
    try {
      pepper = requirePairingPepper();
    } catch {
      return remoteDenied(reply);
    }
    const qrCandidateDigest = digestPairingVerifier(pepper, "qr", body.secret);
    const manualCandidateDigest = digestPairingVerifier(pepper, "manual", body.secret);
    const verifierValid = challenge !== null &&
      (pairingVerifierMatches(challenge.qrVerifierDigest, qrCandidateDigest) ||
        pairingVerifierMatches(challenge.manualVerifierDigest ?? "", manualCandidateDigest));
    const eligibilityNow = now();
    const challengeEligible = challenge !== null && serverIdentity !== null &&
      challenge.consumedAt === null &&
      challenge.revokedAt === null &&
      challenge.failedAttempts < 5 &&
      challenge.expiresAt.getTime() > eligibilityNow.getTime() &&
      challenge.userId === identity.userId &&
      challenge.actorId === identity.actorId &&
      challenge.serverInstanceId === serverIdentity.serverInstanceId &&
      challenge.serverBindingGeneration === serverIdentity.serverBindingGeneration;
    // The proof must verify before the atomic consume/install/bind transaction.
    // Its failure follows the same owner-scoped generic retry path as a bad QR
    // or manual verifier, so it cannot become an identity oracle.
    const verifiedProof = verifierValid && challengeEligible && challenge
      ? verifyRemoteControllerProof({
          pepper,
          challenge,
          installationId: body.installationId,
          proof: body.proof as RemoteControllerProof,
        })
      : null;
    if (!belongsToIdentity || !verifierValid || !challengeEligible || !verifiedProof) {
      if (belongsToIdentity && challenge && serverIdentity) {
        try {
          await store.recordFailedVerifierAttempt({
            challengeId: challenge.id,
            expectedVersion: challenge.version,
            userId: identity.userId,
            actorId: identity.actorId,
            serverInstanceId: serverIdentity.serverInstanceId,
            serverBindingGeneration: serverIdentity.serverBindingGeneration,
            attemptedAt: now(),
          });
        } catch {
          // Preserve the ceremony's single non-enumerating failure response.
        }
      }
      return remoteDenied(reply);
    }
    // The guard above already establishes these; spell them out for both the
    // type checker and future edits to this deliberately security-sensitive
    // control flow.
    if (!challenge || !serverIdentity || !verifiedProof) return remoteDenied(reply);
    const consumedAt = now();
    let outcome: Awaited<ReturnType<RemotePairingStore["consumeChallengeEnsureInstallationAndCreateBinding"]>>;
    try {
      outcome = await store.consumeChallengeEnsureInstallationAndCreateBinding({
        challengeId: challenge.id,
        expectedVersion: challenge.version,
        consumedAt,
        serverInstanceId: serverIdentity.serverInstanceId,
        serverBindingGeneration: serverIdentity.serverBindingGeneration,
        userId: identity.userId,
        actorId: identity.actorId,
        relayTokenId: challenge.relayTokenId,
        hostInstallationId: challenge.hostInstallationId,
        desktopSessionId: challenge.desktopSessionId,
        pairingGeneration: challenge.pairingGeneration,
        controller: {
          userId: identity.userId,
          actorId: identity.actorId,
          serverInstanceId: serverIdentity.serverInstanceId,
          serverBindingGeneration: serverIdentity.serverBindingGeneration,
          installationId: body.installationId,
          proofKeyAlgorithm: body.proof.algorithm,
          proofKey: body.proof.publicKey,
          proofKeyFingerprint: verifiedProof.fingerprint,
          ...(body.label ? { label: body.label } : {}),
        },
      });
    } catch {
      return remoteDenied(reply);
    }
    if (
      outcome.outcome !== "committed" ||
      !outcome.controllerInstallationId ||
      !outcome.bindingId ||
      !outcome.installationGeneration
    ) return remoteDenied(reply);
    reconcileRemoteHostMutation(identity.userId);
    // The binding now contains only a server-verified public key fingerprint;
    // the mobile seed never crossed the wire or entered durable state.
    return reply.send({
      ok: true,
      installationId: body.installationId,
      controllerInstallationId: outcome.controllerInstallationId,
      bindingId: outcome.bindingId,
      installationGeneration: outcome.installationGeneration,
      serverInstanceId: serverIdentity.serverInstanceId,
      serverBindingGeneration: serverIdentity.serverBindingGeneration,
    });
  });

  app.patch<{ Params: { bindingId: string } }>(
    "/api/remote/controllers/:bindingId",
    async (request, reply) => {
      const identity = await requireRemoteIdentity(request as RemoteRequest, reply, true, true, verifyActiveUser);
      if (!identity) return;
      if (!opaqueUuid.safeParse(request.params.bindingId).success) return remoteDenied(reply);
      const body = parseBody(renameRemoteControllerRequestSchema, request.body);
      if (!body) return remoteDenied(reply);
      let renamed: boolean;
      try {
        renamed = await store.renameControllerInstallationForUser({
          bindingId: request.params.bindingId,
          userId: identity.userId,
          label: body.label,
        });
      } catch {
        return remoteDenied(reply);
      }
      if (!renamed) return remoteDenied(reply);
      return reply.send({ ok: true });
    },
  );

  app.delete<{ Params: { bindingId: string } }>(
    "/api/remote/controllers/:bindingId",
    async (request, reply) => {
      const identity = await requireRemoteIdentity(request as RemoteRequest, reply, true, true, verifyActiveUser);
      if (!identity) return;
      if (!opaqueUuid.safeParse(request.params.bindingId).success) return remoteDenied(reply);
      let revoked: boolean;
      try {
        revoked = await store.revokeBindingForUser({
          bindingId: request.params.bindingId,
          userId: identity.userId,
          revokedAt: now(),
        });
      } catch {
        return remoteDenied(reply);
      }
      if (!revoked) return remoteDenied(reply);
      reconcileRemoteHostRevocation({
        userId: identity.userId,
        remoteHostId: request.params.bindingId,
      });
      return reply.send({ ok: true });
    },
  );
}
