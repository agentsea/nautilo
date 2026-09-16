import type { DtoDeclaration } from "../src/node/dto-inventory";

const M314_ROOM_DETAIL_DTO_LOCATORS = [
  "http:produced_arbitrary:packages/types/src/api.ts#RoomDetailResponse",
  "http:request_response:GET /api/rooms/:id",
  "http:request_response:GET /api/rooms/:id/manage-detail",
  "http:request_response:PATCH /api/rooms/:id",
  "http:request_response:POST /api/rooms/:id/join",
  "http:request_response:POST /api/rooms/resolve-landing",
  "http:request_response:POST /api/rooms",
] as const;

export const SUPERSEDED_M314_ROOM_DETAIL_DTO_LOCATORS = new Set<string>(
  M314_ROOM_DETAIL_DTO_LOCATORS,
);

/**
 * M314 exposes the optional Room Namespace coordinate to eligible Room-detail
 * readers. It is bounded metadata used to address protected payloads; the
 * coordinate grants no key authority, and every cryptographic operation
 * independently revalidates current Room authority.
 */
export function reviewedM314RoomDetailDtoReplacements(
  previous: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return M314_ROOM_DETAIL_DTO_LOCATORS.map((locator) => {
    const prior = previous.find((declaration) => declaration.locator === locator);
    if (prior === undefined) {
      throw new Error(`M314 Room-detail DTO predecessor missing: ${locator}`);
    }
    const signatures = prior.structuralSignatures ?? [];
    const roomDetailSignatures = signatures.filter((signature) =>
      signature.includes(";members:{") && signature.includes(";parentRoomId")
    );
    if (roomDetailSignatures.length !== 1) {
      throw new Error(
        `M314 Room-detail DTO predecessor absent or ambiguous: ${locator}`,
      );
    }
    const previousRoomDetail = roomDetailSignatures[0]!;
    const namespaceField = locator.startsWith("http:produced_arbitrary:")
      ? "namespaceId?:null|string;"
      : "namespaceId?:string;";
    const nextRoomDetail = previousRoomDetail.replace(
      ";parentRoomId",
      `;${namespaceField}parentRoomId`,
    );
    return {
      ...prior,
      structuralSignatures: signatures.map((signature) =>
        signature === previousRoomDetail ? nextRoomDetail : signature
      ),
    };
  });
}
