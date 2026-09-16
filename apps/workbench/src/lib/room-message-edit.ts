import type { NautiloApiClient } from "@nautilo/api-client/browser";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";

export type RoomMessageEdit = (
  roomId: string,
  messageId: string,
  body: Readonly<{ content: string; expectedRevision: number }>,
) => Promise<Readonly<{ content: string; editRevision: number }>>;

/** Product-facing edit operation. Representation choice and policy races stay
 * inside the shared data-operation owner; transports receive only the intent. */
export async function editRoomMessageWithPolicy(input: Readonly<{
  api: Pick<NautiloApiClient, "editRoomMessage">;
  owner: EncryptionDataOperationOwner;
  protectedEdit: RoomMessageEdit | undefined;
  roomId: string;
  messageId: string;
  body: Parameters<RoomMessageEdit>[2];
}>): ReturnType<RoomMessageEdit> {
  const ordinary = async () => {
    const result = await input.api.editRoomMessage(
      input.roomId, input.messageId, input.body,
    );
    return { content: result.message.content, editRevision: result.message.editRevision };
  };
  const protectedOperation = input.protectedEdit === undefined ? undefined : () =>
    input.protectedEdit!(input.roomId, input.messageId, input.body);
  return input.owner.runMutation({
    ordinary,
    dual: protectedOperation,
    protected: protectedOperation,
  });
}
