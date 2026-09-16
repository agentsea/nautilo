import type {
  ProtectedArtifactDtoV1,
  ProtectedArtifactListResponseV1,
  ProtectedArtifactUnavailableResponseV1,
} from "@nautilo/api-client";
import {
  and,
  artifactNamespaces,
  artifacts,
  asc,
  eq,
  isNotNull,
  sql,
} from "@nautilo/db";
import { ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES } from "@nautilo/lattice-crypto";
import { encodeArtifactBlobChunkFrameV1 } from "@nautilo/lattice-crypto/wire";

import {
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactCryptoRevisionReference,
} from "../../artifact/artifact-repository.ts";
import type {
  EncryptedArtifactBlobReferenceV1,
  EncryptedArtifactBlobStoreV1,
} from "../../artifact/filesystem-blob-store.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";
import type {
  PostgresHumanArtifactCryptoCompletion,
  VerifiedHumanArtifactCryptoRevisionContent,
} from "./postgres-human-artifact-crypto-completion.ts";
import type { HumanArtifactCiphertextRange } from "./human-artifact-route-ports.ts";
import type { HumanArtifactRouteAuthority } from "./postgres-human-artifact-product-route.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MIME_CLASSES = Object.freeze([
  "text", "image", "audio", "video", "document", "archive", "binary",
] as const);
const SIZE_BUCKETS = Object.freeze([
  "empty", "le_64_kib", "le_1_mib", "le_10_mib", "le_100_mib",
] as const);

type ProductSnapshot = Readonly<{
  artifactRowId: string;
  artifactId: string;
  artifactRevision: number;
  cryptoObjectId: string;
  cryptoAccessRevision: number;
  requiredNamespaceFingerprint: Uint8Array;
  requiredNamespaceIds: readonly string[];
  blobId: string;
  blobGeneration: number;
  ciphertextLength: number;
  ciphertextSha256: Uint8Array;
  mimeClass: ProtectedArtifactDtoV1["mimeClass"];
  sizeBucket: ProtectedArtifactDtoV1["sizeBucket"];
  lifecycleState: "active" | "archived" | "quarantined";
}>;

function unavailable(
  reason: ProtectedArtifactUnavailableResponseV1["reason"],
): ProtectedArtifactUnavailableResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

function text(row: ConversationProductDatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  return value;
}

function counter(row: ConversationProductDatabaseRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
  return value as number;
}

function bytes(row: ConversationProductDatabaseRow, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(`${field} must be a 32-byte digest`);
  }
  return value.slice();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function loadSnapshot(
  transaction: ConversationProductPostgresTransaction,
  artifactId: string,
): Promise<ProductSnapshot | null> {
  const rows = await executeTypedConversationProductQuery(
    transaction,
    conversationProductTypedDb.select({
      artifact_row_id: sql`${artifacts.id}`.as("artifact_row_id"),
      artifact_id: artifacts.artifactId,
      revision: artifacts.revision,
      crypto_object_id: artifacts.cryptoObjectId,
      crypto_access_revision: artifacts.cryptoAccessRevision,
      crypto_required_namespace_fingerprint:
        artifacts.cryptoRequiredNamespaceFingerprint,
      blob_id: artifacts.blobId,
      blob_generation: artifacts.blobGeneration,
      ciphertext_length: artifacts.ciphertextLength,
      ciphertext_sha256: artifacts.ciphertextSha256,
      mime_class: artifacts.mimeClass,
      size_bucket: artifacts.sizeBucket,
      crypto_lifecycle_state: artifacts.cryptoLifecycleState,
    }).from(artifacts).where(and(
      eq(artifacts.artifactId, artifactId),
      isNotNull(artifacts.cryptoObjectId),
    )).limit(2),
  );
  if (rows.length > 1) throw new Error("Protected Artifact identity is not unique");
  const row = rows[0];
  if (row === undefined) return null;
  const namespaceRows = await executeTypedConversationProductQuery(
    transaction,
    conversationProductTypedDb.select({
      namespace_id: artifactNamespaces.namespaceId,
    }).from(artifactNamespaces).where(eq(
      artifactNamespaces.artifactId,
      text(row, "artifact_row_id"),
    )).orderBy(asc(artifactNamespaces.namespaceId)).limit(257),
  );
  const requiredNamespaceIds = namespaceRows.map((entry) =>
    text(entry, "namespace_id")
  );
  if (
    requiredNamespaceIds.length < 1
    || requiredNamespaceIds.length > 256
    || requiredNamespaceIds.some((id, index) =>
      !UUID.test(id) || (index > 0 && requiredNamespaceIds[index - 1]! >= id)
    )
  ) throw new Error("Protected Artifact audience is invalid");
  const artifactRevision = counter(row, "revision");
  const cryptoObjectId = text(row, "crypto_object_id");
  const fingerprint = bytes(row, "crypto_required_namespace_fingerprint");
  const actualFingerprint = fingerprintRequiredArtifactNamespaces(
    requiredNamespaceIds,
  );
  if (
    cryptoObjectId !== deriveArtifactControlObjectIdV1({ artifactId, artifactRevision })
    || !sameBytes(fingerprint, actualFingerprint)
  ) throw new Error("Protected Artifact product mapping is corrupt");
  const lifecycleState = text(row, "crypto_lifecycle_state");
  if (!(["active", "archived", "quarantined"] as const).includes(
    lifecycleState as ProductSnapshot["lifecycleState"],
  )) throw new Error("Protected Artifact lifecycle is invalid");
  const mimeClass = text(row, "mime_class");
  const sizeBucket = text(row, "size_bucket");
  if (!MIME_CLASSES.includes(mimeClass as ProductSnapshot["mimeClass"])) {
    throw new Error("Protected Artifact MIME class is invalid");
  }
  if (!SIZE_BUCKETS.includes(sizeBucket as ProductSnapshot["sizeBucket"])) {
    throw new Error("Protected Artifact size bucket is invalid");
  }
  return Object.freeze({
    artifactRowId: text(row, "artifact_row_id"),
    artifactId: text(row, "artifact_id"),
    artifactRevision,
    cryptoObjectId,
    cryptoAccessRevision: counter(row, "crypto_access_revision"),
    requiredNamespaceFingerprint: fingerprint,
    requiredNamespaceIds: Object.freeze(requiredNamespaceIds),
    blobId: text(row, "blob_id"),
    blobGeneration: counter(row, "blob_generation"),
    ciphertextLength: counter(row, "ciphertext_length"),
    ciphertextSha256: bytes(row, "ciphertext_sha256"),
    mimeClass: mimeClass as ProductSnapshot["mimeClass"],
    sizeBucket: sizeBucket as ProductSnapshot["sizeBucket"],
    lifecycleState: lifecycleState as ProductSnapshot["lifecycleState"],
  });
}

