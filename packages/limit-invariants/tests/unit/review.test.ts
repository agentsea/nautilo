import { describe, expect, test } from "bun:test";
import { normalizedGitHubRepository, runLimitPolicyReview, type LimitPolicyReviewDependencies } from "../../src/node/review";

const HEAD = "a".repeat(40);

function harness(options: { readonly status?: readonly string[]; readonly heads?: readonly string[]; readonly remote?: string; readonly check?: () => Promise<number> } = {}) {
  const posts: Array<{ repository: string; head: string }> = [];
  let inspection = -1;
  const dependencies: LimitPolicyReviewDependencies = {
    git: async (_root, args) => {
      if (args[0] === "rev-parse") { inspection += 1; return `${options.heads?.[inspection] ?? HEAD}\n`; }
      if (args[0] === "remote") return `${options.remote ?? "git@github.com:agentsea/nautilo.git"}\n`;
      return options.status?.[inspection] ?? "";
    },
    check: options.check ?? (async () => 0),
    post: async (repository, head) => { posts.push({ repository, head }); },
  };
  return { dependencies, posts };
}

async function failureMessage(run: Promise<void>): Promise<string> {
  try { await run; return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

describe("exact commit limit policy review", () => {
  test("normalizes only explicit GitHub HTTPS and SSH remotes", () => {
    expect(normalizedGitHubRepository("https://github.com/agentsea/nautilo.git")).toBe("agentsea/nautilo");
    expect(normalizedGitHubRepository("git@github.com:agentsea/nautilo.git")).toBe("agentsea/nautilo");
    expect(normalizedGitHubRepository("ssh://git@github.com/agentsea/nautilo")).toBe("agentsea/nautilo");
    expect(normalizedGitHubRepository("https://example.com/agentsea/nautilo.git")).toBeNull();
  });

  test("posts only after the same clean exact source passes strict review twice", async () => {
    const { dependencies, posts } = harness();
    await runLimitPolicyReview({ repository: "agentsea/nautilo", head: HEAD, repositoryRoot: "/repo" }, dependencies);
    expect(posts).toEqual([{ repository: "agentsea/nautilo", head: HEAD }]);
  });

  test("dirty source and remote mismatch prevent publication", async () => {
    for (const options of [{ status: ["?? private.txt"] }, { remote: "https://github.com/someone/else.git" }]) {
      const { dependencies, posts } = harness(options);
      expect(await failureMessage(runLimitPolicyReview({ repository: "agentsea/nautilo", head: HEAD, repositoryRoot: "/repo" }, dependencies))).not.toBe("");
      expect(posts).toHaveLength(0);
    }
  });

  test("missing evidence, nonzero review, and review exceptions prevent publication", async () => {
    for (const check of [async () => 1, async (): Promise<number> => { throw new Error("Missing local inventory audit evidence"); }]) {
      const { dependencies, posts } = harness({ check });
      expect(await failureMessage(runLimitPolicyReview({ repository: "agentsea/nautilo", head: HEAD, repositoryRoot: "/repo" }, dependencies))).not.toBe("");
      expect(posts).toHaveLength(0);
    }
  });

  test("source changes after review prevent publication", async () => {
    const { dependencies, posts } = harness({ heads: [HEAD, "b".repeat(40)] });
    expect(await failureMessage(runLimitPolicyReview({ repository: "agentsea/nautilo", head: HEAD, repositoryRoot: "/repo" }, dependencies))).toContain("HEAD does not match");
    expect(posts).toHaveLength(0);
  });

  test("rejects ambiguous repository and abbreviated commit inputs before inspection", async () => {
    const { dependencies, posts } = harness();
    expect(await failureMessage(runLimitPolicyReview({ repository: "nautilo", head: "abc123", repositoryRoot: "/repo" }, dependencies))).toContain("owner/name");
    expect(posts).toHaveLength(0);
  });
});
