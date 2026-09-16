import {describe, expect, test} from "bun:test";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {seededRng} from "@nautilo/lattice-crypto/testing";
import {readPostgresReflectionAuthoritySavedOutput} from "../../src/server/reflection/postgres-authority-recovery.ts";
import {verifyCryptoPostgresHandle, type CryptoPostgresConnection, type CryptoPostgresExecutor} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {DatabaseRow, DatabaseScalar} from "../../src/server/storage/postgres-record-codecs.ts";

describe("Reflection saved authority output metadata", () => {
  test("returns absent without a key resolver and shares one actual transaction across authenticated readers", async () => {
    let transactions = 0;
    const sql: string[] = [];
    const connection: CryptoPostgresConnection = {
      query<Row extends DatabaseRow>(statement: string, _parameters?: readonly DatabaseScalar[]): Promise<readonly Row[]> {
        sql.push(statement);
        return Promise.resolve(statement.includes("current_user::text")
          ? [{current_user: "nautilo_crypto", session_user: "nautilo_crypto"}] as unknown as readonly Row[] : []);
      },
      transaction<Value>(use: (tx: CryptoPostgresExecutor) => Promise<Value>) {transactions++; return use(connection);},
    };
    const handle = await verifyCryptoPostgresHandle(connection);
    expect(await readPostgresReflectionAuthoritySavedOutput({handle, crypto: new LatticeCrypto(seededRng(327)), objectId: "absent"})).toBeNull();
    expect(transactions).toBe(1);
    expect(sql.some(statement => statement.includes('from "crypto_objects"'))).toBe(true);
    expect(sql.some(statement => statement.includes("reflection_records"))).toBe(false);
  });
  test("partial ciphertext/head state is integrity failure rather than an absent publication", async () => {
    const connection: CryptoPostgresConnection = {
      query<Row extends DatabaseRow>(statement: string, _parameters?: readonly DatabaseScalar[]): Promise<readonly Row[]> {
        const rows = statement.includes("current_user::text") ? [{current_user: "nautilo_crypto", session_user: "nautilo_crypto"}]
          : statement.includes('from "crypto_objects"') ? [{object_id: "partial", payload_hash: new Uint8Array(32), payload_bytes: new Uint8Array(1)}] : [];
        return Promise.resolve(rows as unknown as readonly Row[]);
      },
      transaction<Value>(use: (tx: CryptoPostgresExecutor) => Promise<Value>) {return use(connection);},
    };
    const handle = await verifyCryptoPostgresHandle(connection);
    const failure = await readPostgresReflectionAuthoritySavedOutput({handle, crypto: new LatticeCrypto(seededRng(328)), objectId: "partial"})
      .then(() => null, (cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain("partial durable state");
  });
});
