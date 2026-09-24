import { createHash } from "node:crypto";
import type {
  LegacyLimitDebt,
  LegacyLimitLock,
  LimitCheckResult,
  LimitDetectorCoverage,
  LimitInvestigationLink,
  LimitObservation,
  ReviewedLimitDecision,
} from "../model";
import {
  EXTRACTION_CONFIDENCES,
  isOneOf,
  LIMIT_CLASSIFICATIONS,
  LIMIT_DISPOSITIONS,
  LIMIT_EFFECTS,
  LIMIT_INVENTORY_SCHEMA_VERSION,
  LIMIT_LANES,
  LIMIT_REACHABILITIES,
  LIMIT_SOURCE_KINDS,
  MECHANICAL_PRIORITIES,
} from "../model";

type Header = {
  readonly type: string;
  readonly schemaVersion: number;
  readonly purpose: string;
};

type LooseRecord = Record<string, unknown> & {
  type?: unknown;
  schemaVersion?: unknown;
  purpose?: unknown;
  effect?: unknown;
  reachability?: unknown;
  sourceKind?: unknown;
  extractionConfidence?: unknown;
  mechanicalPriority?: unknown;
  line?: unknown;
  locator?: unknown;
  fingerprint?: unknown;
  path?: unknown;
  symbol?: unknown;
  owner?: unknown;
  detector?: unknown;
  value?: unknown;
  unit?: unknown;
  reasonCode?: unknown;
  effects?: unknown;
  reasonCodes?: unknown;
  lane?: unknown;
  siteCount?: unknown;
  sites?: unknown;
  expression?: unknown;
  classification?: unknown;
  disposition?: unknown;
  authority?: unknown;
  lossAndCompleteness?: unknown;
  visibility?: unknown;
  continuationOrRecovery?: unknown;
  evidence?: unknown;
  rationale?: unknown;
  count?: unknown;
  sha256?: unknown;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function object(value: unknown, label: string): LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as LooseRecord;
}

function string(value: unknown, field: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} has invalid ${field}`);
  return value;
}

function stringArray(value: unknown, field: string, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${label} has invalid ${field}`);
  }
  return value as string[];
}

function header(type: string, purpose: string): Header {
  return { type, schemaVersion: LIMIT_INVENTORY_SCHEMA_VERSION, purpose };
}

function parseHeader(value: unknown, expectedType: string, label: string): Header {
  const record = object(value, label);
  if (record.type !== expectedType) throw new Error(`${label} has invalid type: ${JSON.stringify(record.type)}`);
  if (record.schemaVersion !== LIMIT_INVENTORY_SCHEMA_VERSION) {
    throw new Error(`${label} has unsupported schemaVersion: ${JSON.stringify(record.schemaVersion)}`);
  }
  return {
    type: expectedType,
    schemaVersion: LIMIT_INVENTORY_SCHEMA_VERSION,
    purpose: string(record.purpose, "purpose", label),
  };
}

