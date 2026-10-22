import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { sessionMessageCryptoRevisions } from "../../src/schema/session-message-crypto-revisions";

test("wake Room publication identity survives Task deletion and rejects a missing ordinal", () => {
  const config = getTableConfig(sessionMessageCryptoRevisions);
  const shape = config.checks.find(check => check.name === "session_message_crypto_revisions_task_wake_shape");
  expect(shape).toBeDefined();
  const sql = new PgDialect().sqlToQuery(shape!.value).sql;
  expect(sql).toContain('"shadow_transcript_ordinal" is not null');
  expect(sql).toContain('"shadow_transcript_ordinal" >= 2');
  expect(config.foreignKeys.flatMap(key => key.reference().columns.map(column => column.name)))
    .not.toContain("task_wake_operation_id");
  expect(config.indexes.some(index => index.config.name === "uq_session_message_crypto_revisions_task_wake_ordinal")).toBe(true);
});
