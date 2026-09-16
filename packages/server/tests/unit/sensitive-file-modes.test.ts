/**
 * D120 A1.P3 — regression tests for sensitive file writers (mode 0600,
 * paths outside the monorepo git tree when using isolated $HOME).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { appendOperatorSecrets } from "@nautilo/operator-secrets";
import { runResetLogtoAdminPassword } from "../../../../bin/nautilo-dev/src/commands/reset-logto-admin-password.ts";
import { ensureLogtoAdminCredentialFile } from "../../../../bin/nautilo-local/src/bootstrap-logto.ts";
import { writeFileAtomic } from "../../../../packages/config-guard/src/env-writer.ts";

const REPO_ROOT = pathResolve(import.meta.dirname, "..", "..", "..", "..");

function assertPathOutsideGitWorkTree(absPath: string): void {
  const resolvedFile = pathResolve(absPath);
  const resolvedRoot = pathResolve(REPO_ROOT);
  if (process.platform === "win32") return;
  const underRepo =
    resolvedFile === resolvedRoot ||
    resolvedFile.startsWith(`${resolvedRoot}/`);
  expect(underRepo).toBe(false);
}

async function assertMode600(filePath: string): Promise<void> {
  if (process.platform === "win32") return;
  const st = await stat(filePath);
  expect(st.mode & 0o777).toBe(0o600);
}

describe("sensitive file writers (D120 A1.P3)", () => {
  let priorHome: string | undefined;
  let priorInstance: string | undefined;
  let tmpHome: string;

  beforeEach(async () => {
    priorHome = process.env["HOME"];
    priorInstance = process.env["NAUTILO_INSTANCE_ID"];
    delete process.env["NAUTILO_INSTANCE_ID"];
    tmpHome = await mkdtemp(join(tmpdir(), "nautilo-sens-"));
    process.env["HOME"] = tmpHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = priorHome;
    if (priorInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = priorInstance;
    await rm(tmpHome, { recursive: true, force: true });
  });

  test("appendOperatorSecrets creates ~/.config/nautilo/secrets.env at 0600 outside repo", async () => {
    const secretsPath = join(tmpHome, ".config", "nautilo", "secrets.env");
    await appendOperatorSecrets({
      path: secretsPath,
      entries: [{ key: "TAVILY_API_KEY", value: "tvly_test_12345678901" }],
    });
    assertPathOutsideGitWorkTree(secretsPath);
    await assertMode600(secretsPath);
  });

  test("config-guard writeFileAtomic creates file at 0600 outside repo", async () => {
    const envPath = join(tmpHome, ".nautilo", "instance.env");
    await writeFileAtomic(envPath, "OPENAI_API_KEY=sk-test-placeholder\n");
    assertPathOutsideGitWorkTree(envPath);
    await assertMode600(envPath);
  });

  test("ensureLogtoAdminCredentialFile default writer uses 0600 outside repo", async () => {
    const target = join(tmpHome, "nautilo-root", "logto-admin.txt");
    const wrote = ensureLogtoAdminCredentialFile(
      {
        username: "nautilo_admin",
        password: "unit-test-secret",
        adminUrl: "http://localhost:3302",
      },
      {
        resolvePath: () => target,
        exists: () => false,
        log: () => {
          /* quiet */
        },
      },
    );
    expect(wrote).toBe(true);
    assertPathOutsideGitWorkTree(target);
    await assertMode600(target);
  });

  test("reset-logto-admin-password default writer uses 0600 outside repo", async () => {
    const target = join(tmpHome, "logto-admin-rotated.txt");
    const code = await runResetLogtoAdminPassword(
      { outputPath: target },
      {
        readMAdminSecret: async () => "fake-secret",
        mintAdminToken: async () => "fake-token",
        findAdminUserId: async () => "user-1",
        setUserPassword: async () => {
          /* no-op */
        },
        log: () => {
          /* quiet */
        },
        isoStamp: () => "2026-01-01T00:00:00.000Z",
      },
    );
    expect(code).toBe(0);
    assertPathOutsideGitWorkTree(target);
    await assertMode600(target);
  });

  test.skip(
    "claim-invite.txt unlink after successful redeem — requires full redeem path + DB",
    () => {
      /* No portable unit hook: redemption lives in packages/server invites flow;
         claim file mint is DB-backed in bootstrap-claim-invite.ts. */
    },
  );

  test.skip(
    "logto-admin.txt unlink after first sign-in — no automated unlink in codebase",
    () => {
      /* Documented as manual operator delete; nothing to assert until product adds cleanup. */
    },
  );
});