function parseObservation(value: unknown): LimitObservation {
  const record = object(value, "limit observation");
  if (!isOneOf(record.effect, LIMIT_EFFECTS)) throw new Error(`limit observation has invalid effect: ${JSON.stringify(record.effect)}`);
  if (!isOneOf(record.reachability, LIMIT_REACHABILITIES)) throw new Error(`limit observation has invalid reachability: ${JSON.stringify(record.reachability)}`);
  if (!isOneOf(record.sourceKind, LIMIT_SOURCE_KINDS)) throw new Error(`limit observation has invalid sourceKind: ${JSON.stringify(record.sourceKind)}`);
  if (!isOneOf(record.extractionConfidence, EXTRACTION_CONFIDENCES)) throw new Error(`limit observation has invalid extractionConfidence: ${JSON.stringify(record.extractionConfidence)}`);
  if (!isOneOf(record.mechanicalPriority, MECHANICAL_PRIORITIES)) throw new Error(`limit observation has invalid mechanicalPriority: ${JSON.stringify(record.mechanicalPriority)}`);
  if (!isOneOf(record.lane, LIMIT_LANES)) throw new Error(`limit observation has invalid lane: ${JSON.stringify(record.lane)}`);
  if (!Number.isInteger(record.line) || Number(record.line) < 1) throw new Error("limit observation has invalid line");
  if (!Number.isInteger(record.siteCount) || Number(record.siteCount) < 1) throw new Error("limit observation has invalid siteCount");
  if (!Array.isArray(record.effects) || record.effects.some((effect) => !isOneOf(effect, LIMIT_EFFECTS))) {
    throw new Error("limit observation has invalid effects");
  }
  const reasonCodes = stringArray(record.reasonCodes, "reasonCodes", "limit observation");
  if (!Array.isArray(record.sites) || record.sites.length !== record.siteCount) throw new Error("limit observation has invalid sites");
  const sites = record.sites.map((site, index) => {
    const value = object(site, `limit observation site ${index + 1}`);
    if (!Number.isInteger(value.line) || Number(value.line) < 1) throw new Error("limit observation site has invalid line");
    return {
      path: string(value.path, "path", "limit observation site"),
      line: Number(value.line),
      symbol: string(value.symbol, "symbol", "limit observation site"),
      detector: string(value.detector, "detector", "limit observation site"),
      expression: string(value.expression, "expression", "limit observation site"),
      reasonCode: string(value.reasonCode, "reasonCode", "limit observation site"),
    };
  });
  return {
    locator: string(record.locator, "locator", "limit observation"),
    fingerprint: string(record.fingerprint, "fingerprint", "limit observation"),
    path: string(record.path, "path", "limit observation"),
    line: Number(record.line),
    symbol: string(record.symbol, "symbol", "limit observation"),
    owner: string(record.owner, "owner", "limit observation"),
    sourceKind: record.sourceKind,
    detector: string(record.detector, "detector", "limit observation"),
    effect: record.effect,
    value: string(record.value, "value", "limit observation"),
    unit: string(record.unit, "unit", "limit observation"),
    reachability: record.reachability,
    extractionConfidence: record.extractionConfidence,
    mechanicalPriority: record.mechanicalPriority,
    reasonCode: string(record.reasonCode, "reasonCode", "limit observation"),
    effects: record.effects as LimitObservation["effects"],
    reasonCodes,
    lane: record.lane,
    siteCount: Number(record.siteCount),
    sites,
  };
}

function parseDecision(value: unknown): ReviewedLimitDecision {
  const record = object(value, "reviewed limit decision");
  if (!isOneOf(record.classification, LIMIT_CLASSIFICATIONS)) throw new Error(`reviewed limit decision has invalid classification: ${JSON.stringify(record.classification)}`);
  if (!isOneOf(record.disposition, LIMIT_DISPOSITIONS)) throw new Error(`reviewed limit decision has invalid disposition: ${JSON.stringify(record.disposition)}`);
  if (record.classification === "arbitrary" && record.disposition === "retain") {
    throw new Error("reviewed limit decision cannot permanently retain an arbitrary limit");
  }
  if (record.classification === "temporary_debt" && record.disposition !== "defer_named") {
    throw new Error("temporary debt must use the explicit defer_named disposition");
  }
  const evidence = stringArray(record.evidence, "evidence", "reviewed limit decision");
  if (!evidence.some((path) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|[.](?:spec|test)[.]/u.test(path))) {
    throw new Error("reviewed limit decision must cite behavioral test evidence");
  }
  return {
    locator: string(record.locator, "locator", "reviewed limit decision"),
    fingerprint: string(record.fingerprint, "fingerprint", "reviewed limit decision"),
    classification: record.classification,
    disposition: record.disposition,
    authority: string(record.authority, "authority", "reviewed limit decision"),
    owner: string(record.owner, "owner", "reviewed limit decision"),
    lossAndCompleteness: string(record.lossAndCompleteness, "lossAndCompleteness", "reviewed limit decision"),
    visibility: string(record.visibility, "visibility", "reviewed limit decision"),
    continuationOrRecovery: string(record.continuationOrRecovery, "continuationOrRecovery", "reviewed limit decision"),
    evidence,
    rationale: string(record.rationale, "rationale", "reviewed limit decision"),
  };
}

