/** Decode exact unpadded base64url, rejecting alternate pad-bit spellings. */
export function decodeCanonicalBase64url(
  value: string,
  expectedLength?: number,
): Uint8Array | null {
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (
    Buffer.from(bytes).toString("base64url") !== value
    || (expectedLength !== undefined && bytes.length !== expectedLength)
  ) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}
