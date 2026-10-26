import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import { verifyCryptoPostgresHandle } from "../../src/server/storage/postgres-lattice-storage.ts";
import { readStagedTaskTerminalMessagePublicationPolicy } from "../../src/server/task/postgres-task-terminal-message-staging.ts";
import type { DatabaseRow } from "../../src/server/storage/postgres-record-codecs.ts";

const expected = { requestId: "task-run-delivery-message-authorization:11111111-1111-4111-8111-111111111111",
  objectId: `message:v2:${"a".repeat(64)}`, acceptedPolicyRevision: 7 };
const receipt = { request_id: expected.requestId, crypto_object_id: expected.objectId,
  accepted_policy_revision: 7, publication_policy_revision: 8 };

async function read(rows: readonly DatabaseRow[]) {
  const connection = {
    query: async (statement: string, parameters?: readonly unknown[]) => {
      if (statement.includes("current_user")) return [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      expect(statement).toContain('"task_terminal_message_crypto_staging_receipts"');
      expect(statement).not.toMatch(/ciphertext|payload|authorization_digest|private_key/u);
      expect(parameters).toEqual([expected.requestId, expected.objectId, 2]);
      return rows;
    },
  } as unknown as PostgresJsBridgeConnection;
  return readStagedTaskTerminalMessagePublicationPolicy(await verifyCryptoPostgresHandle(connection), expected);
}

describe("terminal Message retained policy reconstruction", () => {
  test("reads the exact immutable policy without requiring a retained request", async () => {
    expect(await read([receipt])).toBe(8);
    expect(await read([{ ...receipt, publication_policy_revision: "8" }])).toBe(8);
    expect(await read([])).toBeNull();
  });
  test.each([
    { request_id: "other" }, { crypto_object_id: `message:v2:${"b".repeat(64)}` },
    { accepted_policy_revision: 6 }, { publication_policy_revision: 6 },
    { publication_policy_revision: Number.MAX_SAFE_INTEGER + 1 },
    { publication_policy_revision: "8.1" }, { publication_policy_revision: null },
  ])("rejects conflicting or invalid metadata %j", async patch => {
    const result = await Promise.allSettled([read([{ ...receipt, ...patch }])]);
    expect(result[0]?.status).toBe("rejected");
  });
  test("rejects a cross-coordinate duplicate receipt", async () => {
    expect((await Promise.allSettled([read([receipt, receipt])]))[0]?.status).toBe("rejected");
  });
});
