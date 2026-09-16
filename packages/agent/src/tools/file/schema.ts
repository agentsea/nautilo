/**
 * D079 Phase 4 / G3 — Zod schema for the `file` tool.
 *
 * IMPORTANT SHAPE NOTE (2026-04-22 live-verify fix):
 * The on-the-wire schema is a FLAT `z.object` (not a
 * `z.discriminatedUnion`) because Anthropic's tool-use API requires
 * `input_schema.type: "object"` at the top level of every tool's
 * JSON schema. `z.discriminatedUnion` serialises to
 * `{ anyOf: [...] }` with no top-level `type` field and Anthropic
 * rejects the whole tool list with:
 *   "tools.N.custom.input_schema.type: Field required"
 *
 * We keep the discriminated-union TS TYPES (`FileToolArgs`,
 * `FileCommandArgs<C>`) intact so per-command handlers stay
 * narrow-typed via the `command` discriminator at the TypeScript
 * level. Structural-correctness enforcement that used to live at
 * the Zod layer (e.g. rejecting a stray `oldString` on a `read`
 * call) moves to the handler-level mode-validation layer —
 * handlers already validated cross-field constraints
 * (mode selection for `str_replace`, `from <= to` on `lineRange`,
 * `content` required on `write`/`insert`) so the wire-layer
 * relaxation is contained.
 *
 * What the flat schema buys us:
 *   - Anthropic (and any JSON-schema-strict provider) accepts the
 *     tool without post-processing the emitted schema.
 *   - LangChain's `DynamicStructuredTool` happily validates against
 *     it and hands us a typed object at `func` time.
 *
 * What we accept as a cost:
 *   - An agent that passes `{ command: "read", oldString: "x" }`
 *     won't get a Zod-level error on the stray field (Zod strips
 *     unknown keys on plain `.object()`). The command handler
 *     still does the right thing — it only reads the fields
 *     relevant to its command — but the feedback loop is fuzzier.
 *     In practice the LLM sees the tool description's command
 *     matrix and doesn't mix fields in the first place.
 *   - Optional-field typing: every per-command required field
 *     (e.g. `query` for grep, `content` for write, `newString` for
 *     str_replace) is optional at the Zod layer; the handler
 *     rejects with a clear error if absent. See each
 *     `commands/<cmd>.ts` for the per-field required checks.
 *
 * Decision record anchor:
 *   pr-reviews/DECISION-2026-04-21-file-tool-shape.md §Command matrix
 */

import { z } from "zod";

/**
 * Zone enum schema. Matches the FsZone type in zones.ts, declared
 * here in Zod form so it can drop into every per-command sub-schema.
 * Legacy aliases (`home`, `scratch`) stay in the accepted set for
 * one release cycle then get removed.
 */
const zoneSchema = z.enum(["workspace", "current", "absolute", "home", "scratch"]);

/**
 * lineRange is used by multiple commands (read, grep, str_replace).
 * Pulled out so every command that supports it uses the same shape.
 * `from` is 1-indexed inclusive; `to` is 1-indexed inclusive.
 */
const lineRangeSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
});

/**
 * Single source of truth for valid `file` tool `command` strings.
 * Keep in sync with the `FileToolArgs` discriminated union below.
 * M067D: drives `listFileToolCommandNames()` for matrix guard tests.
 */
export const FILE_TOOL_ALL_COMMAND_NAMES = [
  "list",
  "read",
  "glob",
  "grep",
  "stat",
  "write",
  "insert",
  "str_replace",
  "move",
  "copy",
  "delete",
  // D087 Phase 3 §3.1 — history / undo commands.
  "undo",
  // D087 Phase 3 §3.2 — per-turn batch variant. Stages N reverse
  // patches across every file this agent touched in the given
  // turn. No path/zone on the args; the turn's own revision rows
  // carry the targets.
  "undo_turn",
  // D087 Phase 3 §3.3 — counterpart to undo. Walks forward one step
  // in the undo/redo timeline by restoring the most-recent revision
  // whose restore_from_revision_id is non-null. Same path+zone
  // shape as undo; no selection args (use `undo` with an explicit
  // revisionId if you want to hop non-adjacently).
  "redo",
  // D087 Phase 3 §3.4 — read-only enumeration of the agent's edit
  // history. Optional filters (path, turnId, since/until, pinned-
  // only, limit). No path/zone routing — path is a filter, not a
  // target. Routes BEFORE zone resolution.
  "list_revisions",
  // D087 Phase 3 §3.5 — protect / unprotect a revision from GC.
  // No path/zone — revisionId is the whole key.
  "pin_revision",
  "unpin_revision",
  // D121-P4 / D087-P2B — block-edit substrate. Six surgical commands
  // on HTML5 + <nw-*> artifacts; route only on zone=workspace through
  // `dispatchWorkspaceCommand`. Block identity = native `id` attribute.
  // Mutating commands ride the existing D087 P1 staged-patch pipeline.
  "list_blocks",
  "read_block",
  "replace_block",
  "insert_block",
  "move_block",
  "rewrite_block",
] as const;

