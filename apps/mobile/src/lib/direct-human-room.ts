import type { RoomMemberDto } from "@nautilo/types";

/**
 * A direct Human conversation is a settled roster of exactly two Humans and
 * no Agents. Room kind is deliberately not part of this decision: persisted
 * group-kind rooms can still be a simple Human ↔ Human conversation.
 */
export function isDirectHumanRoom(members: readonly RoomMemberDto[]): boolean {
  if (members.length !== 2) return false;
  return (
    members.every((member) => member.kind === "user") &&
    new Set(members.map((member) => member.actorId)).size === 2
  );
}

/** Exact dormant personal/direct Human-Agent conversation. */
export function isDirectAgentRoom(members: readonly RoomMemberDto[]): boolean {
  if (members.length !== 2 || new Set(members.map((member) => member.actorId)).size !== 2) {
    return false;
  }
  return members.filter((member) => member.kind === "user").length === 1 &&
    members.filter((member) => member.kind === "agent").length === 1;
}
