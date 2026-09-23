import type { NautiloApiClient } from "@nautilo/api-client/browser";
import type { ServerEvent } from "@nautilo/types";
import { ClassifiedDataOperationError, type EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import {
  LATEST_SENTINEL_BEFORE_AT,
  LATEST_SENTINEL_BEFORE_ID,
  reconcileFetchedRoomHistoryPage,
  compareRoomHistoryCursors,
  isRoomHistoryCursor,
  type RoomHistoryShadowReadAdapter,
  type StoredSessionMessageDto,
} from "./session-rehydrate";

/** Product operations bound by the authenticated runtime. Drawers and
 * composers never choose a transport or an encryption representation. */
export interface RoomMessageOperations {
  readRoomMessages(roomId: string): Promise<Readonly<{
    messages: readonly (StoredSessionMessageDto & { createdAt: string })[];
    pageInfo: Awaited<ReturnType<NautiloApiClient["getOlderRoomMessages"]>>["pageInfo"];
  }>>;
  readOlderRoomMessages(options: Omit<Parameters<NautiloApiClient["getOlderRoomMessages"]>[0], "shadowRead">): Promise<Awaited<ReturnType<NautiloApiClient["getOlderRoomMessages"]>>>;
  readReconnectWindow(roomId: string, targetOldestCursor: Readonly<{ id: string; createdAt: string }> | null): Promise<Readonly<{
    messages: readonly (StoredSessionMessageDto & { createdAt: string })[];
    pageInfo: Awaited<ReturnType<NautiloApiClient["getOlderRoomMessages"]>>["pageInfo"];
  }>>;
  readRoomMessagesAround(options: Omit<Parameters<NautiloApiClient["getRoomMessagesAround"]>[0], "shadowRead">): ReturnType<NautiloApiClient["getRoomMessagesAround"]>;
  sendRoomMessage: NautiloApiClient["sendRoomMessage"];
  consumeRealtime(event: ServerEvent, verified: boolean): Promise<ServerEvent>;
}

export const unavailableRoomMessageOperations: RoomMessageOperations = {
  readRoomMessages: () => Promise.reject(new Error("Room data access is unavailable.")),
  readOlderRoomMessages: () => Promise.reject(new Error("Room data access is unavailable.")),
  readReconnectWindow: () => Promise.reject(new Error("Room data access is unavailable.")),
  readRoomMessagesAround: () => Promise.reject(new Error("Room data access is unavailable.")),
  sendRoomMessage: () => Promise.reject(new Error("Room data access is unavailable.")),
  consumeRealtime: () => Promise.reject(new Error("Room data access is unavailable.")),
};

/** These frames carry confidential Message bodies or tool arguments/results.
 * Lifecycle, typing and structural Room events do not require body access. */
export function isConfidentialRoomEvent(event: ServerEvent): boolean {
  return event.type === "message.new" || event.type === "message.tokens"
    || event.type === "message.updated" || event.type === "tool.start"
    || event.type === "tool.end";
}

/** Trusted runtime composition shared by the main composer and child Rooms.
 * Existing transports retain atomic publication and device custody. */
export function createRoomMessageOperations(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  api: Pick<NautiloApiClient, "getOlderRoomMessages">;
  around?: Pick<NautiloApiClient, "getRoomMessagesAround">;
  ordinarySend: NautiloApiClient["sendRoomMessage"];
  protectedSend?: NautiloApiClient["sendRoomMessage"];
  historyReader?: RoomHistoryShadowReadAdapter;
}>): RoomMessageOperations {
  const readPage = async (
    coordinates: Omit<Parameters<NautiloApiClient["getOlderRoomMessages"]>[0], "shadowRead">,
  ): Promise<Awaited<ReturnType<NautiloApiClient["getOlderRoomMessages"]>>> => {
    type ApiPage = Awaited<ReturnType<NautiloApiClient["getOlderRoomMessages"]>>;
    const { shadowRead: _ignoredShadowRead, ...safeCoordinates } = coordinates as Parameters<NautiloApiClient["getOlderRoomMessages"]>[0];
    const loaded = await input.owner.read<ApiPage, ApiPage, ApiPage>({
      ordinary: () => input.api.getOlderRoomMessages(safeCoordinates),
      protected: async () => {
        const reader = input.historyReader;
        if (reader === undefined) throw new ClassifiedDataOperationError(
          "key_waiting", "Room history is waiting for device encryption access.",
        );
        const page = await input.api.getOlderRoomMessages({
          ...safeCoordinates, shadowRead: reader.createIntent(),
        });
        const reconciled = await reconcileFetchedRoomHistoryPage(
          safeCoordinates.roomId, page.messages, page.shadowEncryption, reader,
          { protectedAttempt: true },
        );
        return {
          ...page,
          messages: reconciled.map((row) => {
            if (typeof row.createdAt !== "string") throw new ClassifiedDataOperationError(
              "integrity", "Room history timestamp is unavailable.",
            );
            return { ...row, createdAt: row.createdAt };
          }),
        };
      },
      consumeOrdinary: (page) => page,
      consumeProtected: (page) => page,
    });
    return loaded.value;
  };
  return Object.freeze({
    async consumeRealtime(event: ServerEvent, verified: boolean) {
      const opened = await input.owner.read({
        ordinary: () => Promise.resolve(event),
        protected: () => {
          if (!verified) throw new ClassifiedDataOperationError(
            "key_waiting", "Room event is waiting for authenticated content.",
          );
          return Promise.resolve(event);
        },
        consumeOrdinary: (value) => value,
        consumeProtected: (value) => value.type === "message.new" && "attachments" in value && value.attachments !== undefined
          ? { ...value, attachments: [] }
          : value,
      });
      return opened.value;
    },
    async readRoomMessages(roomId: string) {
      const coordinates = {
        roomId,
        beforeId: String(LATEST_SENTINEL_BEFORE_ID),
        beforeCreatedAt: LATEST_SENTINEL_BEFORE_AT,
      };
      const loaded = await readPage(coordinates);
      return { messages: loaded.messages.map((row) => {
        if (typeof row.createdAt !== "string") throw new Error("Room history timestamp is unavailable.");
        return { ...row, createdAt: row.createdAt };
      }), pageInfo: loaded.pageInfo };
    },
    readOlderRoomMessages: readPage,
    async readReconnectWindow(
      roomId: string,
      targetOldestCursor: Readonly<{ id: string; createdAt: string }> | null,
    ) {
      const pages = [];
      const seenCursors = new Set<string>();
      const seenMessageIds = new Set<string>();
      let page = await readPage({ roomId, beforeId: String(LATEST_SENTINEL_BEFORE_ID), beforeCreatedAt: LATEST_SENTINEL_BEFORE_AT });
      pages.push(page.messages);
      for (const message of page.messages) seenMessageIds.add(message.id);
      while (targetOldestCursor !== null && page.pageInfo.hasMoreBefore && page.pageInfo.oldestCursor !== null) {
        const oldest = page.pageInfo.oldestCursor;
        if (!isRoomHistoryCursor(oldest) || !isRoomHistoryCursor(targetOldestCursor)) {
          throw new ClassifiedDataOperationError("integrity", "Room history cursor is invalid.");
        }
        const comparison = compareRoomHistoryCursors(oldest, targetOldestCursor);
        if (comparison === null) throw new ClassifiedDataOperationError("integrity", "Room history cursor is invalid.");
        if (comparison <= 0) break;
        const cursorKey = `${oldest.createdAt}\u0000${oldest.id}`;
        if (seenCursors.has(cursorKey)) throw new ClassifiedDataOperationError("integrity", "Room history cursor did not advance.");
        seenCursors.add(cursorKey);
        const next = await readPage({ roomId, beforeId: oldest.id, beforeCreatedAt: oldest.createdAt });
        const nextOldest = next.pageInfo.oldestCursor;
        if (nextOldest === null) {
          if (next.pageInfo.hasMoreBefore || next.messages.length > 0) throw new ClassifiedDataOperationError("integrity", "Room history page cursor is inconsistent.");
        } else {
          const progress = compareRoomHistoryCursors(nextOldest, oldest);
          if (progress === null || progress >= 0) throw new ClassifiedDataOperationError("integrity", "Room history cursor did not advance.");
        }
        if (next.messages.some((message) => seenMessageIds.has(message.id))) throw new ClassifiedDataOperationError("integrity", "Room history page contains duplicate messages.");
        for (const message of next.messages) seenMessageIds.add(message.id);
        page = next;
        pages.push(page.messages);
      }
      return { messages: pages.reverse().flat(), pageInfo: page.pageInfo };
    },
    async readRoomMessagesAround(
      options: Omit<Parameters<NautiloApiClient["getRoomMessagesAround"]>[0], "shadowRead">,
    ): ReturnType<NautiloApiClient["getRoomMessagesAround"]> {
      type AroundPage = Awaited<ReturnType<NautiloApiClient["getRoomMessagesAround"]>>;
      const { shadowRead: _ignoredShadowRead, ...safeCoordinates } = options as Parameters<NautiloApiClient["getRoomMessagesAround"]>[0];
      const opened = await input.owner.read<AroundPage, AroundPage, AroundPage>({
        ordinary: () => {
          if (input.around === undefined) throw new ClassifiedDataOperationError("unsupported", "Around-message history is unavailable.");
          return input.around.getRoomMessagesAround(safeCoordinates);
        },
        protected: async () => {
          if (input.around === undefined || input.historyReader === undefined) throw new ClassifiedDataOperationError(
            "key_waiting", "Around-message history is waiting for device encryption access.",
          );
          const page = await input.around.getRoomMessagesAround({
            ...safeCoordinates,
            shadowRead: input.historyReader.createIntent(),
          });
          return {
            ...page,
            messages: [...await reconcileFetchedRoomHistoryPage(
              safeCoordinates.roomId,
              page.messages,
              page.shadowEncryption,
              input.historyReader,
              { protectedAttempt: true },
            )].map((row) => {
              if (typeof row.createdAt !== "string") throw new ClassifiedDataOperationError(
                "integrity", "Around-message history timestamp is unavailable.",
              );
              return { ...row, createdAt: row.createdAt };
            }),
          };
        },
        consumeOrdinary: (page) => page,
        consumeProtected: (page) => page,
      });
      return opened.value;
    },
    sendRoomMessage(roomId: string, body: Parameters<NautiloApiClient["sendRoomMessage"]>[1]) {
      const protectedSend = () => {
        if (input.protectedSend === undefined) throw new ClassifiedDataOperationError(
          "key_waiting", "Room sending is waiting for device encryption access.",
        );
        return input.protectedSend(roomId, body);
      };
      return input.owner.runMutation({
        ordinary: () => input.ordinarySend(roomId, body),
        dual: protectedSend,
        protected: protectedSend,
      });
    },
  });
}
