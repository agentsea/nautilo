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
import { posix } from "node:path";
import { z } from "zod";
import {
  ATTACHMENT_POLICY,
  readAttachmentBytesVerifiedSize,
} from "@nautilo/attachments";
import { log, warn } from "@nautilo/logger";
import { getArtifactsRoot } from "@nautilo/config";
import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import {
  getDefaultImageModel,
  getImageModel,
  type ImageModelConfig,
} from "../../config/image-models";
import { resolveProviderKey } from "../../resolve-provider-key";
import { generateImages } from "../../image-gen";
import { runFundedDirectImageAttempt } from "../../image-gen/funded-attempt";
import { invokeSurplusImageAttempt } from "../../image-gen/surplus-attempt";
import {
  assertSurplusImageRequestCompatible,
  isSafeSurplusImageDirectFallback,
  resolveSurplusImageRoute,
} from "../../image-gen/surplus";
import type {
  GenerateImagesArgs,
  ImageGenerationReference,
} from "../../image-gen/types";
import { getCapabilityFundingSession } from "../../runtime/capability-funding";
import type {
  AdmittedCapabilityMedia,
  CapabilityFundingSession,
} from "../../runtime/capability-funding";
import {
  beginToolProviderCostAttempt,
} from "../../usage/provider-cost-recorder";
import type { ToolContext } from "@nautilo/catalog";
import {
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
  type EnvelopeFacts,
} from "../file/artifact-store";
import {
  preflightGeneratedImagePublication,
  publishGeneratedImages,
  type GeneratedImagePublicationDeps,
} from "./generated-image-publication";

interface GenerateImageContext {
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
  causalHumanUserId: string;
}

export interface GenerateImageToolDeps {
  assertCanUseServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
  getCapabilityFundingSession?: () => CapabilityFundingSession | undefined;
  beginProviderCostAttempt?: typeof beginToolProviderCostAttempt;
  publication?: GeneratedImagePublicationDeps;
}

function contextFromUnknown(ctx: unknown): GenerateImageContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const envRaw = c["memoryAccessEnvelope"];
  const envelope =
    envRaw && typeof envRaw === "object"
      ? (envRaw as MemoryAccessEnvelope)
      : null;
  return {
    memoryAccessEnvelope: envelope,
    causalHumanUserId: typeof c["causalHumanUserId"] === "string"
      ? c["causalHumanUserId"].trim()
      : "",
  };
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
  referencePaths: z
    .array(z.string().min(1))
    .max(8)
    .refine((paths) => new Set(paths).size === paths.length, {
      message: "Reference image paths must be unique and ordered.",
    })
    .optional()
    .describe("Ordered Workspace image paths for an edit. The first is the base image; later images are references."),
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

function formatForMime(mime: string): "png" | "webp" | "jpeg" | null {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg") return "jpeg";
  return null;
}

function assertDirectImageRequestCompatible(
  provider: ImageModelConfig["provider"],
  args: GenerateImagesArgs,
): void {
  if ((args.references?.length ?? 0) === 0) return;
  if (provider !== "openai" && provider !== "google") {
    throw new Error(
      `${provider} has no qualified reference-edit request shape for this image model.`,
    );
  }
}

function requiresDirectImageTransport(
  modelId: string,
  args: GenerateImagesArgs,
): boolean {
  const route = resolveSurplusImageRoute(modelId);
  if (!route) return true;
  try {
    assertSurplusImageRequestCompatible(route, args);
    return false;
  } catch {
    return true;
  }
}

function assertAdmittedDirectFallback(
  prior: AdmittedCapabilityMedia,
  direct: AdmittedCapabilityMedia,
  model: ImageModelConfig,
): void {
  if (direct.modelId !== model.id || direct.family !== "image") {
    throw new Error("The direct image fallback changed the selected model.");
  }
  const ownPersonalRecovery = prior.funding.provider === "surplus"
    && prior.funding.binding.kind === "server" && direct.funding.binding.kind === "personal";
  if (direct.funding.humanUserId !== prior.funding.humanUserId
    || (direct.funding.binding.kind !== prior.funding.binding.kind && !ownPersonalRecovery)) {
    throw new Error("The direct image fallback changed the admitted payer.");
  }
  if (direct.funding.provider !== model.provider
    || direct.funding.binding.providerRoute !== model.provider) {
    throw new Error("The direct image fallback does not match the selected model provider.");
  }
}

