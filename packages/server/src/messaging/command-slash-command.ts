/**
 * D379 — `/name [args]` user command expansion (inline, multi-command).
 *
 * Commands are prebaked prompts — plain text macros. Any `/name` token at a
 * word boundary (start of message OR immediately after whitespace) that
 * resolves to a known command is replaced IN PLACE by that command's body.
 * You can string several together and interleave them with your own prose;
 * surrounding text is preserved as context.
 *
 * `$ARGUMENTS` in a body is filled with the text that follows the command
 * token, up to the next `/command` token or newline (trimmed). That trailing
 * span is consumed into the body. If the body has no `$ARGUMENTS` token and a
 * trailing span exists, the span is appended after the body (nothing is lost).
 *
 * Unknown/unresolved `/foo`, mid-word slashes (`src/foo`, `and/or`), and
 * client commands (`/undo`) are left UNCHANGED and flow to the normal pipeline.
 *
 * Resolved at message-dispatch time in `dispatchRoomMessageSend`, before the
 * LLM job is enqueued, so the expanded body lands in the user turn.
 */

import { resolveCommandByName } from "@nautilo/agent";

/** Command slug shape — matches skill names per the slash-commands spec. */
const COMMAND_NAME_RE = /^[a-z0-9-]+$/;

/**
 * Word-boundary `/name` token: preceded by start-of-string or whitespace
 * (lookbehind, so the boundary char is not consumed). Global for scanning.
 */
const COMMAND_TOKEN_RE = /(?:^|(?<=\s))\/([a-z0-9-]+)/gi;

export interface CommandTokenMatch {
  /** Lowercased command name. */
  name: string;
  /** Index of the leading `/` in the source content. */
  start: number;
  /** Index just past the `/name` token. */
  end: number;
}

/** Scan content for every word-boundary `/name` token, in order. */
export function scanCommandTokens(content: string): CommandTokenMatch[] {
  const out: CommandTokenMatch[] = [];
  for (const m of content.matchAll(COMMAND_TOKEN_RE)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!COMMAND_NAME_RE.test(name)) continue;
    const start = m.index ?? 0;
    out.push({ name, start, end: start + m[0].length });
  }
  return out;
}

/**
 * Build the user-turn text for a resolved command. `$ARGUMENTS` tokens are
 * replaced with `trailingText` (all occurrences); if the body has no
 * `$ARGUMENTS` and `trailingText` is non-empty, it is appended on a new line.
 */
export function formatCommandSlashUserMessage(
  command: { name: string; body: string },
  trailingText: string,
): string {
  if (command.body.includes("$ARGUMENTS")) {
    return command.body.replaceAll("$ARGUMENTS", trailingText).trim();
  }
  if (trailingText.length > 0) {
    return `${command.body}\n\n${trailingText}`.trim();
  }
  return command.body.trim();
}

export interface ResolveCommandSlashCommandResult {
  /** Content to persist and send to the agent (expanded or unchanged). */
  content: string;
  /** True when at least one `/name` command was expanded. */
  handled: boolean;
}

/**
 * Expand every resolvable `/name` command in `content`, in place. Speaker-scoped
 * via `(agentId, userId)`. Returns the original content unchanged (handled:false)
 * when nothing resolves — so `/undo`, unknown names, and plain text pass through.
 */
export async function resolveCommandSlashCommandContent(
  content: string,
  agentId: string,
  userId: string,
  opts?: { isGuest?: boolean },
): Promise<ResolveCommandSlashCommandResult> {
  const tokens = scanCommandTokens(content);
  if (tokens.length === 0) {
    return { content, handled: false };
  }

  const isGuest = opts?.isGuest ?? false;

  // Resolve each distinct name once.
  const uniqueNames = [...new Set(tokens.map((t) => t.name))];
  const resolved = new Map<string, { name: string; body: string } | null>();
  await Promise.all(
    uniqueNames.map(async (name) => {
      const cmd = await resolveCommandByName(agentId, userId, name, { isGuest });
      resolved.set(name, cmd ? { name: cmd.name, body: cmd.body } : null);
    }),
  );

  let out = "";
  let cursor = 0;
  let handled = false;
  let lastWasExpansion = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const cmd = resolved.get(tok.name);
    if (!cmd) continue; // unresolved → leave literal; emitted with surrounding text

    // Emit untouched text between the cursor and this token. When two
    // expansions are adjacent (no surviving text between them), insert a blank
    // line so the bodies don't run together.
    const between = content.slice(cursor, tok.start);
    if (between.length > 0) {
      out += between;
    } else if (lastWasExpansion && out.length > 0 && !out.endsWith("\n")) {
      out += "\n\n";
    }

    // A command WITH `$ARGUMENTS` consumes the trailing text (up to the next
    // command token OR next newline OR end) as its argument. A command WITHOUT
    // `$ARGUMENTS` is a pure macro: it consumes nothing and leaves the
    // surrounding prose untouched.
    let argEnd = tok.end;
    let argSpan = "";
    if (cmd.body.includes("$ARGUMENTS")) {
      const nextTokenStart = tokens[i + 1]?.start ?? content.length;
      // A LEADING command (first token, only whitespace before it) takes the
      // WHOLE remainder as its argument — including newlines — up to the next
      // command. This is the standard "the rest of the message is the
      // argument" behavior, so a leading command can carry a multi-line block
      // (e.g. text to rewrite). A mid-sentence / inline command instead stops
      // at the next newline so it doesn't swallow unrelated following lines.
      const isLeading = i === 0 && content.slice(0, tok.start).trim() === "";
      if (isLeading) {
        argEnd = Math.min(nextTokenStart, content.length);
      } else {
        const nlIdx = content.indexOf("\n", tok.end);
        argEnd = Math.min(
          nextTokenStart,
          nlIdx === -1 ? content.length : nlIdx,
          content.length,
        );
      }
      argSpan = content.slice(tok.end, argEnd).trim();
    }

    out += formatCommandSlashUserMessage(cmd, argSpan);
    cursor = argEnd;
    handled = true;
    lastWasExpansion = true;
  }

  if (!handled) {
    return { content, handled: false };
  }

  out += content.slice(cursor);
  return { content: out, handled: true };
}
