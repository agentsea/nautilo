import type { DtoDeclaration } from "../src/node/dto-inventory";

const SUPERSEDED = [
  "http:request_response:GET /api/admin/server-models",
  "http:request_response:GET /api/security/audit-log",
  "http:request_response:POST /api/admin/server-models",
  "http:request_response:POST /api/auth/approval-reply",
] as const;

export const SUPERSEDED_MAIN_2026_08_15_DTO_LOCATORS =
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
      `2026-08-15 DTO replacement did not match ${declaration.locator}`,
    );
  }
  return { ...declaration, structuralSignatures };
}

function updateDeclaration(declaration: DtoDeclaration): DtoDeclaration {
  switch (declaration.locator) {
    case "http:request_response:GET /api/admin/server-models":
    case "http:request_response:POST /api/admin/server-models":
      return replaceRequired(
        declaration,
        "reasoningOutput:{[key:string]:boolean};stenographerModel:string",
        "reasoningOutput:{[key:string]:boolean};reflectionModel:string;stenographerModel:string",
      );
    case "http:request_response:GET /api/security/audit-log":
      return replaceRequired(
        declaration,
        "fallbackChain:string[];stenographerModel:string",
        "fallbackChain:string[];reflectionModel:string;stenographerModel:string",
      );
    case "http:request_response:POST /api/auth/approval-reply":
      return replaceRequired(
        declaration,
        "localMcpInstallDigest?:string;threadId?:string",
        "localMcpInstallDigest?:string;mediaGenerationDigest?:string;mediaGenerationQuoteDigest?:string;mediaGenerationRevision?:number;threadId?:string",
      );
  }
  throw new Error(`unsupported 2026-08-15 DTO replacement: ${declaration.locator}`);
}

export function reviewedMain20260815DtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  return SUPERSEDED.map((locator) => {
    const declaration = declarations.find((candidate) =>
      candidate.locator === locator
    );
    if (declaration === undefined) {
      throw new Error(`required 2026-08-15 DTO declaration is missing: ${locator}`);
    }
    return updateDeclaration(declaration);
  });
}

export const REVIEWED_MAIN_2026_08_15_NEW_DTO_DECLARATIONS:
  readonly DtoDeclaration[] = [
  {
    observationId: "wire.http.request.response.get.api.admin.reflection.status.eqtoyg",
    locator: "http:request_response:GET /api/admin/reflection-status",
    structuralSignatures: [
      "response.body:{current:{backlog:number;checkpointed:number;claimed:number;complete:number;deferred:number;due:number;maximumAttempts:number;maximumRecoveryRound:number;oldestOverdueMs:number;quarantined:number;recoveryEligible:number;staleLeases:number;totalRecords:number};currentFailures:{attemptCount:number;errorCode:\"authority_unavailable\"|\"candidate_unavailable\"|\"embedding_unavailable\"|\"invalid_model_output\"|\"projection_unavailable\"|\"publication_unavailable\"|\"record_unavailable\"|\"retry_exhausted\"|\"unexpected_failure\";occurredAt:string;stage:\"authority_projection\"|\"organization\"|\"search_projection\"}[];generatedAt:string;health:\"degraded\"|\"delayed\"|\"healthy\";last24h:{completedWork:number;syntheticParentsCreated:number};lastCompletedAt?:string;nextRecoveryAt?:string;projections:{availableRecords:number;current:number;incompatible:number;pending:number};stages:{authorityProjection:number;organization:number;searchProjection:number};window:{since:string;until:string}}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
  {
    observationId: "wire.http.request.response.get.api.media.generations.receiptid.jv4a1a",
    locator: "http:request_response:GET /api/media-generations/:receiptId",
    structuralSignatures: [
      "request.params:{receiptId?:string}",
      "request.query:{roomId?:string}",
      "response.body:{artifact?:{artifactId:string;bytes:number;mime:string;path:string;zone:\"workspace\"};dtoVersion:1;failure?:{chargeCertainty:\"charged\"|\"not_charged\"|\"refunded\"|\"unknown\";code:string;completionCertainty:\"accepted\"|\"complete\"|\"not_started\"|\"unknown\";creditsRefunded?:boolean;message:string;phase:\"cleanup\"|\"download\"|\"queue\"|\"quote\"|\"reconcile\"|\"retrieve\"|\"save\";retrySafe:boolean;stateChanged:boolean};mediaKind:\"audio\"|\"video\";modelId:string;progress?:{elapsedSeconds?:number;estimatedSeconds?:number;message?:string;phase:\"downloading\"|\"generating\"|\"queued\"|\"saving\"|\"submitting\"};receiptId:string;recoveryActions:{actionId:string;kind:\"fresh_generation\"|\"repair_venice\"|\"retry_same_receipt\"|\"revise_prompt\"|\"switch_model\"|\"wait\";label:string;newSpend:boolean}[];revision:number;settings:{aspectRatio?:string;audioEnabled?:boolean;durationSeconds?:number;instrumental?:boolean;resolution?:string};state:\"cleanup-pending\"|\"downloading\"|\"failed\"|\"generating\"|\"needs-action\"|\"queued\"|\"ready\"|\"saving\"|\"submitting\"|\"unknown\"}",
      "response.body:{error:string}",
    ],
    arbitraryPayloads: [],
  },
];