async function readAuthorizedReferences(
  paths: readonly string[],
  facts: EnvelopeFacts,
): Promise<readonly ImageGenerationReference[]> {
  const references: ImageGenerationReference[] = [];
  let totalBytes = 0;
  for (const logicalPath of paths) {
    const resolution = await resolveWorkspaceArtifact({
      logicalPath,
      facts,
      intent: "read",
    });
    if (!resolution.ok || !resolution.artifact) {
      throw new Error(resolution.ok
        ? `Workspace reference image "${logicalPath}" is unavailable.`
        : resolution.reason);
    }
    const mime = resolution.artifact.mimeType;
    if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") {
      throw new Error(`Workspace reference "${logicalPath}" is not a supported image artifact.`);
    }
    const bounded = await readBoundedImageReference(
      resolution.physicalPath,
      resolution.artifact.size,
      totalBytes,
    );
    totalBytes = bounded.totalBytes;
    references.push({ bytes: bounded.bytes, mime });
  }
  return references;
}

/** Single-handle bounded reference read, exported for hermetic race/limit tests. */
export async function readBoundedImageReference(
  physicalPath: string,
  expectedSize: number,
  priorTotalBytes: number,
): Promise<{ readonly bytes: Buffer; readonly totalBytes: number }> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0
    || expectedSize > ATTACHMENT_POLICY.maxImageBytes) {
    throw new Error("Workspace reference image exceeds the supported image size.");
  }
  const totalBytes = priorTotalBytes + expectedSize;
  if (!Number.isSafeInteger(totalBytes)
    || totalBytes > ATTACHMENT_POLICY.maxAcceptedBytesPerMessage) {
    throw new Error("Workspace reference images exceed the supported total size.");
  }
  const read = await readAttachmentBytesVerifiedSize(physicalPath, expectedSize);
  if (!read.ok) {
    throw new Error("Workspace reference image changed or could not be read safely.");
  }
  return { bytes: read.bytes, totalBytes };
}

