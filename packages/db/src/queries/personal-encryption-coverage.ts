import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../config/database";

export const PERSONAL_ENCRYPTION_COVERAGE_FAMILIES = Object.freeze([
  "message",
  "memory",
  "journal_event",
  "reflection_record",
  "artifact",
  "task",
] as const);

export type PersonalEncryptionCoverageFamily =
  (typeof PERSONAL_ENCRYPTION_COVERAGE_FAMILIES)[number];

export type PersonalEncryptionCoverageFamilyResult =
  | Readonly<{
      family: Exclude<PersonalEncryptionCoverageFamily, "task">;
      measurement: "measured";
      accessible: bigint;
      plaintextPresent: bigint;
      encryptedCounterpart: bigint;
    }>
  | Readonly<{
      family: "task";
      measurement: "unsupported";
      accessible: bigint;
      plaintextPresent: bigint;
    }>;

export type PersonalEncryptionCoverageDb = Pick<Database, "execute">;

type AggregateRow = Readonly<{
  accessible: string;
  plaintext_present: string;
  encrypted_counterpart?: string;
}>;

const ZERO_MEASURED = Object.freeze({
  accessible: 0n,
  plaintextPresent: 0n,
  encryptedCounterpart: 0n,
});

function count(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`Invalid personal encryption coverage aggregate: ${label}`);
  }
  return BigInt(value);
}

