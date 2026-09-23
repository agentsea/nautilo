import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { open } from "node:fs/promises";
import {
  ATTACHMENT_POLICY,
  attachmentAudioToTranscriptBlock,
  classifyAttachment,
  createConfiguredTranscriptionProvider,
  readAttachmentBytesVerifiedSize,
  readAttachmentHeadPrefix,
  type AttachmentEnvelope,
  type AttachmentPathValidationResult,
  type TranscriptionProvider,
} from "@nautilo/attachments";
import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import {
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
  validateLogicalPath,
} from "../file/artifact-store";

type TranscribeAudioContext = {
  currentFolder: string;
  workspacePath: string;
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
  causalHumanUserId: string;
  transcriptionProvider?: TranscriptionProvider | undefined;
};

type WorkspaceAudioResolution =
  | { ok: true; physicalPath: string; logicalPath: string }
  | { ok: false; error: string };

export type TranscribeAudioToolDeps = {
  resolveWorkspaceAudio?: (
    logicalPath: string,
    envelope: MemoryAccessEnvelope,
  ) => Promise<WorkspaceAudioResolution>;
  assertCanUseServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
};

const transcribeAudioSchema = z.object({
  path: z.string().min(1, "path required").describe("Path to the audio file."),
  zone: z.enum(["workspace", "current", "absolute"]).optional().default("workspace"),
  language: z.string().min(2).max(16).optional().describe("Optional transcription language hint, e.g. en."),
  timestamps: z.boolean().optional().default(false).describe("Whether the provider should return timestamps when supported."),
});

function contextFromUnknown(ctx: unknown): TranscribeAudioContext {
  const c = (ctx && typeof ctx === "object") ? (ctx as Record<string, unknown>) : {};
  return {
    currentFolder: typeof c["currentFolder"] === "string" ? c["currentFolder"] : "",
    workspacePath: typeof c["workspacePath"] === "string" ? c["workspacePath"] : "",
    memoryAccessEnvelope: c["memoryAccessEnvelope"] && typeof c["memoryAccessEnvelope"] === "object"
      ? c["memoryAccessEnvelope"] as MemoryAccessEnvelope
      : null,
    causalHumanUserId: typeof c["causalHumanUserId"] === "string"
      ? c["causalHumanUserId"].trim()
      : "",
    transcriptionProvider: isTranscriptionProvider(c["transcriptionProvider"])
      ? c["transcriptionProvider"]
      : createConfiguredTranscriptionProvider() ?? undefined,
  };
}

function isTranscriptionProvider(value: unknown): value is TranscriptionProvider {
  return !!value &&
    typeof value === "object" &&
    typeof (value as { available?: unknown }).available === "function" &&
    typeof (value as { transcribe?: unknown }).transcribe === "function";
}

async function fileSizeOrFailure(absPath: string): Promise<
  | { ok: true; sizeBytes: number }
  | { ok: false; message: string }
> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absPath, "r");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
  try {
    const st = await handle.stat();
    if (st.isDirectory()) {
      return { ok: false, message: "path is a directory" };
    }
    return { ok: true, sizeBytes: st.size };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function resolveWorkspaceAudio(
  logicalPath: string,
  envelope: MemoryAccessEnvelope,
): Promise<WorkspaceAudioResolution> {
  const facts = envelopeFactsForArtifacts(envelope);
  if (!facts.ok) return { ok: false, error: facts.reason };

  const validated = validateLogicalPath(logicalPath);
  if (!validated.ok) return { ok: false, error: validated.reason };

  const resolved = await resolveWorkspaceArtifact({
    logicalPath: validated.path,
    facts: facts.facts,
    intent: "read",
  });
  if (!resolved.ok) return { ok: false, error: resolved.reason };
  if (!resolved.artifact) {
    return { ok: false, error: `No workspace artifact at "${validated.path}".` };
  }
  return {
    ok: true,
    physicalPath: resolved.physicalPath,
    logicalPath: resolved.logicalPath,
  };
}

export function createTranscribeAudioTool(
  context?: unknown,
  deps: TranscribeAudioToolDeps = {},
) {
  const toolCtx = contextFromUnknown(context);
  const readWorkspaceAudio = deps.resolveWorkspaceAudio ?? resolveWorkspaceAudio;

  return new DynamicStructuredTool({
    name: "transcribe_audio",
    description:
      "Transcribe a workspace audio artifact to text. Validates it through the D066 attachment security gate and scans the transcript before returning it.",
    schema: transcribeAudioSchema,
    func: async ({ path, zone, language, timestamps }) => {
      if (zone !== "workspace") {
        return "Error: transcribe_audio can only read workspace audio artifacts. " +
          "Use ingest_local_media or extract_audio_from_video first, then transcribe the resulting workspace artifact.";
      }
      if (!toolCtx.memoryAccessEnvelope) {
        return "Error: workspace audio artifact access requires room/namespace context (memoryAccessEnvelope missing).";
      }
      const resolved = await readWorkspaceAudio(path, toolCtx.memoryAccessEnvelope);
      if (!resolved.ok) return `Error: ${resolved.error}`;

      const fileMeta = await fileSizeOrFailure(resolved.physicalPath);
      if (!fileMeta.ok) {
        return `Error: workspace audio artifact not found or unreadable (${fileMeta.message})`;
      }

      const envelope: AttachmentEnvelope = {
        id: `transcribe_audio:${resolved.logicalPath}`,
        source: "workspace-file",
        filename: resolved.logicalPath.split(/[/\\]/).pop() ?? resolved.logicalPath,
        sizeBytes: fileMeta.sizeBytes,
        path,
        zone,
      };
      const classification = await classifyAttachment(envelope, {
        validatePath: (): AttachmentPathValidationResult => ({
          ok: true,
          resolvedPath: resolved.physicalPath,
          resolvedZone: "workspace",
        }),
        readHeadBytes: async () => {
          const head = await readAttachmentHeadPrefix(resolved.physicalPath, ATTACHMENT_POLICY.maxSniffBytes);
          return head.ok ? head.bytes : new Uint8Array();
        },
      });

      if (classification.decision !== "accept" || classification.kind !== "audio") {
        return classification.decision === "reject"
          ? `Error: ${classification.reason}`
          : "Error: attachment is not an accepted audio file";
      }

      const read = await readAttachmentBytesVerifiedSize(resolved.physicalPath, envelope.sizeBytes);
      if (!read.ok) {
        if (read.code === "size_mismatch") {
          return "Error: audio file changed before transcription; retry the tool call";
        }
        return `Error: audio file could not be read (${read.code})`;
      }
      const bytes = read.bytes;
      const byteEnvelope: AttachmentEnvelope = {
        id: envelope.id,
        source: envelope.source,
        filename: envelope.filename,
        sizeBytes: envelope.sizeBytes,
        bytes,
      };
      const provider = toolCtx.transcriptionProvider;
      if (!provider || !(await provider.available())) {
        return "Error: No transcription provider configured";
      }
      if (!toolCtx.causalHumanUserId) {
        throw new ServerProviderCredentialsDeniedError("", "audio_transcription");
      }
      await (deps.assertCanUseServerProviderCredentials
        ?? assertCanUseServerProviderCredentials)(
          toolCtx.causalHumanUserId,
          "audio_transcription",
        );
      const result = await attachmentAudioToTranscriptBlock(
        byteEnvelope,
        classification,
        provider,
        {
          ...(language !== undefined ? { language } : {}),
          ...(timestamps !== undefined ? { timestamps } : {}),
        },
      );
      if (!result.ok) {
        return `Error: ${result.reason}`;
      }
      return result.block.text;
    },
  });
}
