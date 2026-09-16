import { isUuidString } from "@nautilo/trust";

export function extractRequestedRoomIdFromUrl(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl, "http://x");
    const rid = u.searchParams.get("roomId");
    if (rid && isUuidString(rid)) return rid;
  } catch {
    /* malformed URL */
  }
  return undefined;
}

/** Routes whose bearer envelope is deliberately narrowed by `?roomId=`. */
export function acceptsRequestedRoomIdFromUrl(
  method: string,
  routePath: string,
  rawUrl: string,
): boolean {
  return rawUrl.startsWith("/api/workspace/artifacts")
    || (method === "GET" && routePath === "/api/content-access")
    || (method === "POST" && (routePath === "/api/content-access/prepare"
      || routePath === "/api/content-access/commit"))
    || rawUrl.startsWith("/api/media-generations")
    || rawUrl.startsWith("/api/video-generations")
    || rawUrl.startsWith("/api/message-attachments")
    || (routePath === "/api/connected-apps/result-media"
      && rawUrl.startsWith("/api/connected-apps/result-media?"))
    || rawUrl.startsWith("/api/office/")
    || (method === "POST" && routePath === "/api/apps/:appId/conversions/run");
}

/**
 * M065 — same extraction as `app.ts` trust preHandler for room-scoped POSTs
 * so unit tests pin body → `requestedRoomId` without booting Fastify.
 */
export function extractChatRequestedRoomId(body: unknown): string | undefined {
  const raw = body;
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const rid = obj?.["roomId"];
  if (typeof rid === "string" && isUuidString(rid)) return rid;
  return undefined;
}
