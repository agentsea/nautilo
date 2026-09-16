import { randomUUID } from "node:crypto";
import { HERMES_ACP_READINESS_TIMEOUT_MS, type TaskCreateInput } from "@nautilo/runtime";
import {
  ACP_RELAY_MAX_OPAQUE_ID_BYTES,
  ACP_RELAY_PROTOCOL_VERSION,
  type AcpReadinessState,
} from "@nautilo/relay";
import type { CodexCanonicalFactsReader } from "../codex/canonical-facts";

/** Server-authored only, after all local admission checks have passed. */
export const HERMES_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR = Object.freeze({
  version: 1 as const,
  harnessId: "hermes-acp" as const,
  source: "genie" as const,
});

export type HermesAcpHarnessTaskFailureCode =
  | "ACP_HARNESS_UNAVAILABLE"
  | "ACP_SOURCE_FORBIDDEN"
  | "ACP_ROOM_UNAVAILABLE";

/** Bounded error vocabulary: relay and host details never cross this seam. */
class HermesAcpHarnessTaskFailure extends Error {
  constructor(readonly code: HermesAcpHarnessTaskFailureCode) {
    super(code);
    this.name = "HermesAcpHarnessTaskFailure";
  }
}

export interface HermesAcpHarnessTaskRelayPort {
  listConnected(): Promise<string[]>;
  getAcpSession(relayId: string, userId?: string): HermesAcpSessionSnapshot | null;
  requestAcpReadiness(input: {
    readonly relayId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly registrationId: "hermes-acp";
    readonly timeoutMs?: number;
  }): Promise<AcpReadinessState>;
}

/** Minimum authenticated registry snapshot needed for sealed readiness facts. */
export interface HermesAcpSessionSnapshot {
  readonly relayId: string;
  readonly userId: string;
  readonly relaySessionId: string;
  readonly pairingGenerationRef: string;
  readonly desktopSessionId: string;
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
}

export interface HermesAcpHarnessTaskDeps {
  /** The existing server-owned owner/Agent/current-Room facts. */
  readonly facts: Pick<CodexCanonicalFactsReader, "getAgentOwner" | "roomExists" | "isAgentMember">;
  readonly relay: HermesAcpHarnessTaskRelayPort;
  readonly createTask: (input: TaskCreateInput) => Promise<{
    readonly taskId: string;
    readonly status: "pending" | "running" | "awaiting" | "paused" | "completed" | "cancelled" | "errored";
  }>;
  /** Test seam only; production uses an opaque random correlation id. */
  readonly mintRequestId?: () => string;
}

/** Positive allowlist for the only caller facts Hermes admission needs. */
export interface CreateHermesAcpHarnessTaskInput {
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly callingRoomId: string | null;
  /** Canonical nested lineage from the trusted Task dispatcher. */
  readonly parentTaskId?: string;
  /** Derived from the same canonical parent as parentTaskId. */
  readonly depth?: number;
  readonly harness: "hermes-acp";
}

export interface CreateHermesAcpHarnessTaskResult {
  readonly taskId: string;
  readonly status: "pending" | "running" | "awaiting" | "paused" | "completed" | "cancelled" | "errored";
  readonly execution: "hermes-acp";
}

/**
 * Admission-only Hermes Task creation. It deliberately does not prepare,
 * start, prompt, subscribe, or register a Task execution route; Slice C owns
 * that execution protocol. This seam only persists the exact readiness proof
 * used to admit a server-authored ordinary Task.
 */
export async function createHermesAcpHarnessTask(
  deps: HermesAcpHarnessTaskDeps,
  input: CreateHermesAcpHarnessTaskInput,
): Promise<CreateHermesAcpHarnessTaskResult> {
  // Capture exactly the runtime-validated Hermes facts before any await. A
  // mutable JavaScript caller cannot alter the authority, prompt, or sealed
  // Task fields while readiness is in flight.
  const snapshot = snapshotHermesInput(input);
  const readiness = await resolveAdmission(deps, snapshot).catch(normalizeAdmissionFailure);
  const roomId = snapshot.callingRoomId;
  if (!roomId) throw new HermesAcpHarnessTaskFailure("ACP_ROOM_UNAVAILABLE");

  const created = await deps.createTask({
    ownerId: snapshot.ownerId,
    requestorId: snapshot.requestorId,
    agentId: snapshot.agentId,
    prompt: snapshot.prompt,
    scheduleKind: "now",
    targetChat: "last_in_namespace",
    targetRoomId: roomId,
    callingRoomId: roomId,
    targetUserIds: [snapshot.ownerId],
    toolsMode: "none",
    toolsWhitelist: [],
    resultDelivery: "raw_and_wake",
    ...(snapshot.parentTaskId === undefined
      ? {}
      : { parentTaskId: snapshot.parentTaskId, depth: snapshot.depth }),
    requestedModelId: null,
    metadata: {
      execution: {
        ...HERMES_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR,
        readiness,
      },
    },
  });
  return { ...created, execution: "hermes-acp" };
}

function normalizeAdmissionFailure(error: unknown): never {
  if (error instanceof HermesAcpHarnessTaskFailure) throw error;
  throw new HermesAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
}

type HermesAcpReadinessReceipt = Readonly<{
  relayId: string;
  relaySessionId: string;
  pairingGenerationRef: string;
  desktopSessionId: string;
  selectedProtocolVersion: number;
  capabilityRevision: number;
}>;

type HermesAcpHarnessTaskSnapshot = Readonly<{
  readonly harness: "hermes-acp";
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly callingRoomId: string | null;
  readonly parentTaskId?: string;
  readonly depth?: number;
}>;

/** Runtime boundary for direct/malformed JavaScript callers. It is intentionally
 * narrow: all other properties are ignored and never reach the Task write. */
