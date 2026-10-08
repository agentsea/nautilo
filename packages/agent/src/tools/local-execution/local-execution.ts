import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const responseOptions = {
  yield_time_ms: z.number().int().safe().nonnegative().max(2_147_483_647).optional().describe("Wait for output; yielding never terminates or restarts the command."),
  max_output_bytes: z.number().int().safe().min(4).optional().describe("Response output budget in UTF-8 bytes. Remaining output stays available by cursor."),
};
export const execCommandSchema = z.object({
  cmd: z.string().min(1).describe("The complete command to launch once."),
  workdir: z.string().min(1).optional().describe("Directory relative to the admitted Current Folder. Omit for that folder; absolute paths cannot select a different root."),
  tty: z.boolean().optional().describe("Use a fresh contained PTY only when interactive terminal behavior is needed. Full Mac accepts pipes only."),
  ...responseOptions,
}).strict();
const writeStdinFields = {
  session_id: z.string().min(1).describe("Execution reference returned by exec_command."),
  chars: z.string().optional().describe("Interactive input. Omit or use an empty string to read output without sending input."),
  cursor: z.number().int().safe().nonnegative().optional().describe("Repeatable UTF-8 output cursor."),
  cancel: z.boolean().optional().describe("Explicitly stop this owned execution and return its actual cleanup state."),
  ...responseOptions,
};
const writeStdinBaseSchema = z.object(writeStdinFields).strict();
export const writeStdinSchema = writeStdinBaseSchema.extend({
  search: z.string().min(1).refine(value => new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value, "search must be valid UTF-8").optional().describe("Find the next literal match in retained sanitized output. Continue the same search with search.nextSearchCursor, not output.nextCursor. A pending search can be repeated as more output arrives; gap means discarded bytes were not searched. Cannot combine with chars, cancel, or yield_time_ms."),
}).superRefine((args, context) => {
  if (args.search !== undefined && ["chars", "cancel", "yield_time_ms"].some(key => key in args)) context.addIssue({
    code: z.ZodIssueCode.custom, path: ["search"], message: "search cannot be combined with chars, cancel, or yield_time_ms",
  });
  if (args.cancel === true && args.chars !== undefined) context.addIssue({
    code: z.ZodIssueCode.custom, path: ["chars"], message: "cancel cannot be combined with chars",
  });
});
export function localExecutionOperation(name: string, args: Readonly<Record<string, unknown>>): "start" | "read" | "input" | "cancel" {
  if (name === "exec_command") return "start";
  if (args["cancel"] === true) return "cancel";
  return typeof args["chars"] === "string" && args["chars"].length > 0 ? "input" : "read";
}
export function isLocalExecutionTool(name: string): boolean {
  return name === "exec_command" || name === "write_stdin";
}
export function createExecCommandTool() {
  return new DynamicStructuredTool({ name: "exec_command", schema: execCommandSchema,
    description: "Launch one complete command on the authorized computer under the selected access. Basic and Development are contained. Temporary Full Mac supports one-shot pipes only, with ordinary command approval; tty and subsequent input are unavailable. Pipes are the default; tty starts a fresh contained managed PTY. Returns actual exit status or a live session_id. A yielded command continues as the same execution; use write_stdin to read output, provide interactive input, or stop it. Do not restart a quiet build or use background shell syntax to manage a server.",
    func: () => Promise.reject(new Error("exec_command requires the admitted Desktop executor")),
  });
}
export function createWriteStdinTool(context?: { relayCapabilities?: Readonly<Record<string, boolean>> | undefined }) {
  return new DynamicStructuredTool({ name: "write_stdin", schema: context?.relayCapabilities?.["canSearchLocalExecutionOutput"] === true ? writeStdinSchema : writeStdinBaseSchema.superRefine((args, context) => {
      if (args.cancel === true && args.chars !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["chars"], message: "cancel cannot be combined with chars" });
    }),
    description: "Read repeatable output/status from an owned execution, send permitted interactive input, or stop it with cancel:true. After a Desktop or server restart, a read can recover the saved final result of an execution referenced in this conversation; history is read-only and never restarts a command. On compatible computers, search finds literal text in retained output without rerunning the command; use search.nextSearchCursor for the next match and check search.complete and search.gap. Reads do not consume output. A quiet response does not mean completion. Preserve session_id and cursor; do not repeat potentially delivered input after an uncertain response. cancel:true cannot be combined with chars and returns confirmed termination or uncertainty.",
    func: () => Promise.reject(new Error("write_stdin requires the admitted Desktop executor")),
  });
}
