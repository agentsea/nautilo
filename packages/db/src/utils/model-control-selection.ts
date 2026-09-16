import { and, eq } from "drizzle-orm";
import type { ModelCatalogReasoningEffort } from "@nautilo/types";
import { db, type Database } from "../config/database";
import { profiles } from "../schema/profiles";
import {
  roomAgentModelControlSelections,
  type ModelControlSelection,
  type RoomAgentModelControlSelection,
} from "../schema/model-control-selection";

const REASONING_EFFORTS = new Set<ModelCatalogReasoningEffort>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MODEL_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9/._-]*$/;
const SERVING_PROFILE_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** Raised at the persistence boundary; catalog/policy validity is resolved later. */
export class InvalidModelControlSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelControlSelectionError";
  }
}

/**
 * Strictly decode the persisted/browser-neutral selection shape. This prevents
 * JSONB from becoming a carrier for provider selectors or future unreviewed
 * controls. Whether a syntactically valid value is current or allowed belongs
 * to the catalog+policy resolver.
 */
export function parseModelControlSelection(value: unknown): ModelControlSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidModelControlSelectionError("Model control selection must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "modelId" && key !== "reasoningEffort" && key !== "servingProfileId")) {
    throw new InvalidModelControlSelectionError("Model control selection contains an unknown field");
  }
  if (typeof record["modelId"] !== "string" || !MODEL_ID.test(record["modelId"])) {
    throw new InvalidModelControlSelectionError("Model control selection modelId is invalid");
  }
  if (
    record["reasoningEffort"] !== undefined &&
    (typeof record["reasoningEffort"] !== "string" ||
      !REASONING_EFFORTS.has(record["reasoningEffort"] as ModelCatalogReasoningEffort))
  ) {
    throw new InvalidModelControlSelectionError("Model control selection reasoningEffort is invalid");
  }
  if (
    record["servingProfileId"] !== undefined &&
    (typeof record["servingProfileId"] !== "string" ||
      !SERVING_PROFILE_ID.test(record["servingProfileId"]))
  ) {
    throw new InvalidModelControlSelectionError("Model control selection servingProfileId is invalid");
  }
  return {
    modelId: record["modelId"],
    ...(record["reasoningEffort"] === undefined
      ? {}
      : { reasoningEffort: record["reasoningEffort"] as ModelCatalogReasoningEffort }),
    ...(record["servingProfileId"] === undefined
      ? {}
      : { servingProfileId: record["servingProfileId"] }),
  };
}

function assertLaneId(value: string, label: string): void {
  if (value.trim() === "") {
    throw new InvalidModelControlSelectionError(`${label} must not be empty`);
  }
}

type Db = Database;

/** Returns null for historical model-only Profiles. */
export async function getProfileDefaultModelControlSelection(
  agentId: string,
  conn: Db = db,
): Promise<ModelControlSelection | null> {
  assertLaneId(agentId, "agentId");
  const [row] = await conn
    .select({ selection: profiles.defaultModelControlSelection })
    .from(profiles)
    .where(eq(profiles.agentId, agentId))
    .limit(1);
  return row?.selection === null || row?.selection === undefined
    ? null
    : parseModelControlSelection(row.selection);
}

/**
 * Writes only the optional D462 bundle. `default_model` remains untouched so
 * older model-only readers retain their existing behavior throughout rollout.
 */
export async function setProfileDefaultModelControlSelection(
  agentId: string,
  selection: ModelControlSelection | null,
  conn: Db = db,
): Promise<ModelControlSelection | null> {
  assertLaneId(agentId, "agentId");
  const parsed = selection === null ? null : parseModelControlSelection(selection);
  const [row] = await conn
    .update(profiles)
    .set({ defaultModelControlSelection: parsed, updatedAt: new Date() })
    .where(eq(profiles.agentId, agentId))
    .returning({ selection: profiles.defaultModelControlSelection });
  if (!row) throw new Error("Profile does not exist for agentId");
  return row.selection === null || row.selection === undefined
    ? null
    : parseModelControlSelection(row.selection);
}

export async function getRoomAgentModelControlSelection(
  roomId: string,
  agentId: string,
  conn: Db = db,
): Promise<RoomAgentModelControlSelection | null> {
  assertLaneId(roomId, "roomId");
  assertLaneId(agentId, "agentId");
  const [row] = await conn
    .select()
    .from(roomAgentModelControlSelections)
    .where(
      and(
        eq(roomAgentModelControlSelections.roomId, roomId),
        eq(roomAgentModelControlSelections.agentId, agentId),
      ),
    )
    .limit(1);
  return row ? { ...row, selection: parseModelControlSelection(row.selection) } : null;
}

export async function upsertRoomAgentModelControlSelection(
  input: { roomId: string; agentId: string; selection: ModelControlSelection },
  conn: Db = db,
): Promise<RoomAgentModelControlSelection> {
  assertLaneId(input.roomId, "roomId");
  assertLaneId(input.agentId, "agentId");
  const selection = parseModelControlSelection(input.selection);
  const now = new Date();
  const [row] = await conn
    .insert(roomAgentModelControlSelections)
    .values({ ...input, selection, updatedAt: now })
    .onConflictDoUpdate({
      target: [roomAgentModelControlSelections.roomId, roomAgentModelControlSelections.agentId],
      set: { selection, updatedAt: now },
    })
    .returning();
  if (!row) throw new Error("Room+Agent model control selection upsert returned no row");
  return { ...row, selection: parseModelControlSelection(row.selection) };
}

/** Reset exposes the Agent default; it does not mutate the Profile bundle. */
export async function resetRoomAgentModelControlSelection(
  roomId: string,
  agentId: string,
  conn: Db = db,
): Promise<boolean> {
  assertLaneId(roomId, "roomId");
  assertLaneId(agentId, "agentId");
  const rows = await conn
    .delete(roomAgentModelControlSelections)
    .where(
      and(
        eq(roomAgentModelControlSelections.roomId, roomId),
        eq(roomAgentModelControlSelections.agentId, agentId),
      ),
    )
    .returning({ roomId: roomAgentModelControlSelections.roomId });
  return rows.length > 0;
}
