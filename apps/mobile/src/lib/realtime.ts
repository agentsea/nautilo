// D369 Phase 3 — WS spine wiring helpers (pure, no React).
// Turns a server base URL into the WS endpoint and builds a realtime
// client bound to that server with `getToken` pulling a fresh token
// per connect attempt via `ensureValidToken`. The reconnect/heartbeat/
// auth-first-frame machinery all live in `@nautilo/realtime-client` —
// this module only WIRES it. React glue lives in providers/realtime.tsx.
import {
  createWsRealtimeClient,
  type RealtimeClient,
  type RealtimeControlEventHandler,
  type RealtimeErrorHandler,
  type RealtimeEventHandler,
  type RealtimeStateHandler,
} from "@nautilo/realtime-client";

import { ensureValidToken } from "@/lib/auth";
import { platformCapabilities } from "@/platform/capabilities";
import { initiatingClientSurfaceForMobile } from "@/platform/capability-contract";

// `AuthRejectedReason` isn't re-exported from the package entry, so we
// mirror the literal union here. If the package ever widens it, this
// will need updating — kept narrow on purpose so callers can't drift.
export type AuthRejectedReason =
  | "no_token"
  | "auth_required"
  | "auth_timeout"
  | "invalid_token"
  | "device_admission_required"
  | "device_admission_expired"
  | "device_removed_or_stale"
  | "device_admission_unavailable"
  | "unknown";

/**
 * Convert a server base URL (`https://host` / `http://host`) into the WS
 * endpoint (`wss://host/ws` / `ws://host/ws`). Trailing slashes stripped.
 * The `/ws` path matches the server's WS upgrade route (M058).
 */
function wsUrlFromBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/^https:\/\//i.test(trimmed)) {
    return `wss://${trimmed.slice("https://".length)}/ws`;
  }
  if (/^http:\/\//i.test(trimmed)) {
    return `ws://${trimmed.slice("http://".length)}/ws`;
  }
  // Callers normally pass a normalized https/http URL (see lib/api.ts);
  // fall back to wss for anything else so we fail closed rather than
  // silently shipping cleartext over a public host.
  return `wss://${trimmed}/ws`;
}

export interface CreateServerRealtimeOptions {
  baseUrl: string;
  serverId: string;
  onEvent: RealtimeEventHandler;
  onControlEvent?: RealtimeControlEventHandler;
  onStateChange?: RealtimeStateHandler;
  onError?: RealtimeErrorHandler;
  onAuthRejected?: (reason: AuthRejectedReason) => void;
}

/**
 * Build a WS realtime client bound to a single server. `getToken` calls
 * `ensureValidToken(serverId, baseUrl)` on EVERY connect attempt, so
 * reconnects pick up refreshed tokens transparently and the first-frame
 * `{type:"auth",token}` is sent by the client itself — do NOT hand-roll
 * the auth frame here.
 */
export function createServerRealtime({
  baseUrl,
  serverId,
  onEvent,
  onControlEvent,
  onStateChange,
  onError,
  onAuthRejected,
}: CreateServerRealtimeOptions): RealtimeClient {
  const wsUrl = wsUrlFromBase(baseUrl);
  return createWsRealtimeClient(wsUrl, {
    onEvent,
    onControlEvent,
    onError,
    onStateChange,
    onAuthRejected,
    initiatingClientSurface: initiatingClientSurfaceForMobile(platformCapabilities),
    getToken: () => ensureValidToken(serverId, baseUrl),
  });
}
