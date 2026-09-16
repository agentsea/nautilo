import type { DtoDeclaration } from "../src/node/dto-inventory";

const SUPERSEDED = [
  "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody",
  "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest",
  "http:request_response:GET /api/rooms/:id/messages/:messageId/around",
  "http:request_response:GET /api/rooms/:id/messages",
  "http:request_response:GET /api/rooms/:id/thread-detail",
  "http:request_response:GET /api/sessions/latest",
  "http:request_response:POST /api/chat",
  "http:request_response:POST /api/rooms/:roomId/messages",
] as const;

export const SUPERSEDED_MAIN_2026_08_17_DTO_LOCATORS =
  new Set<string>(SUPERSEDED);

function replaceRequired(
  declaration: DtoDeclaration,
  before: string,
  after: string,
): DtoDeclaration {
  let replacements = 0;
  const structuralSignatures = (declaration.structuralSignatures ?? []).map(
    (signature) => {
      if (!signature.includes(before)) return signature;
      replacements += 1;
      return signature.replaceAll(before, after);
    },
  );
  if (replacements === 0) {
    throw new Error(
      `2026-08-17 DTO replacement did not match ${declaration.locator}`,
    );
  }
  return { ...declaration, structuralSignatures };
}

function withArbitraryPayload(
  declaration: DtoDeclaration,
  path: string,
): DtoDeclaration {
  return {
    ...declaration,
    arbitraryPayloads: [
      ...declaration.arbitraryPayloads,
      { path, schema: "AdvancedVideoWorkcardContinuationV1" },
    ],
  };
}

function updateDeclaration(declaration: DtoDeclaration): DtoDeclaration {
  switch (declaration.locator) {
    case "http:accepted_arbitrary:packages/server/src/messaging/dispatch.ts#RoomPostMessageBody":
      return withArbitraryPayload(
        replaceRequired(
          declaration,
          "autoApprove?:boolean;clientActionSessionId?:unknown",
          "autoApprove?:boolean;cardContinuation?:unknown;clientActionSessionId?:unknown",
        ),
        "cardContinuation",
      );
    case "http:accepted_arbitrary:packages/types/src/api.ts#SendMessageRequest":
      return replaceRequired(
        declaration,
        "autoApprove?:boolean|undefined;clientActionSessionId?:string|undefined",
        "autoApprove?:boolean|undefined;cardContinuation?:\"advanced_video\"|undefined;clientActionSessionId?:string|undefined",
      );
    case "http:request_response:POST /api/chat":
      return replaceRequired(
        declaration,
        "autoApprove?:boolean;clientActionSessionId?:string",
        "autoApprove?:boolean;cardContinuation?:\"advanced_video\";clientActionSessionId?:string",
      );
    case "http:request_response:POST /api/rooms/:roomId/messages":
      return withArbitraryPayload(
        replaceRequired(
          declaration,
          "autoApprove?:boolean;clientActionSessionId?:unknown",
          "autoApprove?:boolean;cardContinuation?:unknown;clientActionSessionId?:unknown",
        ),
        "request.body.cardContinuation",
      );
    case "http:request_response:GET /api/rooms/:id/messages/:messageId/around":
    case "http:request_response:GET /api/rooms/:id/messages":
    case "http:request_response:GET /api/rooms/:id/thread-detail":
    case "http:request_response:GET /api/sessions/latest":
      return replaceRequired(
        declaration,
        "toolName?:string}",
        "toolName?:string;workcardContinuation?:{kind:\"advanced_video\";referenceCount:number}}",
      );
  }
  throw new Error(`unsupported 2026-08-17 DTO replacement: ${declaration.locator}`);
}

export function reviewedMain20260817DtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return SUPERSEDED.map((locator) => {
    const declaration = declarations.find((candidate) =>
      candidate.locator === locator
    );
    if (declaration === undefined) {
      throw new Error(`required 2026-08-17 DTO declaration is missing: ${locator}`);
    }
    return updateDeclaration(declaration);
  });
}
