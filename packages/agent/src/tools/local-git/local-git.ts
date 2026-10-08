import { DynamicStructuredTool } from "@langchain/core/tools";
import { parseRelayRunShellGitOperation } from "@nautilo/relay";
import { z } from "zod";

/** The existing broker grammar; Desktop independently validates the wire. */
export const localGitSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("diff"), ref: z.string().optional() }).strict(),
  z.object({ operation: z.literal("add"), paths: z.array(z.string()).min(1) }).strict(),
  z.object({ operation: z.literal("commit"), message: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("worktree-add"), target: z.string(), ref: z.string() }).strict(),
  z.object({ operation: z.literal("worktree-remove"), target: z.string() }).strict(),
]).superRefine((args, context) => {
  const parsed = parseRelayRunShellGitOperation(args);
  if (!parsed.ok) context.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
});

export function createLocalGitTool() {
  return new DynamicStructuredTool({
    name: "local_git",
    schema: localGitSchema,
    description: "Perform a typed local Git operation in the admitted Current Folder using the protected Git broker: status, diff, add, commit, worktree-add, or worktree-remove. Add stages explicit relative paths into the broker-owned index; commit requires preceding add. Worktree targets must be absolute paths inside exact active writable grants. Worktree-remove only removes a broker-created worktree and refuses dirty removal. Hooks, credential helpers, signing and external filters are disabled. This tool does not authenticate accounts or perform network Git operations. Respect sideEffectStarted and retrySafe in the result: never repeat an uncertain mutation whose retrySafe is false.",
    func: () => Promise.reject(new Error("local_git requires the admitted Desktop Git broker")),
  });
}
