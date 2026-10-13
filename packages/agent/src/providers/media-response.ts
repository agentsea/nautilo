import { ATTACHMENT_POLICY } from "@nautilo/attachments";

/** Non-content provider discovery, estimates and job-status envelopes. */
export const MAX_MEDIA_METADATA_JSON_BYTES = 1024 * 1024;

// Bound the encoded response as well as the decoded images. The four-image
// request ceiling and per-image base64 margin are existing image contracts;
// the envelope allowance covers non-image response metadata.
export const MAX_IMAGE_RESPONSE_JSON_BYTES =
  Math.ceil(ATTACHMENT_POLICY.maxAcceptedBytesPerMessage / 3) * 4
  + 4 * 64 + 64 * 1024;

export class MediaResponseReadError extends Error {
  constructor(readonly reason: "too_large" | "invalid" | "interrupted") {
    super(reason === "too_large"
      ? "The media provider response exceeded the accepted byte limit."
      : reason === "invalid"
        ? "The media provider response was not valid JSON."
        : "The media provider response could not be read.");
    this.name = "MediaResponseReadError";
  }
}

/** Read provider JSON with a byte ceiling even when Content-Length is absent or false. */
export async function readBoundedMediaJson(
  response: Response,
  maxBytes = MAX_MEDIA_METADATA_JSON_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("A positive exact media response byte limit is required.");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new MediaResponseReadError("too_large");
  }
  if (!response.body) throw new MediaResponseReadError("invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); }
      catch { throw new MediaResponseReadError("interrupted"); }
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new MediaResponseReadError("invalid");
      total += value.byteLength;
      if (total > maxBytes) throw new MediaResponseReadError("too_large");
      try { text += decoder.decode(value, { stream: true }); }
      catch { throw new MediaResponseReadError("invalid"); }
    }
    try {
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch {
      throw new MediaResponseReadError("invalid");
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Read bounded provider binary bytes, cancelling as soon as the real stream exceeds the limit. */
export async function readBoundedMediaBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("A positive exact media response byte limit is required.");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new MediaResponseReadError("too_large");
  }
  if (!response.body) throw new MediaResponseReadError("invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); }
      catch { throw new MediaResponseReadError("interrupted"); }
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new MediaResponseReadError("invalid");
      total += value.byteLength;
      if (total > maxBytes) throw new MediaResponseReadError("too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
