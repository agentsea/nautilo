import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  RELAY_FS_MAX_BYTES,
  RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
} from "@nautilo/relay";
import type {
  RelayFsRequest,
  RelayFsResult,
  RelayLocalDocumentReadMetaResult,
  RelayLocalDocumentWriteBeginResult,
  RelayLocalDocumentWriteChunkResult,
  RelayLocalFileRequest,
  RelayLocalFileResult,
} from "@nautilo/relay";
import {
  parseLocalSha256,
  parseLocalShaDocumentVersion,
  type LocalShaDocumentVersion,
} from "@nautilo/types";
import { createFileMutationRequestId } from "@nautilo/agent";
import { MAX_DOCUMENT_BYTES } from "@nautilo/writer-proposal-core";
import { validateClientPath } from "../messaging/attachments";
import {
  normalizeRelPath,
  validateRelativePath,
} from "./app-source-store";
import type { LiveMiniAppSessionCurrentFileBinding } from "./live-mini-app-session-registry";

/** Stable client-facing errors for Current Folder live-session issuance. */
export type LiveLocalDocumentAuthorityErrorCode =
  | "relay_unavailable"
  | "local_target_forbidden"
  | "stale_version";

export type LiveLocalDocumentAuthorityResult =
  | {
      ok: true;
      binding: LiveMiniAppSessionCurrentFileBinding;
    }
  | {
      ok: false;
      code: LiveLocalDocumentAuthorityErrorCode;
    };

/** D423/M206 relay snapshot port — exact hinted relay, no fallback selection. */
export interface LiveLocalRelayRegistryPort {
  snapshotForFocusedResource(
    relayId: string,
    actorId: string,
  ): LiveLocalRelaySnapshot | null;
}

export interface LiveLocalRelaySnapshot {
  ownedByActor: boolean;
  protocolVersion: number;
  profile: "device-relay" | "desktop-agent";
  localFileExecution: boolean;
  allowedRoots: readonly string[];
}

export interface LiveLocalFileDispatchPort {
  localFileDispatch(
    relayId: string,
    req: RelayLocalFileRequest,
    opts: { mutating: boolean; approvalObtained: boolean },
  ): Promise<RelayLocalFileResult>;
  fsDispatch(
    relayId: string,
    req: RelayFsRequest,
    opts: { mutating: boolean; timeoutMs?: number },
  ): Promise<RelayFsResult>;
}

export type CanonicalLocalDocumentReadInput = {
  ownerId: string;
  relayId: string;
  allowedRoots: readonly string[];
  currentFolderRoot: string;
  relativePath: string;
  canonicalPath: string;
  /**
   * Optional caller-owned semantic document limit. Omit for infrastructure
   * snapshots that must not inherit a UI/editor ceiling.
   */
  maxBytes?: number;
};

export type CanonicalLocalDocumentReadResult =
  | { ok: true; bytes: Uint8Array; sha256: string }
  | {
      ok: false;
      code:
        | "relay_unavailable"
        | "local_target_forbidden"
        | "document_chunk_transport_required";
    };

export type CanonicalLocalDocumentReader = (
  input: CanonicalLocalDocumentReadInput,
) => Promise<CanonicalLocalDocumentReadResult>;

export interface LiveLocalDocumentAuthorityDeps {
  relayRegistry: LiveLocalRelayRegistryPort;
  localFileDispatch: LiveLocalFileDispatchPort;
  readCanonical?: CanonicalLocalDocumentReader;
}

export interface ResolveCurrentFileLiveSessionInput {
  appId: string;
  userId: string;
  relayIdHint: string;
  currentFolder: string;
  relativePath: string;
  documentVersion: LocalShaDocumentVersion;
}

export interface RefreshCurrentFileLiveSessionInput {
  appId: string;
  userId: string;
  currentFolder: string;
  relativePath: string;
  documentVersion: LocalShaDocumentVersion;
  existing: LiveMiniAppSessionCurrentFileBinding;
}

export interface WriteAcceptedLocalDocumentInput {
  binding: LiveMiniAppSessionCurrentFileBinding;
  bytes: Uint8Array;
  agentId: string;
  turnId: string;
  clientMutationId: string;
}

export type WriteAcceptedLocalDocumentResult =
  | { ok: true; sha256: string; localRevisionRef: string }
  | { ok: false; code: LiveLocalDocumentAuthorityErrorCode };

