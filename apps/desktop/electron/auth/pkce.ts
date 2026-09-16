/**
 * M055 — PKCE (RFC 7636) helpers for the Electron loopback flow.
 *
 * Pure module. No Electron dependencies; safe to import from unit
 * tests under `bun:test`.
 */
import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  /** 64 random bytes, base64url-encoded → 86-char ASCII string. */
  codeVerifier: string;
  /** SHA-256(codeVerifier), base64url-encoded → 43-char ASCII string. */
  codeChallenge: string;
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = base64url(randomBytes(64));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  return { codeVerifier, codeChallenge };
}

/** 256-bit random state token, base64url-encoded. */
export function generateState(): string {
  return base64url(randomBytes(32));
}

export function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
