import type { TaskCreateInput } from "@nautilo/runtime";
import type { CodexCanonicalFactsReader } from "../codex/canonical-facts";
import type { ClaudeExecutionAdmission } from "./connection-controller";

export const CLAUDE_CODE_HARNESS_ID = "claude-code" as const;

type ClaudeHarnessTaskFailureCode =
  | "CLAUDE_HARNESS_UNAVAILABLE"
  | "CLAUDE_SOURCE_FORBIDDEN"
  | "CLAUDE_ROOM_UNAVAILABLE";

class ClaudeHarnessTaskFailure extends Error {
  constructor(readonly code: ClaudeHarnessTaskFailureCode) {
    super(code);
    this.name = "ClaudeHarnessTaskFailure";
  }
}

export interface CreateClaudeHarnessTaskInput {
  readonly ownerId: string;
  readonly requestorId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly callingRoomId: string;
  readonly harness: typeof CLAUDE_CODE_HARNESS_ID;
  readonly profileRef: string;
  readonly catalogModelId: string;
  readonly selectedModel: string;
}

export interface CreateClaudeHarnessTaskResult {
  readonly taskId: string;
  readonly status: "pending";
  readonly execution: typeof CLAUDE_CODE_HARNESS_ID;
  readonly model: Readonly<{ catalogModelId: string; selectedModel: string }>;
}

export interface ClaudeHarnessTaskDeps {
  readonly facts: Pick<CodexCanonicalFactsReader, "getAgentOwner" | "roomExists" | "isAgentMember">;
  readonly admission: {
    admitExecution(
      ownerId: string,
      input: Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }>,
    ): Promise<ClaudeExecutionAdmission | null>;
  };
  readonly createTask: (input: TaskCreateInput) => Promise<{
    readonly taskId: string;
    readonly status: string;
    readonly nextFireAt: Date | undefined;
  }>;
}

type Snapshot = Readonly<Pick<CreateClaudeHarnessTaskInput,
  "ownerId" | "requestorId" | "agentId" | "prompt" | "profileRef" | "catalogModelId" | "selectedModel"
> & { readonly roomId: string }>;

const INPUT_KEYS = Object.freeze([
  "ownerId", "requestorId", "agentId", "prompt", "callingRoomId", "harness",
  "profileRef", "catalogModelId", "selectedModel",
]);

export async function createClaudeHarnessTask(
  deps: ClaudeHarnessTaskDeps,
  input: CreateClaudeHarnessTaskInput,
): Promise<CreateClaudeHarnessTaskResult> {
  const snapshot = captureInput(input);
  try {
    if (snapshot.requestorId !== snapshot.ownerId) throw new ClaudeHarnessTaskFailure("CLAUDE_SOURCE_FORBIDDEN");
    await assertFacts(deps.facts, snapshot);

    const admission = await deps.admission.admitExecution(snapshot.ownerId, Object.freeze({
      profileRef: snapshot.profileRef,
      catalogModelId: snapshot.catalogModelId,
      selectedModel: snapshot.selectedModel,
    }));
    if (admission === null || admission.profileRef !== snapshot.profileRef
      || admission.catalogModelId !== snapshot.catalogModelId || admission.selectedModel !== snapshot.selectedModel
    ) throw new ClaudeHarnessTaskFailure("CLAUDE_HARNESS_UNAVAILABLE");

    // The controller await cannot preserve Room/Agent facts; recheck them
    // immediately before the one ordinary Task write.
    await assertFacts(deps.facts, snapshot);
    const created = await deps.createTask({
      ownerId: snapshot.ownerId,
      requestorId: snapshot.requestorId,
      agentId: snapshot.agentId,
      prompt: snapshot.prompt,
      scheduleKind: "now",
      targetChat: "last_in_namespace",
      targetRoomId: snapshot.roomId,
      callingRoomId: snapshot.roomId,
      targetUserIds: [snapshot.ownerId],
      toolsMode: "none",
      toolsWhitelist: [],
      resultDelivery: "raw_and_wake",
      requestedModelId: null,
      metadata: {
        execution: {
          version: 1,
          harnessId: CLAUDE_CODE_HARNESS_ID,
          source: "genie",
          profileRef: snapshot.profileRef,
          catalogModelId: snapshot.catalogModelId,
          selectedModel: snapshot.selectedModel,
        },
      },
    });
    if (!hasExactKeys(created, ["taskId", "status", "nextFireAt"])) throw new ClaudeHarnessTaskFailure("CLAUDE_HARNESS_UNAVAILABLE");
    const taskId = created.taskId;
    const nextFireAt = created.nextFireAt;
    if (!isUuid(taskId) || created.status !== "pending" || !isFiniteDate(nextFireAt)) {
      throw new ClaudeHarnessTaskFailure("CLAUDE_HARNESS_UNAVAILABLE");
    }
    return Object.freeze({
      taskId,
      status: "pending",
      execution: CLAUDE_CODE_HARNESS_ID,
      model: Object.freeze({ catalogModelId: snapshot.catalogModelId, selectedModel: snapshot.selectedModel }),
    });
  } catch (error) {
    if (error instanceof ClaudeHarnessTaskFailure) throw error;
    throw new ClaudeHarnessTaskFailure("CLAUDE_HARNESS_UNAVAILABLE");
  }
}