export type FileToolCommand = (typeof FILE_TOOL_ALL_COMMAND_NAMES)[number];

const fileCommandEnum = z.enum(FILE_TOOL_ALL_COMMAND_NAMES);

/** All wire-level `file` command names (for drift guards / tooling). */
export function listFileToolCommandNames(): FileToolCommand[] {
  return [...FILE_TOOL_ALL_COMMAND_NAMES];
}

/**
 * FLAT Zod schema that's handed to `DynamicStructuredTool({ schema })`
 * and thereby to Anthropic's tool-use API. See the header comment
 * for why this is a flat `z.object` rather than a discriminated
 * union. All per-command fields are optional at this layer; handlers
 * enforce per-command presence.
 */
export const fileToolSchema = z.object({
  // Required on every command. Handler-level required checks enforce
  // path + zone presence for filesystem commands.
  command: fileCommandEnum,
  path: z.string().min(1).optional().describe(
    "Exact file or directory path. REQUIRED for read and stat: a prior result never creates an implicit current file, and lineRange does not identify one. For current-zone list/glob/grep, use '.' for the selected-folder root. Omit only for commands whose documented contract has no filesystem target; never pass an empty string.",
  ),
  zone: zoneSchema.optional(),
  /**
   * D448 — recovery token returned after an unknown Workspace mutation.
   * It identifies an existing durable operation only; current Room authority
   * and exact command semantics are revalidated on every retry.
   */
  retryRequestId: z.string().trim().min(1).max(512).optional(),

  // list / delete
  recursive: z.boolean().optional(),

  // list / grep (include filter)
  glob: z.string().optional(),

  // glob
  pattern: z.string().optional().describe(
    "Glob expression, REQUIRED only when command is glob. Never use pattern for grep; grep requires query.",
  ),

  // list
  depth: z.number().int().nonnegative().optional(),

  discoveryCursor: z.string().min(1).optional().describe("For list/glob/grep only: echo nextCursor with the same path and filters until null. A changed discovery result set requires restarting; do not invent or edit the cursor."),
  readCursor: z.string().min(1).optional().describe("For read continuation only: echo nextCursor from the prior read of this exact path. The source version is validated; never invent or edit the cursor."),

  // read (offset/limit or exact inclusive lineRange) + list (limit only)
  /** Zero is accepted as a harmless first-page alias. */
  offset: z.number().int().nonnegative().optional(),
  /** read: line window size; list: entry cap (default 1000 flat / 5000 recursive; max 20000). */
  limit: z.number().int().positive().optional(),

  // grep / read / str_replace
  lineRange: lineRangeSchema.optional(),

  // grep
  query: z.string().optional().describe(
    "Regular expression, REQUIRED when command is grep. Never emit a grep call without it; pattern belongs only to glob.",
  ),
  caseMode: z.enum(["smart", "sensitive", "insensitive"]).optional(),

  // glob / grep native-search behavior
  includeIgnored: z.boolean().optional(),
  hidden: z.enum(["include", "exclude"]).optional(),

  // write / insert
  content: z.string().optional(),

  // write
  mode: z.enum(["overwrite", "append", "prepend"]).optional(),

  // insert
  lineNumber: z.number().int().positive().optional(),

  // str_replace
  newString: z.string().optional(),
  oldString: z.string().optional(),
  startFragment: z.string().optional(),
  endFragment: z.string().optional(),
  replaceAll: z.boolean().optional(),

  // move / copy
  destinationPath: z.string().optional(),
  destinationZone: zoneSchema.optional(),

  // D087 Phase 3 §3.1 — undo / redo / list_revisions / pin_revision.
  /**
   * Target a specific revision by id (from `list_revisions` output).
   * Takes precedence over `turnId` when both are set on an undo call.
   * Used also by `pin_revision` / `unpin_revision`.
   */
  revisionId: z.string().optional(),
  /**
   * Target the most recent revision from a specific turn. When
   * neither `revisionId` nor `turnId` is given on an undo call, the
   * handler defaults to "most recent revision (across all turns)
   * for this file by me". The wire field name is overloaded —
   * `ctx.turnId` in the dispatcher is the CURRENT turn's id;
   * this field is the TARGET turn to undo.
   */
  targetTurnId: z.string().optional(),

  // D087 Phase 3 §3.4 — list_revisions-specific filters. All optional.
  /** Turn-scoped filter for list_revisions. Distinct from
   *  `targetTurnId` (which is undo_turn's turn target); kept
   *  separate at the wire layer so the LLM doesn't confuse the two
   *  semantics on the same tool. */
  revisionTurnId: z.string().optional(),
  /** ISO-8601 lower bound on created_at. */
  since: z.string().optional(),
  /** ISO-8601 upper bound on created_at. */
  until: z.string().optional(),
  /** Only return pinned revisions. Default false. */
  includePinnedOnly: z.boolean().optional(),

  // D121-P4 / D087-P2B — block-edit fields. All optional at the wire
  // layer (same flat-schema pattern as the rest of `file`); handlers
  // enforce per-command presence and shape.
  /** Block id for read_block / move_block / rewrite_block; also used
   *  as the filter id on list_blocks. */
  blockId: z.string().optional(),
  /** list_blocks tag filter (case-insensitive). */
  tagFilter: z.string().optional(),
  /** list_blocks: include each outline node's outerHTML as `content`. */
  includeContent: z.boolean().optional(),
  /** replace_block target — discriminator between single block and
   *  same-parent sibling range. Handler validates shape. */
  target: z.unknown().optional(),
  /** New content for replace_block / insert_block (HTML fragment, one
   *  or more top-level elements). "" on replace_block = delete. */
  newContent: z.string().optional(),
  /** Anchor for insert_block / move_block: `{rel, id}`. */
  anchor: z
    .object({
      rel: z.enum(["before", "after", "inside"]),
      id: z.string().min(1),
    })
    .optional(),
  /** rewrite_block scope discriminator. */
  scope: z.enum(["text", "attr", "html"]).optional(),
  /** rewrite_block occurrence selector: "first" | "all" | 1-indexed N.
   *
   * Use `z.enum(["first","all"])` rather than a union of `z.literal()`s so
   * the emitted JSON Schema is `enum` instead of `const` (Gemini rejects
   * `const`; see D141). */
  occurrence: z.union([z.enum(["first", "all"]), z.number().int().positive()]).optional(),
});

