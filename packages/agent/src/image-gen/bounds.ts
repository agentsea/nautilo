import { ATTACHMENT_POLICY, maxChatImageBase64CharLength } from "@nautilo/attachments";
import { DirectImageAttemptError } from "./errors";

function validBase64(value: string): boolean {
  return value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export function decodeBoundedImageBase64(
  value: string,
  provider: string,
): Buffer {
  if (!value || value.length > maxChatImageBase64CharLength() || !validBase64(value)) {
    throw new DirectImageAttemptError(
      `${provider} image generation returned invalid or oversized image data.`,
      "unknown",
      "invalid_provider_response",
    );
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > ATTACHMENT_POLICY.maxImageBytes) {
    throw new DirectImageAttemptError(
      `${provider} image generation returned an image larger than the supported limit.`,
      "unknown",
      "provider_output_too_large",
    );
  }
  return bytes;
}

export function assertImageOutputBounds(
  bytes: readonly Uint8Array[],
  provider: string,
): void {
  let total = 0;
  for (const image of bytes) {
    if (image.byteLength > ATTACHMENT_POLICY.maxImageBytes) {
      throw new DirectImageAttemptError(
        `${provider} image generation returned an image larger than the supported limit.`,
        "unknown",
        "provider_output_too_large",
      );
    }
    total += image.byteLength;
    if (total > ATTACHMENT_POLICY.maxAcceptedBytesPerMessage) {
      throw new DirectImageAttemptError(
        `${provider} image generation returned more image data than the supported request limit.`,
        "unknown",
        "provider_output_too_large",
      );
    }
  }
}