function captureInput(value: CreateClaudeHarnessTaskInput): Snapshot {
  if (!hasExactKeys(value, INPUT_KEYS)) throw new ClaudeHarnessTaskFailure("CLAUDE_HARNESS_UNAVAILABLE");
  try {
    const ownerId = value.ownerId;
    const requestorId = value.requestorId;
    const agentId = value.agentId;
    const prompt = value.prompt;
    const roomId = value.callingRoomId;
    const profileRef = value.profileRef;
    const catalogModelId = value.catalogModelId;
    const selectedModel = value.selectedModel;
    if (value.harness !== CLAUDE_CODE_HARNESS_ID || !isUuid(ownerId) || !isUuid(requestorId)
      || !isUuid(agentId) || !isUuid(roomId) || !isBoundedText(prompt, 16 * 1024)
      || !isBoundedText(profileRef, 320) || !isBoundedText(catalogModelId, 320)
      || !isBoundedText(selectedModel, 320)
    ) throw new ClaudeHarnessTaskFailure("CLAUDE_HARNESS_UNAVAILABLE");
    return Object.freeze({ ownerId, requestorId, agentId, prompt, roomId, profileRef, catalogModelId, selectedModel });
  } catch (error) {
    if (error instanceof ClaudeHarnessTaskFailure) throw error;
    throw new ClaudeHarnessTaskFailure("CLAUDE_HARNESS_UNAVAILABLE");
  }
}

async function assertFacts(
  facts: ClaudeHarnessTaskDeps["facts"],
  input: Snapshot,
): Promise<void> {
  let room: unknown;
  try {
    room = await facts.roomExists(input.roomId);
  } catch {
    throw new ClaudeHarnessTaskFailure("CLAUDE_ROOM_UNAVAILABLE");
  }
  if (room !== true) throw new ClaudeHarnessTaskFailure("CLAUDE_ROOM_UNAVAILABLE");
  try {
    const [owner, member] = await Promise.all([
      facts.getAgentOwner(input.agentId),
      facts.isAgentMember(input.roomId, input.agentId),
    ]);
    if (owner !== input.ownerId || member !== true) throw new ClaudeHarnessTaskFailure("CLAUDE_SOURCE_FORBIDDEN");
  } catch (error) {
    if (error instanceof ClaudeHarnessTaskFailure) throw error;
    throw new ClaudeHarnessTaskFailure("CLAUDE_SOURCE_FORBIDDEN");
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && Reflect.ownKeys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxBytes && !value.includes("\0")
    && new TextEncoder().encode(value).byteLength <= maxBytes;
}

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
