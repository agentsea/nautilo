/**
 * D379 — shared commands resolution seam. Mirrors the skills resolver:
 * merges official bundled commands with speaker-scoped DB rows (DB shadows
 * official by name — copy-on-write). Used by the server-side expander so a
 * bundled command is invocable via `/name` even when not customized in the DB.
 */

import { getCommandByName, type CommandBody } from "@nautilo/db";
import { getBundledCommand, type BundledCommand } from "./bundled";

function bundledToCommandBody(cmd: BundledCommand): CommandBody {
  return {
    id: cmd.id,
    name: cmd.name,
    description: cmd.description,
    body: cmd.body,
  };
}

/**
 * Pure merge: official base, DB rows shadow by `name`, DB-only rows appended.
 * Returns sorted by `name` ascending with no duplicate names.
 */
export function mergeOfficialWithDbRows(
  official: CommandBody[],
  dbRows: CommandBody[],
): CommandBody[] {
  const byName = new Map<string, CommandBody>();

  for (const cmd of official) {
    byName.set(cmd.name, cmd);
  }

  for (const row of dbRows) {
    byName.set(row.name, row);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveByName(
  agentId: string,
  userId: string,
  name: string,
  opts: { isGuest: boolean },
): Promise<CommandBody | null> {
  if (opts.isGuest) return null;

  const row = await getCommandByName(agentId, userId, name);
  if (row) {
    if (!row.enabled) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      body: row.body,
    };
  }

  const bundled = getBundledCommand(name);
  return bundled ? bundledToCommandBody(bundled) : null;
}
