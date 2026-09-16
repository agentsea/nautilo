const ROOM_PATH_PREFIX = "/rooms/";
const ROOM_MESSAGE_TARGET_PARAM = "messageId";

export interface RoomPathOptions {
  targetMessageId?: string | number;
}

export type RoomMessageRouteIntent =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "target"; messageId: number };

function boundedPositiveMessageId(value: string | number | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Absolute app path for deep-linking to a room (single encodeURIComponent segment).
 */
export function roomPath(roomId: string, options: RoomPathOptions = {}): string {
  const trimmed = roomId.trim();
  if (!trimmed) return ROOM_PATH_PREFIX;
  const pathname = `${ROOM_PATH_PREFIX}${encodeURIComponent(trimmed)}`;
  const targetMessageId = boundedPositiveMessageId(options.targetMessageId);
  return targetMessageId === undefined
    ? pathname
    : `${pathname}?${ROOM_MESSAGE_TARGET_PARAM}=${targetMessageId}`;
}

/**
 * Extract room id from pathname, or undefined when not under `/rooms/:id`.
 */
export function parseRouteRoomId(pathname: string): string | undefined {
  if (!pathname.startsWith(ROOM_PATH_PREFIX)) return undefined;
  const raw = pathname.slice(ROOM_PATH_PREFIX.length);
  if (!raw || raw.includes("/")) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/** Decode one canonical, bounded message target from a Room-route query. */
export function parseRoomMessageRouteIntent(search: string): RoomMessageRouteIntent {
  const params = new URLSearchParams(search);
  const values = params.getAll(ROOM_MESSAGE_TARGET_PARAM);
  if (values.length === 0) return { kind: "none" };
  if (values.length !== 1) return { kind: "invalid" };
  const messageId = boundedPositiveMessageId(values[0]);
  return messageId === undefined ? { kind: "invalid" } : { kind: "target", messageId };
}

export type RoomMessageRouteConsumeOutcome =
  | "none"
  | "deferred"
  | "already-consumed"
  | "invalid"
  | "consumed"
  | "failed";

/**
 * Consume a cross-chat message intent exactly once per router location.
 * Transcript hydration, merging, scrolling, highlighting, and errors remain
 * owned by the injected D430 navigation controller.
 */
export function createRoomMessageRouteIntentConsumer(): {
  consume: (args: {
    locationKey: string;
    pathname: string;
    search: string;
    activeRoomId: string | null;
    replaceRoute: (path: string) => void;
    jumpToMessage: (
      messageId: number,
      options: { focusTarget: false },
    ) => Promise<unknown>;
  }) => Promise<RoomMessageRouteConsumeOutcome>;
} {
  let consumedLocation = "";
  return {
    consume: async (args) => {
      const intent = parseRoomMessageRouteIntent(args.search);
      if (intent.kind === "none") return "none";
      const routeRoomId = parseRouteRoomId(args.pathname);
      if (!args.activeRoomId || routeRoomId !== args.activeRoomId) return "deferred";
      const locationIdentity = `${args.locationKey}\u0000${args.pathname}\u0000${args.search}`;
      if (consumedLocation === locationIdentity) return "already-consumed";
      consumedLocation = locationIdentity;
      args.replaceRoute(roomPath(args.activeRoomId));
      if (intent.kind === "invalid") return "invalid";
      try {
        await args.jumpToMessage(intent.messageId, { focusTarget: false });
        return "consumed";
      } catch {
        // The route is already consumed. Do not turn a revoked/deleted target
        // into an identifier-bearing route error or retry through another path.
        return "failed";
      }
    },
  };
}
