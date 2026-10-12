import type { BolterConnectionSummary, BolterStatusReason, BolterDeliveryState } from "@nautilo/types";
import type { ConnectedAppCatalogueSummary } from "./connected-app-presentation";

export function bolterReason(reason?: BolterStatusReason): string {
  switch (reason) {
    case "desktop_required": return "Connect a signed-in Nautilo Desktop to receive messages.";
    case "desktop_offline": return "The receiving Desktop is offline. Keep it running to receive messages.";
    case "desktop_selection_required": return "Choose the receiving Desktop before connecting.";
    case "qualification_required": return "This Bolter version is not qualified for messaging yet.";
    case "runtime_unavailable": return "Bolter is not available on the receiving Desktop.";
    case "mode_unsupported": return "Bolter currently supports plaintext mode only. Protected content cannot be sent.";
    case "authentication_required": return "Sign in to Bolter to connect your identity.";
    case "identity_unconfirmed": return "Your Bolter identity has not been confirmed yet.";
    case "identity_selection_required": return "Choose a Bolter identity before connecting.";
    case "receiver_unavailable": return "The receiver needs attention. Messages already queued are retained.";
    case "authority_changed": case "conflict": return "The connection changed. Reload before continuing.";
    case "delivery_uncertain": return "Delivery is uncertain. Do not resend without checking the destination.";
    case "unsupported_content": return "Only text can be sent through this connection.";
    case "operation_cancelled": return "Connection cancelled.";
    case "not_found": return "This connection is no longer available.";
    case "invalid_request": return "The request could not be accepted. Reload and try again.";
    default: return "Bolter is unavailable. Reload to check the current connection.";
  }
}

export function bolterConnectionLabel(connection: BolterConnectionSummary): string {
  switch (connection.status) {
    case "connected": return connection.reason === "receiver_unavailable" ? "Delivery needs attention" : connection.receiver === "listening" ? "Listening"
      : connection.receiver === "starting" ? "Starting receiver"
      : connection.receiver === "running" ? "Receiver running" : "Connected";
    case "needs_auth": return "Sign-in required";
    case "auth_pending": return "Waiting for sign-in";
    case "qualification_required": return "Not available yet";
    case "offline": return "Desktop offline";
    case "paused": return "Paused";
    case "revoked": return "Disconnected";
  }
}

export function bolterCatalogueSummary(connections: readonly BolterConnectionSummary[]): ConnectedAppCatalogueSummary {
  const connection = connections.find(item => item.status === "connected") ?? connections.find(item => item.status !== "revoked");
  if (!connection) return { state: "available", statusLabel: "Not connected", tone: "muted" };
  const healthy = connection.status === "connected" && !connection.reason;
  return { state: healthy ? "connected" : "attention",
    statusLabel: bolterConnectionLabel(connection), tone: healthy ? "ok" : "warn" };
}

export function bolterDeliveryLabel(state: BolterDeliveryState): string {
  switch (state) {
    case "pending": return "Queued for Bolter";
    case "publishing": return "Sending to Bolter";
    case "published": return "Sent to Bolter";
    case "uncertain": return "Delivery uncertain — do not resend";
    case "cancelled": return "Delivery cancelled";
  }
}
