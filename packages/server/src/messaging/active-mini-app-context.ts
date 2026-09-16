/**
 * M187 — advisory sanitization for `activeMiniApp` chat ingress.
 * Malformed/oversized payloads drop to null without blocking the message.
 */
import type { ActiveMiniAppRequestContext, ActiveMiniAppTargetKind } from "@nautilo/types";

const APP_ID_MAX_LEN = 128;
const APP_NAME_MAX_LEN = 256;
const DOCUMENT_PATH_MAX_LEN = 512;
const CONTEXT_JSON_FIELD_LIMIT = 10_000;

const FORBIDDEN_KEYS = new Set([
  "artifactId",
  "artifact_id",
  "id",
  "roomId",
  "namespaceId",
  "rootPath",
]);

const CELL_PAYLOAD_KEYS = new Set(["cells", "cellData", "sheetData", "values", "grid"]);

function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, "");
}

function truncateString(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function containsCellPayload(value: unknown, depth = 0): boolean {
  if (depth > 6 || value == null) return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsCellPayload(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (CELL_PAYLOAD_KEYS.has(key)) return true;
    if (containsCellPayload(nested, depth + 1)) return true;
  }
  return false;
}

function stripForbiddenKeys(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripForbiddenKeys(item, depth + 1));
  }
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (containsCellPayload(nested, depth + 1)) continue;
    out[key] = stripForbiddenKeys(nested, depth + 1);
  }
  return out;
}

function stripCellPayloadBranches(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripCellPayloadBranches(item, depth + 1));
  }
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (CELL_PAYLOAD_KEYS.has(key)) continue;
    out[key] = stripCellPayloadBranches(nested, depth + 1);
  }
  return out;
}

function sanitizeJsonField(raw: unknown): unknown {
  if (raw === undefined) return undefined;
  if (containsCellPayload(raw)) {
    raw = stripCellPayloadBranches(raw);
  }
  try {
    const stripped = stripForbiddenKeys(raw);
    const encoded = JSON.stringify(stripped);
    if (encoded === undefined || encoded.length > CONTEXT_JSON_FIELD_LIMIT) return undefined;
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

function sanitizeTargetKind(raw: unknown): ActiveMiniAppTargetKind | undefined {
  if (raw === "artifact" || raw === "fs") return raw;
  return undefined;
}

function sanitizeUpdatedAt(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw;
}

/**
 * Best-effort sanitizer for chat ingress. Never throws.
 */
export function sanitizeActiveMiniAppContextSafe(
  raw: unknown,
): ActiveMiniAppRequestContext | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;

  const appIdRaw = src["appId"];
  if (!isNonEmptyString(appIdRaw)) return null;
  const appId = truncateString(stripControlChars(appIdRaw.trim()), APP_ID_MAX_LEN);
  if (!appId) return null;

  const updatedAt = sanitizeUpdatedAt(src["updatedAt"]);
  if (updatedAt == null) return null;

  const out: ActiveMiniAppRequestContext = { appId, updatedAt };

  const appNameRaw = src["appName"];
  if (typeof appNameRaw === "string") {
    const appName = truncateString(stripControlChars(appNameRaw.trim()), APP_NAME_MAX_LEN);
    if (appName) out.appName = appName;
  }

  const documentPathRaw = src["documentPath"];
  if (typeof documentPathRaw === "string") {
    const documentPath = truncateString(
      stripControlChars(documentPathRaw.trim()),
      DOCUMENT_PATH_MAX_LEN,
    );
    if (documentPath) out.documentPath = documentPath;
  }

  const targetKind = sanitizeTargetKind(src["targetKind"]);
  if (targetKind) out.targetKind = targetKind;

  const selection = sanitizeJsonField(src["selection"]);
  if (selection !== undefined) out.selection = selection;

  const summary = sanitizeJsonField(src["summary"]);
  if (summary !== undefined) out.summary = summary;

  return out;
}
