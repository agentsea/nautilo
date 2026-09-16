import { describe, expect, test } from "bun:test";

import {
  CryptoDatabaseConnectionUnavailableError,
  resolveCryptoDatabaseConnectionString,
} from "../../src/config/crypto-database";

describe("restricted crypto database connection resolution", () => {
  test("accepts only an explicit dedicated-role URL", () => {
    const value =
      "postgres://nautilo_crypto:crypto-secret@app-postgres:5432/nautilo";
    expect(resolveCryptoDatabaseConnectionString({
      DB_CRYPTO_CONNECTION_STRING: `  ${value}  `,
    })).toBe(value);
  });

  test("never derives the restricted role from product credentials", () => {
    expect(() => resolveCryptoDatabaseConnectionString({
      DB_CONNECTION_STRING:
        "postgres://nautilo:product-secret@app-postgres:5432/nautilo",
      NAUTILO_CRYPTO_DB_PASSWORD: "crypto-secret",
    })).toThrow(CryptoDatabaseConnectionUnavailableError);
  });

  test("rejects role substitution, missing password, wrong DB, and non-Postgres URLs", () => {
    for (const value of [
      "postgres://nautilo:crypto-secret@app-postgres:5432/nautilo",
      "postgres://nautilo_crypto@app-postgres:5432/nautilo",
      "postgres://nautilo_crypto:crypto-secret@app-postgres:5432/postgres",
      "https://nautilo_crypto:crypto-secret@app-postgres/nautilo",
      "not-a-url",
    ]) {
      expect(() => resolveCryptoDatabaseConnectionString({
        DB_CRYPTO_CONNECTION_STRING: value,
      })).toThrow(CryptoDatabaseConnectionUnavailableError);
    }
  });
});
