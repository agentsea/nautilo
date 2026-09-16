import { readFileSync } from "node:fs";

export const PINNED_CUA_DRIVER_VERSION = "0.23.2";
export const PINNED_CUA_SOURCE_SHA = "e88e9d899ac5effaeae38619527ebaa46b26ce72";
export const PINNED_CUA_MACOS_TOOL_COUNT = 56;

export const CUA_DISPOSITIONS = [
  "agent_exposed_computer",
  "browser_routed",
  "host_managed",
  "platform_inapplicable",
  "withheld_by_policy",
] as const;

export type CuaDisposition = (typeof CUA_DISPOSITIONS)[number];

export type CuaCapabilityReview = {
  name: string;
  disposition: CuaDisposition;
  rationale: string;
  alternative: string;
};

export type CuaCapabilityLedger = {
  schemaVersion: 1;
  driver: {
    version: string;
    sourceSha: string;
    platform: "macos";
    inventoryAuthority: string;
    sourceLocation: string;
  };
  toolCount: number;
  tools: CuaCapabilityReview[];
};

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const DISPOSITION_SET = new Set<string>(CUA_DISPOSITIONS);

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function namesFromJson(value: unknown): string[] {
  const candidate = Array.isArray(value) ? value : requireObject(value, "list-tools JSON").tools;
  if (!Array.isArray(candidate)) {
    throw new Error("list-tools JSON must be an array or an object with a tools array");
  }
  return candidate.map((entry, index) => {
    if (typeof entry === "string") return entry;
    const name = requireObject(entry, `list-tools entry ${index}`).name;
    if (typeof name !== "string") throw new Error(`list-tools entry ${index} is missing a string name`);
    return name;
  });
}

function assertUniqueToolNames(names: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!TOOL_NAME.test(name)) throw new Error(`${label} contains invalid tool name ${JSON.stringify(name)}`);
    if (seen.has(name)) throw new Error(`${label} contains duplicate tool ${name}`);
    seen.add(name);
  }
}

/** Parse machine JSON or the captured `name: first sentence` macOS CLI output. */
export function parseLiveListTools(raw: string): string[] {
  const source = raw.trim();
  if (source.length === 0) throw new Error("list-tools output is empty");
  const names = source.startsWith("[") || source.startsWith("{")
    ? namesFromJson(JSON.parse(source) as unknown)
    : source.split(/\r?\n/).map((line) => line.slice(0, line.indexOf(":") < 0 ? undefined : line.indexOf(":")).trim());
  assertUniqueToolNames(names, "live list-tools output");
  return [...names].sort();
}

function readLedger(value: unknown): CuaCapabilityLedger {
  const root = requireObject(value, "capability ledger");
  const driver = requireObject(root.driver, "capability ledger driver");
  if (!Array.isArray(root.tools)) throw new Error("capability ledger tools must be an array");
  const tools = root.tools.map((entry, index): CuaCapabilityReview => {
    const review = requireObject(entry, `capability ledger tool ${index}`);
    if (typeof review.name !== "string") throw new Error(`capability ledger tool ${index} has no name`);
    if (typeof review.disposition !== "string" || !DISPOSITION_SET.has(review.disposition)) {
      throw new Error(`capability ledger tool ${review.name} has an unreviewed disposition`);
    }
    if (typeof review.rationale !== "string" || review.rationale.trim().length === 0) {
      throw new Error(`capability ledger tool ${review.name} has no rationale`);
    }
    if (typeof review.alternative !== "string" || review.alternative.trim().length === 0) {
      throw new Error(`capability ledger tool ${review.name} has no semantic alternative`);
    }
    return {
      name: review.name,
      disposition: review.disposition as CuaDisposition,
      rationale: review.rationale,
      alternative: review.alternative,
    };
  });
  if (root.schemaVersion !== 1) throw new Error("capability ledger schemaVersion must be 1");
  if (typeof root.toolCount !== "number" || !Number.isInteger(root.toolCount)) {
    throw new Error("capability ledger toolCount must be an integer");
  }
  return {
    schemaVersion: root.schemaVersion,
    driver: {
      version: requireString(driver.version, "capability ledger driver version"),
      sourceSha: requireString(driver.sourceSha, "capability ledger source SHA"),
      platform: requireString(driver.platform, "capability ledger platform") as "macos",
      inventoryAuthority: requireString(driver.inventoryAuthority, "capability ledger inventory authority"),
      sourceLocation: requireString(driver.sourceLocation, "capability ledger source location"),
    },
    toolCount: root.toolCount,
    tools,
  };
}

