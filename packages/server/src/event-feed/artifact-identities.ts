import { actors, agents, profiles, rooms, users, and, eq, inArray, isNull } from "@nautilo/db";
import type { WorkspaceArtifactCreatedFact } from "@nautilo/agent";
import { getServerDirectDb } from "../lib/server-direct-db";

type ArtifactFeedAuthorRow = Readonly<{ actorId: string; userId: string }>;
type ArtifactCreationRoomRow = Readonly<Pick<typeof rooms.$inferSelect, "id" | "kind">>;

/** Schema-valid duplicate identities are ambiguous, so attribution fails closed. */
export function projectExactArtifactFeedAuthor(
  rows: readonly ArtifactFeedAuthorRow[],
  kind: WorkspaceArtifactCreatedFact["actor"]["kind"],
) {
  return rows.length === 1 ? { ...rows[0]!, kind } : null;
}

export async function resolveArtifactFeedAuthor(actor: WorkspaceArtifactCreatedFact["actor"]) {
  const rows = await getServerDirectDb().select({ actorId: actors.id, userId: actors.ownerId })
    .from(actors).where(actor.kind === "human"
      ? and(eq(actors.kind, "user"), eq(actors.ownerId, actor.userId))
      : and(eq(actors.kind, "agent"), eq(actors.agentId, actor.agentId)));
  return projectExactArtifactFeedAuthor(rows, actor.kind);
}

export async function resolveArtifactFeedPeople(actorIds: readonly string[]) {
  if (!actorIds.length) return [];
  return (await getServerDirectDb().select({ userId: actors.ownerId }).from(actors)
    .where(and(eq(actors.kind, "user"), inArray(actors.id, [...actorIds])))).map(row => row.userId);
}

export async function resolveArtifactCreationRoom(namespaceId: string) {
  // Subthreads inherit a Namespace. Only its top-level conversational owner
  // is a creation destination; access/task containers are not user additions.
  const rows = await getServerDirectDb().select({ id: rooms.id, kind: rooms.kind }).from(rooms)
    .where(and(eq(rooms.namespaceId, namespaceId), isNull(rooms.parentRoomId)));
  return projectExactArtifactCreationRoom(rows);
}

/** A Namespace must resolve to exactly one eligible top-level Room. */
export function projectExactArtifactCreationRoom(
  rows: readonly ArtifactCreationRoomRow[],
): string | null {
  if (rows.length !== 1) return null;
  const room = rows[0]!;
  return room.kind !== "access" && room.kind !== "task" ? room.id : null;
}

/** Read-only names for own-feed actor references under current directory rules:
 * active local Humans and basic Genie identity. Never load Room/content names. */
export async function resolveArtifactFeedActorNames(actorIds: readonly string[]) {
  if (!actorIds.length) return new Map<string, string>();
  const db = getServerDirectDb();
  const humanRows = await db.select({ id: actors.id, name: users.name }).from(actors)
    .innerJoin(users, eq(users.id, actors.ownerId))
    .where(and(inArray(actors.id, [...actorIds]), eq(actors.kind, "user"), isNull(users.server), isNull(users.disabledAt)));
  const agentRows = await db.select({ id: actors.id, name: profiles.name }).from(actors)
    .innerJoin(agents, eq(agents.id, actors.agentId))
    .leftJoin(profiles, eq(profiles.agentId, agents.id))
    .where(and(inArray(actors.id, [...actorIds]), eq(actors.kind, "agent")));
  return new Map([...humanRows, ...agentRows].map(row => [row.id, row.name ?? "Genie"]));
}
