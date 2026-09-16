import { createHash, createHmac } from "node:crypto";

import {
  findReflectionMemorySourceWith,
  findReflectionMessageSourceWith,
  sql,
  type DirectDatabase,
} from "@nautilo/db";
import type { DurableSourceDependency } from "@nautilo/reflection/durable";
import {
  assertCanonicalRecordEmbeddingV1,
  RECORD_SEARCH_POLICY_V1,
} from "@nautilo/reflection/search";
import { CANDIDATE_POLICY_V1 } from "@nautilo/reflection";
import type {
  CanonicalRecordSourceReadPort,
  CanonicalRecordSourceReadResult,
  CrossRoomMemoryCandidate,
  CrossRoomMemoryOpenPort,
  RecordRepositorySelection,
  RoomLocalMemoryCandidate,
  RoomLocalMemoryCandidatePort,
} from "@nautilo/reflection-bridge/server";

import type { CanonicalRoomEvidenceBindingPort } from "./canonical-product-authority";

const MEMORY_SOURCE_KIND = "memory";
const MESSAGE_SOURCE_KIND = "message";
const MEMORY_REF = /^memory:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const MESSAGE_REF = /^message:([1-9][0-9]*)$/u;

export interface OrdinaryMemorySourceRow {
  readonly id: string;
  readonly type: string;
  readonly content: string;
  readonly tier: number;
  readonly contentRevision: number;
  readonly updatedAt: Date;
  readonly updatedAtCoordinate: string;
}

export interface OrdinaryMemoryCandidateRow extends OrdinaryMemorySourceRow {
  readonly score: number;
}

export interface OrdinaryMessageSourceRow {
  readonly id: number;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly content: string;
  readonly editRevision: number;
}

export interface OrdinaryRoomSourceQueryPort {
  searchMemories(input: Readonly<{
    namespaceId: string;
    vector: readonly number[];
    provider: string;
    canonicalModel: string;
    dimensions: number;
    contractVersion: number;
    limit: number;
  }>): Promise<readonly OrdinaryMemoryCandidateRow[]>;
  readMemory(input: Readonly<{
    memoryId: string;
    namespaceId: string;
  }>): Promise<OrdinaryMemorySourceRow | null>;
  readMessage(input: Readonly<{
    messageId: number;
    roomId: string;
    namespaceId: string;
  }>): Promise<OrdinaryMessageSourceRow | null>;
}

export interface OrdinarySourceFingerprintPort {
  memory(row: Pick<OrdinaryMemorySourceRow, "id" | "contentRevision" | "type" | "content">): string;
}

export function createHmacOrdinarySourceFingerprintPort(
  key: Uint8Array,
): OrdinarySourceFingerprintPort {
  if (key.byteLength < 32) {
    throw new TypeError("ordinary source fingerprint key must contain at least 32 bytes");
  }
  const owned = key.slice();
  return Object.freeze({
    memory(row: Pick<OrdinaryMemorySourceRow, "id" | "contentRevision" | "type" | "content">) {
      const hmac = createHmac("sha256", owned);
      for (const value of [
        "nautilo/reflection/ordinary-memory-observation/v1",
        row.id,
        memoryRevision(row) ?? "legacy",
        row.type,
        row.content,
      ]) {
        const bytes = Buffer.from(value, "utf8");
        hmac.update(String(bytes.byteLength), "utf8");
        hmac.update(":", "utf8");
        hmac.update(bytes);
      }
      return `hmac-sha256:${hmac.digest("base64url")}`;
    },
  });
}

function memoryRevision(row: Pick<OrdinaryMemorySourceRow, "contentRevision">): string | undefined {
  return row.contentRevision > 0
    ? String(row.contentRevision)
    : undefined;
}

