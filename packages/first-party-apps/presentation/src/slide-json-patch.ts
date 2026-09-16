/** Data-only JSON Pointer edits. Paths describe native data, not a list of
 * permitted creative actions. The caller validates the complete resulting model
 * and commits it once through the ordinary document authority. */
export class SlidePatchError extends Error {
  readonly code = "invalid_patch";
  constructor(message: string, readonly operationIndex: number, readonly path?: string) {
    super(message);
  }
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function tokens(raw: unknown): string[] {
  if (typeof raw !== "string" || (raw !== "" && !raw.startsWith("/")))
    throw new Error("path must be an empty root pointer or start with /");
  if (raw === "") return [];
  return raw.slice(1).split("/").map(part => {
    if (/~(?:[^01]|$)/.test(part)) throw new Error("invalid JSON Pointer escape");
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (["__proto__", "prototype", "constructor"].includes(decoded))
      throw new Error("prototype access is not document data");
    return decoded;
  });
}

function arrayIndex(key: string, length: number, append: boolean): number {
  if (append && key === "-") return length;
  if (!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("array index must be canonical and non-negative");
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index > length || (!append && index === length))
    throw new Error("array index is outside the observed array");
  return index;
}

function member(node: unknown, key: string): unknown {
  if (Array.isArray(node)) return node[arrayIndex(key, node.length, false)];
  if (!isObject(node) || !Object.hasOwn(node, key)) throw new Error("pointer does not identify an existing value");
  return node[key];
}

function read(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>(member, root);
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => same(value, right[index]));
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
}

function change(root: unknown, path: string[], action: "add" | "replace" | "remove", value?: unknown): unknown {
  if (path.length === 0) return action === "remove" ? undefined : structuredClone(value);
  const parent = read(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length, action === "add");
    if (action === "add") parent.splice(index, 0, structuredClone(value));
    else if (action === "remove") parent.splice(index, 1);
    else parent[index] = structuredClone(value);
  } else {
    if (!isObject(parent)) throw new Error("pointer parent must be an object or array");
    if (action !== "add" && !Object.hasOwn(parent, key)) throw new Error("pointer does not identify an existing value");
    if (action === "remove") delete parent[key];
    else parent[key] = structuredClone(value);
  }
  return root;
}

/** Atomic in memory: the source is never mutated, including on a failed test. */
export function patchSlideJson(source: unknown, changes: unknown): { value: unknown; paths: string[] } {
  if (!Array.isArray(changes) || changes.length === 0)
    throw new SlidePatchError("changes must contain at least one patch operation", 0);
  let result = structuredClone(source);
  const paths = new Set<string>();
  for (const [index, raw] of changes.entries()) {
    try {
      if (!isObject(raw)) throw new Error("patch operation must be an object");
      const path = tokens(raw["path"]);
      const op = raw["op"];
      if (op === "add" || op === "replace" || op === "test") {
        if (!Object.hasOwn(raw, "value")) throw new Error(`${op} requires value`);
        if (op === "test") {
          if (!same(read(result, path), raw["value"])) throw new Error("test precondition failed; inspect the addressed value again");
        } else result = change(result, path, op, raw["value"]);
      } else if (op === "remove") {
        result = change(result, path, "remove");
      } else if (op === "copy" || op === "move") {
        const from = tokens(raw["from"]);
        const value = structuredClone(read(result, from));
        if (op === "move") {
          if (path.length > from.length && from.every((key, part) => path[part] === key))
            throw new Error("cannot move a value into its own descendant");
          result = change(result, from, "remove");
          paths.add(raw["from"] as string);
        }
        result = change(result, path, "add", value);
      } else throw new Error("patch op must be add, remove, replace, move, copy or test");
      if (op !== "test") paths.add(raw["path"] as string);
    } catch (error) {
      throw new SlidePatchError(error instanceof Error ? error.message : String(error), index,
        isObject(raw) && typeof raw["path"] === "string" ? raw["path"] : undefined);
    }
  }
  return { value: result, paths: [...paths] };
}
