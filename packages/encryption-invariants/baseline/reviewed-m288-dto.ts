import type { DtoDeclaration } from "../src/node/dto-inventory";

const LOCATOR = "http:request_response:GET /api/admin/reflection-status";

export const SUPERSEDED_M288_DTO_LOCATORS = new Set<string>([LOCATOR]);

export function reviewedM288DtoReplacements(
  declarations: readonly DtoDeclaration[],
): readonly DtoDeclaration[] {
  const declaration = declarations.find((candidate) => candidate.locator === LOCATOR);
  if (declaration === undefined) {
    throw new Error(`required M288 DTO declaration is missing: ${LOCATOR}`);
  }
  const currentBefore = "complete:number;deferred:number";
  const currentAfter = "complete:number;currentParentViolations:number;deferred:number";
  const schedulerBefore = ";nextEligiblePollAt?:string";
  const latency = ";latency:{crossRoom:{candidate:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};endToEnd:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};model:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};publication:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};queue:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number}};sameRoom:{candidate:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};endToEnd:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};model:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};publication:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number};queue:{maximumMs:number;p50Ms:number;p90Ms:number;samples:number}}}";
  let currentReplacements = 0;
  let latencyReplacements = 0;
  const structuralSignatures = (declaration.structuralSignatures ?? []).map((signature) => {
    if (!signature.startsWith("response.body:{current:")) return signature;
    if (signature.includes(currentBefore)) currentReplacements += 1;
    if (signature.includes(schedulerBefore)) latencyReplacements += 1;
    return signature
      .replace(currentBefore, currentAfter)
      .replace(schedulerBefore, `${latency}${schedulerBefore}`);
  });
  if (currentReplacements !== 1 || latencyReplacements !== 1) {
    throw new Error(
      `M288 DTO replacement matched current=${currentReplacements} latency=${latencyReplacements}`,
    );
  }
  return [{ ...declaration, structuralSignatures }];
}
