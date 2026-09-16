export type RoutingReceiptOutcome = "wake" | "silent" | "ask_user" | "error";
export type ActionableRoutingReceiptOutcome = "ask_user";

/** Only a recoverable choice may interrupt an ordinary mobile conversation. */
export function isActionableRoutingReceipt(
  outcome: RoutingReceiptOutcome,
): outcome is ActionableRoutingReceiptOutcome {
  return outcome === "ask_user";
}
