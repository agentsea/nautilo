import type { TaskCreateInput } from "@nautilo/runtime";
import type { CodexPosture } from "@nautilo/types";
import {
  codexCapabilityModelId,
  createCodexModelOutputContract,
  type CodexModelExecutionLimits,
  type CodexModelOutputContract,
} from "./model-output-contract";

/**
 * The only persisted external-execution discriminator. It is authored here,
 * after server-owned owner/Agent/Room/profile checks; a model or browser never
 * writes this metadata directly. It deliberately names the generic Task
 * source, rather than the deleted Codex composer action.
 */
export const CODEX_HARNESS_TASK_EXECUTION_DESCRIPTOR = Object.freeze({
  version: 1 as const,
  harnessId: "codex" as const,
  source: "genie" as const,
  collaborationMode: "work" as const,
});

type CodexPreference = {
  readonly enabled: boolean;
  readonly accountProfileId: string | null;
  readonly defaultPosture: CodexPosture;
};

type CodexProfile = {
  readonly id: string;
  readonly userId: string;
  readonly relayId: string;
  readonly profileHandle: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly authState: string;
  readonly removalState: string;
};

export type CodexHarnessModel = {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly isDefault: boolean;
};

export type CodexHarnessModelChoice = CodexHarnessModel & {
  readonly isPreferred: boolean;
};

export interface CodexHarnessTaskPreferencePort {
  getOwnerPreference(userId: string): Promise<CodexPreference>;
  getProfile(userId: string, profileId: string): Promise<CodexProfile | undefined>;
}

export interface CodexHarnessTaskFactsPort {
  getAgentOwner(agentId: string): Promise<string | null>;
  roomExists(roomId: string): Promise<boolean>;
  isAgentMember(roomId: string, agentId: string): Promise<boolean>;
}

export type CodexHarnessReadinessReceipt = {
  readonly relayId: string;
  readonly pairingGenerationRef: string;
  readonly capabilityRevision: number;
};

export interface CodexHarnessReadinessPort {
  /** Non-writing proof of the exact live paired Desktop and Codex capability. */
  check(
    profile: CodexProfile,
    collaborationMode: "work" | "plan",
  ): Promise<CodexHarnessReadinessReceipt>;
}

export interface CodexHarnessPreflightPort {
  /** Idempotently rehydrates the selected runtime/profile on a cold Desktop. */
  prepare(profile: CodexProfile): Promise<void>;
}

export interface CodexHarnessTaskDeps {
  readonly preferences: CodexHarnessTaskPreferencePort;
  readonly facts: CodexHarnessTaskFactsPort;
  readonly models: {
    list(profile: CodexProfile): Promise<{
      readonly models: readonly CodexHarnessModel[];
      readonly preferredModelId: string | null;
    }>;
  };
  readonly limits: {
    resolve(modelId: string): Promise<CodexModelExecutionLimits>;
  };
  readonly preflight: CodexHarnessPreflightPort;
  readonly readiness: CodexHarnessReadinessPort;
  readonly createTask: (input: TaskCreateInput) => Promise<{
    readonly taskId: string;
    readonly status: "pending" | "running" | "awaiting" | "paused" | "completed" | "cancelled" | "errored";
  }>;
}

export type CodexHarnessTaskFailureCode =
  | "CODEX_NOT_ENABLED"
  | "CODEX_SOURCE_FORBIDDEN"
  | "CODEX_PROFILE_UNAVAILABLE"
  | "CODEX_ROOM_UNAVAILABLE"
  | "CODEX_MODEL_UNAVAILABLE"
  | "CODEX_HOST_UNAVAILABLE"
  | "CODEX_WORKSPACE_UNAVAILABLE";

/** Stable, actionable failures for the Genie. Raw host/account details stay
 * private to Connections and the profile/admin control plane. */
class CodexHarnessTaskFailure extends Error {
  constructor(readonly code: CodexHarnessTaskFailureCode) {
    super(code);
    this.name = "CodexHarnessTaskFailure";
  }
}

