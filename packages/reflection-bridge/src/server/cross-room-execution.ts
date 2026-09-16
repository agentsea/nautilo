import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import {
  assertPortableRecordSearchIdentifier,
  assertPositiveSafeInteger,
  type RecordEmbeddingV1,
} from "@nautilo/reflection/search";

/** Hard serialization ceilings for one exact cross-Room execution plan. */
export const CROSS_ROOM_EXECUTION_PLAN_LIMITS = Object.freeze({
  inputItems: 16,
  inputBytes: 1_048_576,
  outputBytes: 262_144,
  // Two selected cross-Room inputs may each carry the exact bounded attachment
  // and Human sets needed for the post-model authority fence. The encrypted
  // token expands those portable identifiers by base64url overhead.
  applicationPlanTokenBytes: 256 * 1_024,
} as const);

declare const CROSS_ROOM_APPLICATION_PLAN_TOKEN: unique symbol;

/** Opaque bridge-owned identity round-tripped through pure Organizer state. */
export type CrossRoomApplicationPlanToken = string & {
  readonly [CROSS_ROOM_APPLICATION_PLAN_TOKEN]: true;
};

export interface CrossRoomReadCoordinate {
  readonly namespaceRef: string;
  readonly bindingRef: string;
}

interface CrossRoomInputCoordinateBase {
  readonly role: "changed" | "candidate";
  readonly read: CrossRoomReadCoordinate;
  /** Selected repository payload generation fenced by execution. */
  readonly representationGeneration: number;
  /** Complete effective-audience generation fenced by execution. */
  readonly authorityGeneration: number;
}

export interface CrossRoomRecordInputCoordinate
  extends CrossRoomInputCoordinateBase {
  readonly kind: "record";
  readonly recordRef: string;
  readonly processingGeneration: number;
}

export interface CrossRoomMemoryInputCoordinate
  extends CrossRoomInputCoordinateBase {
  readonly kind: "source";
  readonly sourceKind: "memory";
  readonly logicalSourceRef: string;
  readonly contentGeneration: number;
  /**
   * Exact cross-Room discovery fence. Same-Room authored sources omit this
   * because their canonical source reader already owns the final exact fence.
   */
  readonly crossRoomFence?: Readonly<{
    readonly memoryRef: string;
    readonly embeddingRevision: number;
    readonly embeddingProvenance: RecordEmbeddingV1["provenance"];
    readonly updatedAtCoordinate: string;
    readonly authorityNamespaceRefs: readonly string[];
    readonly audience: EffectiveAudienceAlternative;
    readonly protectedObjectId?: string;
    readonly protectedAccessRevision?: number;
  }>;
}

/** Exact same-Room dependency support; never a cross-Room discovery candidate. */
export interface ReflectionMessageInputCoordinate
  extends Omit<CrossRoomMemoryInputCoordinate, "sourceKind" | "crossRoomFence"> {
  readonly sourceKind: "message";
  readonly crossRoomFence?: never;
}

export type CrossRoomInputCoordinate =
  | CrossRoomRecordInputCoordinate
  | CrossRoomMemoryInputCoordinate
  | ReflectionMessageInputCoordinate;

export interface CrossRoomOutputCoordinate {
  readonly accessRoomRef: string;
  readonly accessNamespaceRef: string;
  readonly publicationBindingRef: string;
  readonly authorityGeneration: number;
  readonly includesPublicBoundary: boolean;
}

export interface CrossRoomExecutionBudget {
  /** Includes the changed Record and every selected candidate. */
  readonly maxInputItems: number;
  /** Aggregate opened payload bytes before Organizer framing. */
  readonly maxInputBytes: number;
  /** One semantic decision: one normal attempt and at most one repair attempt. */
  readonly maxModelCalls: 2;
  /** One invocation can propose at most one publication. */
  readonly maxOutputItems: 1;
  readonly maxOutputBytes: number;
}

/**
 * Content-free exact-set handoff. Repository selection and semantic bytes are
 * deliberately absent so ordinary and future protected executors share it.
 */
export interface CrossRoomCandidatePlan {
  readonly workRef: string;
  readonly workGeneration: number;
  readonly policyVersion: string;
  readonly inputs: readonly CrossRoomInputCoordinate[];
  readonly commitments: Readonly<{
    authority: string;
    search: string;
    representation: string;
  }>;
  readonly budget: CrossRoomExecutionBudget;
  readonly idempotencyKey: string;
  /** Pre-model exact publication authority, stored without its enclosing token. */
  readonly publicationPlan?: Omit<
    CrossRoomPublicationPlan,
    "applicationPlanToken"
  >;
}

