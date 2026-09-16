import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { createUnboundMediaGenerationFailure } from "./media-generation-approval-runtime";

const ratios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const filename = z.string().trim().min(1).max(180)
  .refine((value) => !/[\\/\0\r\n]/u.test(value), "Filename cannot contain a path or newline.")
  .optional();

const COMMON_DESCRIPTION = `For ordinary generation, omit model to use the server default. Choose an explicit model only when requested by the user or needed for specific capabilities such as reference video or lyrics. This is a paid, asynchronous media action. Nautilo validates the exact settings and obtains an exact USD quote before showing a Once/Deny approval. Approval starts that exact request once; do not ask for a second confirmation. The result is a local generation card and Workspace receipt, not provider URLs or queue identifiers. Provider safety filters may still refuse a request; preserve the user's intent and follow the recovery shown by the card.`;

export const PrepareVideoSchema = z.object({
  action: z.literal("prepare"),
  prompt: z.string().trim().min(1).max(15_000),
  durationSeconds: z.number().int().min(4).max(30).default(10),
  aspectRatio: z.enum(ratios).default("16:9"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("720p"),
  audio: z.boolean().default(true),
  filename,
}).strict();

const referencePaths = z.array(z.object({
  path: z.string().trim().min(1).max(512),
}).strict());

// Provider tool schemas must have one coherent object root. Root unions are
// flattened by providers that require object-shaped tool inputs, which makes
// mutually exclusive model branches look combinable. This envelope validates
// field types and unknown keys; the media approval contract retains exact
// model-specific cross-field validation before quote or spend.
export const GenerateVideoSchema = z.object({
  action: z.enum(["generate", "prepare"]).default("generate")
    .describe('Use "generate" for ordinary paid video generation. Use "prepare" only for the no-spend Advanced reference workcard, without model or reference fields.'),
  model: z.enum([
    "seedance-2-5-text-to-video-basic",
    "seedance-2-5-reference-to-video-basic",
    "minimax-h3-enhanced-text-to-video",
  ]).optional().describe("Omit to use the server default. Each explicit model accepts only its documented settings."),
  prompt: z.string().trim().min(1).max(15_000),
  durationSeconds: z.number().int().optional(),
  aspectRatio: z.enum(ratios).optional(),
  resolution: z.enum(["480p", "720p", "1080p", "768P", "2K"]).optional(),
  audio: z.boolean().optional().describe("Seedance only; MiniMax H3 manages audio."),
  referenceImages: referencePaths.max(30).optional()
    .describe("Seedance reference execution only. For prepare, add images in the opened workcard instead."),
  referenceVideos: referencePaths.max(10).optional()
    .describe("Seedance reference execution only. For prepare, add videos in the opened workcard instead."),
  filename,
}).strict();

export const GenerateMusicSchema = z.object({
  model: z.enum(["sonilo-v1-1-music", "minimax-music-v26"]).optional()
    .describe("Omit to use the server default. Sonilo is duration-controlled and always instrumental; MiniMax supports lyrics or instrumental mode."),
  prompt: z.string().trim().min(1).max(4_096),
  durationSeconds: z.number().int().optional().describe("Sonilo only. MiniMax Music does not accept a requested duration."),
  lyrics: z.string().optional().describe("MiniMax Music only. Omit for instrumental music and for Sonilo."),
  forceInstrumental: z.boolean().optional().describe("MiniMax Music only. Sonilo is always instrumental."),
  filename,
}).strict();

function invalidVideoPreparation(message: string) {
  return JSON.stringify(createUnboundMediaGenerationFailure({
    toolName: "generate_video",
    code: "MEDIA_GENERATION_INVALID_REQUEST",
    message: `${message} No generation was started.`,
  }));
}

export function createGenerateVideoTool() {
  return new DynamicStructuredTool({
    name: "generate_video",
    description: `Create a video with Venice-hosted generation models. For ordinary text-to-video and every paid execution, set action="generate"; the server validates the exact settings, quotes it, and requests Once/Deny approval. Use action="prepare" only when the user wants the Advanced/reference workcard. That no-spend call uses a useful editable prompt draft and settings without model or reference fields, then opens a workcard where the user uploads/selects, orders, and removes up to 30 images. Never require a pre-focused image and never ask the user to type a path. When the workcard continues, call this same tool with action="generate", the completed Seedance reference model request, and authoritative ordered Workspace paths; that execution enters exact-quote Once/Deny approval. Prefer Seedance 2.5 for general/latest generation; use MiniMax H3 when its 2K tier or different rendering character materially fits the request. Honor an explicit model choice; when the tradeoff matters and the user did not choose, ask. Seedance 2.5 text and reference modes support 4–30 seconds, 480p/720p/1080p, and configurable audio. Reference execution accepts up to 30 ordered Workspace image paths and up to 10 ordered Workspace video paths, with at least one image or video required. <Image 1> maps to referenceImages[0]; <Video 1> maps to referenceVideos[0], and so on. Video-only references support continuation without requiring an extra image. Public Seedance may reject person-bearing reference media. MiniMax H3 supports 5–15 seconds, 768P/2K, with provider-managed audio. ${COMMON_DESCRIPTION}`,
    schema: GenerateVideoSchema,
    // InvocationService intercepts this name and executes only the exact
    // checkpoint-prepared approval. A direct call has no paid authority.
    func: (args) => {
      if ("action" in args && args.action === "prepare") {
        if (args.model !== undefined || args.referenceImages !== undefined || args.referenceVideos !== undefined) {
          return Promise.resolve(invalidVideoPreparation(
            'Advanced video preparation cannot include a generation model or reference paths. Call action="prepare" with prompt and settings only, then add references in the workcard.',
          ));
        }
        const prepared = PrepareVideoSchema.safeParse(args);
        if (!prepared.success) {
          return Promise.resolve(invalidVideoPreparation(
            "Review the Advanced video settings and try again.",
          ));
        }
        return Promise.resolve(JSON.stringify({
          kind: "video_generation_brief",
          version: 1,
          mode: "reference",
          model: "seedance-2-5-reference-to-video-basic",
          prompt: prepared.data.prompt,
          settings: {
            durationSeconds: prepared.data.durationSeconds,
            aspectRatio: prepared.data.aspectRatio,
            resolution: prepared.data.resolution,
            audio: prepared.data.audio,
          },
          ...(prepared.data.filename ? { filename: prepared.data.filename } : {}),
        }));
      }
      return Promise.resolve(JSON.stringify(createUnboundMediaGenerationFailure({
        toolName: "generate_video",
        code: "APPROVAL_REQUIRED",
        message: "Request a fresh exact quote before starting video generation.",
      })));
    },
  });
}

export function createGenerateMusicTool() {
  return new DynamicStructuredTool({
    name: "generate_music",
    description: `Generate music with a Venice-hosted generation model. Omit model to use the server's music default; specify a model when the user requests one or the required capabilities differ. Sonilo creates 1–600 seconds of instrumental music; MiniMax Music 2.6 supports a 10–300 character direction plus optional lyrics or instrumental-only output. ${COMMON_DESCRIPTION}`,
    schema: GenerateMusicSchema,
    // InvocationService intercepts this name and executes only the exact
    // checkpoint-prepared approval. A direct call has no paid authority.
    func: () => Promise.resolve(JSON.stringify(createUnboundMediaGenerationFailure({
      toolName: "generate_music",
      code: "APPROVAL_REQUIRED",
      message: "Request a fresh exact quote before starting music generation.",
    }))),
  });
}
