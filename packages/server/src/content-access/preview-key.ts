import { createHmac } from "node:crypto";

import { PUSH_TOKEN_ENCRYPTION_KEY } from "@nautilo/operator-secrets";

const CONTENT_ACCESS_PREVIEW_KEY_DOMAIN =
  "nautilo/content-access/server-preview-key/v1";

/**
 * Derive the ordinary content-access preview key from the existing durable
 * per-instance operator secret. The source secret is validated before use and
 * is never returned, retained, or included in an error.
 */
export function resolveContentAccessPreviewKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Uint8Array {
  const encoded = environment[PUSH_TOKEN_ENCRYPTION_KEY];
  if (encoded === undefined || !/^[a-f0-9]{64}$/iu.test(encoded)) {
    throw new TypeError("Content access preview key source is unavailable");
  }
  return new Uint8Array(
    createHmac("sha256", Buffer.from(encoded, "hex"))
      .update(CONTENT_ACCESS_PREVIEW_KEY_DOMAIN, "utf8")
      .digest(),
  );
}