/** Exact selected subset and output coordinate derived after Organizer choice. */
export interface CrossRoomPublicationPlan {
  readonly applicationPlanToken: CrossRoomApplicationPlanToken;
  readonly policyVersion: string;
  readonly selectedInputs: readonly CrossRoomInputCoordinate[];
  /** Complete pre-model exposure, independent of the proposal's citations. */
  readonly modelExposureDependencies?: readonly DurableModelExposureDependency[];
  /**
   * Dependency-loss replacement only: this changed Record is fenced and
   * superseded, but its obsolete audience does not constrain remaining
   * evidence when the replacement authority is recomputed.
   */
  readonly predecessorOnlyRecordRef?: string;
  readonly output: CrossRoomOutputCoordinate;
  readonly commitments: Readonly<{
    authority: string;
    representation: string;
  }>;
  readonly budget: CrossRoomExecutionBudget;
  readonly idempotencyKey: string;
}

export type CrossRoomAuthorityOutcome =
  | {
      readonly status: "available";
      readonly alternative: EffectiveAudienceAlternative;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "unsupported_authority_shape"
        | "no_effective_audience";
    };

export type CrossRoomCandidatePlanningResult =
  | { readonly status: "planned"; readonly plan: CrossRoomCandidatePlan }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "unsupported_authority_shape"
        | "no_effective_audience"
        | "stale_input"
        | "capacity_exceeded";
    };

export type CrossRoomExecutionUnavailableReason =
  | "protected_execution_unavailable"
  | "stale_plan"
  | "input_unavailable"
  | "capacity_exceeded";

export interface CrossRoomExecutionUsage {
  readonly inputItems: number;
  readonly inputBytes: number;
  readonly modelCalls: 0 | 1 | 2;
  readonly outputItems: 0 | 1;
  readonly outputBytes: number;
}

export type CrossRoomCandidateExecutionResult<TOrganizerView> =
  | {
      readonly status: "executed";
      readonly organizerView: TOrganizerView;
      readonly applicationPlanToken: CrossRoomApplicationPlanToken;
      readonly usage: CrossRoomExecutionUsage;
    }
  | {
      readonly status: "no_change";
      readonly usage: CrossRoomExecutionUsage;
    }
  | {
      readonly status: "unavailable";
      readonly reason: CrossRoomExecutionUnavailableReason;
    };

export type CrossRoomPublicationResult<TReceipt> =
  | {
      readonly status: "published" | "replayed";
      readonly receipt: TReceipt;
    }
  | { readonly status: "no_change" }
  | {
      readonly status: "unavailable";
      readonly reason: "stale_plan" | "publication_unavailable";
    };

export type CrossRoomPublicationPlanningResult =
  | { readonly status: "planned"; readonly plan: CrossRoomPublicationPlan }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "unsupported_authority_shape"
        | "no_effective_audience"
        | "stale_plan"
        | "capacity_exceeded";
    };

/** Deterministic content-free candidate/authority planning responsibility. */
export interface CrossRoomCandidatePlanningPort {
  plan(input: Readonly<{
    workRef: string;
    workGeneration: number;
    signal?: AbortSignal;
  }>): Promise<CrossRoomCandidatePlanningResult>;
}

/** Exact candidate opens and bridge token creation before Organizer invocation. */
export interface CrossRoomCandidateExecutionPort<TOrganizerView> {
  execute(
    plan: CrossRoomCandidatePlan,
    signal?: AbortSignal,
  ): Promise<CrossRoomCandidateExecutionResult<TOrganizerView>>;
}

/** Revalidate the selected evidence and derive its one exact output coordinate. */
export interface CrossRoomPublicationPlanningPort<TProposal> {
  planPublication(
    input: Readonly<{
      applicationPlanToken: CrossRoomApplicationPlanToken;
      proposal: TProposal;
    }>,
    signal?: AbortSignal,
  ): Promise<CrossRoomPublicationPlanningResult>;
}

