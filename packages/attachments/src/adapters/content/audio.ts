import { scanContent } from "@nautilo/security";
import type { AttachmentTextContentBlock } from "../../content-blocks";
import type { AttachmentClassification, AttachmentEnvelope } from "../../envelope";
import type { TranscriptionProvider } from "../../transcription/provider";

export type AudioAdapterResult =
  | { ok: true; block: AttachmentTextContentBlock; provider: string; model: string; transcriptText: string }
  | { ok: false; reason: string; code: "invalid_classification" | "missing_bytes" | "provider_unavailable" | "provider_error" };

export async function attachmentAudioToTranscriptBlock(
  envelope: AttachmentEnvelope,
  classification: AttachmentClassification,
  provider: TranscriptionProvider | null | undefined,
  options: { language?: string; timestamps?: boolean } = {},
): Promise<AudioAdapterResult> {
  if (classification.decision !== "accept" || classification.kind !== "audio") {
    return {
      ok: false,
      code: "invalid_classification",
      reason: "audio adapter requires an accepted audio classification",
    };
  }
  if (!envelope.bytes) {
    return {
      ok: false,
      code: "missing_bytes",
      reason: "audio adapter requires byte-backed envelope content",
    };
  }
  if (!provider || !(await provider.available())) {
    return {
      ok: false,
      code: "provider_unavailable",
      reason: "No transcription provider configured",
    };
  }

  let transcript;
  try {
    transcript = await provider.transcribe({
      bytes: envelope.bytes,
      filename: envelope.filename,
      mime: classification.normalizedMime,
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.timestamps !== undefined ? { timestamps: options.timestamps } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      code: "provider_error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const wrapped = wrapUntrustedTranscript(envelope, transcript.text, transcript.provider, transcript.model);
  const scan = scanContent(wrapped, `attachment-transcript:${envelope.filename}`);
  if (!scan.safe && scan.replacement) {
    return {
      ok: true,
      provider: transcript.provider,
      model: transcript.model,
      transcriptText: transcript.text,
      block: {
        type: "text",
        text: scan.replacement,
        attachmentId: envelope.id,
        filename: envelope.filename,
        scanned: true,
        blocked: true,
        truncated: false,
        threats: scan.threats,
      },
    };
  }

  return {
    ok: true,
    provider: transcript.provider,
    model: transcript.model,
    transcriptText: transcript.text,
    block: {
      type: "text",
      text: wrapped,
      attachmentId: envelope.id,
      filename: envelope.filename,
      scanned: true,
      blocked: false,
      truncated: false,
      threats: [],
    },
  };
}

function wrapUntrustedTranscript(
  envelope: AttachmentEnvelope,
  transcript: string,
  provider: string,
  model: string,
): string {
  return [
    `<attachment-transcript id="${escapeForTag(envelope.id)}" filename="${escapeForTag(envelope.filename)}" provider="${escapeForTag(provider)}" model="${escapeForTag(model)}" untrusted="true">`,
    transcript,
    "</attachment-transcript>",
  ].join("\n");
}

function escapeForTag(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
