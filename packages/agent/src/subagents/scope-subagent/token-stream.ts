import type { MessageTokensEvent } from "@nautilo/types";

const DEFAULT_MAX_DELAY_MS = 100;
const DEFAULT_MAX_CHARS = 50;

export type ScopeSubagentTokenSink = (event: MessageTokensEvent) => void;

export interface ScopeSubagentTokenStreamOptions {
  laneKey: string;
  authorAgentId: string;
  turnId: string;
  emit: ScopeSubagentTokenSink;
  maxDelayMs?: number;
  maxChars?: number;
}

function contentBlocksToVisibleText(blocks: unknown[]): string {
  let text = "";
  for (const block of blocks) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    const type = typeof value["type"] === "string" ? value["type"] : "";
    if (type === "reasoning" || type === "redacted_thinking" || type === "thinking") {
      continue;
    }
    if (typeof value["text"] === "string") text += value["text"];
    else if (typeof value["content"] === "string") text += value["content"];
  }
  return text;
}

/** Extract only user-visible prose from a LangGraph chat-model stream event. */
export function scopeSubagentVisibleToken(ev: unknown): string {
  if (!ev || typeof ev !== "object") return "";
  const event = ev as Record<string, unknown>;
  if (event["event"] !== "on_chat_model_stream") return "";
  const data = event["data"] as Record<string, unknown> | undefined;
  const chunk = data?.["chunk"];

  if (typeof chunk === "string") return chunk;
  if (!chunk || typeof chunk !== "object") return "";
  const chunkValue = chunk as Record<string, unknown>;

  if (typeof chunkValue["content"] === "string") return chunkValue["content"];
  if (Array.isArray(chunkValue["content"])) {
    return contentBlocksToVisibleText(chunkValue["content"]);
  }

  const delta = chunkValue["delta"];
  if (delta && typeof delta === "object") {
    const deltaValue = delta as Record<string, unknown>;
    if (typeof deltaValue["content"] === "string") return deltaValue["content"];
    if (Array.isArray(deltaValue["content"])) {
      return contentBlocksToVisibleText(deltaValue["content"]);
    }
  }

  const message = chunkValue["message"];
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (Array.isArray(content)) return contentBlocksToVisibleText(content);
  }

  return "";
}

/**
 * Room-scoped token bridge for background Task runs.
 *
 * Scope subagents intentionally detach inherited LangGraph callbacks so a
 * child run cannot fan tokens out through its caller's WebSocket lane. This
 * bridge consumes the child's own streamEvents iterator and stamps every
 * visible token with the Task's explicit Room, Agent, and run identities.
 */
export class ScopeSubagentTokenStream {
  private readonly laneKey: string;
  private readonly authorAgentId: string;
  private readonly turnId: string;
  private readonly emit: ScopeSubagentTokenSink;
  private readonly maxDelayMs: number;
  private readonly maxChars: number;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private messageIndex = 0;
  private chunkSequence = 1;
  private messageHasContent = false;

  constructor(options: ScopeSubagentTokenStreamOptions) {
    this.laneKey = options.laneKey;
    this.authorAgentId = options.authorAgentId;
    this.turnId = options.turnId;
    this.emit = options.emit;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  noteStreamEvent(ev: unknown): void {
    const token = scopeSubagentVisibleToken(ev);
    if (!token) return;
    this.messageHasContent = true;
    this.buffer += token;
    if (this.buffer.length >= this.maxChars) {
      this.flush(false);
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(false), this.maxDelayMs);
    }
  }

  /** Complete one visible assistant message and return its reconciliation key. */
  completeMessage(): string | undefined {
    if (!this.messageHasContent) return undefined;
    const assistantMessageKey = this.currentMessageKey();
    this.flush(true);
    this.messageIndex += 1;
    this.chunkSequence = 1;
    this.messageHasContent = false;
    return assistantMessageKey;
  }

  /** Stop a pending timer without publishing incomplete buffered prose. */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = "";
  }

  private flush(done: boolean): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer && !done) return;
    this.emit({
      type: "message.tokens",
      laneKey: this.laneKey,
      content: this.buffer,
      chunkSequence: this.chunkSequence,
      done,
      authorAgentId: this.authorAgentId,
      turnId: this.turnId,
      assistantMessageKey: this.currentMessageKey(),
    });
    this.chunkSequence += 1;
    this.buffer = "";
  }

  private currentMessageKey(): string {
    return `assistant:${this.turnId}:${this.messageIndex}`;
  }
}
