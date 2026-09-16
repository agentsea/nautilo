/** D452 v1 — Claude Agent SDK facts only; never raw SDK messages or a Codex/ACP envelope. */
export const CLAUDE_RELAY_PROTOCOL_VERSION = 1 as const;
export const CLAUDE_RELAY_MAX_FRAME_BYTES = 16 * 1024;
export const CLAUDE_RELAY_MAX_TEXT_BYTES = 320;

export type RelayClaudeApiProvider =
  | "firstParty"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "anthropicAws"
  | "anthropicGoogleCloud"
  | "mantle"
  | "gateway";

export interface RelayClaudeAccount {
  readonly state: "connected";
  readonly apiProvider?: RelayClaudeApiProvider;
  readonly email?: string;
  readonly organization?: string;
  readonly subscriptionType?: string;
  readonly tokenSource?: string;
  readonly apiKeySource?: string;
}

export interface RelayClaudeModel {
  readonly id: string;
  readonly resolvedModel?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: readonly ("low" | "medium" | "high" | "xhigh" | "max")[];
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
  readonly supportsAutoMode?: boolean;
}

export type RelayClaudeFact =
  | { readonly kind: "runtime"; readonly state: "ready"; readonly version: string; readonly executionQualified: boolean }
  | { readonly kind: "runtime"; readonly state: "unavailable" | "incompatible"; readonly version?: string }
  | { readonly kind: "account"; readonly account: RelayClaudeAccount }
  | { readonly kind: "account_state"; readonly state: "authenticating" | "disconnected" }
  | { readonly kind: "model_catalog"; readonly models: readonly RelayClaudeModel[]; readonly complete: boolean }
  | { readonly kind: "session_initialized"; readonly requestedModel: string; readonly servingModel: string; readonly claudeCodeVersion: string; readonly permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"; readonly interruptReceiptSupported: boolean }
  | { readonly kind: "serving_model"; readonly model: string; readonly scope: "root" | "subagent" }
  | { readonly kind: "tool_activity"; readonly state: "requested" | "progress"; readonly toolName: string; readonly scope: "root" | "subagent" }
  | { readonly kind: "permission_requested"; readonly toolName: string; readonly scope: "root" | "subagent" }
  | { readonly kind: "subagent_activity"; readonly state: "running" | "updated" }
  | { readonly kind: "hook_activity"; readonly state: "running" | "completed" }
  | { readonly kind: "session_state"; readonly state: "idle" | "running" | "awaiting_human" }
  | { readonly kind: "model_degraded"; readonly originalModel: string; readonly servingModel?: string; readonly scope: "root" | "subagent"; readonly outcome: "fallback" | "blocked" | "mismatch" }
  | { readonly kind: "interrupt_requested" }
  | { readonly kind: "interrupt_acknowledged" }
  | { readonly kind: "interrupt_uncertain" }
  | { readonly kind: "terminal"; readonly outcome: "completed" | "failed" | "degraded"; readonly resultSubtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"; readonly permissionDenialCount: number; readonly totalCostUsd: number; readonly actualModels: readonly string[] }
  | { readonly kind: "host_failure"; readonly code: "CLAUDE_SDK_FAILURE" };

export interface RelayClaudeFactMessage {
  readonly type: "relay:claude-fact";
  readonly version: typeof CLAUDE_RELAY_PROTOCOL_VERSION;
  readonly eventSequence: number;
  readonly fact: RelayClaudeFact;
}

export type ClaudeParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: "CLAUDE_FRAME_INVALID" | "CLAUDE_FRAME_TOO_LARGE" };

const encoder = new TextEncoder();
const providers = new Set<RelayClaudeApiProvider>(["firstParty", "bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle", "gateway"]);
const permissionModes = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);

export function parseRelayClaudeFactMessage(value: unknown): ClaudeParseResult<RelayClaudeFactMessage> {
  if (!isRecord(value)) return invalid();
  if (byteSize(value) > CLAUDE_RELAY_MAX_FRAME_BYTES) return { ok: false, error: "CLAUDE_FRAME_TOO_LARGE" };
  if (!exactKeys(value, ["type", "version", "eventSequence", "fact"])) return invalid();
  if (value["type"] !== "relay:claude-fact" || value["version"] !== CLAUDE_RELAY_PROTOCOL_VERSION || !nonNegative(value["eventSequence"]) || !parseFact(value["fact"])) return invalid();
  return { ok: true, value: { type: "relay:claude-fact", version: CLAUDE_RELAY_PROTOCOL_VERSION, eventSequence: value["eventSequence"], fact: value["fact"] } };
}

