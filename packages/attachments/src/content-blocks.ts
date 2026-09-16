import type { AttachmentClassification, AttachmentEnvelope } from "./envelope";
import { sanitizeAttachmentMetadataLine } from "./attachment-metadata-sanitize";

export type AttachmentTextContentBlock = {
  type: "text";
  text: string;
  attachmentId: string;
  filename: string;
  scanned: boolean;
  blocked: boolean;
  truncated: boolean;
  threats: string[];
};

export type AttachmentStubContentBlock = {
  type: "text";
  text: string;
  attachmentId: string;
  filename: string;
  blocked: false;
  scanned: false;
  truncated: false;
  threats: [];
};

export type AttachmentContentBlock =
  | AttachmentTextContentBlock
  | AttachmentStubContentBlock;

export function metadataBlockForClassification(
  envelope: AttachmentEnvelope,
  classification: AttachmentClassification,
): AttachmentStubContentBlock {
  const safeName = sanitizeAttachmentMetadataLine(envelope.filename);
  let safeReason = "";
  if (classification.decision === "reject") {
    safeReason = sanitizeAttachmentMetadataLine(classification.reason, 400);
  } else if (classification.decision === "stub") {
    safeReason = sanitizeAttachmentMetadataLine(classification.reason, 400);
  }
  const status =
    classification.decision === "reject"
      ? `rejected: ${safeReason}`
      : classification.decision === "stub"
        ? `stub: ${safeReason}`
        : `accepted ${classification.kind}`;

  return {
    type: "text",
    text: `[Attachment ${status}: ${safeName} (${envelope.sizeBytes} bytes)]`,
    attachmentId: sanitizeAttachmentMetadataLine(envelope.id, 128),
    filename: safeName,
    blocked: false,
    scanned: false,
    truncated: false,
    threats: [],
  };
}