function parseDebt(value: unknown): LegacyLimitDebt {
  const record = object(value, "legacy limit debt");
  if (!isOneOf(record.mechanicalPriority, MECHANICAL_PRIORITIES)) throw new Error(`legacy limit debt has invalid mechanicalPriority: ${JSON.stringify(record.mechanicalPriority)}`);
  return {
    locator: string(record.locator, "locator", "legacy limit debt"),
    fingerprint: string(record.fingerprint, "fingerprint", "legacy limit debt"),
    owner: string(record.owner, "owner", "legacy limit debt"),
    mechanicalPriority: record.mechanicalPriority,
  };
}

function parseJsonl<T>(content: string, type: string, label: string, parse: (value: unknown) => T): T[] {
  const lines = content.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error(`${label} is empty`);
  parseHeader(JSON.parse(lines[0] ?? "null") as unknown, type, `${label} header`);
  return lines.slice(1).map((line, index) => {
    try {
      return parse(JSON.parse(line) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} line ${index + 2}: ${message}`);
    }
  });
}

function renderJsonl(type: string, purpose: string, values: readonly unknown[]): string {
  return [JSON.stringify(header(type, purpose)), ...values.map((value) => JSON.stringify(value)), ""].join("\n");
}

export function renderInventory(observations: readonly LimitObservation[]): string {
  return renderJsonl("limit-inventory", "Deterministically grouped investigation packets; never semantic judgments.", observations.map(publicObservation));
}

function publicArtifactEvidence(value: string): string {
  return value
    .replace(/\b(?:ISSUE-)?[MD]\d{3}(?![A-Za-z0-9])/gu, "[private planning reference]")
    .replace(/\/(?:Users|home)\/[^/"'\s\\]+/gu, "/[user-home]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[email]");
}

function publicObservation(observation: LimitObservation): LimitObservation {
  return {
    ...observation,
    sites: observation.sites.map((site) => ({
      ...site,
      expression: publicArtifactEvidence(site.expression),
    })),
  };
}

export function renderScout(input: {
  readonly observations: readonly LimitObservation[];
  readonly coverage: LimitDetectorCoverage;
  readonly linksByLocator: ReadonlyMap<string, readonly LimitInvestigationLink[]>;
}): string {
  const records = [
    {
      recordType: "header",
      type: "limit-scout",
      schemaVersion: LIMIT_INVENTORY_SCHEMA_VERSION,
      purpose: "Wide mechanical leads plus deterministic navigation evidence; never semantic judgments.",
    },
    {
      ...input.coverage,
      type: "limit-scout-coverage",
      schemaVersion: LIMIT_INVENTORY_SCHEMA_VERSION,
    },
    ...input.observations.map((observation) => ({
      recordType: "observation",
      type: "limit-scout-observation",
      schemaVersion: LIMIT_INVENTORY_SCHEMA_VERSION,
      ...publicObservation(observation),
      investigationLinks: (input.linksByLocator.get(observation.locator) ?? []).map((link) => ({
        ...link,
        detail: publicArtifactEvidence(link.detail),
      })),
    })),
  ];
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function renderLegacyDebt(debt: readonly LegacyLimitDebt[]): string {
  const sorted = [...debt].sort((left, right) => compareText(left.locator, right.locator));
  return renderJsonl("legacy-limit-debt", "Frozen initial unreviewed debt. It may shrink but cannot grow.", sorted);
}

export function legacyLockFor(debt: readonly LegacyLimitDebt[]): LegacyLimitLock {
  const rendered = renderLegacyDebt(debt);
  return {
    schemaVersion: LIMIT_INVENTORY_SCHEMA_VERSION,
    count: debt.length,
    sha256: createHash("sha256").update(rendered).digest("hex"),
  };
}

export function renderLegacyLock(lock: LegacyLimitLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function parseInventory(content: string): LimitObservation[] {
  return parseJsonl(content, "limit-inventory", "limit inventory", parseObservation);
}

export function parseDecisions(content: string): ReviewedLimitDecision[] {
  return parseJsonl(content, "reviewed-limit-decisions", "reviewed decisions", parseDecision);
}

export function parseLegacyDebt(content: string): LegacyLimitDebt[] {
  return parseJsonl(content, "legacy-limit-debt", "legacy debt", parseDebt);
}

export function parseLegacyLock(content: string): LegacyLimitLock {
  const record = object(JSON.parse(content) as unknown, "legacy lock");
  if (record.schemaVersion !== LIMIT_INVENTORY_SCHEMA_VERSION) throw new Error("legacy lock has unsupported schemaVersion");
  if (!Number.isInteger(record.count) || Number(record.count) < 0) throw new Error("legacy lock has invalid count");
  return {
    schemaVersion: LIMIT_INVENTORY_SCHEMA_VERSION,
    count: Number(record.count),
    sha256: string(record.sha256, "sha256", "legacy lock"),
  };
}

function duplicateLocators(values: readonly { readonly locator: string }[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.locator)) duplicates.add(value.locator);
    seen.add(value.locator);
  }
  return [...duplicates].sort(compareText);
}

function mapByLocator<T extends { readonly locator: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.locator, value]));
}

export function checkRegistry(input: {
  readonly current: readonly LimitObservation[];
  readonly committedInventory: readonly LimitObservation[];
  readonly decisions: readonly ReviewedLimitDecision[];
  readonly legacy: readonly LegacyLimitDebt[];
  readonly legacyLock: LegacyLimitLock;
}): LimitCheckResult {
  const errors: string[] = [];
  for (const [label, values] of [
    ["current inventory", input.current],
    ["committed inventory", input.committedInventory],
    ["reviewed decisions", input.decisions],
    ["legacy debt", input.legacy],
  ] as const) {
    for (const locator of duplicateLocators(values)) errors.push(`${label} contains duplicate locator ${locator}`);
  }

  const current = mapByLocator(input.current);
  const committed = mapByLocator(input.committedInventory);
  const decisions = mapByLocator(input.decisions);
  const legacy = mapByLocator(input.legacy);
  const expectedLock = legacyLockFor(input.legacy);
  if (expectedLock.count !== input.legacyLock.count || expectedLock.sha256 !== input.legacyLock.sha256) {
    errors.push("legacy debt lock does not match the frozen debt file; use shrink-legacy only after reviewed removals");
  }

  for (const observation of input.current) {
    const prior = committed.get(observation.locator);
    if (!prior) errors.push(`NEW observation ${observation.locator} (effects=${observation.effects.join(",")} mechanical-priority=${observation.mechanicalPriority} reasons=${observation.reasonCodes.join(",")}); run limit-preflight, then remove/derive/redesign it or add an evidence-backed reviewed decision`);
    else if (prior.fingerprint !== observation.fingerprint) errors.push(`CHANGED observation ${observation.locator} (effects=${observation.effects.join(",")} mechanical-priority=${observation.mechanicalPriority} reasons=${observation.reasonCodes.join(",")}); run limit-preflight, regenerate inventory, and re-review the changed boundary`);

    const decision = decisions.get(observation.locator);
    const debt = legacy.get(observation.locator);
    if (decision && debt) errors.push(`observation ${observation.locator} is both reviewed and legacy debt`);
    if (decision && decision.fingerprint !== observation.fingerprint) errors.push(`STALE decision ${observation.locator}; boundary fingerprint changed`);
    if (debt && debt.fingerprint !== observation.fingerprint) errors.push(`CHANGED legacy debt ${observation.locator}; legacy debt cannot absorb changed limits`);
    if (!decision && !debt) errors.push(`UNREVIEWED observation ${observation.locator}; remove/derive/redesign it or add an evidence-backed reviewed decision (legacy debt cannot grow)`);
  }
  for (const observation of input.committedInventory) {
    if (!current.has(observation.locator)) errors.push(`REMOVED observation ${observation.locator}; regenerate inventory and retire its decision/debt row`);
  }
  for (const decision of input.decisions) {
    if (!current.has(decision.locator)) errors.push(`ORPHANED decision ${decision.locator}`);
  }
  for (const debt of input.legacy) {
    if (!current.has(debt.locator)) errors.push(`STALE legacy debt ${debt.locator}; run shrink-legacy after confirming removal`);
  }

  const reviewed = input.current.filter((item) => decisions.get(item.locator)?.fingerprint === item.fingerprint).length;
  const legacyCount = input.current.filter((item) => legacy.get(item.locator)?.fingerprint === item.fingerprint).length;
  return {
    ok: errors.length === 0,
    errors,
    observations: input.current.length,
    reviewed,
    legacy: legacyCount,
    unreviewed: input.current.length - reviewed - legacyCount,
  };
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
}

export function renderMatrix(input: {
  readonly observations: readonly LimitObservation[];
  readonly decisions: readonly ReviewedLimitDecision[];
  readonly legacy: readonly LegacyLimitDebt[];
}): string {
  const decisions = mapByLocator(input.decisions);
  const legacy = mapByLocator(input.legacy);
  const counts = { reviewed: 0, legacy: 0, unreviewed: 0 };
  const priorityOrder: Record<LimitObservation["mechanicalPriority"], number> = { high: 0, medium: 1, low: 2 };
  const reachabilityOrder: Record<LimitObservation["reachability"], number> = {
    live: 0,
    operator_ci: 1,
    external: 2,
    migration_history: 3,
    test: 4,
    generated: 5,
    vendor: 6,
  };
  const ordered = [...input.observations].sort((left, right) =>
    priorityOrder[left.mechanicalPriority] - priorityOrder[right.mechanicalPriority]
    || reachabilityOrder[left.reachability] - reachabilityOrder[right.reachability]
    || compareText(left.locator, right.locator));
  const rows = ordered.map((observation) => {
    const decision = decisions.get(observation.locator);
    const debt = legacy.get(observation.locator);
    const status = decision ? "reviewed" : debt ? "legacy" : "unreviewed";
    counts[status] += 1;
    const siteDetail = observation.sites.map((site) => `${site.path}:${site.line} ${site.detector} \`${cell(publicArtifactEvidence(site.expression))}\``).join("<br>");
    return `| ${cell(observation.locator)} | ${observation.effects.join(", ")} | ${cell(observation.value)} ${cell(observation.unit)} | ${observation.siteCount} | ${observation.reachability} | ${observation.extractionConfidence} | ${observation.mechanicalPriority} | ${observation.reasonCodes.join(", ")} | ${status} | ${decision?.classification ?? "—"} | ${decision?.disposition ?? "—"} | ${siteDetail} |`;
  });
  const summarize = (dimension: string, values: readonly string[]): string[] => {
    const grouped = new Map<string, number>();
    for (const value of values) grouped.set(value, (grouped.get(value) ?? 0) + 1);
    return [...grouped].sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
      .map(([value, count]) => `| ${dimension} | ${cell(value)} | ${count} |`);
  };
  const summaryRows = [
    ...summarize("status", ordered.map((observation) => decisions.has(observation.locator) ? "reviewed" : legacy.has(observation.locator) ? "legacy" : "unreviewed")),
    ...summarize("mechanical priority", ordered.map((observation) => observation.mechanicalPriority)),
    ...summarize("reachability", ordered.map((observation) => observation.reachability)),
    ...summarize("effect", ordered.map((observation) => observation.effect)),
    ...summarize("surface reason", ordered.flatMap((observation) => observation.reasonCodes)),
    ...summarize("owner", ordered.map((observation) => observation.owner)),
  ];
  const reviewedRows = [...input.decisions].sort((left, right) => compareText(left.locator, right.locator)).map((decision) =>
    `| ${cell(decision.locator)} | ${decision.classification} | ${decision.disposition} | ${cell(decision.authority)} | ${cell(decision.lossAndCompleteness)} | ${cell(decision.visibility)} | ${cell(decision.continuationOrRecovery)} | ${cell(decision.evidence.join(", "))} | ${cell(decision.rationale)} |`);
  return [
    "# Limit decision matrix",
    "",
    "> Generated from deterministic observations plus separate reviewed decisions. Scanner cues are not semantic judgments.",
    "",
    `- Investigation packets: ${input.observations.length}`,
    `- Linked source sites: ${input.observations.reduce((total, observation) => total + observation.siteCount, 0)}`,
    `- Reviewed: ${counts.reviewed}`,
    `- Frozen legacy debt: ${counts.legacy}`,
    `- Unreviewed: ${counts.unreviewed}`,
    "",
    "## Mechanical summary",
    "",
    "| Dimension | Value | Count |",
    "|---|---|---:|",
    ...summaryRows,
    "",
    "## Reviewed decisions",
    "",
    "| Locator | Classification | Disposition | Authority | Loss and completeness | Visibility | Continuation or recovery | Behavioral evidence | Rationale |",
    "|---|---|---|---|---|---|---|---|---|",
    ...reviewedRows,
    "",
    "## Investigation ledger",
    "",
    "| Boundary packet | Effects | Observed value | Sites | Reachability | Extraction | Mechanical priority | Why surfaced | Status | Classification | Disposition | Investigative sites |",
    "|---|---|---|---:|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export function renderInvestigationMap(input: {
  readonly observations: readonly LimitObservation[];
  readonly decisions: readonly ReviewedLimitDecision[];
  readonly legacy: readonly LegacyLimitDebt[];
  readonly linksByLocator?: ReadonlyMap<string, readonly LimitInvestigationLink[]>;
}): string {
  const decisions = mapByLocator(input.decisions);
  const legacy = mapByLocator(input.legacy);
  const semanticEffects = new Set<LimitObservation["effect"]>(["truncate", "omit", "summarize", "sample"]);
  const reusablePath = /^(?:apps\/desktop\/electron|packages\/(?:agent\/src\/(?:providers|tools)|relay\/src|runtime\/src|sandbox\/src|server\/src\/routes))\//u;
  const frontline = input.observations.filter((observation) =>
    ((observation.effects.some((effect) => semanticEffects.has(effect))
      && observation.reasonCodes.includes("named_boundary_declaration")
      && observation.reasonCodes.some((reason) => reason === "sequence_reduction_sink" || reason === "semantic_reduction_sink"))
      || observation.reasonCodes.includes("returned_boundary_expression")
      || observation.reasonCodes.includes("yielded_boundary_expression"))
    && reusablePath.test(observation.path));
  const unresolved = input.observations.filter((observation) =>
    !decisions.has(observation.locator) && !legacy.has(observation.locator));
  const familyRows = (effects: ReadonlySet<LimitObservation["effect"]>): string[] => {
    const grouped = new Map<string, number>();
    for (const observation of input.observations) {
      if (!observation.effects.some((effect) => effects.has(effect))) continue;
      grouped.set(observation.owner, (grouped.get(observation.owner) ?? 0) + 1);
    }
    return [...grouped].sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
      .map(([owner, count]) => `| ${cell(owner)} | ${count} |`);
  };
  const packetRows = (observations: readonly LimitObservation[]): string[] => observations.map((observation) => {
    const status = decisions.has(observation.locator) ? "reviewed" : legacy.has(observation.locator) ? "legacy" : "unreviewed";
    const sites = observation.sites.map((site) => `${site.path}:${site.line} \`${cell(publicArtifactEvidence(site.expression))}\``).join("<br>");
    const evidence = (input.linksByLocator?.get(observation.locator) ?? [])
      .map((link) => `${link.kind}: ${link.path}:${link.line} ${link.symbol} (${link.reasonCode})`)
      .join("<br>") || "—";
    return `| ${cell(observation.locator)} | ${observation.effects.join(", ")} | ${cell(observation.value)} ${cell(observation.unit)} | ${observation.reasonCodes.join(", ")} | ${status} | ${sites} | ${cell(evidence)} |`;
  });
  const orderedFrontline = [...frontline].sort((left, right) => compareText(left.owner, right.owner) || compareText(left.locator, right.locator));
  const policyFamilyPairs = new Map<string, { left: LimitObservation; right: LimitInvestigationLink }>();
  for (const observation of input.observations) {
    for (const link of input.linksByLocator?.get(observation.locator) ?? []) {
      if (link.kind !== "policy_family" || !link.relatedLocator) continue;
      const key = [observation.locator, link.relatedLocator].sort(compareText).join("\0");
      if (!policyFamilyPairs.has(key)) policyFamilyPairs.set(key, { left: observation, right: link });
    }
  }
  const policyRows = [...policyFamilyPairs.values()]
    .sort((left, right) => compareText(left.left.locator, right.left.locator) || compareText(left.right.relatedLocator ?? "", right.right.relatedLocator ?? ""))
    .map(({ left, right }) => `| ${cell(left.locator)} | ${cell(right.relatedLocator ?? "")} | ${cell(right.reasonCode)} | ${cell(right.detail)} |`);
  return [
    "# Limit investigation map",
    "",
    "> Mechanical focus map for Codex/developers. It routes investigation; it does not decide whether any packet is legitimate.",
    "",
    `- Primary packets: ${input.observations.length}`,
    `- Linked primary sites: ${input.observations.reduce((total, observation) => total + observation.siteCount, 0)}`,
    `- New or uncovered packets: ${unresolved.length}`,
    `- Reusable semantic-loss and producer junctions: ${frontline.length}`,
    `- Mechanical policy-family references: ${policyRows.length}`,
    "",
    "## New or changed work",
    "",
    ...(unresolved.length === 0 ? ["No uncovered primary packets."] : [
      "| Packet | Effects | Value | Why surfaced | Status | Sites | Evidence cues |",
      "|---|---|---|---|---|---|---|",
      ...packetRows(unresolved),
    ]),
    "",
    "## Reusable semantic-loss and producer junctions",
    "",
    "These packets either link an explicit named boundary to a semantic-reduction sink or expose a direct boundary return on reusable Agent/tool/API/relay/runtime/sandbox surfaces. They are the first inspection set, not machine verdicts or a numerically capped top-N list.",
    "",
    "| Packet | Effects | Value | Why surfaced | Status | Sites | Evidence cues |",
    "|---|---|---|---|---|---|---|",
    ...packetRows(orderedFrontline),
    "",
    "## Mechanical policy-family references",
    "",
    "Same-value/name relationships are navigation cues only. Inspect every listed relationship; this section is not capped and does not imply shared authority.",
    "",
    "| Packet | Related packet | Mechanical reason | Related boundary |",
    "|---|---|---|---|",
    ...policyRows,
    "",
    "## Semantic-loss packets by owner",
    "",
    "| Owner | Packets |",
    "|---|---:|",
    ...familyRows(semanticEffects),
    "",
    "## Termination, retry, and eviction packets by owner",
    "",
    "| Owner | Packets |",
    "|---|---:|",
    ...familyRows(new Set(["terminate", "retry", "evict"])),
    "",
    "Use `bun run limits:scout` only when the investigation needs generic comparisons or scheduling timers. Use the full matrix for schema, payload, paging, concurrency, and other primary families.",
    "",
  ].join("\n");
}
