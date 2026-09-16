export type CodexModelOutputContract = Readonly<{
  version: 1;
  capabilityModelId: string;
  catalogVersion: string;
  contextTokens: number;
  outputTokens: number;
}>;

export type CodexModelExecutionLimits = Readonly<{
  modelId: string;
  catalogVersion: string | null;
  contextTokens: number;
  maxOutputTokens: number;
}>;

/** Codex app-server is an OpenAI execution surface; bind its exact API model. */
export function codexCapabilityModelId(apiModel: string): string {
  const normalized = apiModel.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(normalized)) {
    throw new TypeError("Invalid Codex capability model id");
  }
  return `openai:${normalized}`;
}

export function createCodexModelOutputContract(
  apiModel: string,
  limits: CodexModelExecutionLimits,
): CodexModelOutputContract {
  const capabilityModelId = codexCapabilityModelId(apiModel);
  if (
    limits.modelId !== capabilityModelId ||
    !limits.catalogVersion ||
    !positiveInteger(limits.contextTokens) ||
    !positiveInteger(limits.maxOutputTokens) ||
    limits.maxOutputTokens > limits.contextTokens
  ) {
    throw new TypeError("Codex model lacks an exact signed output contract");
  }
  return Object.freeze({
    version: 1,
    capabilityModelId,
    catalogVersion: limits.catalogVersion,
    contextTokens: limits.contextTokens,
    outputTokens: limits.maxOutputTokens,
  });
}

export function parseCodexModelOutputContract(
  value: unknown,
): CodexModelOutputContract | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    record["version"] !== 1 ||
    typeof record["capabilityModelId"] !== "string" ||
    !/^openai:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(record["capabilityModelId"]) ||
    typeof record["catalogVersion"] !== "string" ||
    record["catalogVersion"].length === 0 ||
    new TextEncoder().encode(record["catalogVersion"]).byteLength > 512 ||
    !positiveInteger(record["contextTokens"]) ||
    !positiveInteger(record["outputTokens"]) ||
    record["outputTokens"] > record["contextTokens"]
  ) {
    return null;
  }
  return record as CodexModelOutputContract;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
