/**
 * D121-P4 / D087-P2B — the 6 block-edit command handlers.
 *
 * Each command operates on an HTML5 + `<nw-*>` artifact via the
 * linkedom parser (locked in parser.ts). Mutating commands stage a
 * single `StagedPatch` through the existing D087 P1 pipeline
 * (`stageContentPatch`), stamping `blockOps[]` metadata that P7's
 * block-aware DiffView renderer consumes.
 *
 * Load-bearing principle defended here:
 *
 *   The agent never emits content it didn't author.
 *
 * Encoded by the command shapes themselves — `move_block` takes only
 * a blockId + anchor (zero content); `rewrite_block` takes a short
 * old/new pair scoped to within a single block; `replace_block` /
 * `insert_block` only receive the NEW content. No command takes a
 * search key longer than a block's serialization, and none requires
 * the agent to re-emit pre-existing content as a probe.
 *
 * Integration seam: each mutating command builds proposed newBytes
 * and calls `stageContentPatch({ ..., metadataExtra: { blockOps } })`.
 * The envelope returned from staging is decorated with the same
 * `blockOps[]` so workbench renderers don't have to dig into
 * `metadata` to pick the diff path. See `_shared.ts` for the
 * `StagedResultEnvelope.blockOps?` field.
 */

import * as fsp from "node:fs/promises";
import type { AppliedResultEnvelope, CommandResolution, DispatchContext } from "../commands/_shared";
import { applyContentPatch, encodeAppliedResult } from "../commands/_shared";
import type { FileToolRawArgs } from "../schema";
import { fileToolError } from "../file-result-status";
import {
  collectAllIds,
  findBlockById,
  findRange,
  NODE_TYPE_TEXT,
  parseArtifact,
  parseFragment,
  previewText,
  serializeArtifact,
  type ParsedDocument,
  type ParsedElement,
  type ParsedNode,
} from "./parser";
import type {
  Anchor,
  BlockOp,
  BlockOutline,
  ListBlocksOptions,
  ReplaceTarget,
  RewriteScope,
} from "./types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Read the artifact's physical bytes as a UTF-8 string. ENOENT becomes
 * an empty string so a freshly-resolved "create" path can still parse
 * to an empty document — though in practice every block command runs
 * after a successful `resolveWorkspaceArtifact({intent: "mutate"|"read"})`
 * which has already confirmed the row + bytes exist.
 */
