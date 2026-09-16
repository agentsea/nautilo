/** Browser-safe structural contract for the generic Computer Use broker. */
export const COMPUTER_USE_HOST_PROTOCOL_MAJOR = 3 as const;
export const COMPUTER_USE_HOST_PROTOCOL_MINOR = 0 as const;
export const COMPUTER_USE_HOST_CONTROL_MAX_BYTES = 16 * 1024 * 1024;
export const COMPUTER_USE_HOST_PNG_MAX_BYTES = 32 * 1024 * 1024;

const SCHEMA_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const CONTRACT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

export type ComputerUseHostProtocolVersion = Readonly<{ major: 3; minor: 0 }>;
export type ComputerUseEffectClass = "read" | "mutate" | "sensitive";
export type ComputerUseReplayClass = "safe" | "at_most_once";
export type ComputerUseAuthorityClass = "standing_computer_use";
export type ComputerUseAttachmentClass = "none" | "png";
export type ComputerUseDisclosureClass = "none" | "semantic" | "visual" | "semantic_and_visual";
export type ComputerUseSettlement = "completed" | "not_completed" | "unknown_completion" | "cancelled" | "revoked" | "stale" | "fenced" | "failed";
export type ComputerUseJson = null | boolean | number | string | readonly ComputerUseJson[] | { readonly [key: string]: ComputerUseJson };

/**
 * Closed broker failures that occur before a contract handler can return its
 * public result. These are transport/lifecycle facts, not Computer Use tool
 * semantics, so future contracts inherit them without adding a result variant.
 */
export type ComputerUseHostRejectionReason =
  | "stale_generation"
  | "duplicate_request"
  | "unsupported_contract"
  | "cancelled"
  | "host_failure";

export type ComputerUseHostRejectedResult = Readonly<{
  status: "host_rejected";
  reason: ComputerUseHostRejectionReason;
}>;

export type ComputerUseHostContract = Readonly<{
  contractNamespace: string;
  contractId: string;
  contractVersion: number;
  schemaDigest: string;
  effectClass: ComputerUseEffectClass;
  replayClass: ComputerUseReplayClass;
  authorityClass: ComputerUseAuthorityClass;
  attachmentClass: ComputerUseAttachmentClass;
  disclosureClass: ComputerUseDisclosureClass;
}>;

export type ComputerUseHostAuthorityScope = Readonly<{
  authorityLeaseId: string;
  authorityGeneration: number;
}>;

export type ComputerUseHostGenerationFence = Readonly<{
  hostGeneration: string;
  driverGeneration: string;
  cancellationGeneration: number;
}>;

export type ComputerUseHostAttachmentMetadata = Readonly<{
  attachmentId: string;
  requestId: string;
  hostGeneration: string;
  driverGeneration: string;
  mime: "image/png";
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
  coordinateSpace: "desktop_pixels" | "window_snapshot_pixels" | "presented_snapshot_pixels";
}>;

export type ComputerUseHostRequest = Readonly<{
  kind: "request";
  protocol: ComputerUseHostProtocolVersion;
  requestId: string;
  authority: ComputerUseHostAuthorityScope;
  fence: ComputerUseHostGenerationFence;
  contract: ComputerUseHostContract;
  arguments: Readonly<Record<string, ComputerUseJson>>;
}>;

export type ComputerUseHostCancel = Readonly<{
  kind: "cancel";
  protocol: ComputerUseHostProtocolVersion;
  requestId: string;
  authority: ComputerUseHostAuthorityScope;
  fence: ComputerUseHostGenerationFence;
}>;

export type ComputerUseHostResult = Readonly<{
  kind: "result";
  protocol: ComputerUseHostProtocolVersion;
  requestId: string;
  fence: ComputerUseHostGenerationFence;
  contract: ComputerUseHostContract;
  settlement: ComputerUseSettlement;
  result: Readonly<Record<string, ComputerUseJson>>;
  attachment?: ComputerUseHostAttachmentMetadata;
}>;

export type ComputerUseHostReady = Readonly<{
  kind: "ready";
  protocol: ComputerUseHostProtocolVersion;
  hostGeneration: string;
  driverGeneration: string;
  contracts: readonly ComputerUseHostContract[];
}>;

