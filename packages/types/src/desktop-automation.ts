/**
 * D516 — server-authored standing-desktop authority carried only by an
 * admitted graph run. These values are opaque binding handles, never model
 * input and never a substitute for the Electron-local grant receipt.
 */
export interface DesktopAutomationProvenance {
  readonly originHumanId: string;
  readonly originRunId: string;
  readonly originAgentId: string;
  readonly lineageId: string;
  readonly installationEpoch: string;
  readonly grantGeneration: number;
}

export type DesktopAutomationProvider = "cua";

/** Cua-only semantic capability marker advertised by Desktop relays. */
export const COMPUTER_USE_SEMANTIC_VERSION = 2 as const;
/** Exact graph-state route envelope version. */
export const DESKTOP_AUTOMATION_ROUTE_BINDING_VERSION = 2 as const;

/**
 * A server-minted immutable route attestation, distinct from Human/run
 * provenance. This binds an admitted graph to one executable local provider;
 * it cannot silently follow later policy or readiness changes.
 */
export interface DesktopAutomationRouteBinding {
  readonly version: typeof DESKTOP_AUTOMATION_ROUTE_BINDING_VERSION;
  readonly provider: DesktopAutomationProvider;
  readonly providerGeneration: string;
  readonly grantGeneration: number;
}

/** The outer graph state is deliberately exact: no advisory or derived keys. */
const DESKTOP_AUTOMATION_PROVENANCE_KEYS = [
  "grantGeneration",
  "installationEpoch",
  "lineageId",
  "originAgentId",
  "originHumanId",
  "originRunId",
] as const;

const DESKTOP_AUTOMATION_ROUTE_BINDING_KEYS = [
  "grantGeneration",
  "provider",
  "providerGeneration",
  "version",
] as const;

/**
 * Canonical grammar shared by Nautilo's current opaque UUID/nanoid/handle
 * families. Keeping this ASCII-only also rejects Unicode spaces and line
 * separators that ordinary control-character scans miss.
 */
export const MAX_DESKTOP_AUTOMATION_OPAQUE_ID_LENGTH = 256;
export const MAX_DESKTOP_AUTOMATION_GRANT_GENERATION = 2 ** 31 - 1;
export const DESKTOP_AUTOMATION_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function parseDesktopAutomationOpaqueId(value: unknown): string | null {
  return typeof value === "string" && DESKTOP_AUTOMATION_OPAQUE_ID_PATTERN.test(value)
    ? value
    : null;
}

function isExactDesktopAutomationProvenanceRecord(
  value: object,
): value is Record<(typeof DESKTOP_AUTOMATION_PROVENANCE_KEYS)[number], unknown> {
  const keys = Object.getOwnPropertyNames(value).sort();
  return (
    Object.getOwnPropertySymbols(value).length === 0
    &&
    keys.length === DESKTOP_AUTOMATION_PROVENANCE_KEYS.length
    && keys.every((key, index) => key === DESKTOP_AUTOMATION_PROVENANCE_KEYS[index])
  );
}

/**
 * Strictly decodes a checkpoint/input payload. Invalid or widened state is
 * absent authority (`null`), never a best-effort foreground fallback.
 */
export function parseDesktopAutomationProvenance(
  value: unknown,
): DesktopAutomationProvenance | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !isExactDesktopAutomationProvenanceRecord(value)
  ) {
    return null;
  }

  const originHumanId = parseDesktopAutomationOpaqueId(value.originHumanId);
  const originRunId = parseDesktopAutomationOpaqueId(value.originRunId);
  const originAgentId = parseDesktopAutomationOpaqueId(value.originAgentId);
  const lineageId = parseDesktopAutomationOpaqueId(value.lineageId);
  const installationEpoch = parseDesktopAutomationOpaqueId(value.installationEpoch);
  const grantGeneration = value.grantGeneration;
  if (
    originHumanId === null
    || originRunId === null
    || originAgentId === null
    || lineageId === null
    || installationEpoch === null
    || typeof grantGeneration !== "number"
    || !Number.isSafeInteger(grantGeneration)
    || grantGeneration < 1
    || grantGeneration > MAX_DESKTOP_AUTOMATION_GRANT_GENERATION
  ) {
    return null;
  }

  return Object.freeze({
    originHumanId,
    originRunId,
    originAgentId,
    lineageId,
    installationEpoch,
    grantGeneration,
  });
}

/** Invalid, stale, or widened route state is no authority. */
export function parseDesktopAutomationRouteBinding(
  value: unknown,
): DesktopAutomationRouteBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(record).sort();
  if (
    Object.getOwnPropertySymbols(record).length !== 0
    || keys.length !== DESKTOP_AUTOMATION_ROUTE_BINDING_KEYS.length
    || !keys.every((key, index) => key === DESKTOP_AUTOMATION_ROUTE_BINDING_KEYS[index])
  ) return null;
  const provider = record["provider"];
  const providerGeneration = parseDesktopAutomationOpaqueId(record["providerGeneration"]);
  const grantGeneration = record["grantGeneration"];
  if (
    record["version"] !== DESKTOP_AUTOMATION_ROUTE_BINDING_VERSION
    || provider !== "cua"
    || providerGeneration === null
    || typeof grantGeneration !== "number"
    || !Number.isSafeInteger(grantGeneration)
    || grantGeneration < 1
    || grantGeneration > MAX_DESKTOP_AUTOMATION_GRANT_GENERATION
  ) return null;
  return Object.freeze({
    version: DESKTOP_AUTOMATION_ROUTE_BINDING_VERSION,
    provider,
    providerGeneration,
    grantGeneration,
  });
}
