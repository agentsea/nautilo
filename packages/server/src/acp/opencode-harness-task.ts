import { randomUUID } from "node:crypto";
import type { TaskCreateInput } from "@nautilo/runtime";
import {
  ACP_RELAY_MAX_OPAQUE_ID_BYTES,
  OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
  type AcpReadinessState,
} from "@nautilo/relay";
import type { CodexCanonicalFactsReader } from "../codex/canonical-facts";

export const OPENCODE_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR = Object.freeze({
  version: 1 as const,
  harnessId: "opencode-acp" as const,
  source: "genie" as const,
});

export type OpenCodeAcpExecutionProfile = "interactive" | "autonomous" | "plan";
export type OpenCodeAcpHarnessTaskFailureCode =
  | "ACP_HARNESS_UNAVAILABLE"
  | "ACP_SOURCE_FORBIDDEN"
  | "ACP_ROOM_UNAVAILABLE";

class OpenCodeAcpHarnessTaskFailure extends Error {
  constructor(readonly code: OpenCodeAcpHarnessTaskFailureCode) {
    super(code);
    this.name = "OpenCodeAcpHarnessTaskFailure";
  }
}

export interface OpenCodeAcpSessionSnapshot {
  readonly relayId: string;
  readonly userId: string;
  readonly relaySessionId: string;
  readonly pairingGenerationRef: string;
  readonly desktopSessionId: string;
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
}

export interface OpenCodeAcpHarnessTaskRelayPort {
  listConnected(): Promise<string[]>;
  getAcpSessionForRegistration(
    relayId: string,
    userId: string,
    registrationId: "opencode-acp",
  ): OpenCodeAcpSessionSnapshot | null;
  requestAcpReadiness(input: {
    readonly relayId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly registrationId: "opencode-acp";
    readonly timeoutMs?: number;
  }): Promise<AcpReadinessState>;
}

export interface OpenCodeAcpHarnessTaskDeps {
  readonly facts: Pick<CodexCanonicalFactsReader, "getAgentOwner" | "roomExists" | "isAgentMember">;
  readonly relay: OpenCodeAcpHarnessTaskRelayPort;
  readonly createTask: (input: TaskCreateInput) => Promise<{
    readonly taskId: string;
    readonly status: "pending" | "running" | "awaiting" | "paused" | "completed" | "cancelled" | "errored";
  }>;
  readonly mintRequestId?: () => string;
}

export interface CreateOpenCodeAcpHarnessTaskInput {
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly callingRoomId: string | null;
  readonly harness: "opencode-acp";
  readonly executionProfile: OpenCodeAcpExecutionProfile;
}

export interface CreateOpenCodeAcpHarnessTaskResult {
  readonly taskId: string;
  readonly status: "pending" | "running" | "awaiting" | "paused" | "completed" | "cancelled" | "errored";
  readonly execution: "opencode-acp";
}

/** Admission only. Execution, ACP prompts, permission exchange, and process
 * containment remain unavailable until the compatibility vertical lands. */
export async function createOpenCodeAcpHarnessTask(
  deps: OpenCodeAcpHarnessTaskDeps,
  input: CreateOpenCodeAcpHarnessTaskInput,
): Promise<CreateOpenCodeAcpHarnessTaskResult> {
  const snapshot = snapshotInput(input);
  const readiness = await resolveAdmission(deps, snapshot).catch(normalizeFailure);
  if (!snapshot.callingRoomId) throw new OpenCodeAcpHarnessTaskFailure("ACP_ROOM_UNAVAILABLE");

  const created = await deps.createTask({
    ownerId: snapshot.ownerId,
    requestorId: snapshot.requestorId,
    agentId: snapshot.agentId,
    prompt: snapshot.prompt,
    scheduleKind: "now",
    targetChat: "last_in_namespace",
    targetRoomId: snapshot.callingRoomId,
    callingRoomId: snapshot.callingRoomId,
    targetUserIds: [snapshot.ownerId],
    toolsMode: "none",
    toolsWhitelist: [],
    resultDelivery: "raw_and_wake",
    requestedModelId: null,
    metadata: {
      execution: {
        ...OPENCODE_ACP_HARNESS_TASK_EXECUTION_DESCRIPTOR,
        executionProfile: snapshot.executionProfile,
        readiness,
      },
    },
  }).catch(normalizeFailure);
  return { ...created, execution: "opencode-acp" };
}

type OpenCodeAcpHarnessTaskSnapshot = Readonly<CreateOpenCodeAcpHarnessTaskInput>;
type OpenCodeAcpReadinessReceipt = Readonly<{
  relayId: string;
  relaySessionId: string;
  pairingGenerationRef: string;
  desktopSessionId: string;
  selectedProtocolVersion: number;
  capabilityRevision: number;
}>;

const INPUT_KEYS = Object.freeze([
  "agentId",
  "callingRoomId",
  "executionProfile",
  "harness",
  "ownerId",
  "prompt",
  "requestorId",
]);

