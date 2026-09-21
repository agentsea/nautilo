import { canonicalizeComputerUseJson } from "@nautilo/computer-use-contracts";
import type { ComputerNativeControlCollection } from "@nautilo/computer-use-contracts/native";

type Row = ComputerNativeControlCollection["controls"][number];
type Ancestor = Pick<Row, "role" | "label">;

function describe(rows: readonly Row[]) {
  const byId = new Map(rows.map(row => [row.id, row]));
  return rows.map(row => {
    const ancestors: Ancestor[] = [];
    const visited = new Set([row.id]);
    let parent = row.parent;
    let valid = byId.size === rows.length;
    while (parent !== undefined) {
      const ancestor = byId.get(parent);
      if (!ancestor || visited.has(parent)) { valid = false; break; }
      visited.add(parent);
      ancestors.push({ role: ancestor.role, ...(ancestor.label === undefined ? {} : { label: ancestor.label }) });
      parent = ancestor.parent;
    }
    const { target: _target, ...evidence } = row;
    const { id: _id, parent: _parent, ...semantic } = evidence;
    return { row: evidence, ancestors, key: valid ? JSON.stringify(canonicalizeComputerUseJson({ semantic, ancestors })) : null };
  });
}

/**
 * Model-only multiset difference, never cross-snapshot target identity.
 * Equal semantic rows cancel one occurrence each, not every duplicate. Order
 * and snapshot-local IDs are not comparable; current snapshots retain both.
 * Unmatched rows in partial observations do not prove creation or deletion.
 */
export function nativeObservationDelta(before: readonly Row[], after: readonly Row[]) {
  const previous = describe(before);
  const current = describe(after);
  const remaining = new Map<string, number>();
  for (const entry of previous) if (entry.key !== null) remaining.set(entry.key, (remaining.get(entry.key) ?? 0) + 1);
  const matched = new Map<string, number>();
  const addedOrChanged = current.filter(entry => {
    const count = entry.key === null ? 0 : remaining.get(entry.key) ?? 0;
    if (!count || entry.key === null) return true;
    remaining.set(entry.key, count - 1);
    matched.set(entry.key, (matched.get(entry.key) ?? 0) + 1);
    return false;
  });
  const removedOrChanged = previous.filter(entry => {
    const count = entry.key === null ? 0 : matched.get(entry.key) ?? 0;
    if (!count || entry.key === null) return true;
    matched.set(entry.key, count - 1);
    return false;
  });
  const project = ({ row, ancestors, key }: typeof current[number]) => ({ ...row, ancestors, ancestryComplete: key !== null });
  return {
    comparison: "semantic_multiset" as const,
    identity: "not_inferred" as const,
    unmatchedMeaning: "Different observed content, not proof of creation, deletion, or persistent control identity.",
    sameSemanticOccurrences: after.length - addedOrChanged.length,
    addedOrChanged: addedOrChanged.map(project),
    removedOrChanged: removedOrChanged.map(project),
  };
}