export type ComputerUseHostControlMessage = ComputerUseHostRequest | ComputerUseHostCancel | ComputerUseHostResult | ComputerUseHostReady;
export type ComputerUseHostResultMessage = ComputerUseHostResult;
export type ComputerUseHostResultExpectation = Readonly<{
  requestId: string;
  hostGeneration: string;
  driverGeneration: string;
  cancellationGeneration: number;
  authority: ComputerUseHostAuthorityScope;
  contract: ComputerUseHostContract;
}>;

export class ComputerUseHostProtocolError extends Error {
  constructor(readonly code: "invalid_frame" | "frame_too_large" | "invalid_message" | "invalid_attachment") {
    super(code);
    this.name = "ComputerUseHostProtocolError";
  }
}

function fail(code: ComputerUseHostProtocolError["code"]): never {
  throw new ComputerUseHostProtocolError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("invalid_message");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("invalid_message");
}

export function parseComputerUseHostRejectedResult(value: unknown): ComputerUseHostRejectedResult {
  const raw = record(value);
  exactKeys(raw, ["reason", "status"]);
  if (raw["status"] !== "host_rejected") fail("invalid_message");
  const reason = raw["reason"];
  if (reason !== "stale_generation" && reason !== "duplicate_request" && reason !== "unsupported_contract"
    && reason !== "cancelled" && reason !== "host_failure") fail("invalid_message");
  return { status: "host_rejected", reason };
}

/** Conservative server/model projection for one closed broker rejection. */
export function projectComputerUseHostRejectionSettlement(
  reason: ComputerUseHostRejectionReason,
  contract: Pick<ComputerUseHostContract, "effectClass" | "replayClass">,
): Extract<ComputerUseSettlement, "unknown_completion" | "stale" | "fenced" | "cancelled" | "failed"> {
  if (reason === "stale_generation") return "stale";
  if (reason === "duplicate_request" || reason === "unsupported_contract") return "fenced";
  if (reason === "cancelled") return "cancelled";
  return contract.effectClass === "read" && contract.replayClass === "safe" ? "failed" : "unknown_completion";
}

function optionalKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) fail("invalid_message");
}

function opaque(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) fail("invalid_message");
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail("invalid_message");
  return value;
}

function jsonScalar(value: unknown): null | boolean | number | string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_message");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") fail("invalid_message");
  return undefined;
}

/**
 * Validate and detach an arbitrary JSON value without an invented nesting
 * cutoff. The already-reviewed frame byte boundary bounds total work; this
 * iterative walk avoids making call-stack depth a second, hidden policy.
 */
function parseJson(value: unknown): ComputerUseJson {
  const scalar = jsonScalar(value);
  if (scalar !== undefined) return scalar;

  type Container = Record<string, ComputerUseJson> | ComputerUseJson[];
  type Pending = Readonly<{ source: object; target: Container }>;
  const seen = new WeakSet<object>();
  const sourceRoot = value as object;
  const outputRoot: Container = Array.isArray(sourceRoot) ? [] : Object.create(null) as Record<string, ComputerUseJson>;
  const pending: Pending[] = [{ source: sourceRoot, target: outputRoot }];
  seen.add(sourceRoot);

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (Object.getOwnPropertySymbols(current.source).length !== 0) fail("invalid_message");
    let entries: [string, unknown][];
    if (Array.isArray(current.source)) {
      const sourceArray = current.source as unknown[];
      const keys = Object.keys(sourceArray);
      if (keys.length !== sourceArray.length
        || keys.some((key, index) => key !== String(index))) fail("invalid_message");
      entries = keys.map((key) => [key, sourceArray[Number(key)]]);
    } else {
      entries = Object.entries(record(current.source)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    }

    for (const [key, entry] of entries) {
      const childScalar = jsonScalar(entry);
      if (childScalar !== undefined) {
        (current.target as Record<string, ComputerUseJson>)[key] = childScalar;
        continue;
      }
      const childSource = entry as object;
      if (seen.has(childSource)) fail("invalid_message");
      seen.add(childSource);
      const childTarget: Container = Array.isArray(childSource) ? [] : Object.create(null) as Record<string, ComputerUseJson>;
      (current.target as Record<string, ComputerUseJson>)[key] = childTarget;
      pending.push({ source: childSource, target: childTarget });
    }
  }
  return outputRoot;
}

