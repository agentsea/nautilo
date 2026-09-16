import { scanContent } from "@nautilo/security";
import type { AttachmentTextContentBlock } from "../../content-blocks";
import type { AttachmentClassification, AttachmentEnvelope } from "../../envelope";
import { ATTACHMENT_POLICY } from "../../policy";

export type TextAdapterResult =
  | { ok: true; block: AttachmentTextContentBlock }
  | { ok: false; reason: string };

export function attachmentTextToContentBlock(
  envelope: AttachmentEnvelope,
  classification: AttachmentClassification,
): TextAdapterResult {
  if (classification.decision !== "accept" || classification.kind !== "text") {
    return { ok: false, reason: "text adapter requires an accepted text classification" };
  }
  if (!envelope.bytes) {
    return { ok: false, reason: "text adapter requires byte-backed envelope content" };
  }

  const bytes = envelope.bytes.subarray(0, ATTACHMENT_POLICY.maxTextBytes);
  const truncated = envelope.bytes.length > ATTACHMENT_POLICY.maxTextBytes;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "text attachment failed UTF-8 decoding" };
  }

  const wrapped = wrapUntrustedAttachmentText(envelope, decoded, truncated);
  const scan = scanContent(wrapped, `attachment:${envelope.filename}`);
  if (!scan.safe && scan.replacement) {
    return {
      ok: true,
      block: {
        type: "text",
        text: scan.replacement,
        attachmentId: envelope.id,
        filename: envelope.filename,
        scanned: true,
        blocked: true,
        truncated,
        threats: scan.threats,
      },
    };
  }

  return {
    ok: true,
    block: {
      type: "text",
      text: wrapped,
      attachmentId: envelope.id,
      filename: envelope.filename,
      scanned: true,
      blocked: false,
      truncated,
      threats: [],
    },
  };
}

function wrapUntrustedAttachmentText(
  envelope: AttachmentEnvelope,
  decoded: string,
  truncated: boolean,
): string {
  const truncationNote = truncated
    ? "\n[Attachment truncated at the configured text size cap.]"
    : "";
  return [
    `<attachment id="${escapeForTag(envelope.id)}" filename="${escapeForTag(envelope.filename)}" untrusted="true">`,
    decoded,
    `${truncationNote}</attachment>`,
  ].join("\n");
}

function escapeForTag(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
