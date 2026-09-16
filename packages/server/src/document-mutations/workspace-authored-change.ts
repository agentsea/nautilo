/** Retained, actor-honest UI recovery. This does not grant mutation authority. */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  lockWorkspaceArtifactForCurrentRoomAuthority,
  listWorkspaceRoomDocumentHistory,
  reduceWorkspaceDocumentHistoryLineage,
  type Artifact,
  type WorkspaceDocumentHistoryRecord,
} from "@nautilo/db";
import { USER_SAVE_TEXT_LIMIT_BYTES } from "@nautilo/agent";
import { isScopeMemoryEnvelope, type MemoryAccessEnvelope } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";

export type WorkspaceAuthoredChange =
  | { kind: "none" }
  | { kind: "unavailable"; code: "history_unavailable" | "document_changed" }
  | {
      kind: "ready";
      operationId: string;
      author: { kind: "agent"; displayName: "Genie" };
      before: { content: string; sha256: string };
      after: { content: string; sha256: string };
      currentSha256: string;
    };

export type WorkspaceAuthoredChangeInput = {
  readonly envelope: MemoryAccessEnvelope;
  readonly sessionUserId: string;
  readonly artifactId: string;
  readonly expectedRevision: number;
  readonly expectedSha256: string;
};

type Scope = {
  readonly humanActorId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly artifactInternalId: string;
};

export type WorkspaceAuthoredChangeDependencies = {
  /** Production re-proves Room/human/agent membership and live attachment. */
  readonly resolveCurrentArtifact?: (scope: Scope) => Promise<Artifact | null>;
  /** Newest first, exact agent/Room/artifact, eligible receipt metadata. */
  readonly listHistory?: (scope: Scope) => Promise<readonly WorkspaceDocumentHistoryRecord[]>;
  readonly readContent?: (storageUri: string, size: number) => Promise<Uint8Array>;
};

const unavailable = (): WorkspaceAuthoredChange => ({ kind: "unavailable", code: "history_unavailable" });
const changed = (): WorkspaceAuthoredChange => ({ kind: "unavailable", code: "document_changed" });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const validSize = (size: number | null): size is number =>
  size !== null && Number.isSafeInteger(size) && size >= 0 && size <= USER_SAVE_TEXT_LIMIT_BYTES;

/** Same text-document boundary as editor saves; never truncate a snapshot. */
async function readExactContent(storageUri: string, size: number): Promise<Uint8Array> {
  // Canonical storage URIs contain raw absolute paths, including literal #/%.
  if (!storageUri.startsWith("file:///")) throw new Error("Unsupported retained storage");
  const handle = await open(storageUri.slice("file://".length), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== size || !validSize(size)) throw new Error("Invalid retained size");
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = await handle.read(bytes, offset, size - offset, offset);
      if (read.bytesRead === 0) throw new Error("Incomplete retained bytes");
      offset += read.bytesRead;
    }
    // Detect growth without allocating/reading beyond the admitted document.
    const tail = await handle.read(Buffer.alloc(1), 0, 1, size);
    if (tail.bytesRead !== 0) throw new Error("Retained bytes changed");
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Return one newest active authored change, never a history dump. Later human
 * autosaves are not Genie authorship: the UI rebases its semantic inverse over
 * the independently verified current head and fences overlapping human work.
 */
