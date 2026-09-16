import { projectToolResultForEvent } from "@nautilo/types";
import type { MessageTokensEvent, ToolStartEvent, ToolEndEvent, TokenUsage } from "@nautilo/types";

export interface TokenBatcherConfig {
  maxDelayMs?: number;
  maxChars?: number;
  laneKey: string;
  /** D300 — assistant author stamped on every `message.tokens` chunk. */
  authorAgentId?: string;
  /** M178 — turn id stamped on every `message.tokens` chunk when present. */
  turnId?: string;
}

/**
 * Batches LLM tokens into larger chunks for efficient WebSocket delivery.
 * Returns events instead of publishing — the caller (executor) yields them.
 */
export class TokenBatcher {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private messageIndex = 0;
  private messageHasContent = false;
  private chunkSequence = 1;
  private pendingEvents: MessageTokensEvent[] = [];
  private readonly config: Required<Pick<TokenBatcherConfig, "maxDelayMs" | "maxChars">> & {
    laneKey: string;
    authorAgentId?: string;
    turnId?: string;
  };
  private lastUsage: TokenUsage | undefined;

  constructor(config: TokenBatcherConfig) {
    this.config = {
      maxDelayMs: 100,
      maxChars: 50,
      laneKey: config.laneKey,
    };
    if (config.maxDelayMs !== undefined) this.config.maxDelayMs = config.maxDelayMs;
    if (config.maxChars !== undefined) this.config.maxChars = config.maxChars;
    if (config.authorAgentId !== undefined) this.config.authorAgentId = config.authorAgentId;
    if (config.turnId !== undefined) this.config.turnId = config.turnId;
  }

  setUsage(usage: TokenUsage): void {
    this.lastUsage = usage;
  }

  addToken(content: string): void {
    if (content.length > 0) this.messageHasContent = true;
    this.buffer += content;

    if (this.buffer.length >= this.config.maxChars) {
      this.flush(false);
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush(false);
      }, this.config.maxDelayMs);
    }
  }

  flush(done: boolean): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length > 0 || (done && this.messageHasContent)) {
      const event: MessageTokensEvent = {
        type: "message.tokens",
        laneKey: this.config.laneKey,
        content: this.buffer,
        chunkSequence: this.chunkSequence,
        done,
      };
      if (this.config.authorAgentId) {
        event.authorAgentId = this.config.authorAgentId;
      }
      if (this.config.turnId) {
        event.turnId = this.config.turnId;
        event.assistantMessageKey = this.currentMessageKey();
      }
      if (done && this.lastUsage) {
        event.tokenUsage = this.lastUsage;
      }
      this.pendingEvents.push(event);
      this.chunkSequence += 1;
      this.buffer = "";
    }

    if (done && this.messageHasContent) {
      this.messageIndex++;
      this.chunkSequence = 1;
      this.messageHasContent = false;
    }
  }

  completeMessage(): string | undefined {
    const completedKey = this.messageHasContent && this.config.turnId
      ? this.currentMessageKey()
      : undefined;
    this.flush(true);
    return completedKey;
  }

  drain(): MessageTokensEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = "";
    this.messageIndex = 0;
    this.messageHasContent = false;
    this.chunkSequence = 1;
    this.pendingEvents = [];
  }

  getMessageIndex(): number {
    return this.messageIndex;
  }

  private currentMessageKey(): string {
    return `assistant:${this.config.turnId}:${this.messageIndex}`;
  }
}

/**
 * Tracks active tool calls and produces start/end events.
 */
export class ToolCallTracker {
  private activeCalls = new Map<string, { toolName: string; startTime: number }>();

  constructor(
    private readonly authorAgentId?: string | undefined,
    private readonly turnId?: string | undefined,
  ) {}

  toolStart(toolCallId: string, toolName: string, args?: unknown): ToolStartEvent {
    this.activeCalls.set(toolCallId, {
      toolName,
      startTime: Date.now(),
    });

    return {
      type: "tool.start",
      ...(this.authorAgentId ? { authorAgentId: this.authorAgentId } : {}),
      ...(this.turnId ? { turnId: this.turnId } : {}),
      toolCallId,
      toolName,
      argsSummary: args ? summarizeToolArgs(args) : undefined,
    };
  }

  /**
   * D083 Phase 2 — `result` (optional) carries the actual tool
   * output over the WS so the inline ToolCard can render real
   * stdout / diff / preview / matches instead of the legacy
   * "Done (Xms)" placeholder. Capped at `TOOL_RESULT_MAX_BYTES`
   * to protect WS throughput on busy turns; a trailing
   * "\n…[N bytes truncated]" marker makes the truncation visible
   * in raw consumers too (e.g. MCP tail).
   */
  toolEnd(
    toolCallId: string,
    toolName: string,
    status: "success" | "error",
    error?: string,
    result?: string,
  ): ToolEndEvent {
    const call = this.activeCalls.get(toolCallId);
    const duration = call ? Date.now() - call.startTime : 0;
    this.activeCalls.delete(toolCallId);

    const event: ToolEndEvent = {
      type: "tool.end",
      ...(this.authorAgentId ? { authorAgentId: this.authorAgentId } : {}),
      ...(this.turnId ? { turnId: this.turnId } : {}),
      toolCallId,
      toolName,
      duration,
      status,
    };
    if (error !== undefined) event.error = error;
    if (result !== undefined) {
      const capped = projectToolResultForEvent(toolName, result);
      event.result = capped.result;
      if (capped.truncated) event.resultTruncated = true;
    }
    return event;
  }

  getActiveCount(): number {
    return this.activeCalls.size;
  }

  reset(): void {
    this.activeCalls.clear();
  }
}

function summarizeToolArgs(args: unknown, maxLength = 200): string {
  if (!args) return "";
  try {
    const str = typeof args === "string" ? args : JSON.stringify(args);
    return str.length > maxLength ? str.slice(0, maxLength) + "..." : str;
  } catch {
    return "[args]";
  }
}
