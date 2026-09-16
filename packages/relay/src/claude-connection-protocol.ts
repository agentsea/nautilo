/**
 * D452 v17 Claude Connections discovery wire.
 *
 * This is deliberately a closed, discovery-only contract: it transfers the
 * registered relay scope and independently observed runtime/account/catalog
 * facts only. It is not a task, session, credential, path, or billing lane.
 */
export const CLAUDE_CONNECTION_PROTOCOL_VERSION = 17 as const;
export const CLAUDE_CONNECTION_MAX_TEXT_BYTES = 320;
export const CLAUDE_CONNECTION_MAX_FRAME_BYTES = 16 * 1024;

export type RelayClaudeConnectionApiProvider =
  | "firstParty"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "anthropicAws"
  | "anthropicGoogleCloud"
  | "mantle"
  | "gateway";

export type RelayClaudeConnectionRuntime =
  | Readonly<{ state: "ready"; version: string; executionQualified: boolean }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "incompatible" | "failure"; version?: string }>;

/** A connected account must expose at least one safe display fact. */
export type RelayClaudeConnectionAccount =
  | Readonly<{
      state: "connected";
      email?: string;
      organization?: string;
      subscriptionType?: string;
      tokenSource?: string;
      apiKeySource?: string;
      apiProvider?: RelayClaudeConnectionApiProvider;
    }>
  | Readonly<{ state: "disconnected" | "unavailable" }>;

export type RelayClaudeConnectionModel = Readonly<{
  id: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportedEffortLevels?: readonly ("low" | "medium" | "high" | "xhigh" | "max")[];
  supportsEffort?: boolean;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}>;

/**
 * `complete` is exact rather than inferred from model count. A degraded
 * catalog has no exhaustive/default assertion, and unavailable carries no
 * stale models at all.
 */
export type RelayClaudeConnectionCatalog =
  | Readonly<{ state: "complete"; complete: true; models: readonly RelayClaudeConnectionModel[] }>
  | Readonly<{ state: "incomplete"; complete: false; models: readonly RelayClaudeConnectionModel[] }>
  | Readonly<{ state: "unavailable"; complete: false; models: readonly [] }>;

export type RelayClaudeConnectionScope = Readonly<{
  relayId: string;
  relaySessionId: string;
  desktopSessionId: string;
  pairingGenerationRef: string;
  selectedProtocolVersion: number;
  capabilityRevision: number;
}>;

export type RelayClaudeConnectionDiscoverCommand = Readonly<{
  type: "relay:claude-connection-discover";
  version: typeof CLAUDE_CONNECTION_PROTOCOL_VERSION;
  correlationId: string;
  scope: RelayClaudeConnectionScope;
  profileRef: string;
}>;

export type RelayClaudeConnectionDiscoveryResult = Readonly<{
  type: "relay:claude-connection-discovery-result";
  version: typeof CLAUDE_CONNECTION_PROTOCOL_VERSION;
  correlationId: string;
  scope: RelayClaudeConnectionScope;
  profileRef: string;
  runtime: RelayClaudeConnectionRuntime;
  account: RelayClaudeConnectionAccount;
  catalog: RelayClaudeConnectionCatalog;
}>;

const encoder = new TextEncoder();
const providers = new Set<RelayClaudeConnectionApiProvider>([
  "firstParty", "bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle", "gateway",
]);
const effortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);
const scopeKeys = ["relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef", "selectedProtocolVersion", "capabilityRevision"] as const;
const accountOptionalKeys = ["email", "organization", "subscriptionType", "tokenSource", "apiKeySource", "apiProvider"] as const;

/** Strict server-to-Desktop command parser. */
export function parseRelayClaudeConnectionDiscoverCommand(value: unknown): RelayClaudeConnectionDiscoverCommand | null {
  try {
    if (!frameWithinLimit(value) || !isPlainRecord(value)) return null;
    if (!exactKeys(value, ["type", "version", "correlationId", "scope", "profileRef"])) return null;
    if (
      value["type"] !== "relay:claude-connection-discover" ||
      value["version"] !== CLAUDE_CONNECTION_PROTOCOL_VERSION ||
      !uuid(value["correlationId"]) ||
      !uuid(value["profileRef"]) ||
      !parseScope(value["scope"])
    ) return null;
    return value as RelayClaudeConnectionDiscoverCommand;
  } catch {
    return null;
  }
}