/** Build a stable ledger only when every live tool already has an explicit review. */
export function generateCapabilityLedger(
  liveNames: readonly string[],
  reviews: readonly CuaCapabilityReview[],
  driver: CuaCapabilityLedger["driver"],
): CuaCapabilityLedger {
  assertUniqueToolNames(liveNames, "live list-tools output");
  assertUniqueToolNames(reviews.map((review) => review.name), "capability reviews");
  const byName = new Map(reviews.map((review) => [review.name, review]));
  const tools = [...liveNames].sort().map((name) => {
    const review = byName.get(name);
    if (!review) throw new Error(`live tool ${name} has no reviewed disposition`);
    return review;
  });
  const unexpectedReviews = reviews.map((review) => review.name).filter((name) => !liveNames.includes(name));
  if (unexpectedReviews.length > 0) throw new Error(`reviews contain tools absent from live output: ${unexpectedReviews.join(", ")}`);
  return validateCapabilityLedger({ schemaVersion: 1, driver, toolCount: tools.length, tools }, liveNames);
}

/** Fail closed on metadata, count, review, ordering, or live-inventory drift. */
export function validateCapabilityLedger(value: unknown, liveNames?: readonly string[]): CuaCapabilityLedger {
  const ledger = readLedger(value);
  if (ledger.schemaVersion !== 1) throw new Error("capability ledger schemaVersion must be 1");
  if (ledger.driver.version !== PINNED_CUA_DRIVER_VERSION) throw new Error("capability ledger driver version drift");
  if (ledger.driver.sourceSha !== PINNED_CUA_SOURCE_SHA) throw new Error("capability ledger source SHA drift");
  if (ledger.driver.platform !== "macos") throw new Error("capability ledger platform must be macos");
  if (!ledger.driver.inventoryAuthority.trim() || !ledger.driver.sourceLocation.trim()) {
    throw new Error("capability ledger must identify its live upstream authority and source location");
  }
  if (ledger.toolCount !== PINNED_CUA_MACOS_TOOL_COUNT || ledger.tools.length !== PINNED_CUA_MACOS_TOOL_COUNT) {
    throw new Error(`capability ledger must contain exactly ${PINNED_CUA_MACOS_TOOL_COUNT} tools`);
  }
  const ledgerNames = ledger.tools.map((tool) => tool.name);
  assertUniqueToolNames(ledgerNames, "capability ledger");
  if (ledgerNames.join("\n") !== [...ledgerNames].sort().join("\n")) throw new Error("capability ledger tools must be sorted");
  if (liveNames) {
    assertUniqueToolNames(liveNames, "live list-tools output");
    const live = [...liveNames].sort();
    const missing = live.filter((name) => !ledgerNames.includes(name));
    const removed = ledgerNames.filter((name) => !live.includes(name));
    if (missing.length || removed.length) {
      throw new Error(`Cua capability drift: unreviewed live=[${missing.join(", ")}], absent live=[${removed.join(", ")}]`);
    }
  }
  return ledger;
}

if (import.meta.main) {
  const [listToolsPath, ledgerPath] = Bun.argv.slice(2);
  if (!listToolsPath) throw new Error("usage: bun generate-cua-capability-ledger.ts <captured-list-tools> [ledger.json]");
  const liveNames = parseLiveListTools(readFileSync(listToolsPath, "utf8"));
  const target = ledgerPath
    ? readFileSync(ledgerPath, "utf8")
    : readFileSync(new URL("../cua-driver/capability-ledger.json", import.meta.url), "utf8");
  validateCapabilityLedger(JSON.parse(target) as unknown, liveNames);
  console.log(`Cua ${PINNED_CUA_DRIVER_VERSION} macOS capability ledger matches ${liveNames.length} live tools.`);
}
