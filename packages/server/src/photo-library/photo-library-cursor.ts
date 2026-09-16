import { createHmac, timingSafeEqual } from "node:crypto";

const CURSOR_VERSION = 1;
const CURSOR_TTL_MS = 15 * 60 * 1000;
const CURSOR_DOMAIN = "nautilo.agent-photo-library.cursor.v1\0";
const MINIMUM_SECRET_BYTES = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

export type PhotoLibraryProjection = "recent" | "deleted";

export interface PhotoLibraryCursorPayload {
  readonly version: 1;
  readonly expiresAt: number;
  readonly serverInstanceId: string;
  readonly viewerUserId: string;
  readonly agentId: string;
  readonly projection: PhotoLibraryProjection;
  readonly libraryRevision: string;
  readonly createdAtMicros: string;
  readonly id: string;
}

export type PhotoLibraryCursorDecode =
  | { readonly ok: true; readonly value: PhotoLibraryCursorPayload }
  | { readonly ok: false; readonly reason: "invalid" | "expired" };

function encodePayload(payload: PhotoLibraryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(CURSOR_DOMAIN).update(payload, "utf8").digest("base64url");
}

function validPayload(value: unknown): value is PhotoLibraryCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item["version"] !== CURSOR_VERSION || !Number.isSafeInteger(item["expiresAt"])) return false;
  if (typeof item["serverInstanceId"] !== "string" || !UUID_PATTERN.test(item["serverInstanceId"])) return false;
  if (typeof item["viewerUserId"] !== "string" || !UUID_PATTERN.test(item["viewerUserId"])) return false;
  if (typeof item["agentId"] !== "string" || !UUID_PATTERN.test(item["agentId"])) return false;
  if (item["projection"] !== "recent" && item["projection"] !== "deleted") return false;
  if (typeof item["libraryRevision"] !== "string" || !DECIMAL_PATTERN.test(item["libraryRevision"])) return false;
  if (typeof item["createdAtMicros"] !== "string" || !DECIMAL_PATTERN.test(item["createdAtMicros"])) return false;
  return typeof item["id"] === "string" && UUID_PATTERN.test(item["id"]);
}

export interface PhotoLibraryCursorCodec {
  issue(input: Omit<PhotoLibraryCursorPayload, "version" | "expiresAt">): string;
  decode(raw: string): PhotoLibraryCursorDecode;
}

export function createPhotoLibraryCursorCodec(
  secret: string,
  now: () => Date = () => new Date(),
): PhotoLibraryCursorCodec {
  if (Buffer.byteLength(secret, "utf8") < MINIMUM_SECRET_BYTES) {
    throw new Error("Photo library cursor root is too short");
  }
  return {
    issue(input) {
      const payload: PhotoLibraryCursorPayload = {
        version: CURSOR_VERSION,
        expiresAt: now().getTime() + CURSOR_TTL_MS,
        ...input,
      };
      const encoded = encodePayload(payload);
      return `${encoded}.${signature(secret, encoded)}`;
    },
    decode(raw) {
      const match = /^([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/.exec(raw);
      if (!match) return { ok: false, reason: "invalid" };
      const [payloadText, suppliedSignature] = [match[1]!, match[2]!];
      const expected = signature(secret, payloadText);
      const expectedBytes = Buffer.from(expected, "utf8");
      const suppliedBytes = Buffer.from(suppliedSignature, "utf8");
      if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
        return { ok: false, reason: "invalid" };
      }
      try {
        const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8")) as unknown;
        if (!validPayload(payload)) return { ok: false, reason: "invalid" };
        if (payload.expiresAt <= now().getTime()) return { ok: false, reason: "expired" };
        return { ok: true, value: payload };
      } catch {
        return { ok: false, reason: "invalid" };
      }
    },
  };
}
