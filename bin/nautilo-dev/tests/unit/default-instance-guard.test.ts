/**
 * ISSUE-D202 Wave 1 — decision matrix for default-instance DB mutation guard.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOW_DEFAULT_DB_MUTATION_ENV,
  evaluateDefaultInstanceMutationGuard,
  RECOMMENDED_SCRATCH_INSTANCE,
  resolveAndEvaluateDefaultInstanceMutationGuard,
} from "../../src/lib/default-instance-guard";

const CMD = "dev:restore";

type MatrixRow = {
  name: string;
  input: Parameters<typeof evaluateDefaultInstanceMutationGuard>[0];
  expectAllowed: boolean;
  messageIncludes?: string[];
};

const matrix: MatrixRow[] = [
  {
    name: "named instance mutating allowed",
    input: {
      commandName: CMD,
      instanceId: "beta",
      cwd: "/repos/nautilo-stack-foo",
      isDryRunOrReadOnly: false,
    },
    expectAllowed: true,
  },
  {
    name: "default dry-run/read-only allowed",
    input: {
      commandName: CMD,
      instanceId: "",
      cwd: "/repos/nautilo-d202-protect-default-db",
      isDryRunOrReadOnly: true,
    },
    expectAllowed: true,
  },
  {
    name: "canonical nautilo checkout default mutating refused without opt-in",
    input: {
      commandName: CMD,
      instanceId: "",
      cwd: "/repos/nautilo",
      isDryRunOrReadOnly: false,
    },
    expectAllowed: false,
    messageIncludes: ["canonical nautilo checkout", RECOMMENDED_SCRATCH_INSTANCE],
  },
  {
    name: "non-canonical nautilo-* worktree default mutating refused",
    input: {
      commandName: CMD,
      instanceId: "",
      cwd: "/repos/nautilo-d202-protect-default-db",
      isDryRunOrReadOnly: false,
    },
    expectAllowed: false,
    messageIncludes: ["nautilo-d202-protect-default-db", RECOMMENDED_SCRATCH_INSTANCE],
  },
  {
    name: "explicit iKnowWhatIAmDoing allows default mutation",
    input: {
      commandName: CMD,
      instanceId: "",
      cwd: "/repos/nautilo-d202-protect-default-db",
      isDryRunOrReadOnly: false,
      iKnowWhatIAmDoing: true,
    },
    expectAllowed: true,
  },
  {
    name: "ALLOW_DEFAULT_DB_MUTATION=1 allows default mutation",
    input: {
      commandName: CMD,
      instanceId: "",
      cwd: "/repos/nautilo-d202-protect-default-db",
      isDryRunOrReadOnly: false,
      env: { [ALLOW_DEFAULT_DB_MUTATION_ENV]: "1" },
    },
    expectAllowed: true,
  },
];

describe("evaluateDefaultInstanceMutationGuard", () => {
  test.each(matrix.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const decision = evaluateDefaultInstanceMutationGuard(row.input);
    expect(decision.allowed).toBe(row.expectAllowed);
    if (!row.expectAllowed) {
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        for (const fragment of row.messageIncludes ?? []) {
          expect(decision.message).toContain(fragment);
        }
      }
    }
  });

  test("refusal copy suggests test-cruft scratch instance", () => {
    const decision = evaluateDefaultInstanceMutationGuard({
      commandName: "dev:setup-instance",
      instanceId: "",
      cwd: "/Users/me/nautilo-stack-11",
      isDryRunOrReadOnly: false,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toContain(`--instance ${RECOMMENDED_SCRATCH_INSTANCE}`);
      expect(decision.message).toContain("test-cruft");
      expect(decision.message).toContain("dev:setup-instance");
      expect(decision.message).toContain("(default)");
      expect(decision.message).toContain("--i-know-what-i-am-doing");
      expect(decision.message).toContain(`${ALLOW_DEFAULT_DB_MUTATION_ENV}=1`);
    }
  });
});

describe("resolveAndEvaluateDefaultInstanceMutationGuard", () => {
  test("--instance default from feature worktree resolves to default and refuses mutation", () => {
    const decision = resolveAndEvaluateDefaultInstanceMutationGuard({
      commandName: CMD,
      cwd: "/Users/me/nautilo-stack-15-friendly-errors",
      argv: ["--instance", "default"],
      env: {},
      isDryRunOrReadOnly: false,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.effectiveInstanceLabel).toBe("(default)");
      expect(decision.message).toContain("test-cruft");
    }
  });

  test("worktree-derived named instance allows mutation", () => {
    const decision = resolveAndEvaluateDefaultInstanceMutationGuard({
      commandName: CMD,
      cwd: "/Users/me/nautilo-d202-protect-default-db",
      argv: [],
      env: {},
      isDryRunOrReadOnly: false,
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.effectiveInstanceLabel).toBe("d202-protect-default-db");
    }
  });
});
