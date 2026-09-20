import { expect, test } from "bun:test";
import { resolveServerModelConfig, upsertServerModelConfig, type ServerModelConfigDb } from "../../src/utils/server-model-config-queries";
import { resolveServerContextConfig, upsertServerContextConfig, type ServerContextConfigDb } from "../../src/utils/server-context-config-queries";
import type { ServerModelConfigRow } from "../../src/schema/server-model-config";

const defaults = { defaultChatModel: "test:chat", fallbackChain: [] };

test("unset Memory overrides preserve runtime ownership instead of inheriting chat policy", () => {
  expect(resolveServerModelConfig(null, defaults).memoryReviewModel).toBeNull();
  expect(resolveServerContextConfig(null).memoryReviewEnabled).toBeNull();
  const row: ServerModelConfigRow = {
    id: "server", defaultChatModel: "test:chat", conductorModel: null, embeddingModel: null,
    imageModel: null, musicModel: null, videoModel: null, speechModel: null,
    stenographerModel: null, reflectionModel: null, memoryReviewModel: "test:review",
    fallbackChain: [], reasoningOutput: null, reasoningPolicy: null, updatedAt: new Date(),
  };
  expect(resolveServerModelConfig(row, defaults).memoryReviewModel).toBe("test:review");
  expect(resolveServerContextConfig({ recentConversationLimit: 50, minimumFullTurns: 1,
    maxRoomContextPercent: 50, stenographerPriorConversationLimit: 10,
    memoryReviewEnabled: false }).memoryReviewEnabled).toBe(false);
});

test("nullable overrides update only owned columns including reset to inherited policy", async () => {
  const updates: Record<string, unknown>[] = [];
  const fake = {
    insert: () => ({ values: () => ({ onConflictDoUpdate: (input: { set: Record<string, unknown> }) => {
      updates.push(input.set);
      return { returning: async () => [] };
    } }) }),
  };
  await upsertServerModelConfig(fake as unknown as ServerModelConfigDb, { memoryReviewModel: null }, defaults);
  await upsertServerContextConfig(fake as unknown as ServerContextConfigDb, { memoryReviewEnabled: false });
  await upsertServerContextConfig(fake as unknown as ServerContextConfigDb, { memoryReviewEnabled: null });
  expect(updates.map(row => Object.keys(row).sort())).toEqual([
    ["memoryReviewModel", "updatedAt"], ["memoryReviewEnabled", "updatedAt"], ["memoryReviewEnabled", "updatedAt"],
  ]);
  expect(updates.map(row => row["memoryReviewEnabled"])).toEqual([undefined, false, null]);
});
