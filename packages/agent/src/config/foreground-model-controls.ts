import {
  getCachedServerModelConfigRow,
  getProfileDefaultModelControlSelection,
  getRoomAgentModelControlSelection,
  type ServerReasoningPolicy,
} from "@nautilo/db";
import type { ModelControlSelection } from "@nautilo/types";
import { log } from "@nautilo/logger";
import type { ResolveForegroundModelControls } from "../utils/chat-model-invocation";
import { getActiveModelCatalogSync } from "./model-catalog/runtime-catalog";
import { resolveModelControlSelection, type ModelControlCatalogEntry } from "./model-control-selection";

export interface ForegroundModelControlPlan {
  initialModelId: string;
  resolveForegroundControls?: ResolveForegroundModelControls;
}

/** Pure D462 precedence resolver; kept test-visible so Room/fallback isolation needs no DB or graph harness. */
export function buildForegroundModelControlPlan(
  roomBundle: ModelControlSelection | null,
  agentBundle: ModelControlSelection | null,
  fallbackModelId: string | (() => string),
  catalogByModelId: ReadonlyMap<string, ModelControlCatalogEntry>,
  serverReasoningPolicy: ServerReasoningPolicy | null = null,
  turnModelId?: string | null,
): ForegroundModelControlPlan {
  const initialModelId = turnModelId ?? roomBundle?.modelId ?? agentBundle?.modelId
    ?? (typeof fallbackModelId === "function" ? fallbackModelId() : fallbackModelId);
  return {
    initialModelId,
    resolveForegroundControls: (candidateModelId) => {
      const matchingPersisted = turnModelId === candidateModelId
        ? { modelId: turnModelId }
        : roomBundle?.modelId === candidateModelId
          ? roomBundle
          : agentBundle?.modelId === candidateModelId
            ? agentBundle
            : null;
      if (!catalogByModelId.has(candidateModelId) && !matchingPersisted) return undefined;
      const catalogReasoning = catalogByModelId.get(candidateModelId)?.controls?.reasoning;
      const overrideEffort = serverReasoningPolicy?.overrides[candidateModelId];
      const defaultEffort = serverReasoningPolicy?.defaultEffort;
      const configuredEffort = overrideEffort ?? defaultEffort ?? undefined;
      const serverEffort = configuredEffort === undefined
        ? undefined
        : configuredEffort === "off"
          ? catalogReasoning?.canDisable && !catalogReasoning.mandatory ? configuredEffort : undefined
          : catalogReasoning?.levels.includes(configuredEffort) ? configuredEffort : undefined;
      const requested = matchingPersisted && matchingPersisted.reasoningEffort !== undefined
        ? matchingPersisted
        : {
            ...(matchingPersisted ?? { modelId: candidateModelId }),
            ...(serverEffort === undefined ? {} : { reasoningEffort: serverEffort }),
          };
      const resolution = resolveModelControlSelection({
        catalogByModelId,
        turnOverride: requested,
        catalogDefaultModelId: candidateModelId,
      });
      if (resolution.status !== "resolved") {
        throw new Error(`D462 model controls ${resolution.status} for "${candidateModelId}": ${resolution.reason}`);
      }
      const effective = resolution.effective;
      if (effective.reasoningEffort === undefined && effective.servingProfileId === undefined) return undefined;
      return {
        canonicalModelId: effective.modelId,
        ...(effective.reasoningEffort === undefined ? {} : { reasoningEffort: effective.reasoningEffort }),
        ...(effective.servingProfileId === undefined ? {} : { servingProfileId: effective.servingProfileId }),
      };
    },
  };
}

/** Serializable turn snapshot; approval resumes retain the same model preferences. */
export interface ForegroundModelControlSnapshot {
  roomSelection: ModelControlSelection | null;
  agentSelection: ModelControlSelection | null;
  serverReasoningPolicy: ServerReasoningPolicy | null;
  turnModelId: string | null;
}

export async function loadForegroundModelControlSnapshot(
  roomId: string,
  agentId: string,
  turnModelId: string | null = null,
): Promise<ForegroundModelControlSnapshot> {
  let roomSelection: ModelControlSelection | null = null;
  let agentSelection: ModelControlSelection | null = null;
  try {
    const [room, agent] = await Promise.all([
      roomId ? getRoomAgentModelControlSelection(roomId, agentId) : Promise.resolve(null),
      getProfileDefaultModelControlSelection(agentId),
    ]);
    roomSelection = room?.selection ?? null;
    agentSelection = agent;
  } catch (error) {
    // Preserve the existing model-only recovery for a transient preference read.
    log(`[nautilo/agent] D462 model-control preferences unavailable; using model-only behavior: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    roomSelection,
    agentSelection,
    serverReasoningPolicy: getCachedServerModelConfigRow()?.reasoningPolicy ?? null,
    turnModelId,
  };
}

export function foregroundModelControlPlanFromSnapshot(
  snapshot: ForegroundModelControlSnapshot,
  fallbackModelId: () => string,
): ForegroundModelControlPlan {
  return buildForegroundModelControlPlan(
    snapshot.roomSelection,
    snapshot.agentSelection,
    fallbackModelId,
    new Map<string, ModelControlCatalogEntry>(
      getActiveModelCatalogSync().catalog.entries.map((entry) => [entry.id, entry]),
    ),
    snapshot.serverReasoningPolicy,
    snapshot.turnModelId,
  );
}
