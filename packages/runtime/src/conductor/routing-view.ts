/** D302 R12 — bounded routing view for the Floor Manager prompt. */
export interface RoutingAttachmentDescriptor {
  id: string;
  filename: string;
  decision: string;
  kind?: string;
  reason?: string;
}

export interface RoutingView {
  /** Bounded head+tail view of the message body, used only for routing. */
  content: string;
  /** Optional metadata-only attachment descriptors. No blobs / extracted text. */
  attachments?: RoutingAttachmentDescriptor[];
  /** True when `content` is a truncated view of the original message. */
  truncated: boolean;
  originalLength: number;
}

export interface BuildRoutingViewOptions {
  perMessageHeadChars?: number;
  perMessageTailChars?: number;
  packetBudgetChars?: number;
  attachments?: RoutingAttachmentDescriptor[];
}

export const DEFAULT_ROUTING_VIEW_HEAD_CHARS = 1_500;
export const DEFAULT_ROUTING_VIEW_TAIL_CHARS = 500;
export const DEFAULT_ROUTING_VIEW_PACKET_BUDGET_CHARS = 8_000;

function truncateHeadTail(text: string, headChars: number, tailChars: number): { content: string; truncated: boolean } {
  if (text.length <= headChars + tailChars) return { content: text, truncated: false };
  const omitted = text.length - headChars - tailChars;
  return {
    content: `${text.slice(0, headChars)}\n…[truncated ${omitted} chars]…\n${text.slice(text.length - tailChars)}`,
    truncated: true,
  };
}

/**
 * Build a compact view for routing only. The answering bot still receives the
 * full original message + attachments in the job input.
 */
export function buildRoutingView(content: string, opts: BuildRoutingViewOptions = {}): RoutingView {
  const head = opts.perMessageHeadChars ?? DEFAULT_ROUTING_VIEW_HEAD_CHARS;
  const tail = opts.perMessageTailChars ?? DEFAULT_ROUTING_VIEW_TAIL_CHARS;
  const budget = opts.packetBudgetChars ?? DEFAULT_ROUTING_VIEW_PACKET_BUDGET_CHARS;
  const normalized = content.replace(/\s+/g, " ").trim();
  const initial = truncateHeadTail(normalized, head, tail);
  const bounded = initial.content.length <= budget
    ? initial
    : truncateHeadTail(initial.content, Math.max(0, budget - tail - 80), tail);
  return {
    content: bounded.content,
    ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
    truncated: initial.truncated || bounded.truncated,
    originalLength: normalized.length,
  };
}
