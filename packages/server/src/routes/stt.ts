import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { log } from "@nautilo/logger";
import {
  ATTACHMENT_POLICY,
  attachmentAudioToTranscriptBlock,
  classifyAttachment,
  createConfiguredTranscriptionProvider,
  ElevenLabsTranscriptionProvider,
  GroqTranscriptionProvider,
  type AttachmentEnvelope,
  type TranscriptionProvider,
} from "@nautilo/attachments";
import {
  beginServerProviderCostAttempt,
  settleServerProviderCostAttempt,
  type ServerProviderCostAttemptAdmission,
  type ServerProviderCostReceipt,
} from "../costs/provider-cost-recorder";
import {
  assertCanUseServerProviderCredentials,
  getUserCapabilities,
  ServerProviderCredentialsDeniedError,
  toActionCapabilityHttpDenial,
} from "@nautilo/trust";
import type { DurableServiceFundingBinding } from "@nautilo/types";
import { ModelFundingError } from "../lib/model-funding";
import {
  directVoiceServiceFunding,
  type VoiceServiceFunding,
} from "../realtime/voice-service-funding";

export type SttTranscriptionOutcome =
  | { ok: true; text: string; provider: string; model: string; blocked: boolean }
  | { ok: false; statusCode: 400 | 502 | 503; error: string; detail?: string };

function admissionUnavailable(error: unknown): boolean {
  return error instanceof ModelFundingError
    && (error.code === "personal_credential_missing" || error.code === "provider_credentials_missing");
}

export async function createFundedTranscriptionProvider(
  humanUserId: string,
  deps: {
    funding: VoiceServiceFunding;
    beginCost: (receipt: ServerProviderCostAttemptAdmission) => Promise<void>;
    settleCost: (receipt: ServerProviderCostReceipt) => Promise<void>;
    createProvider?: (provider: "elevenlabs" | "groq", apiKey: string) => TranscriptionProvider;
  },
): Promise<TranscriptionProvider> {
  let binding: DurableServiceFundingBinding | undefined;
  let providerId: "elevenlabs" | "groq" | undefined;
  let firstError: unknown;
  for (const candidate of ["elevenlabs", "groq"] as const) {
    try {
      binding = await deps.funding.admit(humanUserId, candidate);
      providerId = candidate;
      break;
    } catch (error) {
      if (!admissionUnavailable(error)) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      firstError ??= error;
    }
  }
  if (!binding || !providerId) {
    throw firstError instanceof Error
      ? firstError
      : new ModelFundingError("provider_credentials_missing");
  }
  const admittedBinding = binding;
  const admittedProvider = providerId;
  const attemptId = randomUUID();
  return {
    id: admittedProvider,
    available: () => Promise.resolve(true),
    transcribe: input => deps.funding.run(admittedBinding, "spend", async ({ apiKey, usageFunding }) => {
      const admission: ServerProviderCostAttemptAdmission = {
        identity: `${admittedProvider}:speech-to-text:${attemptId}`,
        userId: humanUserId,
        usageFunding,
        provider: admittedProvider,
        operation: "speech_to_text",
      };
      await deps.beginCost(admission);
      try {
        const provider = deps.createProvider?.(admittedProvider, apiKey)
          ?? (admittedProvider === "elevenlabs"
            ? new ElevenLabsTranscriptionProvider(apiKey)
            : new GroqTranscriptionProvider(apiKey));
        const result = await provider.transcribe(input);
        await deps.settleCost({
          ...admission,
          evidenceState: "unknown",
          attemptOutcome: "succeeded",
        }).catch(() => log(`[stt] cost settlement unavailable for ${admittedProvider}`));
        return result;
      } catch (error) {
        await deps.settleCost({
          ...admission,
          evidenceState: "unknown",
          attemptOutcome: input.signal?.aborted ? "cancelled" : "failed",
          failureCode: input.signal?.aborted ? "cancelled" : "provider_error",
        }).catch(() => {});
        throw error;
      }
    }),
  };
}

export async function transcribeUploadedAudio(args: {
  bytes: Uint8Array;
  filename: string;
  claimedMime?: string | undefined;
  provider?: TranscriptionProvider | null | undefined;
  resolveProvider?: (() => Promise<TranscriptionProvider | null>) | undefined;
  beforeProviderDispatch?: (() => Promise<void>) | undefined;
  signal?: AbortSignal | undefined;
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

  const provider = args.provider ?? await args.resolveProvider?.()
    ?? createConfiguredTranscriptionProvider();
  if (!provider || !(await provider.available())) {
    return { ok: false, statusCode: 503, error: "Voice transcription not configured" };
  }

  await args.beforeProviderDispatch?.();
  const result = await attachmentAudioToTranscriptBlock(envelope, classification, provider, {
    ...(args.signal ? { signal: args.signal } : {}),
  });
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
    funding?: VoiceServiceFunding;
    beginCost?: (receipt: ServerProviderCostAttemptAdmission) => Promise<void>;
    settleCost?: (receipt: ServerProviderCostReceipt) => Promise<void>;
    getCapabilities?: typeof getUserCapabilities;
  } = {},
) {
  const funding = deps.funding ?? directVoiceServiceFunding;
  const beginCost = deps.beginCost ?? beginServerProviderCostAttempt;
  const settleCost = deps.settleCost ?? settleServerProviderCostAttempt;
  const getCapabilities = deps.getCapabilities ?? getUserCapabilities;

  app.post("/api/stt", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const humanUserId = request.sessionUserId;
    if (!(await getCapabilities(humanUserId)).includes("use_transcription")) {
      return reply.code(403).send({ error: "Forbidden" });
    }
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
    const abort = new AbortController();
    const cancel = () => abort.abort();
    request.raw.once("aborted", cancel);
    reply.raw.once("close", cancel);
    try {
      result = await transcribeUploadedAudio({
        bytes: buf,
        filename: data.filename ?? "recording.webm",
        claimedMime: data.mimetype,
        resolveProvider: () => createFundedTranscriptionProvider(humanUserId, { funding, beginCost, settleCost }),
        signal: abort.signal,
      });
    } catch (error) {
      if (error instanceof ServerProviderCredentialsDeniedError) {
        return reply.code(403).send(toActionCapabilityHttpDenial(error));
      }
      if (error instanceof ModelFundingError) {
        const status = error.code === "personal_credential_stale"
          || error.code === "personal_credential_unavailable" ? 409
          : error.code === "personal_credential_missing"
            || error.code === "provider_credentials_missing" ? 503
            : 403;
        return reply.code(status).send({
          error: status === 409
            ? "The saved transcription credential changed or is unavailable."
            : status === 503
              ? "Voice transcription credentials are not configured."
              : "Voice transcription is not available with the current funding permissions.",
          code: error.code,
        });
      }
      throw error;
    } finally {
      request.raw.off("aborted", cancel);
      reply.raw.off("close", cancel);
    }

    if (!result.ok) {
      return reply.code(result.statusCode).send({
        error: result.error,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    }

    return reply.send({
      text: result.text,
      provider: result.provider,
      model: result.model,
    });
  });
}