export function reflectionMessageSourceFingerprint(row: Pick<OrdinaryMessageSourceRow, "id" | "editRevision" | "content">): string {
  const canonical = JSON.stringify([
    "nautilo/stenographer/message-observation/v1",
    row.id,
    row.editRevision,
    row.content,
  ]);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function rowsFromExecute<Row>(result: unknown): readonly Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  return [];
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== 1_536 || vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError("ordinary Memory query embedding is invalid");
  }
  return `[${vector.join(",")}]`;
}

function date(value: Date | string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("ordinary source date is invalid");
  return parsed;
}

export function createDirectDatabaseOrdinaryRoomSourceQueries(
  db: DirectDatabase,
): OrdinaryRoomSourceQueryPort {
  return Object.freeze({
    async searchMemories(
      input: Parameters<OrdinaryRoomSourceQueryPort["searchMemories"]>[0],
    ) {
      const vector = vectorLiteral(input.vector);
      const result = await db.execute<{
        id: string;
        type: string;
        content: string;
        tier: number;
        contentRevision: number;
        updatedAt: Date | string;
        updatedAtCoordinate: string;
        score: number;
      }>(sql`
        SELECT m.id,
               m.type,
               m.content,
               m.tier,
               m.content_revision AS "contentRevision",
               m.updated_at AS "updatedAt",
               to_char(m.updated_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtCoordinate",
               1 - (m.embedding <=> ${vector}::vector) AS score
          FROM memories AS m
          JOIN memory_namespaces AS edge
            ON edge.memory_id = m.id
           AND edge.namespace_id = ${input.namespaceId}::uuid
         WHERE m.tier <= 2
           AND m.embedding IS NOT NULL
           AND m.embedding_revision = m.content_revision
           AND m.embedding_provider = ${input.provider}
           AND m.embedding_model = ${input.canonicalModel}
           AND m.embedding_dimensions = ${input.dimensions}
           AND m.embedding_contract_version = ${input.contractVersion}
         ORDER BY m.embedding <=> ${vector}::vector, m.id
         LIMIT ${input.limit}
      `);
      return rowsFromExecute<{
        id: string;
        type: string;
        content: string | null;
        tier: number;
        contentRevision: number;
        updatedAt: Date | string;
        updatedAtCoordinate: string;
        score: number;
      }>(result).flatMap((row) => row.content === null ? [] : [{
        ...row,
        content: row.content,
        updatedAt: date(row.updatedAt),
      }]);
    },
    async readMemory(
      input: Parameters<OrdinaryRoomSourceQueryPort["readMemory"]>[0],
    ) {
      const row = await findReflectionMemorySourceWith(
        db,
        input.memoryId,
        input.namespaceId,
      );
      if (row === null || row.content === null || row.type === null) return null;
      return { ...row, type: row.type, content: row.content };
    },
    async readMessage(
      input: Parameters<OrdinaryRoomSourceQueryPort["readMessage"]>[0],
    ) {
      const row = await findReflectionMessageSourceWith(
        db,
        input.messageId,
        input.roomId,
        input.namespaceId,
      );
      if (row === null || row.content === null) return null;
      return { ...row, content: row.content };
    },
  });
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Selected-mode source adapter. Protected selection never opens ordinary bytes. */
export class SelectedRoomLocalSourceAdapter
implements RoomLocalMemoryCandidatePort, CanonicalRecordSourceReadPort,
CrossRoomMemoryOpenPort {
  constructor(private readonly ports: Readonly<{
    selection: RecordRepositorySelection;
    bindings: CanonicalRoomEvidenceBindingPort;
    ordinary: OrdinaryRoomSourceQueryPort;
    fingerprints: OrdinarySourceFingerprintPort;
    protectedMemoryCandidates?: RoomLocalMemoryCandidatePort;
    protectedSource?: CanonicalRecordSourceReadPort;
  }>) {}

  async search(input: Parameters<RoomLocalMemoryCandidatePort["search"]>[0]) {
    if (this.ports.selection.selectedRepresentation !== "ordinary") {
      return this.ports.protectedMemoryCandidates?.search(input)
        ?? Promise.resolve({ status: "unavailable" as const });
    }
    if (input.signal?.aborted) return { status: "unavailable" as const };
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > CANDIDATE_POLICY_V1.sameRoomBound
    ) return { status: "unavailable" as const };
    const binding = await this.ports.bindings.resolveRoom(input.roomAnchorRef);
    if (binding === null || binding.roomId !== input.roomAnchorRef) {
      return { status: "unavailable" as const };
    }
    assertCanonicalRecordEmbeddingV1(input.embedding);
    const provenance = input.embedding.provenance;
    const rows = await this.ports.ordinary.searchMemories({
      namespaceId: binding.namespaceId,
      vector: input.embedding.vector,
      provider: provenance.provider,
      canonicalModel: provenance.canonicalModel,
      dimensions: provenance.dimensions,
      contractVersion: provenance.contractVersion,
      limit: input.limit,
    });
    const discovered = rows
      .filter((row) =>
        Number.isFinite(row.score)
        && bytes(row.content) <= RECORD_SEARCH_POLICY_V1.recordStatementMaximumUtf8Bytes
      )
      .slice(0, input.limit);
    const candidates: RoomLocalMemoryCandidate[] = [];
    for (const row of discovered) {
      // The vector query discovers candidates; this exact owner re-open keeps
      // a racing edit/archive/scope change out of the Organizer prompt.
      const current = await this.ports.ordinary.readMemory({
        memoryId: row.id,
        namespaceId: binding.namespaceId,
      });
      if (
        current === null
        || current.tier > 2
        || memoryRevision(current) !== memoryRevision(row)
        || this.ports.fingerprints.memory(current)
          !== this.ports.fingerprints.memory(row)
      ) continue;
      const observedRevision = memoryRevision(row);
      const observedContentFingerprint = this.ports.fingerprints.memory(row);
      const logicalSourceRef = `memory:${row.id}`;
      const dependency: DurableSourceDependency = {
        sourceKind: MEMORY_SOURCE_KIND,
        logicalSourceRef,
        ...(observedRevision === undefined ? {} : { observedRevision }),
        observedContentFingerprint,
        terminalAuthorityLeafHandle: binding.namespaceId,
        authorityBearing: true,
      };
      candidates.push({
        score: row.score,
        snapshot: {
          recordRef: logicalSourceRef,
          observedContentFingerprint,
          posture: "authored",
          anchors: [binding.roomId],
          statement: row.content,
          sourceRefs: [],
          childRecordRefs: [],
          structuralHeight: 0,
          lifecycle: "current",
          sourceOwnedKind: MEMORY_SOURCE_KIND,
          observedLogicalObjectRef: logicalSourceRef,
          ...(observedRevision === undefined ? {} : { observedRevision }),
        },
        dependency,
      });
    }
    return { status: "available" as const, candidates };
  }

  async readExact(
    input: Parameters<CanonicalRecordSourceReadPort["readExact"]>[0],
  ): Promise<CanonicalRecordSourceReadResult> {
    if (this.ports.selection.selectedRepresentation === "protected") {
      return this.ports.protectedSource?.readExact(input)
        ?? Promise.resolve({ status: "unavailable" as const });
    }
    if (input.signal?.aborted) return { status: "unavailable" };
    const binding = await this.ports.bindings.resolve(input.evidenceBindingRef);
    if (
      binding === null
      || input.dependency.terminalAuthorityLeafHandle !== binding.namespaceId
      || !input.dependency.authorityBearing
    ) return { status: "unavailable" };
    if (input.dependency.sourceKind === MEMORY_SOURCE_KIND) {
      return this.#readMemory(input.dependency, binding.namespaceId, input.returnedBytesMaximum);
    }
    if (input.dependency.sourceKind === MESSAGE_SOURCE_KIND) {
      return this.#readMessage(
        input.dependency,
        binding,
        input.returnedBytesMaximum,
      );
    }
    return { status: "unavailable" };
  }

  async open(
    input: Readonly<{
      candidate: CrossRoomMemoryCandidate;
      signal?: AbortSignal;
    }>,
  ): ReturnType<CrossRoomMemoryOpenPort["open"]> {
    if (
      this.ports.selection.selectedRepresentation !== "ordinary"
      || input.signal?.aborted
    ) return { status: "unavailable" };
    const binding = await this.ports.bindings.resolve(
      input.candidate.readBindingRef,
    );
    if (
      binding === null
      || binding.namespaceId !== input.candidate.readNamespaceRef
    ) return { status: "unavailable" };
    const row = await this.ports.ordinary.readMemory({
      memoryId: input.candidate.memoryRef,
      namespaceId: input.candidate.readNamespaceRef,
    });
    if (row === null) return { status: "stale" };
    if (
      row.tier > 2
      || row.contentRevision !== input.candidate.contentRevision
      || row.updatedAtCoordinate !== input.candidate.updatedAtCoordinate
      || bytes(row.content)
        > RECORD_SEARCH_POLICY_V1.recordStatementMaximumUtf8Bytes
    ) return { status: "stale" };
    const observedRevision = memoryRevision(row);
    const observedContentFingerprint = this.ports.fingerprints.memory(row);
    const dependency: DurableSourceDependency = {
      sourceKind: MEMORY_SOURCE_KIND,
      logicalSourceRef: input.candidate.logicalSourceRef,
      ...(observedRevision === undefined ? {} : { observedRevision }),
      observedContentFingerprint,
      terminalAuthorityLeafHandle: binding.namespaceId,
      authorityBearing: true,
    };
    return {
      status: "available",
      dependency,
      snapshot: {
        recordRef: input.candidate.logicalSourceRef,
        observedContentFingerprint,
        posture: "authored",
        anchors: [binding.roomId],
        statement: row.content,
        sourceRefs: [],
        childRecordRefs: [],
        structuralHeight: 0,
        lifecycle: "current",
        sourceOwnedKind: MEMORY_SOURCE_KIND,
        observedLogicalObjectRef: input.candidate.logicalSourceRef,
        ...(observedRevision === undefined ? {} : { observedRevision }),
      },
    };
  }

  async #readMemory(
    dependency: DurableSourceDependency,
    namespaceId: string,
    maximumBytes: number,
  ): Promise<CanonicalRecordSourceReadResult> {
    const match = MEMORY_REF.exec(dependency.logicalSourceRef);
    if (match === null) return { status: "unavailable" };
    const row = await this.ports.ordinary.readMemory({
      memoryId: match[1]!,
      namespaceId,
    });
    if (row === null) return { status: "unavailable" };
    if (
      row.tier > 2
      || dependency.observedRevision !== memoryRevision(row)
      || dependency.observedContentFingerprint !== this.ports.fingerprints.memory(row)
    ) return { status: "changed" };
    if (bytes(row.content) > maximumBytes) return { status: "unavailable" };
    return { status: "available", kind: "memory", content: row.content };
  }

  async #readMessage(
    dependency: DurableSourceDependency,
    binding: Readonly<{ roomId: string; namespaceId: string }>,
    maximumBytes: number,
  ): Promise<CanonicalRecordSourceReadResult> {
    const match = MESSAGE_REF.exec(dependency.logicalSourceRef);
    const messageId = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(messageId)) return { status: "unavailable" };
    const row = await this.ports.ordinary.readMessage({
      messageId,
      roomId: binding.roomId,
      namespaceId: binding.namespaceId,
    });
    if (row === null) return { status: "unavailable" };
    if (
      dependency.observedRevision !== String(row.editRevision)
      || dependency.observedContentFingerprint !== reflectionMessageSourceFingerprint(row)
    ) return { status: "changed" };
    if (bytes(row.content) > maximumBytes) return { status: "unavailable" };
    return { status: "available", kind: "message", content: row.content };
  }
}