function parseFact(value: unknown): value is RelayClaudeFact {
  if (!isRecord(value) || !short(value["kind"])) return false;
  switch (value["kind"]) {
    case "runtime":
      return value["state"] === "ready"
        ? exactKeys(value, ["kind", "state", "version", "executionQualified"]) && short(value["version"]) && typeof value["executionQualified"] === "boolean"
        : exactKeys(value, ["kind", "state"], ["version"]) && oneOf(value["state"], ["unavailable", "incompatible"]) && optionalShort(value["version"]);
    case "account": return exactKeys(value, ["kind", "account"]) && parseAccount(value["account"]);
    case "account_state": return exactKeys(value, ["kind", "state"]) && oneOf(value["state"], ["authenticating", "disconnected"]);
    case "model_catalog": return exactKeys(value, ["kind", "models", "complete"]) && Array.isArray(value["models"]) && value["models"].length <= 12 && value["models"].every(parseModel) && typeof value["complete"] === "boolean";
    case "session_initialized": return exactKeys(value, ["kind", "requestedModel", "servingModel", "claudeCodeVersion", "permissionMode", "interruptReceiptSupported"]) && short(value["requestedModel"]) && short(value["servingModel"]) && short(value["claudeCodeVersion"]) && typeof value["permissionMode"] === "string" && permissionModes.has(value["permissionMode"]) && typeof value["interruptReceiptSupported"] === "boolean";
    case "serving_model": return exactKeys(value, ["kind", "model", "scope"]) && short(value["model"]) && oneOf(value["scope"], ["root", "subagent"]);
    case "tool_activity": return exactKeys(value, ["kind", "state", "toolName", "scope"]) && oneOf(value["state"], ["requested", "progress"]) && short(value["toolName"]) && oneOf(value["scope"], ["root", "subagent"]);
    case "permission_requested": return exactKeys(value, ["kind", "toolName", "scope"]) && short(value["toolName"]) && oneOf(value["scope"], ["root", "subagent"]);
    case "subagent_activity": return exactKeys(value, ["kind", "state"]) && oneOf(value["state"], ["running", "updated"]);
    case "hook_activity": return exactKeys(value, ["kind", "state"]) && oneOf(value["state"], ["running", "completed"]);
    case "session_state": return exactKeys(value, ["kind", "state"]) && oneOf(value["state"], ["idle", "running", "awaiting_human"]);
    case "model_degraded": return exactKeys(value, ["kind", "originalModel", "scope", "outcome"], ["servingModel"]) && short(value["originalModel"]) && optionalShort(value["servingModel"]) && oneOf(value["scope"], ["root", "subagent"]) && oneOf(value["outcome"], ["fallback", "blocked", "mismatch"]) && (value["outcome"] === "blocked" || value["servingModel"] !== undefined);
    case "interrupt_requested":
    case "interrupt_acknowledged":
    case "interrupt_uncertain": return exactKeys(value, ["kind"]);
    case "terminal": return exactKeys(value, ["kind", "outcome", "resultSubtype", "permissionDenialCount", "totalCostUsd", "actualModels"]) && oneOf(value["outcome"], ["completed", "failed", "degraded"]) && oneOf(value["resultSubtype"], ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]) && boundedCount(value["permissionDenialCount"]) && boundedCost(value["totalCostUsd"]) && Array.isArray(value["actualModels"]) && value["actualModels"].length <= 32 && value["actualModels"].every(short);
    case "host_failure": return exactKeys(value, ["kind", "code"]) && value["code"] === "CLAUDE_SDK_FAILURE";
    default: return false;
  }
}

function parseAccount(value: unknown): value is RelayClaudeAccount {
  return isRecord(value) && exactKeys(value, ["state"], ["apiProvider", "email", "organization", "subscriptionType", "tokenSource", "apiKeySource"]) && value["state"] === "connected" && (value["apiProvider"] === undefined || (typeof value["apiProvider"] === "string" && providers.has(value["apiProvider"] as RelayClaudeApiProvider))) && optionalShort(value["email"]) && optionalShort(value["organization"]) && optionalShort(value["subscriptionType"]) && optionalShort(value["tokenSource"]) && optionalShort(value["apiKeySource"]);
}

function parseModel(value: unknown): value is RelayClaudeModel {
  return isRecord(value) && exactKeys(value, ["id", "displayName", "description"], ["resolvedModel", "supportsEffort", "supportedEffortLevels", "supportsAdaptiveThinking", "supportsFastMode", "supportsAutoMode"]) && short(value["id"]) && short(value["displayName"]) && short(value["description"]) && optionalShort(value["resolvedModel"]) && optionalBoolean(value["supportsEffort"]) && optionalEffortLevels(value["supportedEffortLevels"]) && optionalBoolean(value["supportsAdaptiveThinking"]) && optionalBoolean(value["supportsFastMode"]) && optionalBoolean(value["supportsAutoMode"]);
}

function invalid(): ClaudeParseResult<never> { return { ok: false, error: "CLAUDE_FRAME_INVALID" }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean { const keys = Object.keys(value); return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key)); }
function byteSize(value: unknown): number { try { return encoder.encode(JSON.stringify(value)).byteLength; } catch { return Number.POSITIVE_INFINITY; } }
function short(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= CLAUDE_RELAY_MAX_TEXT_BYTES &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    });
}
function optionalShort(value: unknown): boolean { return value === undefined || short(value); }
function optionalBoolean(value: unknown): boolean { return value === undefined || typeof value === "boolean"; }
function nonNegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function boundedCount(value: unknown): value is number { return nonNegative(value) && value <= 1_000; }
function boundedCost(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000; }
function optionalEffortLevels(value: unknown): boolean { return value === undefined || (Array.isArray(value) && value.length <= 5 && value.every((entry) => oneOf(entry, ["low", "medium", "high", "xhigh", "max"]))); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T { return typeof value === "string" && (allowed as readonly string[]).includes(value); }
