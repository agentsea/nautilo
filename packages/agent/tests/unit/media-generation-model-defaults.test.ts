import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { primeServerModelConfigCache, type ServerModelConfigRow } from "@nautilo/db";
import { configureRuntimeModelCatalog, resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { getDefaultMediaGenerationModel, listMediaGenerationModels, withMediaGenerationDefault } from "../../src/config/media-generation-models";
import { getDefaultImageModel } from "../../src/config/image-models";
import { GenerateMusicSchema, GenerateVideoSchema } from "../../src/tools/media/generate-media-entry";
import { createMediaGenerationPreparedApproval, prepareMediaGenerationApproval, resetMediaGenerationApprovalRuntimeForTests, setMediaGenerationApprovalRuntime } from "../../src/tools/media/media-generation-approval-runtime";

const previousSkip = process.env["NAUTILO_SKIP_VENICE_REFRESH"];
const previousVenice = process.env["VENICE_API_KEY"];
const stored = (patch: Partial<ServerModelConfigRow> = {}): ServerModelConfigRow => ({
  id: "server", defaultChatModel: null, conductorModel: null, stenographerModel: null,
  reflectionModel: null, memoryReviewModel: null, embeddingModel: null,
  imageModel: null, musicModel: null, videoModel: null,
  fallbackChain: null, reasoningOutput: null, reasoningPolicy: null, updatedAt: new Date(), ...patch,
});
beforeEach(() => {
  process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
  configureRuntimeModelCatalog({ catalogPointerUrl: null });
  primeServerModelConfigCache(null);
});
afterEach(() => {
  primeServerModelConfigCache(null);
  resetRuntimeModelCatalog();
  resetMediaGenerationApprovalRuntimeForTests();
  if (previousSkip === undefined) delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
  else process.env["NAUTILO_SKIP_VENICE_REFRESH"] = previousSkip;
  if (previousVenice === undefined) delete process.env["VENICE_API_KEY"];
  else process.env["VENICE_API_KEY"] = previousVenice;
});

describe("server media generation defaults", () => {
  test("automatic image selection prefers Venice then OpenRouter then OpenAI then Google", () => {
    const env: NodeJS.ProcessEnv = { VENICE_API_KEY: "test", OPENROUTER_API_KEY: "test", OPENAI_API_KEY: "test", GOOGLE_API_KEY: "test" };
    expect(getDefaultImageModel(env).provider).toBe("venice");
    delete env["VENICE_API_KEY"];
    expect(getDefaultImageModel(env).provider).toBe("openrouter");
    delete env["OPENROUTER_API_KEY"];
    expect(getDefaultImageModel(env).provider).toBe("openai");
    delete env["OPENAI_API_KEY"];
    expect(getDefaultImageModel(env).provider).toBe("google");
  });

  test("stored override wins over env; null inherits and empty selects automatic", () => {
    const env = { VENICE_API_KEY: "test", NAUTILO_IMAGE_MODEL: "venice:seedream-v5-pro" };
    expect(getDefaultImageModel(env).id).toBe("venice:seedream-v5-pro");
    primeServerModelConfigCache(stored({ imageModel: "venice:grok-imagine-image-quality" }));
    expect(getDefaultImageModel(env).id).toBe("venice:grok-imagine-image-quality");
    primeServerModelConfigCache(stored({ imageModel: "" }));
    expect(getDefaultImageModel(env).id).toBe("venice:gpt-image-2");
    primeServerModelConfigCache(stored({ imageModel: null }));
    expect(getDefaultImageModel(env).id).toBe("venice:seedream-v5-pro");
  });

  test("unavailable or wrong-family selection fails rather than switching providers", () => {
    primeServerModelConfigCache(stored({ imageModel: "venice:gpt-image-2" }));
    expect(() => getDefaultImageModel({ OPENAI_API_KEY: "test" })).toThrow("unavailable");
    primeServerModelConfigCache(stored({ musicModel: "venice:gpt-image-2" }));
    expect(() => getDefaultMediaGenerationModel("music", { VENICE_API_KEY: "test" })).toThrow("Unknown configured music model");
  });

  test("generic video defaults exclude reference-only and unsupported models", () => {
    const options = listMediaGenerationModels("video", { VENICE_API_KEY: "test" });
    expect(options.map((model) => model.id)).toEqual([
      "venice:seedance-2-5-text-to-video-basic", "venice:minimax-h3-enhanced-text-to-video",
    ]);
    expect(listMediaGenerationModels("music", {}).every((model) => !model.enabled)).toBe(true);
  });

  test("explicit media choices are preserved; missing model is accepted without guessing model-specific defaults", () => {
    const explicit = { model: "minimax-music-v26", prompt: "A lyrical song" };
    expect(withMediaGenerationDefault("music", explicit)).toBe(explicit);
    expect(GenerateMusicSchema.parse({ prompt: "A song" })).toEqual({ prompt: "A song" });
    expect(GenerateVideoSchema.parse({ prompt: "A landscape" })).toEqual({ action: "generate", prompt: "A landscape" });
    // The provider envelope accepts typed optional fields; the selected
    // model's canonical validator applies their cross-field meaning.
    expect(GenerateVideoSchema.safeParse({ prompt: "A landscape", referenceImages: [{ path: "image.png" }] }).success).toBe(true);
  });

  test("a quoted default is frozen across replay and a subsequent request uses the changed default", async () => {
    process.env["VENICE_API_KEY"] = "test";
    primeServerModelConfigCache(stored({ musicModel: "venice:sonilo-v1-1-music" }));
    let quoted = 0;
    setMediaGenerationApprovalRuntime({
      async prepare(actor, preparation) {
        quoted++;
        return { ok: true, prepared: createMediaGenerationPreparedApproval({ actor, preparation,
          receiptId: "mg_1234567890abcdef", quoteUsdMicros: 100_000, expiresAt: "2099-01-01T00:00:00.000Z" }) };
      },
      async submit() { throw new Error("No paid calls in unit tests"); },
    });
    const input = { actor: { userId: "user", roomId: "room", agentId: "agent" }, intent: { prompt: "Gentle piano melody" },
      toolName: "generate_music" as const, approvalId: "approval", threadId: "thread", turnId: "turn", laneKey: "lane", toolCallId: "call" };
    const first = await prepareMediaGenerationApproval(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.prepared.request.model).toBe("sonilo-v1-1-music");
    primeServerModelConfigCache(stored({ musicModel: "venice:minimax-music-v26" }));
    expect(await prepareMediaGenerationApproval(input)).toEqual(first);
    expect(quoted).toBe(1);
    const next = await prepareMediaGenerationApproval({ ...input, approvalId: "next" });
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.prepared.request.model).toBe("minimax-music-v26");
    const changed = await prepareMediaGenerationApproval({ ...input, intent: { prompt: "Changed request" } });
    expect(changed.ok).toBe(false);
  });
});
