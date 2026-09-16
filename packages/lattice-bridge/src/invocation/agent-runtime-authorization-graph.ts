import {
  LATTICE_LIMITS,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  portableIdIsValid,
  type AgentRuntimeAuthorizationPlan,
  type AgentRuntimeAuthorizationTransitionPlan,
  type AgentRuntimeRotationManager,
} from "@nautilo/lattice-crypto";

export type AgentRuntimeAuthorizationNamespaceEdge = Readonly<{
  readonly namespaceId: string;
  readonly domainId: string;
  readonly authorizedHumanIds: readonly string[];
}>;

export type AgentRuntimeAuthorizationDomainAuthority = Readonly<{
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly agentAuthorizationRevision: number;
  readonly committerDeviceId: string;
  readonly committerAvailable: boolean;
}>;

export type AgentRuntimeAuthorizationGraphSnapshot = Readonly<{
  readonly managementHumanIds: readonly string[];
  readonly namespaceEdges:
    readonly AgentRuntimeAuthorizationNamespaceEdge[];
  readonly domainAuthorities:
    readonly AgentRuntimeAuthorizationDomainAuthority[];
}>;

export type AgentRuntimeAuthorizationGraphTransition = Readonly<{
  readonly addedDomainIds: readonly string[];
  readonly removedDomainIds: readonly string[];
  readonly retainedDomainIds: readonly string[];
  readonly refreshDomainIds: readonly string[];
  readonly humansLosingFinalAccess: readonly string[];
}>;

export type AgentRuntimeAuthorizationGraphPlan =
  | Readonly<{
    readonly status: "ready";
    readonly transition: AgentRuntimeAuthorizationGraphTransition;
    readonly authorizationPlan: AgentRuntimeAuthorizationPlan;
    readonly authorizationTransitionPlan:
      AgentRuntimeAuthorizationTransitionPlan | null;
  }>
  | Readonly<{
    readonly status: "pending";
    readonly reason:
      | "manager_unavailable"
      | "domain_committer_unavailable";
    readonly transition: AgentRuntimeAuthorizationGraphTransition;
    readonly unavailableDomainIds: readonly string[];
  }>;

type ValidatedDomain = Readonly<{
  readonly domainId: ReturnType<typeof cryptoDomainId>;
  readonly domainEpoch: ReturnType<typeof domainEpoch>;
  readonly agentAuthorizationRevision:
    ReturnType<typeof authorizationRevision>;
  readonly committerDeviceId: ReturnType<typeof cryptoDeviceId>;
  readonly committerAvailable: boolean;
}>;

type ValidatedSnapshot = Readonly<{
  readonly managementHumanIds: readonly string[];
  readonly namespaceEdges:
    readonly AgentRuntimeAuthorizationNamespaceEdge[];
  readonly domainAuthorities: ReadonlyMap<string, ValidatedDomain>;
  readonly domainIds: readonly string[];
  readonly authorizedHumanIds: readonly string[];
}>;

const encoder = new TextEncoder();