async function readArtifactString(absPath: string): Promise<string> {
  try {
    return await fsp.readFile(absPath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT") || msg.includes("EISDIR")) return "";
    throw err;
  }
}

/**
 * After a proposed mutation has been applied to a parsed document,
 * walk all `[id]` elements and reject if any id appears more than
 * once. The duplicate check runs on the WHOLE resulting document so
 * an inserted fragment that brings its own duplicate id (with itself)
 * AND a fragment that collides with an existing block both surface.
 */
function checkIdCollisions(doc: ParsedDocument, op: string): { ok: true } | { ok: false; reason: string } {
  const { duplicates } = collectAllIds(doc);
  if (duplicates.length === 0) return { ok: true };
  return {
    ok: false,
    reason:
      `Error: ${op} would introduce duplicate id(s): ${duplicates.join(", ")}. ` +
      `Block ids are public contract — retry with unique ids per the artifact's existing id set.`,
  };
}

/**
 * Walk the document tree depth-first and emit outline nodes for every
 * element with an `id` attribute. The walker honors the request's
 * `depth` / `filter` / `includeContent` flags.
 *
 * Depth semantics (matches D121 §Editing Surface spec): `0` = top
 * level only (direct children of `<body>`); omitted = full tree.
 * The "subtree" rooted at a filter id is itself a tree, and depth
 * applies relative to that subtree's root.
 */
function buildOutline(
  root: ParsedElement,
  opts: { depth?: number; tagFilter?: string; includeContent: boolean },
  currentDepth = 0,
): BlockOutline[] {
  const out: BlockOutline[] = [];
  for (const child of root.children) {
    const id = child.getAttribute("id");
    const tag = child.tagName.toLowerCase();
    const passesTag = opts.tagFilter === undefined || tag === opts.tagFilter.toLowerCase();
    if (id !== null && id.length > 0 && passesTag) {
      const node: BlockOutline = {
        id,
        tag,
        preview: previewText(child.textContent ?? ""),
      };
      if (opts.includeContent) node.content = child.outerHTML;
      if (opts.depth === undefined || currentDepth < opts.depth) {
        const kids = buildOutline(child, opts, currentDepth + 1);
        if (kids.length > 0) node.children = kids;
      }
      out.push(node);
    } else {
      // Element without an id (or filtered out by tag) — descend so we
      // still find id-bearing grandchildren under it. They appear at
      // the current depth, not deeper, so id-less wrappers don't
      // distort the tree shape the agent sees.
      if (opts.depth === undefined || currentDepth < opts.depth) {
        const kids = buildOutline(child, opts, currentDepth);
        out.push(...kids);
      }
    }
  }
  return out;
}

/**
 * Resolve an `Anchor` to (parent, refSibling) — the arguments
 * `parent.insertBefore(node, ref)` expects. For `rel: "inside"` the
 * ref is `null` (append). For `before`/`after` the parent is the
 * anchor element's parent and the ref is the anchor (or its next
 * sibling). Returns an error if the anchor id is unknown.
 *
 * For `inside`, the parent is the anchor element itself (insert as
 * its last child).
 */
type ResolvedAnchor =
  | { ok: true; parent: ParsedElement; ref: ParsedNode | null; mode: "before" | "after" | "inside"; anchor: ParsedElement }
  | { ok: false; reason: string };

function resolveAnchor(doc: ParsedDocument, anchor: Anchor): ResolvedAnchor {
  if (!anchor || typeof anchor.id !== "string" || anchor.id.length === 0) {
    return { ok: false, reason: "anchor.id is required" };
  }
  if (anchor.rel !== "before" && anchor.rel !== "after" && anchor.rel !== "inside") {
    return { ok: false, reason: `anchor.rel must be "before" | "after" | "inside" (got ${String(anchor.rel)})` };
  }
  const el = findBlockById(doc, anchor.id);
  if (!el) return { ok: false, reason: `anchor id "${anchor.id}" not found in artifact` };
  if (anchor.rel === "inside") {
    return { ok: true, parent: el, ref: null, mode: "inside", anchor: el };
  }
  const parent = el.parentNode;
  if (!parent || !(parent as ParsedElement).tagName) {
    return { ok: false, reason: `anchor id "${anchor.id}" has no element parent` };
  }
  const ref: ParsedNode | null = anchor.rel === "before" ? el : el.nextSibling;
  return { ok: true, parent: parent as ParsedElement, ref, mode: anchor.rel, anchor: el };
}

/** Build the standard staged-result envelope plus the block-aware
 *  `blockOps[]` field that P7's renderer keys off. */
function decorateEnvelopeWithBlockOps(env: AppliedResultEnvelope, blockOps: BlockOp[]): AppliedResultEnvelope {
  return { ...env, blockOps };
}

async function applyBlockPatch(args: {
  resolution: CommandResolution;
  ctx: DispatchContext;
  command: string;
  commandArgs: Record<string, unknown>;
  newDocument: ParsedDocument;
  blockOps: BlockOp[];
  summary: string;
}): Promise<string> {
  const newHtml = serializeArtifact(args.newDocument);
  try {
    const env = await applyContentPatch({
      resolution: args.resolution,
      ctx: args.ctx,
      command: args.command,
      commandArgs: args.commandArgs,
      newBytes: Buffer.from(newHtml, "utf-8"),
      summary: args.summary,
      metadataExtra: { blockOps: args.blockOps },
    });
    if ("errorText" in env) return fileToolError(env.errorText);
    return encodeAppliedResult(decorateEnvelopeWithBlockOps(env, args.blockOps));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fileToolError(`Error applying ${args.command}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 1. list_blocks — read-only tree walk
// ---------------------------------------------------------------------------

export async function handleListBlocks(
  args: FileToolRawArgs,
  resolution: CommandResolution,
  _ctx: DispatchContext,
): Promise<string> {
  const opts: ListBlocksOptions = extractListOptions(args);
  const src = await readArtifactString(resolution.resolved);
  const doc = parseArtifact(src);

  // Determine walk root + effective filter. When `filter.id` is set the
  // walk root narrows to that subtree; the result's first level is the
  // subtree's id-bearing children at depth 0.
  let root: ParsedElement | null = doc.body;
  if (opts.filter?.id) {
    const found = findBlockById(doc, opts.filter.id);
    if (!found) {
      return fileToolError(JSON.stringify({ error: `block id "${opts.filter.id}" not found`, blocks: [] }));
    }
    root = found;
  }
  if (!root) {
    return JSON.stringify({ blocks: [] });
  }

  const blocks = buildOutline(root, {
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    ...(opts.filter?.tag ? { tagFilter: opts.filter.tag } : {}),
    includeContent: opts.includeContent === true,
  });

  return JSON.stringify({ zone: "workspace", path: args.path, blocks }, null, 2);
}

function extractListOptions(args: FileToolRawArgs): ListBlocksOptions {
  const opts: ListBlocksOptions = {};
  if (typeof args.depth === "number") opts.depth = args.depth;
  const filterId = typeof args.blockId === "string" ? args.blockId : undefined;
  const filterTag = typeof args.tagFilter === "string" ? args.tagFilter : undefined;
  if (filterId !== undefined || filterTag !== undefined) {
    opts.filter = {
      ...(filterId !== undefined ? { id: filterId } : {}),
      ...(filterTag !== undefined ? { tag: filterTag } : {}),
    };
  }
  if (args.includeContent === true) opts.includeContent = true;
  return opts;
}

// ---------------------------------------------------------------------------
// 2. read_block — sugar over list_blocks
// ---------------------------------------------------------------------------

export async function handleReadBlock(
  args: FileToolRawArgs,
  resolution: CommandResolution,
  _ctx: DispatchContext,
): Promise<string> {
  if (typeof args.blockId !== "string" || args.blockId.length === 0) {
    return fileToolError("Error: read_block requires 'blockId' (string)");
  }
  const src = await readArtifactString(resolution.resolved);
  const doc = parseArtifact(src);
  const el = findBlockById(doc, args.blockId);
  if (!el) {
    return fileToolError(`Error: block id "${args.blockId}" not found in artifact`);
  }
  return JSON.stringify(
    { zone: "workspace", path: args.path, blockId: args.blockId, tag: el.tagName.toLowerCase(), content: el.outerHTML },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// 3. replace_block — single block OR contiguous same-parent range
// ---------------------------------------------------------------------------

export async function handleReplaceBlock(
  args: FileToolRawArgs,
  resolution: CommandResolution,
  ctx: DispatchContext,
): Promise<string> {
  const target = args.target as ReplaceTarget | undefined;
  if (typeof args.newContent !== "string") {
    return fileToolError("Error: replace_block requires 'newContent' (string; empty string means delete the target)");
  }
  const validated = validateReplaceTarget(target);
  if (!validated.ok) return fileToolError(`Error: ${validated.reason}`);

  const src = await readArtifactString(resolution.resolved);
  const doc = parseArtifact(src);

  // Resolve the affected element(s).
  let affected: ParsedElement[];
  if ("block" in validated.target) {
    const el = findBlockById(doc, validated.target.block);
    if (!el) return fileToolError(`Error: block id "${validated.target.block}" not found in artifact`);
    affected = [el];
  } else {
    const r = findRange(doc, validated.target.range.from, validated.target.range.to);
    if (!r.ok) {
      if (r.reason === "from-not-found")
        return fileToolError(`Error: range.from id "${validated.target.range.from}" not found`);
      if (r.reason === "to-not-found")
        return fileToolError(`Error: range.to id "${validated.target.range.to}" not found`);
      if (r.reason === "cross-parent")
        return fileToolError(`Error: range.from "${validated.target.range.from}" and range.to "${validated.target.range.to}" are not siblings of the same parent — replace_block ranges must lie within one parent block`);
      return fileToolError(`Error: range from "${validated.target.range.from}" to "${validated.target.range.to}" is empty (to precedes from in source order)`);
    }
    affected = r.elements;
  }

  // Capture before-snapshot (joined serialization of all affected
  // siblings, no separator — matches what the source slice looked like).
  const beforeJoined = affected.map((el) => el.outerHTML).join("");

  // Parse new content. Empty string === delete.
  let insertedElements: ParsedElement[] = [];
  if (args.newContent.length > 0) {
    const fragment = parseFragment(args.newContent);
    insertedElements = fragment.elements;
    if (insertedElements.length === 0) {
      return fileToolError("Error: newContent contains no top-level elements (parsed as text-only or empty). Provide one or more element nodes.");
    }
  }

  const parent = affected[0]!.parentNode as ParsedElement | null;
  if (!parent || !parent.tagName) {
    return fileToolError("Error: target element has no element parent (cannot replace document root)");
  }
  // Capture the insertion anchor as the next sibling AFTER the LAST
  // affected element, not the first. For ranges over adjacent compact
  // siblings (no whitespace between them), `affected[0].nextSibling`
  // is `affected[1]`, which we are about to remove — that would leave
  // `insertBefore(refSibling=<detached>)` undefined behavior (parser-
  // dependent; htmlparser2 silently appends at end). Anchoring on
  // `affected[last].nextSibling` is correct in both the single-block
  // case (affected.length === 1) and the multi-block range case.
  const refSibling: ParsedNode | null = affected[affected.length - 1]!.nextSibling;

  // Remove all affected siblings BEFORE inserting so the original
  // first-element's position is reclaimed by `refSibling`-relative
  // insertion.
  for (const el of affected) el.remove();

  // Insert new elements (if any) at the captured position.
  for (const el of insertedElements) {
    parent.insertBefore(el, refSibling);
  }

  // After-mutation id-collision check.
  const collision = checkIdCollisions(doc, "replace_block");
  if (!collision.ok) return fileToolError(collision.reason);

  const afterJoined = insertedElements.map((el) => el.outerHTML).join("");
  const blockOps: BlockOp[] = [
    {
      op: "replace",
      target: validated.target,
      before: beforeJoined,
      after: afterJoined,
    },
  ];

  const isDelete = args.newContent.length === 0;
  const labelTarget =
    "block" in validated.target
      ? `block "${validated.target.block}"`
      : `range ${validated.target.range.from}..${validated.target.range.to}`;
  const summary = isDelete
    ? `Applied replace_block deleted ${labelTarget} — revertable.`
    : `Applied replace_block on ${labelTarget} (${insertedElements.length} new block${insertedElements.length === 1 ? "" : "s"}) — revertable.`;

  return await applyBlockPatch({
    resolution,
    ctx,
    command: "replace_block",
    commandArgs: { path: args.path, zone: args.zone, target: validated.target, newContent: args.newContent },
    newDocument: doc,
    blockOps,
    summary,
  });
}

function validateReplaceTarget(target: unknown): { ok: true; target: ReplaceTarget } | { ok: false; reason: string } {
  if (!target || typeof target !== "object") {
    return { ok: false, reason: "replace_block requires 'target' object" };
  }
  const t = target as Record<string, unknown>;
  const block = t["block"];
  const range = t["range"];
  if (typeof block === "string" && block.length > 0) {
    if (range !== undefined) return { ok: false, reason: "target may have 'block' OR 'range', not both" };
    return { ok: true, target: { block } };
  }
  if (range && typeof range === "object") {
    const r = range as Record<string, unknown>;
    const from = r["from"];
    const to = r["to"];
    if (typeof from !== "string" || typeof to !== "string" || from.length === 0 || to.length === 0) {
      return { ok: false, reason: "target.range requires {from: string, to: string} (non-empty ids)" };
    }
    return { ok: true, target: { range: { from, to } } };
  }
  return { ok: false, reason: "target must be {block: id} OR {range: {from, to}}" };
}

// ---------------------------------------------------------------------------
// 4. insert_block — anchor-positioned, pure additive
// ---------------------------------------------------------------------------

export async function handleInsertBlock(
  args: FileToolRawArgs,
  resolution: CommandResolution,
  ctx: DispatchContext,
): Promise<string> {
  if (typeof args.newContent !== "string" || args.newContent.length === 0) {
    return fileToolError("Error: insert_block requires non-empty 'newContent' (string)");
  }
  const anchor = args.anchor as Anchor | undefined;
  if (!anchor) return fileToolError("Error: insert_block requires 'anchor' ({rel, id})");

  const src = await readArtifactString(resolution.resolved);
  const doc = parseArtifact(src);

  const resolved = resolveAnchor(doc, anchor);
  if (!resolved.ok) return fileToolError(`Error: ${resolved.reason}`);

  const fragment = parseFragment(args.newContent);
  if (fragment.elements.length === 0) {
    return fileToolError("Error: newContent contains no top-level elements");
  }

  // Insert into the resolved (parent, ref) — same call for "inside"
  // (parent=anchor, ref=null → appendChild semantics via insertBefore).
  for (const el of fragment.elements) {
    resolved.parent.insertBefore(el, resolved.ref);
  }

  const collision = checkIdCollisions(doc, "insert_block");
  if (!collision.ok) return fileToolError(collision.reason);

  const after = fragment.elements.map((el) => el.outerHTML).join("");
  const blockOps: BlockOp[] = [{ op: "insert", anchor, before: null, after }];
  const summary = `Applied insert_block ${anchor.rel} "${anchor.id}" (${fragment.elements.length} new block${fragment.elements.length === 1 ? "" : "s"}) — revertable.`;

  return await applyBlockPatch({
    resolution,
    ctx,
    command: "insert_block",
    commandArgs: { path: args.path, zone: args.zone, anchor, newContent: args.newContent },
    newDocument: doc,
    blockOps,
    summary,
  });
}

// ---------------------------------------------------------------------------
// 5. move_block — zero content emit; the load-bearing primitive
// ---------------------------------------------------------------------------

export async function handleMoveBlock(
  args: FileToolRawArgs,
  resolution: CommandResolution,
  ctx: DispatchContext,
): Promise<string> {
  if (typeof args.blockId !== "string" || args.blockId.length === 0) {
    return fileToolError("Error: move_block requires 'blockId' (string)");
  }
  const anchor = args.anchor as Anchor | undefined;
  if (!anchor) return fileToolError("Error: move_block requires 'anchor' ({rel, id})");
  // Self-rejection for ALL `rel` values. Previously only "before"/"after"
  // were blocked; "inside" was permitted with anchor.id === blockId, which
  // attempts to make a node a child of itself — htmlparser2 doesn't enforce
  // HierarchyRequestError so the result is a silently-cyclic tree.
  if (anchor.id === args.blockId) {
    return fileToolError("Error: move_block anchor cannot reference the block being moved (would create a cycle)");
  }

  const src = await readArtifactString(resolution.resolved);
  const doc = parseArtifact(src);

  const block = findBlockById(doc, args.blockId);
  if (!block) return fileToolError(`Error: block id "${args.blockId}" not found in artifact`);
  const beforeSerialization = block.outerHTML;

  const resolved = resolveAnchor(doc, anchor);
  if (!resolved.ok) return fileToolError(`Error: ${resolved.reason}`);

  // Descendant-rejection: if the resolved insertion site is anywhere inside
  // the moving subtree, reparenting would make `block` an ancestor of
  // itself. linkedom (unlike spec DOM) does not throw HierarchyRequestError
  // here, it silently builds the cycle. Walk the parent chain from the
  // insertion-site parent upward and bail if we cross `block`.
  //
  // The loop variable starts as `ParsedNode` (since `ParsedElement extends
  // ParsedNode`). `ParsedNode.parentNode` can be a `ParsedDocument`, which
  // is the terminal of the chain — `ParsedDocument` is not a `ParsedNode`,
  // so the chain walk stops naturally when we step off the element side.
  for (
    let n: ParsedNode | null = resolved.parent;
    n !== null && (n as ParsedElement).tagName !== undefined;
    n = n.parentNode as ParsedNode | null
  ) {
    if (n === block) {
      return fileToolError(`Error: move_block anchor "${anchor.id}" is a descendant of "${args.blockId}" — moving a block inside its own subtree would create a cycle`);
    }
  }

  // CRITICAL: reparent the SAME node reference. No clone, no
  // serialize-reparse — that's how attributes (including id, custom
  // attrs, inline event handlers as text) are preserved by definition.
  // DOM spec: insertBefore on a node that already has a parent
  // removes it from its old parent automatically.
  resolved.parent.insertBefore(block, resolved.ref);

  // ID-collision check just to be defensive — moving the same node
  // can't introduce duplicates, but a hostile / buggy parser path
  // might leave a stale node behind; the check catches it cheap.
  const collision = checkIdCollisions(doc, "move_block");
  if (!collision.ok) return fileToolError(collision.reason);

  const blockOps: BlockOp[] = [{ op: "move", blockId: args.blockId, anchor, before: beforeSerialization, after: null }];
  const summary = `Applied move_block "${args.blockId}" ${anchor.rel} "${anchor.id}" (zero content emitted) — revertable.`;

  return await applyBlockPatch({
    resolution,
    ctx,
    command: "move_block",
    commandArgs: { path: args.path, zone: args.zone, blockId: args.blockId, anchor },
    newDocument: doc,
    blockOps,
    summary,
  });
}

// ---------------------------------------------------------------------------
// 6. rewrite_block — within-block surgical edit (text | attr | html)
// ---------------------------------------------------------------------------

export async function handleRewriteBlock(
  args: FileToolRawArgs,
  resolution: CommandResolution,
  ctx: DispatchContext,
): Promise<string> {
  if (typeof args.blockId !== "string" || args.blockId.length === 0) {
    return fileToolError("Error: rewrite_block requires 'blockId' (string)");
  }
  const scope: RewriteScope | undefined = args.scope;
  if (scope !== "text" && scope !== "attr" && scope !== "html") {
    return fileToolError(`Error: rewrite_block requires 'scope' in ["text", "attr", "html"] (got ${String(scope)})`);
  }
  if (typeof args.oldString !== "string") {
    return fileToolError("Error: rewrite_block requires 'oldString'");
  }
  if (typeof args.newString !== "string") {
    return fileToolError("Error: rewrite_block requires 'newString'");
  }

  const occurrence: "first" | "all" | number =
    args.occurrence === undefined ? "first" :
    args.occurrence === "first" || args.occurrence === "all" ? args.occurrence :
    typeof args.occurrence === "number" ? args.occurrence :
    "first";

  const src = await readArtifactString(resolution.resolved);
  const doc = parseArtifact(src);
  const block = findBlockById(doc, args.blockId);
  if (!block) return fileToolError(`Error: block id "${args.blockId}" not found in artifact`);

  const beforeSerialization = block.outerHTML;
  let result: { ok: true; matched: number } | { ok: false; reason: string };
  if (scope === "text") {
    result = applyTextScopeRewrite(block, args.oldString, args.newString, occurrence);
  } else if (scope === "attr") {
    result = applyAttrScopeRewrite(block, args.oldString, args.newString);
  } else {
    result = applyHtmlScopeRewrite(block, args.oldString, args.newString, occurrence);
  }

  if (!result.ok) return fileToolError(`Error: ${result.reason}`);

  const collision = checkIdCollisions(doc, "rewrite_block");
  if (!collision.ok) return fileToolError(collision.reason);

  // For scope="html" we replaced the block element wholesale; re-find
  // it (same id) to read the after-snapshot. For text/attr the node
  // identity is preserved, so block.outerHTML is the after.
  const afterBlock = scope === "html" ? findBlockById(doc, args.blockId) : block;
  const afterSerialization = afterBlock ? afterBlock.outerHTML : "";

  const blockOps: BlockOp[] = [
    {
      op: "rewrite",
      blockId: args.blockId,
      scope,
      old: args.oldString,
      new: args.newString,
      before: beforeSerialization,
      after: afterSerialization,
    },
  ];
  const summary = `Applied rewrite_block "${args.blockId}" scope=${scope} (${result.matched} match${result.matched === 1 ? "" : "es"}) — revertable.`;

  return await applyBlockPatch({
    resolution,
    ctx,
    command: "rewrite_block",
    commandArgs: {
      path: args.path,
      zone: args.zone,
      blockId: args.blockId,
      scope,
      oldString: args.oldString,
      newString: args.newString,
      ...(args.occurrence !== undefined ? { occurrence: args.occurrence } : {}),
    },
    newDocument: doc,
    blockOps,
    summary,
  });
}

/**
 * scope="text" — walk the block's descendant TextNodes only. Does NOT
 * match inside element attribute values or markup. This is the
 * primary proofreading entry point and the load-bearing-correct
 * implementation: we never serialize the block to a string and
 * string-replace, because that would let `oldString` match inside
 * `class="..."` / `data-..."..."` / opening-tag markup.
 *
 * `occurrence` semantics:
 *   - "first": replace the first match in source order.
 *   - "all":   replace every match.
 *   - number N (1-indexed): replace the Nth match only.
 *
 * Matches are counted across text-node boundaries by linear scan of
 * the concatenated text-content within each individual TextNode (we
 * do not splice across nodes — a match that straddles two TextNodes
 * is left as a no-match for v1; the agent retries with a smaller
 * snippet or `scope: "html"`).
 */
function applyTextScopeRewrite(
  block: ParsedElement,
  oldString: string,
  newString: string,
  occurrence: "first" | "all" | number,
): { ok: true; matched: number } | { ok: false; reason: string } {
  if (oldString.length === 0) {
    return { ok: false, reason: 'rewrite_block scope="text" requires non-empty oldString' };
  }
  let matched = 0;
  const textNodes: ParsedNode[] = [];
  collectTextNodes(block, textNodes);
  let occurrenceCursor = 0;
  for (const node of textNodes) {
    const txt = node.textContent ?? "";
    if (txt.length === 0) continue;
    let updated = "";
    let i = 0;
    while (i < txt.length) {
      const idx = txt.indexOf(oldString, i);
      if (idx < 0) {
        updated += txt.slice(i);
        break;
      }
      updated += txt.slice(i, idx);
      occurrenceCursor++;
      const shouldReplace =
        occurrence === "all" ||
        (occurrence === "first" && matched === 0) ||
        (typeof occurrence === "number" && occurrenceCursor === occurrence);
      if (shouldReplace) {
        updated += newString;
        matched++;
      } else {
        updated += oldString;
      }
      i = idx + oldString.length;
    }
    node.textContent = updated;
  }
  if (matched === 0) {
    return {
      ok: false,
      reason: `rewrite_block scope="text" found no match for "${oldString.slice(0, 60)}" inside block (text-node scope skips attributes + markup; use scope="html" for those).`,
    };
  }
  return { ok: true, matched };
}

function collectTextNodes(el: ParsedElement, out: ParsedNode[]): void {
  for (const child of el.childNodes) {
    if (child.nodeType === NODE_TYPE_TEXT) {
      out.push(child);
    } else if ((child as ParsedElement).tagName) {
      collectTextNodes(child as ParsedElement, out);
    }
  }
}

/**
 * scope="attr" — `old` is the attribute NAME on the block element
 * itself (not on a descendant), `new` is the new value. Setting an
 * empty `new` value writes an empty-string attribute; to REMOVE an
 * attribute, callers should use a different op. (Keeping the surface
 * tight; the agent can use `replace_block` for full attribute
 * restructuring.) `occurrence` is ignored.
 */
function applyAttrScopeRewrite(
  block: ParsedElement,
  attrName: string,
  newValue: string,
): { ok: true; matched: number } | { ok: false; reason: string } {
  if (attrName.length === 0) {
    return { ok: false, reason: 'rewrite_block scope="attr" requires non-empty oldString (the attribute name)' };
  }
  // Validate the attribute name to avoid surprise injections. linkedom
  // accepts most ASCII names; reject anything with whitespace / quotes
  // / equals signs that would imply the agent malformed an HTML
  // fragment instead of an attribute name.
  if (/[\s"'=<>/]/.test(attrName)) {
    return { ok: false, reason: `rewrite_block scope="attr" oldString "${attrName}" is not a valid attribute name` };
  }
  block.setAttribute(attrName, newValue);
  return { ok: true, matched: 1 };
}

/**
 * scope="html" — escape hatch. Serialize the block's outerHTML,
 * string-replace `old` → `new` within that string, then reparse + put
 * the resulting element back in place. Honors `occurrence`.
 *
 * Bounded to the block's serialized HTML by construction (we operate
 * on `block.outerHTML`, not the document string). Caller-beware: this
 * scope CAN match inside attributes and markup, by design — it's the
 * "I know what I'm doing" escape hatch.
 */
function applyHtmlScopeRewrite(
  block: ParsedElement,
  oldString: string,
  newString: string,
  occurrence: "first" | "all" | number,
): { ok: true; matched: number } | { ok: false; reason: string } {
  if (oldString.length === 0) {
    return { ok: false, reason: 'rewrite_block scope="html" requires non-empty oldString' };
  }
  const src = block.outerHTML;
  let updated = "";
  let i = 0;
  let occCursor = 0;
  let matched = 0;
  while (i < src.length) {
    const idx = src.indexOf(oldString, i);
    if (idx < 0) {
      updated += src.slice(i);
      break;
    }
    updated += src.slice(i, idx);
    occCursor++;
    const shouldReplace =
      occurrence === "all" ||
      (occurrence === "first" && matched === 0) ||
      (typeof occurrence === "number" && occCursor === occurrence);
    if (shouldReplace) {
      updated += newString;
      matched++;
    } else {
      updated += oldString;
    }
    i = idx + oldString.length;
  }
  if (matched === 0) {
    return { ok: false, reason: `rewrite_block scope="html" found no match for "${oldString.slice(0, 60)}" inside block` };
  }
  // Reparse the mutated block fragment, replace the original in-place.
  const fragment = parseFragment(updated);
  if (fragment.elements.length !== 1) {
    return {
      ok: false,
      reason: `rewrite_block scope="html" produced ${fragment.elements.length} top-level elements (expected exactly 1; the rewrite must keep the block as a single element)`,
    };
  }
  const replacement = fragment.elements[0]!;
  const parent = block.parentNode as ParsedElement | null;
  if (!parent || !parent.tagName) {
    return { ok: false, reason: "rewrite_block scope=\"html\" target has no element parent" };
  }
  parent.replaceChild(replacement, block);
  return { ok: true, matched };
}
