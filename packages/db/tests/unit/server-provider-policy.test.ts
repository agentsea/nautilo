import { describe, expect, test } from "bun:test";
import {
  getServerProviderPolicy,
  resolveServerProviderPolicy,
  upsertServerProviderPolicy,
  type Database,
} from "../../src";

function policyDb(options: { returnWrittenRow?: boolean } = {}) {
  let stored: {
    allowPersonalProviderKeys: boolean;
    fundingPreference: "personal_first" | "server_first";
  } | null = null;
  const operations: string[] = [];
  const tx = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => {
          operations.push("seed");
          stored ??= {
            allowPersonalProviderKeys: false,
            fundingPreference: "personal_first",
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (mode: string) => {
            operations.push(`read:${mode}`);
            return stored === null ? [] : [stored];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: {
        allowPersonalProviderKeys?: boolean;
        fundingPreference?: "personal_first" | "server_first";
      }) => ({
        where: () => ({
          returning: async () => {
            operations.push("write");
            if (options.returnWrittenRow === false) return [];
            stored = { ...stored!, ...patch };
            return [stored];
          },
        }),
      }),
    }),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: async () => stored === null ? [] : [stored],
      }),
    }),
    transaction: async <T>(operation: (handle: typeof tx) => Promise<T>) => {
      operations.push("begin");
      const result = await operation(tx);
      operations.push("commit");
      return result;
    },
  } as unknown as Database;
  return { db, operations };
}

describe("server provider policy", () => {
  test("absence resolves off and writes return the locked previous value", async () => {
    const { db, operations } = policyDb();
    expect(resolveServerProviderPolicy(null)).toEqual({
      allowPersonalProviderKeys: false,
      fundingPreference: "personal_first",
    });
    expect(await getServerProviderPolicy(db)).toEqual({
      allowPersonalProviderKeys: false,
      fundingPreference: "personal_first",
    });

    expect(await upsertServerProviderPolicy(db, { allowPersonalProviderKeys: true }))
      .toEqual({
        previous: { allowPersonalProviderKeys: false, fundingPreference: "personal_first" },
        effective: { allowPersonalProviderKeys: true, fundingPreference: "personal_first" },
      });
    expect(await getServerProviderPolicy(db)).toEqual({
      allowPersonalProviderKeys: true,
      fundingPreference: "personal_first",
    });

    expect(await upsertServerProviderPolicy(db, { fundingPreference: "server_first" }))
      .toEqual({
        previous: { allowPersonalProviderKeys: true, fundingPreference: "personal_first" },
        effective: { allowPersonalProviderKeys: true, fundingPreference: "server_first" },
      });

    expect(await upsertServerProviderPolicy(db, { allowPersonalProviderKeys: false }))
      .toEqual({
        previous: { allowPersonalProviderKeys: true, fundingPreference: "server_first" },
        effective: { allowPersonalProviderKeys: false, fundingPreference: "server_first" },
      });
    expect(await getServerProviderPolicy(db)).toEqual({
      allowPersonalProviderKeys: false,
      fundingPreference: "server_first",
    });
    expect(await upsertServerProviderPolicy(db, { allowPersonalProviderKeys: false }))
      .toEqual({
        previous: { allowPersonalProviderKeys: false, fundingPreference: "server_first" },
        effective: { allowPersonalProviderKeys: false, fundingPreference: "server_first" },
      });
    const mutationOperations = ["begin", "seed", "read:update", "write", "commit"];
    expect(operations).toEqual([
      ...mutationOperations,
      ...mutationOperations,
      ...mutationOperations,
      ...mutationOperations,
    ]);
  });

  test("rejects an empty update before opening a transaction", async () => {
    const { db, operations } = policyDb();
    const error = await upsertServerProviderPolicy(db, {})
      .then(() => null, (cause: unknown) => cause);
    expect(error).toEqual(new Error("Server provider policy update must not be empty"));
    expect(operations).toEqual([]);
  });

  test("a storage read failure never becomes a default-off success", async () => {
    const db = {
      select: () => ({ from: () => ({ where: async () => {
        throw new Error("database unavailable");
      } }) }),
    } as unknown as Database;
    const error = await getServerProviderPolicy(db).then(() => null, (cause: unknown) => cause);
    expect(error).toEqual(new Error("database unavailable"));
  });

  test("a write without a returned row is not reported as persisted", async () => {
    const { db } = policyDb({ returnWrittenRow: false });
    const error = await upsertServerProviderPolicy(db, { allowPersonalProviderKeys: true })
      .then(() => null, (cause: unknown) => cause);
    expect(error).toEqual(new Error("Server provider policy write returned no row"));
  });
});
