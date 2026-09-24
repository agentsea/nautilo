import { afterEach, describe, expect, test } from "bun:test";
import { clearToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { registerAllTools } from "../../src/tools/register-all";
import { createDiscoverToolsTool } from "../../src/tools/meta/discover-tools";
import { resolveIntentPacks } from "../../src/tools/exposure/manifest";
import {
  createGenerateVideoTool,
  createGenerateMusicTool,
  GenerateMusicSchema,
  PrepareVideoSchema,
  GenerateVideoSchema,
} from "../../src/tools/media/generate-media-entry";
import {
  resetMediaGenerationApprovalRuntimeForTests,
  setMediaGenerationApprovalRuntime,
} from "../../src/tools/media/media-generation-approval-runtime";
import { normalizeMediaGenerationIntent } from "../../src/media-generation";

const ORIGINAL_VENICE_API_KEY = process.env["VENICE_API_KEY"];

afterEach(() => {
  resetMediaGenerationApprovalRuntimeForTests();
  clearToolCatalog();
  if (ORIGINAL_VENICE_API_KEY !== undefined) {
    process.env["VENICE_API_KEY"] = ORIGINAL_VENICE_API_KEY;
  } else {
    delete process.env["VENICE_API_KEY"];
  }
});

describe("D525 paid media tool entry", () => {
  test("keeps unavailable registrations hidden from live catalog projections", () => {
    delete process.env["VENICE_API_KEY"];
    resetMediaGenerationApprovalRuntimeForTests();
    const defaultUnavailable = new ToolCatalog();
    registerAllTools(defaultUnavailable);
    expect(defaultUnavailable.has("generate_video")).toBe(true);
    expect(defaultUnavailable.has("generate_music")).toBe(true);
    expect(defaultUnavailable.query({}).map((entry) => entry.name)).not.toContain("generate_video");
    expect(defaultUnavailable.getFiltered().entries.map((entry) => entry.name)).not.toContain("generate_music");

    const unavailable = new ToolCatalog();
    registerAllTools(unavailable, { mediaGenerationAvailable: () => false });
    expect(unavailable.has("generate_video")).toBe(true);
    expect(unavailable.has("generate_music")).toBe(true);
    expect(unavailable.query({ category: "media" }).map((entry) => entry.name)).not.toContain("generate_video");
    expect(unavailable.getFiltered().entries.map((entry) => entry.name)).not.toContain("generate_music");

    const videoOnly = new ToolCatalog();
    registerAllTools(videoOnly, { mediaGenerationAvailable: (kind) => kind === "video" });
    expect(videoOnly.query({}).map((entry) => entry.name)).toContain("generate_video");
    expect(videoOnly.has("prepare_video")).toBe(false);
    expect(videoOnly.query({}).map((entry) => entry.name)).not.toContain("generate_music");
  });

  test("query and filtered projections track availability without re-registering tools", () => {
    let videoAvailable = false;
    let musicAvailable = false;
    const catalog = new ToolCatalog();
    registerAllTools(catalog, {
      mediaGenerationAvailable: (kind) => kind === "video" ? videoAvailable : musicAvailable,
    });
    const generation = catalog.currentGeneration;
    const visibleNames = () => ({
      query: catalog.query({}).map((entry) => entry.name),
      filtered: catalog.getFiltered().entries.map((entry) => entry.name),
    });

    expect(visibleNames().query).not.toContain("generate_video");
    expect(visibleNames().filtered).not.toContain("generate_music");
    videoAvailable = true;
    expect(visibleNames().query).toContain("generate_video");
    expect(visibleNames().filtered).toContain("generate_video");
    musicAvailable = true;
    expect(visibleNames().query).toContain("generate_music");
    expect(visibleNames().filtered).toContain("generate_music");
    videoAvailable = false;
    musicAvailable = false;
    expect(visibleNames().query).not.toContain("generate_video");
    expect(visibleNames().filtered).not.toContain("generate_music");
    expect(catalog.currentGeneration).toBe(generation);
  });

  test("the production probe requires an injected runtime and compatible active catalog rows", () => {
    process.env["VENICE_API_KEY"] = "test-key";
    setMediaGenerationApprovalRuntime({
      async prepare() { return { ok: false, code: "quote_unavailable", recovery: "Try again later." }; },
      async submit() { throw new Error("not used"); },
    });
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    expect(catalog.query({}).map((entry) => entry.name)).toContain("generate_video");
    expect(catalog.getFiltered().entries.map((entry) => entry.name)).toContain("generate_music");
  });

  test("registers discoverable destructive tools on the exact approval policy", () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { mediaGenerationAvailable: () => true });
    for (const name of ["generate_video", "generate_music"] as const) {
      expect(catalog.get(name)).toMatchObject({
        exposure: "discoverable",
        category: "media",
        trustTier: "standard",
        impact: "destructive",
        requiresApproval: true,
        approvalLevel: "prove_it",
        requiredCapabilities: ["use_media_generation", "use_server_provider_credentials"],
        resultScanPolicy: "never",
      });
    }
  });

  test("opens an unpaid reference workcard without requiring a pre-focused image", async () => {
    expect(PrepareVideoSchema.safeParse({
      action: "prepare",
      prompt: "[GOAL]\nThe workshop wakes.\n\n[REFERENCES]\n<Image 1> sets the illustrated crew.",
      durationSeconds: 12,
    }).success).toBe(true);
    const raw = await createGenerateVideoTool().invoke({
      action: "prepare",
      prompt: "The workshop wakes around an illustrated crew.",
      durationSeconds: 12,
      aspectRatio: "16:9",
      resolution: "720p",
      audio: true,
    });
    expect(JSON.parse(String(raw))).toEqual({
      kind: "video_generation_brief",
      version: 1,
      mode: "reference",
      model: "seedance-2-5-reference-to-video-basic",
      prompt: "The workshop wakes around an illustrated crew.",
      settings: { durationSeconds: 12, aspectRatio: "16:9", resolution: "720p", audio: true },
    });
  });

  test("returns actionable no-spend recovery for a mixed Advanced preparation envelope", async () => {
    const raw = await createGenerateVideoTool().invoke({
      action: "prepare",
      model: "seedance-2-5-text-to-video-basic",
      prompt: "A blue cube rotating in a clean studio.",
      durationSeconds: 4,
      aspectRatio: "16:9",
      resolution: "720p",
      audio: true,
      referenceImages: [],
      referenceVideos: [],
    });
    const result = JSON.parse(String(raw)) as Record<string, unknown>;
    const failure = result["failure"] as Record<string, unknown>;
    expect(result).toMatchObject({
      queueStarted: false,
      state: "failed",
      failure: {
        code: "MEDIA_GENERATION_INVALID_REQUEST",
      },
    });
    expect(String(failure["message"])).toContain('Call action="prepare" with prompt and settings only');
    expect(String(failure["message"])).toContain("No generation was started");
    expect(result["receiptId"]).toBeUndefined();
  });

  test("discovers and preactivates the Advanced workcard using the live user phrasing", async () => {
    const catalog = new ToolCatalog();
    registerAllTools(catalog, { mediaGenerationAvailable: () => true });
    initToolCatalog(catalog);
    const exact = String(await createDiscoverToolsTool().invoke({
      query: "Seedance reference-to-video attachment card focused image workflow",
    }));
    expect(exact).toContain('"name": "generate_video"');
    expect(exact).not.toContain('"name": "prepare_video"');

    const broad = String(await createDiscoverToolsTool().invoke({ query: "generate video" }));
    expect(broad).toContain('"name": "generate_video"');
    expect(resolveIntentPacks("Open Advanced reference-to-video for The Workshop Wakes.")).toMatchObject({
      families: ["voice_media"],
      reasons: ["explicit_media_generation"],
    });
  });

  test("uses one typed provider envelope while canonical intent validation stays model-specific", () => {
    expect(GenerateVideoSchema.safeParse({
      model: "seedance-2-5-text-to-video-basic",
      prompt: "A sailboat at dusk",
    }).success).toBe(true);
    expect(GenerateVideoSchema.safeParse({
      model: "seedance-2-5-text-to-video-basic",
      prompt: "A sailboat at dusk",
      providerUrl: "https://provider.example/queue",
    }).success).toBe(false);
    expect(GenerateVideoSchema.safeParse({
      model: "seedance-2-5-reference-to-video-basic",
      prompt: "Refer to the lighting in <Image 1>.",
      referenceImages: [{ path: "references/noir.png" }],
    }).success).toBe(true);
    expect(GenerateVideoSchema.safeParse({
      model: "seedance-2-5-reference-to-video-basic",
      prompt: "Use a reference.",
      referenceImages: [{ path: "references/noir.png", url: "https://provider.example/image" }],
    }).success).toBe(false);
    const minimaxWithAudio = {
      model: "minimax-h3-enhanced-text-to-video",
      prompt: "A sailboat at dusk",
      audio: false,
    } as const;
    expect(GenerateVideoSchema.safeParse(minimaxWithAudio).success).toBe(true);
    expect(() => normalizeMediaGenerationIntent(minimaxWithAudio)).toThrow("audio");
    const lyricsAndInstrumental = {
      model: "minimax-music-v26",
      prompt: "Warm analog synths with a slow nocturnal pulse",
      lyrics: "hello",
      forceInstrumental: true,
    } as const;
    expect(GenerateMusicSchema.safeParse(lyricsAndInstrumental).success).toBe(true);
    expect(() => normalizeMediaGenerationIntent(lyricsAndInstrumental)).toThrow("Instrumental music cannot include lyrics");
    expect(GenerateMusicSchema.safeParse({
      model: "sonilo-v1-1-music",
      prompt: "Quiet piano",
      queueId: "provider-queue",
    }).success).toBe(false);
    expect(GenerateVideoSchema.safeParse({ action: "render", prompt: "A sailboat" }).success).toBe(false);
  });

  test("a direct factory invocation cannot bypass prepared paid approval", async () => {
    const raw = await createGenerateMusicTool().invoke({
      model: "sonilo-v1-1-music",
      prompt: "Quiet piano",
    });
    const result = JSON.parse(String(raw)) as Record<string, unknown>;
    expect(result).toMatchObject({
      kind: "generated_media",
      version: 1,
      queueStarted: false,
      mediaKind: "audio",
      state: "failed",
      failure: { code: "APPROVAL_REQUIRED" },
    });
    expect(result["receiptId"]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("provider");
  });
});
