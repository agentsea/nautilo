/**
 * D263 P3 R6 — `/skill <name> [text]` user command expansion.
 *
 * Injects the named skill's body into the user-turn content (not the system
 * prompt) so prompt-cache churn is avoided. Resolved at message-dispatch time
 * in `dispatchRoomMessageSend` before the LLM job is enqueued.
 */

import { getByName } from "@nautilo/db";

/** Matches `buildSkillBodyBlock` in packages/agent/src/prompts/templates.ts */
const SKILL_BODY_HEADER_PREFIX = "\n\n## Skill: ";

/** Skill slug per R10 / SKILL_NAME_PATTERN. */
const SKILL_NAME_RE = /^[a-z0-9-]+$/;

export interface ParsedSkillSlashCommand {
  name: string;
  trailingText: string;
}

/**
 * Parse `/skill <name> [text]` when the message is a skill slash command.
 * Returns null when the line is not a `/skill` invocation.
 */
export function parseSkillSlashCommand(content: string): ParsedSkillSlashCommand | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^\/skill\s+([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  if (!SKILL_NAME_RE.test(name)) return null;
  return {
    name,
    trailingText: (match[2] ?? "").trim(),
  };
}

export function formatSkillSlashUserMessage(
  skill: { name: string; body: string },
  trailingText: string,
): string {
  let message = `${SKILL_BODY_HEADER_PREFIX}${skill.name}\n\n${skill.body}`;
  if (trailingText.length > 0) {
    message += `\n\n${trailingText}`;
  }
  return message.trim();
}

export interface ResolveSkillSlashCommandResult {
  /** Content to persist and send to the agent (expanded or error text). */
  content: string;
  /** True when the input was a `/skill` command (hit or miss). */
  handled: boolean;
}

/**
 * Expand `/skill <name> [text]` into a user message carrying the skill body.
 * Speaker-scoped via `(agentId, userId)` — cross-user skills never surface.
 */
export async function resolveSkillSlashCommandContent(
  content: string,
  agentId: string,
  userId: string,
): Promise<ResolveSkillSlashCommandResult> {
  const parsed = parseSkillSlashCommand(content);
  if (!parsed) {
    return { content, handled: false };
  }

  if (!agentId || !userId) {
    return {
      content: `Skill "${parsed.name}" not found.`,
      handled: true,
    };
  }

  try {
    const row = await getByName(agentId, userId, parsed.name);
    if (!row || !row.enabled) {
      return {
        content: `Skill "${parsed.name}" not found.`,
        handled: true,
      };
    }
    return {
      content: formatSkillSlashUserMessage(
        { name: row.name, body: row.body },
        parsed.trailingText,
      ),
      handled: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: `/skill failed: ${msg}`,
      handled: true,
    };
  }
}
