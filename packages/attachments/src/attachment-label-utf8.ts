import { Buffer } from "node:buffer";
import { ATTACHMENT_POLICY } from "./policy";

/**
 * UTF-8 byte length of a string (Node). Used for attachment id / filename bounds.
 */
export function attachmentLabelUtf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function attachmentIdExceedsUtf8Policy(s: string): boolean {
  return attachmentLabelUtf8ByteLength(s) > ATTACHMENT_POLICY.maxAttachmentIdUtf8Bytes;
}

export function attachmentFilenameExceedsUtf8Policy(s: string): boolean {
  return attachmentLabelUtf8ByteLength(s) > ATTACHMENT_POLICY.maxAttachmentFilenameUtf8Bytes;
}

/**
 * @deprecated Prefer {@link attachmentIdExceedsUtf8Policy} / {@link attachmentFilenameExceedsUtf8Policy}.
 * True when `s` exceeds the legacy combined ceiling ({@link ATTACHMENT_POLICY.maxAttachmentLabelUtf8Bytes}).
 */
export function attachmentLabelExceedsUtf8Policy(s: string): boolean {
  return attachmentLabelUtf8ByteLength(s) > ATTACHMENT_POLICY.maxAttachmentLabelUtf8Bytes;
}
