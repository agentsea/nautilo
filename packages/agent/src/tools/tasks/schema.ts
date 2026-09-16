import { z } from "zod";

const TASK_TOOL_ALL_COMMAND_NAMES = [
  "create",
  "read",
  "list",
  "update",
  // M147 (Phase 6) — lifecycle commands. Each takes `{ taskId }`.
  "pause",
  "unpause",
  "stop",
  "steer",
  "list_harness_models",
] as const;

export type TaskToolCommand = (typeof TASK_TOOL_ALL_COMMAND_NAMES)[number];

/** All wire-level `task` command names (for drift guards / tooling). */
export function listTaskToolCommandNames(): TaskToolCommand[] {
  return [...TASK_TOOL_ALL_COMMAND_NAMES];
}

/**
 * IMPORTANT SHAPE NOTE (mirrors `file/schema.ts`): the on-the-wire schema is a
 * FLAT `z.object` (NOT `z.discriminatedUnion`). OpenAI + Anthropic require
 * `type: "object"` at the top level of every tool's JSON schema;
 * `z.discriminatedUnion` serialises to `{ anyOf: [...] }` with no top-level
 * `type`, which OpenAI rejects with:
 *   "Invalid schema for function 'task': schema must be a JSON Schema of
 *    'type: \"object\"', got 'type: \"None\"'."
 * Because `task` is an always-available tool (no capability gate), a bad schema
 * breaks EVERY turn — so the wire schema stays flat. Per-command field
 * requirements (e.g. `prompt` on create, `taskId` on read) are enforced in the
 * dispatcher, exactly like the `file` tool's handler-level validation.
 */