export async function readWorkspaceAuthoredChange(
  input: WorkspaceAuthoredChangeInput,
  dependencies: WorkspaceAuthoredChangeDependencies = {},
): Promise<WorkspaceAuthoredChange> {
  const env = input.envelope;
  if (isScopeMemoryEnvelope(env) || !input.sessionUserId || !env.actorId ||
      !env.agentId || !env.roomId || !input.artifactId ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !/^[a-f0-9]{64}$/.test(input.expectedSha256)) return unavailable();
  if (!dependencies.resolveCurrentArtifact) {
    // Hold the canonical Room/member/attachment/artifact locks through the
    // complete read, just as mutation admission does. Repeating a sequence of
    // unlocked membership lookups would still permit a torn authorization
    // proof. The injected resolver below is only for this transaction/tests.
    try {
      return await getServerDirectDb().transaction((tx) => readWorkspaceAuthoredChange(input, {
        ...dependencies,
        listHistory: dependencies.listHistory ?? ((scope) => listWorkspaceRoomDocumentHistory(tx, scope)),
        resolveCurrentArtifact: (scope) => lockWorkspaceArtifactForCurrentRoomAuthority({
          internalId: scope.artifactInternalId, humanActorId: scope.humanActorId,
          agentId: scope.agentId, roomId: scope.roomId,
        }, tx),
      }));
    } catch { return unavailable(); }
  }
  const scope: Scope = {
    humanActorId: env.actorId, agentId: env.agentId,
    roomId: env.roomId, artifactInternalId: input.artifactId,
  };
  const resolve = dependencies.resolveCurrentArtifact;
  const list = dependencies.listHistory ?? ((s: Scope) => listWorkspaceRoomDocumentHistory(getServerDirectDb(), s));
  const read = dependencies.readContent ?? readExactContent;
  try {
    const admitted = await resolve(scope);
    if (!admitted || admitted.id !== input.artifactId || admitted.deletedAt) return unavailable();
    const current = { ...admitted };
    if (current.revision !== input.expectedRevision) return changed();
    if (!validSize(current.size)) return unavailable();
    const head = await read(current.storageUri, current.size);
    if (head.byteLength !== current.size || sha256(head) !== input.expectedSha256) return changed();

    const records = await list(scope);
    // Defense in depth: even an incorrectly widened query cannot disclose a
    // receipt from another Room, agent, or artifact through this service.
    // A receipt is Room-visible; the original owner's identity must not exclude
    // another currently authorized human in the same Room.
    const scoped = records.filter(({ mutation: m, entry: e }) =>
      m.agentId === scope.agentId && m.roomId === scope.roomId &&
      e.artifactInternalId === current.id && e.historyEligible);
    const lineage = reduceWorkspaceDocumentHistoryLineage([...scoped].reverse());
    if (lineage.kind === "broken") return unavailable();
    const candidate = [...lineage.undo].reverse().find(({ mutation }) => mutation.actorKind === "agent");
    let result: WorkspaceAuthoredChange = { kind: "none" };
    if (candidate) {
      const { mutation: m, entry: e } = candidate;
      if (m.actorId !== scope.agentId || !m.operationId.trim() || e.mutationKind !== "update" ||
          e.beforeLogicalPath !== current.path || e.afterLogicalPath !== current.path ||
          e.beforeRevision === null || e.afterRevision === null ||
          e.beforeRevision >= e.afterRevision || e.afterRevision > current.revision ||
          !e.beforeStorageUri || !e.afterStorageUri ||
          !validSize(e.beforeSize) || !validSize(e.afterSize) ||
          !e.beforeSha256 || !e.afterSha256) return unavailable();
      const [beforeBytes, afterBytes] = await Promise.all([
        read(e.beforeStorageUri, e.beforeSize), read(e.afterStorageUri, e.afterSize),
      ]);
      if (beforeBytes.byteLength !== e.beforeSize || afterBytes.byteLength !== e.afterSize ||
          sha256(beforeBytes) !== e.beforeSha256 || sha256(afterBytes) !== e.afterSha256) return unavailable();
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      result = {
        kind: "ready", operationId: m.operationId, author: { kind: "agent", displayName: "Genie" },
        before: { content: decoder.decode(beforeBytes), sha256: e.beforeSha256 },
        after: { content: decoder.decode(afterBytes), sha256: e.afterSha256 },
        currentSha256: input.expectedSha256,
      };
    }
    // Membership, attachment and version can change while history/blobs load.
    // Rebuild authority, reread bytes, then re-prove authority/version before
    // disclosure. No namespace snapshot from the opening request is reused.
    const refreshed = await resolve(scope);
    if (!refreshed || refreshed.deletedAt || refreshed.id !== input.artifactId) return unavailable();
    const latest = { ...refreshed };
    if (latest.revision !== current.revision || latest.path !== current.path ||
        latest.storageUri !== current.storageUri || latest.size !== current.size) return changed();
    const latestBytes = await read(latest.storageUri, latest.size);
    if (latestBytes.byteLength !== latest.size || sha256(latestBytes) !== input.expectedSha256) return changed();
    const final = await resolve(scope);
    if (!final || final.deletedAt || final.id !== input.artifactId) return unavailable();
    if (final.revision !== latest.revision || final.path !== latest.path ||
        final.storageUri !== latest.storageUri || final.size !== latest.size) return changed();
    return result;
  } catch {
    // Missing/pruned/corrupt receipts and revoked access never reveal storage
    // paths, private snippets, or historical identities through errors.
    return unavailable();
  }
}
