import type { DtoDeclaration } from "../src/node/dto-inventory";

export const SUPERSEDED_ROOM_EVERYONE_MENTION_DTO_LOCATORS = new Set<string>([
  "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
  "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest",
  "http:request_response:POST /api/chat",
  "http:request_response:POST /api/rooms/:roomId/messages",
]);

function addRoomEveryoneMention(
  declaration: DtoDeclaration,
): DtoDeclaration {
  let matches = 0;
  const structuralSignatures = (declaration.structuralSignatures ?? []).map(
    (signature) => {
      const from = ";mentionedHumanUserIds?";
      if (!signature.includes(from)) return signature;
      matches += 1;
      const mentionType = declaration.locator
          === "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest"
        ? "boolean|undefined"
        : "boolean";
      return signature.replace(
        from,
        `;mentionEveryone?:${mentionType};mentionedHumanUserIds?`,
      );
    },
  );
  if (matches !== 1) {
    throw new Error(
      `Room-wide mention DTO predecessor mismatch for ${declaration.locator}: expected 1 match, found ${matches}`,
    );
  }
  return { ...declaration, structuralSignatures };
}

/**
 * Review the optional structured Room-wide Human audience bit without changing
 * any inherited arbitrary-payload declaration or historical debt decision.
 */
export function reviewedRoomEveryoneMentionDtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return [...SUPERSEDED_ROOM_EVERYONE_MENTION_DTO_LOCATORS].map((locator) => {
    const declaration = declarations.find((candidate) =>
      candidate.locator === locator
    );
    if (declaration === undefined) {
      throw new Error(`Room-wide mention DTO predecessor missing: ${locator}`);
    }
    return addRoomEveryoneMention(declaration);
  });
}
