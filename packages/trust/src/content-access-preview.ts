import { createHmac, timingSafeEqual } from "node:crypto";

/** Explicit Human policy: ordinary access review lasts ten minutes. */
export const CONTENT_ACCESS_PREVIEW_TTL_MS = 10 * 60 * 1000;
const DOMAIN = "nautilo/content-access/preview/v1\0";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type ContentAccessPreviewBinding = Readonly<{
  operationId: string;
  /** Commitment to the original normalized command, principal and admission. */
  intentDigest: string;
  /** Server-derived commitment to principal, object/revision, context, action,
   * sensitivity and policy. A client-supplied digest is never authority. */
  requestDigest: string;
}>;

export type ContentAccessPreviewClaims = ContentAccessPreviewBinding & Readonly<{
  version: 1;
  issuedAt: number;
  expiresAt: number;
}>;

export type ContentAccessPreviewVerification =
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "valid" | "expired"; claims: ContentAccessPreviewClaims }>;

function encode(claims: ContentAccessPreviewClaims): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    operationId: claims.operationId,
    intentDigest: claims.intentDigest,
    requestDigest: claims.requestDigest,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  }), "utf8").toString("base64url");
}

// Derived from the fixed wire shape, UUID/SHA-256 widths and JS integer range;
// not a product audience/payload limit. No content or audience is in the token.
const MAX_ENCODED_CLAIMS_LENGTH = encode({
  version: 1,
  operationId: "00000000-0000-4000-8000-000000000000",
  intentDigest: "0".repeat(64),
  requestDigest: "0".repeat(64),
  issuedAt: Number.MAX_SAFE_INTEGER,
  expiresAt: Number.MAX_SAFE_INTEGER,
}).length;
const SIGNATURE_LENGTH = Buffer.alloc(32).toString("base64url").length;

function validClaims(value: unknown): value is ContentAccessPreviewClaims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return Object.keys(claims).sort().join(",") === "expiresAt,intentDigest,issuedAt,operationId,requestDigest,version"
    && claims["version"] === 1
    && typeof claims["operationId"] === "string" && UUID.test(claims["operationId"])
    && typeof claims["intentDigest"] === "string" && DIGEST.test(claims["intentDigest"])
    && typeof claims["requestDigest"] === "string" && DIGEST.test(claims["requestDigest"])
    && typeof claims["issuedAt"] === "number" && Number.isSafeInteger(claims["issuedAt"])
    && claims["issuedAt"] >= 0
    && typeof claims["expiresAt"] === "number" && Number.isSafeInteger(claims["expiresAt"])
    && claims["expiresAt"] - claims["issuedAt"] === CONTENT_ACCESS_PREVIEW_TTL_MS;
}

/**
 * Stateless exact-preview authenticity, not permission or approval. Composition
 * supplies a stable purpose-separated instance key. Before new publication the
 * owner must reauthorize, re-plan and compare requestDigest on its transaction,
 * as well as check any invocation-specific approval/proof requirements.
 *
 * Authentic expired claims may locate a terminal receipt, never execute a new
 * mutation. This permits truthful lost-response recovery without resurrecting a
 * grant after revocation. Invalid tokens expose no claims. No timers, retained
 * invocation state, or prepared-plan rows are created here.
 */
export function createContentAccessPreviewCodec(
  instanceKey: Uint8Array,
  now: () => number = Date.now,
) {
  if (instanceKey.byteLength !== 32) {
    throw new TypeError("Content access preview requires a SHA-256 instance key");
  }
  const key = Buffer.from(instanceKey);
  const sign = (payload: string): Buffer =>
    createHmac("sha256", key).update(DOMAIN).update(payload, "utf8").digest();

  return Object.freeze({
    issue(binding: ContentAccessPreviewBinding): string {
      const issuedAt = now();
      const claims: ContentAccessPreviewClaims = {
        version: 1,
        operationId: binding.operationId,
        intentDigest: binding.intentDigest,
        requestDigest: binding.requestDigest,
        issuedAt,
        expiresAt: issuedAt + CONTENT_ACCESS_PREVIEW_TTL_MS,
      };
      if (!validClaims(claims)) throw new TypeError("Invalid content access preview binding");
      const payload = encode(claims);
      return `${payload}.${sign(payload).toString("base64url")}`;
    },
    verify(token: string): ContentAccessPreviewVerification {
      if (token.length > MAX_ENCODED_CLAIMS_LENGTH + 1 + SIGNATURE_LENGTH) {
        return { status: "invalid" };
      }
      const parts = token.split(".");
      if (parts.length !== 2) return { status: "invalid" };
      const [payload, signature] = parts;
      if (!payload || !signature || signature.length !== SIGNATURE_LENGTH
        || !/^[A-Za-z0-9_-]+$/.test(payload)) return { status: "invalid" };
      const supplied = Buffer.from(signature, "base64url");
      const expected = sign(payload);
      if (supplied.length !== expected.length
        || supplied.toString("base64url") !== signature
        || !timingSafeEqual(supplied, expected)) return { status: "invalid" };
      try {
        const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!validClaims(claims) || encode(claims) !== payload) return { status: "invalid" };
        const currentTime = now();
        if (!Number.isSafeInteger(currentTime) || currentTime < claims.issuedAt) {
          return { status: "invalid" };
        }
        return Object.freeze({
          status: currentTime >= claims.expiresAt ? "expired" : "valid",
          claims: Object.freeze(claims),
        });
      } catch {
        return { status: "invalid" };
      }
    },
  });
}
