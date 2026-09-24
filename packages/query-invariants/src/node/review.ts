import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { runLimitPolicyReview } from "../../../limit-invariants/src/node/review";
import { QUERY_POLICY_STATUS_CONTEXT } from "./public-check";

const execFileAsync = promisify(execFile);

// Reuse the existing clean-source, exact-HEAD check before and after review.
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repository = args[args.indexOf("--repository") + 1];
  const head = args[args.indexOf("--head") + 1];
  if (!args.includes("--repository") || !args.includes("--head") || !repository || !head) {
    throw new Error("Usage: review --repository owner/name --head <40-hex-sha>");
  }
  await runLimitPolicyReview({ repository, head, repositoryRoot: resolve(import.meta.dir, "../../../..") }, {
    git: async (root, argv) => (await execFileAsync("git", [...argv], { cwd: root, encoding: "utf8" })).stdout,
    check: async (root) => {
      const child = Bun.spawn([process.execPath, "run", "db:query-inventory:check"], {
        cwd: root, stdout: "inherit", stderr: "inherit",
      });
      return child.exited;
    },
    post: async (target, sha) => {
      await execFileAsync("gh", ["api", "--method", "POST", `repos/${target}/statuses/${sha}`,
        "-f", "state=success", "-f", `context=${QUERY_POLICY_STATUS_CONTEXT}`,
        "-f", "description=Query policy reviewed for this commit"], { encoding: "utf8" });
    },
  });
}

if (import.meta.main) {
  try { await main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Query policy review failed.");
    process.exitCode = 1;
  }
}
