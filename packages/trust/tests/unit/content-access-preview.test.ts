import { describe, expect, test } from "bun:test";
import {
  CONTENT_ACCESS_PREVIEW_TTL_MS,
  createContentAccessPreviewCodec,
} from "../../src/content-access-preview";

const binding = {
  operationId: "00000000-0000-4000-8000-000000000001",
  intentDigest: "c".repeat(64),
  requestDigest: "a".repeat(64),
};
const key = new Uint8Array(32).fill(7);

describe("ordinary content access preview", () => {
  test("valid for ten minutes, then authentic only for historical receipt lookup", () => {
    let now = 1000;
    const codec = createContentAccessPreviewCodec(key, () => now);
    const token = codec.issue(binding);
    expect(CONTENT_ACCESS_PREVIEW_TTL_MS).toBe(600_000);
    expect(codec.verify(token)).toEqual({ status: "valid", claims: {
      version: 1, ...binding, issuedAt: 1000, expiresAt: 601_000,
    } });
    now = 600_999;
    expect(codec.verify(token).status).toBe("valid");
    now = 601_000;
    expect(codec.verify(token)).toEqual({ status: "expired", claims: {
      version: 1, ...binding, issuedAt: 1000, expiresAt: 601_000,
    } });
  });

  test("survives codec reconstruction with the same instance key", () => {
    const token = createContentAccessPreviewCodec(key, () => 1000).issue(binding);
    expect(createContentAccessPreviewCodec(key, () => 2000).verify(token).status).toBe("valid");
    expect(createContentAccessPreviewCodec(new Uint8Array(32).fill(8), () => 2000)
      .verify(token)).toEqual({ status: "invalid" });
  });

  test("does not retain caller-mutable key bytes", () => {
    const supplied = new Uint8Array(key);
    const codec = createContentAccessPreviewCodec(supplied, () => 1000);
    const token = codec.issue(binding);
    supplied.fill(0);
    expect(codec.verify(token).status).toBe("valid");
  });

  test("rejects tampering, malformed encodings, truncation and token concatenation", () => {
    const codec = createContentAccessPreviewCodec(key, () => 1000);
    const token = codec.issue(binding);
    const [payload, signature] = token.split(".");
    const changed = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
    changed["requestDigest"] = "b".repeat(64);
    const forged = `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`;
    for (const invalid of ["", token.slice(0, -1), token + "=", `${token}.${token}`, forged]) {
      expect(codec.verify(invalid)).toEqual({ status: "invalid" });
    }
  });

  test("rejects clock rollback and malformed trusted inputs", () => {
    const codec = createContentAccessPreviewCodec(key, () => 1000);
    const token = codec.issue(binding);
    expect(createContentAccessPreviewCodec(key, () => 999).verify(token)).toEqual({ status: "invalid" });
    expect(() => codec.issue({ ...binding, operationId: "not-a-uuid" })).toThrow();
    expect(() => codec.issue({ ...binding, requestDigest: "A".repeat(64) })).toThrow();
    expect(() => createContentAccessPreviewCodec(key, () => Number.MAX_SAFE_INTEGER)
      .issue(binding)).toThrow();
    expect(() => createContentAccessPreviewCodec(new Uint8Array(1))).toThrow();
  });
});
