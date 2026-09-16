/**
 * D417 Phase 3 — explicitly approved MP4 audio extraction.
 *
 * This is intentionally neither `convert` nor `run_shell`: source authority
 * is resolved here, while the paired desktop relay receives only a bounded,
 * fixed-schema byte payload and owns the ffmpeg invocation.
 */

import * as fsp from "node:fs/promises";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { getCurrentTurnId } from "@nautilo/logger";
import {
  RELAY_MEDIA_CHUNK_BYTES,
  RELAY_MEDIA_MAX_BYTES,
} from "@nautilo/relay";
import { randomUUID, createHash } from "node:crypto";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import { z } from "zod";
import { getRelayRegistry } from "../../nodes/tools";
import {
  FOCUSED_RELAY_MISMATCH_MESSAGE,
  resolveFocusedRelayHintForPath,
} from "../file/local-file-routing";
import {
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
  validateLogicalPath,
} from "../file/artifact-store";
import { readLocalZoneMediaBytes, type LocalZoneIoContext } from "../file/local-zone-io";
import {
  createWorkspaceBinaryArtifact,
  type CreateWorkspaceBinaryArtifactResult,
} from "../file/workspace-binary-artifact";

const AUDIO_MIME_TYPE = "audio/mp4";
const MEDIA_EXTRACTION_PROTOCOL_VERSION = 5;
const MAX_BASE64_MEDIA_BYTES = Math.ceil(RELAY_MEDIA_CHUNK_BYTES / 3) * 4;

const extractAudioSchema = z.object({
  sourcePath: z.string().min(1, "sourcePath is required"),
  sourceZone: z.enum(["workspace", "current", "absolute"]).default("workspace"),
  artifactPath: z.string().min(1, "artifactPath is required"),
});

type ExtractAudioInput = z.infer<typeof extractAudioSchema>;

interface ExtractAudioContext {
  ownerId: string;
  agentId: string;
  currentFolder: string;
  workspacePath: string;
  activeModelId?: string;
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
}

export interface ExtractAudioFromVideoToolDeps {
  readLocalZoneBytes?: typeof readLocalZoneMediaBytes;
  readWorkspaceBytes?: (logicalPath: string, envelope: MemoryAccessEnvelope) => Promise<
    { ok: true; bytes: Buffer } | { ok: false; error: string }
  >;
  dispatch?: (
    source: Buffer,
    ownerId: string,
    /** D423 Phase 5 — exact originating relay for a focused local source. */
    relayIdHint?: string,
  ) => Promise<{ ok: true; audio: Buffer } | { ok: false; error: string }>;
  createWorkspaceBinaryArtifact?: (
    input: Parameters<typeof createWorkspaceBinaryArtifact>[0],
  ) => Promise<CreateWorkspaceBinaryArtifactResult>;
}

function contextFromUnknown(context: unknown): ExtractAudioContext {
  const raw = (context && typeof context === "object" ? context : {}) as Record<string, unknown>;
  const envelope = raw["memoryAccessEnvelope"];
  return {
    ownerId: typeof raw["ownerId"] === "string" ? raw["ownerId"] : "",
    agentId: typeof raw["agentId"] === "string" ? raw["agentId"] : "",
    currentFolder: typeof raw["currentFolder"] === "string" ? raw["currentFolder"] : "",
    workspacePath: typeof raw["workspacePath"] === "string" ? raw["workspacePath"] : "",
    ...(typeof raw["activeModelId"] === "string" ? { activeModelId: raw["activeModelId"] } : {}),
    memoryAccessEnvelope: envelope && typeof envelope === "object"
      ? (envelope as MemoryAccessEnvelope)
      : null,
  };
}

function hasMp4Extension(value: string): boolean {
  return /\.mp4$/i.test(value);
}

function hasM4aExtension(value: string): boolean {
  return /\.m4a$/i.test(value);
}

function hasIsoBmffFileTypeBox(bytes: Buffer): boolean {
  return bytes.byteLength >= 12 && bytes.subarray(4, 8).equals(Buffer.from("ftyp"));
}

function decodeBoundedCanonicalBase64(
  value: string,
): { ok: true; bytes: Buffer } | { ok: false; error: string } {
  if (
    value.length === 0 ||
    value.length > MAX_BASE64_MEDIA_BYTES ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return { ok: false, error: "relay returned invalid or oversized base64 audio" };
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength <= 0 || decodedLength > RELAY_MEDIA_CHUNK_BYTES) {
    return { ok: false, error: "relay returned audio chunk exceeding the 1 MiB limit" };
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== decodedLength || bytes.toString("base64") !== value) {
    return { ok: false, error: "relay returned non-canonical base64 audio" };
  }
  return { ok: true, bytes };
}

