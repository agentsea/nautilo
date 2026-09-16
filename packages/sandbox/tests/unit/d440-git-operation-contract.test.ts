import { describe, expect, test } from "bun:test";

type Operation = "status" | "diff" | "add" | "commit" | "worktree-add" | "worktree-remove";

type ContractCase = {
  operation: Operation;
  subject: string;
  decision: "allow" | "deny";
  reason: string;
};

/**
 * D440 Phase 0.4.1 proposed seam: a typed Git broker.
 *
 * A command-string exemption cannot safely distinguish Git's direct filesystem
 * effects from config-driven hooks, filters, textconv/external diff programs,
 * object alternates, or recursive submodules. A generic operation-aware
 * sandbox also lacks Git's index/ref transaction semantics and cannot decide
 * whether a partially failed mutation is retry-safe. The broker must preflight
 * and normalize the operation, then compile a per-operation sandbox profile as
 * defense in depth. This test intentionally defines no production exception.
 */
const seam = {
  primary: "typed-git-broker",
  defenseInDepth: "operation-aware-sandbox-profile",
  rejected: [
    "raw-command-string-allowlist",
    "broad-.git/**-write",
    "broad-.env*-read-or-write",
  ],
} as const;

const contract: readonly ContractCase[] = [
  { operation: "status", subject: "canonical granted worktree", decision: "allow", reason: "read-only, optional locks disabled" },
  { operation: "status", subject: "registered linked-worktree common-dir with exact reciprocal backlink", decision: "allow", reason: "implicit read-only repository metadata authority" },
  { operation: "status", subject: "forged or non-reciprocal linked-worktree common-dir", decision: "deny", reason: "repository identity mismatch" },
  { operation: "diff", subject: "no-ext-diff and no-textconv", decision: "allow", reason: "no config-selected process execution" },
  { operation: "diff", subject: "external diff or textconv driver", decision: "deny", reason: "arbitrary process execution" },
  { operation: "add", subject: "explicit normalized in-repository pathspec", decision: "allow", reason: "bounded index/object transaction" },
  { operation: "add", subject: "pathspec magic, symlink traversal, or outside target", decision: "deny", reason: "unbounded selection or escape" },
  { operation: "commit", subject: "broker-built tree plus atomic ref update", decision: "allow", reason: "hooks, editor, signing, and aliases bypassed" },
  { operation: "commit", subject: "porcelain commit with hooks or signing enabled", decision: "deny", reason: "arbitrary process or credential access" },
  { operation: "worktree-add", subject: "canonical preauthorized empty target", decision: "allow", reason: "exact target authority established before mutation" },
  { operation: "worktree-add", subject: "external, existing nonempty, or symlink target", decision: "deny", reason: "overwrite and escape risk" },
  { operation: "worktree-remove", subject: "exact broker-created registered worktree", decision: "allow", reason: "bounded target and metadata pair" },
  { operation: "worktree-remove", subject: "unregistered, dirty, nested, or symlink target", decision: "deny", reason: "destructive ambiguity" },
] as const;

const repositoryInputs = [
  ["common-dir", "resolve canonical --git-common-dir and --git-dir; require an exact reciprocal linked-worktree registry identity before implicit read-only metadata authority"],
  ["hooks", "never execute; use hook-free plumbing and an empty broker-owned hooks path"],
  ["config", "ignore system/global config; audit local config without includes and override execution-bearing keys"],
  ["aliases", "never dispatch aliases; broker selects a fixed executable and subcommand"],
  ["filters/attributes", "do not execute clean/smudge/process filters, textconv, or external diff; broker materializes blobs"],
  ["alternates", "drop alternate-object env and reject objects/info/alternates unless every target is separately authorized"],
  ["submodules", "treat gitlinks as inert entries; never clone, fetch, update, or recurse"],
  ["symlinks", "reject absolute or lexically escaping links and never follow a worktree path through a symlink"],
  ["external targets", "require a distinct exact target grant; /tmp writability is not target authority"],
  [".env.example", "allow tracked terminal .example/.sample/.template/.dist materialization as public data"],
  ["live .env", "deny read, stage, checkout, and materialization even when tracked"],
] as const;

const mutationProtocol = {
  beforeMutation: [
    "canonicalize repository, common-dir, worktree git-dir, and exact target",
    "verify grants, repo identity, clean lock state, pathspecs, attributes, config, alternates, submodules, and symlinks",
    "allocate broker-owned temporary index, quarantine object directory, and operation record",
  ],
  knownFailure: [
    "remove only broker-created lock, quarantine, metadata, and target artifacts",
    "verify refs, index, registered worktrees, target existence, and source cleanliness",
    "return sideEffectStarted plus exact residual paths",
  ],
  unknownOutcome: [
    "do not retry or force-clean",
    "preserve evidence and return a non-retryable manual-inspection disposition",
  ],
} as const;

describe("D440 minimum safe Git operation contract", () => {
  test("selects a typed broker and rejects broad policy exemptions", () => {
    expect(seam.primary).toBe("typed-git-broker");
    expect(seam.defenseInDepth).toBe("operation-aware-sandbox-profile");
    expect(seam.rejected).toEqual([
      "raw-command-string-allowlist",
      "broad-.git/**-write",
      "broad-.env*-read-or-write",
    ]);
  });

  test("covers every required operation with explicit allow and deny cases", () => {
    const operations: readonly Operation[] = [
      "status",
      "diff",
      "add",
      "commit",
      "worktree-add",
      "worktree-remove",
    ];
    for (const operation of operations) {
      const cases = contract.filter((entry) => entry.operation === operation);
      expect(cases.some((entry) => entry.decision === "allow")).toBe(true);
      expect(cases.some((entry) => entry.decision === "deny")).toBe(true);
    }
  });

  test("covers every Git-controlled execution and path escape surface", () => {
    expect(repositoryInputs.map(([subject]) => subject)).toEqual([
      "common-dir",
      "hooks",
      "config",
      "aliases",
      "filters/attributes",
      "alternates",
      "submodules",
      "symlinks",
      "external targets",
      ".env.example",
      "live .env",
    ]);
  });

  test("fails closed on partial or unknown mutation outcomes", () => {
    expect(mutationProtocol.beforeMutation.length).toBeGreaterThanOrEqual(3);
    expect(mutationProtocol.knownFailure.join(" ")).toContain("broker-created");
    expect(mutationProtocol.knownFailure.join(" ")).toContain("residual paths");
    expect(mutationProtocol.unknownOutcome).toContain("do not retry or force-clean");
    expect(mutationProtocol.unknownOutcome.join(" ")).toContain("non-retryable");
  });
});
