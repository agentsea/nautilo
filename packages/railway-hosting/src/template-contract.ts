/**
 * Gate 1 is deliberately an observation-only contract.  A later GraphQL
 * adapter must reduce provider responses to these small, non-secret facts
 * before asking whether a disposable template experiment is safe to advance.
 * This module never fetches Railway and never returns provider-owned text.
 */
export const RAILWAY_TEMPLATE_EXPERIMENT_CONTRACT_SCHEMA_VERSION = 1;

export type RailwayTemplateExperimentReasonCode =
  | "railway.template-contract.qualified"
  | "railway.template-contract.input-invalid"
  | "railway.template-contract.identity-mismatch"
  | "railway.template-contract.resource-inventory-mismatch"
  | "railway.template-contract.source-not-image"
  | "railway.template-contract.mutable-image"
  | "railway.template-contract.provenance-invalid"
  | "railway.template-contract.held-command-mismatch"
  | "railway.template-contract.volume-mount-mismatch"
  | "railway.template-contract.domain-mismatch"
  | "railway.template-contract.variable-metadata-invalid"
  | "railway.template-contract.cleanup-inventory-invalid";

export type RailwayTemplateExperimentResult =
  | Readonly<{ readonly outcome: "go"; readonly code: "railway.template-contract.qualified" }>
  | Readonly<{ readonly outcome: "no-go"; readonly code: Exclude<RailwayTemplateExperimentReasonCode, "railway.template-contract.qualified"> }>;

export interface RailwayTemplateExperimentIdentity {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
}

export interface RailwayTemplateExperimentProvenance {
  /** Exact provider identities; private templates legitimately report a null thread slug. */
  readonly templateId: string;
  readonly templateServiceId: string;
  readonly templateThreadSlug: string | null;
}

export type RailwayTemplateExperimentResourceKind = "project" | "environment" | "service" | "volume" | "domain";

/** An exact receipt-owned resource inventory; no name matching is allowed. */
export interface RailwayTemplateExperimentResource {
  readonly kind: RailwayTemplateExperimentResourceKind;
  readonly id: string;
}

export interface RailwayTemplateExperimentVolume {
  readonly id: string;
  readonly mountPath: string;
}

export interface RailwayTemplateExperimentDomain {
  readonly id: string;
  readonly kind: "generated";
  readonly targetPort: number;
}

/**
 * This is metadata about provider-side variable custody, not the rendered
 * value. Literal values and secret contents are outside this contract. The
 * adapter may report only the boolean fact that Railway rendered the value.
 */
export interface RailwayTemplateExperimentVariableReference {
  readonly key: string;
  readonly source: "provider-reference" | "template-generated-secret";
  readonly referenceScope: "project" | "service";
  readonly rendered: true;
}

/**
 * This is a post-destroy observation, not a requested cleanup plan. The
 * project scope must be absent and the adapter must report zero survivors
 * before this evaluator can return `go`.
 */
export interface RailwayTemplateExperimentTerminalCleanupProof {
  readonly state: "verified-absent";
  readonly receiptOwnedInventory: readonly RailwayTemplateExperimentResource[];
  readonly projectAbsent: true;
  /** Must be an empty list at evaluation time; typed as a list so adapters can report an unsafe survivor. */
  readonly survivingResources: readonly RailwayTemplateExperimentResource[];
}

export interface RailwayTemplateExperimentExpected {
  readonly identity: RailwayTemplateExperimentIdentity;
  readonly imageReference: string;
  readonly heldStartCommand: string;
  readonly volume: RailwayTemplateExperimentVolume;
  readonly domain: RailwayTemplateExperimentDomain;
  readonly variables: readonly RailwayTemplateExperimentVariableReference[];
  readonly provenance: RailwayTemplateExperimentProvenance;
  readonly receiptOwnedInventory: readonly RailwayTemplateExperimentResource[];
}

export interface RailwayTemplateExperimentObservedMount {
  readonly volumeId: string;
  readonly mountPath: string;
}

