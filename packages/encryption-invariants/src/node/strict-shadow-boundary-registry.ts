import { BACKGROUND_ENCRYPTION_SURFACES } from
  "./background-encryption-inventory.ts";
import { CONVERSATION_ENCRYPTION_SURFACES } from
  "./conversation-encryption-inventory.ts";
import { MEMORY_ENCRYPTION_SURFACES } from
  "./memory-encryption-inventory.ts";

export type StrictShadowBoundaryReadiness =
  | "protected"
  | "unsupported"
  | "unexercised";

export type RegisteredStrictShadowBoundary = Readonly<{
  id: string;
  family: string;
  operation: string;
  actorClass: "human" | "agent" | "conductor" | "tool" | "background";
  readiness: StrictShadowBoundaryReadiness;
}>;

function operation(id: string): string {
  if (id.includes("write") || id.includes("publish") || id.includes("manage")) {
    return "write";
  }
  if (id.includes("invoke") || id.includes("model")) return "invoke";
  if (id.includes("search")) return "search";
  if (id.includes("read") || id.includes("history")) return "read";
  return "process";
}

function backgroundFamily(id: string): string {
  if (id.startsWith("stenographer.")) return "record";
  if (id.startsWith("memory.")) return "memory";
  if (id.startsWith("task.") || id.startsWith("job.")) return "task";
  return "message";
}

function conversationReadiness(
  surface: typeof CONVERSATION_ENCRYPTION_SURFACES[number],
): StrictShadowBoundaryReadiness {
  if (
    surface.ownership === "disabled_legacy"
    || surface.ownership === "wave10_background"
    || surface.ownership === "wave12_autonomous"
    || surface.ownership === "wave14_mobile"
    || surface.requiredDuties.some((duty: string) => duty === "fts_unavailable")
  ) return "unsupported";
  return "protected";
}

/**
 * Static, content-free PR1 activation inventory. Runtime observations may
 * advance an unexercised entry, but cannot add or rename boundaries.
 */
export const STRICT_SHADOW_BOUNDARY_REGISTRY = Object.freeze([
  Object.freeze({
    // Bounded sink for a caller that reaches Strict enforcement without a
    // reviewed coordinate. Persisting the caller-supplied ID would turn a
    // fixed-cardinality health table into an attacker-controlled event log.
    id: "system.unknown_boundary",
    family: "unknown",
    operation: "unknown",
    actorClass: "background" as const,
    readiness: "unsupported" as const,
  }),
  Object.freeze({
    id: "artifact.api.workspace",
    family: "artifact",
    operation: "process",
    actorClass: "human" as const,
    readiness: "unsupported" as const,
  }),
  Object.freeze({
    id: "record.foreground.recall",
    family: "record",
    operation: "read",
    actorClass: "agent" as const,
    readiness: "unsupported" as const,
  }),
  Object.freeze({
    id: "conversation.read.foreground_journal",
    family: "record",
    operation: "read",
    actorClass: "agent" as const,
    readiness: "protected" as const,
  }),
  Object.freeze({
    id: "conversation.read.foreground_records",
    family: "record",
    operation: "read",
    actorClass: "agent" as const,
    readiness: "protected" as const,
  }),
  Object.freeze({
    id: "conversation.read.foreground_memory",
    family: "memory",
    operation: "read",
    actorClass: "agent" as const,
    readiness: "protected" as const,
  }),
  Object.freeze({
    id: "conversation.write.foreground_checkpoint",
    family: "checkpoint",
    operation: "write",
    actorClass: "agent" as const,
    readiness: "protected" as const,
  }),
  ...CONVERSATION_ENCRYPTION_SURFACES.map((surface) => Object.freeze({
    id: `conversation.${surface.id}`,
    family: "message",
    operation: operation(surface.id),
    actorClass: surface.id === "read.foreground_history"
      ? "agent" as const
      : surface.id.includes("conductor")
      ? "conductor" as const
      : surface.id.includes("tool")
      ? "tool" as const
      : surface.ownership === "wave10_background"
      || surface.ownership === "wave12_autonomous"
      ? "background" as const
      : "human" as const,
    readiness: conversationReadiness(surface),
  })),
  ...BACKGROUND_ENCRYPTION_SURFACES.map((surface) => Object.freeze({
    id: `background.${surface.id}`,
    family: backgroundFamily(surface.id),
    operation: operation(surface.id),
    actorClass: "background" as const,
    // PR1 gates these roots before plaintext work. Existing protected Memory
    // entrypoints are classified independently below; the generic background
    // surfaces remain unavailable under Strict until their own verticals ship.
    readiness: "unsupported" as const,
  })),
  ...MEMORY_ENCRYPTION_SURFACES.map((surface) => Object.freeze({
    id: surface.id,
    family: "memory",
    operation: operation(surface.id),
    actorClass: surface.boundary === "agent_tool"
      ? "tool" as const
      : surface.boundary === "background"
      ? "background" as const
      : "human" as const,
    readiness: surface.implementationState === "protected"
      ? "protected" as const
      : "unsupported" as const,
  })),
] satisfies readonly RegisteredStrictShadowBoundary[]);

