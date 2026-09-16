import type {
  AuthorityClosureNode,
  AuthorityClosureNodePort,
  AuthorityClosureResult,
} from "./authority-contracts";

interface ClosureCheckpoint {
  readonly version: 1;
  readonly rootRecordRef: string;
  pendingRecordRefs: string[];
  visitedRecordRefs: string[];
  nodes: AuthorityClosureNode[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function parseCheckpoint(value: string, rootRecordRef: string): ClosureCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Authority closure checkpoint is invalid");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("version" in parsed)
    || parsed.version !== 1
    || !("rootRecordRef" in parsed)
    || parsed.rootRecordRef !== rootRecordRef
    || !("pendingRecordRefs" in parsed)
    || !Array.isArray(parsed.pendingRecordRefs)
    || !("visitedRecordRefs" in parsed)
    || !Array.isArray(parsed.visitedRecordRefs)
    || !("nodes" in parsed)
    || !Array.isArray(parsed.nodes)
  ) throw new TypeError("Authority closure checkpoint is invalid");
  return parsed as ClosureCheckpoint;
}

function deriveClosure(
  recordRef: string,
  nodes: ReadonlyMap<string, AuthorityClosureNode>,
  visiting: Set<string>,
  memo: Map<string, string[]>,
): string[] | "cycle" | "missing" | "mismatch" {
  const memoized = memo.get(recordRef);
  if (memoized !== undefined) return memoized;
  if (visiting.has(recordRef)) return "cycle";
  const node = nodes.get(recordRef);
  if (node === undefined) return "missing";
  visiting.add(recordRef);
  const handles = [...node.directAuthorityLeafHandles];
  for (const childRecordRef of node.childRecordRefs) {
    const child = deriveClosure(childRecordRef, nodes, visiting, memo);
    if (typeof child === "string") return child;
    handles.push(...child);
  }
  visiting.delete(recordRef);
  const closure = sortedUnique(handles);
  if (
    JSON.stringify(closure)
    !== JSON.stringify(sortedUnique(node.declaredTerminalAuthorityLeafHandles))
  ) return "mismatch";
  memo.set(recordRef, closure);
  return closure;
}

/** Complete checkpointed traversal; declared inventories are caches only. */
export async function advanceTerminalAuthorityClosure(input: Readonly<{
  rootRecordRef: string;
  nodes: AuthorityClosureNodePort;
  maxVisitedRecords: number;
  continuation?: string;
}>): Promise<AuthorityClosureResult> {
  if (!Number.isSafeInteger(input.maxVisitedRecords) || input.maxVisitedRecords < 1) {
    throw new RangeError("Authority closure budget requires at least one Record");
  }
  const checkpoint = input.continuation === undefined
    ? {
        version: 1 as const,
        rootRecordRef: input.rootRecordRef,
        pendingRecordRefs: [input.rootRecordRef],
        visitedRecordRefs: [],
        nodes: [],
      }
    : parseCheckpoint(input.continuation, input.rootRecordRef);
  const visited = new Set(checkpoint.visitedRecordRefs);
  let work = 0;
  while (checkpoint.pendingRecordRefs.length > 0 && work < input.maxVisitedRecords) {
    const recordRef = checkpoint.pendingRecordRefs.pop()!;
    if (visited.has(recordRef)) continue;
    const read = await input.nodes.readNode(recordRef);
    if (read.status === "unavailable") {
      return { status: "unavailable", reason: "record_unavailable" };
    }
    if (read.node.recordRef !== recordRef) {
      return { status: "unavailable", reason: "record_unavailable" };
    }
    visited.add(recordRef);
    checkpoint.visitedRecordRefs.push(recordRef);
    checkpoint.nodes.push({
      ...read.node,
      childRecordRefs: sortedUnique(read.node.childRecordRefs),
      directAuthorityLeafHandles: sortedUnique(read.node.directAuthorityLeafHandles),
      declaredTerminalAuthorityLeafHandles: sortedUnique(
        read.node.declaredTerminalAuthorityLeafHandles,
      ),
    });
    checkpoint.pendingRecordRefs.push(
      ...sortedUnique(read.node.childRecordRefs).reverse(),
    );
    work += 1;
  }
  if (checkpoint.pendingRecordRefs.length > 0) {
    return {
      status: "paused",
      continuation: JSON.stringify(checkpoint),
      visitedRecords: visited.size,
    };
  }
  const nodes = new Map(checkpoint.nodes.map((node) => [node.recordRef, node]));
  const closure = deriveClosure(
    input.rootRecordRef,
    nodes,
    new Set(),
    new Map(),
  );
  if (closure === "cycle") return { status: "unavailable", reason: "dependency_cycle" };
  if (closure === "mismatch") {
    return { status: "unavailable", reason: "declared_closure_mismatch" };
  }
  if (closure === "missing") return { status: "unavailable", reason: "record_unavailable" };
  if (closure.length === 0) return { status: "unavailable", reason: "no_authority_leaves" };
  return {
    status: "complete",
    terminalAuthorityLeafHandles: closure,
    visitedRecords: visited.size,
  };
}