export interface CreateCodexHarnessTaskInput extends TaskCreateInput {
  readonly harness: "codex";
  readonly collaborationMode: "work" | "plan";
  /** Advanced Task id from the live harness catalog, not a Nautilo model id. */
  readonly harnessModelId?: string;
  /** Optional host-local starting directory; never a Nautilo grant. */
  readonly workingDirectory?: string;
}

export interface CreateCodexHarnessTaskResult {
  readonly taskId: string;
  readonly status: "pending" | "running" | "awaiting" | "paused" | "completed" | "cancelled" | "errored";
  readonly execution: "codex";
}

/**
 * Canonical native-Genie Codex admission. Exact selection never falls back.
 * All ordinary tasks bypass this function, preserving their Native path.
 */
export async function createCodexHarnessTask(
  deps: CodexHarnessTaskDeps,
  input: CreateCodexHarnessTaskInput,
): Promise<CreateCodexHarnessTaskResult> {
  const admitted = await resolveCodexHarnessTaskAdmission(deps, input);

  const roomId = input.callingRoomId;
  if (!roomId) throw new CodexHarnessTaskFailure("CODEX_ROOM_UNAVAILABLE");
  const created = await deps.createTask({
    ...nativeInput(input),
    targetChat: "last_in_namespace",
    targetRoomId: roomId,
    callingRoomId: roomId,
    targetUserIds: [input.ownerId],
    toolsMode: "none",
    toolsWhitelist: [],
    resultDelivery: "raw_and_wake",
    // `requestedModelId` belongs exclusively to Nautilo's curated native
    // model domain. The sealed harness descriptor carries only Codex's
    // driver-owned catalog id so native Task dispatch cannot reject or
    // reinterpret it; execution admission revalidates and resolves it.
    requestedModelId: null,
    metadata: {
      execution: {
        ...CODEX_HARNESS_TASK_EXECUTION_DESCRIPTOR,
        collaborationMode: input.collaborationMode,
        harnessModelId: admitted.model.id,
        outputContract: admitted.outputContract,
        readiness: admitted.readiness,
        ...(input.workingDirectory === undefined
          ? {}
          : { workingDirectory: input.workingDirectory }),
      },
    },
  });
  return { ...created, execution: "codex" };
}

function nativeInput(input: CreateCodexHarnessTaskInput): TaskCreateInput {
  const { harness: _harness, collaborationMode: _mode, harnessModelId: _model, workingDirectory: _cwd, ...native } = input;
  return native;
}

async function preflightCodex(
  deps: Pick<CodexHarnessTaskDeps, "preferences" | "facts">,
  input: CreateCodexHarnessTaskInput,
): Promise<{ ok: true; profile: CodexProfile } | { ok: false; code: CodexHarnessTaskFailureCode }> {
  const preference = await deps.preferences.getOwnerPreference(input.ownerId);
  if (!preference.enabled) return { ok: false, code: "CODEX_NOT_ENABLED" };

  const roomId = input.callingRoomId;
  if (!roomId || !(await deps.facts.roomExists(roomId))) {
    return { ok: false, code: "CODEX_ROOM_UNAVAILABLE" };
  }

  const [agentOwner, agentMember] = await Promise.all([
    deps.facts.getAgentOwner(input.agentId),
    deps.facts.isAgentMember(roomId, input.agentId),
  ]);
  if (agentOwner !== input.ownerId || !agentMember) {
    return { ok: false, code: "CODEX_SOURCE_FORBIDDEN" };
  }

  if (!preference.accountProfileId) {
    return { ok: false, code: "CODEX_PROFILE_UNAVAILABLE" };
  }
  const profile = await deps.preferences.getProfile(input.ownerId, preference.accountProfileId);
  if (
    !profile
    || profile.id !== preference.accountProfileId
    || profile.userId !== input.ownerId
    || profile.authState !== "signed_in"
    || profile.removalState !== "active"
  ) {
    return { ok: false, code: "CODEX_PROFILE_UNAVAILABLE" };
  }
  return { ok: true, profile };
}

