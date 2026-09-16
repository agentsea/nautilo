/**
 * D362 Phase 2/3 — quarantined WOPI module for Collabora (coolwsd).
 *
 * Phase 2 (read-only) shipped CheckFileInfo + GetFile + the
 * `/api/office/wopi-token` mint route. Phase 3 (this revision) adds the
 * write path: PutFile, the WOPI lock family (LOCK / UNLOCK / REFRESH_LOCK
 * / GET_LOCK / UnlockAndRelock), and an autosave debounce so a burst of
 * `X-WOPI-IsAutosave:true` saves doesn't fan out one revision bump +
 * SSE change event per call.
 *
 * The token-mint route `/api/office/wopi-token` is user-authenticated via
 * the normal trust preHandler; the `/wopi/*` routes bypass user-session
 * auth (see app.ts preHandler `request.url.startsWith("/wopi/")`
 * short-circuit) and are gated by a per-artifact opaque `access_token`
 * query param issued here. The token now carries BOTH the readable AND
 * writable namespace grants captured at mint time, so the write routes
 * can re-derive writability server-side without re-touching the trust
 * envelope (which the /wopi/ routes don't have — they're un-authed).
 *
 * Reuses the artifact store/db helpers from `@nautilo/db` (same
 * `findArtifactByInternalIdForNamespaces` query workspace-artifacts.ts
 * uses) and the trust envelope's `envelopeReadableNamespaces` /
 * `envelopeWritableNamespaces` so the mint route applies the SAME
 * namespace visibility / writability rule as the rest of the
 * workspace-artifacts API.
 *
 * Binary-write strategy (task 3.1.5): office docs are OOXML / ODF
 * BINARY — `userSaveWorkspaceArtifact` from `@nautilo/agent` takes a
 * UTF-8 `newText` string, which is wrong for PutFile. Instead we mirror
 * the agent's own `applyWorkspaceArtifactRowChange` pattern
 * (packages/agent/src/tools/file/artifact-store.ts): write the raw bytes
 * to the existing on-disk file at `absPathFromStorageUri(row.storageUri)`
 * via `fs/promises.writeFile`, then call `bumpArtifactRevision({
 * id: row.id, size, mimeType? })` — the same row-bump helper the agent
 * uses after `apply_patch` writes bytes to disk. No shim needed; this IS
 * the binary-update path the agent already uses.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  bumpArtifactRevision,
  findArtifactByInternalIdForNamespaces,
  type Artifact,
} from "@nautilo/db";
import {
  ArtifactWriteDeniedError,
  assertCanWriteArtifacts,
  envelopeReadableNamespaces,
  envelopeWritableNamespaces,
  envelopeMutableNamespaces,
} from "@nautilo/trust";
import { warn } from "@nautilo/logger";
import { eventBus } from "@nautilo/runtime";
import { resolveInstance, collaboraHostPort } from "@nautilo/config";
import { resolvePublicServerUrl } from "../lib/public-urls";
import { OFFICE_PROXY_PREFIX } from "./office-proxy";
import { requireArtifactWrite } from "../lib/artifact-write-admission";

/** 8 hours — long enough for an editing session, short enough to bound exposure. */
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** 30 minutes — WOPI spec recommends lock TTLs in this ballpark. */
const LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Autosave debounce window. A burst of `X-WOPI-IsAutosave:true` PutFile
 * calls within this window coalesces to a single revision bump + change
 * event; bytes are still persisted every call. A user-initiated save
 * (`X-WOPI-IsModifiedByUser:true` OR a non-autosave PutFile) flushes
 * immediately and resets the window.
 */
const AUTOSAVE_DEBOUNCE_MS = 10 * 1000;

/** PutFile body size cap. Office docs are typically <10MB; 100MB is headroom. */
const PUTFILE_BODY_LIMIT = 100 * 1024 * 1024;

type WopiTokenRecord = {
  artifactId: string;
  readableNamespaces: string[];
  writableNamespaces: string[];
  /**
   * The mutation gate (== readableNamespaces under the current trust
   * model). The CheckFileInfo `UserCanWrite` flag and the PutFile 403
   * gate consume THIS set, not `writableNamespaces`. Captured at mint
   * time from `envelopeMutableNamespaces(env)` so the un-authed
   * `/wopi/*` routes can re-derive writability server-side.
   */
  mutableNamespaces: string[];
  ownerId: string;
  userId: string;
  userFriendlyName: string;
  provenance: WopiAdmissionProvenance;
  expiresAt: number;
};

