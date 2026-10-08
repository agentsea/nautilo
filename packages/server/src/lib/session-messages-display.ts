/**
 * Server-side display shaping for persisted session history (Option B).
 * Aligns REST `/api/sessions/latest` tool rows with the WebSocket one-liner
 * style (`⚙ name [running|success|error …]`) so Workbench and Electron restore
 * the same labels without re-parsing LangChain
 * tool-call queues client-side.
 */

import { projectSemanticComputerResult } from "@nautilo/agent";

export interface SessionMessageInput {
  id: string;
  role: string;
  content: string | null;
  toolCalls: string | null;
  /** Persisted tool name on `role = 'tool'` rows; optional for legacy. */
  toolName?: string | null;
  toolCallId?: string;
  toolStatus?: "success" | "error";
  authorAgentId?: string;
  createdAt?: Date;
  /** Quote-reply FK when set. */
  replyToMessageId?: number | null;
  /** Human author (`sessions.owner_id`) for room-scoped fan-in. */
  sourceUserId?: string;
}

export type SessionMessageWithDisplay<M extends SessionMessageInput = SessionMessageInput> = M & {
  displayContent?: string;
};

/** Retained helper evidence belongs to model history, not the visible transcript. */
export function isVisibleSessionMessage(message: Readonly<{
  role: string; content?: string | null; toolName?: string | null; toolCalls?: string | null;
}>): boolean {
  if (message.role === "tool" && message.toolName === "image_assistance") return false;
  if (message.role === "assistant" && message.content === "") {
    const calls = parseAssistantToolCallsJson(message.toolCalls);
    if (calls.length > 0 && calls.every((call) => call.name === "image_assistance")) return false;
  }
  return true;
}

interface ParsedToolCall {
  authorAgentId?: string;
  id?: string;
  name?: string;
}

/** Parses LangChain-style `tool_calls` JSON from an assistant row (same shape as workbench). */
export function parseAssistantToolCallsJson(raw: string | null | undefined): ParsedToolCall[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ParsedToolCall => Boolean(item) && typeof item === "object")
      .map((item) => ({
        ...(typeof (item as { id?: unknown }).id === "string"
          ? { id: (item as { id: string }).id }
          : {}),
        ...(typeof (item as { name?: unknown }).name === "string"
          ? { name: (item as { name: string }).name }
          : {}),
      }));
  } catch {
    return [];
  }
}

/** Legacy fallback when persisted tool status is absent. */
export function inferToolEndStatusFromContent(content: string): "success" | "error" {
  const t = content.trim();
  if (!t) return "success";
  if (/^error\b/i.test(t) || /^security:/i.test(t)) return "error";
  try {
    const j = JSON.parse(t) as { error?: unknown };
    if (j && typeof j === "object" && j.error != null) return "error";
  } catch {
    /* not JSON */
  }
  return "success";
}

/**
 * Uses persisted call identity for optional assistant-name lookup and sets
 * `displayContent` on tool rows
 * to a WS-style one-liner. Raw `content` is unchanged (FTS / ToolCard body).
 */
export function enrichSessionMessagesForDisplay<M extends SessionMessageInput>(
  messages: readonly M[],
): SessionMessageWithDisplay<M>[] {
  const pending: ParsedToolCall[] = [];

  return messages.map((m) => {
    const out = { ...m } as SessionMessageWithDisplay<M>;

    // Tool results cannot belong to an earlier Human turn. A cancelled or
    // interrupted turn may persist its assistant tool call without a matching
    // tool row; retaining that orphan across the next user message would
    // shift every later result onto the wrong invocation after cold boot.
    if (m.role === "user") {
      pending.length = 0;
    }

    if (m.role === "assistant") {
      pending.push(...parseAssistantToolCallsJson(m.toolCalls).map((call) => ({
        ...call, ...(m.authorAgentId === undefined ? {} : { authorAgentId: m.authorAgentId }),
      })));
    }

    if (m.role === "tool") {
      // A protected-only row has no ordinary body from which status or a
      // semantic result can truthfully be inferred.
      if (m.content === null) return out;
      const candidates = typeof m.toolCallId === "string" && m.toolCallId.length > 0
        ? pending.filter((call) => call.id === m.toolCallId
          && (m.authorAgentId === undefined || call.authorAgentId === m.authorAgentId)) : [];
      const call = candidates.length === 1
        ? candidates[0] : undefined;
      if (call !== undefined) {
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          if (pending[index]?.id === call.id && pending[index]?.authorAgentId === call.authorAgentId) {
            pending.splice(index, 1);
          }
        }
      }
      const fromDb = typeof m.toolName === "string" ? m.toolName.trim() : "";
      const name = (fromDb.length > 0 ? fromDb : call?.name?.trim()) || "tool";
      const status = m.toolStatus === "success" || m.toolStatus === "error"
        ? m.toolStatus : inferToolEndStatusFromContent(m.content);
      // The database intentionally retains Computer Use's scanned host result
      // for diagnostics. REST history must expose only the same strict compact
      // envelope as live tool events; Workbench never parses raw provider bytes.
      out.content = projectSemanticComputerResult(name, m.content);
      out.displayContent = `⚙ ${name} [${status}]`;
    }

    return out;
  });
}

/** Parses `⚙ <name> [<status>…]` from server `displayContent` (best-effort). */
export function toolDisplayNameFromDisplayContent(displayContent: string | null | undefined): string | undefined {
  if (!displayContent?.startsWith("⚙ ")) return undefined;
  const match = displayContent.match(/^⚙\s+(.+?)\s+\[(success|error)(?:\s+\d+ms)?\]/);
  const name = match?.[1]?.trim();
  return name || undefined;
}
