import {
  actors,
  and,
  capabilities,
  eq,
  groupMembers,
  groupRoles,
  groups,
  isNull,
  moderationAccessAllowedSql,
  roleCapabilities,
  roles,
  roomMembers,
  rooms,
  sql,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { assertCanInvokeAgent, type ActionCapabilityAdmissionDeps } from "./action-capability-admission";
import { CAP_USE_WORKSTATION } from "./capabilities";
import { AmbiguousAgentOwnerError } from "./queries";

export type HumanTerminalSourceAuthorityDatabase = Pick<DirectDatabase, "select">;

export interface HumanTerminalSourceAuthorityInput {
  readonly humanUserId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly graphThreadId: string;
}

export interface HumanTerminalSourceAuthority {
  readonly roomId: string;
  readonly graphThreadId: string;
  readonly agentActorId: string;
}

interface HumanTerminalSourceAuthorityFacts {
  getCapabilities(database: HumanTerminalSourceAuthorityDatabase, humanUserId: string): Promise<string[]>;
  findAgentOwner(database: HumanTerminalSourceAuthorityDatabase, agentId: string): Promise<string | null>;
  accessAllowed(database: HumanTerminalSourceAuthorityDatabase, input: HumanTerminalSourceAuthorityInput): Promise<boolean>;
  findScope(database: HumanTerminalSourceAuthorityDatabase, input: HumanTerminalSourceAuthorityInput): Promise<HumanTerminalSourceAuthority | null>;
}

const productionFacts: HumanTerminalSourceAuthorityFacts = {
  async getCapabilities(database, humanUserId) {
    const rows = await database.select({ slug: capabilities.slug }).from(groupMembers)
      .innerJoin(groups, eq(groupMembers.groupId, groups.id))
      .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
      .innerJoin(roles, eq(groupRoles.roleId, roles.id))
      .innerJoin(roleCapabilities, eq(roles.id, roleCapabilities.roleId))
      .innerJoin(capabilities, eq(roleCapabilities.capabilityId, capabilities.id))
      .where(eq(groupMembers.userId, humanUserId));
    return [...new Set(rows.map(row => row.slug))];
  },
  async findAgentOwner(database, agentId) {
    const rows = await database.select({ userId: users.id }).from(actors)
      .innerJoin(users, eq(users.id, actors.ownerId))
      .where(and(eq(actors.kind, "agent"), eq(actors.agentId, agentId))).limit(2);
    if (rows.length > 1) throw new AmbiguousAgentOwnerError();
    return rows[0]?.userId ?? null;
  },
  async accessAllowed(database, input) {
    const [row] = await database.select({ id: users.id }).from(users).where(and(
      eq(users.id, input.humanUserId),
      isNull(users.disabledAt),
      moderationAccessAllowedSql(sql`${users.id}`, sql`${input.roomId}::uuid`),
    )).limit(1);
    return row !== undefined;
  },
  async findScope(database, input) {
    const [human] = await database.select({ id: actors.id }).from(actors).where(and(
      eq(actors.kind, "user"), eq(actors.ownerId, input.humanUserId),
    )).limit(1);
    if (!human) return null;
    const [room] = await database.select({ id: rooms.id, graphThreadId: rooms.graphThreadId }).from(rooms)
      .innerJoin(roomMembers, and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.actorId, human.id)))
      .where(and(eq(rooms.id, input.roomId), eq(rooms.graphThreadId, input.graphThreadId))).limit(1);
    if (!room) return null;
    const [agent] = await database.select({ actorId: actors.id }).from(actors)
      .innerJoin(roomMembers, and(eq(roomMembers.actorId, actors.id), eq(roomMembers.roomId, room.id)))
      .where(and(eq(actors.kind, "agent"), eq(actors.agentId, input.agentId))).limit(1);
    return agent ? { roomId: room.id, graphThreadId: room.graphThreadId, agentActorId: agent.actorId } : null;
  },
};

/** Resolve the current Human, Room, Agent, moderation, capability, and source
 * thread facts through one caller-owned database handle. */
export async function readHumanTerminalSourceAuthority(
  database: HumanTerminalSourceAuthorityDatabase,
  input: HumanTerminalSourceAuthorityInput,
): Promise<HumanTerminalSourceAuthority | null> {
  const facts = productionFacts;
  let capabilitiesPromise: Promise<string[]> | undefined;
  const getCapabilities = () => capabilitiesPromise
    ?? (capabilitiesPromise = facts.getCapabilities(database, input.humanUserId));
  const admissionDeps: ActionCapabilityAdmissionDeps = {
    getUserCapabilities: getCapabilities,
    findAgentOwnerUserId: agentId => facts.findAgentOwner(database, agentId),
    isInvocationAccessAllowed: () => facts.accessAllowed(database, input),
  };
  await assertCanInvokeAgent({ humanUserId: input.humanUserId, agentId: input.agentId,
    roomId: input.roomId, origin: "room_message" }, admissionDeps);
  if (!(await getCapabilities()).includes(CAP_USE_WORKSTATION)) return null;
  return facts.findScope(database, input);
}
