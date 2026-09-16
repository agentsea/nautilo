import type { ThreadMessageLike } from "@assistant-ui/react";
import type { RoomHistoryShadowReadResponseV1 } from "@nautilo/api-client/browser";
import type { ProtectedMessageRealtimeEventV2 } from "@nautilo/types";
import type { RoomHistoryShadowReadAdapter, StoredSessionMessageDto } from "./session-rehydrate";

export type ProtectedMessageUpdate = Extract<ProtectedMessageRealtimeEventV2, { type: "message.updated" }>;
const PROTECTED_MESSAGE_UNAVAILABLE = "Encrypted history is unavailable on this device.";

/** Reuse history authentication for an exact edit, without loading or replacing a page. */
export async function readProtectedMessageUpdate(input: {
  event: ProtectedMessageUpdate;
  reader: RoomHistoryShadowReadAdapter;
  loadSidecar: () => Promise<RoomHistoryShadowReadResponseV1>;
}): Promise<StoredSessionMessageDto> {
  const projection = input.event.message.projection;
  if (projection.role !== "user") throw new Error("Protected edit is not a Human message");
  const structural: StoredSessionMessageDto = {
    id: projection.messageId,
    logicalMessageKey: input.event.logicalMessageKey,
    role: projection.role,
    content: PROTECTED_MESSAGE_UNAVAILABLE,
    createdAt: projection.createdAt,
    editedAt: projection.editedAt,
    editRevision: projection.editRevision,
    ...(projection.sourceUserId === undefined ? {} : { sourceUserId: projection.sourceUserId }),
  };
  const sidecar = await input.loadSidecar();
  if (sidecar.status !== "ready") throw new Error("Protected edit history is unavailable");
  const result = await input.reader.reconcile({
    roomId: projection.roomId,
    messages: [structural],
    sidecar,
    requireVerified: true,
  });
  const updated = result[0];
  if (result.length !== 1 || updated?.id !== structural.id
    || updated.editRevision !== structural.editRevision
    || updated.logicalMessageKey !== structural.logicalMessageKey
    || updated.content === PROTECTED_MESSAGE_UNAVAILABLE) {
    throw new Error("Protected edit history coordinates changed");
  }
  return updated;
}

/** Only replace the matching older revision; preserve streams, pagination and local metadata. */
export function mergeProtectedMessageUpdate(
  messages: readonly ThreadMessageLike[],
  updated: StoredSessionMessageDto,
): readonly ThreadMessageLike[] {
  let changed = false;
  const next = messages.map((message) => {
    const custom = message.metadata?.custom ?? {};
    if (custom.logicalMessageKey !== updated.logicalMessageKey
      || updated.logicalMessageKey === undefined
      || (typeof custom.editRevision === "number" ? custom.editRevision : 0) >= (updated.editRevision ?? 0)) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: [{ type: "text" as const, text: updated.content }],
      metadata: {
        ...message.metadata,
        custom: { ...custom, editRevision: updated.editRevision, editedAt: updated.editedAt },
      },
    };
  });
  return changed ? next : messages;
}