export type RailwayTemplateExperimentObservedDomain = RailwayTemplateExperimentDomain;

export interface RailwayTemplateExperimentObservedImageSource {
  readonly kind: "image";
  readonly imageReference: string;
}

export interface RailwayTemplateExperimentObserved {
  readonly identity: RailwayTemplateExperimentIdentity;
  readonly source: RailwayTemplateExperimentObservedImageSource;
  readonly startCommand: string;
  readonly mounts: readonly RailwayTemplateExperimentObservedMount[];
  readonly domains: readonly RailwayTemplateExperimentObservedDomain[];
  readonly variables: readonly RailwayTemplateExperimentVariableReference[];
  readonly provenance: RailwayTemplateExperimentProvenance;
  /** Complete observed provider inventory for the experiment's project boundary. */
  readonly resources: readonly RailwayTemplateExperimentResource[];
  /** Independently observed terminal proof after receipt-driven cleanup. */
  readonly terminalCleanup: RailwayTemplateExperimentTerminalCleanupProof;
}

export interface RailwayTemplateExperimentContractInput {
  readonly expected: RailwayTemplateExperimentExpected;
  readonly observed: RailwayTemplateExperimentObserved;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const THREAD_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VARIABLE_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
// Railway preserves registry-qualified references, but normalizes Docker Hub
// official images to `name@sha256:...`. Both are exact immutable sources.
const IMAGE_REFERENCE = /^(?:[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/)?(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/;
const RESOURCE_KINDS: readonly RailwayTemplateExperimentResourceKind[] = ["project", "environment", "service", "volume", "domain"];

const GO: RailwayTemplateExperimentResult = Object.freeze({ outcome: "go" as const, code: "railway.template-contract.qualified" as const });

function noGo(code: Exclude<RailwayTemplateExperimentReasonCode, "railway.template-contract.qualified">): RailwayTemplateExperimentResult {
  return Object.freeze({ outcome: "no-go" as const, code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function nonEmptyId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function validHeldCommand(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 512
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
}

function validMountPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 512 || !value.startsWith("/") || value.endsWith("/")) return false;
  return value.slice(1).split("/").every((segment) => segment.length > 0
    && segment !== "."
    && segment !== ".."
    && /^[A-Za-z0-9._-]+$/.test(segment));
}

function validIdentity(value: unknown): value is RailwayTemplateExperimentIdentity {
  return exactKeys(value, ["projectId", "environmentId", "serviceId"])
    && nonEmptyId(value["projectId"])
    && nonEmptyId(value["environmentId"])
    && nonEmptyId(value["serviceId"]);
}

function sameIdentity(left: RailwayTemplateExperimentIdentity, right: RailwayTemplateExperimentIdentity): boolean {
  return left.projectId === right.projectId
    && left.environmentId === right.environmentId
    && left.serviceId === right.serviceId;
}

function validProvenance(value: unknown): value is RailwayTemplateExperimentProvenance {
  return exactKeys(value, ["templateId", "templateServiceId", "templateThreadSlug"])
    && nonEmptyId(value["templateId"])
    && nonEmptyId(value["templateServiceId"])
    && (value["templateThreadSlug"] === null
      || (typeof value["templateThreadSlug"] === "string" && THREAD_SLUG.test(value["templateThreadSlug"])));
}

function sameProvenance(left: RailwayTemplateExperimentProvenance, right: RailwayTemplateExperimentProvenance): boolean {
  return left.templateId === right.templateId
    && left.templateServiceId === right.templateServiceId
    && left.templateThreadSlug === right.templateThreadSlug;
}

function validVolume(value: unknown): value is RailwayTemplateExperimentVolume {
  return exactKeys(value, ["id", "mountPath"])
    && nonEmptyId(value["id"])
    && validMountPath(value["mountPath"]);
}

function validObservedMount(value: unknown): value is RailwayTemplateExperimentObservedMount {
  return exactKeys(value, ["volumeId", "mountPath"])
    && nonEmptyId(value["volumeId"])
    && validMountPath(value["mountPath"]);
}

function validDomain(value: unknown): value is RailwayTemplateExperimentDomain {
  return exactKeys(value, ["id", "kind", "targetPort"])
    && nonEmptyId(value["id"])
    && value["kind"] === "generated"
    && typeof value["targetPort"] === "number"
    && Number.isInteger(value["targetPort"])
    && value["targetPort"] >= 1
    && value["targetPort"] <= 65_535;
}

function validVariableReference(value: unknown): value is RailwayTemplateExperimentVariableReference {
  return exactKeys(value, ["key", "source", "referenceScope", "rendered"])
    && typeof value["key"] === "string"
    && VARIABLE_KEY.test(value["key"])
    && (value["source"] === "provider-reference" || value["source"] === "template-generated-secret")
    && (value["referenceScope"] === "project" || value["referenceScope"] === "service")
    && value["rendered"] === true;
}

function validVariableReferences(value: unknown): value is readonly RailwayTemplateExperimentVariableReference[] {
  if (!Array.isArray(value) || !value.every(validVariableReference)) return false;
  return new Set(value.map((entry) => entry.key)).size === value.length;
}

function variableInventory(values: readonly RailwayTemplateExperimentVariableReference[]): readonly string[] {
  return values
    .map((entry) => `${entry.key}\u0000${entry.source}\u0000${entry.referenceScope}\u0000${entry.rendered}`)
    .sort();
}

function sameVariables(
  expected: readonly RailwayTemplateExperimentVariableReference[],
  observed: readonly RailwayTemplateExperimentVariableReference[],
): boolean {
  const left = variableInventory(expected);
  const right = variableInventory(observed);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function validResource(value: unknown): value is RailwayTemplateExperimentResource {
  return exactKeys(value, ["kind", "id"])
    && typeof value["kind"] === "string"
    && RESOURCE_KINDS.includes(value["kind"] as RailwayTemplateExperimentResourceKind)
    && nonEmptyId(value["id"]);
}

function resourceKey(resource: RailwayTemplateExperimentResource): string {
  return `${resource.kind}\u0000${resource.id}`;
}

function validResourceInventory(value: unknown): value is readonly RailwayTemplateExperimentResource[] {
  if (!validResourceList(value)) return false;
  return new Set(value.map(resourceKey)).size === value.length;
}

function validResourceList(value: unknown): value is readonly RailwayTemplateExperimentResource[] {
  return Array.isArray(value) && value.every(validResource);
}

function sameInventory(
  expected: readonly RailwayTemplateExperimentResource[],
  observed: readonly RailwayTemplateExperimentResource[],
): boolean {
  if (expected.length !== observed.length) return false;
  const left = expected.map(resourceKey).sort();
  const right = observed.map(resourceKey).sort();
  return left.every((entry, index) => entry === right[index]);
}

function exactExpectedInventory(expected: RailwayTemplateExperimentExpected): boolean {
  const required: readonly RailwayTemplateExperimentResource[] = [
    { kind: "project", id: expected.identity.projectId },
    { kind: "environment", id: expected.identity.environmentId },
    { kind: "service", id: expected.identity.serviceId },
    { kind: "volume", id: expected.volume.id },
    { kind: "domain", id: expected.domain.id },
  ];
  return validResourceInventory(expected.receiptOwnedInventory)
    && expected.receiptOwnedInventory.length === required.length
    && sameInventory(required, expected.receiptOwnedInventory);
}

function validExpected(value: unknown): value is RailwayTemplateExperimentExpected {
  return exactKeys(value, ["identity", "imageReference", "heldStartCommand", "volume", "domain", "variables", "provenance", "receiptOwnedInventory"])
    && validIdentity(value["identity"])
    && typeof value["imageReference"] === "string"
    && validHeldCommand(value["heldStartCommand"])
    && validVolume(value["volume"])
    && validDomain(value["domain"])
    && validVariableReferences(value["variables"])
    && validProvenance(value["provenance"])
    && validResourceInventory(value["receiptOwnedInventory"])
    && exactExpectedInventory(value as unknown as RailwayTemplateExperimentExpected);
}

function validTerminalCleanupProof(value: unknown): value is RailwayTemplateExperimentTerminalCleanupProof {
  return exactKeys(value, ["state", "receiptOwnedInventory", "projectAbsent", "survivingResources"])
    && value["state"] === "verified-absent"
    && value["projectAbsent"] === true
    && validResourceList(value["receiptOwnedInventory"])
    && Array.isArray(value["survivingResources"])
    && value["survivingResources"].length === 0;
}

function validObserved(value: unknown): value is RailwayTemplateExperimentObserved {
  return exactKeys(value, ["identity", "source", "startCommand", "mounts", "domains", "variables", "provenance", "resources", "terminalCleanup"])
    && validIdentity(value["identity"])
    && validHeldCommand(value["startCommand"])
    && Array.isArray(value["mounts"])
    && Array.isArray(value["domains"])
    && validVariableReferences(value["variables"])
    && validProvenance(value["provenance"])
    && validResourceList(value["resources"])
    && validTerminalCleanupProof(value["terminalCleanup"]);
}

function evaluate(input: RailwayTemplateExperimentContractInput): RailwayTemplateExperimentResult {
  const { expected, observed } = input;
  if (!sameIdentity(expected.identity, observed.identity)) return noGo("railway.template-contract.identity-mismatch");
  if (!validResourceInventory(observed.resources) || !sameInventory(expected.receiptOwnedInventory, observed.resources)) {
    return noGo("railway.template-contract.resource-inventory-mismatch");
  }

  if (!exactKeys(observed.source, ["kind", "imageReference"]) || observed.source.kind !== "image" || typeof observed.source.imageReference !== "string") {
    return noGo("railway.template-contract.source-not-image");
  }
  if (!IMAGE_REFERENCE.test(expected.imageReference) || !IMAGE_REFERENCE.test(observed.source.imageReference) || expected.imageReference !== observed.source.imageReference) {
    return noGo("railway.template-contract.mutable-image");
  }
  if (!sameProvenance(expected.provenance, observed.provenance)) return noGo("railway.template-contract.provenance-invalid");
  if (expected.heldStartCommand !== observed.startCommand) return noGo("railway.template-contract.held-command-mismatch");

  if (observed.mounts.length !== 1 || !validObservedMount(observed.mounts[0])
    || observed.mounts[0].volumeId !== expected.volume.id
    || observed.mounts[0].mountPath !== expected.volume.mountPath) {
    return noGo("railway.template-contract.volume-mount-mismatch");
  }
  if (observed.domains.length !== 1 || !validDomain(observed.domains[0])
    || observed.domains[0].id !== expected.domain.id
    || observed.domains[0].kind !== expected.domain.kind
    || observed.domains[0].targetPort !== expected.domain.targetPort) {
    return noGo("railway.template-contract.domain-mismatch");
  }
  if (!sameVariables(expected.variables, observed.variables)) return noGo("railway.template-contract.variable-metadata-invalid");
  if (!validResourceInventory(observed.terminalCleanup.receiptOwnedInventory)
    || !sameInventory(expected.receiptOwnedInventory, observed.terminalCleanup.receiptOwnedInventory)) {
    return noGo("railway.template-contract.cleanup-inventory-invalid");
  }
  return GO;
}

/**
 * Evaluates one already-observed private template experiment. The outcome is
 * intentionally only a stable reason code; it never includes provider IDs,
 * image references, domains, commands, variables, secret values, or errors.
 */
export function evaluateRailwayTemplateExperiment(input: RailwayTemplateExperimentContractInput): RailwayTemplateExperimentResult {
  try {
    if (!exactKeys(input, ["expected", "observed"]) || !validExpected(input.expected) || !validObserved(input.observed)) {
      return noGo("railway.template-contract.input-invalid");
    }
    return evaluate(input as RailwayTemplateExperimentContractInput);
  } catch {
    return noGo("railway.template-contract.input-invalid");
  }
}