type CodexHarnessTaskAdmission = {
  readonly profile: CodexProfile;
  readonly model: CodexHarnessModel;
  readonly outputContract: CodexModelOutputContract;
  readonly readiness: CodexHarnessReadinessReceipt;
};

/** Performs the deterministic, no-write half of Codex task admission. */
async function resolveCodexHarnessTaskAdmission(
  deps: Pick<CodexHarnessTaskDeps, "preferences" | "facts" | "models" | "limits" | "preflight" | "readiness">,
  input: CreateCodexHarnessTaskInput,
): Promise<CodexHarnessTaskAdmission> {
  const admission = await preflightCodex(deps, input);
  if (!admission.ok) {
    throw new CodexHarnessTaskFailure(admission.code);
  }
  await rehydrateCodexProfile(deps.preflight, admission.profile);
  const readiness = await Promise.resolve().then(() => deps.readiness.check(
    admission.profile,
    input.collaborationMode,
  )).catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    throw new CodexHarnessTaskFailure(
      code === "CODEX_PROFILE_UNAVAILABLE"
        ? "CODEX_PROFILE_UNAVAILABLE"
        : "CODEX_HOST_UNAVAILABLE",
    );
  });
  const catalog = await deps.models.list(admission.profile)
    .catch(() => { throw new CodexHarnessTaskFailure("CODEX_MODEL_UNAVAILABLE"); });
  const selectedId = input.harnessModelId ?? catalog.preferredModelId;
  const model = selectedId === null
    ? undefined
    : catalog.models.find((candidate) => candidate.id === selectedId);
  if (!model) {
    throw new CodexHarnessTaskFailure("CODEX_MODEL_UNAVAILABLE");
  }
  const outputContract = await resolveOutputContract(deps.limits, model);
  return { profile: admission.profile, model, outputContract, readiness };
}

async function resolveOutputContract(
  limits: CodexHarnessTaskDeps["limits"],
  model: CodexHarnessModel,
): Promise<CodexModelOutputContract> {
  try {
    const capabilityModelId = codexCapabilityModelId(model.model);
    return createCodexModelOutputContract(
      model.model,
      await limits.resolve(capabilityModelId),
    );
  } catch {
    throw new CodexHarnessTaskFailure("CODEX_MODEL_UNAVAILABLE");
  }
}

async function rehydrateCodexProfile(
  preflight: CodexHarnessPreflightPort,
  profile: CodexProfile,
): Promise<void> {
  await preflight.prepare(profile).catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    throw new CodexHarnessTaskFailure(
      code === "CODEX_PROFILE_UNAVAILABLE"
        ? "CODEX_PROFILE_UNAVAILABLE"
        : "CODEX_HOST_UNAVAILABLE",
    );
  });
}

export async function listCodexHarnessModels(
  deps: Pick<CodexHarnessTaskDeps, "preferences" | "models" | "limits" | "preflight">,
  ownerId: string,
): Promise<readonly CodexHarnessModelChoice[]> {
  const preference = await deps.preferences.getOwnerPreference(ownerId);
  if (!preference.enabled || !preference.accountProfileId) {
    throw new CodexHarnessTaskFailure("CODEX_PROFILE_UNAVAILABLE");
  }
  const profile = await deps.preferences.getProfile(ownerId, preference.accountProfileId);
  if (!profile || profile.userId !== ownerId || profile.authState !== "signed_in" || profile.removalState !== "active") {
    throw new CodexHarnessTaskFailure("CODEX_PROFILE_UNAVAILABLE");
  }
  await rehydrateCodexProfile(deps.preflight, profile);
  const catalog = await deps.models.list(profile)
    .catch(() => { throw new CodexHarnessTaskFailure("CODEX_MODEL_UNAVAILABLE"); });
  const admitted = await Promise.all(catalog.models.map(async (model) => {
    try {
      await resolveOutputContract(deps.limits, model);
      return {
        ...model,
        isPreferred: model.id === catalog.preferredModelId,
      };
    } catch {
      return null;
    }
  }));
  return admitted.filter((model): model is CodexHarnessModelChoice => model !== null);
}