/**
 * Validate, detach, and canonically order semantics-owned JSON. The broker
 * deliberately knows nothing about operation names or result fields; it owns
 * only deterministic JSON identity for framing, hashing, and replay fences.
 */
export function canonicalizeComputerUseJson(value: unknown): ComputerUseJson {
  return parseJson(value);
}

/**
 * Serialize JSON with lexicographically ordered object keys and preserved
 * array order. The iterative writer avoids introducing a hidden nesting limit.
 */
export function stringifyCanonicalComputerUseJson(value: unknown): string {
  const canonical = canonicalizeComputerUseJson(value);
  type Pending =
    | Readonly<{ kind: "value"; value: ComputerUseJson }>
    | Readonly<{ kind: "bytes"; value: string }>;
  const pending: Pending[] = [{ kind: "value", value: canonical }];
  const output: string[] = [];

  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.kind === "bytes") {
      output.push(next.value);
      continue;
    }
    const current = next.value;
    if (current === null || typeof current === "boolean" || typeof current === "number" || typeof current === "string") {
      output.push(JSON.stringify(current));
      continue;
    }
    if (Array.isArray(current)) {
      const entries = current as readonly ComputerUseJson[];
      output.push("[");
      pending.push({ kind: "bytes", value: "]" });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        pending.push({ kind: "value", value: entries[index]! });
        if (index !== 0) pending.push({ kind: "bytes", value: "," });
      }
      continue;
    }
    const entries = Object.entries(current).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    output.push("{");
    pending.push({ kind: "bytes", value: "}" });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entry] = entries[index]!;
      pending.push({ kind: "value", value: entry });
      pending.push({ kind: "bytes", value: ":" });
      pending.push({ kind: "bytes", value: JSON.stringify(key) });
      if (index !== 0) pending.push({ kind: "bytes", value: "," });
    }
  }
  return output.join("");
}

function jsonRecord(value: unknown): Readonly<Record<string, ComputerUseJson>> {
  const parsed = parseJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_message");
  return parsed as Readonly<Record<string, ComputerUseJson>>;
}

function parseProtocol(value: unknown): ComputerUseHostProtocolVersion {
  const raw = record(value);
  exactKeys(raw, ["major", "minor"]);
  if (raw["major"] !== 3 || raw["minor"] !== 0) fail("invalid_message");
  return { major: 3, minor: 0 };
}

function parseEffectClass(value: unknown): ComputerUseEffectClass {
  if (value !== "read" && value !== "mutate" && value !== "sensitive") fail("invalid_message");
  return value;
}

function parseReplayClass(value: unknown): ComputerUseReplayClass {
  if (value !== "safe" && value !== "at_most_once") fail("invalid_message");
  return value;
}

function parseAttachmentClass(value: unknown): ComputerUseAttachmentClass {
  if (value !== "none" && value !== "png") fail("invalid_message");
  return value;
}

function parseDisclosureClass(value: unknown): ComputerUseDisclosureClass {
  if (value !== "none" && value !== "semantic" && value !== "visual" && value !== "semantic_and_visual") fail("invalid_message");
  return value;
}

export function parseComputerUseHostContract(value: unknown): ComputerUseHostContract {
  const raw = record(value);
  exactKeys(raw, ["attachmentClass", "authorityClass", "contractId", "contractNamespace", "contractVersion", "disclosureClass", "effectClass", "replayClass", "schemaDigest"]);
  if (typeof raw["contractNamespace"] !== "string" || !CONTRACT_ID.test(raw["contractNamespace"])
    || typeof raw["contractId"] !== "string" || !CONTRACT_ID.test(raw["contractId"])
    || typeof raw["schemaDigest"] !== "string" || !SCHEMA_DIGEST.test(raw["schemaDigest"])
    || raw["authorityClass"] !== "standing_computer_use") fail("invalid_message");
  return {
    contractNamespace: raw["contractNamespace"],
    contractId: raw["contractId"],
    contractVersion: safeInteger(raw["contractVersion"], 1),
    schemaDigest: raw["schemaDigest"],
    effectClass: parseEffectClass(raw["effectClass"]),
    replayClass: parseReplayClass(raw["replayClass"]),
    authorityClass: "standing_computer_use",
    attachmentClass: parseAttachmentClass(raw["attachmentClass"]),
    disclosureClass: parseDisclosureClass(raw["disclosureClass"]),
  };
}

