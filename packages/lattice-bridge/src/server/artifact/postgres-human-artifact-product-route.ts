import type {
  ProtectedArtifactPublicationPlanRequestV1,
  ProtectedArtifactPublicationPlanResponseV1,
} from "@nautilo/api-client";
import {
  ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
  ARTIFACT_BLOB_MAX_FILE_BYTES,
  ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES,
} from "@nautilo/lattice-crypto";

import {
  artifactPublicationReservationDigest,
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactPublicationReservationInput,
} from "../../artifact/artifact-repository.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
} from "../message/postgres-conversation-product-store.ts";
import { PostgresArtifactProductPublication } from "./postgres-artifact-product-publication.ts";
import { artifactNamespaces, asc, eq } from "@nautilo/db";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PLAN_TTL_MS = 30_000;

export type HumanArtifactRouteAuthority = Readonly<{
  userId: string;
  subjectHumanId: string;
  actorId: string;
  agentId: null;
  readableNamespaceIds: readonly string[];
  mutableNamespaceIds: readonly string[];
  writableNamespaceIds: readonly string[];
}>;

export type HumanArtifactPublicationBindingFact = Readonly<{
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  bindingHash: Uint8Array;
}>;

export type ResolveHumanArtifactPublicationBindings = (input: Readonly<{
  subjectHumanId: string;
  namespaceIds: readonly string[];
}>) => Promise<readonly HumanArtifactPublicationBindingFact[] | null>;

type ProductSnapshot = Readonly<{
  artifactRowId: string;
  artifactId: string;
  artifactRevision: number;
  cryptoAccessRevision: number;
  blobId: string;
  blobGeneration: number;
  requiredNamespaceFingerprint: Uint8Array;
  requiredNamespaceIds: readonly string[];
  lifecycleState: "active" | "archived" | "quarantined";
}>;

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

function canonicalIds(label: string, values: readonly string[]): readonly string[] {
  if (
    values.length > 256
    || values.some((value) => !UUID.test(value))
    || values.some((value, index) => index > 0 && values[index - 1]! >= value)
  ) throw new TypeError(`${label} must be a canonical bounded Namespace set`);
  return Object.freeze([...values]);
}

function unavailable(
  reason: "authorization_required" | "target_encryption_not_ready" | "stale_revision",
): ProtectedArtifactPublicationPlanResponseV1 {
  return Object.freeze({ dtoVersion: 1, status: "unavailable", reason });
}