function localIoContext(context: ExtractAudioContext): LocalZoneIoContext {
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
    approvalObtained: true,
  };
}

async function readWorkspaceMp4(
  logicalPath: string,
  envelope: MemoryAccessEnvelope,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const facts = envelopeFactsForArtifacts(envelope);
  if (!facts.ok) return { ok: false, error: facts.reason };
  const path = validateLogicalPath(logicalPath);
  if (!path.ok) return { ok: false, error: path.reason };
  const resolved = await resolveWorkspaceArtifact({
    logicalPath: path.path,
    facts: facts.facts,
    intent: "read",
  });
  if (!resolved.ok || !resolved.artifact) {
    return { ok: false, error: resolved.ok ? `No workspace artifact at "${path.path}".` : resolved.reason };
  }
  try {
    return { ok: true, bytes: await fsp.readFile(resolved.physicalPath) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function dispatchExtraction(
  source: Buffer,
  ownerId: string,
  relayIdHint?: string,
): Promise<{ ok: true; audio: Buffer } | { ok: false; error: string }> {
  const registry = getRelayRegistry();
  if (!registry) {
    return { ok: false, error: "Audio extraction requires a connected Nautilo desktop relay." };
  }
  const candidates = registry.findByCapabilityForUser("canReadWorkspace", ownerId);
  const qualifies = (id: string): boolean => {
    const capabilities = registry.getCapabilities(id);
    return capabilities?.profile === "desktop-agent" &&
      capabilities.localFileExecution === true &&
      (registry.getProtocolVersion?.(id) ?? 0) >= MEDIA_EXTRACTION_PROTOCOL_VERSION;
  };
  let relayId: string | undefined;
  if (relayIdHint) {
    // D423 Phase 5 — a focused local source MUST extract on its originating
    // relay. A hint that isn't the connected owner-paired qualifying relay
    // fails closed; never fall back to another device for a focused file.
    if (!candidates.includes(relayIdHint) || !qualifies(relayIdHint)) {
      return { ok: false, error: FOCUSED_RELAY_MISMATCH_MESSAGE };
    }
    relayId = relayIdHint;
  } else {
    relayId = candidates.find((id) => qualifies(id));
  }
  if (!relayId) {
    return {
      ok: false,
      error:
        "Audio extraction requires the Nautilo desktop app with D417 media support. " +
        "Headless relays cannot run this fixed local media operation.",
    };
  }
  const sessionId = randomUUID();
  const chunkCount = Math.ceil(source.byteLength / RELAY_MEDIA_CHUNK_BYTES);
  const send = async (toolName: string, args: Record<string, unknown>) => registry.dispatch(relayId, {
    toolName, args,
    impact: "high",
    approvalObtained: true,
    timeout: 60_000,
  });
  const started = await send("media_extract_start", { sessionId, totalBytes: source.byteLength, chunkCount, outputFormat: "m4a" });
  if (started.status !== "ok") return { ok: false, error: started.error ?? "Desktop audio extraction failed." };
  for (let index = 0; index < chunkCount; index++) {
    const chunk = source.subarray(index * RELAY_MEDIA_CHUNK_BYTES, Math.min(source.byteLength, (index + 1) * RELAY_MEDIA_CHUNK_BYTES));
    const accepted = await send("media_extract_chunk", { sessionId, index, chunkCount, data: chunk.toString("base64") });
    if (accepted.status !== "ok") return { ok: false, error: accepted.error ?? "Desktop rejected media chunk." };
  }
  const completed = await send("media_extract_finish", { sessionId });
  const meta = completed.result as { ok?: unknown; message?: unknown; totalBytes?: unknown; chunkCount?: unknown; sha256?: unknown };
  if (completed.status !== "ok" || meta?.ok !== true || !Number.isSafeInteger(meta.totalBytes) || !Number.isSafeInteger(meta.chunkCount) || typeof meta.sha256 !== "string") {
    return { ok: false, error: completed.error ?? (typeof meta?.message === "string" ? meta.message : "Desktop audio extraction failed.") };
  }
  if ((meta.totalBytes as number) > RELAY_MEDIA_MAX_BYTES || (meta.chunkCount as number) !== Math.ceil((meta.totalBytes as number) / RELAY_MEDIA_CHUNK_BYTES)) return { ok: false, error: "Desktop returned invalid audio size." };
  const chunks: Buffer[] = [];
  for (let index = 0; index < (meta.chunkCount as number); index++) {
    const result = await send("media_extract_output_chunk", { sessionId, index, chunkCount: meta.chunkCount });
    const payload = result.result as { ok?: unknown; data?: unknown; index?: unknown; chunkCount?: unknown };
    const decoded = decodeBoundedCanonicalBase64(payload?.data as string);
    if (result.status !== "ok" || payload?.ok !== true || payload.index !== index || payload.chunkCount !== meta.chunkCount || !decoded.ok) {
      return { ok: false, error: result.error ?? "Desktop returned malformed audio chunk." };
    }
    chunks.push(decoded.bytes);
  }
  const audio = Buffer.concat(chunks);
  if (audio.byteLength !== meta.totalBytes || createHash("sha256").update(audio).digest("hex") !== meta.sha256) return { ok: false, error: "Desktop audio transfer integrity check failed." };
  return { ok: true, audio };
}

export function createExtractAudioFromVideoTool(
  context?: unknown,
  deps: ExtractAudioFromVideoToolDeps = {},
) {
  const toolContext = contextFromUnknown(context);
  const readLocal = deps.readLocalZoneBytes ?? readLocalZoneMediaBytes;
  const readWorkspace = deps.readWorkspaceBytes ?? readWorkspaceMp4;
  const execute = deps.dispatch ?? dispatchExtraction;
  const createArtifact = deps.createWorkspaceBinaryArtifact ?? createWorkspaceBinaryArtifact;

  return new DynamicStructuredTool({
    name: "extract_audio_from_video",
    description:
      "With explicit approval, extract the first audio stream from one MP4 into a workspace .m4a artifact. " +
      "Use the resulting artifact with transcribe_audio. Uses a fixed desktop-relay ffmpeg operation; it never runs arbitrary shell commands or transcribes audio.",
    schema: extractAudioSchema,
    func: async (input: ExtractAudioInput) => {
      if (!hasMp4Extension(input.sourcePath)) {
        return "Error: extract_audio_from_video currently accepts only .mp4 source files.";
      }
      if (!hasM4aExtension(input.artifactPath)) {
        return "Error: artifactPath must end in .m4a.";
      }
      if (!toolContext.memoryAccessEnvelope) {
        return "Error: workspace audio artifact creation requires room/namespace context (memoryAccessEnvelope missing).";
      }

      const sourceZone = input.sourceZone;
      // D423 Phase 5 — pin extraction (and the local read above) to the focused
      // source's exact originating relay. `readLocal` already pins via
      // `local-zone-io`; thread the same hint into the extraction dispatch.
      const relayHint =
        sourceZone === "current" || sourceZone === "absolute"
          ? resolveFocusedRelayHintForPath({
              path: input.sourcePath,
              zone: sourceZone,
              currentFolder: toolContext.currentFolder || null,
            })
          : undefined;

      const source = sourceZone === "workspace"
        ? await readWorkspace(input.sourcePath, toolContext.memoryAccessEnvelope)
        : await readLocal(input.sourcePath, sourceZone, localIoContext(toolContext));
      if (!source.ok) return `Error: MP4 source could not be read (${source.error})`;
      if (source.bytes.byteLength > RELAY_MEDIA_MAX_BYTES) {
        return `Error: MP4 source is ${source.bytes.byteLength} bytes, exceeding the ${RELAY_MEDIA_MAX_BYTES}-byte relay media limit.`;
      }
      if (!hasIsoBmffFileTypeBox(source.bytes)) {
        return "Error: source is not a supported MP4 file (missing ISO BMFF ftyp header).";
      }

      const extracted = await execute(source.bytes, toolContext.ownerId, relayHint);
      if (!extracted.ok) return `Error: audio extraction failed (${extracted.error})`;
      const output = extracted.audio;
      if (output.byteLength <= 0 || output.byteLength > RELAY_MEDIA_MAX_BYTES) {
        return "Error: extracted audio exceeds the bounded media limit; no artifact was created.";
      }
      const created = await createArtifact({
        envelope: toolContext.memoryAccessEnvelope,
        actor: { kind: "agent", agentId: toolContext.memoryAccessEnvelope.agentId },
        logicalPath: input.artifactPath,
        bytes: output,
        mimeType: AUDIO_MIME_TYPE,
      });
      if (!created.ok) {
        return `Error: could not persist extracted audio artifact (${created.code}: ${created.message})`;
      }
      return JSON.stringify({
        extracted: true,
        artifactId: created.artifactId,
        artifactInternalId: created.artifactInternalId,
        path: created.displayPath,
        mimeType: AUDIO_MIME_TYPE,
        size: created.size,
        sha256: created.sha256,
      });
    },
  });
}
