import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { log } from "@nautilo/logger";
import {
  ATTACHMENT_POLICY,
  attachmentAudioToTranscriptBlock,
  classifyAttachment,
  createConfiguredTranscriptionProvider,
  type AttachmentEnvelope,
  type TranscriptionProvider,
} from "@nautilo/attachments";
import { safelyRecordProviderCost } from "../costs/provider-cost-recorder";
import {
  assertCanUseServerProviderCredentials,
  ServerProviderCredentialsDeniedError,
  toActionCapabilityHttpDenial,
} from "@nautilo/trust";

export type SttTranscriptionOutcome =
  | { ok: true; text: string; provider: string; model: string; blocked: boolean }
  | { ok: false; statusCode: 400 | 502 | 503; error: string; detail?: string };

export async function transcribeUploadedAudio(args: {
  bytes: Uint8Array;
  filename: string;
  claimedMime?: string | undefined;
  provider?: TranscriptionProvider | null | undefined;
  beforeProviderDispatch?: (() => Promise<void>) | undefined;
}): Promise<SttTranscriptionOutcome> {
  const envelope: AttachmentEnvelope = {
    id: `stt:${args.filename}`,
    source: "workbench-chat",
    filename: args.filename,
    sizeBytes: args.bytes.byteLength,
    bytes: args.bytes,
  };
  if (args.claimedMime) {
    envelope.claimedMime = args.claimedMime;
  }

  const classification = await classifyAttachment(envelope);
  if (classification.decision !== "accept" || classification.kind !== "audio") {
    return {
      ok: false,
      statusCode: 400,
      error: classification.decision === "reject" ? classification.reason : "Uploaded file is not accepted audio",
    };
  }

  const provider = args.provider ?? createConfiguredTranscriptionProvider();
  if (!provider || !(await provider.available())) {
    return { ok: false, statusCode: 503, error: "Voice transcription not configured" };
  }

  await args.beforeProviderDispatch?.();
  const result = await attachmentAudioToTranscriptBlock(envelope, classification, provider);
  if (!result.ok) {
    if (result.code === "provider_error") {
      log(`[stt] provider_error: ${result.reason}`);
    }
    return {
      ok: false,
      statusCode: 502,
      error: "Transcription failed",
      detail: "The transcription service returned an error.",
    };
  }
  if (result.block.blocked) {
    return {
      ok: false,
      statusCode: 400,
      error: "Transcript blocked by content scanner",
      detail: result.block.threats.join(", "),
    };
  }

  return {
    ok: true,
    text: result.transcriptText,
    provider: result.provider,
    model: result.model,
    blocked: false,
  };
}

export function sttRoutes(
  app: FastifyInstance,
  deps: {
    assertCanUseServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
  } = {},
) {
  app.post("/api/stt", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const humanUserId = request.sessionUserId;
    const data = await request.file({
      limits: {
        fileSize: ATTACHMENT_POLICY.maxAudioBytes,
        files: 1,
      },
    });
    if (!data) {
      return reply.code(400).send({ error: "audio file is required" });
    }

    let buf: Buffer;
    try {
      buf = await data.toBuffer();
    } catch (err) {
      log(`[stt] upload read failed: ${err instanceof Error ? err.message : String(err)}`);
      return reply.code(400).send({
        error: "audio upload could not be read",
        detail: "The upload could not be read. Try a smaller file or a different format.",
      });
    }
    let result: SttTranscriptionOutcome;
    try {
      result = await transcribeUploadedAudio({
        bytes: buf,
        filename: data.filename ?? "recording.webm",
        claimedMime: data.mimetype,
        beforeProviderDispatch: () => (deps.assertCanUseServerProviderCredentials
          ?? assertCanUseServerProviderCredentials)(humanUserId, "speech_to_text"),
      });
    } catch (error) {
      if (error instanceof ServerProviderCredentialsDeniedError) {
        return reply.code(403).send(toActionCapabilityHttpDenial(error));
      }
      throw error;
    }

    if (!result.ok) {
      return reply.code(result.statusCode).send({
        error: result.error,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    }

    await safelyRecordProviderCost({
      identity: `${result.provider}:speech-to-text:${randomUUID()}`,
      userId: request.sessionUserId ?? null,
      provider: result.provider.toLowerCase(),
      operation: "speech_to_text",
      evidenceState: "unknown",
    });

    return reply.send({
      text: result.text,
      provider: result.provider,
      model: result.model,
    });
  });
}
