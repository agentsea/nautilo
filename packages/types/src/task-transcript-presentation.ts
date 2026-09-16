/**
 * D547 — runtime-free projection of one Task run's agent transcript.
 *
 * The Task detail API is authoritative for ordering and redaction.  This
 * module deliberately makes no request, reads no clock, and does not infer a
 * tool outcome: a later durable tool row means only that a result was
 * recorded.  Both Desktop and Mobile render this same projection.
 */

import type { TaskDetail, TaskRunTranscriptMessage } from "./task-api";
import { localToolControlReceiptSchema, localToolControlDisplaySchema } from "./local-tool-control";
import { projectSecurityScanCardResult } from "./security-scan-card";

const REDACTED = "[redacted]";
const OMITTED = "[omitted]";
const MAX_DEPTH = 5;
const MAX_OBJECT_ENTRIES = 64;
const MAX_ARRAY_ITEMS = 64;
const MAX_STRING_CHARS = 4_096;
const MAX_TOOL_NAME_CHARS = 256;
const MAX_SERIALIZED_ARGS_CHARS = 65_536;
const MAX_SERIALIZED_RESULT_CHARS = 262_144;
const MAX_DISPLAY_KEY_CHARS = 128;
const MAX_PROJECTED_NODES = 512;
const BEARER_CREDENTIAL = /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const JWT_LIKE_CREDENTIAL = /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\b/g;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveToolArgumentKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized === "auth"
    || normalized.includes("authorization")
    || normalized.includes("credential")
    || normalized.includes("apikey")
    || normalized === "token"
    || normalized.endsWith("token")
    || normalized === "cursor"
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("passphrase")
    || normalized.includes("privatekey")
    || normalized === "cookie"
    || normalized.endsWith("cookie")
    || normalized === "pin"
    || normalized.endsWith("pin")
    || normalized === "otp";
}

function isToolCardCapabilityKey(key: string): boolean {
  return isSensitiveToolArgumentKey(key) || normalizedKey(key) === "nextcursor";
}

export function redactToolTranscriptCredentialMaterial(value: string): string {
  return value
    .replace(BEARER_CREDENTIAL, "Bearer [redacted]")
    .replace(JWT_LIKE_CREDENTIAL, REDACTED);
}

function boundedString(value: string): string {
  const bounded = value.length <= MAX_STRING_CHARS ? value : `${value.slice(0, MAX_STRING_CHARS - 1)}…`;
  return redactToolTranscriptCredentialMaterial(bounded);
}

function boundedLabel(value: string): string {
  return value.length <= MAX_DISPLAY_KEY_CHARS ? value : `${value.slice(0, MAX_DISPLAY_KEY_CHARS - 1)}…`;
}

function boundedToolName(value: string): string {
  return value.length <= MAX_TOOL_NAME_CHARS ? value : `${value.slice(0, MAX_TOOL_NAME_CHARS - 1)}…`;
}

function ownDataProperty(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && "value" in descriptor ? descriptor.value : OMITTED;
}

function projectValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0) return OMITTED;
  budget.remaining -= 1;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : OMITTED;
  if (typeof value === "bigint") return boundedString(String(value));
  if (depth >= MAX_DEPTH || typeof value !== "object" || value === null || ancestors.has(value)) return OMITTED;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const rawLength = ownDataProperty(value, "length");
      const length = typeof rawLength === "number" && Number.isSafeInteger(rawLength) ? Math.max(0, rawLength) : 0;
      const next: unknown[] = [];
      for (let index = 0; index < Math.min(length, MAX_ARRAY_ITEMS); index += 1) {
        next.push(projectValue(ownDataProperty(value, index), depth + 1, ancestors, budget));
      }
      if (length > MAX_ARRAY_ITEMS) next.push(OMITTED);
      return next;
    }

    const next: Record<string, unknown> = {};
    const keys: string[] = [];
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      keys.push(key);
      if (keys.length > MAX_OBJECT_ENTRIES) break;
    }
    for (const key of keys.slice(0, MAX_OBJECT_ENTRIES)) {
      // Transcript cards are disclosure surfaces, never capability forms.
      if (isToolCardCapabilityKey(key)) continue;
      Object.defineProperty(next, boundedLabel(key), {
        enumerable: true,
        configurable: true,
        writable: true,
        value: isSensitiveToolArgumentKey(key)
          ? REDACTED
          : projectValue(ownDataProperty(value, key), depth + 1, ancestors, budget),
      });
    }
    if (keys.length > MAX_OBJECT_ENTRIES) next["…"] = OMITTED;
    return next;
  } catch {
    return OMITTED;
  } finally {
    ancestors.delete(value);
  }
}

