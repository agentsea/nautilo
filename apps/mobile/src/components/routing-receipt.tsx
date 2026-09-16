import type { RoutingReceiptOutcome } from "@/features/room-chat-pane/routing-receipt-presentation";

export type RoutingReceiptData = {
  outcome: RoutingReceiptOutcome;
  /** Server-authored, privacy-safe explanation. */
  displayReason: string;
  /** Server-provided, safe agent handles; present for wake decisions only. */
  selectedHandles?: string[];
};
