/**
 * D417 Phase 2 — copy a narrowly admitted local MP4 into the workspace
 * artifact store. This is deliberately an ingest primitive, not extraction or
 * transcription: local bytes cross the relay once and are preserved exactly.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { getCurrentTurnId } from "@nautilo/logger";
import { RELAY_MEDIA_MAX_BYTES } from "@nautilo/relay";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { z } from "zod";
import { readLocalZoneMediaBytes, type LocalZoneIoContext } from "../file/local-zone-io";
import {
  createWorkspaceBinaryArtifact,
  type CreateWorkspaceBinaryArtifactResult,
} from "../file/workspace-binary-artifact";

const MP4_MIME_TYPE = "video/mp4";

const ingestLocalMediaSchema = z.object({
  sourcePath: z.string().min(1, "sourcePath is required"),
  sourceZone: z.enum(["current", "absolute"]).describe(
    "Local source zone. Workspace artifacts are not valid ingest inputs.",
  ),
  artifactPath: z.string().min(1, "artifactPath is required").describe(
    "Workspace artifact path where the original MP4 bytes will be stored.",
  ),
});

type IngestLocalMediaInput = z.infer<typeof ingestLocalMediaSchema>;

interface IngestLocalMediaContext {
  ownerId: string;
  agentId: string;
  currentFolder: string;
  workspacePath: string;
  activeModelId?: string;
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
}

export interface IngestLocalMediaToolDeps {
  readLocalZoneBytes?: typeof readLocalZoneMediaBytes;
  createWorkspaceBinaryArtifact?: (
    input: Parameters<typeof createWorkspaceBinaryArtifact>[0],
  ) => Promise<CreateWorkspaceBinaryArtifactResult>;
}

function contextFromUnknown(context: unknown): IngestLocalMediaContext {
  const raw = (context && typeof context === "object"
    ? context
    : {}) as Record<string, unknown>;
  const envelope = raw["memoryAccessEnvelope"];
  return {
    ownerId: typeof raw["ownerId"] === "string" ? raw["ownerId"] : "",
    agentId: typeof raw["agentId"] === "string" ? raw["agentId"] : "",
    currentFolder: typeof raw["currentFolder"] === "string" ? raw["currentFolder"] : "",
    workspacePath: typeof raw["workspacePath"] === "string" ? raw["workspacePath"] : "",
    ...(typeof raw["activeModelId"] === "string" ? { activeModelId: raw["activeModelId"] } : {}),
    memoryAccessEnvelope:
      envelope && typeof envelope === "object"
        ? (envelope as MemoryAccessEnvelope)
        : null,
  };
}

function hasMp4Extension(value: string): boolean {
  return /\.mp4$/i.test(value);
}

function hasIsoBmffFileTypeBox(bytes: Buffer): boolean {
  return bytes.byteLength >= 12 && bytes.subarray(4, 8).equals(Buffer.from("ftyp"));
}

function localIoContext(context: IngestLocalMediaContext): LocalZoneIoContext {
  const turnId = getCurrentTurnId();
  return {
    ownerId: context.ownerId,
    agentId: context.agentId,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(context.activeModelId ? { activeModelId: context.activeModelId } : {}),
    zoneCtx: {
      workspaceRoot: context.workspacePath,
      currentFolder: context.currentFolder || null,
    },
    // Catalog approval is resolved before a tool is invoked.
    approvalObtained: true,
  };
}

export function createIngestLocalMediaTool(
  context?: unknown,
  deps: IngestLocalMediaToolDeps = {},
) {
  const toolContext = contextFromUnknown(context);
  const readBytes = deps.readLocalZoneBytes ?? readLocalZoneMediaBytes;
  const createArtifact =
    deps.createWorkspaceBinaryArtifact ?? createWorkspaceBinaryArtifact;

  return new DynamicStructuredTool({
    name: "ingest_local_media",
    description:
      "With explicit approval, ingest one local MP4 file through the desktop relay into a workspace artifact. " +
      `The source must be at most ${RELAY_MEDIA_MAX_BYTES} bytes; it is transferred in bounded relay chunks, copied unchanged, and no audio is extracted.`,
    schema: ingestLocalMediaSchema,
    func: async (input: IngestLocalMediaInput) => {
      if (!hasMp4Extension(input.sourcePath)) {
        return "Error: ingest_local_media currently accepts only .mp4 source files.";
      }
      if (!hasMp4Extension(input.artifactPath)) {
        return "Error: artifactPath must end in .mp4.";
      }
      if (!toolContext.memoryAccessEnvelope) {
        return "Error: workspace artifact ingest requires room/namespace context (memoryAccessEnvelope missing).";
      }

      const read = await readBytes(
        input.sourcePath,
        input.sourceZone,
        localIoContext(toolContext),
      );
      if (!read.ok) return `Error: local MP4 could not be read (${read.error})`;

      // The relay rejects oversize reads too, but check the returned payload
      // before any workspace write so no truncated/partial artifact can exist.
      if (read.bytes.byteLength > RELAY_MEDIA_MAX_BYTES) {
        return (
          `Error: local MP4 is ${read.bytes.byteLength} bytes, exceeding the ` +
          `${RELAY_MEDIA_MAX_BYTES}-byte relay media limit.`
        );
      }
      if (!hasIsoBmffFileTypeBox(read.bytes)) {
        return "Error: source is not a supported MP4 file (missing ISO BMFF ftyp header).";
      }

      const created = await createArtifact({
        envelope: toolContext.memoryAccessEnvelope,
        actor: { kind: "agent", agentId: toolContext.memoryAccessEnvelope.agentId },
        logicalPath: input.artifactPath,
        bytes: read.bytes,
        mimeType: MP4_MIME_TYPE,
      });
      if (!created.ok) {
        return `Error: could not persist local MP4 artifact (${created.code}: ${created.message})`;
      }

      return JSON.stringify({
        ingested: true,
        artifactId: created.artifactId,
        artifactInternalId: created.artifactInternalId,
        path: created.displayPath,
        mimeType: MP4_MIME_TYPE,
        size: created.size,
        sha256: created.sha256,
      });
    },
  });
}
