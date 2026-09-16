/**
 * D113 / M088B — generate images via OpenAI / Google adapters and persist
 * them as first-class workspace artifacts.
 *
 * Bytes land under the server-owned artifact root
 * (`getArtifactsRoot()`, default `~/.nautilo/artifacts/`). The tool no
 * longer reads any client-supplied `workspaceRoot`. Each generated
 * image inserts an `artifacts` row + `artifact_namespaces` junction
 * row pinned to the envelope's `writableNamespaces[0]` so the image is
 * visible via the canonical `file({zone:"workspace"})` path and the
 * Workspace tab.
 *
 * The tool's result envelope returns the stable `artifactId` plus the
 * logical workspace path. Absolute filesystem paths are NOT exposed
 * to the agent — server byte placement is an implementation detail
 * the agent doesn't get to learn (closes the local-vs-Droplet gap).
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { mkdir, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { log, warn } from "@nautilo/logger";
import { getArtifactsRoot } from "@nautilo/config";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  getDefaultImageModel,
  getImageModel,
  type ImageModelConfig,
} from "../../config/image-models";
import { resolveProviderKey } from "../../resolve-provider-key";
import { generateImages } from "../../image-gen";
import {
  applyWorkspaceArtifactRowChange,
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
  type WorkspaceArtifactPatchMeta,
} from "../file/artifact-store";

interface GenerateImageContext {
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
}

function contextFromUnknown(ctx: unknown): GenerateImageContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const envRaw = c["memoryAccessEnvelope"];
  const envelope =
    envRaw && typeof envRaw === "object"
      ? (envRaw as MemoryAccessEnvelope)
      : null;
  return { memoryAccessEnvelope: envelope };
}

const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(4000).describe("Description of the image to generate."),
  count: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe("Number of variations (1–4). Each is saved as a separate file."),
  size: z
    .enum(["1024x1024", "1024x1536", "1536x1024", "auto"])
    .default("auto")
    .describe('Square ("1024x1024"), portrait ("1024x1536"), landscape ("1536x1024"), or "auto".'),
  quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
  background: z.enum(["transparent", "opaque", "auto"]).default("auto"),
  format: z.enum(["png", "webp", "jpeg"]).default("png"),
  filename: z
    .string()
    .optional()
    .describe("Optional base name without extension. Default: slugified prompt + short id."),
  model: z
    .string()
    .optional()
    .describe('Optional override (e.g. "openai:gpt-image-2.5-sunburst", "openai:gpt-image-2.5-flare", "google:gemini-2.5-flash-image").'),
});

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "image"
  );
}

function extForFormat(fmt: z.infer<typeof GenerateImageSchema>["format"]): string {
  if (fmt === "jpeg") return "jpg";
  return fmt;
}

function mimeForFormat(fmt: z.infer<typeof GenerateImageSchema>["format"]): string {
  if (fmt === "jpeg") return "image/jpeg";
  if (fmt === "webp") return "image/webp";
  return "image/png";
}

export function createGenerateImageTool(context?: unknown) {
  const ctx = contextFromUnknown(context);
  return new DynamicStructuredTool({
    name: "generate_image",
    description: `Generate 1–4 images from a text prompt and save them as workspace artifacts under generated-images/<YYYY-MM-DD>/. They appear in the Workspace tab and can be re-read with file({command:"read", zone:"workspace", path:"generated-images/.../foo.png"}).
Default model follows the server catalog (typically OpenAI gpt-image-2.5-sunburst). Optional model override with full Nautilo id (e.g. openai:gpt-image-2.5-flare or google:gemini-2.5-flash-image).
Provider filters are at minimum strength (OpenAI moderation low; Gemini safety BLOCK_NONE). Refusals may still occur from account-level provider policy.

Returns a JSON envelope with the shape:
  { images: [{ artifactId, path, zone, mime, bytes }, ...], model, provider, prompt }
where 'artifactId' is the stable external id (use it with share_artifact / file zone="workspace") and 'path' is the workspace-relative POSIX path (e.g. "generated-images/2026-05-08/red-square-01.png"). Absolute filesystem paths are NOT returned — bytes live under the server-owned artifact root and are addressed by artifactId + logical path.

When telling the user where the images are, ALWAYS use the exact 'path' value verbatim from the result envelope. Refer to them as living in the user's Workspace tab — do NOT print absolute paths, do NOT abbreviate filenames with ellipses, do NOT invent slugs. The workbench already renders the gallery with thumbnails inline; your reply only needs to acknowledge what was generated and where, briefly.`,
    schema: GenerateImageSchema,
    func: async (args) => {
      let modelEntry: ImageModelConfig | undefined;
      try {
        modelEntry = args.model
          ? getImageModel(args.model)
          : getDefaultImageModel();
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "no image model is available"}`;
      }
      if (!modelEntry) {
        return `Error: unknown image model "${args.model}".`;
      }
      if (!modelEntry.enabled) {
        return (
          `Error: image model "${modelEntry.id}" is unavailable: `
          + `${modelEntry.unavailableReason ?? "catalog row is not selectable"}.`
        );
      }

      const openaiKey = resolveProviderKey("openai", {}) ?? "";
      const googleKey = resolveProviderKey("google", {}) ?? "";
      const openrouterKey = resolveProviderKey("openrouter", {}) ?? "";
      const veniceKey = resolveProviderKey("venice", {}) ?? "";
      const providerKey = { openai: openaiKey, google: googleKey, openrouter: openrouterKey, venice: veniceKey }[modelEntry.provider];
      if (!providerKey) return `Error: ${modelEntry.provider} API credential is not configured.`;

      const factsResult = envelopeFactsForArtifacts(ctx.memoryAccessEnvelope);
      if (!factsResult.ok) return `Error: ${factsResult.reason}`;
      const facts = factsResult.facts;
      if (facts.writableNamespaces.length === 0) {
        return (
          "Error: no writable namespace for new workspace artifacts. " +
          "Open a room with namespace write access before generating images."
        );
      }
      const targetNamespaceId = facts.writableNamespaces[0]!;

      let result: Awaited<ReturnType<typeof generateImages>>;
      try {
        result = await generateImages(
          {
            model: modelEntry.apiModel,
            prompt: args.prompt,
            count: args.count,
            size: args.size,
            quality: args.quality,
            background: args.background,
            format: args.format,
          },
          { openaiKey, googleKey, openrouterKey, veniceKey },
          modelEntry.provider,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`[generate_image] failed: ${msg}`);
        return `Error: ${msg}`;
      }

      const today = new Date().toISOString().slice(0, 10);
      const subdirRel = posix.join("generated-images", today);
      const ext = extForFormat(args.format);
      const mime = mimeForFormat(args.format);
      const rand = Date.now().toString(36);
      const baseStem =
        args.filename?.replace(/\.[^/.]+$/, "").trim() ||
        `${slugify(args.prompt).slice(0, 60)}-${rand}`;

      // Flat layout under getArtifactsRoot — the date is purely a logical
      // grouping. Do not create the storage root until the exact output has
      // crossed Artifact-write admission below.
      const artifactsRoot = getArtifactsRoot();

      const written: Array<{
        artifactId: string;
        path: string;
        zone: "workspace";
        mime: string;
        bytes: number;
      }> = [];

      for (let i = 0; i < result.bytes.length; i++) {
        const suffix =
          result.bytes.length === 1 ? "" : `-${String(i + 1).padStart(2, "0")}`;
        const stem = `${baseStem}${suffix}`;
        const logicalPath = posix.join(subdirRel, `${stem}.${ext}`);

        const resolution = await resolveWorkspaceArtifact({
          logicalPath,
          facts,
          intent: "create",
        });
        if (!resolution.ok) {
          return `Error: ${resolution.reason}`;
        }

        const bytes = result.bytes[i]!;
        try {
          await mkdir(artifactsRoot, { recursive: true });
          await writeFile(resolution.physicalPath, bytes);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Error: writing image bytes failed: ${msg}`;
        }

        const meta: WorkspaceArtifactPatchMeta = {
          mode: "create",
          artifactId: resolution.artifactId,
          logicalPath: resolution.logicalPath,
          namespaceId: targetNamespaceId,
          storageUri: resolution.storageUri,
          mimeType: mime,
        };
        try {
          await applyWorkspaceArtifactRowChange(
            meta,
            bytes.byteLength,
            facts.userId,
            facts.agentId,
            { kind: "agent", agentId: facts.agentId },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Error: indexing generated image as artifact failed: ${msg}`;
        }

        written.push({
          artifactId: resolution.artifactId,
          path: logicalPath,
          zone: "workspace",
          mime,
          bytes: bytes.byteLength,
        });
      }

      log(`[generate_image] wrote ${written.length} artifact(s) under ${artifactsRoot}`);

      return JSON.stringify({
        images: written,
        model: modelEntry.id,
        provider: modelEntry.provider,
        prompt: args.prompt,
      });
    },
  });
}