function namespaceList(readableNamespaceIds: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    readableNamespaceIds.map((namespaceId) => sql`${namespaceId}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * M308 query seam. Every family remains an independent aggregate so callers
 * can preserve the other rows when one storage projection is unavailable.
 * Empty Namespace authority is handled before SQL and can never widen scope.
 */
export function buildPersonalEncryptionCoverageQuery(input: Readonly<{
  family: PersonalEncryptionCoverageFamily;
  readableNamespaceIds: readonly string[];
  userId: string;
}>): SQL {
  const readable = namespaceList(input.readableNamespaceIds);
  switch (input.family) {
    case "message":
      return sql`
        SELECT count(DISTINCT message.id)::text AS accessible,
               count(DISTINCT message.id) FILTER (
                 WHERE message.content IS NOT NULL
               )::text AS plaintext_present,
               count(DISTINCT message.id) FILTER (WHERE
                 message.crypto_object_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM session_message_crypto_revisions revision
                    WHERE revision.session_id = message.session_id
                      AND revision.message_id = message.id
                      AND revision.edit_revision = message.edit_revision
                      AND revision.crypto_object_id = message.crypto_object_id
                      AND revision.completion = 'complete'
                      AND revision.disposition = 'mapped'
                      -- Authentication proves current protected coverage.
                      -- The *_verified subset additionally records independent
                      -- ordinary/protected parity; this aggregate does not
                      -- collapse that stronger provenance into a requirement.
                      AND revision.parity_status IN (
                        'server_verified', 'client_verified',
                        'server_authenticated', 'client_authenticated'
                      )
                 )
               )::text AS encrypted_counterpart
          FROM session_messages message
          JOIN sessions session ON session.id = message.session_id
          JOIN rooms room ON room.id = session.room_id
         WHERE room.namespace_id = ANY(${readable})`;
    case "memory":
      return sql`
        SELECT count(DISTINCT memory.id)::text AS accessible,
               count(DISTINCT memory.id) FILTER (
                 WHERE memory.content IS NOT NULL
               )::text AS plaintext_present,
               count(DISTINCT memory.id) FILTER (WHERE
                 memory.crypto_object_id IS NOT NULL
                 AND memory.crypto_mapping_state = 'verified'
                 AND memory.crypto_required_namespace_fingerprint IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM memory_crypto_revisions revision
                    WHERE revision.memory_id = memory.id
                      AND revision.content_revision = memory.content_revision
                      AND revision.crypto_object_id = memory.crypto_object_id
                      AND revision.completion = 'complete'
                      AND revision.disposition = 'mapped'
                 )
               )::text AS encrypted_counterpart
          FROM memories memory
         WHERE EXISTS (
           SELECT 1
             FROM memory_namespaces attachment
            WHERE attachment.memory_id = memory.id
              AND attachment.namespace_id = ANY(${readable})
         )`;
    case "artifact":
      return sql`
        SELECT count(DISTINCT artifact.id)::text AS accessible,
               count(DISTINCT artifact.id) FILTER (WHERE
                 artifact.path IS NOT NULL
                 AND artifact.mime_type IS NOT NULL
                 AND artifact.size IS NOT NULL
                 AND artifact.storage_uri IS NOT NULL
               )::text AS plaintext_present,
               count(DISTINCT artifact.id) FILTER (WHERE
                 artifact.crypto_object_id IS NOT NULL
                 AND artifact.crypto_mapping_state = 'verified'
                 AND artifact.crypto_required_namespace_fingerprint IS NOT NULL
                 AND artifact.crypto_lifecycle_state = 'active'
                 AND EXISTS (
                   SELECT 1
                     FROM artifact_crypto_revisions revision
                    WHERE revision.artifact_row_id = artifact.id
                      AND revision.artifact_id = artifact.artifact_id
                      AND revision.artifact_revision = artifact.revision
                      AND revision.crypto_object_id = artifact.crypto_object_id
                      AND revision.required_namespace_fingerprint =
                        artifact.crypto_required_namespace_fingerprint
                      AND revision.completion = 'complete'
                      AND revision.disposition = 'mapped'
                 )
                 AND EXISTS (
                   SELECT 1
                     FROM artifact_crypto_blobs blob
                    WHERE blob.artifact_row_id = artifact.id
                      AND blob.artifact_id = artifact.artifact_id
                      AND blob.blob_id = artifact.blob_id
                      AND blob.blob_generation = artifact.blob_generation
                      AND blob.ciphertext_length = artifact.ciphertext_length
                      AND blob.ciphertext_sha256 = artifact.ciphertext_sha256
                      AND blob.state = 'published'
                 )
               )::text AS encrypted_counterpart
          FROM artifacts artifact
         WHERE artifact.deleted_at IS NULL
           AND EXISTS (
             SELECT 1
               FROM artifact_namespaces attachment
              WHERE attachment.artifact_id = artifact.id
                AND attachment.namespace_id = ANY(${readable})
           )`;
    case "reflection_record":
      return sql`
        SELECT count(DISTINCT record.record_id)::text AS accessible,
               count(DISTINCT record.record_id) FILTER (WHERE EXISTS (
                 SELECT 1
                   FROM reflection_record_payload_representation_heads head
                   JOIN reflection_record_payload_representations representation
                     ON representation.record_id = head.record_id
                    AND representation.representation = head.representation
                    AND representation.representation_generation =
                      head.current_representation_generation
                  WHERE head.record_id = record.record_id
                    AND head.representation = 'ordinary'
                    AND representation.plaintext_payload_bytes IS NOT NULL
               ))::text AS plaintext_present,
               count(DISTINCT record.record_id) FILTER (WHERE EXISTS (
                 SELECT 1
                   FROM reflection_record_payload_representation_heads head
                   JOIN reflection_record_payload_representations representation
                     ON representation.record_id = head.record_id
                    AND representation.representation = head.representation
                    AND representation.representation_generation =
                      head.current_representation_generation
                   JOIN reflection_record_publications publication
                     ON publication.record_id = representation.record_id
                    AND publication.representation = representation.representation
                    AND publication.representation_generation =
                      representation.representation_generation
                    AND publication.crypto_object_id =
                      representation.crypto_object_id
                  WHERE head.record_id = record.record_id
                    AND head.representation = 'protected'
                    AND representation.crypto_object_id IS NOT NULL
                    AND publication.state = 'complete'
               ))::text AS encrypted_counterpart
          FROM reflection_records record
         WHERE record.lifecycle = 'current'
           AND record.disposition = 'available'
           AND EXISTS (
             SELECT 1
               FROM reflection_record_authority_projections authority
               JOIN reflection_record_authority_alternatives alternative
                 ON alternative.record_id = authority.record_id
                AND alternative.projection_generation =
                  authority.projection_generation
              WHERE authority.record_id = record.record_id
                AND authority.current = true
                AND authority.processing_state = 'current'
                AND alternative.access_namespace_id = ANY(${readable})
           )`;
    case "journal_event":
      return sql`
        SELECT count(DISTINCT event.id)::text AS accessible,
               count(DISTINCT event.id) FILTER (WHERE
                 event.statement IS NOT NULL
                 OR EXISTS (
                   SELECT 1
                     FROM reflection_record_payload_representation_heads head
                     JOIN reflection_record_payload_representations representation
                       ON representation.record_id = head.record_id
                      AND representation.representation = head.representation
                      AND representation.representation_generation =
                        head.current_representation_generation
                    WHERE head.record_id = event.record_id
                      AND head.representation = 'ordinary'
                      AND representation.plaintext_payload_bytes IS NOT NULL
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM room_event_rollups rollup
                    WHERE rollup.id = (
                      SELECT current_rollup.id
                        FROM room_event_rollups current_rollup
                       WHERE current_rollup.room_id = event.room_id
                       ORDER BY current_rollup.through_event_sequence DESC,
                                current_rollup.created_at DESC,
                                current_rollup.id
                       LIMIT 1
                    )
                      AND rollup.through_event_sequence >= event.sequence
                      AND rollup.crypto_object_id IS NULL
                 )
               )::text AS plaintext_present,
               count(DISTINCT event.id) FILTER (WHERE
                 (
                   (event.projection_kind = 'legacy'
                     AND event.crypto_object_id IS NOT NULL)
                   OR
                   (event.projection_kind = 'native' AND EXISTS (
                     SELECT 1
                       FROM reflection_record_payload_representation_heads head
                       JOIN reflection_record_payload_representations representation
                         ON representation.record_id = head.record_id
                        AND representation.representation = head.representation
                        AND representation.representation_generation =
                          head.current_representation_generation
                       JOIN reflection_record_publications publication
                         ON publication.record_id = representation.record_id
                        AND publication.representation =
                          representation.representation
                        AND publication.representation_generation =
                          representation.representation_generation
                        AND publication.crypto_object_id =
                          representation.crypto_object_id
                      WHERE head.record_id = event.record_id
                        AND head.representation = 'protected'
                        AND representation.crypto_object_id IS NOT NULL
                        AND publication.state = 'complete'
                   ))
                 )
                 AND NOT EXISTS (
                   SELECT 1
                     FROM room_event_rollups rollup
                    WHERE rollup.id = (
                      SELECT current_rollup.id
                        FROM room_event_rollups current_rollup
                       WHERE current_rollup.room_id = event.room_id
                       ORDER BY current_rollup.through_event_sequence DESC,
                                current_rollup.created_at DESC,
                                current_rollup.id
                       LIMIT 1
                    )
                      AND rollup.through_event_sequence >= event.sequence
                      AND rollup.crypto_object_id IS NULL
                 )
               )::text AS encrypted_counterpart
          FROM room_events event
          JOIN rooms room ON room.id = event.room_id
         WHERE room.namespace_id = ANY(${readable})
           AND event.status = 'active'`;
    case "task":
      return sql`
        SELECT count(DISTINCT task.id)::text AS accessible,
               count(DISTINCT task.id) FILTER (
                 WHERE task.prompt IS NOT NULL
               )::text AS plaintext_present
          FROM tasks task
         WHERE task.owner_id = ${input.userId}`;
  }
}

export async function readPersonalEncryptionCoverageFamily(
  db: PersonalEncryptionCoverageDb,
  input: Readonly<{
    family: PersonalEncryptionCoverageFamily;
    readableNamespaceIds: readonly string[];
    userId: string;
  }>,
): Promise<PersonalEncryptionCoverageFamilyResult> {
  if (input.family !== "task" && input.readableNamespaceIds.length === 0) {
    return Object.freeze({
      family: input.family,
      measurement: "measured" as const,
      ...ZERO_MEASURED,
    });
  }
  const rows = await db.execute<AggregateRow>(
    buildPersonalEncryptionCoverageQuery(input),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Personal encryption coverage ${input.family} aggregate is unavailable`);
  }
  const accessible = count(row.accessible, `${input.family} accessible`);
  const plaintextPresent = count(
    row.plaintext_present,
    `${input.family} plaintext present`,
  );
  if (plaintextPresent > accessible) {
    throw new Error(
      `Invalid personal encryption coverage aggregate: ${input.family} plaintext exceeds accessible`,
    );
  }
  if (input.family === "task") {
    return Object.freeze({
      family: "task",
      measurement: "unsupported",
      accessible,
      plaintextPresent,
    });
  }
  const encryptedCounterpart = count(
    row.encrypted_counterpart,
    `${input.family} encrypted counterpart`,
  );
  if (encryptedCounterpart > accessible) {
    throw new Error(
      `Invalid personal encryption coverage aggregate: ${input.family} encrypted exceeds accessible`,
    );
  }
  return Object.freeze({
    family: input.family,
    measurement: "measured",
    accessible,
    plaintextPresent,
    encryptedCounterpart,
  });
}
