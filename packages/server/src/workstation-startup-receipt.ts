/**
 * D557 — Stateless, device/pairing-bound Workstation startup receipt.
 *
 * This receipt is proof that the server previously accepted the Human's own
 * PIN for this exact Workstation security context. It is deliberately not a
 * capability, grant, relay session, or profile authority: callers must still
 * resolve and validate every live binding before it can request activation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const RECEIPT_VERSION = 1;
const RECEIPT_PREFIX = "wsr1";
const RECEIPT_DOMAIN = "nautilo.workstation-startup-receipt.v1\0";
const MAX_RECEIPT_LENGTH = 4096;
const MAX_CLAIM_LENGTH = 512;

export interface WorkstationStartupReceiptClaims {
  readonly userId: string;
  readonly instanceId: string;
  readonly serverBindingId: string;
  readonly pairingGeneration: string;
  readonly profileId: string;
  readonly profileRevision: number;
}

interface EncodedClaims {
  readonly v: typeof RECEIPT_VERSION;
  readonly u: string;
  readonly i: string;
  readonly s: string;
  readonly g: string;
  readonly p: string;
  readonly r: number;
}

/** Mint one bounded opaque receipt. The supplied key must be stable server secret material. */
export function mintWorkstationStartupReceipt(
  secret: string,
  claims: WorkstationStartupReceiptClaims,
): string | null {
  const encoded = encodeClaims(claims);
  if (encoded === null) return null;
  const payload = Buffer.from(JSON.stringify(encoded), "utf8").toString("base64url");
  const signature = sign(secret, payload);
  const receipt = `${RECEIPT_PREFIX}.${payload}.${signature}`;
  return receipt.length <= MAX_RECEIPT_LENGTH ? receipt : null;
}

/**
 * Verifies the MAC in constant time and strictly parses the versioned payload.
 * `null` deliberately combines malformed, forged, and unsupported receipts.
 */
export function verifyWorkstationStartupReceipt(
  secret: string,
  receipt: unknown,
): WorkstationStartupReceiptClaims | null {
  if (typeof receipt !== "string" || receipt.length === 0 || receipt.length > MAX_RECEIPT_LENGTH) {
    return null;
  }
  const parts = receipt.split(".");
  const prefix = parts[0];
  const payload = parts[1];
  const suppliedSignature = parts[2];
  if (
    parts.length !== 3 ||
    prefix !== RECEIPT_PREFIX ||
    payload === undefined ||
    suppliedSignature === undefined
  ) return null;
  if (!isBase64Url(payload) || !isBase64Url(suppliedSignature)) return null;
  const expectedSignature = sign(secret, payload);
  const expected = Buffer.from(expectedSignature, "base64url");
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;

  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    return decodeClaims(JSON.parse(decoded));
  } catch {
    return null;
  }
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(RECEIPT_DOMAIN, "utf8")
    .update(payload, "utf8")
    .digest("base64url");
}

function encodeClaims(claims: WorkstationStartupReceiptClaims): EncodedClaims | null {
  if (!areValidClaims(claims)) return null;
  // Property order is part of the signed canonical payload. Do not spread an
  // untrusted object here.
  return {
    v: RECEIPT_VERSION,
    u: claims.userId,
    i: claims.instanceId,
    s: claims.serverBindingId,
    g: claims.pairingGeneration,
    p: claims.profileId,
    r: claims.profileRevision,
  };
}

function decodeClaims(value: unknown): WorkstationStartupReceiptClaims | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims).sort();
  if (keys.length !== 7 || keys.join(",") !== "g,i,p,r,s,u,v") return null;
  if (claims["v"] !== RECEIPT_VERSION) return null;
  const decoded: WorkstationStartupReceiptClaims = {
    userId: claims["u"] as string,
    instanceId: claims["i"] as string,
    serverBindingId: claims["s"] as string,
    pairingGeneration: claims["g"] as string,
    profileId: claims["p"] as string,
    profileRevision: claims["r"] as number,
  };
  return areValidClaims(decoded) ? decoded : null;
}

function areValidClaims(claims: WorkstationStartupReceiptClaims): boolean {
  return (
    isBoundedString(claims.userId) &&
    typeof claims.instanceId === "string" &&
    claims.instanceId.length <= MAX_CLAIM_LENGTH &&
    isBoundedString(claims.serverBindingId) &&
    isBoundedString(claims.pairingGeneration) &&
    isBoundedString(claims.profileId) &&
    Number.isSafeInteger(claims.profileRevision) &&
    claims.profileRevision >= 1
  );
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CLAIM_LENGTH;
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