export type CanonicalLocalTargetIdentityResult =
  | { ok: true; canonicalTargetIdentity: string }
  | { ok: false; code: "relay_unavailable" | "local_target_forbidden" | "not_found" };

/**
 * Read-only snapshot for a server-authorized local document target.
 *
 * Unlike `resolveCurrentFileIssue`, this deliberately creates neither a
 * mini-app binding nor a live session. It is the narrow primitive used by
 * document infrastructure that has already selected a relay hint and needs
 * the canonical document truth before recording ephemeral state.
 */
export type CanonicalLocalDocumentSnapshotResult =
  | {
      ok: true;
      relayId: string;
      canonicalPath: string;
      bytes: Uint8Array;
      sha256: string;
    }
  | {
      ok: false;
      code: "relay_unavailable" | "local_target_forbidden" | "not_found";
    };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Reject absolute paths, traversal, and control characters in host relative paths. */
export function validateLiveCurrentFileRelativePath(relativePath: string): string | null {
  return validateRelativePath(relativePath);
}

export function resolveLiveCurrentFileCanonicalPath(
  currentFolder: string,
  relativePath: string,
): string {
  const folder = path.normalize(currentFolder);
  const rel = normalizeRelPath(relativePath);
  return path.normalize(path.join(folder, rel));
}