export type WopiAdmissionProvenance =
  | Readonly<{ kind: "plaintext_human" }>
  | Readonly<{ kind: "server_agent" }>
  | Readonly<{
      kind: "human_device";
      userId: string;
      humanActorId: string;
      deviceId: string;
      deviceGeneration: number;
      serverInstanceId: string;
      lineageGeneration: number;
      epoch: number;
      securityRevision: number;
      headDigest: Uint8Array;
    }>;

// Phase 2: in-memory, per-process token store. Sufficient for a single
// server process. Phase 5 should move this to a shared store (Redis or
// db-backed) so multi-replica deployments mint/validate consistently.
// M201 R4: SINGLE-REPLICA ONLY — see `warnOfficeSingleReplica`.
const tokenStore = new Map<string, WopiTokenRecord>();

/**
 * Phase 3 — in-memory WOPI lock store, keyed by artifact internal id.
 * Each entry carries the opaque lock string + an expiry timestamp.
 * Phase 5: multi-replica deployments need a shared store (Redis or a
 * `wopi_locks` db table) so two server replicas agree on who holds the
 * lock — an in-process Map is NOT consistent across replicas.
 * M201 R4: SINGLE-REPLICA ONLY — see `warnOfficeSingleReplica`.
 */
const lockStore = new Map<string, { lock: string; expiresAt: number }>();

/**
 * Phase 3 — autosave debounce state, keyed by artifact internal id.
 * `lastBumpAt` is the timestamp of the most recent revision bump for this
 * artifact. An autosave whose `Date.now() - lastBumpAt < DEBOUNCE` skips
 * the bump + change event (bytes are still persisted). A user-initiated
 * save always bumps and resets `lastBumpAt`. Phase 5: like the lock
 * store, multi-replica deployments need shared state.
 * M201 R4: SINGLE-REPLICA ONLY — see `warnOfficeSingleReplica`.
 */
const autosaveThrottle = new Map<string, { lastBumpAt: number }>();

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type IssuedWopiToken = {
  token: string;
  expiresAt: number;
};

export type WopiNamespaceGrant = {
  readableNamespaces: string[];
  /**
   * Phase 3 — namespaces the token holder may WRITE. Optional only for
   * backward-compat with Phase 2 callers/tests that mint a pure-read
   * token; the mint route always populates it from
   * `envelopeWritableNamespaces(env)`. When omitted/empty, CheckFileInfo
   * reports `UserCanWrite:false` and PutFile rejects with 403.
   *
   * NOTE: this is the narrow "attachment target" set
   * (`Namespace(currentRoom)`), NOT the mutation gate. The WOPI write
   * gate consumes `mutableNamespaces` below.
   */
  writableNamespaces?: string[];
  /**
   * The mutation gate (== readableNamespaces under the current trust
   * model). The CheckFileInfo `UserCanWrite` flag and the PutFile 403
   * gate consume THIS set. Optional only for backward-compat with
   * Phase 2 callers/tests that mint a pure-read token; the mint route
   * always populates it from `envelopeMutableNamespaces(env)`. When
   * omitted/empty, CheckFileInfo reports `UserCanWrite:false` and
   * PutFile rejects with 403.
   */
  mutableNamespaces?: string[];
  ownerId: string;
  userId: string;
  userFriendlyName: string;
  provenance?: WopiAdmissionProvenance;
};

/**
 * Mint a WOPI access token bound to a single artifact id + the readable
 * AND writable namespace grants the minting envelope had at issue time.
 * The token is opaque (random 256-bit url-safe string); the artifactId
 * binding is checked at validate time so a token minted for artifact A
 * cannot be replayed against artifact B. The writable grant is checked
 * at PutFile / CheckFileInfo time so a read-only envelope cannot
 * escalate to write even if it laterally obtains another artifact's
 * token.
 */
