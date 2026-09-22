import type { RoomDetailPayload } from "@nautilo/trust";
import { isUuidString, MAX_STRUCTURED_HUMAN_MENTIONS } from "@nautilo/trust";

export class StructuredHumanMentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredHumanMentionError";
  }
}

/** Strictly admit the optional structured Room-wide Human mention signal. */
export function parseMentionEveryone(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") {
    throw new StructuredHumanMentionError("mentionEveryone must be a boolean");
  }
  return raw;
}

/**
 * Validate sender-authored structured mention metadata against the canonical
 * live Room roster. Plaintext is deliberately absent from this API: Wave 1
 * never promotes an `@handle` by reparsing message bytes.
 */
export function parseStructuredHumanMentionIds(
  raw: unknown,
  room: Pick<RoomDetailPayload, "members">,
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new StructuredHumanMentionError(
      "mentionedHumanUserIds must be an array",
    );
  }

  const unique = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || !isUuidString(value)) {
      throw new StructuredHumanMentionError(
        "mentionedHumanUserIds must contain only UUIDs",
      );
    }
    unique.add(value);
    if (unique.size > MAX_STRUCTURED_HUMAN_MENTIONS) {
      throw new StructuredHumanMentionError(
        `mentionedHumanUserIds may contain at most ${MAX_STRUCTURED_HUMAN_MENTIONS} unique recipients`,
      );
    }
  }

  const currentHumanUserIds = new Set(
    room.members.flatMap((member) =>
      member.kind === "user" && member.userId ? [member.userId] : [],
    ),
  );
  for (const userId of unique) {
    if (!currentHumanUserIds.has(userId)) {
      throw new StructuredHumanMentionError(
        "mentionedHumanUserIds must identify current Human members of the room",
      );
    }
  }
  return [...unique];
}
