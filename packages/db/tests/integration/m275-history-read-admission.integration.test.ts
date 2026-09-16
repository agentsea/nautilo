import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  createDirectDb,
  ensureDatabase,
  resolveCryptoDatabaseConnectionString,
  resolveDirectAgentDatabaseConnectionString,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const TABLE = "encryption_transition_history_read_admissions";

function errorMessage(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    messages.push(
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : JSON.stringify(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.join("\ncaused by: ");
}

describe("M275 history-read admission role and lifecycle isolation", () => {
  let product: ReturnType<typeof createDirectDb> | undefined;
  let agent: ReturnType<typeof postgres> | undefined;
  let crypto: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    product = createDirectDb(1);
    agent = postgres(resolveDirectAgentDatabaseConnectionString(), {
      max: 1,
      prepare: false,
    });
    crypto = postgres(resolveCryptoDatabaseConnectionString(), {
      max: 1,
      prepare: false,
    });
  });

  afterAll(async () => {
    await Promise.all([
      product?.end(),
      agent?.end({ timeout: 1 }),
      crypto?.end({ timeout: 1 }),
    ]);
  });

  test("permits only the product role and enforces terminal monotonicity", async () => {
    if (product === undefined || agent === undefined || crypto === undefined) {
      throw new Error("M275 database role clients are unavailable");
    }
    const operationId = `history-read:${randomUUID()}`;
    const clientRequestKey = `request:${randomUUID()}`;
    const roomId = randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + 60_000);

    try {
      await product.execute(`
        INSERT INTO ${TABLE} (
          operation_id, client_request_key, policy_revision,
          subject_human_id, reader_device_id,
          reader_device_signing_key_generation, host_authorization_revision,
          room_id, selected_coordinate_digest, selected_count, eligible_count,
          token_digest,
          issued_at, expires_at, updated_at
        ) VALUES (
          '${operationId}', '${clientRequestKey}', 1,
          'human:m275-integration', 'browser:m275-integration', 1, 1,
          '${roomId}', decode(repeat('11', 32), 'hex'), 2, 2,
          decode(repeat('22', 32), 'hex'),
          '${now.toISOString()}', '${expires.toISOString()}',
          '${now.toISOString()}'
        )
      `);

      const productRows = await product.execute(
        `SELECT state FROM ${TABLE} WHERE operation_id = '${operationId}'`,
      ) as unknown as readonly { state: string }[];
      expect(productRows).toEqual([{ state: "planned" }]);

      for (const restricted of [agent, crypto]) {
        let caught: unknown;
        try {
          await restricted.unsafe(
            `SELECT operation_id FROM ${TABLE} WHERE operation_id = $1`,
            [operationId],
          );
        } catch (error) {
          caught = error;
        }
        expect(errorMessage(caught)).toMatch(/permission denied/u);
      }

      await product.execute(`
        UPDATE ${TABLE}
           SET token_digest = decode(repeat('33', 32), 'hex'),
               updated_at = '${new Date(now.getTime() + 1).toISOString()}'
         WHERE operation_id = '${operationId}'
      `);

      let identityMutation: unknown;
      try {
        await product.execute(`
          UPDATE ${TABLE}
             SET room_id = '${randomUUID()}',
                 updated_at = '${new Date(now.getTime() + 2).toISOString()}'
           WHERE operation_id = '${operationId}'
        `);
      } catch (error) {
        identityMutation = error;
      }
      expect(errorMessage(identityMutation)).toContain(
        "planned history-read admission may rotate only its token",
      );

      const terminalAt = new Date(now.getTime() + 3);
      await product.execute(`
        UPDATE ${TABLE}
           SET state = 'consumed',
               consumption_kind = 'signed_acknowledgement',
               acknowledgement_digest = decode(repeat('44', 32), 'hex'),
               ordered_result_set_digest = decode(repeat('55', 32), 'hex'),
               verified_count = 2,
               terminal_at = '${terminalAt.toISOString()}',
               updated_at = '${terminalAt.toISOString()}'
         WHERE operation_id = '${operationId}'
      `);

      let terminalMutation: unknown;
      try {
        await product.execute(`
          UPDATE ${TABLE}
             SET token_digest = decode(repeat('66', 32), 'hex')
           WHERE operation_id = '${operationId}'
        `);
      } catch (error) {
        terminalMutation = error;
      }
      expect(errorMessage(terminalMutation)).toContain(
        "terminal history-read admission is immutable",
      );
    } finally {
      await product.execute(
        `DELETE FROM ${TABLE} WHERE operation_id = '${operationId}'`,
      );
    }
  });

  test("the admission schema has no payload or Message inventory columns", async () => {
    if (product === undefined) {
      throw new Error("M275 product database client is unavailable");
    }
    const rows = await product.execute(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${TABLE}'
       ORDER BY ordinal_position
    `) as unknown as readonly { column_name: string }[];
    const columns = rows.map((row) => row.column_name);
    for (const forbidden of [
      "content",
      "plaintext",
      "ciphertext",
      "content_digest",
      "message_id",
      "session_id",
      "namespace_id",
      "signature",
    ]) expect(columns).not.toContain(forbidden);
  });
});