function snapshotInput(input: CreateOpenCodeAcpHarnessTaskInput): OpenCodeAcpHarnessTaskSnapshot {
  const candidate = input as unknown;
  if (!isRecord(candidate) || !hasExactKeys(candidate, INPUT_KEYS)
    || candidate["harness"] !== "opencode-acp"
    || typeof candidate["ownerId"] !== "string"
    || typeof candidate["requestorId"] !== "string"
    || typeof candidate["agentId"] !== "string"
    || typeof candidate["prompt"] !== "string"
    || (candidate["callingRoomId"] !== null && typeof candidate["callingRoomId"] !== "string")
    || !isExecutionProfile(candidate["executionProfile"])) {
    throw new OpenCodeAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  }
  return Object.freeze({
    ownerId: candidate["ownerId"],
    requestorId: candidate["requestorId"],
    agentId: candidate["agentId"],
    prompt: candidate["prompt"],
    callingRoomId: candidate["callingRoomId"],
    harness: "opencode-acp",
    executionProfile: candidate["executionProfile"],
  });
}

async function resolveAdmission(
  deps: OpenCodeAcpHarnessTaskDeps,
  input: OpenCodeAcpHarnessTaskSnapshot,
): Promise<OpenCodeAcpReadinessReceipt> {
  await assertAuthority(deps, input);

  const candidates = (await deps.relay.listConnected())
    .map((relayId) => ({
      relayId,
      session: deps.relay.getAcpSessionForRegistration(relayId, input.ownerId, "opencode-acp"),
    }))
    .map(({ relayId, session }) => session?.relayId === relayId ? session : null)
    .filter((session): session is OpenCodeAcpSessionSnapshot =>
      session !== null && session.userId === input.ownerId && isSafeSession(session));
  if (candidates.length !== 1) {
    throw new OpenCodeAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  }
  const selected = candidates[0]!;
  const state = await Promise.resolve().then(() => deps.relay.requestAcpReadiness({
    relayId: selected.relayId,
    userId: input.ownerId,
    requestId: (deps.mintRequestId ?? randomUUID)(),
    registrationId: "opencode-acp",
    timeoutMs: 5_000,
  })).catch(() => {
    throw new OpenCodeAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  });
  if (state !== "ready" || !sameSession(
    deps.relay.getAcpSessionForRegistration(selected.relayId, input.ownerId, "opencode-acp"),
    selected,
  )) {
    throw new OpenCodeAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
  }

  // Readiness is asynchronous and cannot carry authority. Re-read every
  // owner/Genie/current-Room fact, then synchronously fence the exact socket
  // generation once more before authoring the receipt.
  await assertAuthority(deps, input);
  if (!sameSession(
    deps.relay.getAcpSessionForRegistration(selected.relayId, input.ownerId, "opencode-acp"),
    selected,
  )) {
    throw new OpenCodeAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
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

async function assertAuthority(
  deps: OpenCodeAcpHarnessTaskDeps,
  input: OpenCodeAcpHarnessTaskSnapshot,
): Promise<void> {
  if (input.requestorId !== input.ownerId) {
    throw new OpenCodeAcpHarnessTaskFailure("ACP_SOURCE_FORBIDDEN");
  }
  const roomId = input.callingRoomId;
  if (!roomId || !(await deps.facts.roomExists(roomId))) {
    throw new OpenCodeAcpHarnessTaskFailure("ACP_ROOM_UNAVAILABLE");
  }
  const [agentOwner, agentMember] = await Promise.all([
    deps.facts.getAgentOwner(input.agentId),
    deps.facts.isAgentMember(roomId, input.agentId),
  ]);
  if (agentOwner !== input.ownerId || !agentMember) {
    throw new OpenCodeAcpHarnessTaskFailure("ACP_SOURCE_FORBIDDEN");
  }
}

function normalizeFailure(error: unknown): never {
  if (error instanceof OpenCodeAcpHarnessTaskFailure) throw error;
  throw new OpenCodeAcpHarnessTaskFailure("ACP_HARNESS_UNAVAILABLE");
}

function isSafeSession(session: OpenCodeAcpSessionSnapshot): boolean {
  return session.selectedProtocolVersion >= OPENCODE_ACP_RELAY_PROTOCOL_VERSION
    && Number.isSafeInteger(session.selectedProtocolVersion)
    && Number.isSafeInteger(session.capabilityRevision)
    && session.capabilityRevision >= 0
    && isSafeOpaqueId(session.relayId)
    && isSafeOpaqueId(session.relaySessionId)
    && isSafeOpaqueId(session.desktopSessionId)
    && isSafeOpaqueId(session.pairingGenerationRef);
}

function sameSession(current: OpenCodeAcpSessionSnapshot | null, selected: OpenCodeAcpSessionSnapshot): boolean {
  return current !== null
    && current.relayId === selected.relayId
    && current.userId === selected.userId
    && current.relaySessionId === selected.relaySessionId
    && current.desktopSessionId === selected.desktopSessionId
    && current.pairingGenerationRef === selected.pairingGenerationRef
    && current.selectedProtocolVersion === selected.selectedProtocolVersion
    && current.capabilityRevision === selected.capabilityRevision;
}

function isSafeOpaqueId(value: string): boolean {
  return value.length > 0 && !value.includes("\0")
    && new TextEncoder().encode(value).byteLength <= ACP_RELAY_MAX_OPAQUE_ID_BYTES;
}

function isExecutionProfile(value: unknown): value is OpenCodeAcpExecutionProfile {
  return value === "interactive" || value === "autonomous" || value === "plan";
}

type UnknownRecord = Record<string, unknown>;
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