/** Safe, bounded arguments for a durable transcript card. */
export function projectTaskTranscriptToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const projected = projectValue(args, 0, new WeakSet<object>(), { remaining: MAX_PROJECTED_NODES });
  if (typeof projected !== "object" || projected === null || Array.isArray(projected)) return {};
  try {
    return JSON.stringify(projected).length <= MAX_SERIALIZED_ARGS_CHARS
      ? projected as Record<string, unknown>
      : {};
  } catch { return {}; }
}

/** Safe, bounded result text for a durable transcript card. */
export function projectTaskTranscriptToolResult(result: string | undefined): string | undefined {
  if (result === undefined) return undefined;
  if (result.includes('"local_tool_control"')) {
    try {
      const value: unknown = JSON.parse(result);
      const control = localToolControlReceiptSchema.safeParse(value);
      if (control.success) {
        const { runtimeRecovery, ...receipt } = control.data;
        const { nextContextRef: _handle, ...facts } = runtimeRecovery ?? {};
        return redactToolTranscriptCredentialMaterial(JSON.stringify({ ...receipt, ...(runtimeRecovery ? { runtimeRecovery: facts } : {}) }));
      }
      // Repeated live/history projection retains the same validated display data.
      const display = localToolControlDisplaySchema.safeParse(value);
      if (display.success) return redactToolTranscriptCredentialMaterial(JSON.stringify(display.data));
    } catch { /* Non-receipts retain the ordinary safe preview. */ }
  }
  // Security receipts have a validated, display-only projection before the
  // generic preview limits can corrupt linked records. Canonical bytes stay
  // unchanged; repeated live/history/card projection is idempotent.
  if (result.includes('"operation"') || result.includes('"displayFormat"')) {
    try {
      const security = projectSecurityScanCardResult(JSON.parse(result));
      if (security) return redactToolTranscriptCredentialMaterial(JSON.stringify(security));
    } catch { /* Malformed/non-security results retain the generic safe fallback. */ }
  }
  if (result.length > MAX_SERIALIZED_RESULT_CHARS) return "[result too large to preview]";
  try {
    const parsed: unknown = JSON.parse(result);
    const projected = projectValue(parsed, 0, new WeakSet<object>(), { remaining: MAX_PROJECTED_NODES });
    if (JSON.stringify(projected) === JSON.stringify(parsed)) return redactToolTranscriptCredentialMaterial(result);
    return typeof projected === "string" ? projected : JSON.stringify(projected, null, 2);
  } catch {
    if (/[["']?(?:session[_-]?token|access[_-]?token|refresh[_-]?token|authorization|api[_-]?key|password|passphrase|private[_-]?key|secret|cookie|approval[_-]?pin|admin[_-]?pin|owner[_-]?pin|security[_-]?pin|otp|cursor|next[_-]?cursor)["']?\s*:/i.test(result)) {
      return "[structured result could not be safely previewed]";
    }
    return redactToolTranscriptCredentialMaterial(result);
  }
}

export interface TaskTranscriptMessageVM {
  /** Stable source identity, authored by the mapper rather than by a renderer. */
  readonly key: string;
  readonly role: string;
  readonly content: string;
  readonly toolName?: string | null;
  readonly args?: Record<string, unknown>;
  /** Defined only when a durable tool result row was recorded. It is not an outcome. */
  readonly resultText?: string;
  readonly toolCallId?: string;
  readonly toolStatus?: "success" | "error";
  readonly createdAt: string;
}

export function isTaskTranscriptToolRow(message: Pick<TaskTranscriptMessageVM, "role" | "toolName">): boolean {
  return message.role === "tool" && typeof message.toolName === "string" && message.toolName.length > 0;
}

/**
 * Preserves row order and pairs assistant calls to later unconsumed tool rows:
 * exact call identity when present; legacy rows retain display-only name pairing.
 * Missing outcome stays unknown. Ambiguous identities never borrow another result.
 */
export function taskRunTranscriptToPresentation(messages: readonly TaskRunTranscriptMessage[], runId = "run"): TaskTranscriptMessageVM[] {
  const rows: TaskTranscriptMessageVM[] = [];
  const consumedToolIndices = new Set<number>();
  const exactPairs = new Map<string, number>();
  const callIdCounts = new Map<string, number>();
  const receiptIdCounts = new Map<string, number>();
  for (const row of messages) {
    if (row.role === "assistant") {
      for (const call of row.toolCalls ?? []) if (call.id) callIdCounts.set(call.id, (callIdCounts.get(call.id) ?? 0) + 1);
    } else if (row.role === "tool" && row.toolCallId) {
      receiptIdCounts.set(row.toolCallId, (receiptIdCounts.get(row.toolCallId) ?? 0) + 1);
    }
  }
  const pending = new Map<string, { key: string; name: string } | null>();
  for (const [index, row] of messages.entries()) {
    if (row.role === "assistant") {
      for (const [callIndex, call] of (row.toolCalls ?? []).entries()) if (call.id) {
        pending.set(call.id, pending.has(call.id) ? null : { key: `${index}:${callIndex}`, name: call.name });
      }
    } else if (row.role === "tool" && row.toolCallId) {
      const call = pending.get(row.toolCallId);
      pending.delete(row.toolCallId);
      if (call && callIdCounts.get(row.toolCallId) === 1 && receiptIdCounts.get(row.toolCallId) === 1 && call.name === row.toolName) exactPairs.set(call.key, index);
    }
  }
  const findPairedToolIndex = (fromIndex: number, callIndex: number, toolName: string, callId: string | null): number | null => {
    const exact = exactPairs.get(`${fromIndex}:${callIndex}`);
    if (exact !== undefined) return exact;
    if (callId) return null;
    for (let index = fromIndex + 1; index < messages.length; index += 1) {
      const candidate = messages[index];
      if (candidate && candidate.role === "tool" && !candidate.toolCallId && !consumedToolIndices.has(index) && candidate.toolName === toolName) return index;
    }
    for (let index = fromIndex + 1; index < messages.length; index += 1) {
      const candidate = messages[index];
      if (candidate && candidate.role === "tool" && !candidate.toolCallId && !consumedToolIndices.has(index)) return index;
    }
    return null;
  };

  for (let index = 0; index < messages.length; index += 1) {
    const row = messages[index];
    if (!row) continue;
    if (row.role === "assistant") {
      if (row.content.length > 0) rows.push({ key: `${runId}:source:${index}:assistant`, role: "assistant", content: row.content, createdAt: row.createdAt });
      for (const [callIndex, call] of (row.toolCalls ?? []).entries()) {
        const pairedIndex = findPairedToolIndex(index, callIndex, call.name, call.id);
        const paired = pairedIndex === null ? undefined : messages[pairedIndex];
        const resultText = paired ? projectTaskTranscriptToolResult(paired.content) : undefined;
        if (pairedIndex !== null) consumedToolIndices.add(pairedIndex);
        const toolName = boundedToolName(call.name);
        rows.push({
          key: `${runId}:source:${index}:call:${callIndex}:${call.id ?? "none"}`,
          role: "tool",
          content: toolName,
          toolName,
          args: projectTaskTranscriptToolArgs(call.args),
          ...(resultText === undefined ? {} : { resultText }),
          ...(paired?.toolCallId ? { toolCallId: paired.toolCallId, ...(paired.toolStatus ? { toolStatus: paired.toolStatus } : {}) } : {}),
          createdAt: row.createdAt,
        });
      }
      continue;
    }
    if (row.role === "tool") {
      if (consumedToolIndices.has(index)) continue;
      const resultText = projectTaskTranscriptToolResult(row.content);
      rows.push({
        key: `${runId}:source:${index}:orphan-tool`,
        role: "tool",
        content: row.content,
        toolName: boundedToolName(row.toolName ?? "tool"),
        args: {},
        ...(resultText === undefined ? {} : { resultText }),
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        ...(row.toolStatus && (!row.toolCallId || receiptIdCounts.get(row.toolCallId) === 1) ? { toolStatus: row.toolStatus } : {}),
        createdAt: row.createdAt,
      });
      continue;
    }
    // Desktop retains its historic loose adapter behavior; the Mobile
    // renderer has a strict assistant/tool gate before display.
    rows.push({ key: `${runId}:source:${index}:${row.role}`, role: row.role, content: row.content, createdAt: row.createdAt });
  }
  return rows;
}

/** Latest API run only; the API exposes no historical-completeness signal. */
export function taskDetailTranscriptToPresentation(detail: TaskDetail): TaskTranscriptMessageVM[] {
  const latest = detail.runs.at(-1);
  return latest ? taskRunTranscriptToPresentation(latest.transcript ?? [], latest.id) : [];
}
