import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ModelControlSelection } from "@nautilo/types";
import { assertModelRunnable, getActiveModelCatalogSync } from "@nautilo/agent";
import {
  getRoomAgentModelControlSelection,
  InvalidModelControlSelectionError,
  parseModelControlSelection,
  resetRoomAgentModelControlSelection,
  upsertRoomAgentModelControlSelection,
} from "@nautilo/db";
import { findPersonalAgentsForUser, findRoomForUserAndAgentMembers } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";

/**
 * D462's browser-facing selection scope is deliberately `(current user,
 * explicitly selected owned Agent, Room)`. The browser submits only neutral catalog
 * identifiers; the server owns catalog validation and provider translation.
 */
export interface ModelControlSelectionRoutesDeps {
  findPersonalAgentsForUser?: (
    userId: string,
  ) => Promise<Array<{ agentId: string }>>;
  findRoomForUserAndAgentMembers?: (
    roomId: string,
    userActorId: string,
    agentId: string,
  ) => Promise<{ id?: string } | null>;
  getSelection?: (roomId: string, agentId: string) => Promise<ModelControlSelection | null>;
  setSelection?: (
    roomId: string,
    agentId: string,
    selection: ModelControlSelection,
  ) => Promise<ModelControlSelection>;
  resetSelection?: (roomId: string, agentId: string) => Promise<void>;
  /** Active signed-catalog seam; injectable so route tests never need network/catalog boot. */
  getCatalogEntries?: () => readonly ModelControlCatalogEntry[];
  assertRunnableSelection?: (modelId: string) => void;
}

type RoomParams = { roomId: string; agentId: string };
type SelectionBody = { selection?: unknown };

/** The narrow active-catalog projection needed to validate a browser tuple. */
interface ModelControlCatalogEntry {
  readonly id: string;
  readonly controls?: {
    readonly reasoning?: {
      readonly levels: readonly string[];
      readonly canDisable: boolean;
      readonly mandatory: boolean;
    } | undefined;
    readonly serving?: {
      readonly profiles: readonly { readonly id: string }[];
    } | undefined;
  } | undefined;
}

function parseRequestSelection(body: unknown):
  | { ok: true; selection: ModelControlSelection | null }
  | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "request body must be an object" };
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("selection" in record)) {
    return { ok: false, error: "request body must contain only selection" };
  }
  if (record["selection"] === null) return { ok: true, selection: null };
  try {
    return { ok: true, selection: parseModelControlSelection(record["selection"]) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof InvalidModelControlSelectionError
          ? error.message
          : "selection is invalid",
    };
  }
}

/**
 * Reject a syntactically-safe selection that is not valid for the active
 * signed catalog. This is intentionally before persistence: the JSONB store
 * accepts only neutral ids, while this route additionally proves those ids
 * belong to a current catalog entry and its advertised controls.
 */
function validateSelectionAgainstActiveCatalog(
  selection: ModelControlSelection,
  entries: readonly ModelControlCatalogEntry[],
): string | null {
  const entry = entries.find((candidate) => candidate.id === selection.modelId);
  if (!entry) return "selection modelId is not in the active catalog";

  if (selection.reasoningEffort !== undefined) {
    const reasoning = entry.controls?.reasoning;
    if (!reasoning) return "selection reasoningEffort is not supported by this model";
    if (selection.reasoningEffort === "off") {
      if (!reasoning.canDisable || reasoning.mandatory) {
        return "selection reasoningEffort off is not supported by this model";
      }
    } else if (!reasoning.levels.includes(selection.reasoningEffort)) {
      return "selection reasoningEffort is not supported by this model";
    }
  }

  if (selection.servingProfileId !== undefined) {
    const serving = entry.controls?.serving;
    if (!serving || !serving.profiles.some((profile) => profile.id === selection.servingProfileId)) {
      return "selection servingProfileId is not supported by this model";
    }
  }
  return null;
}