function descriptorKey(contract: ComputerUseHostContract): string {
  return `${contract.contractNamespace}\u0000${contract.contractId}\u0000${contract.contractVersion}`;
}

function sameContract(left: ComputerUseHostContract, right: ComputerUseHostContract): boolean {
  return descriptorKey(left) === descriptorKey(right)
    && left.schemaDigest === right.schemaDigest
    && left.effectClass === right.effectClass
    && left.replayClass === right.replayClass
    && left.authorityClass === right.authorityClass
    && left.attachmentClass === right.attachmentClass
    && left.disclosureClass === right.disclosureClass;
}

function sameAuthority(left: ComputerUseHostAuthorityScope, right: ComputerUseHostAuthorityScope): boolean {
  return left.authorityLeaseId === right.authorityLeaseId
    && left.authorityGeneration === right.authorityGeneration;
}

function parseSupportedContracts(value: unknown): readonly ComputerUseHostContract[] {
  if (!Array.isArray(value) || value.length === 0) fail("invalid_message");
  const seen = new Set<string>();
  return value.map((entry) => {
    const contract = parseComputerUseHostContract(entry);
    const key = descriptorKey(contract);
    if (seen.has(key)) fail("invalid_message");
    seen.add(key);
    return contract;
  });
}

export function parseComputerUseHostAuthorityScope(value: unknown): ComputerUseHostAuthorityScope {
  const raw = record(value);
  exactKeys(raw, ["authorityGeneration", "authorityLeaseId"]);
  return {
    authorityLeaseId: opaque(raw["authorityLeaseId"]),
    authorityGeneration: safeInteger(raw["authorityGeneration"], 1),
  };
}

export function parseComputerUseHostGenerationFence(value: unknown): ComputerUseHostGenerationFence {
  const raw = record(value);
  exactKeys(raw, ["cancellationGeneration", "driverGeneration", "hostGeneration"]);
  return {
    hostGeneration: opaque(raw["hostGeneration"]),
    driverGeneration: opaque(raw["driverGeneration"]),
    cancellationGeneration: safeInteger(raw["cancellationGeneration"], 0),
  };
}

export function parseComputerUseHostAttachmentMetadata(value: unknown): ComputerUseHostAttachmentMetadata {
  const raw = record(value);
  exactKeys(raw, ["attachmentId", "byteLength", "coordinateSpace", "driverGeneration", "height", "hostGeneration", "mime", "requestId", "sha256", "width"]);
  const coordinateSpace = raw["coordinateSpace"];
  if (raw["mime"] !== "image/png" || typeof raw["sha256"] !== "string" || !SHA256_HEX.test(raw["sha256"])
    || (coordinateSpace !== "desktop_pixels" && coordinateSpace !== "window_snapshot_pixels" && coordinateSpace !== "presented_snapshot_pixels")) fail("invalid_message");
  return {
    attachmentId: opaque(raw["attachmentId"]), requestId: opaque(raw["requestId"]),
    hostGeneration: opaque(raw["hostGeneration"]), driverGeneration: opaque(raw["driverGeneration"]),
    mime: "image/png", byteLength: safeInteger(raw["byteLength"], 0), sha256: raw["sha256"],
    width: safeInteger(raw["width"], 1), height: safeInteger(raw["height"], 1), coordinateSpace,
  };
}

function parseResultBase(raw: Record<string, unknown>) {
  return { protocol: parseProtocol(raw["protocol"]), requestId: opaque(raw["requestId"]), fence: parseComputerUseHostGenerationFence(raw["fence"]) };
}