function sameSnapshot(left: ProductSnapshot, right: ProductSnapshot): boolean {
  return left.artifactRowId === right.artifactRowId
    && left.artifactId === right.artifactId
    && left.artifactRevision === right.artifactRevision
    && left.cryptoObjectId === right.cryptoObjectId
    && left.cryptoAccessRevision === right.cryptoAccessRevision
    && left.blobId === right.blobId
    && left.blobGeneration === right.blobGeneration
    && left.ciphertextLength === right.ciphertextLength
    && left.mimeClass === right.mimeClass
    && left.sizeBucket === right.sizeBucket
    && sameBytes(left.ciphertextSha256, right.ciphertextSha256)
    && sameBytes(
      left.requiredNamespaceFingerprint,
      right.requiredNamespaceFingerprint,
    )
    && left.requiredNamespaceIds.length === right.requiredNamespaceIds.length
    && left.requiredNamespaceIds.every((id, index) =>
      id === right.requiredNamespaceIds[index]
    )
    && left.lifecycleState === right.lifecycleState;
}

function wipeContent(content: VerifiedHumanArtifactCryptoRevisionContent): void {
  content.encryptedControlPayloadBytes.fill(0);
  content.accessManifestBytes.fill(0);
  content.accessManifestProofBytes.forEach((value) => value.fill(0));
  content.accessSignerEvidence.forEach(({ evidenceBytes }) =>
    evidenceBytes.fill(0)
  );
  content.namespaceEnvelopes.forEach(({ envelopeBytes }) => envelopeBytes.fill(0));
  content.verified.requiredNamespaceFingerprint.fill(0);
}

