/**
 * Stack 198 / D266 follow-up — unit tests for the `--plan-out` flag on
 * `dev:cleanup-test-cruft`. No DB is touched.
 *
 * The invalid-combination, existing-destination, missing-parent, and
 * not-a-directory refusals all run during pre-DB validation (before
 * `createDirectDb`), so they are exercisable without a live Postgres. The
 * atomic write helper is exercised directly for content + mode 0600 +
 * no-partial / no-temp-leftbehind JSON plan file semantics.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  atomicWritePlanFile,
  cleanupTestCruft,
} from "../../src/commands/cleanup-test-cruft";

const ROOT = join(tmpdir(), "nautilo-stack198-plan-out");
mkdirSync(ROOT, { recursive: true });
let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(join(ROOT, "wt-"));
});
afterEach(() => {
  try {
    rmSync(worktree, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

const DEFAULT_ENV = { NAUTILO_INSTANCE_ID: "default" } as NodeJS.ProcessEnv;
const NAMED_ENV = { NAUTILO_INSTANCE_ID: "stack198-test" } as NodeJS.ProcessEnv;

describe("cleanup-test-cruft --plan-out (pre-DB validation, no DB)", () => {
  let errCapture: string[];
  let stdoutCapture: string[];
  const origErr = console.error;
  const origLog = console.log;

  beforeEach(() => {
    errCapture = [];
    stdoutCapture = [];
    console.error = (...xs: unknown[]) => {
      errCapture.push(xs.join(" "));
    };
    console.log = (...xs: unknown[]) => {
      stdoutCapture.push(xs.join(" "));
    };
  });
  afterEach(() => {
    console.error = origErr;
    console.log = origLog;
  });

  test("refuses --plan-out without --plan-json before touching the DB", async () => {
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      planOut: join(worktree, "plan.json"),
      cwd: worktree,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(stdoutCapture).toEqual([]);
    expect(errCapture.join("\n")).toContain(
      "--plan-out <path> is only valid with --plan-json",
    );
  });

  test("refuses --plan-out destination that already exists (never overwrites a reviewed manifest)", async () => {
    const dest = join(worktree, "existing-plan.json");
    const reviewed = JSON.stringify({ reviewed: true, planFingerprint: "deadbeef" });
    writeFileSync(dest, reviewed, { mode: 0o600 });
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      planJson: true,
      planOut: dest,
      cwd: worktree,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(stdoutCapture).toEqual([]);
    const err = errCapture.join("\n");
    expect(err).toContain("already exists");
    expect(err).toContain("never overwritten");
    // The reviewed manifest is preserved byte-for-byte.
    expect(readFileSync(dest, "utf8")).toBe(reviewed);
  });

  test("refuses --plan-out when the parent directory does not exist", async () => {
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      planJson: true,
      planOut: join(worktree, "no-such-dir", "plan.json"),
      cwd: worktree,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(stdoutCapture).toEqual([]);
    expect(errCapture.join("\n")).toContain("parent directory does not exist");
  });

  test("refuses --plan-out when the parent path is not a directory", async () => {
    const fileAsParent = join(worktree, "a-file");
    writeFileSync(fileAsParent, "x");
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      planJson: true,
      planOut: join(fileAsParent, "plan.json"),
      cwd: worktree,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(stdoutCapture).toEqual([]);
    expect(errCapture.join("\n")).toContain("not a directory");
  });

  test("--plan-out cannot sneak into the --apply path (apply without plan-json is refused; apply cannot cause deletion)", async () => {
    // Use a named (non-default) instance so the D202 mutation guard does not
    // refuse first — the plan-out validation must be the load-bearing refusal.
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      apply: true,
      planOut: join(worktree, "plan.json"),
      cwd: worktree,
      env: NAMED_ENV,
    });
    expect(code).toBe(1);
    expect(stdoutCapture).toEqual([]);
    expect(errCapture.join("\n")).toContain(
      "--plan-out <path> is only valid with --plan-json",
    );
  });

  test("plan-json keeps malformed-plan-out refusals off stdout before DB access", async () => {
    const code = await cleanupTestCruft({
      keepUserHandles: "operator",
      planJson: true,
      planOut: join(worktree, "no-such-dir", "plan.json"),
      cwd: worktree,
      env: DEFAULT_ENV,
    });
    expect(code).toBe(1);
    expect(stdoutCapture).toEqual([]);
    expect(errCapture.join("\n")).toContain("parent directory does not exist");
  });
});

describe("atomicWritePlanFile (JSON plan file semantics, no DB)", () => {
  test("writes exact content with mode 0600 and leaves no temp behind", () => {
    const dest = join(worktree, "plan.json");
    const content = JSON.stringify(
      { command: "dev:cleanup-test-cruft", mode: "plan-json", readOnly: true, planFingerprint: "a".repeat(64) },
      null,
      2,
    );
    atomicWritePlanFile(dest, content);
    const st = statSync(dest);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readFileSync(dest, "utf8")).toBe(content);
    const leftovers = readdirSync(worktree).filter((n) =>
      n.startsWith(".nautilo-cleanup-plan."),
    );
    expect(leftovers).toEqual([]);
  });

  test("throws and leaves no target when the parent is not a directory", () => {
    const fileAsParent = join(worktree, "a-file");
    writeFileSync(fileAsParent, "x");
    expect(() => atomicWritePlanFile(join(fileAsParent, "plan.json"), "{}")).toThrow();
    expect(existsSync(join(fileAsParent, "plan.json"))).toBe(false);
  });

  test("throws and leaves no temp when the parent directory is missing", () => {
    const dest = join(worktree, "missing", "plan.json");
    expect(() => atomicWritePlanFile(dest, "{}")).toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(worktree, "missing"))).toBe(false);
  });

  test("does not perturb an existing sibling file on a failed write", () => {
    const sibling = join(worktree, "sibling.json");
    writeFileSync(sibling, "keep-me", { mode: 0o600 });
    // Parent is a file → write fails.
    const fileAsParent = join(worktree, "blocker");
    writeFileSync(fileAsParent, "x");
    expect(() => atomicWritePlanFile(join(fileAsParent, "plan.json"), "{}")).toThrow();
    expect(readFileSync(sibling, "utf8")).toBe("keep-me");
  });
});