/**
 * Resolves authority before any selection read/write. A valid session must
 * own the explicitly requested Agent and both the human and Agent actors must be
 * room members. Returning 404 for a failed membership proof avoids exposing
 * another room's existence or saved preference.
 */
async function resolveAuthorizedRoomAgent(
  request: FastifyRequest<{ Params: RoomParams }>,
  findAgents: NonNullable<ModelControlSelectionRoutesDeps["findPersonalAgentsForUser"]>,
  findRoom: NonNullable<ModelControlSelectionRoutesDeps["findRoomForUserAndAgentMembers"]>,
): Promise<{ roomId: string; agentId: string } | null> {
  const userId = request.sessionUserId;
  const userActorId = request.sessionActorId;
  if (!userId || !userActorId) return null;
  const agentId = request.params.agentId;
  const owned = await findAgents(userId);
  if (!owned.some((agent) => agent.agentId === agentId)) return null;
  const room = await findRoom(request.params.roomId, userActorId, agentId);
  return room ? { roomId: request.params.roomId, agentId } : null;
}

export function modelControlSelectionRoutes(
  app: FastifyInstance,
  deps: ModelControlSelectionRoutesDeps = {},
): void {
  const findAgents = deps.findPersonalAgentsForUser ?? findPersonalAgentsForUser;
  const findRoom = deps.findRoomForUserAndAgentMembers ?? findRoomForUserAndAgentMembers;
  const getSelection =
    deps.getSelection ??
    (async (roomId: string, agentId: string): Promise<ModelControlSelection | null> => {
      const row = await getRoomAgentModelControlSelection(roomId, agentId, getServerDirectDb());
      return row?.selection ?? null;
    });
  const setSelection =
    deps.setSelection ??
    (async (roomId: string, agentId: string, selection: ModelControlSelection) => {
      const row = await upsertRoomAgentModelControlSelection(
        { roomId, agentId, selection },
        getServerDirectDb(),
      );
      return row.selection;
    });
  const resetSelection =
    deps.resetSelection ??
    (async (roomId: string, agentId: string) => {
      await resetRoomAgentModelControlSelection(roomId, agentId, getServerDirectDb());
    });
  const getCatalogEntries =
    deps.getCatalogEntries ??
    (() => getActiveModelCatalogSync().catalog.entries);
  const assertRunnableSelection =
    deps.assertRunnableSelection ??
    ((modelId: string) => assertModelRunnable(modelId, { purpose: "chat-tools" }));

  app.get<{ Params: RoomParams }>(
    "/api/rooms/:roomId/agents/:agentId/model-control-selection",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const authorized = await resolveAuthorizedRoomAgent(request, findAgents, findRoom);
      if (!authorized) return reply.code(404).send({ error: "Room not found" });
      return reply.send({ selection: await getSelection(authorized.roomId, authorized.agentId) });
    },
  );

  app.put<{ Params: RoomParams; Body: SelectionBody }>(
    "/api/rooms/:roomId/agents/:agentId/model-control-selection",
    async (request, reply) => {
      if (!request.sessionUserId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const authorized = await resolveAuthorizedRoomAgent(request, findAgents, findRoom);
      if (!authorized) return reply.code(404).send({ error: "Room not found" });
      const parsed = parseRequestSelection(request.body);
      if (!parsed.ok) return reply.code(422).send({ error: parsed.error });

      if (parsed.selection === null) {
        await resetSelection(authorized.roomId, authorized.agentId);
        return reply.send({ selection: null });
      }
      const catalogError = validateSelectionAgainstActiveCatalog(
        parsed.selection,
        getCatalogEntries(),
      );
      if (catalogError) return reply.code(422).send({ error: catalogError });
      try {
        assertRunnableSelection(parsed.selection.modelId);
      } catch (error) {
        return reply.code(422).send({
          code: "model_unavailable",
          error: error instanceof Error ? error.message : "selection model is unavailable",
        });
      }
      return reply.send({
        selection: await setSelection(authorized.roomId, authorized.agentId, parsed.selection),
      });
    },
  );
}
