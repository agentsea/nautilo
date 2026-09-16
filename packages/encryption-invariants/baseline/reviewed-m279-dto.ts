import type { DtoDeclaration } from "../src/node/dto-inventory";

const LOCATOR = "http:request_response:GET /api/admin/reflection-status";

export const SUPERSEDED_M279_DTO_LOCATORS = new Set<string>([LOCATOR]);

export function reviewedM279DtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  const declaration = declarations.find((candidate) => candidate.locator === LOCATOR);
  if (declaration === undefined) {
    throw new Error(`required M279 DTO declaration is missing: ${LOCATOR}`);
  }
  const before = ";stages:{authorityProjection:number;organization:number;searchProjection:number}";
  const scheduler = ";scheduler:{amplification:\"normal\"|\"pressure\"|\"watch\";backlog:{oldestAgeMs:number;size:number};lastPoll?:{authorityElapsedMs:number;candidateElapsedMs:number;candidatesOpened:number;capacityOutcomes:number;claims:number;crossRoomCompletions:number;crossRoomPlans:number;databaseWork:number;deterministicNoChanges:number;elapsedMs:number;modelCalls:number;modelElapsedMs:number;modelFailures:number;noEffectiveAudience:number;protectedExecutionUnavailable:number;publicationElapsedMs:number;sameRoomCompletions:number;sameRoomPlans:number;searchProjectionElapsedMs:number;stalePlans:number;unsupportedAuthorityShapes:number};nextEligiblePollAt?:string;pauseReason?:\"backlog_growth\"|\"elapsed_budget\"|\"recursive_amplification\"|\"repeated_failure\";recoveryIntervalMs:number;state:\"cooldown\"|\"disabled\"|\"pressure_paused\"|\"running\";window:{admitted:number;completed:number;created:number;polls:number}}";
  let replacements = 0;
  const structuralSignatures = (declaration.structuralSignatures ?? []).map((signature) => {
    if (!signature.includes(before)) return signature;
    replacements += 1;
    return signature.replace(before, `${scheduler}${before}`);
  });
  if (replacements !== 1) {
    throw new Error(`M279 DTO replacement matched ${replacements} signatures`);
  }
  return [{ ...declaration, structuralSignatures }];
}
