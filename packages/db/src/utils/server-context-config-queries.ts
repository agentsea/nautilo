import { eq } from "drizzle-orm";
import type { Database } from "../config/database";
import {
  serverContextConfig,
  type NewServerContextConfigRow,
  type ServerContextConfigRow,
} from "../schema/server-context-config";

const SERVER_CONTEXT_CONFIG_ID = "server";

export const RECENT_CONVERSATION_LIMIT_DEFAULT = 50;
export const RECENT_CONVERSATION_LIMIT_MIN = 10;
export const RECENT_CONVERSATION_LIMIT_MAX = 100;
export const MINIMUM_FULL_TURNS_DEFAULT = 1;
export const MINIMUM_FULL_TURNS_MIN = 0;
export const MINIMUM_FULL_TURNS_MAX = 10;
export const MAX_ROOM_CONTEXT_PERCENT_DEFAULT = 50;
export const MAX_ROOM_CONTEXT_PERCENT_MIN = 30;
export const MAX_ROOM_CONTEXT_PERCENT_MAX = 80;
export const STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_DEFAULT = 10;
export const STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MIN = 0;
export const STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MAX = 50;
export const PASSIVE_RECALL_ENABLED_DEFAULT = true;
export const REFLECTION_SLEEP_ENABLED_DEFAULT = true;

export interface ResolvedServerContextConfig {
  recentConversationLimit: number;
  minimumFullTurns: number;
  maxRoomContextPercent: number;
  stenographerPriorConversationLimit: number;
  passiveRecallEnabled: boolean;
  reflectionSleepEnabled: boolean;
  memoryReviewEnabled: boolean | null;
}

export type ServerContextConfigPatch = Partial<
  Pick<
    NewServerContextConfigRow,
    | "recentConversationLimit"
    | "minimumFullTurns"
    | "maxRoomContextPercent"
    | "stenographerPriorConversationLimit"
    | "passiveRecallEnabled"
    | "reflectionSleepEnabled"
    | "memoryReviewEnabled"
  >
>;

export type ServerContextConfigDb = Pick<Database, "insert" | "select">;

export function isRecentConversationLimit(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= RECENT_CONVERSATION_LIMIT_MIN &&
    value <= RECENT_CONVERSATION_LIMIT_MAX
  );
}

export function isMinimumFullTurns(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MINIMUM_FULL_TURNS_MIN &&
    value <= MINIMUM_FULL_TURNS_MAX
  );
}

export function isMaxRoomContextPercent(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MAX_ROOM_CONTEXT_PERCENT_MIN &&
    value <= MAX_ROOM_CONTEXT_PERCENT_MAX
  );
}

export function isStenographerPriorConversationLimit(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MIN &&
    value <= STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MAX
  );
}

export function resolveServerContextConfig(
  row:
    | (Pick<
        ServerContextConfigRow,
        | "recentConversationLimit"
        | "minimumFullTurns"
        | "maxRoomContextPercent"
        | "stenographerPriorConversationLimit"
      > & Partial<
        Pick<
          ServerContextConfigRow,
          "passiveRecallEnabled" | "reflectionSleepEnabled" | "memoryReviewEnabled"
        >
      >)
    | null
    | undefined,
): ResolvedServerContextConfig {
  const recentConversationLimit = row?.recentConversationLimit;
  const minimumFullTurns = row?.minimumFullTurns;
  const maxRoomContextPercent = row?.maxRoomContextPercent;
  const stenographerPriorConversationLimit =
    row?.stenographerPriorConversationLimit;
  return {
    recentConversationLimit:
      typeof recentConversationLimit === "number" &&
      isRecentConversationLimit(recentConversationLimit)
        ? recentConversationLimit
        : RECENT_CONVERSATION_LIMIT_DEFAULT,
    minimumFullTurns:
      typeof minimumFullTurns === "number" && isMinimumFullTurns(minimumFullTurns)
        ? minimumFullTurns
        : MINIMUM_FULL_TURNS_DEFAULT,
    maxRoomContextPercent:
      typeof maxRoomContextPercent === "number" &&
      isMaxRoomContextPercent(maxRoomContextPercent)
        ? maxRoomContextPercent
        : MAX_ROOM_CONTEXT_PERCENT_DEFAULT,
    stenographerPriorConversationLimit:
      typeof stenographerPriorConversationLimit === "number" &&
      isStenographerPriorConversationLimit(stenographerPriorConversationLimit)
        ? stenographerPriorConversationLimit
        : STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_DEFAULT,
    passiveRecallEnabled:
      typeof row?.passiveRecallEnabled === "boolean"
        ? row.passiveRecallEnabled
        : PASSIVE_RECALL_ENABLED_DEFAULT,
    memoryReviewEnabled: row?.memoryReviewEnabled ?? null,
    reflectionSleepEnabled:
      typeof row?.reflectionSleepEnabled === "boolean"
        ? row.reflectionSleepEnabled
        : REFLECTION_SLEEP_ENABLED_DEFAULT,
  };
}

export async function getServerContextConfig(
  db: ServerContextConfigDb,
): Promise<ResolvedServerContextConfig> {
  const [row] = await db
    .select()
    .from(serverContextConfig)
    .where(eq(serverContextConfig.id, SERVER_CONTEXT_CONFIG_ID))
    .limit(1);
  return resolveServerContextConfig(row ?? null);
}

export async function upsertServerContextConfig(
  db: ServerContextConfigDb,
  patch: ServerContextConfigPatch,
): Promise<ResolvedServerContextConfig> {
  const now = new Date();
  const insertValues: NewServerContextConfigRow = {
    id: SERVER_CONTEXT_CONFIG_ID,
    updatedAt: now,
    ...patch,
  };
  const set: Partial<NewServerContextConfigRow> = { updatedAt: now };
  if (patch.recentConversationLimit !== undefined) {
    set.recentConversationLimit = patch.recentConversationLimit;
  }
  if (patch.minimumFullTurns !== undefined) {
    set.minimumFullTurns = patch.minimumFullTurns;
  }
  if (patch.maxRoomContextPercent !== undefined) {
    set.maxRoomContextPercent = patch.maxRoomContextPercent;
  }
  if (patch.stenographerPriorConversationLimit !== undefined) {
    set.stenographerPriorConversationLimit =
      patch.stenographerPriorConversationLimit;
  }
  if (patch.passiveRecallEnabled !== undefined) {
    set.passiveRecallEnabled = patch.passiveRecallEnabled;
  }
  if (patch.memoryReviewEnabled !== undefined) set.memoryReviewEnabled = patch.memoryReviewEnabled;
  if (patch.reflectionSleepEnabled !== undefined) {
    set.reflectionSleepEnabled = patch.reflectionSleepEnabled;
  }

  const [row] = await db
    .insert(serverContextConfig)
    .values(insertValues)
    .onConflictDoUpdate({
      target: serverContextConfig.id,
      set,
    })
    .returning();
  return resolveServerContextConfig(row ?? null);
}