export function strictShadowCoveragePreview(): Readonly<{
  protected: number;
  unsupported: number;
  unexercised: number;
}> {
  let protectedCount = 0;
  let unsupported = 0;
  let unexercised = 0;
  for (const boundary of STRICT_SHADOW_BOUNDARY_REGISTRY) {
    if (boundary.readiness === "protected") protectedCount++;
    else if (boundary.readiness === "unsupported") unsupported++;
    else unexercised++;
  }
  return Object.freeze({
    protected: protectedCount,
    unsupported,
    unexercised,
  });
}

export type StrictShadowObservedBoundaryHealth = Readonly<{
  policyRevision: number;
  boundaryId: string;
  family: string;
  operation: string;
  actorClass: RegisteredStrictShadowBoundary["actorClass"];
  state:
    | "verified"
    | "waiting_for_authority"
    | "repairing"
    | "unsupported"
    | "failed";
  reason: string;
  occurrenceCount: bigint;
  lastObservedAt: Date;
}>;

/** Merge bounded current observations onto the immutable reviewed registry. */
export function strictShadowRuntimeHealthProjection(
  policyRevision: number,
  observations: readonly StrictShadowObservedBoundaryHealth[],
): Readonly<{
  policyRevision: number;
  verified: number;
  waitingForAuthority: number;
  repairing: number;
  unsupported: number;
  failed: number;
  unexercised: number;
  lastObservedAt: Date | null;
  summaries: readonly Readonly<{
    boundaryId: string;
    family: string;
    operation: string;
    actorClass: RegisteredStrictShadowBoundary["actorClass"];
    state: StrictShadowObservedBoundaryHealth["state"] | "unexercised";
    reason: string;
    occurrenceCount: bigint;
    lastObservedAt: Date | null;
  }>[];
}> {
  const registry = new Map(
    STRICT_SHADOW_BOUNDARY_REGISTRY.map((boundary) => [boundary.id, boundary]),
  );
  const latest = new Map<string, StrictShadowObservedBoundaryHealth>();
  for (const observation of observations) {
    const boundary = registry.get(observation.boundaryId);
    if (
      observation.policyRevision !== policyRevision
      || boundary === undefined
      || boundary.family !== observation.family
      || boundary.operation !== observation.operation
      || boundary.actorClass !== observation.actorClass
    ) continue;
    latest.set(observation.boundaryId, observation);
  }
  const counts = {
    verified: 0,
    waitingForAuthority: 0,
    repairing: 0,
    unsupported: 0,
    failed: 0,
    unexercised: 0,
  };
  let lastObservedAt: Date | null = null;
  const summaries = STRICT_SHADOW_BOUNDARY_REGISTRY.map((boundary) => {
    const observed = latest.get(boundary.id);
    if (observed === undefined) {
      counts.unexercised++;
      return Object.freeze({
        boundaryId: boundary.id,
        family: boundary.family,
        operation: boundary.operation,
        actorClass: boundary.actorClass,
        state: "unexercised" as const,
        reason: "not_observed",
        occurrenceCount: 0n,
        lastObservedAt: null,
      });
    }
    if (observed.state === "waiting_for_authority") {
      counts.waitingForAuthority++;
    } else {
      counts[observed.state]++;
    }
    if (lastObservedAt === null || observed.lastObservedAt > lastObservedAt) {
      lastObservedAt = observed.lastObservedAt;
    }
    return Object.freeze({
      boundaryId: boundary.id,
      family: boundary.family,
      operation: boundary.operation,
      actorClass: boundary.actorClass,
      state: observed.state,
      reason: observed.reason,
      occurrenceCount: observed.occurrenceCount,
      lastObservedAt: observed.lastObservedAt,
    });
  });
  return Object.freeze({
    policyRevision,
    ...counts,
    lastObservedAt,
    summaries: Object.freeze(summaries),
  });
}