export function createGenerateImageTool(
  context?: unknown,
  deps: GenerateImageToolDeps = {},
) {
  const ctx = contextFromUnknown(context);
  return new DynamicStructuredTool({
    name: "generate_image",
    description: `Generate 1–4 images from a text prompt and save them as workspace artifacts under generated-images/<YYYY-MM-DD>/. They appear in the Workspace tab and can be re-read with file({command:"read", zone:"workspace", path:"generated-images/.../foo.png"}).
Default model follows the admitted personal/server preference and catalog. Optional model override with full Nautilo id (e.g. openai:gpt-image-2.5-flare or google:gemini-2.5-flash-image) is authoritative. To edit, pass ordered Workspace referencePaths; the first image is the base. Masks are not supported.
Provider filters are at minimum strength (OpenAI moderation low; Gemini safety BLOCK_NONE). Refusals may still occur from account-level provider policy.

Returns a JSON envelope with the shape:
  { generationCompleted, publication, images: [{ artifactId, path, zone, mime, bytes }, ...], pendingPublications, model, provider, prompt }
where 'artifactId' is the stable external id (use it with share_artifact / file zone="workspace") and 'path' is the workspace-relative POSIX path (e.g. "generated-images/2026-05-08/red-square-01.png"). Absolute filesystem paths are NOT returned — bytes live under the server-owned artifact root and are addressed by artifactId + logical path.

Only entries in 'images' are registered Workspace artifacts. If publication is partial or pending, report the returned recovery message and do not call generate_image again for the same output; entries in 'pendingPublications' are recovery records, not accessible images, and any 'recoveryRef' is opaque operator correlation rather than an artifactId.

When telling the user where the images are, ALWAYS use the exact 'path' value verbatim from the result envelope. Refer to them as living in the user's Workspace tab — do NOT print absolute paths, do NOT abbreviate filenames with ellipses, do NOT invent slugs. The workbench already renders the gallery with thumbnails inline; your reply only needs to acknowledge what was generated and where, briefly.`,
    schema: GenerateImageSchema,
    func: async (args) => {
      const capabilityFunding = (deps.getCapabilityFundingSession
        ?? getCapabilityFundingSession)();
      let modelEntry: ImageModelConfig | undefined;
      try {
        const selectedModelId = capabilityFunding
          ? (await capabilityFunding.resolveModel(
              "imageGeneration",
              args.model ?? null,
            )).modelId
          : args.model;
        modelEntry = selectedModelId
          ? getImageModel(selectedModelId)
          : getDefaultImageModel();
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "no image model is available"}`;
      }
      if (!modelEntry) {
        return `Error: unknown image model "${args.model}".`;
      }
      // Request-local funding may make a catalogue row runnable even when its
      // direct server credential is absent. The funding owner rechecks the
      // exact model, payer, transport, and credential before dispatch.
      if (!modelEntry.enabled && !capabilityFunding) {
        return (
          `Error: image model "${modelEntry.id}" is unavailable: `
          + `${modelEntry.unavailableReason ?? "catalog row is not selectable"}.`
        );
      }

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

      let references: readonly ImageGenerationReference[];
      try {
        references = await readAuthorizedReferences(args.referencePaths ?? [], facts);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "reference image authorization failed"}`;
      }
      const imageArgs: GenerateImagesArgs = {
        model: modelEntry.apiModel,
        prompt: args.prompt,
        count: args.count,
        size: args.size,
        quality: args.quality,
        background: args.background,
        format: args.format,
        ...(references.length === 0 ? {} : { references }),
      };

      let actualProvider = modelEntry.provider as string;
      let funded: AdmittedCapabilityMedia | undefined;
      let providerKey = "";
      try {
        if (capabilityFunding) {
          if (!capabilityFunding.openMedia) {
            throw new Error("Image funding is unavailable for this request.");
          }
          funded = await capabilityFunding.openMedia(
            modelEntry.id,
            "image",
            {
              operation: references.length > 0 ? "edit" : "generate",
              directOnly: requiresDirectImageTransport(modelEntry.id, imageArgs),
            },
          );
          actualProvider = funded.funding.provider;
          if (actualProvider === "surplus") {
            const route = resolveSurplusImageRoute(modelEntry.id);
            if (!route) throw new Error(`${modelEntry.id} has no qualified Surplus image route.`);
            assertSurplusImageRequestCompatible(route, imageArgs);
          } else {
            if (actualProvider !== modelEntry.provider) {
              throw new Error("The admitted direct image credential does not match the selected model provider.");
            }
            assertDirectImageRequestCompatible(modelEntry.provider, imageArgs);
          }
        } else {
          if (!ctx.causalHumanUserId) {
            throw new ServerProviderCredentialsDeniedError("", "image_generation");
          }
          await (deps.assertCanUseServerProviderCredentials
            ?? assertCanUseServerProviderCredentials)(ctx.causalHumanUserId, "image_generation");
          assertDirectImageRequestCompatible(modelEntry.provider, imageArgs);
          providerKey = resolveProviderKey(modelEntry.provider, {}) ?? "";
          if (!providerKey) {
            throw new Error(`${modelEntry.provider} API credential is not configured.`);
          }
        }
      } catch (err) {
        if (err instanceof ServerProviderCredentialsDeniedError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        warn(`[generate_image] admission failed: ${msg}`);
        return `Error: ${msg}`;
      }

      const today = new Date().toISOString().slice(0, 10);
      const subdirRel = posix.join("generated-images", today);
      const requestedExt = extForFormat(args.format);
      const requestedMime = mimeForFormat(args.format);
      const rand = Date.now().toString(36);
      const baseStem =
        args.filename?.replace(/\.[^/.]+$/, "").trim() ||
        `${slugify(args.prompt).slice(0, 60)}-${rand}`;
      let publicationPlan: Awaited<ReturnType<typeof preflightGeneratedImagePublication>>;
      try {
        publicationPlan = await preflightGeneratedImagePublication({
          baseStem,
          subdirRel,
          requestedCount: args.count,
          requestedMime,
          requestedExtension: requestedExt,
          facts,
          ...(deps.publication === undefined ? {} : { deps: deps.publication }),
        });
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : "image publication authorization failed"}`;
      }

      let result: Awaited<ReturnType<typeof generateImages>>;
      const runFundedDirectAttempt = (
        admitted: AdmittedCapabilityMedia,
      ): Promise<Awaited<ReturnType<typeof generateImages>>> => admitted.runAttempt(
        ({ apiKey, usageFunding }) => runFundedDirectImageAttempt({
          ...(context == null ? {} : { context: context as ToolContext }),
          canonicalModelId: modelEntry.id,
          provider: modelEntry.provider,
          usageFunding,
          args: imageArgs,
          ...(deps.beginProviderCostAttempt === undefined
            ? {}
            : { beginProviderCostAttempt: deps.beginProviderCostAttempt }),
          invoke: () => generateImages(
            imageArgs,
            modelEntry.provider === "openai" ? { openaiKey: apiKey }
              : modelEntry.provider === "google" ? { googleKey: apiKey }
                : modelEntry.provider === "openrouter" ? { openrouterKey: apiKey }
                  : { veniceKey: apiKey },
            modelEntry.provider,
            { meterUsage: false },
          ),
        }),
      );
      try {
        if (funded) {
          if (actualProvider === "surplus") {
            try {
              result = await funded.runAttempt(({ apiKey, usageFunding }) => {
                const route = resolveSurplusImageRoute(modelEntry.id);
                if (!route) throw new Error(`${modelEntry.id} has no qualified Surplus image route.`);
                return invokeSurplusImageAttempt({
                  route,
                  canonicalModelId: modelEntry.id,
                  args: imageArgs,
                  apiKey,
                  funding: usageFunding,
                });
              });
            } catch (error) {
              if (!isSafeSurplusImageDirectFallback(error)) throw error;
              if (!capabilityFunding?.openMedia) {
                throw new Error("Image funding is unavailable for direct fallback.");
              }
              const direct = await capabilityFunding.openMedia(modelEntry.id, "image", {
                operation: references.length > 0 ? "edit" : "generate",
                directOnly: true,
                transport: "direct",
                prior: funded.funding,
              });
              assertAdmittedDirectFallback(funded, direct, modelEntry);
              actualProvider = direct.funding.provider;
              result = await runFundedDirectAttempt(direct);
            }
          } else {
            result = await runFundedDirectAttempt(funded);
          }
        } else {
          result = await generateImages(
            imageArgs,
            modelEntry.provider === "openai" ? { openaiKey: providerKey }
              : modelEntry.provider === "google" ? { googleKey: providerKey }
                : modelEntry.provider === "openrouter" ? { openrouterKey: providerKey }
                  : { veniceKey: providerKey },
            modelEntry.provider,
          );
        }
      } catch (err) {
        if (err instanceof ServerProviderCredentialsDeniedError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        warn("[generate_image] failed code=IMAGE_PROVIDER_FAILED");
        return `Error: ${msg}`;
      }

      const resultFormat = formatForMime(result.mime) ?? args.format;
      const ext = extForFormat(resultFormat);
      const mime = mimeForFormat(resultFormat);
      let published: Awaited<ReturnType<typeof publishGeneratedImages>>;
      try {
        published = await publishGeneratedImages({
          plan: publicationPlan,
          bytes: result.bytes,
          mime,
          extension: ext,
          facts,
          targetNamespaceId,
          ...(deps.publication === undefined ? {} : { deps: deps.publication }),
        });
      } catch {
        try {
          warn("[generate_image] unexpected publication failure after generation code=IMAGE_PUBLICATION_FAILED");
        } catch {
          // Diagnostics must not replace the paid provider result.
        }
        published = {
          images: [],
          pendingPublications: result.bytes.map((bytes, index) => ({
            path: `${subdirRel}/${baseStem}${result.bytes.length === 1 ? "" : `-${String(index + 1).padStart(2, "0")}`}.${ext}`,
            mime,
            bytes: bytes.byteLength,
            retained: false,
          })),
          publication: {
            status: "pending",
            publishedCount: 0,
            pendingCount: result.bytes.length,
            recovery: "Generation completed, but Workspace publication could not be verified. Do not regenerate or retry the paid request; doing so can bill the user again.",
          },
        };
      }

      log(`[generate_image] published ${published.images.length} artifact(s) under ${getArtifactsRoot()}`);

      return JSON.stringify({
        generationCompleted: true,
        ...published,
        model: modelEntry.id,
        provider: actualProvider,
        canonicalProvider: modelEntry.provider,
        operation: references.length > 0 ? "edit" : "generate",
        prompt: args.prompt,
      });
    },
  });
}