export function parseComputerUseHostControlMessage(value: unknown): ComputerUseHostControlMessage {
  const raw = record(value);
  const kind = raw["kind"];
  if (kind === "request") {
    exactKeys(raw, ["arguments", "authority", "contract", "fence", "kind", "protocol", "requestId"]);
    return { kind, protocol: parseProtocol(raw["protocol"]), requestId: opaque(raw["requestId"]), authority: parseComputerUseHostAuthorityScope(raw["authority"]), fence: parseComputerUseHostGenerationFence(raw["fence"]), contract: parseComputerUseHostContract(raw["contract"]), arguments: jsonRecord(raw["arguments"]) };
  }
  if (kind === "cancel") {
    exactKeys(raw, ["authority", "fence", "kind", "protocol", "requestId"]);
    return { kind, protocol: parseProtocol(raw["protocol"]), requestId: opaque(raw["requestId"]), authority: parseComputerUseHostAuthorityScope(raw["authority"]), fence: parseComputerUseHostGenerationFence(raw["fence"]) };
  }
  if (kind === "result") {
    optionalKeys(raw, ["contract", "fence", "kind", "protocol", "requestId", "result", "settlement"], ["attachment"]);
    if (raw["settlement"] !== "completed" && raw["settlement"] !== "not_completed" && raw["settlement"] !== "unknown_completion"
      && raw["settlement"] !== "cancelled" && raw["settlement"] !== "revoked" && raw["settlement"] !== "stale"
      && raw["settlement"] !== "fenced" && raw["settlement"] !== "failed") fail("invalid_message");
    const parsed: ComputerUseHostResult = { kind, ...parseResultBase(raw), contract: parseComputerUseHostContract(raw["contract"]), settlement: raw["settlement"], result: jsonRecord(raw["result"]), ...(raw["attachment"] === undefined ? {} : { attachment: parseComputerUseHostAttachmentMetadata(raw["attachment"]) }) };
    if (parsed.attachment !== undefined && parsed.contract.attachmentClass !== "png") fail("invalid_message");
    if (parsed.attachment !== undefined && parsed.contract.disclosureClass !== "visual" && parsed.contract.disclosureClass !== "semantic_and_visual") fail("invalid_message");
    if (parsed.attachment !== undefined) assertComputerUseHostAttachmentMatchesResult(parsed.attachment, parsed);
    return parsed;
  }
  if (kind === "ready") {
    exactKeys(raw, ["contracts", "driverGeneration", "hostGeneration", "kind", "protocol"]);
    return { kind, protocol: parseProtocol(raw["protocol"]), hostGeneration: opaque(raw["hostGeneration"]), driverGeneration: opaque(raw["driverGeneration"]), contracts: parseSupportedContracts(raw["contracts"]) };
  }
  return fail("invalid_message");
}

export function assertComputerUseHostAttachmentMatchesResult(metadata: ComputerUseHostAttachmentMetadata, result: Pick<ComputerUseHostResult, "requestId" | "fence">): void {
  if (metadata.requestId !== result.requestId || metadata.hostGeneration !== result.fence.hostGeneration || metadata.driverGeneration !== result.fence.driverGeneration) fail("invalid_message");
}

export class ComputerUseHostResultGate {
  #settled = false;
  constructor(private readonly expected: ComputerUseHostResultExpectation) {}
  accept(message: ComputerUseHostResultMessage): ComputerUseHostResultMessage {
    const parsed = parseComputerUseHostControlMessage(message);
    if (parsed.kind !== "result") fail("invalid_message");
    const expected = this.expected;
    if (this.#settled || parsed.requestId !== expected.requestId
      || parsed.fence.hostGeneration !== expected.hostGeneration
      || parsed.fence.driverGeneration !== expected.driverGeneration
      || parsed.fence.cancellationGeneration !== expected.cancellationGeneration
      || !sameContract(parsed.contract, expected.contract)) fail("invalid_message");
    this.#settled = true;
    return parsed;
  }

  /** Settle this request by one exact authority-bound cancellation. */
  cancel(message: ComputerUseHostCancel): void {
    const parsed = parseComputerUseHostControlMessage(message);
    if (parsed.kind !== "cancel") fail("invalid_message");
    const expected = this.expected;
    if (this.#settled || parsed.requestId !== expected.requestId
      || parsed.fence.hostGeneration !== expected.hostGeneration
      || parsed.fence.driverGeneration !== expected.driverGeneration
      || parsed.fence.cancellationGeneration !== expected.cancellationGeneration
      || !sameAuthority(parsed.authority, expected.authority)) fail("invalid_message");
    this.#settled = true;
  }
}
