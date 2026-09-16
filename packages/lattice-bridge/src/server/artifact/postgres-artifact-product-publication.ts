import {
  assertArtifactPublicationPlan,
  assertArtifactPublicationReservation,
  deriveArtifactControlObjectIdV1,
  type ArtifactProductPublicationPort,
  type ArtifactPublicationLifecycle,
  type ArtifactPublicationPlanInput,
  type ArtifactPublicationReservationInput,
  type ArtifactProductPublishResult,
} from "../../artifact/artifact-repository.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "../message/postgres-conversation-product-store.ts";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function text(row: ConversationProductDatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`${name} must be text`);
  return value;
}

function nullableText(row: ConversationProductDatabaseRow, name: string): string | null {
  return row[name] === null ? null : text(row, name);
}

function integer(row: ConversationProductDatabaseRow, name: string): number {
  const raw = row[name];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(0|[1-9][0-9]*)$/.test(raw)
    ? Number(raw)
    : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function bytes(row: ConversationProductDatabaseRow, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be bytea`);
  return value.slice();
}

function nullableBytes(
  row: ConversationProductDatabaseRow,
  name: string,
): Uint8Array | null {
  return row[name] === null ? null : bytes(row, name);
}

function sameNullableBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameBytes(left, right);
}

function one(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function lifecycleFromRow(row: ConversationProductDatabaseRow): ArtifactPublicationLifecycle {
  return Object.freeze({
    operationId: text(row, "operation_id"),
    artifactRowId: text(row, "artifact_row_id"),
    artifactId: text(row, "artifact_id"),
    anchorNamespaceId: text(row, "anchor_namespace_id"),
    operationType: text(row, "operation_type") as ArtifactPublicationLifecycle["operationType"],
    expectedArtifactRevision: integer(row, "expected_artifact_revision"),
    resultArtifactRevision: integer(row, "result_artifact_revision"),
    expectedAccessRevision: integer(row, "expected_access_revision"),
    resultAccessRevision: 0,
    expectedBlobGeneration: integer(row, "expected_blob_generation"),
    resultBlobGeneration: integer(row, "result_blob_generation"),
    expectedBlobId: nullableText(row, "expected_blob_id"),
    resultBlobId: text(row, "result_blob_id"),
    expectedRequiredNamespaceFingerprint: nullableBytes(
      row,
      "expected_required_namespace_fingerprint",
    ),
    cryptoObjectId: text(row, "crypto_object_id"),
    blob: Object.freeze({
      artifactId: text(row, "artifact_id"),
      blobId: text(row, "result_blob_id"),
      blobGeneration: integer(row, "result_blob_generation"),
      storageRef: text(row, "storage_ref"),
      ciphertextLength: integer(row, "ciphertext_length"),
      ciphertextSha256: bytes(row, "ciphertext_sha256"),
    }),
    mimeClass: text(row, "mime_class") as ArtifactPublicationLifecycle["mimeClass"],
    sizeBucket: text(row, "size_bucket") as ArtifactPublicationLifecycle["sizeBucket"],
    requestDigest: bytes(row, "request_digest"),
    allocationRequestDigest: bytes(row, "allocation_request_digest"),
    requiredNamespaceFingerprint: bytes(row, "target_required_namespace_fingerprint"),
    completion: text(row, "completion") as ArtifactPublicationLifecycle["completion"],
    disposition: text(row, "disposition") as ArtifactPublicationLifecycle["disposition"],
    attemptCount: integer(row, "attempt_count"),
    failureCode: nullableText(row, "failure_code"),
  });
}

function reservationFromRow(
  row: ConversationProductDatabaseRow,
): ArtifactPublicationReservationInput {
  return Object.freeze({
    operationId: text(row, "operation_id"),
    artifactRowId: text(row, "artifact_row_id"),
    artifactId: text(row, "artifact_id"),
    anchorNamespaceId: text(row, "anchor_namespace_id"),
    operationType: text(row, "operation_type") as ArtifactPublicationReservationInput["operationType"],
    expectedArtifactRevision: integer(row, "expected_artifact_revision"),
    resultArtifactRevision: integer(row, "result_artifact_revision"),
    expectedAccessRevision: integer(row, "expected_access_revision"),
    resultAccessRevision: 0,
    expectedBlobGeneration: integer(row, "expected_blob_generation"),
    resultBlobGeneration: integer(row, "result_blob_generation"),
    expectedBlobId: nullableText(row, "expected_blob_id"),
    resultBlobId: text(row, "result_blob_id"),
    expectedRequiredNamespaceFingerprint: nullableBytes(
      row,
      "expected_required_namespace_fingerprint",
    ),
    targetRequiredNamespaceFingerprint: bytes(
      row,
      "target_required_namespace_fingerprint",
    ),
    planDigest: bytes(row, "request_digest"),
  });
}

function exactReservation(
  actual: ArtifactPublicationReservationInput,
  expected: ArtifactPublicationReservationInput,
): boolean {
  return actual.operationId === expected.operationId
    && actual.artifactRowId === expected.artifactRowId
    && actual.artifactId === expected.artifactId
    && actual.anchorNamespaceId === expected.anchorNamespaceId
    && actual.operationType === expected.operationType
    && actual.expectedArtifactRevision === expected.expectedArtifactRevision
    && actual.resultArtifactRevision === expected.resultArtifactRevision
    && actual.expectedAccessRevision === expected.expectedAccessRevision
    && actual.resultAccessRevision === expected.resultAccessRevision
    && actual.expectedBlobGeneration === expected.expectedBlobGeneration
    && actual.resultBlobGeneration === expected.resultBlobGeneration
    && actual.expectedBlobId === expected.expectedBlobId
    && actual.resultBlobId === expected.resultBlobId
    && sameNullableBytes(
      actual.expectedRequiredNamespaceFingerprint,
      expected.expectedRequiredNamespaceFingerprint,
    )
    && sameBytes(
      actual.targetRequiredNamespaceFingerprint,
      expected.targetRequiredNamespaceFingerprint,
    )
    && sameBytes(actual.planDigest, expected.planDigest);
}

function reservationForPlan(
  plan: ArtifactPublicationPlanInput,
): ArtifactPublicationReservationInput {
  return Object.freeze({
    operationId: plan.operationId,
    artifactRowId: plan.artifactRowId,
    artifactId: plan.revision.artifactId,
    anchorNamespaceId: plan.anchorNamespaceId,
    operationType: plan.operationType,
    expectedArtifactRevision: plan.expectedArtifactRevision,
    resultArtifactRevision: plan.revision.artifactRevision,
    expectedAccessRevision: plan.expectedAccessRevision,
    resultAccessRevision: 0,
    expectedBlobGeneration: plan.expectedBlobGeneration,
    resultBlobGeneration: plan.revision.blobGeneration,
    expectedBlobId: plan.expectedBlobId,
    resultBlobId: plan.revision.blobId,
    expectedRequiredNamespaceFingerprint:
      plan.expectedRequiredNamespaceFingerprint,
    targetRequiredNamespaceFingerprint: plan.requiredNamespaceFingerprint,
    planDigest: plan.requestDigest,
  });
}

function exactReplay(
  lifecycle: ArtifactPublicationLifecycle,
  plan: ArtifactPublicationPlanInput,
): boolean {
  return lifecycle.operationId === plan.operationId
    && lifecycle.artifactRowId === plan.artifactRowId
    && lifecycle.artifactId === plan.revision.artifactId
    && lifecycle.anchorNamespaceId === plan.anchorNamespaceId
    && lifecycle.operationType === plan.operationType
    && lifecycle.expectedArtifactRevision === plan.expectedArtifactRevision
    && lifecycle.resultArtifactRevision === plan.revision.artifactRevision
    && lifecycle.expectedAccessRevision === plan.expectedAccessRevision
    && lifecycle.expectedBlobGeneration === plan.expectedBlobGeneration
    && lifecycle.resultBlobGeneration === plan.revision.blobGeneration
    && lifecycle.expectedBlobId === plan.expectedBlobId
    && lifecycle.resultBlobId === plan.revision.blobId
    && sameNullableBytes(
      lifecycle.expectedRequiredNamespaceFingerprint,
      plan.expectedRequiredNamespaceFingerprint,
    )
    && lifecycle.cryptoObjectId === plan.revision.objectId
    && lifecycle.blob.storageRef === plan.blob.storageRef
    && lifecycle.mimeClass === plan.mimeClass
    && lifecycle.sizeBucket === plan.sizeBucket
    && sameBytes(lifecycle.requestDigest, plan.requestDigest)
    && sameBytes(
      lifecycle.allocationRequestDigest,
      plan.allocationRequestDigest,
    )
    && sameBytes(
      lifecycle.requiredNamespaceFingerprint,
      plan.requiredNamespaceFingerprint,
    );
}

export class PostgresArtifactProductPublication
  implements ArtifactProductPublicationPort {
  readonly #handle: ConversationProductPostgresHandle;

  constructor(handle: ConversationProductPostgresHandle) {
    assertVerifiedConversationProductPostgresHandle(handle);
    if (handle.role !== "nautilo") {
      throw new TypeError("Artifact publication requires a direct nautilo handle");
    }
    this.#handle = handle;
  }

  async #loadReservation(
    transaction: ConversationProductPostgresTransaction,
    operationId: string,
    lock: boolean,
  ): Promise<ArtifactPublicationReservationInput | null> {
    const row = one(await transaction.query(
      `SELECT operation_id, artifact_row_id::text, artifact_id,
              anchor_namespace_id::text, operation_type,
              expected_artifact_revision, result_artifact_revision,
              expected_access_revision, result_access_revision,
              expected_blob_generation, result_blob_generation,
              expected_blob_id, result_blob_id, request_digest,
              expected_required_namespace_fingerprint,
              target_required_namespace_fingerprint
         FROM artifact_crypto_operations
        WHERE operation_id = $1 LIMIT 2 ${lock ? "FOR UPDATE" : ""}`,
      [operationId],
    ), "Artifact publication reservation");
    return row === null ? null : reservationFromRow(row);
  }

  async #insertReservation(
    transaction: ConversationProductPostgresTransaction,
    plan: ArtifactPublicationReservationInput,
  ): Promise<void> {
    await executeTypedConversationProductQuery(
      transaction,
      conversationProductTypedDb.insert(artifactCryptoOperations).values({
        operationId: plan.operationId,
        artifactRowId: plan.artifactRowId,
        artifactId: plan.artifactId,
        anchorNamespaceId: plan.anchorNamespaceId,
        operationType: plan.operationType,
        expectedArtifactRevision: plan.expectedArtifactRevision,
        resultArtifactRevision: plan.resultArtifactRevision,
        expectedAccessRevision: plan.expectedAccessRevision,
        resultAccessRevision: 0,
        expectedBlobGeneration: plan.expectedBlobGeneration,
        resultBlobGeneration: plan.resultBlobGeneration,
        expectedBlobId: plan.expectedBlobId,
        resultBlobId: plan.resultBlobId,
        requestDigest: plan.planDigest,
        expectedRequiredNamespaceFingerprint:
          plan.expectedRequiredNamespaceFingerprint,
        targetRequiredNamespaceFingerprint:
          plan.targetRequiredNamespaceFingerprint,
      }),
    );
  }

  async #load(
    transaction: ConversationProductPostgresTransaction,
    operationId: string,
    lock: boolean,
  ): Promise<ArtifactPublicationLifecycle | null> {
    const row = one(await transaction.query(
      `/* artifact:protected-publication-read */
       SELECT o.operation_id, o.artifact_row_id::text, o.artifact_id,
              o.anchor_namespace_id::text, o.operation_type,
              o.expected_artifact_revision, o.result_artifact_revision,
              o.expected_access_revision, o.expected_blob_generation,
              o.result_blob_generation, o.expected_blob_id, o.result_blob_id,
              o.request_digest, o.expected_required_namespace_fingerprint,
              o.target_required_namespace_fingerprint,
              o.completion, o.disposition, o.attempt_count, o.failure_code,
              r.crypto_object_id, r.allocation_request_digest,
              r.mime_class, r.size_bucket,
              b.storage_ref, b.ciphertext_length, b.ciphertext_sha256
         FROM artifact_crypto_operations o
         JOIN artifact_crypto_revisions r
           ON r.artifact_row_id = o.artifact_row_id
          AND r.artifact_revision = o.result_artifact_revision
         JOIN artifact_crypto_blobs b
           ON b.blob_id = o.result_blob_id
        WHERE o.operation_id = $1
        LIMIT 2 ${lock ? "FOR UPDATE OF o, r, b" : ""}`,
      [operationId],
    ), "Artifact publication operation");
    return row === null ? null : lifecycleFromRow(row);
  }

  reservePlan(input: ArtifactPublicationReservationInput): Promise<
    | Readonly<{
        status: "allocated" | "replayed";
        reservation: ArtifactPublicationReservationInput;
      }>
    | Readonly<{ status: "conflict" }>
  > {
    assertArtifactPublicationReservation(input);
    return this.#handle.transaction(async (transaction) => {
      const existing = await this.#loadReservation(
        transaction,
        input.operationId,
        true,
      );
      if (existing !== null) {
        return exactReservation(existing, input)
          ? { status: "replayed" as const, reservation: existing }
          : { status: "conflict" as const };
      }
      if (input.operationType === "create") {
        if ((await transaction.query(
          `SELECT 1 FROM artifacts
            WHERE id = $1::uuid OR artifact_id = $2 LIMIT 1 FOR UPDATE`,
          [input.artifactRowId, input.artifactId],
        )).length !== 0) return { status: "conflict" as const };
      } else if ((await transaction.query(
        `SELECT 1 FROM artifacts
          WHERE id = $1::uuid AND artifact_id = $2
            AND revision = $3 AND crypto_access_revision = $4
            AND blob_generation = $5 AND blob_id = $6
            AND crypto_object_id = $7
            AND crypto_lifecycle_state = 'active'
            AND crypto_required_namespace_fingerprint = $8
          LIMIT 1 FOR UPDATE`,
        [
          input.artifactRowId,
          input.artifactId,
          input.expectedArtifactRevision,
          input.expectedAccessRevision,
          input.expectedBlobGeneration,
          input.expectedBlobId,
          deriveArtifactControlObjectIdV1({
            artifactId: input.artifactId,
            artifactRevision: input.expectedArtifactRevision,
          }),
          input.expectedRequiredNamespaceFingerprint,
        ],
      )).length !== 1) return { status: "conflict" as const };
      if (
        input.operationType !== "control"
        && (await transaction.query(
          `SELECT 1 FROM artifact_crypto_blobs
            WHERE blob_id = $1
               OR (artifact_row_id = $2::uuid AND blob_generation = $3)
            LIMIT 1 FOR UPDATE`,
          [input.resultBlobId, input.artifactRowId, input.resultBlobGeneration],
        )).length !== 0
      ) return { status: "conflict" as const };
      await this.#insertReservation(transaction, input);
      return Object.freeze({ status: "allocated" as const, reservation: input });
    }, { isolationLevel: "serializable" });
  }

  reserve(plan: ArtifactPublicationPlanInput) {
    assertArtifactPublicationPlan(plan);
    return this.#handle.transaction(async (transaction) => {
      const replay = await this.#load(transaction, plan.operationId, true);
      if (replay !== null) {
        return exactReplay(replay, plan)
          ? { status: "replayed" as const, lifecycle: replay }
          : { status: "conflict" as const };
      }
      const expectedReservation = reservationForPlan(plan);
      const reserved = await this.#loadReservation(
        transaction,
        plan.operationId,
        true,
      );
      if (
        reserved !== null
        && !exactReservation(reserved, expectedReservation)
      ) return { status: "conflict" as const };
      if (plan.operationType === "create") {
        if ((await transaction.query(
          `SELECT 1 FROM artifacts
            WHERE id = $1::uuid OR artifact_id = $2 LIMIT 1 FOR UPDATE`,
          [plan.artifactRowId, plan.revision.artifactId],
        )).length !== 0) return { status: "conflict" as const };
      } else if ((await transaction.query(
        `SELECT 1 FROM artifacts
          WHERE id = $1::uuid AND artifact_id = $2
            AND revision = $3 AND crypto_access_revision = $4
            AND blob_generation = $5 AND blob_id = $6
            AND crypto_object_id = $7
            AND crypto_lifecycle_state = 'active'
            AND crypto_required_namespace_fingerprint = $8
          LIMIT 1 FOR UPDATE`,
        [
          plan.artifactRowId,
          plan.revision.artifactId,
          plan.expectedArtifactRevision,
          plan.expectedAccessRevision,
          plan.expectedBlobGeneration,
          plan.expectedBlobId,
          deriveArtifactControlObjectIdV1({
            artifactId: plan.revision.artifactId,
            artifactRevision: plan.expectedArtifactRevision,
          }),
          plan.expectedRequiredNamespaceFingerprint,
        ],
      )).length !== 1) return { status: "conflict" as const };

      if (plan.operationType === "control") {
        const retained = await transaction.query(
          `SELECT 1 FROM artifact_crypto_blobs
            WHERE artifact_row_id = $1::uuid AND artifact_id = $2
              AND blob_id = $3 AND blob_generation = $4
              AND storage_ref = $5 AND ciphertext_length = $6
              AND ciphertext_sha256 = $7 AND state = 'published'
            LIMIT 1 FOR UPDATE`,
          [
            plan.artifactRowId, plan.revision.artifactId,
            plan.revision.blobId, plan.revision.blobGeneration,
            plan.blob.storageRef, plan.blob.ciphertextLength,
            plan.blob.ciphertextSha256,
          ],
        );
        if (retained.length !== 1) return { status: "conflict" as const };
      } else if ((await transaction.query(
        `SELECT 1 FROM artifact_crypto_blobs
          WHERE blob_id = $1
             OR (artifact_row_id = $2::uuid AND blob_generation = $3)
          LIMIT 1 FOR UPDATE`,
        [
          plan.revision.blobId,
          plan.artifactRowId,
          plan.revision.blobGeneration,
        ],
      )).length !== 0) return { status: "conflict" as const };

      if (reserved === null) {
        await this.#insertReservation(transaction, expectedReservation);
      }
      if (plan.operationType !== "control") {
        await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.insert(artifactCryptoBlobs).values({
            artifactRowId: plan.artifactRowId,
            artifactId: plan.revision.artifactId,
            blobId: plan.revision.blobId,
            blobGeneration: plan.revision.blobGeneration,
            publicationOperationId: plan.operationId,
            storageRef: plan.blob.storageRef,
            ciphertextLength: plan.blob.ciphertextLength,
            ciphertextSha256: plan.blob.ciphertextSha256,
          }),
        );
      }
      await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.insert(artifactCryptoRevisions).values({
          artifactRowId: plan.artifactRowId,
          artifactId: plan.revision.artifactId,
          artifactRevision: plan.revision.artifactRevision,
          anchorNamespaceId: plan.anchorNamespaceId,
          cryptoObjectId: plan.revision.objectId,
          allocationRequestDigest: plan.allocationRequestDigest,
          requiredNamespaceFingerprint: plan.requiredNamespaceFingerprint,
          blobId: plan.revision.blobId,
          blobGeneration: plan.revision.blobGeneration,
          mimeClass: plan.mimeClass,
          sizeBucket: plan.sizeBucket,
        }),
      );
      return {
        status: "allocated" as const,
        lifecycle: Object.freeze({
          operationId: plan.operationId,
          artifactRowId: plan.artifactRowId,
          artifactId: plan.revision.artifactId,
          anchorNamespaceId: plan.anchorNamespaceId,
          operationType: plan.operationType,
          expectedArtifactRevision: plan.expectedArtifactRevision,
          resultArtifactRevision: plan.revision.artifactRevision,
          expectedAccessRevision: plan.expectedAccessRevision,
          resultAccessRevision: 0 as const,
          expectedBlobGeneration: plan.expectedBlobGeneration,
          resultBlobGeneration: plan.revision.blobGeneration,
          expectedBlobId: plan.expectedBlobId,
          resultBlobId: plan.revision.blobId,
          expectedRequiredNamespaceFingerprint:
            plan.expectedRequiredNamespaceFingerprint,
          cryptoObjectId: plan.revision.objectId,
          blob: plan.blob,
          mimeClass: plan.mimeClass,
          sizeBucket: plan.sizeBucket,
          requestDigest: plan.requestDigest,
          allocationRequestDigest: plan.allocationRequestDigest,
          requiredNamespaceFingerprint: plan.requiredNamespaceFingerprint,
          completion: "pending" as const,
          disposition: "active" as const,
          attemptCount: 0,
          failureCode: null,
        }),
      };
    }, { isolationLevel: "serializable" });
  }

  publish({
    lifecycle,
    verified,
    targetLifecycleState,
  }: Parameters<ArtifactProductPublicationPort["publish"]>[0]) {
    return this.#handle.transaction(async (transaction) => {
      const current = await this.#load(transaction, lifecycle.operationId, true);
      if (
        current === null
        || (current.operationType !== "control"
          && targetLifecycleState !== "active")
        || !sameBytes(current.requestDigest, lifecycle.requestDigest)
        || verified.artifactId !== current.artifactId
        || verified.artifactRevision !== current.resultArtifactRevision
        || verified.objectId !== current.cryptoObjectId
        || verified.accessRevision !== current.resultAccessRevision
        || !sameBytes(
          verified.requiredNamespaceFingerprint,
          current.requiredNamespaceFingerprint,
        )
      ) return "conflict";
      if (current.completion === "complete") {
        const exactMapping = await transaction.query(
          `SELECT 1 FROM artifacts
            WHERE id = $1::uuid AND artifact_id = $2
              AND revision = $3 AND crypto_object_id = $4
              AND crypto_access_revision = $5
              AND crypto_required_namespace_fingerprint = $6
              AND blob_id = $7 AND blob_generation = $8
              AND ciphertext_length = $9 AND ciphertext_sha256 = $10
              AND mime_class = $11 AND size_bucket = $12
              AND crypto_lifecycle_state = $13
            LIMIT 1 FOR UPDATE`,
          [
            current.artifactRowId,
            current.artifactId,
            current.resultArtifactRevision,
            current.cryptoObjectId,
            current.resultAccessRevision,
            current.requiredNamespaceFingerprint,
            current.resultBlobId,
            current.resultBlobGeneration,
            current.blob.ciphertextLength,
            current.blob.ciphertextSha256,
            current.mimeClass,
            current.sizeBucket,
            targetLifecycleState,
          ],
        );
        return exactMapping.length === 1 ? "duplicate" : "conflict";
      }
      if (current.operationType !== "create") {
        const existing = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .select({ namespace_id: artifactNamespaces.namespaceId })
            .from(artifactNamespaces)
            .where(eq(artifactNamespaces.artifactId, current.artifactRowId))
            .orderBy(artifactNamespaces.namespaceId),
        );
        const ids = existing.map((row) => text(row, "namespace_id"));
        if (
          ids.length !== verified.requiredNamespaceIds.length
          || ids.some((value, index) => value !== verified.requiredNamespaceIds[index])
        ) return "stale";
      }
      const mapped = current.operationType === "create"
        ? await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb.insert(artifacts).values({
            id: current.artifactRowId,
            artifactId: current.artifactId,
            path: null,
            mimeType: null,
            size: null,
            storageUri: null,
            revision: current.resultArtifactRevision,
            cryptoObjectId: current.cryptoObjectId,
            cryptoAccessRevision: 0,
            cryptoRequiredNamespaceFingerprint:
              current.requiredNamespaceFingerprint,
            cryptoMappingState: "verified",
            blobId: current.resultBlobId,
            blobGeneration: current.resultBlobGeneration,
            ciphertextLength: current.blob.ciphertextLength,
            ciphertextSha256: current.blob.ciphertextSha256,
            mimeClass: current.mimeClass,
            sizeBucket: current.sizeBucket,
            cryptoLifecycleState: targetLifecycleState,
          }).returning({ id: artifacts.id }),
        )
        : await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .update(artifacts)
            .set({
              revision: current.resultArtifactRevision,
              cryptoObjectId: current.cryptoObjectId,
              cryptoAccessRevision: 0,
              cryptoRequiredNamespaceFingerprint:
                current.requiredNamespaceFingerprint,
              cryptoMappingState: "verified",
              blobId: current.resultBlobId,
              blobGeneration: current.resultBlobGeneration,
              ciphertextLength: current.blob.ciphertextLength,
              ciphertextSha256: current.blob.ciphertextSha256,
              mimeClass: current.mimeClass,
              sizeBucket: current.sizeBucket,
              cryptoLifecycleState: targetLifecycleState,
              deletedAt: targetLifecycleState === "archived"
                ? sql`CURRENT_TIMESTAMP`
                : null,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(and(
              eq(artifacts.id, current.artifactRowId),
              eq(artifacts.artifactId, current.artifactId),
              eq(artifacts.revision, current.expectedArtifactRevision),
              eq(
                artifacts.cryptoAccessRevision,
                current.expectedAccessRevision,
              ),
              eq(artifacts.blobGeneration, current.expectedBlobGeneration),
              sql`${artifacts.blobId} = ${current.expectedBlobId}`,
              eq(
                artifacts.cryptoObjectId,
                deriveArtifactControlObjectIdV1({
                  artifactId: current.artifactId,
                  artifactRevision: current.expectedArtifactRevision,
                }),
              ),
              eq(artifacts.cryptoLifecycleState, "active"),
              sql`${artifacts.cryptoRequiredNamespaceFingerprint} = ${current.expectedRequiredNamespaceFingerprint}`,
            ))
            .returning({ id: artifacts.id }),
        );
      if (mapped.length !== 1) return "stale";
      if (current.operationType === "create") {
        for (const namespaceId of verified.requiredNamespaceIds) {
          await executeTypedConversationProductQuery(
            transaction,
            conversationProductTypedDb.insert(artifactNamespaces).values({
              artifactId: current.artifactRowId,
              namespaceId,
            }),
          );
        }
      }
      if (current.operationType !== "control") {
        await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .update(artifactCryptoBlobs)
            .set({
              state: "published",
              publishedAt: sql`CURRENT_TIMESTAMP`,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(and(
              eq(
                artifactCryptoBlobs.publicationOperationId,
                current.operationId,
              ),
              eq(artifactCryptoBlobs.state, "staging"),
            )),
        );
      }
      await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .update(artifactCryptoRevisions)
          .set({
            completion: "complete",
            disposition: "mapped",
            cryptoCompletedAt: sql`CURRENT_TIMESTAMP`,
            nextAttemptAt: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(and(
            eq(artifactCryptoRevisions.artifactRowId, current.artifactRowId),
            eq(
              artifactCryptoRevisions.artifactRevision,
              current.resultArtifactRevision,
            ),
          )),
      );
      await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .update(artifactCryptoOperations)
          .set({
            completion: "complete",
            disposition: "complete",
            cryptoCompletedAt: sql`CURRENT_TIMESTAMP`,
            nextAttemptAt: null,
            failureCode: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(artifactCryptoOperations.operationId, current.operationId)),
      );
      return "applied";
    }, { isolationLevel: "serializable" }) as Promise<ArtifactProductPublishResult>;
  }

  read(operationId: string): Promise<ArtifactPublicationLifecycle | null> {
    return this.#handle.transaction(
      (transaction) => this.#load(transaction, operationId, false),
      { isolationLevel: "serializable" },
    );
  }

  readPlan(
    operationId: string,
  ): Promise<ArtifactPublicationReservationInput | null> {
    return this.#handle.transaction(
      (transaction) => this.#loadReservation(transaction, operationId, false),
      { isolationLevel: "serializable" },
    );
  }

  recordFailure(input: Parameters<ArtifactProductPublicationPort["recordFailure"]>[0]) {
    return this.#handle.transaction(async (transaction) => {
      const lifecycle = await this.#load(transaction, input.operationId, true);
      if (
        lifecycle === null
        || !sameBytes(lifecycle.requestDigest, input.requestDigest)
      ) throw new Error(
        "Artifact failure receipt conflicts with durable state",
      );
      if (lifecycle.completion === "complete") {
        if (input.disposition !== "quarantined") throw new Error(
          "Completed Artifact publication may only be quarantined",
        );
        const rows = await executeTypedConversationProductQuery(
          transaction,
          conversationProductTypedDb
            .update(artifacts)
            .set({
              cryptoLifecycleState: "quarantined",
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(and(
              eq(artifacts.id, lifecycle.artifactRowId),
              eq(artifacts.artifactId, lifecycle.artifactId),
              eq(artifacts.revision, lifecycle.resultArtifactRevision),
              eq(artifacts.cryptoObjectId, lifecycle.cryptoObjectId),
            ))
            .returning({ id: artifacts.id }),
        );
        if (rows.length !== 1) throw new Error(
          "Completed Artifact quarantine conflicts with product mapping",
        );
        return;
      }
      const rows = await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb
          .update(artifactCryptoOperations)
          .set({
            disposition: input.disposition,
            failureCode: input.failureCode,
            nextAttemptAt: input.disposition === "blocked"
              ? sql`CURRENT_TIMESTAMP`
              : null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(and(
            eq(artifactCryptoOperations.operationId, input.operationId),
            eq(artifactCryptoOperations.requestDigest, input.requestDigest),
            eq(artifactCryptoOperations.completion, "pending"),
          ))
          .returning({ operation_id: artifactCryptoOperations.operationId }),
      );
      if (rows.length !== 1) throw new Error(
        "Artifact failure receipt conflicts with durable state",
      );
    }, { isolationLevel: "serializable" });
  }
}
import {
  and,
  artifactCryptoBlobs,
  artifactCryptoOperations,
  artifactCryptoRevisions,
  artifactNamespaces,
  artifacts,
  eq,
  sql,
} from "@nautilo/db";
