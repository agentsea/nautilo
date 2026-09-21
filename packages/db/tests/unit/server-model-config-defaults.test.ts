import { describe, expect, it, beforeEach } from "bun:test";
import type { ServerModelConfigRow } from "../../src/schema/server-model-config";
import {
  resolveServerModelConfig,
  upsertServerModelConfig,
  type ServerModelConfigDefaults,
  type ServerModelConfigDb,
} from "../../src/utils/server-model-config-queries";
import {
  getCachedServerModelConfigRow,
  primeServerModelConfigCache,
  __resetServerModelConfigCache,
} from "../../src/utils/server-model-config-cache";

const DEFAULTS: ServerModelConfigDefaults = {
  defaultChatModel: "anthropic:claude-sonnet-4-6",
  fallbackChain: [],
};

describe("resolveServerModelConfig", () => {
  it("applies defaults when the row is null", () => {
    expect(resolveServerModelConfig(null, DEFAULTS)).toEqual({
      defaultChatModel: "anthropic:claude-sonnet-4-6",
      conductorModel: "",
      stenographerModel: "",
      reflectionModel: "",
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: [],
      reasoningOutput: {},
      reasoningPolicy: { defaultEffort: null, overrides: {} },
    });
  });

  it("treats null conductorModel as inherit (empty string)", () => {
    const row: ServerModelConfigRow = {
      id: "server",
      defaultChatModel: "openai:gpt-5.4-2026-03-05",
      conductorModel: null,
      stenographerModel: null,
      reflectionModel: null,
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: ["openai:gpt-5.4-mini"],
      reasoningOutput: null,
      reasoningPolicy: null,
      updatedAt: new Date("2026-06-09T12:00:00.000Z"),
    };
    expect(resolveServerModelConfig(row, DEFAULTS)).toEqual({
      defaultChatModel: "openai:gpt-5.4-2026-03-05",
      conductorModel: "",
      stenographerModel: "",
      reflectionModel: "",
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: ["openai:gpt-5.4-mini"],
      reasoningOutput: {},
      reasoningPolicy: { defaultEffort: null, overrides: {} },
    });
  });

  it("passes through a fully populated row", () => {
    const row: ServerModelConfigRow = {
      id: "server",
      defaultChatModel: "openai:gpt-5.5-2026-04-23",
      conductorModel: "google:gemini-3.1-flash-lite-preview",
      stenographerModel: "openai:gpt-5.4-mini",
      reflectionModel: "anthropic:claude-haiku-4-5",
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: ["openai:gpt-5.4-mini", "openai:gpt-5.4-nano"],
      reasoningOutput: { "anthropic:claude-sonnet-4-6": false },
      reasoningPolicy: { defaultEffort: null, overrides: { "anthropic:claude-sonnet-4-6": "off" } },
      updatedAt: new Date("2026-06-09T12:00:00.000Z"),
    };
    expect(resolveServerModelConfig(row, DEFAULTS)).toEqual({
      defaultChatModel: "openai:gpt-5.5-2026-04-23",
      conductorModel: "google:gemini-3.1-flash-lite-preview",
      stenographerModel: "openai:gpt-5.4-mini",
      reflectionModel: "anthropic:claude-haiku-4-5",
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: ["openai:gpt-5.4-mini", "openai:gpt-5.4-nano"],
      reasoningOutput: { "anthropic:claude-sonnet-4-6": false },
      reasoningPolicy: { defaultEffort: null, overrides: { "anthropic:claude-sonnet-4-6": "off" } },
    });
  });
});

describe("upsertServerModelConfig", () => {
  it.each([null, "", "venice:text-embedding-3-small"])("round-trips embedding selection %s and reasoning output", async (embeddingModel) => {
    const stored = {
      id: "server",
      defaultChatModel: DEFAULTS.defaultChatModel,
      conductorModel: null,
      stenographerModel: null,
      reflectionModel: null,
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: [] as string[],
      reasoningOutput: { "anthropic:claude-sonnet-4-6": false },
      reasoningPolicy: null,
      updatedAt: new Date(),
    } satisfies ServerModelConfigRow;

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: ({
            set,
          }: {
            set: Partial<ServerModelConfigRow>;
          }) => {
            Object.assign(stored, set);
            return {
              returning: () => Promise.resolve([stored]),
            };
          },
        }),
      }),
    } as unknown as ServerModelConfigDb;

    const result = await upsertServerModelConfig(
      db,
      { embeddingModel, reasoningOutput: { "anthropic:claude-sonnet-4-6": false } },
      DEFAULTS,
    );
    expect(result.reasoningOutput).toEqual({ "anthropic:claude-sonnet-4-6": false });
    expect(result.embeddingModel).toBe(embeddingModel);
  });

  it("round-trips independent nullable and automatic media selections", async () => {
    const stored = {
      id: "server",
      defaultChatModel: DEFAULTS.defaultChatModel,
      conductorModel: null,
      stenographerModel: null,
      reflectionModel: null,
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: [] as string[],
      reasoningOutput: null,
      reasoningPolicy: null,
      updatedAt: new Date(),
    } satisfies ServerModelConfigRow;
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: ({ set }: { set: Partial<ServerModelConfigRow> }) => {
            Object.assign(stored, set);
            return { returning: () => Promise.resolve([stored]) };
          },
        }),
      }),
    } as unknown as ServerModelConfigDb;

    const result = await upsertServerModelConfig(db, {
      imageModel: "",
      musicModel: null,
      videoModel: "venice:seedance-2-5-text-to-video-basic",
    }, DEFAULTS);
    expect(result).toMatchObject({
      imageModel: "",
      musicModel: null,
      videoModel: "venice:seedance-2-5-text-to-video-basic",
    });
  });
});

describe("server model config cache", () => {
  beforeEach(() => {
    __resetServerModelConfigCache();
  });

  it("returns null before priming (consumers fall back)", () => {
    expect(getCachedServerModelConfigRow()).toBeNull();
  });

  it("write-through prime exposes the row to sync readers", () => {
    const row: ServerModelConfigRow = {
      id: "server",
      defaultChatModel: "openai:gpt-5.5-2026-04-23",
      conductorModel: null,
      stenographerModel: null,
      reflectionModel: null,
      memoryReviewModel: null,
      embeddingModel: null,
      imageModel: null,
      musicModel: null,
      videoModel: null, speechModel: null,
      fallbackChain: null,
      reasoningOutput: null,
      reasoningPolicy: null,
      updatedAt: new Date(),
    };
    primeServerModelConfigCache(row);
    expect(getCachedServerModelConfigRow()?.defaultChatModel).toBe(
      "openai:gpt-5.5-2026-04-23",
    );
    __resetServerModelConfigCache();
    expect(getCachedServerModelConfigRow()).toBeNull();
  });
});