function toDto(
  snapshot: ProductSnapshot,
  content: VerifiedHumanArtifactCryptoRevisionContent,
  blob: EncryptedArtifactBlobReferenceV1,
  authority: HumanArtifactRouteAuthority,
): ProtectedArtifactDtoV1 {
  return Object.freeze({
    dtoVersion: 1,
    status: "encrypted",
    artifactId: snapshot.artifactId,
    artifactRevision: snapshot.artifactRevision,
    cryptoObjectId: snapshot.cryptoObjectId,
    cryptoAccessRevision: snapshot.cryptoAccessRevision,
    requiredNamespaceIds: [...snapshot.requiredNamespaceIds],
    encryptedControlPayloadBytesBase64url: Buffer.from(
      content.encryptedControlPayloadBytes,
    ).toString("base64url"),
    accessManifestBytesBase64url: Buffer.from(
      content.accessManifestBytes,
    ).toString("base64url"),
    accessManifestProofBytesBase64url: content.accessManifestProofBytes.map(
      (value) => Buffer.from(value).toString("base64url"),
    ),
    accessSignerEvidence: content.accessSignerEvidence.map((entry) => ({
      kind: entry.kind,
      evidenceBytesBase64url: Buffer.from(entry.evidenceBytes).toString("base64url"),
    })),
    namespaceEnvelopes: content.namespaceEnvelopes.map((entry) => ({
      namespaceId: entry.namespaceId,
      envelopeBytesBase64url: Buffer.from(entry.envelopeBytes).toString("base64url"),
    })),
    blobId: snapshot.blobId,
    blobGeneration: snapshot.blobGeneration,
    ciphertextLength: snapshot.ciphertextLength,
    ciphertextSha256Base64url: Buffer.from(snapshot.ciphertextSha256).toString("base64url"),
    chunkPlaintextBytes: blob.chunkPlaintextBytes,
    chunkCount: blob.chunkCount,
    mimeClass: snapshot.mimeClass,
    sizeBucket: snapshot.sizeBucket,
    archived: snapshot.lifecycleState === "archived",
    canManageAccess: snapshot.requiredNamespaceIds.some((id) =>
      authority.mutableNamespaceIds.includes(id)
    ),
  });
}

export class PostgresHumanArtifactProtectedProductRoute {
  readonly #handle: ConversationProductPostgresHandle;
  readonly #crypto: Pick<PostgresHumanArtifactCryptoCompletion, "read">;
  readonly #blobs: Pick<
    EncryptedArtifactBlobStoreV1,
    "inspectStored" | "readCiphertextRange"
  >;

  constructor(input: Readonly<{
    handle: ConversationProductPostgresHandle;
    crypto: Pick<PostgresHumanArtifactCryptoCompletion, "read">;
    blobs: Pick<
      EncryptedArtifactBlobStoreV1,
      "inspectStored" | "readCiphertextRange"
    >;
  }>) {
    assertVerifiedConversationProductPostgresHandle(input.handle);
    if (input.handle.role !== "nautilo") {
      throw new TypeError("Protected Artifact reads require a direct nautilo handle");
    }
    this.#handle = input.handle;
    this.#crypto = input.crypto;
    this.#blobs = input.blobs;
  }