export function issueWopiToken(
  artifactId: string,
  grant: WopiNamespaceGrant,
): IssuedWopiToken {
  const token = randomToken();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  tokenStore.set(token, {
    artifactId,
    readableNamespaces: grant.readableNamespaces,
    writableNamespaces: grant.writableNamespaces ?? [],
    mutableNamespaces: grant.mutableNamespaces ?? [],
    ownerId: grant.ownerId,
    userId: grant.userId,
    userFriendlyName: grant.userFriendlyName,
    provenance: grant.provenance ?? Object.freeze({ kind: "plaintext_human" }),
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Validate a presented `access_token` against a specific artifact id.
 * Returns the token record on success, null on any failure (missing,
 * unknown, expired, or artifactId mismatch). Expired tokens are reaped
 * on access.
 */
export function validateWopiToken(
  token: string | undefined,
  artifactId: string,
): WopiTokenRecord | null {
  if (!token || token.length === 0) return null;
  let matchedKey: string | null = null;
  let matched: WopiTokenRecord | null = null;
  for (const [key, rec] of tokenStore) {
    if (safeEqual(key, token)) {
      matchedKey = key;
      matched = rec;
      break;
    }
  }
  if (!matched || !matchedKey) return null;
  if (Date.now() >= matched.expiresAt) {
    tokenStore.delete(matchedKey);
    return null;
  }
  if (!safeEqual(matched.artifactId, artifactId)) return null;
  return matched;
}

/** Test-only hook: clear the token store between unit tests. */
export function __resetWopiTokenStoreForTests(): void {
  tokenStore.clear();
}

/** Test-only hook: clear the WOPI lock store between unit tests. */
export function __resetWopiLockStoreForTests(): void {
  lockStore.clear();
}

/** Test-only hook: clear the autosave throttle between unit tests. */
export function __resetWopiAutosaveThrottleForTests(): void {
  autosaveThrottle.clear();
}

function absPathFromStorageUri(storageUri: string): string | null {
  if (!storageUri.startsWith("file://")) return null;
  const rest = storageUri.slice("file://".length);
  if (!rest.startsWith("/")) return null;
  return rest;
}

/**
 * Origin coolwsd (running in its own container) calls back to reach this
 * server's `/wopi` endpoints (`CheckFileInfo` / `GetFile` / `PutFile`). It is
 * also the WOPI-host value that must appear in coolwsd's `aliasgroup1`
 * allowlist.
 *
 * M201 R1 — topology-aware. Honors `NAUTILO_WOPI_CALLBACK_ORIGIN` so a
 * containerized deploy can reach the server over the compose bridge network
 * (`http://nautilo-server:3001`), where `host.docker.internal` does NOT resolve
 * to the server container. When unset it falls back to today's dev value —
 * the `host.docker.internal` container→host hop on the config-resolved server
 * port — so dev behaves identically. Trailing slash stripped.
 */
export function wopiCallbackOrigin(): string {
  return (
    process.env["NAUTILO_WOPI_CALLBACK_ORIGIN"] ??
    `http://host.docker.internal:${resolveInstance().server.port}`
  ).replace(/\/$/, "");
}

/**
 * Collabora engine origin the SERVER uses to fetch discovery. With
 * `net.service_root=/office-engine` the discovery route lives under that
 * service root; the browser still receives a same-origin URL rebased to the
 * Nautilo server origin.
 *
 * M201 R1 — reads the SAME `NAUTILO_COLLABORA_ENGINE_URL` override as the
 * proxy upstream (`office-proxy.ts` `collaboraEngineHttpUrl`) so discovery and
 * proxying always target one engine. The historical `localhost` vs `127.0.0.1`
 * defaults are functionally identical; the literal default is kept for zero
 * behavior change when the var is unset. Trailing slash stripped.
 */
export function collaboraEngineOrigin(): string {
  return (
    process.env["NAUTILO_COLLABORA_ENGINE_URL"] ??
    `http://localhost:${collaboraHostPort(resolveInstance())}`
  ).replace(/\/$/, "");
}

// Cache the discovered `cool.html` base URL per collabora origin (the discovery
// XML changes only across engine upgrades). Short TTL so a version bump is
// picked up without a restart.
const COOL_BASE_TTL_MS = 10 * 60 * 1000;
const coolBaseCache = new Map<string, { base: string; expiresAt: number }>();

/**
 * Fetch coolwsd's `/office-engine/hosting/discovery`, extract the first
 * `urlsrc` (the `cool.html` action URL), and rebuild it against the engine
 * origin so we get the correct service-rooted browser path
 * (`/office-engine/browser/<hash>/cool.html`). Throws if discovery is
 * unreachable/unparseable — the caller degrades gracefully (editorUrl:null).
 */
async function fetchCoolBaseUrl(engineOrigin: string): Promise<string> {
  const cached = coolBaseCache.get(engineOrigin);
  if (cached && Date.now() < cached.expiresAt) return cached.base;
  const res = await fetch(`${engineOrigin}${OFFICE_PROXY_PREFIX}/hosting/discovery`, {
    method: "GET",
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
  const xml = await res.text();
  const m = xml.match(/urlsrc="([^"]+)"/);
  const urlsrc = m?.[1];
  if (!urlsrc) throw new Error("no urlsrc in discovery");
  const pathname = new URL(urlsrc).pathname;
  const base = `${engineOrigin}${pathname}`;
  coolBaseCache.set(engineOrigin, { base, expiresAt: Date.now() + COOL_BASE_TTL_MS });
  return base;
}
function readAccessToken(request: FastifyRequest): string | undefined {
  const q = request.query as { access_token?: string };
  const raw = q["access_token"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Browser-facing origin for the editor URL. Prefer the inbound request host so
 * the iframe URL is byte-for-byte same-origin with the workbench renderer
 * (Electron dev connects to 127.0.0.1, while instance.json historically stores
 * localhost). Fall back to the configured public server URL for non-HTTP tests.
 */
function requestPublicOrigin(request: FastifyRequest): string {
  const host = readHeader(request, "host");
  if (host && host.length > 0) {
    const proto = readHeader(request, "x-forwarded-proto") ?? "http";
    return `${proto}://${host}`;
  }
  return resolvePublicServerUrl(resolveInstance());
}

function lookupArtifact(
  artifactId: string,
  readableNamespaces: string[],
): Promise<Artifact | null> {
  return findArtifactByInternalIdForNamespaces({
    internalId: artifactId,
    readableNamespaceIds: readableNamespaces,
  });
}

/** Read a single-value request header (handles Fastify's `string | string[]`). */
function readHeader(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Read the `X-WOPI-Override` value, upper-cased for dispatch. */
function readWopiOverride(request: FastifyRequest): string | undefined {
  const raw = readHeader(request, "x-wopi-override");
  return raw ? raw.toUpperCase() : undefined;
}

/**
 * Live lock entry for `id`, or null if absent / expired. Expired entries
 * are reaped on access (same pattern as the token store).
 */
function liveLock(id: string): { lock: string; expiresAt: number } | null {
  const entry = lockStore.get(id);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    lockStore.delete(id);
    return null;
  }
  return entry;
}

/** Returns true iff the artifact is resolvable in the token's writable namespaces. */
async function artifactIsWritable(
  artifactId: string,
  writableNamespaces: string[],
): Promise<boolean> {
  if (writableNamespaces.length === 0) return false;
  const row = await lookupArtifact(artifactId, writableNamespaces);
  return row !== null;
}

/**
 * Persist PutFile bytes + bump revision (unless throttled) + emit the
 * workspace change event. Returns the new revision (or the unchanged
 * revision when the autosave throttle skipped the bump).
 *
 * Binary-write strategy: see the file-level docstring — `writeFile` to
 * the existing on-disk path, then `bumpArtifactRevision`. The
 * `bumpArtifactRevision` helper is the SAME row-bump the agent's
 * `applyWorkspaceArtifactRowChange` uses after `apply_patch`, so the
 * revision-monotonicity invariant is shared with the rest of the
 * workspace write paths.
 */
async function persistArtifactBytes(
  row: Artifact,
  bytes: Buffer,
  options: { isUserInitiated: boolean },
): Promise<{ revision: number; bumped: boolean }> {
  const abs = absPathFromStorageUri(row.storageUri);
  if (!abs) throw new Error("Invalid storage URI");

  // Defensive: ensure the parent dir exists. The create path makes the
  // dir at insert time, but a temp-dir test fixture or a moved file
  // could leave it absent; a missing parent would otherwise turn every
  // PutFile into a 500.
  await mkdir(dirname(abs), { recursive: true });
  await fsWriteFile(abs, bytes);

  const now = Date.now();
  const throttle = autosaveThrottle.get(row.id);
  const withinDebounce =
    throttle !== undefined && now - throttle.lastBumpAt < AUTOSAVE_DEBOUNCE_MS;
  const shouldBump = options.isUserInitiated || !withinDebounce;

  if (!shouldBump) {
    // Autosave within the debounce window: bytes are persisted, the
    // revision + SSE event are deferred until the next user-initiated
    // save or the next autosave outside the window.
    return { revision: row.revision, bumped: false };
  }

  const updated = await bumpArtifactRevision({
    id: row.id,
    size: bytes.byteLength,
    ...(row.mimeType && row.mimeType.length > 0 ? { mimeType: row.mimeType } : {}),
  });
  autosaveThrottle.set(row.id, { lastBumpAt: now });

  const finalRow = updated ?? row;
  eventBus.emit({
    type: "workspace.artifact.changed",
    id: finalRow.id,
    artifactId: finalRow.artifactId,
    path: finalRow.path,
  });
  return { revision: finalRow.revision, bumped: true };
}

/**
 * M201 R4 — the WOPI token / lock / autosave stores above are in-memory
 * `Map`s: correct for ONE server process, silently broken across replicas
 * (two replicas can't validate each other's tokens and disagree on locks).
 * Collabora/office is a SINGLE-REPLICA feature until D362 Phase 5.1 ships a
 * shared (Redis/db) store. Emit a loud warning at office-route registration
 * whenever a multi-replica signal is present, plus an always-on one-line note
 * so the constraint is greppable in logs.
 */
export function warnOfficeSingleReplica(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const replicasRaw = env["NAUTILO_SERVER_REPLICAS"];
  const replicas = replicasRaw ? Number.parseInt(replicasRaw, 10) : 1;
  if (Number.isFinite(replicas) && replicas > 1) {
    warn(
      `[wopi] M201: Collabora/office requires a SINGLE server replica — in-memory ` +
        `WOPI token/lock/autosave stores are NOT shared across replicas ` +
        `(NAUTILO_SERVER_REPLICAS=${replicasRaw}). Office is UNSUPPORTED under ` +
        `horizontal scale until a shared store lands (D362 Phase 5.1).`,
    );
    return;
  }
  warn(
    "[wopi] M201: office runs single-replica (in-memory WOPI stores). " +
      "Do not scale the server horizontally with office enabled.",
  );
}

export function wopiRoutes(
  app: FastifyInstance,
  options?: Readonly<{
    validateAdmissionProvenance?: (
      provenance: WopiAdmissionProvenance,
    ) => Promise<boolean>;
  }>,
): void {
  warnOfficeSingleReplica();
  // ─── Body parser for PutFile ───────────────────────────────────────
  //
  // coolwsd POSTs the raw file bytes with `Content-Type: application/octet-stream`
  // (per WOPI spec; Collabora follows this). We buffer the whole body into a
  // Buffer — office docs are typically <10MB and the 100MB cap above bounds
  // memory. The text/* parser registered by workspace-artifacts.ts is
  // untouched; JSON still uses Fastify's default parser.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: PUTFILE_BODY_LIMIT },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // ─── CheckFileInfo ────────────────────────────────────────────────
  //
  // coolwsd GETs `<wopiSrc>?access_token=...` to learn the file's
  // metadata before opening the editor. `UserCanWrite` / `SupportsUpdate`
  // are derived server-side from the token's `writableNamespaces` grant —
  // the browser/client never asserts writability, so a read-only envelope
  // cannot escalate by tampering with the editor URL. `SupportsLocks:true`
  // advertises the lock family so coolwsd doesn't fall back to its
  // no-lock save-conflict path.
  app.get("/wopi/files/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = validateWopiToken(readAccessToken(request), id);
    if (!record) {
      return reply.code(401).send({ error: "Invalid or missing WOPI access token" });
    }
    if (options?.validateAdmissionProvenance &&
        !await options.validateAdmissionProvenance(record.provenance)) {
      return reply.code(401).send({ error: "WOPI device admission is no longer valid" });
    }
    const row = await lookupArtifact(id, record.readableNamespaces);
    if (!row) return reply.code(404).send({ error: "Not found" });

    let size = row.size ?? 0;
    const abs = absPathFromStorageUri(row.storageUri);
    if (abs) {
      try {
        const st = await fsStat(abs);
        size = st.size;
      } catch {
        warn(`[wopi] CheckFileInfo stat failed for ${abs}`);
      }
    }

    let hasWriteCapability = false;
    try {
      await assertCanWriteArtifacts({
        humanUserId: record.userId,
        artifactId: row.id,
      });
      hasWriteCapability = true;
    } catch (error) {
      if (!(error instanceof ArtifactWriteDeniedError)) throw error;
    }
    const canWrite = hasWriteCapability &&
      await artifactIsWritable(id, record.mutableNamespaces);

    const baseFileName = basename(row.path) || row.artifactId;
    const version = String(row.revision);

    return reply.send({
      BaseFileName: baseFileName,
      Size: size,
      OwnerId: record.ownerId,
      UserId: record.userId,
      UserFriendlyName: record.userFriendlyName,
      Version: version,
      UserCanWrite: canWrite,
      SupportsLocks: true,
      SupportsUpdate: canWrite,
    });
  });

  // ─── GetFile ──────────────────────────────────────────────────────
  //
  // coolwsd GETs `<wopiSrc>/contents?access_token=...` to stream the
  // file bytes. We pipe straight from disk (same `storageUri` → abs
  // path resolution as workspace-artifacts.ts) so we never buffer the
  // whole file in memory.
  app.get("/wopi/files/:id/contents", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = validateWopiToken(readAccessToken(request), id);
    if (!record) {
      return reply.code(401).send({ error: "Invalid or missing WOPI access token" });
    }
    if (options?.validateAdmissionProvenance &&
        !await options.validateAdmissionProvenance(record.provenance)) {
      return reply.code(401).send({ error: "WOPI device admission is no longer valid" });
    }
    const row = await lookupArtifact(id, record.readableNamespaces);
    if (!row) return reply.code(404).send({ error: "Not found" });

    const abs = absPathFromStorageUri(row.storageUri);
    if (!abs) return reply.code(500).send({ error: "Invalid storage URI" });

    let size = row.size ?? 0;
    try {
      const st = await fsStat(abs);
      size = st.size;
    } catch {
      warn(`[wopi] GetFile stat failed for ${abs}`);
    }
    const mimeType = row.mimeType ?? "application/octet-stream";

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": mimeType,
      "Content-Length": String(size),
    });
    await pipeline(createReadStream(abs), reply.raw);
  });

  // ─── PutFile ──────────────────────────────────────────────────────
  //
  // coolwsd POSTs `<wopiSrc>/contents?access_token=...` with the raw
  // file bytes as the body + `X-WOPI-Override: PUT` to save edits back.
  // We validate the token, require the artifact to be writable in the
  // token's `writableNamespaces` (403 if not), persist the bytes, bump
  // the revision (subject to the autosave debounce), and emit the
  // workspace change event so other clients refresh via SSE.
  //
  // Autosave: when `X-WOPI-IsAutosave:true` AND NOT
  // `X-WOPI-IsModifiedByUser:true`, the revision bump + event are
  // debounced to at most one per AUTOSAVE_DEBOUNCE_MS per artifact.
  // Bytes are ALWAYS persisted. A user-initiated save
  // (`X-WOPI-IsModifiedByUser:true` OR a non-autosave PutFile) flushes
  // immediately and resets the debounce window.
  app.post(
    "/wopi/files/:id/contents",
    { bodyLimit: PUTFILE_BODY_LIMIT },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const record = validateWopiToken(readAccessToken(request), id);
      if (!record) {
        return reply.code(401).send({ error: "Invalid or missing WOPI access token" });
      }
      if (options?.validateAdmissionProvenance &&
          !await options.validateAdmissionProvenance(record.provenance)) {
        return reply.code(401).send({ error: "WOPI device admission is no longer valid" });
      }

      // The X-WOPI-Override header MUST be PUT for PutFile. Coolwsd
      // always sends it; reject if absent/wrong so a misrouted lock op
      // (which would carry LOCK/UNLOCK/etc.) doesn't accidentally land
      // on the byte-write path.
      const override = readWopiOverride(request);
      if (override !== "PUT") {
        return reply.code(400).send({ error: "X-WOPI-Override must be PUT for PutFile" });
      }

      const row = await lookupArtifact(id, record.readableNamespaces);
      if (!row) return reply.code(404).send({ error: "Not found" });

      const writable = await artifactIsWritable(id, record.mutableNamespaces);
      if (!writable) {
        return reply.code(403).send({ error: "Artifact is not writable with this token" });
      }
      if (!(await requireArtifactWrite(
        { humanUserId: record.userId, artifactId: row.id },
        reply,
      ))) {
        return;
      }

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send({ error: "Expected raw binary body" });
      }

      const isAutosave = readHeader(request, "x-wopi-isautosave") === "true";
      const isModifiedByUser = readHeader(request, "x-wopi-ismodifiedbyuser") === "true";
      const isUserInitiated = !isAutosave || isModifiedByUser;

      try {
        const result = await persistArtifactBytes(row, body, { isUserInitiated });
        reply.header("X-WOPI-ItemVersion", String(result.revision));
        return reply.code(200).send();
      } catch (err) {
        warn(
          `[wopi] PutFile persist failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return reply.code(500).send({ error: "Failed to persist file" });
      }
    },
  );

  // ─── Lock / Unlock / RefreshLock / GetLock / UnlockAndRelock ───────
  //
  // coolwsd POSTs `<wopiSrc>?access_token=...` (no `/contents`) with
  // `X-WOPI-Override` dispatching the lock op. `X-WOPI-Lock` carries
  // the opaque lock id (provider-chosen, we just store it verbatim).
  // UnlockAndRelock additionally sends `X-WOPI-OldLock` for the
  // compare-and-swap. On lock mismatch we return 409 with
  // `X-WOPI-Lock: <currentLock>` so coolwsd can re-sync.
  //
  // The lock store is in-memory (Map); Phase 5 needs a shared store for
  // multi-replica consistency.
  app.post("/wopi/files/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = validateWopiToken(readAccessToken(request), id);
    if (!record) {
      return reply.code(401).send({ error: "Invalid or missing WOPI access token" });
    }
    if (options?.validateAdmissionProvenance &&
        !await options.validateAdmissionProvenance(record.provenance)) {
      return reply.code(401).send({ error: "WOPI device admission is no longer valid" });
    }
    const override = readWopiOverride(request);
    const lockId = readHeader(request, "x-wopi-lock");
    const oldLock = readHeader(request, "x-wopi-oldlock");

    if (override !== "GET_LOCK") {
      const row = await lookupArtifact(id, record.readableNamespaces);
      if (!row) return reply.code(404).send({ error: "Not found" });
      if (!(await artifactIsWritable(id, record.mutableNamespaces))) {
        return reply.code(403).send({ error: "Artifact is not writable with this token" });
      }
      if (!(await requireArtifactWrite(
        { humanUserId: record.userId, artifactId: row.id },
        reply,
      ))) {
        return;
      }
    }

    switch (override) {
      case "LOCK": {
        if (!lockId) return reply.code(400).send({ error: "X-WOPI-Lock required" });
        const current = liveLock(id);
        if (current && current.lock !== lockId) {
          reply.header("X-WOPI-Lock", current.lock);
          return reply.code(409).send({ error: "File locked by another session" });
        }
        lockStore.set(id, { lock: lockId, expiresAt: Date.now() + LOCK_TTL_MS });
        return reply.code(200).send();
      }
      case "UNLOCK": {
        if (!lockId) return reply.code(400).send({ error: "X-WOPI-Lock required" });
        const current = liveLock(id);
        if (!current) return reply.code(404).send({ error: "File not locked" });
        if (current.lock !== lockId) {
          reply.header("X-WOPI-Lock", current.lock);
          return reply.code(409).send({ error: "Lock mismatch" });
        }
        lockStore.delete(id);
        return reply.code(200).send();
      }
      case "REFRESH_LOCK": {
        if (!lockId) return reply.code(400).send({ error: "X-WOPI-Lock required" });
        const current = liveLock(id);
        if (!current) return reply.code(404).send({ error: "File not locked" });
        if (current.lock !== lockId) {
          reply.header("X-WOPI-Lock", current.lock);
          return reply.code(409).send({ error: "Lock mismatch" });
        }
        current.expiresAt = Date.now() + LOCK_TTL_MS;
        return reply.code(200).send();
      }
      case "GET_LOCK": {
        const current = liveLock(id);
        reply.header("X-WOPI-Lock", current ? current.lock : "");
        return reply.code(200).send();
      }
      case "UNLOCKANDRELOCK": {
        if (!lockId || !oldLock) {
          return reply.code(400).send({ error: "X-WOPI-Lock and X-WOPI-OldLock required" });
        }
        const current = liveLock(id);
        if (!current) return reply.code(404).send({ error: "File not locked" });
        if (current.lock !== oldLock) {
          reply.header("X-WOPI-Lock", current.lock);
          return reply.code(409).send({ error: "Lock mismatch" });
        }
        lockStore.set(id, { lock: lockId, expiresAt: Date.now() + LOCK_TTL_MS });
        return reply.code(200).send();
      }
      default:
        return reply.code(400).send({ error: `Unsupported X-WOPI-Override: ${override ?? "(missing)"}` });
    }
  });

  // ─── Token mint (user-authed via normal trust preHandler) ─────────
  //
  // Frontend calls this with the artifact's internal id; we confirm
  // the caller's envelope can read the artifact (same
  // `envelopeReadableNamespaces` + `findArtifactByInternalIdForNamespaces`
  // chain as GET /api/workspace/artifacts/:id), then mint a short-TTL
  // token bound to that artifact + the envelope's readable AND writable
  // namespace grants. coolwsd later presents the token to the `/wopi/*`
  // routes above, which bypass user-session auth (see app.ts preHandler).
  //
  // This route is NOT in the `/wopi/` prefix and therefore does NOT
  // bypass user-session auth — it stays user-authed. The writable grant
  // is captured at mint time so a later loss of write access (e.g. the
  // envelope's writable set shrinks) does NOT revoke an in-flight edit
  // session; that's the WOPI tradeoff (short token TTL bounds it).
  app.post("/api/office/wopi-token", async (request, reply) => {
    const env = request.memoryEnvelope;
    if (!env) return reply.code(401).send({ error: "Authentication required" });
    const agentId = env.agentId;
    if (!agentId) return reply.code(403).send({ error: "Agent context required" });

    const body = (request.body ?? {}) as { artifactId?: unknown; permission?: unknown };
    const artifactId =
      typeof body?.artifactId === "string" ? body.artifactId.trim() : "";
    if (!artifactId) return reply.code(400).send({ error: "artifactId is required" });
    const requestedPermission = body?.permission === "edit" ? "edit" : "readonly";

    const readable = envelopeReadableNamespaces(env);
    if (readable.length === 0) {
      return reply.code(403).send({ error: "No readable namespace in this context" });
    }
    const writable = envelopeWritableNamespaces(env);
    const mutable = envelopeMutableNamespaces(env);

    const row = await lookupArtifact(artifactId, readable);
    if (!row) return reply.code(404).send({ error: "Not found" });

    const userId = request.sessionUserId ?? env.ownerId ?? "nautilo-user";
    const ownerId = env.ownerId ?? "nautilo-owner";
    const userFriendlyName = userId;

    let hasWriteCapability = false;
    if (requestedPermission === "edit") {
      try {
        await assertCanWriteArtifacts({ humanUserId: userId, artifactId: row.id });
        hasWriteCapability = true;
      } catch (error) {
        if (!(error instanceof ArtifactWriteDeniedError)) throw error;
      }
    }
    const permission = requestedPermission === "edit" && hasWriteCapability
      ? "edit"
      : "readonly";

    const { token } = issueWopiToken(artifactId, {
      readableNamespaces: readable,
      writableNamespaces: hasWriteCapability ? writable : [],
      mutableNamespaces: hasWriteCapability ? mutable : [],
      ownerId,
      userId,
      userFriendlyName,
      provenance: request.cryptoDeviceAdmission
        ? Object.freeze({
            kind: "human_device" as const,
            userId,
            humanActorId: request.sessionActorId!,
            deviceId: request.cryptoDeviceAdmission.deviceId,
            deviceGeneration: request.cryptoDeviceAdmission.deviceGeneration,
            serverInstanceId: request.cryptoDeviceAdmission.serverInstanceId,
            lineageGeneration: request.cryptoDeviceAdmission.lineageGeneration,
            epoch: request.cryptoDeviceAdmission.epoch,
            securityRevision: request.cryptoDeviceAdmission.securityRevision,
            headDigest: request.cryptoDeviceAdmission.headDigest.slice(),
          })
        : Object.freeze({ kind: "plaintext_human" as const }),
    });

    const origin = wopiCallbackOrigin();
    const wopiSrc = `${origin}/wopi/files/${encodeURIComponent(artifactId)}`;

    // Assemble the full browser-loadable editor URL server-side (fetches
    // coolwsd discovery for the cool.html hash). This avoids a cross-origin
    // discovery fetch (and its CORS) in the renderer. Degrades gracefully:
    // if the engine is unreachable we return editorUrl:null and the client
    // surfaces an "engine unavailable" error.
    let editorUrl: string | null = null;
    try {
      // Discovery stays a server-side fetch from the engine directly
      // (coolwsd's `/hosting/discovery` returns the per-build
      // `/browser/<hash>/cool.html` path). We then RE-BASE that path
      // onto the same-origin proxy so the browser loads cool.html from
      // the Nautilo origin, not the cross-origin engine host.
      const coolBase = await fetchCoolBaseUrl(collaboraEngineOrigin());
      const publicServerOrigin = requestPublicOrigin(request);
      const coolPath = new URL(coolBase).pathname;
      const sameOriginBase = `${publicServerOrigin}${coolPath}`;
      const params = new URLSearchParams({
        WOPISrc: wopiSrc,
        access_token: token,
        permission,
      });
      editorUrl = `${sameOriginBase}?${params.toString()}`;
    } catch (e) {
      warn(`[wopi] editor URL assembly failed (collabora unreachable?): ${String(e)}`);
    }

    return reply.send({ editorUrl, token, wopiSrc });
  });
}
