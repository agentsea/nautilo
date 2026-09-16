import { eq } from "drizzle-orm";
import type { Database } from "../config/database";
import {
  serverModelConfig,
  type NewServerModelConfigRow,
  type ServerModelConfigRow,
  type ServerReasoningPolicy,
} from "../schema/server-model-config";

export type { ServerReasoningPolicy } from "../schema/server-model-config";

const SERVER_MODEL_CONFIG_ID = "server";

/**
 * Effective defaults supplied by the caller (server package resolves these
 * from `@nautilo/config` / `MODEL_DEFAULTS` so the db package stays free of
 * runtime config-resolution coupling — same pattern as `defaultName` on
 * `resolveServerProfile`).
 */
export interface ServerModelConfigDefaults {
  defaultChatModel: string;
  fallbackChain: string[];
}

export interface ResolvedServerModelConfig {
  /** Always populated (stored value or default). */
  defaultChatModel: string;
  /** Empty string ⇒ inherit the default chat model (D221/M135 contract). */
  conductorModel: string;
  /** Empty string ⇒ inherit the resolved Conductor model (M219). */
  stenographerModel: string;
  /** Empty string ⇒ inherit the resolved Stenographer model (M271). */
  reflectionModel: string;
  memoryReviewModel: string | null;
  embeddingModel: string | null;
  imageModel: string | null;
  musicModel: string | null;
  videoModel: string | null;
  /** Always populated (stored value or default). */
  fallbackChain: string[];
  /** Per-model operator override for reasoning output (D331). Absent key ⇒ default ON. */
  reasoningOutput: Record<string, boolean>;
  /** D537 — one server default plus sparse model-specific reasoning-effort overrides. */
  reasoningPolicy: ServerReasoningPolicy;
}

export type ServerModelConfigPatch = Partial<
  Pick<
    NewServerModelConfigRow,
    | "defaultChatModel"
    | "conductorModel"
    | "stenographerModel"
    | "reflectionModel"
    | "memoryReviewModel"
    | "embeddingModel"
    | "imageModel"
    | "musicModel"
    | "videoModel"
    | "fallbackChain"
    | "reasoningOutput"
    | "reasoningPolicy"
  >
>;

export type ServerModelConfigDb = Pick<Database, "insert" | "select">;

/** Pure default-fallback resolver. No DB I/O. */
export function resolveServerModelConfig(
  row: ServerModelConfigRow | null | undefined,
  defaults: ServerModelConfigDefaults,
): ResolvedServerModelConfig {
  return {
    defaultChatModel: row?.defaultChatModel ?? defaults.defaultChatModel,
    conductorModel: row?.conductorModel ?? "",
    stenographerModel: row?.stenographerModel ?? "",
    reflectionModel: row?.reflectionModel ?? "",
    memoryReviewModel: row?.memoryReviewModel ?? null,
    embeddingModel: row?.embeddingModel ?? null,
    imageModel: row?.imageModel ?? null,
    musicModel: row?.musicModel ?? null,
    videoModel: row?.videoModel ?? null,
    fallbackChain: row?.fallbackChain ?? defaults.fallbackChain,
    reasoningOutput: row?.reasoningOutput ?? {},
    reasoningPolicy: row?.reasoningPolicy ?? {
      defaultEffort: null,
      overrides: Object.fromEntries(
        Object.entries(row?.reasoningOutput ?? {})
          .filter(([, enabled]) => enabled === false)
          .map(([modelId]) => [modelId, "off"]),
      ),
    },
  };
}

export async function getServerModelConfig(
  db: ServerModelConfigDb,
  defaults: ServerModelConfigDefaults,
): Promise<ResolvedServerModelConfig> {
  const [row] = await db
    .select()
    .from(serverModelConfig)
    .where(eq(serverModelConfig.id, SERVER_MODEL_CONFIG_ID))
    .limit(1);
  return resolveServerModelConfig(row ?? null, defaults);
}

export async function upsertServerModelConfig(
  db: ServerModelConfigDb,
  patch: ServerModelConfigPatch,
  defaults: ServerModelConfigDefaults,
): Promise<ResolvedServerModelConfig> {
  const now = new Date();
  const insertValues: NewServerModelConfigRow = {
    id: SERVER_MODEL_CONFIG_ID,
    updatedAt: now,
    ...patch,
  };

  const set: Partial<NewServerModelConfigRow> = { updatedAt: now };
  if (patch.defaultChatModel !== undefined) set.defaultChatModel = patch.defaultChatModel;
  if (patch.conductorModel !== undefined) set.conductorModel = patch.conductorModel;
  if (patch.stenographerModel !== undefined) {
    set.stenographerModel = patch.stenographerModel;
  }
  if (patch.reflectionModel !== undefined) {
    set.reflectionModel = patch.reflectionModel;
  }
  if (patch.memoryReviewModel !== undefined) set.memoryReviewModel = patch.memoryReviewModel;
  if (patch.embeddingModel !== undefined) set.embeddingModel = patch.embeddingModel;
  if (patch.imageModel !== undefined) set.imageModel = patch.imageModel;
  if (patch.musicModel !== undefined) set.musicModel = patch.musicModel;
  if (patch.videoModel !== undefined) set.videoModel = patch.videoModel;
  if (patch.fallbackChain !== undefined) set.fallbackChain = patch.fallbackChain;
  if (patch.reasoningOutput !== undefined) set.reasoningOutput = patch.reasoningOutput;
  if (patch.reasoningPolicy !== undefined) set.reasoningPolicy = patch.reasoningPolicy;

  const [row] = await db
    .insert(serverModelConfig)
    .values(insertValues)
    .onConflictDoUpdate({
      target: serverModelConfig.id,
      set,
    })
    .returning();

  return resolveServerModelConfig(row ?? null, defaults);
}
