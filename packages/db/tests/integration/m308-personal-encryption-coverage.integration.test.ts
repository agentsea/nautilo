import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";

import {
  createDirectDb,
  cryptoObjects,
  ensureDatabase,
  memories,
  memoryCryptoRevisions,
  readPersonalEncryptionCoverageFamily,
  sql,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: DirectDatabase | undefined;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(1);
});

afterAll(async () => {
  await db?.end();
});

class RollbackFixture extends Error {}

describe("M308 personal encryption coverage on PostgreSQL", () => {
  test("isolates authority, deduplicates junctions, and requires current complete protection", async () => {
    if (db === undefined) throw new Error("M308 integration DB is unavailable");
    const ids = {
      userA: randomUUID(),
      userB: randomUUID(),
      actorA: randomUUID(),
      actorB: randomUUID(),
      agent: randomUUID(),
      namespaceA: randomUUID(),
      namespaceShared: randomUUID(),
      namespaceB: randomUUID(),
      roomA: randomUUID(),
      roomShared: randomUUID(),
      roomB: randomUUID(),
      sessionA: randomUUID(),
      sessionB: randomUUID(),
      memoryCurrent: randomUUID(),
      memoryAccessChanged: randomUUID(),
      memoryPending: randomUUID(),
      memoryStale: randomUUID(),
      memoryForeign: randomUUID(),
      artifactA: randomUUID(),
      artifactForeign: randomUUID(),
      batch: randomUUID(),
      eventCoveredByPlaintextRollup: randomUUID(),
      eventCurrent: randomUUID(),
      eventInactive: randomUUID(),
      rollup: randomUUID(),
      taskA: randomUUID(),
      taskB: randomUUID(),
    };
    const tag = ids.userA.slice(0, 8);
    const object = (kind: string) => `m308:${kind}:${tag}`;
    const now = "2026-09-03T10:00:00.000Z";

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO users (id, name, email, handle)
          VALUES
            (${ids.userA}, 'M308 A', ${`m308-a-${tag}@test.local`}, ${`m308-a-${tag}`}),
            (${ids.userB}, 'M308 B', ${`m308-b-${tag}@test.local`}, ${`m308-b-${tag}`})
        `);
        await tx.execute(sql`
          INSERT INTO actors (id, owner_id, display_name, kind)
          VALUES
            (${ids.actorA}, ${ids.userA}, 'M308 A', 'user'),
            (${ids.actorB}, ${ids.userB}, 'M308 B', 'user')
        `);
        await tx.execute(sql`
          INSERT INTO agents (id, handle) VALUES (${ids.agent}, ${`m308-agent-${tag}`})
        `);
        await tx.execute(sql`
          INSERT INTO namespaces (id, scope, label)
          VALUES
            (${ids.namespaceA}, 'room', 'M308 A'),
            (${ids.namespaceShared}, 'room', 'M308 shared'),
            (${ids.namespaceB}, 'room', 'M308 B')
        `);
        await tx.execute(sql`
          INSERT INTO rooms (
            id, owner_id, type, label, graph_thread_id, namespace_id,
            human_actor_ids, kind, created_by
          ) VALUES
            (${ids.roomA}, ${ids.userA}, 'private', 'M308 A',
             ${`m308:room:a:${tag}`}, ${ids.namespaceA},
             ARRAY[${ids.actorA}]::uuid[], 'private', ${ids.actorA}),
            (${ids.roomShared}, ${ids.userA}, 'shared', 'M308 shared',
             ${`m308:room:shared:${tag}`}, ${ids.namespaceShared},
             ARRAY[${ids.actorA}, ${ids.actorB}]::uuid[], 'group', ${ids.actorA}),
            (${ids.roomB}, ${ids.userB}, 'private', 'M308 B',
             ${`m308:room:b:${tag}`}, ${ids.namespaceB},
             ARRAY[${ids.actorB}]::uuid[], 'private', ${ids.actorB})
        `);
        await tx.execute(sql`
          INSERT INTO sessions (id, thread_id, owner_id, persona_id, agent_id, room_id)
          VALUES
            (${ids.sessionA}, ${`m308:session:a:${tag}`}, ${ids.userA}, 'owner',
             ${ids.agent}, ${ids.roomA}),
            (${ids.sessionB}, ${`m308:session:b:${tag}`}, ${ids.userB}, 'owner',
             ${ids.agent}, ${ids.roomB})
        `);
        await tx.execute(sql`
          INSERT INTO session_messages (session_id, role, content)
          VALUES (${ids.sessionA}, 'user', 'A'), (${ids.sessionB}, 'user', 'B')
        `);

        // Authentication is sufficient to count a current protected Message.
        // The *_verified rows retain the stronger, independent plaintext-parity
        // provenance, while a stale mapping remains outside current coverage.
        for (const [kind, parityStatus, disposition] of [
          ["server-authenticated", "server_authenticated", "mapped"],
          ["client-authenticated", "client_authenticated", "mapped"],
          ["server-verified", "server_verified", "mapped"],
          ["client-verified", "client_verified", "mapped"],
          ["stale-verified", "client_verified", "stale_mapping"],
        ] as const) {
          const cryptoObjectId = object(`message-${kind}`);
          await tx.execute(sql`
            INSERT INTO crypto_objects (object_id, payload_hash, payload_bytes)
            VALUES (
              ${cryptoObjectId}, decode(repeat('77', 32), 'hex'), decode('01', 'hex')
            )
          `);
          const messageRows = await tx.execute<{ id: number }>(sql`
            INSERT INTO session_messages (
              session_id, role, content, fingerprint, crypto_object_id
            ) VALUES (
              ${ids.sessionA}, 'assistant', ${`message-${kind}`},
              ${`m308:message:${kind}:${tag}`}, ${cryptoObjectId}
            )
            RETURNING id
          `);
          const messageId = messageRows[0]?.id;
          if (messageId === undefined) {
            throw new Error(`M308 ${kind} Message fixture was not inserted`);
          }
          await tx.execute(sql`
            INSERT INTO session_message_crypto_revisions (
              session_id, message_id, edit_revision, room_id,
              namespace_id_at_allocation, crypto_object_id, key_class,
              author_role, append_idempotency_key, allocation_request_digest,
              completion, disposition, parity_status, next_attempt_at,
              crypto_completed_at
            ) VALUES (
              ${ids.sessionA}, ${messageId}, 0, ${ids.roomA}, ${ids.namespaceA},
              ${cryptoObjectId}, 'ai', 'assistant',
              ${`m308:append:${kind}:${tag}`}, decode(repeat('88', 32), 'hex'),
              'complete', ${disposition}, ${parityStatus}, NULL, ${now}
            )
          `);
        }

        for (const [memoryId, cryptoObjectId, revision, completion, disposition]
          of [
            [ids.memoryCurrent, object("memory-current"), 1, "complete", "mapped"],
            [ids.memoryPending, object("memory-pending"), 1, "pending", "active"],
            [ids.memoryStale, object("memory-stale"), 2, "complete", "mapped"],
          ] as const) {
          await tx.execute(sql`
            INSERT INTO crypto_objects (object_id, payload_hash, payload_bytes)
            VALUES (${cryptoObjectId}, decode(repeat('11', 32), 'hex'), decode('01', 'hex'))
          `);
          await tx.execute(sql`
            INSERT INTO memories (
              id, content, content_revision, crypto_object_id,
              crypto_required_namespace_fingerprint, crypto_mapping_state
            ) VALUES (
              ${memoryId}, ${`memory-${memoryId}`}, ${revision}, ${cryptoObjectId},
              decode(repeat('22', 32), 'hex'), 'verified'
            )
          `);
          await tx.execute(sql`
            INSERT INTO memory_crypto_revisions (
              memory_id, content_revision, anchor_namespace_id,
              crypto_object_id, allocation_request_digest,
              required_namespace_fingerprint, completion, disposition,
              next_attempt_at, crypto_completed_at
            ) VALUES (
              ${memoryId}, 1, ${ids.namespaceA}, ${cryptoObjectId},
              decode(repeat('33', 32), 'hex'), decode(repeat('22', 32), 'hex'),
              ${completion}, ${disposition},
              ${completion === "complete" ? null : now},
              ${completion === "complete" ? now : null}
            )
          `);
        }
        await tx.insert(cryptoObjects).values({
          objectId: object("memory-access-changed"),
          payloadHash: new Uint8Array(32).fill(0x11),
          payloadBytes: new Uint8Array([0x01]),
        });
        await tx.insert(memories).values({
          id: ids.memoryAccessChanged,
          type: null,
          content: null,
          contentRevision: 1,
          cryptoObjectId: object("memory-access-changed"),
          cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(0x44),
          cryptoMappingState: "verified",
          cryptoAccessRevision: 3,
        });
        await tx.insert(memoryCryptoRevisions).values({
          memoryId: ids.memoryAccessChanged,
          contentRevision: 1,
          anchorNamespaceId: ids.namespaceA,
          cryptoObjectId: object("memory-access-changed"),
          allocationRequestDigest: new Uint8Array(32).fill(0x33),
          requiredNamespaceFingerprint: new Uint8Array(32).fill(0x22),
          completion: "complete",
          disposition: "mapped",
          nextAttemptAt: null,
          cryptoCompletedAt: new Date(now),
        });
        await tx.execute(sql`
          INSERT INTO memories (id, content) VALUES (${ids.memoryForeign}, 'foreign');
        `);
        await tx.execute(sql`
          INSERT INTO memory_namespaces (memory_id, namespace_id) VALUES
            (${ids.memoryCurrent}, ${ids.namespaceA}),
            (${ids.memoryCurrent}, ${ids.namespaceShared}),
            (${ids.memoryAccessChanged}, ${ids.namespaceA}),
            (${ids.memoryPending}, ${ids.namespaceA}),
            (${ids.memoryStale}, ${ids.namespaceA}),
            (${ids.memoryForeign}, ${ids.namespaceB})
        `);
        await tx.update(memories)
          .set({ cryptoMappingState: "verified" })
          .where(inArray(memories.id, [
            ids.memoryCurrent,
            ids.memoryAccessChanged,
          ]));
        await tx.execute(sql`
          INSERT INTO artifacts (
            id, artifact_id, path, mime_type, size, storage_uri
          ) VALUES
            (${ids.artifactA}, ${ids.artifactA}, 'a.txt', 'text/plain', 1,
             ${`file:///m308/${tag}/a.txt`}),
            (${ids.artifactForeign}, ${ids.artifactForeign}, 'b.txt', 'text/plain', 1,
             ${`file:///m308/${tag}/b.txt`})
        `);
        await tx.execute(sql`
          INSERT INTO artifact_namespaces (artifact_id, namespace_id) VALUES
            (${ids.artifactA}, ${ids.namespaceA}),
            (${ids.artifactA}, ${ids.namespaceShared}),
            (${ids.artifactForeign}, ${ids.namespaceB})
        `);
        await tx.execute(sql`
          INSERT INTO tasks (
            id, owner_id, requestor_id, agent_id, prompt
          ) VALUES
            (${ids.taskA}, ${ids.userA}, ${ids.userA}, ${ids.agent}, 'A task'),
            (${ids.taskB}, ${ids.userB}, ${ids.userB}, ${ids.agent}, 'B task')
        `);

        for (const recordId of [
          ids.eventCoveredByPlaintextRollup,
          ids.eventCurrent,
          ids.eventInactive,
        ]) {
          const cryptoObjectId = `m308:record:${recordId}`;
          await tx.execute(sql`
            INSERT INTO reflection_records (
              record_id, lifecycle, structural_height,
              producer_policy_version, processing_generation
            ) VALUES (${recordId}, 'current', 0, 'm308', 1)
          `);
          await tx.execute(sql`
            INSERT INTO reflection_record_payload_representations (
              record_id, representation, representation_generation,
              plaintext_payload_bytes, crypto_object_id
            ) VALUES
              (${recordId}, 'ordinary', 1,
               convert_to('{"statement":"M308"}', 'UTF8'), NULL),
              (${recordId}, 'protected', 1, NULL, ${cryptoObjectId})
          `);
          await tx.execute(sql`
            INSERT INTO reflection_record_payload_representation_heads (
              record_id, representation, current_representation_generation
            ) VALUES (${recordId}, 'ordinary', 1), (${recordId}, 'protected', 1)
          `);
          await tx.execute(sql`
            INSERT INTO reflection_record_publications (
              publication_id, record_id, representation,
              representation_generation, request_commitment,
              publication_binding_ref, crypto_object_id, state,
              next_attempt_at, crypto_completed_at, product_attached_at,
              completed_at, created_at, updated_at
            ) VALUES (
              ${`m308:publication:${recordId}`}, ${recordId}, 'protected', 1,
              decode(repeat('44', 32), 'hex'), ${`m308:binding:${recordId}`},
              ${cryptoObjectId}, 'complete', NULL, ${now}, ${now}, ${now}, ${now}, ${now}
            )
          `);
          await tx.execute(sql`
            INSERT INTO reflection_record_authority_projections (
              record_id, projection_generation, source_change_generation,
              processing_state, audience_set_commitment, current
            ) VALUES (
              ${recordId}, 1, 1, 'current', decode(repeat('55', 32), 'hex'), true
            )
          `);
          await tx.execute(sql`
            INSERT INTO reflection_record_authority_alternatives (
              record_id, projection_generation, alternative_ordinal,
              access_namespace_id, alternative_commitment
            ) VALUES (
              ${recordId}, 1, 0, ${ids.namespaceA}, decode(repeat('66', 32), 'hex')
            )
          `);
        }

        await tx.execute(sql`
          SELECT set_config('nautilo.stenographer_writer_version', '2', true)
        `);
        await tx.execute(sql`
          INSERT INTO room_journal_batches (
            id, room_id, from_message_id_exclusive,
            through_message_id_inclusive, extractor_version,
            observation_publication_version, status, operation_count,
            completed_at
          ) VALUES (${ids.batch}, ${ids.roomA}, 0, 3, 'm308', 2,
                    'completed', 3, ${now})
        `);
        await tx.execute(sql`
          INSERT INTO room_events (
            id, room_id, sequence, kind, statement, status,
            source_message_ids, source_batch_id, batch_local_ordinal,
            extractor_version, projection_kind, record_id, native_attached_at
          ) VALUES
            (${ids.eventCoveredByPlaintextRollup}, ${ids.roomA}, 1, 'fact', NULL,
             'active', ARRAY[1], ${ids.batch}, 0, 'm308', 'native',
             ${ids.eventCoveredByPlaintextRollup}, ${now}),
            (${ids.eventCurrent}, ${ids.roomA}, 2, 'fact', NULL,
             'active', ARRAY[1], ${ids.batch}, 1, 'm308', 'native',
             ${ids.eventCurrent}, ${now}),
            (${ids.eventInactive}, ${ids.roomA}, 3, 'fact', NULL,
             'resolved', ARRAY[1], ${ids.batch}, 2, 'm308', 'native',
             ${ids.eventInactive}, ${now})
        `);
        await tx.execute(sql`
          INSERT INTO room_event_rollups (
            id, room_id, through_event_sequence, content,
            source_event_count, model_id, compactor_version
          ) VALUES (${ids.rollup}, ${ids.roomA}, 1, 'plaintext rollup', 1,
                    'm308-model', 'm308')
        `);

        const readable = [ids.namespaceA, ids.namespaceShared];
        expect(await readPersonalEncryptionCoverageFamily(tx, {
          family: "message", readableNamespaceIds: readable, userId: ids.userA,
        })).toEqual({
          family: "message", measurement: "measured", accessible: 6n,
          plaintextPresent: 6n, encryptedCounterpart: 4n,
        });
        expect(await readPersonalEncryptionCoverageFamily(tx, {
          family: "memory", readableNamespaceIds: readable, userId: ids.userA,
        })).toEqual({
          family: "memory", measurement: "measured", accessible: 4n,
          plaintextPresent: 3n, encryptedCounterpart: 2n,
        });
        expect(await readPersonalEncryptionCoverageFamily(tx, {
          family: "artifact", readableNamespaceIds: readable, userId: ids.userA,
        })).toEqual({
          family: "artifact", measurement: "measured", accessible: 1n,
          plaintextPresent: 1n, encryptedCounterpart: 0n,
        });
        expect(await readPersonalEncryptionCoverageFamily(tx, {
          family: "reflection_record", readableNamespaceIds: readable,
          userId: ids.userA,
        })).toEqual({
          family: "reflection_record", measurement: "measured", accessible: 3n,
          plaintextPresent: 3n, encryptedCounterpart: 3n,
        });
        expect(await readPersonalEncryptionCoverageFamily(tx, {
          family: "journal_event", readableNamespaceIds: readable, userId: ids.userA,
        })).toEqual({
          family: "journal_event", measurement: "measured", accessible: 2n,
          plaintextPresent: 2n, encryptedCounterpart: 1n,
        });
        expect(await readPersonalEncryptionCoverageFamily(tx, {
          family: "task", readableNamespaceIds: readable, userId: ids.userA,
        })).toEqual({
          family: "task", measurement: "unsupported", accessible: 1n,
          plaintextPresent: 1n,
        });

        throw new RollbackFixture();
      });
    } catch (error) {
      if (!(error instanceof RollbackFixture)) throw error;
    }
  });
});