/** Deterministic proposal revalidation and immutable publication. */
export interface CrossRoomPublicationPort<TProposal, TReceipt> {
  publish(
    input: Readonly<{
      plan: CrossRoomPublicationPlan;
      proposal: TProposal;
    }>,
    signal?: AbortSignal,
  ): Promise<CrossRoomPublicationResult<TReceipt>>;
}

export interface CrossRoomOrganizationPorts<TOrganizerView, TProposal, TReceipt> {
  readonly candidatePlanning: CrossRoomCandidatePlanningPort;
  readonly candidateExecution: CrossRoomCandidateExecutionPort<TOrganizerView>;
  readonly publicationPlanning: CrossRoomPublicationPlanningPort<TProposal>;
  readonly publication: CrossRoomPublicationPort<TProposal, TReceipt>;
}

/** Marker contract for the ordinary repository implementation owned by M284. */
export interface OrdinaryCrossRoomExecutionAdapter<TOrganizerView>
  extends CrossRoomCandidateExecutionPort<TOrganizerView> {
  readonly representation: "ordinary";
}

/**
 * Intentional Wave-10 protected adapter. It owns no ports, cannot open bytes or
 * invoke a model, and gives the scheduler a stable non-retryable outcome.
 */
export class ProtectedUnavailableCrossRoomExecutionAdapter<TOrganizerView>
implements CrossRoomCandidateExecutionPort<TOrganizerView> {
  readonly representation = "protected" as const;

  execute(
    plan: CrossRoomCandidatePlan,
    _signal?: AbortSignal,
  ): Promise<CrossRoomCandidateExecutionResult<TOrganizerView>> {
    assertCrossRoomCandidatePlan(plan);
    return Promise.resolve({
      status: "unavailable",
      reason: "protected_execution_unavailable",
    });
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function coordinateIdentity(input: CrossRoomInputCoordinate): string {
  return input.kind === "record"
    ? `record\0${input.recordRef}`
    : `source\0${input.sourceKind}\0${input.logicalSourceRef}`;
}

function compareCoordinates(
  left: CrossRoomInputCoordinate,
  right: CrossRoomInputCoordinate,
): number {
  if (left.role !== right.role) return left.role === "changed" ? -1 : 1;
  return compareStrings(coordinateIdentity(left), coordinateIdentity(right));
}

function assertCanonicalHumanRefs(humanRefs: readonly string[]): void {
  let prior: string | undefined;
  for (const humanRef of humanRefs) {
    assertPortableRecordSearchIdentifier("authority Human reference", humanRef);
    if (prior !== undefined && compareStrings(prior, humanRef) >= 0) {
      throw new TypeError(
        "authority Human references must be unique and canonically ordered",
      );
    }
    prior = humanRef;
  }
}

/**
 * M284's intentionally narrow authority rule: every dependency supplies one
 * complete alternative, and the result must retain at least one real Human.
 */
export function intersectSingleAuthorityAlternatives(
  alternativesByInput: readonly (readonly EffectiveAudienceAlternative[])[],
): CrossRoomAuthorityOutcome {
  if (
    alternativesByInput.length < 1
    || alternativesByInput.length > CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputItems
  ) {
    throw new RangeError("cross-Room authority input count is out of bounds");
  }
  if (alternativesByInput.some((alternatives) => alternatives.length > 1)) {
    return { status: "unavailable", reason: "unsupported_authority_shape" };
  }
  if (alternativesByInput.some((alternatives) => alternatives.length === 0)) {
    return { status: "unavailable", reason: "no_effective_audience" };
  }

  const selected = alternativesByInput.map((alternatives) => alternatives[0]!);
  for (const alternative of selected) {
    if (typeof alternative.includesPublicBoundary !== "boolean") {
      throw new TypeError("authority alternative requires a public-boundary boolean");
    }
    assertCanonicalHumanRefs(alternative.humanRefs);
  }

  const remaining = new Set(selected[0]!.humanRefs);
  for (const alternative of selected.slice(1)) {
    const available = new Set(alternative.humanRefs);
    for (const humanRef of remaining) {
      if (!available.has(humanRef)) remaining.delete(humanRef);
    }
  }
  const humanRefs = [...remaining].sort(compareStrings);
  if (humanRefs.length === 0) {
    return { status: "unavailable", reason: "no_effective_audience" };
  }
  return {
    status: "available",
    alternative: Object.freeze({
      humanRefs: Object.freeze(humanRefs),
      includesPublicBoundary: selected.every(
        (alternative) => alternative.includesPublicBoundary,
      ),
    }),
  };
}

function assertReadCoordinate(
  label: string,
  coordinate: CrossRoomReadCoordinate,
): void {
  assertPortableRecordSearchIdentifier(`${label} Namespace reference`, coordinate.namespaceRef);
  assertPortableRecordSearchIdentifier(`${label} binding reference`, coordinate.bindingRef);
}

function assertInputCoordinate(
  input: CrossRoomInputCoordinate,
  index: number,
): void {
  assertReadCoordinate(`cross-Room input ${index}`, input.read);
  assertPositiveSafeInteger(
    `cross-Room input ${index} representation generation`,
    input.representationGeneration,
  );
  assertPositiveSafeInteger(
    `cross-Room input ${index} authority generation`,
    input.authorityGeneration,
  );
  if (input.kind === "record") {
    assertPortableRecordSearchIdentifier("cross-Room Record reference", input.recordRef);
    assertPositiveSafeInteger(
      "cross-Room Record processing generation",
      input.processingGeneration,
    );
    return;
  }
  if (input.sourceKind !== "memory" && input.sourceKind !== "message") {
    throw new TypeError("Reflection source kind must be memory or message");
  }
  if (input.role !== "candidate") {
    throw new TypeError("cross-Room changed input must be a Record");
  }
  assertPortableRecordSearchIdentifier(
    "cross-Room source logical reference",
    input.logicalSourceRef,
  );
  if (input.sourceKind === "message") {
    if (!/^message:[1-9][0-9]*$/.test(input.logicalSourceRef)
      || !Number.isSafeInteger(input.contentGeneration) || input.contentGeneration < 0
      || input.crossRoomFence !== undefined) throw new TypeError("Invalid exact Message support coordinate");
  } else {
    assertPositiveSafeInteger("cross-Room source content generation", input.contentGeneration);
  }
  if (input.crossRoomFence !== undefined) {
    const fence = input.crossRoomFence;
    assertPortableRecordSearchIdentifier(
      "cross-Room source Memory reference",
      fence.memoryRef,
    );
    if (input.logicalSourceRef !== `memory:${fence.memoryRef}`) {
      throw new TypeError("cross-Room source logical reference does not match Memory");
    }
    assertPositiveSafeInteger(
      "cross-Room source embedding revision",
      fence.embeddingRevision,
    );
    if (
      fence.embeddingRevision !== input.contentGeneration
      || !Number.isFinite(new Date(fence.updatedAtCoordinate).getTime())
      || fence.authorityNamespaceRefs.length < 1
      || fence.authorityNamespaceRefs.length > 256
    ) {
      throw new TypeError("cross-Room source fence is invalid");
    }
    let priorNamespace: string | undefined;
    for (const namespaceRef of fence.authorityNamespaceRefs) {
      assertPortableRecordSearchIdentifier(
        "cross-Room source authority Namespace reference",
        namespaceRef,
      );
      if (priorNamespace !== undefined && compareStrings(priorNamespace, namespaceRef) >= 0) {
        throw new TypeError("cross-Room source authority Namespaces must be canonical");
      }
      priorNamespace = namespaceRef;
    }
    if (!fence.authorityNamespaceRefs.includes(input.read.namespaceRef)) {
      throw new TypeError("cross-Room source read Namespace is not authoritative");
    }
    assertPortableRecordSearchIdentifier(
      "cross-Room source embedding provider",
      fence.embeddingProvenance.provider,
    );
    assertPortableRecordSearchIdentifier(
      "cross-Room source embedding model",
      fence.embeddingProvenance.canonicalModel,
    );
    assertPositiveSafeInteger(
      "cross-Room source embedding dimensions",
      fence.embeddingProvenance.dimensions,
    );
    assertPositiveSafeInteger(
      "cross-Room source embedding contract version",
      fence.embeddingProvenance.contractVersion,
    );
    assertCanonicalHumanRefs(fence.audience.humanRefs);
    if (typeof fence.audience.includesPublicBoundary !== "boolean") {
      throw new TypeError("cross-Room source audience boundary is invalid");
    }
    if (
      (fence.protectedObjectId === undefined)
        !== (fence.protectedAccessRevision === undefined)
    ) {
      throw new TypeError("cross-Room source protected fence is incomplete");
    }
    if (fence.protectedObjectId !== undefined) {
      assertPortableRecordSearchIdentifier(
        "cross-Room source protected object",
        fence.protectedObjectId,
      );
      if (
        !Number.isSafeInteger(fence.protectedAccessRevision)
        || fence.protectedAccessRevision! < 0
      ) throw new TypeError("cross-Room source protected access revision is invalid");
    }
  }
}

function assertBudget(
  budget: CrossRoomExecutionBudget,
  inputItems: number,
): void {
  assertPositiveSafeInteger("cross-Room input-item budget", budget.maxInputItems);
  assertPositiveSafeInteger("cross-Room input-byte budget", budget.maxInputBytes);
  assertPositiveSafeInteger("cross-Room output-byte budget", budget.maxOutputBytes);
  if (
    budget.maxInputItems < inputItems
    || budget.maxInputItems > CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputItems
  ) {
    throw new RangeError("cross-Room input-item budget is out of bounds");
  }
  if (budget.maxInputBytes > CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes) {
    throw new RangeError("cross-Room input-byte budget is out of bounds");
  }
  if (budget.maxOutputBytes > CROSS_ROOM_EXECUTION_PLAN_LIMITS.outputBytes) {
    throw new RangeError("cross-Room output-byte budget is out of bounds");
  }
  if (budget.maxModelCalls !== 2 || budget.maxOutputItems !== 1) {
    throw new RangeError(
      "cross-Room plans permit exactly one model call and one output item",
    );
  }
}

export function crossRoomApplicationPlanToken(
  value: string,
): CrossRoomApplicationPlanToken {
  if (
    new TextEncoder().encode(value).byteLength < 1
    || new TextEncoder().encode(value).byteLength
      > CROSS_ROOM_EXECUTION_PLAN_LIMITS.applicationPlanTokenBytes
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) throw new TypeError("cross-Room application-plan token must be bounded and portable");
  return value as CrossRoomApplicationPlanToken;
}

function assertCommitment(label: string, value: string): void {
  assertPortableRecordSearchIdentifier(`cross-Room ${label} commitment`, value);
}

function assertCanonicalInputs(inputs: readonly CrossRoomInputCoordinate[]): void {
  if (
    inputs.length < 1
    || inputs.length > CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputItems
  ) {
    throw new RangeError("cross-Room execution input count is out of bounds");
  }
  const changedInputs = inputs.filter((input) => input.role === "changed");
  if (
    inputs.filter((input) => input.kind === "source" && input.crossRoomFence !== undefined)
      .length > 2
  ) {
    throw new RangeError("cross-Room source-fence input count exceeds the selected bound");
  }
  if (
    changedInputs.length !== 1
    || changedInputs.some((input) => input.kind !== "record")
  ) {
    throw new TypeError(
      "cross-Room plan requires exactly one changed Record",
    );
  }
  const identities = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    assertInputCoordinate(input, index);
    const identity = coordinateIdentity(input);
    if (identities.has(identity)) {
      throw new TypeError("cross-Room input logical coordinates must be unique");
    }
    identities.add(identity);
    if (index > 0 && compareCoordinates(inputs[index - 1]!, input) >= 0) {
      throw new TypeError("cross-Room inputs must be unique and canonically ordered");
    }
  }
}

function assertOutputCoordinate(output: CrossRoomOutputCoordinate): void {
  assertPortableRecordSearchIdentifier(
    "cross-Room output access Room reference",
    output.accessRoomRef,
  );
  assertPortableRecordSearchIdentifier(
    "cross-Room output access Namespace reference",
    output.accessNamespaceRef,
  );
  assertPortableRecordSearchIdentifier(
    "cross-Room output publication binding reference",
    output.publicationBindingRef,
  );
  assertPositiveSafeInteger(
    "cross-Room output authority generation",
    output.authorityGeneration,
  );
  if (typeof output.includesPublicBoundary !== "boolean") {
    throw new TypeError("cross-Room output requires a public-boundary boolean");
  }
}

function assertModelExposureDependencies(
  dependencies: readonly DurableModelExposureDependency[] | undefined,
  inputs: readonly CrossRoomInputCoordinate[],
): void {
  if (dependencies === undefined) return;
  const identities = dependencies.map((dependency) => dependency.kind === "record"
    ? `record\0${dependency.recordRef}`
    : `source\0${dependency.sourceKind}\0${dependency.logicalSourceRef}`);
  if (
    identities.length !== inputs.length
    || new Set(identities).size !== identities.length
  ) {
    throw new TypeError("model exposure must match the full cross-Room input set");
  }
  for (const input of inputs) {
    const identity = coordinateIdentity(input);
    const index = identities.indexOf(identity);
    const dependency = dependencies[index];
    if (
      dependency === undefined
      || (input.kind === "record"
        ? dependency.kind !== "record"
          || dependency.observedProcessingGeneration !== input.processingGeneration
        : dependency.kind !== "source"
          || dependency.observedRevision !== String(input.contentGeneration))
    ) {
      throw new TypeError("model exposure coordinate is stale or substituted");
    }
  }
}

/** Validate the content-free candidate plan before selected-mode execution. */
export function assertCrossRoomCandidatePlan(
  plan: CrossRoomCandidatePlan,
): void {
  assertPortableRecordSearchIdentifier("cross-Room work reference", plan.workRef);
  assertPositiveSafeInteger("cross-Room work generation", plan.workGeneration);
  assertPortableRecordSearchIdentifier("cross-Room policy version", plan.policyVersion);
  assertPortableRecordSearchIdentifier(
    "cross-Room idempotency key",
    plan.idempotencyKey,
  );
  assertCommitment("authority", plan.commitments.authority);
  assertCommitment("search", plan.commitments.search);
  assertCommitment("representation", plan.commitments.representation);
  assertCanonicalInputs(plan.inputs);
  assertBudget(plan.budget, plan.inputs.length);
  if (plan.publicationPlan !== undefined) {
    const fixed = plan.publicationPlan;
    if (fixed.modelExposureDependencies === undefined) {
      throw new TypeError("fixed cross-Room publication plan requires model exposure");
    }
    assertPortableRecordSearchIdentifier(
      "cross-Room policy version",
      fixed.policyVersion,
    );
    assertPortableRecordSearchIdentifier(
      "cross-Room publication idempotency key",
      fixed.idempotencyKey,
    );
    assertCommitment("authority", fixed.commitments.authority);
    assertCommitment("representation", fixed.commitments.representation);
    assertCanonicalInputs(fixed.selectedInputs);
    assertModelExposureDependencies(
      fixed.modelExposureDependencies,
      fixed.selectedInputs,
    );
    assertOutputCoordinate(fixed.output);
    assertBudget(fixed.budget, fixed.selectedInputs.length);
    if (
      fixed.policyVersion !== plan.policyVersion
      || fixed.commitments.representation !== plan.commitments.representation
      || JSON.stringify(fixed.selectedInputs) !== JSON.stringify(plan.inputs)
      || JSON.stringify(fixed.budget) !== JSON.stringify(plan.budget)
    ) {
      throw new TypeError(
        "fixed cross-Room publication plan must match the full candidate inputs",
      );
    }
  }
}

/** Validate the post-selection exact output plan before publication. */
export function assertCrossRoomPublicationPlan(
  plan: CrossRoomPublicationPlan,
): void {
  crossRoomApplicationPlanToken(plan.applicationPlanToken);
  assertPortableRecordSearchIdentifier("cross-Room policy version", plan.policyVersion);
  assertPortableRecordSearchIdentifier(
    "cross-Room publication idempotency key",
    plan.idempotencyKey,
  );
  assertCommitment("authority", plan.commitments.authority);
  assertCommitment("representation", plan.commitments.representation);
  assertCanonicalInputs(plan.selectedInputs);
  assertModelExposureDependencies(
    plan.modelExposureDependencies,
    plan.selectedInputs,
  );
  if (plan.predecessorOnlyRecordRef !== undefined) {
    assertPortableRecordSearchIdentifier(
      "cross-Room predecessor-only Record",
      plan.predecessorOnlyRecordRef,
    );
    const changed = plan.selectedInputs.find((input) => input.role === "changed");
    if (
      changed?.kind !== "record"
      || changed.recordRef !== plan.predecessorOnlyRecordRef
      || plan.selectedInputs.length < 2
    ) {
      throw new TypeError("cross-Room predecessor-only fence is invalid");
    }
  }
  assertOutputCoordinate(plan.output);
  assertBudget(plan.budget, plan.selectedInputs.length);
}