function comparePortableText(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const width = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < width; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function exactFields(
  label: string,
  value: object,
  fields: readonly string[],
): void {
  if (
    Object.keys(value).sort().join("\0")
      !== [...fields].sort().join("\0")
  ) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function portableText(value: unknown, label: string): string {
  if (!portableIdIsValid(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function canonicalText(
  value: unknown,
  label: string,
  maximum: number,
  normalize: (value: string) => string = (item) => item,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const result = value.map((item) =>
    normalize(portableText(item, label))
  );
  if (
    result.some((item, index) =>
      index > 0
      && comparePortableText(result[index - 1]!, item) >= 0
    )
  ) {
    throw new TypeError(`${label} must be sorted and unique`);
  }
  return Object.freeze(result);
}

function validateSnapshot(
  value: AgentRuntimeAuthorizationGraphSnapshot,
  label: string,
): ValidatedSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${label} must be an object`);
  }
  exactFields(label, value, [
    "managementHumanIds",
    "namespaceEdges",
    "domainAuthorities",
  ]);
  const managementHumanIds = canonicalText(
    value.managementHumanIds,
    `${label} management Humans`,
    LATTICE_LIMITS.humanParticipantsPerDomain,
    (value) => humanId(value),
  );
  if (
    !Array.isArray(value.namespaceEdges)
    || value.namespaceEdges.length
      > LATTICE_LIMITS.namespacesPerDomainTransition
  ) {
    throw new TypeError(`${label} Namespace edges must be bounded`);
  }
  const rawNamespaceEdges: readonly unknown[] = value.namespaceEdges;
  const namespaceEdges =
    rawNamespaceEdges.map((raw) => {
      if (typeof raw !== "object" || raw === null) {
        throw new TypeError(`${label} Namespace edge is invalid`);
      }
      exactFields(`${label} Namespace edge`, raw, [
        "namespaceId",
        "domainId",
        "authorizedHumanIds",
      ]);
      const value =
        raw as AgentRuntimeAuthorizationNamespaceEdge;
      return Object.freeze({
        namespaceId:
          namespaceId(
            portableText(value.namespaceId, `${label} Namespace id`),
          ),
        domainId: cryptoDomainId(
          portableText(value.domainId, `${label} Domain id`),
        ),
        authorizedHumanIds: canonicalText(
          value.authorizedHumanIds,
          `${label} Namespace Humans`,
          LATTICE_LIMITS.humanParticipantsPerDomain,
          (value) => humanId(value),
        ),
      });
    });
  if (
    namespaceEdges.some((edge, index) =>
      index > 0
      && comparePortableText(
        namespaceEdges[index - 1]!.namespaceId,
        edge.namespaceId,
      ) >= 0
    )
  ) {
    throw new TypeError(
      `${label} Namespace edges must be sorted and unique`,
    );
  }
  if (
    !Array.isArray(value.domainAuthorities)
    || value.domainAuthorities.length
      > LATTICE_LIMITS.agentGrantDomains
  ) {
    throw new TypeError(`${label} Domain authorities must be bounded`);
  }
  const rawDomainAuthorities: readonly unknown[] =
    value.domainAuthorities;
  const domains = rawDomainAuthorities.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new TypeError(`${label} Domain authority is invalid`);
    }
    exactFields(`${label} Domain authority`, raw, [
      "domainId",
      "domainEpoch",
      "agentAuthorizationRevision",
      "committerDeviceId",
      "committerAvailable",
    ]);
    const value =
      raw as AgentRuntimeAuthorizationDomainAuthority;
    if (typeof value.committerAvailable !== "boolean") {
      throw new TypeError(`${label} committer availability is invalid`);
    }
    return Object.freeze({
      domainId:
        cryptoDomainId(portableText(value.domainId, `${label} Domain id`)),
      domainEpoch: domainEpoch(value.domainEpoch),
      agentAuthorizationRevision:
        authorizationRevision(value.agentAuthorizationRevision),
      committerDeviceId:
        cryptoDeviceId(
          portableText(
            value.committerDeviceId,
            `${label} committer device id`,
          ),
        ),
      committerAvailable: value.committerAvailable,
    });
  });
  if (
    domains.some((domain, index) =>
      index > 0
      && comparePortableText(
        domains[index - 1]!.domainId,
        domain.domainId,
      ) >= 0
    )
  ) {
    throw new TypeError(
      `${label} Domain authorities must be sorted and unique`,
    );
  }
  const domainAuthorities = new Map<string, ValidatedDomain>(
    domains.map((domain) => [domain.domainId, domain]),
  );
  const domainIds =
    [...new Set(namespaceEdges.map((edge) => edge.domainId))]
      .sort(comparePortableText);
  if (
    domainIds.some((domainId) => !domainAuthorities.has(domainId))
    || domains.some((domain) => !domainIds.includes(domain.domainId))
  ) {
    throw new Error(
      `${label} Domain authorities must exactly cover Namespace Domains`,
    );
  }
  const authorizedHumanIds = [...new Set([
    ...managementHumanIds,
    ...namespaceEdges.flatMap((edge) => edge.authorizedHumanIds),
  ])].sort(comparePortableText);
  return Object.freeze({
    managementHumanIds,
    namespaceEdges: Object.freeze(namespaceEdges),
    domainAuthorities,
    domainIds: Object.freeze(domainIds),
    authorizedHumanIds: Object.freeze(authorizedHumanIds),
  });
}

function difference(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const rightValues = new Set(right);
  return Object.freeze(left.filter((value) => !rightValues.has(value)));
}

function intersection(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const rightValues = new Set(right);
  return Object.freeze(left.filter((value) => rightValues.has(value)));
}

function domainHeadChanged(
  current: ValidatedSnapshot,
  next: ValidatedSnapshot,
  domainId: string,
): boolean {
  const left = current.domainAuthorities.get(domainId);
  const right = next.domainAuthorities.get(domainId);
  return left === undefined
    || right === undefined
    || left.domainEpoch !== right.domainEpoch
    || left.agentAuthorizationRevision
      !== right.agentAuthorizationRevision
    || left.committerDeviceId !== right.committerDeviceId;
}

function snapshotInventory(
  value: AgentRuntimeAuthorizationPlan["activeConfigInventory"],
): AgentRuntimeAuthorizationPlan["activeConfigInventory"] {
  if (
    typeof value !== "object"
    || value === null
    || !Number.isSafeInteger(value.objectCount)
    || value.objectCount < 0
    || value.objectCount > LATTICE_LIMITS.batchItems
    || !(value.digest instanceof Uint8Array)
    || value.digest.length !== 32
  ) {
    throw new TypeError("Active Runtime config inventory is invalid");
  }
  exactFields("Active Runtime config inventory", value, [
    "objectCount",
    "digest",
  ]);
  return Object.freeze({
    objectCount: value.objectCount,
    digest: value.digest.slice(),
  });
}

/**
 * Translate injected canonical product authorization facts into the exact
 * Domain-deduplicated plan consumed by the supported crypto coordinator.
 * This function never queries product tables or infers membership itself.
 */
export function planAgentRuntimeAuthorizationGraphTransition(
  input: Readonly<{
    readonly operationId: string;
    readonly agentId: string;
    readonly oldAuthorizationRevision: number;
    readonly newAuthorizationRevision: number;
    readonly currentRuntimeGeneration: number;
    readonly currentManager: AgentRuntimeRotationManager | null;
    readonly currentManagerAvailable: boolean;
    readonly activeConfigInventory:
      AgentRuntimeAuthorizationPlan["activeConfigInventory"];
    readonly current: AgentRuntimeAuthorizationGraphSnapshot;
    readonly next: AgentRuntimeAuthorizationGraphSnapshot;
  }>,
): AgentRuntimeAuthorizationGraphPlan {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Agent Runtime authorization graph input is invalid");
  }
  exactFields("Agent Runtime authorization graph input", input, [
    "operationId",
    "agentId",
    "oldAuthorizationRevision",
    "newAuthorizationRevision",
    "currentRuntimeGeneration",
    "currentManager",
    "currentManagerAvailable",
    "activeConfigInventory",
    "current",
    "next",
  ]);
  if (typeof input.currentManagerAvailable !== "boolean") {
    throw new TypeError("Current Runtime manager availability is invalid");
  }
  const current = validateSnapshot(input.current, "Current graph");
  const next = validateSnapshot(input.next, "Next graph");
  const humansLosingFinalAccess = difference(
    current.authorizedHumanIds,
    next.authorizedHumanIds,
  );
  const addedDomainIds = difference(next.domainIds, current.domainIds);
  const removedDomainIds = difference(current.domainIds, next.domainIds);
  const retainedDomainIds = intersection(current.domainIds, next.domainIds);
  const runtimeRotationRequired = humansLosingFinalAccess.length > 0;
  const refreshDomainIds = Object.freeze(
    (
      runtimeRotationRequired
        ? [...next.domainIds]
        : next.domainIds.filter((domainId) =>
          addedDomainIds.includes(domainId)
          || domainHeadChanged(current, next, domainId)
        )
    ).sort(comparePortableText),
  );
  const transition = Object.freeze({
    addedDomainIds,
    removedDomainIds,
    retainedDomainIds,
    refreshDomainIds,
    humansLosingFinalAccess,
  });

  if (
    input.currentManager === null
    || input.currentManagerAvailable === false
  ) {
    return Object.freeze({
      status: "pending",
      reason: "manager_unavailable",
      transition,
      unavailableDomainIds: Object.freeze([]),
    });
  }
  const unavailableDomainIds = refreshDomainIds.filter((domainId) =>
    next.domainAuthorities.get(domainId)?.committerAvailable !== true
  );
  if (unavailableDomainIds.length > 0) {
    return Object.freeze({
      status: "pending",
      reason: "domain_committer_unavailable",
      transition,
      unavailableDomainIds: Object.freeze(unavailableDomainIds),
    });
  }

  const remainingDomains =
    next.domainIds.map((domainId) => {
      const domain = next.domainAuthorities.get(domainId)!;
      return Object.freeze({
        domainId: domain.domainId,
        domainEpoch: domain.domainEpoch,
        agentAuthorizationRevision: domain.agentAuthorizationRevision,
        committerDeviceId: domain.committerDeviceId,
      });
    });
  const operationId =
    portableText(input.operationId, "Runtime transition operation id");
  const targetAgentId = agentId(input.agentId);
  const oldAuthorizationRevision =
    authorizationRevision(input.oldAuthorizationRevision);
  const newAuthorizationRevision =
    authorizationRevision(input.newAuthorizationRevision);
  const currentRuntimeGeneration =
    agentRuntimeGeneration(input.currentRuntimeGeneration);
  const currentManager = Object.freeze({
    managerHumanId: humanId(input.currentManager.managerHumanId),
    managerAuthorizationRevision:
      authorizationRevision(
        input.currentManager.managerAuthorizationRevision,
      ),
    managerDeviceId:
      cryptoDeviceId(input.currentManager.managerDeviceId),
  });
  const activeConfigInventory =
    snapshotInventory(input.activeConfigInventory);
  const authorizationPlan: AgentRuntimeAuthorizationPlan = Object.freeze({
    operationId,
    agentId: targetAgentId,
    oldAuthorizationRevision,
    newAuthorizationRevision,
    currentRuntimeGeneration,
    runtimeRotationRequired,
    currentManager,
    activeConfigInventory,
    remainingDomains: Object.freeze(remainingDomains),
  });
  const currentDomains = current.domainIds.map((domainId) => {
    const domain = current.domainAuthorities.get(domainId)!;
    return Object.freeze({
      domainId: domain.domainId,
      domainEpoch: domain.domainEpoch,
      agentAuthorizationRevision: domain.agentAuthorizationRevision,
      committerDeviceId: domain.committerDeviceId,
    });
  });
  const authorizationTransitionPlan:
    AgentRuntimeAuthorizationTransitionPlan | null =
      runtimeRotationRequired
        ? null
        : Object.freeze({
          operationId,
          agentId: targetAgentId,
          oldAuthorizationRevision,
          newAuthorizationRevision,
          currentRuntimeGeneration,
          currentManager,
          activeConfigInventory,
          currentDomains: Object.freeze(currentDomains),
          remainingDomains: Object.freeze(remainingDomains),
          refreshedDomainIds: refreshDomainIds,
        });
  return Object.freeze({
    status: "ready",
    transition,
    authorizationPlan,
    authorizationTransitionPlan,
  });
}