export function createTaskToolSchema(
  options: Readonly<{ claudeCode: boolean }>,
) {
  return z.object({
  command: z.enum(TASK_TOOL_ALL_COMMAND_NAMES),
  // create / update (full Tier-2 property set; per-command requirements are
  // enforced in the dispatcher, not the schema — see the FLAT-object note above)
  prompt: z
    .string()
    .optional()
    .describe(
      "The instruction for the background task (addressed to the agent/subagent that will run it, NOT to any human). Required on 'create', and used as the concise same-turn instruction on explicit 'steer'. A second Codex 'create' is an ordinary follow-up Task: it queues behind active Codex work and never changes the active turn; use 'steer' only when the user explicitly wants that active turn redirected. If the task involves messaging or asking another human, the prompt must be a full instruction — say who to message, the EXACT text to send, that the subagent must WAIT for the human's reply (not answer it itself), and where to report the answer. Do not assume a bare question will be sent to the human. (For a simple ask-a-person flow, prefer the `ask_peer` shortcut.)",
    ),
  expected_output: z
    .string()
    .optional()
    .describe("Optional description of what a good result looks like."),
  schedule_kind: z
    .enum(["now", "one_shot", "cron"])
    .optional()
    .describe(
      "When the task runs: 'now' (default, immediately), 'one_shot' (once at run_at), or 'cron' (recurring).",
    ),
  run_at: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp for a 'one_shot' task (e.g. 2026-06-10T14:30:00Z)."),
  cron: z
    .string()
    .optional()
    .describe("Raw 5-field cron expression for a 'cron' task (e.g. '0 9 * * *')."),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone used to interpret cron occurrences (defaults to the user's timezone, else UTC)."),
  target_chat: z
    .enum(["orphan", "last_in_namespace", "new_in_namespace"])
    .optional()
    .describe(
      "Where the result lands: 'orphan' (default, a private background thread), 'last_in_namespace' (the last chat), or 'new_in_namespace' (a fresh chat).",
    ),
  target_users: z
    .array(z.string())
    .optional()
    .describe(
      "M165 — @handles of the people this task is ABOUT (you, the requester, are always included automatically). When `use_scope` is false, the task's memory/artifact namespace is derived from this set: omit it (or pass just yourself) to run in your own namespace, or name one or more peers to run in the shared namespace of exactly those people. This is the namespace axis only — it does NOT message anyone or change where the result lands (that is `target_chat`); to actually ask a person something, use `ask_peer`.",
    ),
  use_scope: z
    .boolean()
    .optional()
    .describe("Run the task inside an agent scope (narrow, scoped helper)."),
  scope_id: z
    .string()
    .optional()
    .describe("Reuse a pre-existing scope id; omit to mint an ephemeral one."),
  tools: z
    .array(z.string())
    .optional()
    .describe("Tool whitelist: omit for all tools, [] for none, or a list of tool names."),
  result_delivery: z
    .enum(["wake", "raw", "raw_and_wake"])
    .optional()
    .describe("How the result is delivered back: 'wake' (default), 'raw', or 'raw_and_wake'."),
  parent_task_id: z
    .string()
    .optional()
    .describe("Link this task to a parent task (advanced; depth is derived + capped)."),
  time_limit_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Max wall-clock seconds a run may execute before the watchdog auto-pauses it (resume or stop afterward).",
    ),
  // model selection (M152) — bias which model the task's run uses (create/update)
  model_selection_profile: z
    .enum([
      "balanced",
      "most_private",
      "smartest",
      "cheapest",
      "private_cheap",
      "private_smart",
      "cheap_private",
      "cheap_smart",
      "smart_private",
      "smart_cheap",
    ])
    .optional()
    .describe(
      "Bias model choice for this task's run. 'balanced' (default) inherits the saved Agent model setting, then the server chat default when the Agent uses Follow default. A Room model override is separate and is not inherited; use model_id when this task needs an exact model. Singles: 'most_private' / 'smartest' / 'cheapest'. Pairs '<X>_<Y>' = qualify by X then optimize Y, e.g. 'private_cheap' (private, then cheapest of those), 'smart_cheap' (near-smartest, then cheapest). Picks the best CONFIGURED model; errors only when a private_* profile finds no private-enough model.",
    ),
  model_selection_spec: z
    .object({
      band: z.enum(["privacy", "smart", "cheap"]).optional(),
      objective: z.enum(["privacy", "smart", "cheap"]),
      absoluteFloors: z
        .object({
          privacy: z.number().optional(),
          intelligenceRank: z.number().optional(),
          maxCost: z.number().optional(),
        })
        .optional(),
    })
    .optional()
    .describe(
      "ADVANCED: explicit {band?, objective} combo (+ optional absolute floors). Prefer model_selection_profile when one fits.",
    ),
  // D429 Phase 3 — exact model pin (mutually exclusive with the M152
  // selection profile/spec above). Snake_case on the LLM Tool wire surface;
  // the HTTP surface uses camelCase `requestedModelId`. Nullable so an update
  // can explicitly clear the pin with `model_id: null` (omission preserves the
  // existing value — omission is NOT a clear).
  model_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Pin the EXACT model this task's run will use (a strict same-model pin — no cross-model fallback). First call the `discover_models` tool (list/search/get) and copy the EXACT stable curated model id it returns; do NOT guess or hand-type one. Only curated ids are accepted in v1 (dynamic openrouter:/gateway: ids are rejected). Mutually exclusive with model_selection_profile / model_selection_spec — pass model_id OR a selection bias, never both. On update, pass model_id: null to clear the pin (omission preserves it). A tool-using task (tools omitted, or a non-empty tools list) requires a model with confirmed tool support; pass tools: [] to allow a tool-free model.",
    ),
  // D453 — execution remains Native unless the Genie deliberately selects an
  // external harness. Exact selection must fail rather than silently falling
  // back.
  harness: z
    .enum(options.claudeCode
      ? ["native", "codex", "hermes-acp", "claude-code"]
      : ["native", "codex", "hermes-acp"])
    .optional()
    .describe(
      options.claudeCode
        ? "Optional execution preference. Omit (or use 'native') for Nautilo's normal task executor. Use 'codex', 'hermes-acp', or 'claude-code' only when the user explicitly asks for that harness; it never falls back."
        : "Optional execution preference. Omit (or use 'native') for Nautilo's normal task executor. Use 'codex' or 'hermes-acp' only when the user explicitly asks for that harness; it never falls back.",
    ),
  collaboration_mode: z
    .enum(["work", "plan"])
    .optional()
    .describe(
      "Optional external-harness collaboration mode. Use only with harness 'codex'; omit for normal Native tasks. 'work' performs work, while 'plan' asks the external harness to plan and may require user input.",
    ),
  harness_model_id: z
    .string()
    .optional()
    .describe(
      options.claudeCode
        ? "Exact picker id returned by task command 'list_harness_models'. Use only when creating with harness 'codex' or 'claude-code'. This is a harness model, not Nautilo model_id; never guess it."
        : "Exact picker id returned by task command 'list_harness_models'. Use only when creating with harness 'codex'. This is a harness model, not Nautilo model_id; never guess it.",
    ),
  working_directory: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Optional absolute directory on the selected Desktop where Codex should start. Use only with harness 'codex'. Omit it to let the Desktop choose Current Folder when available, otherwise the existing Genie Workspace. This is a starting directory, not Nautilo filesystem authority.",
    ),
  // read / update / pause / unpause / stop / steer
  taskId: z
    .string()
    .optional()
    .describe("The task id. Required on 'read', 'update', 'pause', 'unpause', 'stop', and explicit 'steer'."),
  readSection: z.enum(["metadata", "result", "transcript"]).optional().describe("Read one exact saved Task section. Large reads return byte pages; metadata includes the full prompt and all run IDs without their transcripts/results."),
  runId: z.string().optional().describe("Exact run within taskId for transcript/result reads. Omit to select the latest run; continuation freezes that run."),
  readCursor: z.string().optional().describe("Exact continuation from a previous task.read page. Remains scoped to its owner, Task, run, section, literal search and saved snapshot."),
  continueRead: z.boolean().optional().describe("Continue the latest matching incomplete task.read page from canonical history without copying its cursor. Supply the same taskId; explicit selection fields must match."),
  readSearch: z.string().min(1).optional().describe("Optional case-sensitive literal substring lookup in saved message content or serialized assistant tool calls in the selected run. Returns matching entries only; matches are navigation, not coverage or a semantic summary."),
  // list
  status: z.string().optional().describe("Filter listed tasks to an exact status."),
  includeTerminal: z
    .boolean()
    .optional()
    .describe("Include completed/cancelled/errored tasks when listing."),
  });
}

const _claudeEnabledTaskToolSchema = createTaskToolSchema({ claudeCode: true });

/** Legacy export for static tool registration: Claude stays opt-in. */
export const taskToolSchema = createTaskToolSchema({ claudeCode: false });

export type TaskToolArgs = z.infer<typeof _claudeEnabledTaskToolSchema>;