/**
 * The flat type as Zod produces it. LangChain's tool runtime hands
 * us this at invocation time.
 */
export type FileToolRawArgs = z.infer<typeof fileToolSchema>;

/**
 * D560 — strict provider-facing file surface for a read-only security Task.
 * Mutation/history fields are irrelevant under that server-owned whitelist
 * and can distract flat-schema providers from the actual read target.
 */
export const securityResearchFileToolSchema = fileToolSchema.pick({
  command: true,
  path: true,
  zone: true,
  recursive: true,
  glob: true,
  pattern: true,
  depth: true,
  offset: true,
  limit: true,
  lineRange: true,
  readCursor: true,
  discoveryCursor: true,
  query: true,
  caseMode: true,
  includeIgnored: true,
  hidden: true,
}).extend({
  command: z.enum(["list", "read", "glob", "grep", "stat"]),
  path: z.string().min(1).describe(
    "Required exact Current Folder path. Use '.' only for the selected-folder root; read and stat require an exact relative file path.",
  ),
  zone: z.literal("current"),
}).strict();

// ---- TS-level discriminated union ---------------------------------
// Manually declared so per-command handlers get narrow args via the
// `command` discriminator. Each variant carries only the args for
// its command; the dispatcher narrows from the raw flat args to the
// appropriate variant via a single cast (safe because `command` is
// validated by the Zod enum above).

type BaseArgs = {
  path: string;
  zone: z.infer<typeof zoneSchema>;
};

/** Commands that do NOT need a path/zone (agent-layer verbs that
 *  operate on the staged-patch store or turn state). */
type NoPathArgs = object;

type LineRange = z.infer<typeof lineRangeSchema>;

