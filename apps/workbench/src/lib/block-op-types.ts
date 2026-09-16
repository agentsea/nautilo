/**
 * Workbench-side mirror of `packages/agent/src/tools/file/blocks/types.ts`
 * `BlockOp` union. The workbench does not depend on `@nautilo/agent`; keep
 * this aligned with staging output (P6) + `StagedResultEnvelope.blockOps`.
 */

export type Anchor = { rel: "before" | "after" | "inside"; id: string };

export type ReplaceTarget =
  | { block: string }
  | { range: { from: string; to: string } };

export type RewriteScope = "text" | "attr" | "html";

export type BlockOp =
  | {
      op: "replace";
      target: ReplaceTarget;
      before: string;
      after: string;
    }
  | {
      op: "insert";
      anchor: Anchor;
      before: null;
      after: string;
    }
  | {
      op: "move";
      blockId: string;
      anchor: Anchor;
      before: string;
      after: null;
    }
  | {
      op: "rewrite";
      blockId: string;
      scope: RewriteScope;
      old: string;
      new: string;
      before: string;
      after: string;
    };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function parseAnchor(raw: unknown): Anchor | null {
  if (!isRecord(raw)) return null;
  const rel = raw["rel"];
  const id = raw["id"];
  if (rel !== "before" && rel !== "after" && rel !== "inside") return null;
  if (typeof id !== "string" || !id) return null;
  return { rel, id };
}

function parseReplaceTarget(raw: unknown): ReplaceTarget | null {
  if (!isRecord(raw)) return null;
  if (typeof raw["block"] === "string" && raw["block"]) {
    return { block: raw["block"] };
  }
  const range = raw["range"];
  if (!isRecord(range)) return null;
  const from = range["from"];
  const to = range["to"];
  if (typeof from !== "string" || typeof to !== "string" || !from || !to) return null;
  return { range: { from, to } };
}

function parseRewriteScope(x: unknown): RewriteScope | null {
  if (x === "text" || x === "attr" || x === "html") return x;
  return null;
}

/** Returns `undefined` when the array is missing, empty, or malformed. */
export function parseBlockOps(raw: unknown): BlockOp[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: BlockOp[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return undefined;
    const op = item["op"];
    if (op === "replace") {
      const target = parseReplaceTarget(item["target"]);
      const before = item["before"];
      const after = item["after"];
      if (!target || typeof before !== "string" || typeof after !== "string") return undefined;
      out.push({ op: "replace", target, before, after });
    } else if (op === "insert") {
      const anchor = parseAnchor(item["anchor"]);
      const after = item["after"];
      if (!anchor || typeof after !== "string") return undefined;
      if (item["before"] != null) return undefined;
      out.push({ op: "insert", anchor, before: null, after });
    } else if (op === "move") {
      const anchor = parseAnchor(item["anchor"]);
      const blockId = item["blockId"];
      const before = item["before"];
      if (!anchor || typeof blockId !== "string" || !blockId || typeof before !== "string") {
        return undefined;
      }
      if (item["after"] != null) return undefined;
      out.push({ op: "move", blockId, anchor, before, after: null });
    } else if (op === "rewrite") {
      const blockId = item["blockId"];
      const scope = parseRewriteScope(item["scope"]);
      const oldV = item["old"];
      const newV = item["new"];
      const before = item["before"];
      const after = item["after"];
      if (
        typeof blockId !== "string" ||
        !blockId ||
        !scope ||
        typeof oldV !== "string" ||
        typeof newV !== "string" ||
        typeof before !== "string" ||
        typeof after !== "string"
      ) {
        return undefined;
      }
      out.push({ op: "rewrite", blockId, scope, old: oldV, new: newV, before, after });
    } else {
      return undefined;
    }
  }
  return out;
}
