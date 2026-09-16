import { connectedWebOperationTerminalReadResultSchema } from "@nautilo/types";

/**
 * Server-only projection contract for Browser Use read summaries.  This is
 * deliberately shared by the synchronous read runtime and the durable
 * operation finalizer so their acceptance bounds cannot drift.
 */
const PROVIDER_RESULT_MAX_CHARS = 12_000;
const PROVIDER_FACT_MAX_COUNT = 32;
const PROVIDER_FACT_LABEL_MAX_CHARS = 256;
const PROVIDER_FACT_VALUE_MAX_CHARS = 1_024;
const PROVIDER_ANSWER_MAX_CHARS = 8_000;

export interface ParsedConnectedWebRead {
  readonly kind: "read";
  readonly answer: string;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly completeness: "complete" | "partial" | "unknown";
  readonly provenance: "authenticated_website" | "user_connected_website" | "public_website";
  readonly origin: string;
}

export interface ParsedConnectedWebAuthenticationRequired {
  readonly kind: "authentication_required";
  readonly reason: "sign_in" | "mfa" | "captcha";
}

export type ParsedConnectedWebReadOutcome = ParsedConnectedWebRead | ParsedConnectedWebAuthenticationRequired;

export type ConnectedWebReadCost = Readonly<{
  readonly amountUsd: number | null;
  readonly state: "actual" | "unknown";
}>;

/** Provider-free durable shape matching the completed tool DTO for text. */
export type ConnectedWebTerminalReadResult = Readonly<{
  readonly version: 1;
  readonly account: Readonly<{ readonly id: string; readonly label: string; readonly service: string; readonly origin: string }> | null;
  readonly page: Readonly<{ readonly ref: string; readonly title: string; readonly origin: string }>;
  readonly read: Readonly<{
    readonly answer: string;
    readonly facts: readonly { readonly label: string; readonly value: string }[];
    readonly completeness: "complete" | "partial" | "unknown";
    readonly provenance: "authenticated_website" | "user_connected_website" | "public_website";
    readonly origin: string;
  }> | null;
  readonly cost: Readonly<{ readonly currency: "USD"; readonly amountUsd: number | null; readonly state: "actual" | "unknown" }>;
  readonly outputs: readonly [];
  readonly outputsTruncated: false;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value.trim() : null;
}

function boundedFactValue(value: unknown): string | null {
  if (typeof value === "string") return boundedText(value, PROVIDER_FACT_VALUE_MAX_CHARS);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return String(value);
  if (!Array.isArray(value) || value.length === 0) return null;
  const items = value.map((item) => {
    if (typeof item === "string") return item.trim().length > 0 ? item.trim() : null;
    if (typeof item === "number") return Number.isFinite(item) ? String(item) : null;
    if (typeof item === "boolean") return String(item);
    return null;
  });
  if (items.some((item) => item === null)) return null;
  return boundedText(items.join(", "), PROVIDER_FACT_VALUE_MAX_CHARS);
}

export function parseConnectedWebProviderCost(totalCostUsd: string | null): ConnectedWebReadCost | null {
  if (totalCostUsd === null) return { amountUsd: null, state: "unknown" };
  if (totalCostUsd.trim() === "") return null;
  const amountUsd = Number(totalCostUsd);
  return Number.isFinite(amountUsd) && amountUsd >= 0 ? { amountUsd, state: "actual" } : null;
}