/** Strict Desktop-to-server discovery-result parser. */
export function parseRelayClaudeConnectionDiscoveryResult(value: unknown): RelayClaudeConnectionDiscoveryResult | null {
  try {
    if (!frameWithinLimit(value) || !isPlainRecord(value)) return null;
    if (!exactKeys(value, ["type", "version", "correlationId", "scope", "profileRef", "runtime", "account", "catalog"])) return null;
    if (
      value["type"] !== "relay:claude-connection-discovery-result" ||
      value["version"] !== CLAUDE_CONNECTION_PROTOCOL_VERSION ||
      !uuid(value["correlationId"]) ||
      !uuid(value["profileRef"]) ||
      !parseScope(value["scope"]) ||
      !parseRuntime(value["runtime"]) ||
      !parseAccount(value["account"]) ||
      !parseCatalog(value["catalog"])
    ) return null;
    return value as RelayClaudeConnectionDiscoveryResult;
  } catch {
    return null;
  }
}

function frameWithinLimit(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && encoder.encode(serialized).byteLength <= CLAUDE_CONNECTION_MAX_FRAME_BYTES;
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function short(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= CLAUDE_CONNECTION_MAX_TEXT_BYTES &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    });
}

function uuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseScope(value: unknown): value is RelayClaudeConnectionScope {
  return isPlainRecord(value) && exactKeys(value, scopeKeys) &&
    short(value["relayId"]) && short(value["relaySessionId"]) && short(value["desktopSessionId"]) && short(value["pairingGenerationRef"]) &&
    positiveSafeInteger(value["selectedProtocolVersion"]) && value["selectedProtocolVersion"] >= CLAUDE_CONNECTION_PROTOCOL_VERSION &&
    nonNegativeSafeInteger(value["capabilityRevision"]);
}

function parseRuntime(value: unknown): value is RelayClaudeConnectionRuntime {
  if (!isPlainRecord(value) || typeof value["state"] !== "string") return false;
  if (value["state"] === "ready") return exactKeys(value, ["state", "version", "executionQualified"]) && short(value["version"]) && typeof value["executionQualified"] === "boolean";
  if (value["state"] === "unavailable") return exactKeys(value, ["state"]);
  return (value["state"] === "incompatible" || value["state"] === "failure") &&
    exactKeys(value, value["version"] === undefined ? ["state"] : ["state", "version"]) &&
    (value["version"] === undefined || short(value["version"]));
}

function parseAccount(value: unknown): value is RelayClaudeConnectionAccount {
  if (!isPlainRecord(value) || typeof value["state"] !== "string") return false;
  if (value["state"] === "disconnected" || value["state"] === "unavailable") return exactKeys(value, ["state"]);
  if (value["state"] !== "connected" || !exactKeysWithOptional(value, ["state"], accountOptionalKeys)) return false;
  const facts = accountOptionalKeys.filter((key) => value[key] !== undefined);
  return facts.length > 0 &&
    optionalShort(value["email"]) && optionalShort(value["organization"]) && optionalShort(value["subscriptionType"]) &&
    optionalShort(value["tokenSource"]) && optionalShort(value["apiKeySource"]) &&
    (value["apiProvider"] === undefined || (typeof value["apiProvider"] === "string" && providers.has(value["apiProvider"] as RelayClaudeConnectionApiProvider)));
}

function parseCatalog(value: unknown): value is RelayClaudeConnectionCatalog {
  if (!isPlainRecord(value) || !exactKeys(value, ["state", "complete", "models"]) || !Array.isArray(value["models"])) return false;
  if (!value["models"].every(parseModel)) return false;
  if (value["state"] === "complete") return value["complete"] === true;
  if (value["state"] === "incomplete") return value["complete"] === false;
  return value["state"] === "unavailable" && value["complete"] === false && value["models"].length === 0;
}

function parseModel(value: unknown): value is RelayClaudeConnectionModel {
  if (!isPlainRecord(value) || !exactKeysWithOptional(value, ["id", "displayName", "description"], ["resolvedModel", "supportedEffortLevels", "supportsEffort", "supportsAdaptiveThinking", "supportsFastMode", "supportsAutoMode"])) return false;
  return short(value["id"]) && short(value["displayName"]) && short(value["description"]) && optionalShort(value["resolvedModel"]) &&
    optionalBoolean(value["supportsEffort"]) && optionalBoolean(value["supportsAdaptiveThinking"]) && optionalBoolean(value["supportsFastMode"]) && optionalBoolean(value["supportsAutoMode"]) &&
    (value["supportedEffortLevels"] === undefined ||
      (Array.isArray(value["supportedEffortLevels"]) && value["supportedEffortLevels"].length <= 5 && value["supportedEffortLevels"].every((level) => typeof level === "string" && effortLevels.has(level))));
}

function exactKeysWithOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function optionalShort(value: unknown): boolean { return value === undefined || short(value); }
function optionalBoolean(value: unknown): boolean { return value === undefined || typeof value === "boolean"; }
function positiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function nonNegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
