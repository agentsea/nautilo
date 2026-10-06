import { expect, test } from "bun:test";
import { PostgresGroundedDependencyRecordState } from "../../src/server/postgres-dependency-record-state";
import {
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresRow,
} from "../../src/server/product-postgres";

async function fixture(rows: readonly RecordProductPostgresRow[]) {
  const statements: string[] = [];
  const connection: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(statement: string) {
      if (statement.startsWith("SELECT current_user")) {
        return [{current_role: "nautilo", session_role: "nautilo"}] as unknown as readonly Row[];
      }
      statements.push(statement);
      return rows as readonly Row[];
    },
    transaction: callback => callback(connection),
  };
  return {state: new PostgresGroundedDependencyRecordState(await verifyRecordProductPostgresHandle(connection)), statements};
}

test("recovery reads canonical lifecycle and generation without payload bytes", async () => {
  const {state, statements} = await fixture([{lifecycle: "superseded", processing_generation: 4, disposition: "available"}]);
  expect(await state.readState("old-record")).toEqual({status: "available", lifecycle: "superseded", processingGeneration: 4, disposition: "available"});
  expect(statements[0]).not.toContain("payload");
});

test("recovery reports truncated successor sets instead of selecting an arbitrary successor", async () => {
  const {state} = await fixture([{successor_record_id: "a"}, {successor_record_id: "b"}, {successor_record_id: "c"}]);
  expect(await state.readSuccessors({recordRef: "old-record", limit: 2})).toEqual({status: "available", successorRecordRefs: ["a", "b"], complete: false});
});

test("a persisted protected grant restores only the logical Record coordinate", async () => {
  const {state, statements} = await fixture([{record_id: "logical-record"}]);
  expect(await state.readRecordRefForProtectedObject("old-object")).toBe("logical-record");
  expect(statements[0]).toContain('"representation"');
  expect(statements[0]).not.toContain('"payload_bytes"');
});

test("missing or ambiguous protected grant coordinates stay unavailable", async () => {
  for (const rows of [[], [{record_id: "a"}, {record_id: "b"}]]) {
    const {state} = await fixture(rows);
    expect(await state.readRecordRefForProtectedObject("unknown-object")).toBeNull();
  }
});