export type FileToolArgs =
  | (BaseArgs & {
      command: "list";
      discoveryCursor?: string;
      recursive?: boolean;
      glob?: string;
      depth?: number;
      /** Discovery page size. Defaults to 1000 (flat) / 5000 (recursive). */
      limit?: number;
    })
  | (BaseArgs & {
      command: "read";
      readCursor?: string;
      offset?: number;
      limit?: number;
      lineRange?: LineRange;
    })
  | (BaseArgs & {
      command: "glob";
      discoveryCursor?: string;
      pattern: string;
      limit?: number;
      includeIgnored?: boolean;
      hidden?: "include" | "exclude";
    })
  | (BaseArgs & {
      command: "grep";
      discoveryCursor?: string;
      query: string;
      glob?: string;
      lineRange?: LineRange;
      limit?: number;
      caseMode?: "smart" | "sensitive" | "insensitive";
      includeIgnored?: boolean;
      hidden?: "include" | "exclude";
    })
  | (BaseArgs & {
      command: "stat";
    })
  | (BaseArgs & {
      command: "write";
      content: string;
      mode?: "overwrite" | "append" | "prepend";
    })
  | (BaseArgs & {
      command: "insert";
      lineNumber: number;
      content: string;
    })
  | (BaseArgs & {
      command: "str_replace";
      newString: string;
      oldString?: string;
      startFragment?: string;
      endFragment?: string;
      replaceAll?: boolean;
      lineRange?: LineRange;
    })
  | (BaseArgs & {
      command: "move";
      destinationPath: string;
      destinationZone?: z.infer<typeof zoneSchema>;
    })
  | (BaseArgs & {
      command: "copy";
      destinationPath: string;
      destinationZone?: z.infer<typeof zoneSchema>;
    })
  | (BaseArgs & {
      command: "delete";
      recursive?: boolean;
    })
  | (BaseArgs & {
      command: "undo";
      revisionId?: string;
      targetTurnId?: string;
    })
  | (NoPathArgs & {
      command: "undo_turn";
      /**
       * Required — identifies the turn whose revisions get reverted.
       * No "most recent turn" default because targeting the wrong
       * turn is destructive (stages N reverse patches that could
       * clobber several files). The UI and the LLM are expected to
       * populate this from a prior `list_revisions` result or from
       * the turn id visible in the chat transcript.
       */
      targetTurnId: string;
      /** M206 — `current` or `absolute` routes to the desktop relay journal. */
      zone?: z.infer<typeof zoneSchema>;
    })
  | (BaseArgs & {
      command: "redo";
    })
  | (NoPathArgs & {
      command: "list_revisions";
      /** Absolute path filter. Optional — omit for cross-file listing. */
      path?: string;
      /** M206 — `current` or `absolute` routes to the desktop relay journal. */
      zone?: z.infer<typeof zoneSchema>;
      /** Filter to one specific turn's revisions. Distinct from
       *  `targetTurnId` on undo_turn — different semantic, different
       *  wire key to avoid LLM confusion. */
      revisionTurnId?: string;
      /** ISO-8601 lower bound on created_at. */
      since?: string;
      /** ISO-8601 upper bound on created_at. */
      until?: string;
      /** Row cap. Default 20; hard max 200. */
      limit?: number;
      /** Return only pinned revisions. Default false. */
      includePinnedOnly?: boolean;
    })
  | (NoPathArgs & {
      command: "pin_revision";
      revisionId: string;
    })
  | (NoPathArgs & {
      command: "unpin_revision";
      revisionId: string;
    })
  | (BaseArgs & {
      command: "list_blocks";
      depth?: number;
      blockId?: string;
      tagFilter?: string;
      includeContent?: boolean;
    })
  | (BaseArgs & {
      command: "read_block";
      blockId: string;
    })
  | (BaseArgs & {
      command: "replace_block";
      target: { block: string } | { range: { from: string; to: string } };
      newContent: string;
    })
  | (BaseArgs & {
      command: "insert_block";
      anchor: { rel: "before" | "after" | "inside"; id: string };
      newContent: string;
    })
  | (BaseArgs & {
      command: "move_block";
      blockId: string;
      anchor: { rel: "before" | "after" | "inside"; id: string };
    })
  | (BaseArgs & {
      command: "rewrite_block";
      blockId: string;
      scope: "text" | "attr" | "html";
      oldString: string;
      newString: string;
      occurrence?: "first" | "all" | number;
    });

/**
 * Narrow a `FileToolArgs` to the args for a specific command. Used
 * inside command handlers so TypeScript knows which optional fields
 * are "definitely present for this command" vs "always optional".
 */
export type FileCommandArgs<C extends FileToolArgs["command"]> = Extract<
  FileToolArgs,
  { command: C }
>;
