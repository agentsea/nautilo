/**
 * D379 — composer slash-command typeahead adapter.
 *
 * Mirrors the @-mention adapter. The picker fires wherever assistant-ui's
 * native `detectTrigger` sees a `/` at the start of the input OR immediately
 * after whitespace (so `/intro` mid-sentence works, but `src/foo` and `and/or`
 * do NOT trigger). Esc or typing past the token dismisses it. Selection inserts
 * plain `/<name> ` text; the server send path remains the source of truth for
 * expanding slash commands.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  Unstable_TriggerAdapter,
  Unstable_TriggerCategory,
  Unstable_TriggerItem,
  Unstable_DirectiveFormatter,
  Unstable_DirectiveSegment,
} from "@assistant-ui/core";
import { fetchCommands, type CommandListItem } from "../../lib/commands-api";

const NO_CATEGORIES: readonly Unstable_TriggerCategory[] = [];

export function useCommandAdapter(): Unstable_TriggerAdapter {
  const [commands, setCommands] = useState<readonly CommandListItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    void fetchCommands()
      .then((res) => {
        if (!cancelled) setCommands(res.commands.filter((command) => command.enabled));
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const allRanked = commands.map(commandToTriggerItem);

    return {
      categories: () => NO_CATEGORIES,
      categoryItems: () => [],
      search: (query: string) => {
        const q = query.trim().toLowerCase();
        if (!q) return allRanked.slice(0, 8);

        const prefixMatches = allRanked.filter((item) =>
          item.id.toLowerCase().startsWith(q),
        );
        const prefixIds = new Set(prefixMatches.map((item) => item.id));
        const descriptionMatches = allRanked.filter(
          (item) =>
            !prefixIds.has(item.id) &&
            (item.description?.toLowerCase().includes(q) ?? false),
        );

        return [...prefixMatches, ...descriptionMatches].slice(0, 8);
      },
    };
  }, [commands]);
}

export const commandSlashFormatter: Unstable_DirectiveFormatter = {
  serialize(item) {
    return serializePlainDirective(item);
  },
  parse(text) {
    return parsePlainDirectives(text);
  },
};

function serializePlainDirective(item: Unstable_TriggerItem): string {
  return item.type === "command" ? `/${item.id} ` : `@${item.id} `;
}

function parsePlainDirectives(text: string): Unstable_DirectiveSegment[] {
  const segments: Unstable_DirectiveSegment[] = [];
  const directiveRe = /(^|\s)([@/])([A-Za-z0-9_-]+)(?=$|\s)/g;
  let cursor = 0;
  for (const match of text.matchAll(directiveRe)) {
    const prefix = match[1] ?? "";
    const marker = match[2];
    const id = match[3];
    if (!marker || !id) continue;

    const directiveStart = match.index + prefix.length;
    if (directiveStart > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, directiveStart) });
    }
    segments.push({
      kind: "mention",
      id,
      label: id,
      type: marker === "/" ? "command" : "user",
    });
    cursor = directiveStart + marker.length + id.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

function commandToTriggerItem(command: CommandListItem): Unstable_TriggerItem {
  return {
    id: command.name,
    type: "command",
    label: command.name,
    description: command.description,
  };
}