export function parseConnectedWebProviderOutcome(raw: string | null, expectedOrigin: string): ParsedConnectedWebReadOutcome | null {
  if (raw === null || raw.length > PROVIDER_RESULT_MAX_CHARS) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  // A public provider may combine the checkpoint and read templates. Project
  // only the validated checkpoint; never surface its extra answer fields.
  const publicCheckpoint = exactKeys(parsed, ["outcome", "reason", "answer", "facts", "completeness", "provenance", "origin"])
    && parsed["provenance"] === "public_website" && parsed["origin"] === expectedOrigin;
  if (exactKeys(parsed, ["outcome", "reason"]) || publicCheckpoint) {
    if (parsed["outcome"] !== "authentication_required" || (parsed["reason"] !== "sign_in" && parsed["reason"] !== "mfa" && parsed["reason"] !== "captcha")) return null;
    return { kind: "authentication_required", reason: parsed["reason"] };
  }
  if (!exactKeys(parsed, ["answer", "facts", "completeness", "origin", "provenance"])) return null;
  const answer = boundedText(parsed["answer"], PROVIDER_ANSWER_MAX_CHARS);
  const origin = parsed["origin"] === expectedOrigin ? expectedOrigin : null;
  const completeness = parsed["completeness"];
  const provenance = parsed["provenance"];
  if (answer === null || origin === null || (completeness !== "complete" && completeness !== "partial" && completeness !== "unknown") || (provenance !== "authenticated_website" && provenance !== "user_connected_website" && provenance !== "public_website") || !Array.isArray(parsed["facts"]) || parsed["facts"].length > PROVIDER_FACT_MAX_COUNT) return null;
  const facts: Array<{ readonly label: string; readonly value: string }> = [];
  for (const fact of parsed["facts"]) {
    if (!isPlainObject(fact) || !exactKeys(fact, ["label", "value"])) return null;
    const label = boundedText(fact["label"], PROVIDER_FACT_LABEL_MAX_CHARS);
    const value = boundedFactValue(fact["value"]);
    if (label === null || value === null) return null;
    facts.push({ label, value });
  }
  return { kind: "read", answer, facts, completeness, provenance, origin };
}

export function parseConnectedWebTerminalReadResult(value: unknown): ConnectedWebTerminalReadResult | null {
  if (!isPlainObject(value) || !exactKeys(value, ["account", "cost", "outputs", "outputsTruncated", "page", "read", "version"]) || value["version"] !== 1 || !Array.isArray(value["outputs"]) || value["outputs"].length !== 0 || value["outputsTruncated"] !== false) return null;
  if (value["account"] === null) {
    const { version: _version, ...body } = value;
    const parsed = connectedWebOperationTerminalReadResultSchema.safeParse({ ...body, ok: true, status: "completed" });
    if (!parsed.success || parsed.data.account !== null) return null;
    return { version: 1, account: null, page: parsed.data.page, read: parsed.data.read,
      cost: parsed.data.cost, outputs: [], outputsTruncated: false };
  }
  const account = value["account"];
  const page = value["page"];
  const cost = value["cost"];
  if (!isPlainObject(account) || !exactKeys(account, ["id", "label", "origin", "service"]) || !isPlainObject(page) || !exactKeys(page, ["origin", "ref", "title"]) || !isPlainObject(cost) || !exactKeys(cost, ["amountUsd", "currency", "state"]) || cost["currency"] !== "USD") return null;
  const accountId = boundedText(account["id"], 256);
  const label = boundedText(account["label"], 256);
  const service = boundedText(account["service"], 128);
  const origin = boundedText(account["origin"], 2_048);
  if (!accountId || !label || !service || !origin || page["ref"] !== accountId || page["title"] !== label || page["origin"] !== origin) return null;
  const parsedCost = parseConnectedWebProviderCost(cost["state"] === "actual" && typeof cost["amountUsd"] === "number" ? String(cost["amountUsd"]) : cost["state"] === "unknown" && cost["amountUsd"] === null ? null : "");
  if (parsedCost === null || parsedCost.state !== cost["state"]) return null;
  if (value["read"] === null) return { version: 1, account: { id: accountId, label, service, origin }, page: { ref: accountId, title: label, origin }, read: null, cost: { currency: "USD", ...parsedCost }, outputs: [], outputsTruncated: false };
  const read = value["read"];
  if (!isPlainObject(read) || !exactKeys(read, ["answer", "completeness", "facts", "origin", "provenance"])) return null;
  const parsedRead = parseConnectedWebProviderOutcome(JSON.stringify(read), origin);
  if (parsedRead?.kind !== "read" || parsedRead.provenance === "public_website") return null;
  return {
    version: 1,
    account: { id: accountId, label, service, origin },
    page: { ref: accountId, title: label, origin },
    read: {
      answer: parsedRead.answer,
      facts: parsedRead.facts,
      completeness: parsedRead.completeness,
      provenance: "authenticated_website",
      origin,
    },
    cost: { currency: "USD", ...parsedCost }, outputs: [], outputsTruncated: false,
  };
}
