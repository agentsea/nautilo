import { DynamicStructuredTool } from "@langchain/core/tools";
import { parseRelayRunShellGitOperation } from "@nautilo/relay";
import { parseGitHubGitOperation } from "@nautilo/types";
import { z } from "zod";

/** The existing broker grammar; Desktop independently validates the wire. */
export const localGitSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("diff"), ref: z.string().optional() }).strict(),
  z.object({ operation: z.literal("add"), paths: z.array(z.string()).min(1) }).strict(),
  z.object({ operation: z.literal("commit"), message: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("worktree-add"), target: z.string(), ref: z.string() }).strict(),
  z.object({ operation: z.literal("worktree-remove"), target: z.string() }).strict(),
  z.object({ operation: z.literal("fetch"), repository: z.string(), branch: z.string() }).strict(),
  z.object({ operation: z.literal("clone"), repository: z.string(), branch: z.string(), directory: z.string() }).strict(),
  z.object({ operation: z.literal("pull"), repository: z.string(), branch: z.string() }).strict(),
  z.object({ operation: z.literal("push"), repository: z.string(), sourceBranch: z.string(), destinationBranch: z.string() }).strict(),
]).superRefine((args, context) => {
  const parsed = parseRelayRunShellGitOperation(args);
  if (!parsed.ok && !parseGitHubGitOperation(args)) context.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
});

export function createLocalGitTool() {
  return new DynamicStructuredTool({
    name: "local_git",
    schema: localGitSchema,
    description: "Perform a typed Git operation in the admitted Current Folder using the protected Git broker: status, diff, add, commit, worktree-add, worktree-remove, authenticated GitHub clone/fetch/fast-forward-only pull, or an exact separately approved push. Add stages explicit relative paths into the broker-owned index; commit requires preceding add. Network Git uses the admitted Desktop GitHub account without exposing credentials. Worktree targets must remain inside exact active writable grants. Hooks, signing, external filters, redirects and model-selected credential helpers are disabled. Respect sideEffectStarted and retrySafe: never repeat an uncertain mutation whose retrySafe is false.",
    func: () => Promise.reject(new Error("local_git requires the admitted Desktop Git broker")),
  });
}