export function isPathContainedInRoot(targetPath: string, rootPath: string): boolean {
  const root = path.normalize(rootPath);
  const target = path.normalize(targetPath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(rootWithSep);
}

export function isPathContainedInAllowedRoots(
  canonicalPath: string,
  allowedRoots: readonly string[],
): boolean {
  for (const root of allowedRoots) {
    if (isPathContainedInRoot(canonicalPath, root)) return true;
  }
  return false;
}

function isCanonicalIdentityAuthorizedByRoots(
  canonicalTargetIdentity: string,
  allowedRoots: readonly string[],
): boolean {
  const pathApi = pathApiForRelayIdentity(canonicalTargetIdentity);
  if (
    !pathApi.isAbsolute(canonicalTargetIdentity) ||
    pathApi.normalize(canonicalTargetIdentity) !== canonicalTargetIdentity
  ) {
    return false;
  }
  return findRelayIdentityAllowedRoot(canonicalTargetIdentity, allowedRoots) !== null;
}

function isWindowsRelayIdentity(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

/** Select path semantics from the relay identity, never from server host OS. */
function pathApiForRelayIdentity(value: string): typeof path.posix {
  return isWindowsRelayIdentity(value) ? path.win32 : path.posix;
}

function isRelayPathContainedInRoot(
  targetPath: string,
  rootPath: string,
): boolean {
  if (isWindowsRelayIdentity(targetPath) !== isWindowsRelayIdentity(rootPath)) {
    return false;
  }
  const pathApi = pathApiForRelayIdentity(targetPath);
  const target = pathApi.normalize(targetPath);
  const root = pathApi.normalize(rootPath);
  if (!pathApi.isAbsolute(target) || !pathApi.isAbsolute(root)) return false;
  const relative = pathApi.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

function findRelayIdentityAllowedRoot(
  canonicalTargetIdentity: string,
  allowedRoots: readonly string[],
): string | null {
  return allowedRoots.find((root) =>
    isRelayPathContainedInRoot(canonicalTargetIdentity, root),
  ) ?? null;
}

function qualifyHintedRelay(
  relayRegistry: LiveLocalRelayRegistryPort,
  relayIdHint: string,
  userId: string,
): LiveLocalRelaySnapshot | null {
  if (typeof relayIdHint !== "string" || relayIdHint.length === 0) return null;
  if (hasControlChars(relayIdHint)) return null;
  const snapshot = relayRegistry.snapshotForFocusedResource(relayIdHint, userId);
  if (!snapshot) return null;
  if (!snapshot.ownedByActor) return null;
  if (snapshot.protocolVersion < 4) return null;
  if (snapshot.profile !== "desktop-agent") return null;
  if (!snapshot.localFileExecution) return null;
  if (snapshot.allowedRoots.length === 0) return null;
  return snapshot;
}

function parseStatPreflightResult(result: unknown): { ok: true; size: number } | { ok: false } {
  if (typeof result === "string") {
    if (result.startsWith("Error:")) return { ok: false };
    try {
      return parseStatPreflightResult(JSON.parse(result));
    } catch {
      return { ok: false };
    }
  }
  if (!result || typeof result !== "object") return { ok: false };
  const record = result as Record<string, unknown>;
  if (record["isSymbolicLink"] === true) return { ok: false };
  if (record["isFile"] !== true) return { ok: false };
  const size = record["size"];
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return { ok: false };
  return { ok: true, size };
}

function parseResultRecord(result: unknown): Record<string, unknown> | null {
  if (typeof result === "string") {
    if (result.startsWith("Error:")) return null;
    try {
      return parseResultRecord(JSON.parse(result));
    } catch {
      return null;
    }
  }
  return result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
}

function decodeCanonicalBase64(value: unknown, maxBytes: number): Uint8Array | null {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maxBytes || bytes.toString("base64") !== value) return null;
  return bytes;
}

function localRouting(
  ownerId: string,
  currentFolder: string,
  mutation?: {
    agentId: string;
    turnId: string;
    mutationRequestId: string;
  },
) {
  return {
    ownerId,
    agentId: mutation?.agentId ?? "",
    ...(mutation
      ? {
          turnId: mutation.turnId,
          mutationRequestId: mutation.mutationRequestId,
        }
      : {}),
    currentFolder,
    workspaceRoot: "",
  };
}

function parseBinaryReadResult(
  result: unknown,
  expectedBytes: number,
): { ok: true; bytes: Uint8Array } | { ok: false } {
  const record = parseResultRecord(result);
  const bytes = decodeCanonicalBase64(record?.["content"], RELAY_FS_MAX_BYTES);
  return bytes && bytes.byteLength === expectedBytes ? { ok: true, bytes } : { ok: false };
}

function parseDocumentReadMeta(
  result: unknown,
  expectedSessionId: string,
  expectedBytes: number,
): RelayLocalDocumentReadMetaResult | null {
  const record = parseResultRecord(result);
  if (
    record?.["sessionId"] !== expectedSessionId ||
    record["totalBytes"] !== expectedBytes ||
    !Number.isSafeInteger(record["chunkCount"]) ||
    (record["chunkCount"] as number) !==
      Math.ceil(expectedBytes / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES) ||
    parseLocalSha256(record["sha256"]) === null
  ) {
    return null;
  }
  return record as unknown as RelayLocalDocumentReadMetaResult;
}

function parseDocumentReadChunk(
  result: unknown,
  expected: {
    sessionId: string;
    index: number;
    chunkCount: number;
    totalBytes: number;
    expectedBytes: number;
  },
): Uint8Array | null {
  const record = parseResultRecord(result);
  if (
    record?.["sessionId"] !== expected.sessionId ||
    record["index"] !== expected.index ||
    record["chunkCount"] !== expected.chunkCount ||
    record["totalBytes"] !== expected.totalBytes
  ) {
    return null;
  }
  const bytes = decodeCanonicalBase64(
    record["data"],
    RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
  );
  return bytes?.byteLength === expected.expectedBytes ? bytes : null;
}

function safeDispatchFailureCode(
  result: RelayLocalFileResult,
): LiveLocalDocumentAuthorityErrorCode {
  if (result.ok) {
    const error = parseResultRecord(result.result)?.["error"];
    if (error === "stale_sha256") return "stale_version";
    if (
      error === "path_forbidden" ||
      error === "not_a_file" ||
      error === "session_path_mismatch"
    ) {
      return "local_target_forbidden";
    }
  }
  return "relay_unavailable";
}

function parseAppliedWrite(
  result: RelayLocalFileResult,
  expectedSha256: string,
): WriteAcceptedLocalDocumentResult {
  if (!result.ok) return { ok: false, code: safeDispatchFailureCode(result) };
  const record = parseResultRecord(result.result);
  if (record?.["error"] !== undefined) {
    return { ok: false, code: safeDispatchFailureCode(result) };
  }
  const sha256 = parseLocalSha256(record?.["sha256"]);
  const revisionId = record?.["revisionId"];
  if (
    record?.["applied"] !== true ||
    sha256 === null ||
    // The relay may already have committed before returning a faulty result.
    // Treat that outcome as unknown and never let callers advance registry
    // state to a hash the server did not compute from the dispatched bytes.
    sha256 !== expectedSha256 ||
    typeof revisionId !== "string" ||
    revisionId.length === 0
  ) {
    return { ok: false, code: "relay_unavailable" };
  }
  return { ok: true, sha256, localRevisionRef: revisionId };
}

function createDefaultCanonicalLocalDocumentReader(
  dispatch: LiveLocalFileDispatchPort,
): CanonicalLocalDocumentReader {
  return async (input) => {
    const routing = localRouting(input.ownerId, input.currentFolderRoot);
    const statResult = await dispatch.localFileDispatch(
      input.relayId,
      {
        allowedRoots: [...input.allowedRoots],
        operation: {
          kind: "file",
          command: "stat",
          zone: "current",
          args: { path: input.relativePath, _routing: routing },
        },
      },
      { mutating: false, approvalObtained: false },
    );
    if (!statResult.ok) {
      return { ok: false, code: "local_target_forbidden" };
    }
    const stat = parseStatPreflightResult(statResult.result);
    if (!stat.ok) {
      return { ok: false, code: "local_target_forbidden" };
    }
    if (input.maxBytes !== undefined && stat.size > input.maxBytes) {
      return { ok: false, code: "local_target_forbidden" };
    }
    if (stat.size > RELAY_FS_MAX_BYTES) {
      const sessionId = randomUUID();
      const metaResult = await dispatch.localFileDispatch(
        input.relayId,
        {
          allowedRoots: [...input.allowedRoots],
          operation: {
            kind: "document",
            command: "read_meta",
            zone: "current",
            args: {
              sessionId,
              path: input.relativePath,
              _routing: routing,
            },
          },
        },
        { mutating: false, approvalObtained: false },
      );
      if (!metaResult.ok) return { ok: false, code: "relay_unavailable" };
      const meta = parseDocumentReadMeta(metaResult.result, sessionId, stat.size);
      if (!meta) return { ok: false, code: "local_target_forbidden" };

      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;
      for (let index = 0; index < meta.chunkCount; index++) {
        const offset = index * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES;
        const expectedBytes = Math.min(
          RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
          meta.totalBytes - offset,
        );
        const chunkResult = await dispatch.localFileDispatch(
          input.relayId,
          {
            allowedRoots: [...input.allowedRoots],
            operation: {
              kind: "document",
              command: "read_chunk",
              zone: "current",
              args: {
                sessionId,
                path: input.relativePath,
                index,
                offset,
                chunkCount: meta.chunkCount,
                _routing: routing,
              },
            },
          },
          { mutating: false, approvalObtained: false },
        );
        if (!chunkResult.ok) return { ok: false, code: "relay_unavailable" };
        const chunk = parseDocumentReadChunk(chunkResult.result, {
          sessionId,
          index,
          chunkCount: meta.chunkCount,
          totalBytes: meta.totalBytes,
          expectedBytes,
        });
        if (!chunk) return { ok: false, code: "local_target_forbidden" };
        chunks.push(chunk);
        receivedBytes += chunk.byteLength;
      }
      if (receivedBytes !== meta.totalBytes) {
        return { ok: false, code: "local_target_forbidden" };
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      if (sha256Hex(bytes) !== meta.sha256) {
        return { ok: false, code: "local_target_forbidden" };
      }
      return { ok: true, bytes, sha256: meta.sha256 };
    }

    const readResult = await dispatch.localFileDispatch(
      input.relayId,
      {
        allowedRoots: [...input.allowedRoots],
        operation: {
          kind: "file",
          command: "read",
          zone: "current",
          args: {
            path: input.relativePath,
            binary: true,
            _routing: routing,
          },
        },
      },
      { mutating: false, approvalObtained: false },
    );
    if (!readResult.ok) {
      return { ok: false, code: "relay_unavailable" };
    }
    const parsed = parseBinaryReadResult(readResult.result, stat.size);
    if (!parsed.ok) {
      return { ok: false, code: "local_target_forbidden" };
    }
    return { ok: true, bytes: parsed.bytes, sha256: sha256Hex(parsed.bytes) };
  };
}

export class LiveLocalDocumentAuthority {
  private readonly canonicalReader: CanonicalLocalDocumentReader;

  constructor(private readonly deps: LiveLocalDocumentAuthorityDeps) {
    this.canonicalReader =
      deps.readCanonical ?? createDefaultCanonicalLocalDocumentReader(deps.localFileDispatch);
  }

  authorizeCanonicalTargetIdentity(input: {
    ownerId: string;
    relayId: string;
    canonicalTargetIdentity: string;
  }): boolean {
    const snapshot = qualifyHintedRelay(
      this.deps.relayRegistry,
      input.relayId,
      input.ownerId,
    );
    return (
      snapshot !== null &&
      isCanonicalIdentityAuthorizedByRoots(
        input.canonicalTargetIdentity,
        snapshot.allowedRoots,
      )
    );
  }

  /**
   * Resolve filesystem identity on one explicitly pinned, authenticated relay.
   * This read-only preflight never falls back to another relay.
   */
  async resolveCanonicalTargetIdentity(input: {
    ownerId: string;
    relayId: string;
    candidatePath: string;
  }): Promise<CanonicalLocalTargetIdentityResult> {
    const snapshot = qualifyHintedRelay(
      this.deps.relayRegistry,
      input.relayId,
      input.ownerId,
    );
    if (!snapshot) return { ok: false, code: "relay_unavailable" };
    const candidatePathApi = pathApiForRelayIdentity(input.candidatePath);
    const candidatePath = candidatePathApi.normalize(input.candidatePath);
    // A Desktop grant names canonical roots; a selected folder may use a
    // filesystem alias (for example /tmp -> /private/tmp on macOS). Resolve
    // through the exact actor-owned relay's filesystem jail before comparing
    // roots. The post-resolution containment check below remains mandatory.
    if (!candidatePathApi.isAbsolute(candidatePath)) {
      return { ok: false, code: "local_target_forbidden" };
    }
    const resolved = await this.deps.localFileDispatch.fsDispatch(
      input.relayId,
      {
        op: "realpath",
        path: candidatePath,
        allowedRoots: [...snapshot.allowedRoots],
      },
      { mutating: false },
    );
    if (!resolved.ok) {
      return resolved.code === "ENOENT"
        ? { ok: false, code: "not_found" }
        : { ok: false, code: "local_target_forbidden" };
    }
    if (resolved.realpath === null) return { ok: false, code: "not_found" };
    const resolvedPathApi =
      typeof resolved.realpath === "string"
        ? pathApiForRelayIdentity(resolved.realpath)
        : null;
    if (
      typeof resolved.realpath !== "string" ||
      resolvedPathApi === null ||
      !resolvedPathApi.isAbsolute(resolved.realpath) ||
      !findRelayIdentityAllowedRoot(resolved.realpath, snapshot.allowedRoots)
    ) {
      return { ok: false, code: "local_target_forbidden" };
    }
    return {
      ok: true,
      canonicalTargetIdentity: resolvedPathApi.normalize(resolved.realpath),
    };
  }

  /**
   * Resolve and read a candidate local path through exactly the hinted,
   * caller-owned desktop relay. This is intentionally read-only: it does not
   * mint a local target id, open a mini-app session, or write a byte.
   */
  async readCanonicalSnapshot(input: {
    ownerId: string;
    relayId: string;
    candidatePath: string;
  }): Promise<CanonicalLocalDocumentSnapshotResult> {
    const snapshot = qualifyHintedRelay(
      this.deps.relayRegistry,
      input.relayId,
      input.ownerId,
    );
    if (!snapshot) return { ok: false, code: "relay_unavailable" };

    const identity = await this.resolveCanonicalTargetIdentity({
      ownerId: input.ownerId,
      relayId: input.relayId,
      candidatePath: input.candidatePath,
    });
    if (!identity.ok) return identity;

    const root = findRelayIdentityAllowedRoot(
      identity.canonicalTargetIdentity,
      snapshot.allowedRoots,
    );
    if (!root) return { ok: false, code: "local_target_forbidden" };
    const pathApi = pathApiForRelayIdentity(identity.canonicalTargetIdentity);
    const relativePath = pathApi.relative(root, identity.canonicalTargetIdentity);
    if (!relativePath || validateLiveCurrentFileRelativePath(relativePath)) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const read = await this.canonicalReader({
      ownerId: input.ownerId,
      relayId: input.relayId,
      allowedRoots: snapshot.allowedRoots,
      currentFolderRoot: root,
      relativePath: normalizeRelPath(relativePath),
      canonicalPath: identity.canonicalTargetIdentity,
    });
    if (!read.ok) {
      return {
        ok: false,
        code:
          read.code === "relay_unavailable"
            ? "relay_unavailable"
            : "local_target_forbidden",
      };
    }
    return {
      ok: true,
      relayId: input.relayId,
      canonicalPath: identity.canonicalTargetIdentity,
      bytes: read.bytes,
      sha256: read.sha256,
    };
  }

  async readCurrentFileCanonical(
    binding: LiveMiniAppSessionCurrentFileBinding,
  ): Promise<
    | { ok: true; content: string; sha256: string }
    | { ok: false; status: "session_closed" | "stale_version" }
  > {
    const snapshot = qualifyHintedRelay(
      this.deps.relayRegistry,
      binding.relayId,
      binding.userId,
    );
    const identity = await this.resolveCanonicalTargetIdentity({
      ownerId: binding.userId,
      relayId: binding.relayId,
      candidatePath: resolveLiveCurrentFileCanonicalPath(
        binding.currentFolderRoot,
        binding.relativePath,
      ),
    });
    if (
      !snapshot ||
      !identity.ok ||
      identity.canonicalTargetIdentity !== binding.canonicalPath ||
      !isPathContainedInAllowedRoots(binding.canonicalPath, snapshot.allowedRoots)
    ) {
      return { ok: false, status: "session_closed" };
    }
    const read = await this.canonicalReader({
      ownerId: binding.userId,
      relayId: binding.relayId,
      allowedRoots: snapshot.allowedRoots,
      currentFolderRoot: binding.currentFolderRoot,
      relativePath: binding.relativePath,
      canonicalPath: binding.canonicalPath,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    if (!read.ok) return { ok: false, status: "session_closed" };
    if (read.sha256 !== binding.documentVersion.sha256) {
      return { ok: false, status: "stale_version" };
    }
    return {
      ok: true,
      content: Buffer.from(read.bytes).toString("utf8"),
      sha256: read.sha256,
    };
  }

  async writeAccepted(
    input: WriteAcceptedLocalDocumentInput,
  ): Promise<WriteAcceptedLocalDocumentResult> {
    const { binding } = input;
    if (
      !input.turnId ||
      !input.agentId ||
      !input.clientMutationId ||
      input.bytes.byteLength === 0 ||
      input.bytes.byteLength > MAX_DOCUMENT_BYTES
    ) {
      return { ok: false, code: "local_target_forbidden" };
    }
    const snapshot = qualifyHintedRelay(
      this.deps.relayRegistry,
      binding.relayId,
      binding.userId,
    );
    if (!snapshot) return { ok: false, code: "relay_unavailable" };
    const identity = await this.resolveCanonicalTargetIdentity({
      ownerId: binding.userId,
      relayId: binding.relayId,
      candidatePath: resolveLiveCurrentFileCanonicalPath(
        binding.currentFolderRoot,
        binding.relativePath,
      ),
    });
    if (
      !identity.ok ||
      identity.canonicalTargetIdentity !== binding.canonicalPath ||
      !isPathContainedInAllowedRoots(binding.canonicalPath, snapshot.allowedRoots)
    ) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const dispatchedSha256 = sha256Hex(input.bytes);
    const mutationRequestId = createFileMutationRequestId(input.turnId, {
      operation: "live-review.accept",
      appId: binding.appId,
      localTargetId: binding.localTargetId,
      expectedSha256: binding.documentVersion.sha256,
      acceptedSha256: dispatchedSha256,
      clientMutationId: input.clientMutationId,
    });
    const routing = localRouting(
      binding.userId,
      binding.currentFolderRoot,
      {
        agentId: input.agentId,
        turnId: input.turnId,
        mutationRequestId,
      },
    );
    if (input.bytes.byteLength <= RELAY_FS_MAX_BYTES) {
      const result = await this.deps.localFileDispatch.localFileDispatch(
        binding.relayId,
        {
          allowedRoots: [...snapshot.allowedRoots],
          operation: {
            kind: "file",
            command: "write",
            zone: "current",
            args: {
              path: binding.relativePath,
              content: Buffer.from(input.bytes).toString("base64"),
              encoding: "base64",
              mode: "overwrite",
              expectedSha256: binding.documentVersion.sha256,
              clientMutationId: input.clientMutationId,
              _routing: routing,
            },
          },
        },
        { mutating: true, approvalObtained: true },
      );
      return parseAppliedWrite(result, dispatchedSha256);
    }

    const sessionId = randomUUID();
    const chunkCount = Math.ceil(
      input.bytes.byteLength / RELAY_LOCAL_DOCUMENT_CHUNK_BYTES,
    );
    const common = {
      sessionId,
      path: binding.relativePath,
      totalBytes: input.bytes.byteLength,
      chunkCount,
      expectedSha256: binding.documentVersion.sha256,
      clientMutationId: input.clientMutationId,
      _routing: routing,
    };
    const dispatchDocument = (command: "write_begin" | "write_chunk" | "write_commit" | "write_abort", args: Record<string, unknown>) =>
      this.deps.localFileDispatch.localFileDispatch(
        binding.relayId,
        {
          allowedRoots: [...snapshot.allowedRoots],
          operation: {
            kind: "document",
            command,
            zone: "current",
            args,
          },
        },
        { mutating: true, approvalObtained: true },
      );
    const abort = async () => {
      await dispatchDocument("write_abort", common).catch(() => undefined);
    };

    const begin = await dispatchDocument("write_begin", common);
    if (!begin.ok) return { ok: false, code: safeDispatchFailureCode(begin) };
    const beginRecord = parseResultRecord(begin.result);
    const beginParsed =
      beginRecord?.["sessionId"] === sessionId &&
      beginRecord["totalBytes"] === input.bytes.byteLength &&
      beginRecord["chunkCount"] === chunkCount
        ? beginRecord as unknown as RelayLocalDocumentWriteBeginResult
        : null;
    if (!beginParsed) {
      await abort();
      return { ok: false, code: safeDispatchFailureCode(begin) };
    }

    let receivedBytes = 0;
    for (let index = 0; index < chunkCount; index++) {
      const offset = index * RELAY_LOCAL_DOCUMENT_CHUNK_BYTES;
      const chunk = input.bytes.subarray(
        offset,
        Math.min(input.bytes.byteLength, offset + RELAY_LOCAL_DOCUMENT_CHUNK_BYTES),
      );
      const result = await dispatchDocument("write_chunk", {
        ...common,
        index,
        offset,
        data: Buffer.from(chunk).toString("base64"),
      });
      if (!result.ok) {
        await abort();
        return { ok: false, code: safeDispatchFailureCode(result) };
      }
      const record = parseResultRecord(result.result);
      const parsed =
        record?.["sessionId"] === sessionId &&
        record["index"] === index &&
        record["receivedBytes"] === receivedBytes + chunk.byteLength
          ? record as unknown as RelayLocalDocumentWriteChunkResult
          : null;
      if (!parsed) {
        await abort();
        return { ok: false, code: safeDispatchFailureCode(result) };
      }
      receivedBytes = parsed.receivedBytes;
    }

    const commit = await dispatchDocument("write_commit", {
      ...common,
      sha256: dispatchedSha256,
    });
    return parseAppliedWrite(commit, dispatchedSha256);
  }

  async resolveCurrentFileIssue(
    input: ResolveCurrentFileLiveSessionInput,
  ): Promise<LiveLocalDocumentAuthorityResult> {
    const parsedVersion = parseLocalShaDocumentVersion(input.documentVersion);
    if (!parsedVersion) {
      return { ok: false, code: "local_target_forbidden" };
    }

    let currentFolder: string;
    try {
      const validatedFolder = validateClientPath(input.currentFolder, "currentFolder");
      if (!validatedFolder) {
        return { ok: false, code: "local_target_forbidden" };
      }
      currentFolder = validatedFolder;
    } catch {
      return { ok: false, code: "local_target_forbidden" };
    }

    const relativeError = validateLiveCurrentFileRelativePath(input.relativePath);
    if (relativeError) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const relativePath = normalizeRelPath(input.relativePath);
    const canonicalPath = resolveLiveCurrentFileCanonicalPath(currentFolder, relativePath);
    if (!isPathContainedInRoot(canonicalPath, currentFolder)) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const relaySnapshot = qualifyHintedRelay(
      this.deps.relayRegistry,
      input.relayIdHint,
      input.userId,
    );
    if (!relaySnapshot) {
      return { ok: false, code: "relay_unavailable" };
    }
    const identity = await this.resolveCanonicalTargetIdentity({
      ownerId: input.userId,
      relayId: input.relayIdHint,
      candidatePath: canonicalPath,
    });
    if (!identity.ok) {
      return {
        ok: false,
        code:
          identity.code === "relay_unavailable"
            ? "relay_unavailable"
            : "local_target_forbidden",
      };
    }

    const read = await this.canonicalReader({
      ownerId: input.userId,
      relayId: input.relayIdHint,
      allowedRoots: relaySnapshot.allowedRoots,
      currentFolderRoot: currentFolder,
      relativePath,
      canonicalPath: identity.canonicalTargetIdentity,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    if (!read.ok) {
      if (read.code === "document_chunk_transport_required") {
        throw new Error(
          "Current Folder Writer live review requires relay document chunk transport for files above the generic 16 MiB local-file read cap.",
        );
      }
      return { ok: false, code: read.code };
    }
    if (read.sha256 !== parsedVersion.sha256) {
      return { ok: false, code: "stale_version" };
    }

    return {
      ok: true,
      binding: {
        targetKind: "currentFile",
        appId: input.appId,
        userId: input.userId,
        localTargetId: randomBytes(32).toString("base64url"),
        relayId: input.relayIdHint,
        canonicalPath: identity.canonicalTargetIdentity,
        currentFolderRoot: currentFolder,
        relativePath,
        documentVersion: parsedVersion,
      },
    };
  }

  async refreshCurrentFileBinding(
    input: RefreshCurrentFileLiveSessionInput,
  ): Promise<LiveLocalDocumentAuthorityResult> {
    const parsedVersion = parseLocalShaDocumentVersion(input.documentVersion);
    if (!parsedVersion) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const existing = input.existing;
    if (
      existing.targetKind !== "currentFile" ||
      existing.appId !== input.appId ||
      existing.userId !== input.userId
    ) {
      return { ok: false, code: "local_target_forbidden" };
    }

    let currentFolder: string;
    try {
      const validatedFolder = validateClientPath(input.currentFolder, "currentFolder");
      if (!validatedFolder) {
        return { ok: false, code: "local_target_forbidden" };
      }
      currentFolder = validatedFolder;
    } catch {
      return { ok: false, code: "local_target_forbidden" };
    }

    const relativeError = validateLiveCurrentFileRelativePath(input.relativePath);
    if (relativeError) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const relativePath = normalizeRelPath(input.relativePath);
    if (
      currentFolder !== existing.currentFolderRoot ||
      relativePath !== existing.relativePath
    ) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const relaySnapshot = qualifyHintedRelay(
      this.deps.relayRegistry,
      existing.relayId,
      input.userId,
    );
    if (!relaySnapshot) {
      return { ok: false, code: "relay_unavailable" };
    }
    const identity = await this.resolveCanonicalTargetIdentity({
      ownerId: input.userId,
      relayId: existing.relayId,
      candidatePath: resolveLiveCurrentFileCanonicalPath(
        existing.currentFolderRoot,
        existing.relativePath,
      ),
    });
    if (!identity.ok || identity.canonicalTargetIdentity !== existing.canonicalPath) {
      return { ok: false, code: "local_target_forbidden" };
    }

    const read = await this.canonicalReader({
      ownerId: input.userId,
      relayId: existing.relayId,
      allowedRoots: relaySnapshot.allowedRoots,
      currentFolderRoot: existing.currentFolderRoot,
      relativePath: existing.relativePath,
      canonicalPath: existing.canonicalPath,
      maxBytes: MAX_DOCUMENT_BYTES,
    });
    if (!read.ok) {
      if (read.code === "document_chunk_transport_required") {
        throw new Error(
          "Current Folder Writer live review requires relay document chunk transport for files above the generic 16 MiB local-file read cap.",
        );
      }
      return { ok: false, code: read.code };
    }
    if (read.sha256 !== parsedVersion.sha256) {
      return { ok: false, code: "stale_version" };
    }

    return {
      ok: true,
      binding: {
        ...existing,
        documentVersion: parsedVersion,
      },
    };
  }
}

export function parseHostLocalShaDocumentVersion(raw: unknown): LocalShaDocumentVersion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const version = parseLocalShaDocumentVersion(raw);
  if (!version) return null;
  const sha256 = parseLocalSha256(version.sha256);
  return sha256 ? { kind: "local_sha", sha256 } : null;
}
