import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { parseGitHubOperation } from "../../../../types/src/github-broker";

const resource = { repository: z.string(), number: z.number().int().positive().safe() };
export const githubSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("issue_read"), ...resource }).strict(),
  z.object({ operation: z.literal("pr_read"), ...resource }).strict(),
  z.object({ operation: z.literal("comment_create"), ...resource, body: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("pr_create"), repository: z.string(), headRepository: z.string(), baseBranch: z.string(), headBranch: z.string(), title: z.string().min(1), body: z.string(), draft: z.boolean() }).strict(),
]).superRefine((value, context) => {
  if (!parseGitHubOperation(value)) context.addIssue({ code: "custom", message: "Invalid typed GitHub operation" });
});

export function createGitHubTool() {
  return new DynamicStructuredTool({
    name: "local_github",
    schema: githubSchema,
    description: "Read an issue or pull request, or propose a conversation comment or pull request, in an exact owner/repository on GitHub.com using the admitted Desktop account broker. Publishing always needs a separate one-time Human review showing the actual account, repository, target and full payload, including observed branches for a pull request. PR creation disables maintainer branch edits and returns observed branch movement, without guaranteeing an approved commit because GitHub has no commit compare-and-swap for creation. This is not arbitrary gh, review submission, merge, or authenticated Git. A publishing outcome_unknown must never be retried automatically.",
    func: () => Promise.reject(new Error("local_github requires the admitted Desktop account broker")),
  });
}
