export type DirectoryEntry = {
  kind: "user" | "agent";
  id: string;
  handle: string;
  displayName: string;
  agentOwnerUserId?: string;
  agentOwnerHandle?: string | null;
  agentOwnerDisplayName?: string | null;
  lastContactAt: string | null;
  actionable: boolean;
  actionReason: "available" | "invoke_agents_required";
};

export const DIRECTORY_PAGE_SIZE = 50;

export function directoryKindsForViewer(
  _canInvokeAgents: boolean,
): readonly ("user" | "agent")[] {
  return ["user", "agent"];
}

export function filterDirectoryEntriesForViewer(
  entries: readonly DirectoryEntry[],
  _canInvokeAgents: boolean,
): DirectoryEntry[] {
  return entries.slice();
}

export function directoryEntryKey(entry: Pick<DirectoryEntry, "kind" | "id">): string {
  return `${entry.kind}:${entry.id}`;
}

function compareDirectoryEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  const aTime = a.lastContactAt ? Date.parse(a.lastContactAt) : Number.NaN;
  const bTime = b.lastContactAt ? Date.parse(b.lastContactAt) : Number.NaN;
  const aHasTime = Number.isFinite(aTime);
  const bHasTime = Number.isFinite(bTime);
  if (aHasTime && bHasTime && aTime !== bTime) return bTime - aTime;
  if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
  const handleOrder = a.handle.localeCompare(b.handle, undefined, { sensitivity: "base" });
  if (handleOrder !== 0) return handleOrder;
  return directoryEntryKey(a).localeCompare(directoryEntryKey(b));
}

/** Merge independently paged Human and Genie streams into one stable virtual list. */
export function mergeDirectoryEntries(
  current: readonly DirectoryEntry[],
  incoming: readonly DirectoryEntry[],
): DirectoryEntry[] {
  const byKey = new Map<string, DirectoryEntry>();
  for (const entry of current) byKey.set(directoryEntryKey(entry), entry);
  for (const entry of incoming) byKey.set(directoryEntryKey(entry), entry);
  return [...byKey.values()].sort(compareDirectoryEntries);
}
