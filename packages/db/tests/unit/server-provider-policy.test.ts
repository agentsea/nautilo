import { describe, expect, test } from "bun:test";
import {
  getServerProviderPolicy,
  resolveServerProviderPolicy,
  upsertServerProviderPolicy,
  type ServerProviderPolicyDb,
} from "../../src";

function policyDb() {
  let stored: boolean | null = null;
  const db = {
    select: () => ({
      from: () => ({
        where: async () => stored === null ? [] : [{ allowPersonalProviderKeys: stored }],
      }),
    }),
    insert: () => ({
      values: (values: { allowPersonalProviderKeys: boolean }) => ({
        onConflictDoUpdate: ({ set }: { set: { allowPersonalProviderKeys: boolean } }) => ({
          returning: async () => {
            stored = set.allowPersonalProviderKeys ?? values.allowPersonalProviderKeys;
            return [{ allowPersonalProviderKeys: stored }];
          },
        }),
      }),
    }),
  } as unknown as ServerProviderPolicyDb;
  return db;
}

describe("server provider policy", () => {
  test("absence resolves off while a persisted choice survives later reads", async () => {
    const db = policyDb();
    expect(resolveServerProviderPolicy(null)).toEqual({ allowPersonalProviderKeys: false });
    expect(await getServerProviderPolicy(db)).toEqual({ allowPersonalProviderKeys: false });

    expect(await upsertServerProviderPolicy(db, { allowPersonalProviderKeys: true }))
      .toEqual({ allowPersonalProviderKeys: true });
    expect(await getServerProviderPolicy(db)).toEqual({ allowPersonalProviderKeys: true });

    expect(await upsertServerProviderPolicy(db, { allowPersonalProviderKeys: false }))
      .toEqual({ allowPersonalProviderKeys: false });
    expect(await getServerProviderPolicy(db)).toEqual({ allowPersonalProviderKeys: false });
    expect(await upsertServerProviderPolicy(db, { allowPersonalProviderKeys: false }))
      .toEqual({ allowPersonalProviderKeys: false });
  });

  test("a storage read failure never becomes a default-off success", async () => {
    const db = {
      select: () => ({ from: () => ({ where: async () => {
        throw new Error("database unavailable");
      } }) }),
    } as unknown as ServerProviderPolicyDb;
    const error = await getServerProviderPolicy(db).then(() => null, (cause: unknown) => cause);
    expect(error).toEqual(new Error("database unavailable"));
  });

  test("a write without a returned row is not reported as persisted", async () => {
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
    } as unknown as ServerProviderPolicyDb;
    const error = await upsertServerProviderPolicy(db, { allowPersonalProviderKeys: true })
      .then(() => null, (cause: unknown) => cause);
    expect(error).toEqual(new Error("Server provider policy write returned no row"));
  });
});
