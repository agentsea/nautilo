import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDirectDb,
  eq,
  getServerProviderPolicy,
  serverProviderPolicy,
  upsertServerProviderPolicy,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let blockerDb: DirectDatabase;
let writerDb: DirectDatabase;

beforeAll(() => {
  bootstrapTestDbInstance();
  blockerDb = createDirectDb(1);
  writerDb = createDirectDb(1);
});

afterAll(async () => {
  await Promise.all([blockerDb?.end(), writerDb?.end()]);
});

describe("server provider policy concurrent updates", () => {
  test("reports the committed value held behind another writer's row lock", async () => {
    const [original] = await blockerDb.select().from(serverProviderPolicy)
      .where(eq(serverProviderPolicy.id, "server"));
    await upsertServerProviderPolicy(blockerDb, { allowPersonalProviderKeys: false });

    let releaseLock: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseLock = resolve; });
    let signalLocked: () => void = () => {};
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const blocker = blockerDb.transaction(async (tx) => {
      await tx.select().from(serverProviderPolicy)
        .where(eq(serverProviderPolicy.id, "server"))
        .for("update");
      await tx.update(serverProviderPolicy)
        .set({ allowPersonalProviderKeys: true })
        .where(eq(serverProviderPolicy.id, "server"));
      signalLocked();
      await held;
    });

    try {
      await locked;
      const writer = upsertServerProviderPolicy(writerDb, { allowPersonalProviderKeys: false });
      // Let the independent connection reach the blocked row before release.
      await Bun.sleep(50);
      releaseLock();
      await blocker;
      expect(await writer).toEqual({
        previous: { allowPersonalProviderKeys: true },
        effective: { allowPersonalProviderKeys: false },
      });
      expect(await getServerProviderPolicy(writerDb)).toEqual({ allowPersonalProviderKeys: false });
    } finally {
      releaseLock();
      await blocker;
      if (original) {
        await upsertServerProviderPolicy(blockerDb, {
          allowPersonalProviderKeys: original.allowPersonalProviderKeys,
        });
      } else {
        await blockerDb.delete(serverProviderPolicy).where(eq(serverProviderPolicy.id, "server"));
      }
    }
  });
});