async function loadSnapshot(
  handle: ConversationProductPostgresHandle,
  artifactId: string,
): Promise<ProductSnapshot | null> {
  return handle.transaction(async (transaction) => {
    const rows = await transaction.query(
      `SELECT id::text AS artifact_row_id, artifact_id, revision,
              crypto_access_revision, blob_id, blob_generation,
              crypto_required_namespace_fingerprint,
              crypto_lifecycle_state
         FROM artifacts
        WHERE artifact_id = $1 AND crypto_object_id IS NOT NULL
        LIMIT 2 FOR UPDATE`,
      [artifactId],
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
    const requiredNamespaceIds = canonicalIds(
      "Protected Artifact audience",
      namespaceRows.map((entry) => text(entry, "namespace_id")),
    );
    if (requiredNamespaceIds.length === 0) {
      throw new Error("Protected Artifact has no Namespace attachment");
    }
    const fingerprint = bytes(row, "crypto_required_namespace_fingerprint");
    const actual = fingerprintRequiredArtifactNamespaces(requiredNamespaceIds);
    if (!actual.every((byte, index) => byte === fingerprint[index])) {
      throw new Error("Protected Artifact Namespace fingerprint disagrees");
    }
    return Object.freeze({
      artifactRowId: text(row, "artifact_row_id"),
      artifactId: text(row, "artifact_id"),
      artifactRevision: counter(row, "revision"),
      cryptoAccessRevision: counter(row, "crypto_access_revision"),
      blobId: text(row, "blob_id"),
      blobGeneration: counter(row, "blob_generation"),
      requiredNamespaceFingerprint: fingerprint,
      requiredNamespaceIds,
      lifecycleState: text(row, "crypto_lifecycle_state") as ProductSnapshot["lifecycleState"],
    });
  }, { isolationLevel: "serializable" });
}

export class PostgresHumanArtifactProductRoute {
  readonly #handle: ConversationProductPostgresHandle;
  readonly #publication: PostgresArtifactProductPublication;
  readonly #createUuid: () => string;
  readonly #now: () => number;
  readonly #resolveBindings: ResolveHumanArtifactPublicationBindings;

  constructor(input: Readonly<{
    handle: ConversationProductPostgresHandle;
    createUuid: () => string;
    now: () => number;
    resolveBindings: ResolveHumanArtifactPublicationBindings;
  }>) {
    assertVerifiedConversationProductPostgresHandle(input.handle);
    if (input.handle.role !== "nautilo") {
      throw new TypeError("Human Artifact planning requires a direct nautilo handle");
    }
    this.#handle = input.handle;
    this.#publication = new PostgresArtifactProductPublication(input.handle);
    this.#createUuid = input.createUuid;
    this.#now = input.now;
    this.#resolveBindings = input.resolveBindings;
  }

  async plan(input: Readonly<{
    authority: HumanArtifactRouteAuthority;
    request: ProtectedArtifactPublicationPlanRequestV1;
  }>): Promise<ProtectedArtifactPublicationPlanResponseV1> {
    const readable = canonicalIds("Readable authority", input.authority.readableNamespaceIds);
    const mutable = canonicalIds("Mutable authority", input.authority.mutableNamespaceIds);
    const writable = canonicalIds("Writable authority", input.authority.writableNamespaceIds);
    if (
      input.authority.agentId !== null
      || !writable.includes(input.request.anchorNamespaceId)
    ) return unavailable("authorization_required");
    const create = input.request.operation === "create";
    const current = create || input.request.artifactId === null
      ? null
      : await loadSnapshot(this.#handle, input.request.artifactId);
    if (
      create
        ? input.request.artifactId !== null
        : current === null
          || current.lifecycleState !== "active"
          || !readable.some((id) => current.requiredNamespaceIds.includes(id))
          || !mutable.includes(input.request.anchorNamespaceId)
          || !current.requiredNamespaceIds.includes(input.request.anchorNamespaceId)
          || input.request.expectedArtifactRevision !== current.artifactRevision
          || input.request.expectedCryptoAccessRevision !== current.cryptoAccessRevision
          || input.request.expectedBlobGeneration !== current.blobGeneration
          || input.request.expectedBlobId !== current.blobId
    ) return unavailable(current === null ? "stale_revision" : "authorization_required");
    const requiredNamespaceIds = create
      ? Object.freeze([input.request.anchorNamespaceId])
      : current!.requiredNamespaceIds;
    const bindings = await this.#resolveBindings({
      subjectHumanId: input.authority.subjectHumanId,
      namespaceIds: requiredNamespaceIds,
    });
    if (
      bindings === null
      || bindings.length !== requiredNamespaceIds.length
      || bindings.some((binding, index) =>
        binding.namespaceId !== requiredNamespaceIds[index]
        || !(binding.bindingHash instanceof Uint8Array)
        || binding.bindingHash.length !== 32
      )
    ) return unavailable("target_encryption_not_ready");
    const artifactRowId = create ? this.#createUuid() : current!.artifactRowId;
    const artifactId = create ? this.#createUuid() : current!.artifactId;
    const resultBlobId = input.request.operation === "revise_control"
      ? current!.blobId : this.#createUuid();
    const operationId = `artifact-publication:${this.#createUuid()}`;
    if (
      !UUID.test(artifactRowId)
      || !UUID.test(artifactId)
      || !UUID.test(resultBlobId)
      || !operationId.startsWith("artifact-publication:")
    ) throw new TypeError("Artifact plan ID factory returned a noncanonical UUID");
    const expectedFingerprint = create
      ? null : current!.requiredNamespaceFingerprint.slice();
    const targetFingerprint = fingerprintRequiredArtifactNamespaces(
      requiredNamespaceIds,
    );
    const operationType = input.request.operation === "create"
      ? "create" : input.request.operation === "replace_content" ? "content" : "control";
    const reservationWithoutDigest = Object.freeze({
      operationId,
      artifactRowId,
      artifactId,
      anchorNamespaceId: input.request.anchorNamespaceId,
      operationType,
      expectedArtifactRevision: input.request.expectedArtifactRevision,
      resultArtifactRevision: input.request.expectedArtifactRevision + 1,
      expectedAccessRevision: input.request.expectedCryptoAccessRevision,
      resultAccessRevision: 0 as const,
      expectedBlobGeneration: input.request.expectedBlobGeneration,
      resultBlobGeneration: operationType === "control"
        ? input.request.expectedBlobGeneration
        : input.request.expectedBlobGeneration + 1,
      expectedBlobId: input.request.expectedBlobId,
      resultBlobId,
      expectedRequiredNamespaceFingerprint: expectedFingerprint,
      targetRequiredNamespaceFingerprint: targetFingerprint,
    });
    const planDigest = artifactPublicationReservationDigest(
      reservationWithoutDigest,
    );
    const reservation: ArtifactPublicationReservationInput = Object.freeze({
      ...reservationWithoutDigest,
      planDigest,
    });
    const reserved = await this.#publication.reservePlan(reservation);
    if (reserved.status === "conflict") return unavailable("stale_revision");
    const deadlineAt = this.#now() + PLAN_TTL_MS;
    return Object.freeze({
      dtoVersion: 1,
      status: "planned",
      planVersion: 1,
      operationId,
      planDigestBase64url: Buffer.from(planDigest).toString("base64url"),
      operation: input.request.operation,
      lifecycleAction: input.request.lifecycleAction,
      artifactRowId,
      artifactId,
      anchorNamespaceId: input.request.anchorNamespaceId,
      cryptoObjectId: deriveArtifactControlObjectIdV1({
        artifactId,
        artifactRevision: reservation.resultArtifactRevision,
      }),
      expectedArtifactRevision: reservation.expectedArtifactRevision,
      nextArtifactRevision: reservation.resultArtifactRevision,
      expectedCryptoAccessRevision: reservation.expectedAccessRevision,
      resultCryptoAccessRevision: 0,
      expectedBlobGeneration: reservation.expectedBlobGeneration,
      resultBlobGeneration: reservation.resultBlobGeneration,
      expectedBlobId: reservation.expectedBlobId,
      resultBlobId: reservation.resultBlobId,
      requiredNamespaceIds: [...requiredNamespaceIds],
      bindings: bindings.map((binding) => ({
        namespaceId: binding.namespaceId,
        domainId: binding.domainId,
        expectedAccessRevision: binding.expectedAccessRevision,
        expectedPolicyRevision: binding.expectedPolicyRevision,
        bindingHashBase64url: Buffer.from(binding.bindingHash).toString("base64url"),
      })),
      maxPlaintextBytes: ARTIFACT_BLOB_MAX_PLAINTEXT_BYTES,
      maxCiphertextBytes: ARTIFACT_BLOB_MAX_FILE_BYTES,
      chunkPlaintextBytes: ARTIFACT_BLOB_CHUNK_PLAINTEXT_BYTES,
      mimeClass: input.request.mimeClass,
      sizeBucket: input.request.sizeBucket,
      deadlineAt,
    });
  }

  publication(): PostgresArtifactProductPublication {
    return this.#publication;
  }
}
