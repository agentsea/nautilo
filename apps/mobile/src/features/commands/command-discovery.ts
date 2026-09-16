// D501 Phase 5.1/5.3 — shared mobile slash-command discovery.
//
// The server is the authority for both membership and enabled state. This
// module only identifies a currently typed command token and ranks the
// already-authorized catalogue; it never expands or otherwise executes a
// command locally.
import type { CommandListItem } from "@nautilo/api-client/browser";

export type CommandQuery = {
  /** Name text after the active slash, without the slash itself. */
  query: string;
  /** Start offset of the active `/name` token. */
  start: number;
};

/** Desktop-equivalent trigger: start of input or immediately after whitespace. */
const ACTIVE_COMMAND_RE = /(?:^|\s)\/([A-Za-z0-9-]*)$/;

/**
 * Return the command token being typed at the end of the native input.
 * Mid-word slashes (for example `src/foo` and `and/or`) intentionally do not
 * trigger discovery, matching the server's command token boundary.
 */
export function activeCommandQuery(text: string): CommandQuery | null {
  const match = text.match(ACTIVE_COMMAND_RE);
  if (!match) return null;
  const token = match[0] ?? "";
  return {
    query: match[1] ?? "",
    start: text.length - token.length + (token.startsWith("/") ? 0 : 1),
  };
}

/** Enabled commands only, ranked exactly like the desktop composer adapter. */
export function filterCommands(
  commands: readonly CommandListItem[],
  query: string,
): CommandListItem[] {
  const enabled = commands.filter((command) => command.enabled);
  const q = query.trim().toLowerCase();
  if (!q) return enabled.slice(0, 8);

  const prefixMatches = enabled.filter((command) =>
    command.name.toLowerCase().startsWith(q),
  );
  const prefixNames = new Set(prefixMatches.map((command) => command.name));
  const descriptionMatches = enabled.filter(
    (command) =>
      !prefixNames.has(command.name) &&
      command.description.toLowerCase().includes(q),
  );
  return [...prefixMatches, ...descriptionMatches].slice(0, 8);
}

/** Replace only the active token, leaving surrounding draft text untouched. */
export function insertCommand(text: string, command: Pick<CommandListItem, "name">): string {
  const active = activeCommandQuery(text);
  if (!active) return text;
  return `${text.slice(0, active.start)}/${command.name} `;
}
