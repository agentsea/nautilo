/**
 * M055 — PKCE helpers.
 *
 * Pure module; no Electron / no network. Round-trips the SHA-256
 * relationship between verifier and challenge so a regression that
 * accidentally swapped the encode order would fail.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { base64url, generatePkcePair, generateState } from "../../../electron/auth/pkce";

describe("generatePkcePair", () => {
  test("verifier is 86 base64url chars (64 random bytes)", () => {
    const { codeVerifier } = generatePkcePair();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  test("challenge is SHA-256(verifier) base64url-encoded", () => {
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const recomputed = base64url(
      createHash("sha256").update(codeVerifier).digest(),
    );
    expect(codeChallenge).toBe(recomputed);
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("two pairs differ (uses random bytes per call)", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe("generateState", () => {
  test("256-bit base64url string", () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("two calls differ", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("base64url", () => {
  test("strips padding and url-safe substitutes", () => {
    const raw = Buffer.from("any carnal pleasur");
    const encoded = base64url(raw);
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });
});