  async detail(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    artifactId: string;
  }>): Promise<ProtectedArtifactDtoV1 | ProtectedArtifactUnavailableResponseV1> {
    if (input.authority.agentId !== null || !UUID.test(input.artifactId)) {
      return unavailable("authorization_required");
    }
    const before = await this.#handle.transaction(
      (transaction) => loadSnapshot(transaction, input.artifactId),
      { isolationLevel: "serializable" },
    );
    if (before === null || before.lifecycleState === "quarantined") {
      return unavailable("stale_revision");
    }
    if (!before.requiredNamespaceIds.some((id) =>
      input.authority.readableNamespaceIds.includes(id)
    )) return unavailable("authorization_required");
    const reference: ArtifactCryptoRevisionReference = Object.freeze({
      artifactId: before.artifactId,
      artifactRevision: before.artifactRevision,
      objectId: before.cryptoObjectId,
      expectedAccessRevision: before.cryptoAccessRevision,
      expectedRequiredNamespaceFingerprint:
        before.requiredNamespaceFingerprint.slice(),
    });
    const [content, inspected] = await Promise.all([
      this.#crypto.read(reference),
      this.#blobs.inspectStored({
        artifactId: before.artifactId,
        blobId: before.blobId,
        blobGeneration: before.blobGeneration,
        ciphertextLength: before.ciphertextLength,
        ciphertextSha256: before.ciphertextSha256,
      }),
    ]);
    reference.expectedRequiredNamespaceFingerprint.fill(0);
    if (content === null) return unavailable("encryption_pending");
    if (inspected.status === "missing") {
      wipeContent(content);
      return unavailable("storage_unavailable");
    }
    if (inspected.status === "mismatch") {
      wipeContent(content);
      return unavailable("integrity_failure");
    }
    try {
      const after = await this.#handle.transaction(
        (transaction) => loadSnapshot(transaction, input.artifactId),
        { isolationLevel: "serializable" },
      );
      if (after === null || !sameSnapshot(before, after)) {
        return unavailable("stale_revision");
      }
      return toDto(after, content, inspected.reference, input.authority);
    } finally {
      wipeContent(content);
    }
  }

  async ciphertextRange(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    artifactId: string;
    start: number;
    endExclusive: number;
  }>): Promise<HumanArtifactCiphertextRange | ProtectedArtifactUnavailableResponseV1> {
    if (
      input.authority.agentId !== null
      || !UUID.test(input.artifactId)
      || !Number.isSafeInteger(input.start)
      || !Number.isSafeInteger(input.endExclusive)
      || input.start < 0
      || input.endExclusive < input.start
      || input.endExclusive - input.start > ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES
    ) return unavailable("authorization_required");
    const before = await this.#handle.transaction(
      (transaction) => loadSnapshot(transaction, input.artifactId),
      { isolationLevel: "serializable" },
    );
    if (
      before === null
      || before.lifecycleState === "quarantined"
      || input.endExclusive > Number.MAX_SAFE_INTEGER
      || !before.requiredNamespaceIds.some((id) =>
        input.authority.readableNamespaceIds.includes(id)
      )
    ) return unavailable("authorization_required");
    const inspected = await this.#blobs.inspectStored({
      artifactId: before.artifactId,
      blobId: before.blobId,
      blobGeneration: before.blobGeneration,
      ciphertextLength: before.ciphertextLength,
      ciphertextSha256: before.ciphertextSha256,
    });
    if (inspected.status === "missing") return unavailable("storage_unavailable");
    if (inspected.status === "mismatch") return unavailable("integrity_failure");
    if (input.endExclusive > inspected.reference.plaintextLength) {
      return unavailable("stale_revision");
    }
    const read = await this.#blobs.readCiphertextRange({
      reference: inspected.reference,
      start: input.start,
      endExclusive: input.endExclusive,
      consume: ({ firstChunkIndex, sealedChunks }) => {
        const frames = sealedChunks.map((chunk) =>
          encodeArtifactBlobChunkFrameV1(chunk)
        );
        try {
          const length = frames.reduce((total, frame) => total + frame.length, 0);
          const body = new Uint8Array(length);
          let offset = 0;
          for (const frame of frames) {
            body.set(frame, offset);
            offset += frame.length;
          }
          return Object.freeze({ body, firstChunkIndex,
            returnedChunkCount: frames.length });
        } finally {
          frames.forEach((frame) => frame.fill(0));
        }
      },
    });
    if (read.status === "unavailable") {
      return unavailable(read.reason === "missing"
        ? "storage_unavailable" : "integrity_failure");
    }
    const after = await this.#handle.transaction(
      (transaction) => loadSnapshot(transaction, input.artifactId),
      { isolationLevel: "serializable" },
    );
    if (after === null || !sameSnapshot(before, after)) {
      read.value.body.fill(0);
      return unavailable("stale_revision");
    }
    return Object.freeze({
      status: "encrypted_chunks" as const,
      artifactId: after.artifactId,
      artifactRevision: after.artifactRevision,
      cryptoAccessRevision: after.cryptoAccessRevision,
      blobId: after.blobId,
      blobGeneration: after.blobGeneration,
      plaintextLength: inspected.reference.plaintextLength,
      ciphertextLength: after.ciphertextLength,
      ciphertextSha256: after.ciphertextSha256.slice(),
      chunkPlaintextBytes: inspected.reference.chunkPlaintextBytes,
      chunkCount: inspected.reference.chunkCount,
      firstChunkIndex: read.value.firstChunkIndex,
      returnedChunkCount: read.value.returnedChunkCount,
      body: read.value.body,
    });
  }

  async list(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    cursor?: string;
    limit?: number;
    includeArchive?: boolean;
  }>): Promise<ProtectedArtifactListResponseV1 | ProtectedArtifactUnavailableResponseV1> {
    if (input.authority.agentId !== null) return unavailable("authorization_required");
    if (input.cursor !== undefined && !UUID.test(input.cursor)) {
      throw new TypeError("Protected Artifact list cursor is invalid");
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Protected Artifact list limit is invalid");
    }
    const rows = await this.#handle.transaction((transaction) => transaction.query(
      `SELECT DISTINCT a.artifact_id
         FROM artifacts a
         JOIN artifact_namespaces n ON n.artifact_id = a.id
        WHERE a.crypto_object_id IS NOT NULL
          AND n.namespace_id::text IN (
            SELECT value FROM jsonb_array_elements_text($1::jsonb)
          )
          AND ($2::boolean OR a.crypto_lifecycle_state = 'active')
          AND ($3::text IS NULL OR a.artifact_id > $3)
        ORDER BY a.artifact_id ASC LIMIT $4`,
      [JSON.stringify(input.authority.readableNamespaceIds), input.includeArchive === true,
        input.cursor ?? null, limit + 1],
    ), { isolationLevel: "serializable" });
    const ids = rows.map((row) => text(row, "artifact_id"));
    const page = ids.slice(0, limit);
    const items: ProtectedArtifactDtoV1[] = [];
    for (const artifactId of page) {
      const detail = await this.detail({ authority: input.authority, artifactId });
      if (detail.status === "unavailable") return detail;
      items.push(detail);
    }
    return Object.freeze({
      dtoVersion: 1,
      items,
      nextCursor: ids.length > limit ? page.at(-1)! : null,
    });
  }
}
