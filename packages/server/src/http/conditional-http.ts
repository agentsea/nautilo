import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";
export const VARY_AUTHORIZATION = "Authorization";

export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

/** Opaque weak ETag from a pre-canonicalized digest input string. */
export function weakETagFromDigestInput(input: string): string {
  return `W/"${sha256Base64Url(input)}"`;
}

/** Exact token match against a single weak ETag value; ignores `*`. */
export function ifNoneMatchEquals(
  ifNoneMatch: string | string[] | undefined,
  etag: string,
): boolean {
  if (ifNoneMatch === undefined) return false;
  const raw = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
  if (raw.trim().length === 0) return false;
  for (const token of raw.split(",")) {
    if (token.trim() === etag) return true;
  }
  return false;
}

function setPrivateConditionalReadHeaders(reply: FastifyReply, etag: string): void {
  reply.header("ETag", etag);
  reply.header("Vary", VARY_AUTHORIZATION);
  reply.header("Cache-Control", PRIVATE_NO_STORE_CACHE_CONTROL);
}

export function sendPrivateConditionalRead(
  request: FastifyRequest,
  reply: FastifyReply,
  etag: string,
  body: unknown,
): FastifyReply {
  setPrivateConditionalReadHeaders(reply, etag);
  if (ifNoneMatchEquals(request.headers["if-none-match"], etag)) {
    return reply.status(304).send();
  }
  return reply.send(body);
}
