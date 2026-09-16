/**
 * D487 canonical `manage_avatar` tool.
 *
 * The tool keeps the existing show → Human confirm → apply gate, but it owns
 * no files and never sees a blob id. The server installs one narrow port that
 * delegates generation and selection to AgentPhotoLibraryService.
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PRESET_AVATAR_ID_REGEX } from "@nautilo/types";

interface ManageAvatarContext {
  ownerId?: string;
  agentId?: string;
}

export interface ManageAvatarPhotoLibraryPort {
  current(input: { ownerId: string; agentId: string }): Promise<{
    selectionRevision: string;
  }>;
  generate(input: {
    ownerId: string;
    agentId: string;
    operationId: string;
    prompt: string;
    count: number;
  }): Promise<{
    selectionRevision: string;
    model: string;
    provider: string;
    candidates: Array<{
      entryId: string;
      thumbnailUrl: string;
      fullUrl: string;
    }>;
  }>;
  select(input: {
    ownerId: string;
    agentId: string;
    operationId: string;
    expectedSelectionRevision: string;
    target:
      { kind: "entry"; entryId: string } | { kind: "preset"; presetId: string };
  }): Promise<void>;
}

let photoLibraryPort: ManageAvatarPhotoLibraryPort | null = null;

/** Server-process composition root; null is used only to isolate tests. */
export function setManageAvatarPhotoLibraryPort(
  port: ManageAvatarPhotoLibraryPort | null,
): void {
  photoLibraryPort = port;
}

const DEFAULT_COUNT = 2;
const MIN_COUNT = 1;
const MAX_COUNT = 4;

export function clampAvatarCount(count: number | undefined): number {
  if (typeof count !== "number" || Number.isNaN(count)) return DEFAULT_COUNT;
  const rounded = Math.floor(count);
  if (rounded < MIN_COUNT) return MIN_COUNT;
  if (rounded > MAX_COUNT) return MAX_COUNT;
  return rounded;
}

export function createManageAvatarTool(context?: ManageAvatarContext) {
  return new DynamicStructuredTool({
    name: "manage_avatar",
    description: `Create and select the Agent's own profile photo.

Use the two-step show → ask → set gate:
1. Call "preview". Generated previews return owned entryIds and authorized media URLs; preset previews return a presetId. Preview never changes the current photo.
2. Show the choices and ask the Human. Only after they choose, call "apply" with the chosen entryId or presetId and the selectionRevision returned by preview.

Never ask the Human to paste an id. Never apply without confirmation. If the preview is no longer available, preview again.`,
    schema: z
      .object({
        action: z.enum(["preview", "apply"]),
        source: z.enum(["generate", "preset"]).optional(),
        prompt: z.string().min(1).max(500).optional(),
        count: z.number().int().min(MIN_COUNT).max(MAX_COUNT).optional(),
        presetId: z.string().optional(),
        entryId: z.string().uuid().optional(),
        expectedSelectionRevision: z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .optional(),
      })
      .strict(),
    func: async ({
      action,
      source,
      prompt,
      count,
      presetId,
      entryId,
      expectedSelectionRevision,
    }) => {
      try {
        const ownerId = context?.ownerId;
        const agentId = context?.agentId;
        if (!ownerId || !agentId)
          return "manage_avatar failed: no Agent authority in context.";
        const port = photoLibraryPort;
        if (!port)
          return "manage_avatar failed: Agent photo library is unavailable.";

        if (action === "preview") {
          const src = source ?? "generate";
          if (src === "preset") {
            if (!presetId || !PRESET_AVATAR_ID_REGEX.test(presetId)) {
              return "manage_avatar failed: invalid preset id.";
            }
            const current = await port.current({ ownerId, agentId });
            return JSON.stringify({
              action: "preview",
              source: "preset",
              selectionRevision: current.selectionRevision,
              candidates: [{ presetId }],
            });
          }
          if (!prompt)
            return "manage_avatar failed: a prompt is required for generate preview.";
          const result = await port.generate({
            ownerId,
            agentId,
            operationId: randomUUID(),
            prompt,
            count: clampAvatarCount(count),
          });
          return JSON.stringify({
            action: "preview",
            source: "generate",
            prompt,
            selectionRevision: result.selectionRevision,
            model: result.model,
            provider: result.provider,
            candidates: result.candidates,
          });
        }

        if (!expectedSelectionRevision) {
          return "manage_avatar failed: preview again before applying a photo.";
        }
        const target =
          source === "preset"
            ? presetId && PRESET_AVATAR_ID_REGEX.test(presetId)
              ? { kind: "preset" as const, presetId }
              : null
            : entryId
              ? { kind: "entry" as const, entryId }
              : null;
        if (!target)
          return "manage_avatar failed: choose a candidate from the preview.";
        await port.select({
          ownerId,
          agentId,
          operationId: randomUUID(),
          expectedSelectionRevision,
          target,
        });
        return target.kind === "preset"
          ? `Agent photo set to preset "${target.presetId}".`
          : "Agent photo updated from the owned photo library.";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `manage_avatar failed: ${message}`;
      }
    },
  });
}