function snapshotHermesInput(input: CreateHermesAcpHarnessTaskInput): HermesAcpHarnessTaskSnapshot {
  const candidate = input as unknown;
  if (!isRecord(candidate) || candidate["harness"] !== "hermes-acp") {
    throw new HermesAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  }
  if (
    typeof candidate["ownerId"] !== "string"
    || typeof candidate["requestorId"] !== "string"
    || typeof candidate["agentId"] !== "string"
    || typeof candidate["prompt"] !== "string"
    || (candidate["callingRoomId"] !== null && typeof candidate["callingRoomId"] !== "string")
    || (candidate["parentTaskId"] !== undefined && typeof candidate["parentTaskId"] !== "string")
    || (candidate["depth"] !== undefined
      && (!Number.isSafeInteger(candidate["depth"]) || (candidate["depth"] as number) < 0))
    || (candidate["parentTaskId"] === undefined) !== (candidate["depth"] === undefined)
  ) {
    throw new HermesAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  }
  return Object.freeze({
    harness: "hermes-acp",
    ownerId: candidate["ownerId"],
    requestorId: candidate["requestorId"],
    agentId: candidate["agentId"],
    prompt: candidate["prompt"],
    callingRoomId: candidate["callingRoomId"],
    ...(candidate["parentTaskId"] === undefined
      ? {}
      : {
          parentTaskId: candidate["parentTaskId"],
          depth: candidate["depth"] as number,
        }),
  });
}

async function resolveAdmission(
  deps: HermesAcpHarnessTaskDeps,
  input: HermesAcpHarnessTaskSnapshot,
): Promise<HermesAcpReadinessReceipt> {
  // This is independent of the Agent/Room relationship: a delegated or
  // otherwise substituted requestor must not enumerate or probe the owner's
  // Desktop relay, and must never create a Task.
  if (input.requestorId !== input.ownerId) {
    throw new HermesAcpHarnessTaskFailure("ACP_SOURCE_FORBIDDEN");
  }
  const roomId = input.callingRoomId;
  if (!roomId || !(await deps.facts.roomExists(roomId))) {
    throw new HermesAcpHarnessTaskFailure("ACP_ROOM_UNAVAILABLE");
  }
  const [agentOwner, agentMember] = await Promise.all([
    deps.facts.getAgentOwner(input.agentId),
    deps.facts.isAgentMember(roomId, input.agentId),
  ]);
  if (agentOwner !== input.ownerId || !agentMember) {
    throw new HermesAcpHarnessTaskFailure("ACP_SOURCE_FORBIDDEN");
  }

  const candidates = (await deps.relay.listConnected())
    .map((relayId) => ({ relayId, session: deps.relay.getAcpSession(relayId, input.ownerId) }))
    .map(({ relayId, session }) =>
      session !== null && session.relayId === relayId ? session : null,
    )
    .filter((session): session is HermesAcpSessionSnapshot =>
      session !== null
      && session.userId === input.ownerId
      && isSafeSessionSnapshot(session),
    );
  if (candidates.length !== 1) {
    throw new HermesAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  }
  const selected = candidates[0]!;
  const state = await Promise.resolve().then(() => deps.relay.requestAcpReadiness({
    relayId: selected.relayId,
    userId: input.ownerId,
    requestId: (deps.mintRequestId ?? randomUUID)(),
    registrationId: "hermes-acp",
    timeoutMs: HERMES_ACP_READINESS_TIMEOUT_MS,
  })).catch(() => {
    throw new HermesAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  });
  if (state !== "ready") {
    throw new HermesAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  }

  // A readiness answer has meaning only for the same authenticated v14 socket
  // generation and capability revision selected above.
  const current = deps.relay.getAcpSession(selected.relayId, input.ownerId);
  if (!sameSession(current, selected)) {
    throw new HermesAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  }
  return {
    relayId: selected.relayId,
    relaySessionId: selected.relaySessionId,
    pairingGenerationRef: selected.pairingGenerationRef,
    desktopSessionId: selected.desktopSessionId,
    selectedProtocolVersion: selected.selectedProtocolVersion,
    capabilityRevision: selected.capabilityRevision,
  };
}

/** The relay registry is trusted in production, but this persisted receipt is
 * still bounded at the admission seam so malformed test/adapter data cannot
 * turn into unbounded or raw metadata. */
function isSafeSessionSnapshot(session: HermesAcpSessionSnapshot): boolean {
  return session.selectedProtocolVersion >= ACP_RELAY_PROTOCOL_VERSION
    && Number.isSafeInteger(session.selectedProtocolVersion)
    && Number.isSafeInteger(session.capabilityRevision)
    && session.capabilityRevision >= 0
    && isSafeOpaqueId(session.relayId)
    && isSafeOpaqueId(session.relaySessionId)
    && isSafeOpaqueId(session.desktopSessionId)
    && isSafeOpaqueId(session.pairingGenerationRef);
}

function isSafeOpaqueId(value: string): boolean {
  return value.length > 0
    && !value.includes("\0")
    && new TextEncoder().encode(value).byteLength <= ACP_RELAY_MAX_OPAQUE_ID_BYTES;
}

function sameSession(
  current: HermesAcpSessionSnapshot | null,
  selected: HermesAcpSessionSnapshot,
): boolean {
  return current !== null
    && current.relayId === selected.relayId
    && current.userId === selected.userId
    && current.relaySessionId === selected.relaySessionId
    && current.desktopSessionId === selected.desktopSessionId
    && current.pairingGenerationRef === selected.pairingGenerationRef
    && current.selectedProtocolVersion === selected.selectedProtocolVersion
    && current.capabilityRevision === selected.capabilityRevision;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
