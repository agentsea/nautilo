import { expect, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow } from "@nautilo/db";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";
import { verifyCryptoPostgresHandle, type CryptoPostgresHandle } from "../../src/server/storage/postgres-lattice-storage.ts";
import {
  readTaskContentCryptoObjectPage, readTaskContentCryptoStagingPage,
  type TaskContentCryptoStagingKind,
} from "../../src/server/task/postgres-task-content-publication-inventory.ts";

async function fixture() {
  const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const connection: PostgresJsBridgeConnection = {
    query: <Row extends PostgresJsBridgeRow>(sql: string, parameters: readonly unknown[] = []) => {
      const rows = sql.includes("current_user")
        ? [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }]
        : [{ object_id: "object", crypto_object_id: "object", request_id: "request" }];
      if (!sql.includes("current_user")) queries.push({ sql, parameters });
      return Promise.resolve(rows as unknown as readonly Row[]);
    },
    transaction: use => use(connection),
    transactionOnce: use => use(connection),
  };
  return { handle: await verifyCryptoPostgresHandle(connection), queries };
}

test("object inventory selects only identifiers with bounded keyset and closed Task families", async () => {
  const { handle, queries } = await fixture();
  expect(await readTaskContentCryptoObjectPage(handle, "previous")).toEqual([
    { cursor: "object", objectId: "object" },
  ]);
  const query = queries[0]!;
  expect(query.sql).toContain('from "crypto_objects"');
  expect(query.sql).toContain('"object_id" >');
  expect(query.sql).toContain('order by "crypto_objects"."object_id" asc');
  expect(query.parameters).toEqual([
    "task-definition:v1:%", "task-run-result:v1:%", "task-historical:v1:%",
    "previous", LATTICE_LIMITS.batchItems,
  ]);
  expect(query.sql).not.toContain('"ciphertext"');
  expect(query.sql).not.toContain('"payload_bytes"');
  expect(query.sql).not.toContain("for update");
});

test("staging inventory separates raw and terminal receipts and uses each stable cursor", async () => {
  for (const kind of ["cancellation", "terminal_message", "result_message", "historical"] as const) {
    const { handle, queries } = await fixture();
    const result = await readTaskContentCryptoStagingPage(handle, kind, "previous");
    expect(result).toEqual([{ cursor: kind === "historical" ? "object" : "request", objectId: "object" }]);
    const query = queries[0]!;
    const tables: Record<TaskContentCryptoStagingKind, string> = {
      cancellation: "task_cancellation_crypto_staging_receipts",
      terminal_message: "task_terminal_message_crypto_staging_receipts",
      result_message: "task_terminal_message_crypto_staging_receipts",
      historical: "task_historical_content_crypto_staging_receipts",
    };
    expect(query.sql).toContain(`from "${tables[kind]}"`);
    expect(query.parameters).toEqual(["previous", LATTICE_LIMITS.batchItems]);
    if (kind === "terminal_message" || kind === "result_message") {
      expect(query.sql).toContain(`"raw_result_message_intent" is ${kind === "result_message" ? "not " : ""}null`);
    }
    const selection = query.sql.split(" from ")[0]!;
    expect(selection).not.toContain("raw_result_message_intent");
    expect(selection).not.toContain("genesis_manifest_hash");
    expect(query.sql).not.toContain("for update");
  }
});

test("inventory rejects an unverified handle before querying", async () => {
  let queried = false;
  const forged = { query: () => { queried = true; return Promise.resolve([]); } } as unknown as CryptoPostgresHandle;
  for (const read of [() => readTaskContentCryptoObjectPage(forged, null),
    () => readTaskContentCryptoStagingPage(forged, "cancellation", null)]) {
    let failure: unknown;
    try { await read(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TypeError);
  }
  expect(queried).toBe(false);
});
