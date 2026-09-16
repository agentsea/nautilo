import { test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isBootstrapUsed } from "@nautilo/operator-secrets";
import {
  runDoctorMigrateConfig,
} from "../../src/lib/doctor-migrate-config.ts";

function operatorSecretsPath(home: string): string {
  return join(home, ".config", "nautilo", "secrets.env");
}

function deployTomlExamplePath(home: string): string {
  return join(home, ".config", "nautilo", "deploy.toml.example");
}

function mkHome(): string {
  return join(tmpdir(), `nm091-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function writeSecrets600(path: string, body: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

test("no secrets.env → no-op-no-secrets-file", async () => {
  const home = mkHome();
  const r = await runDoctorMigrateConfig({ home });
  expect(r.status).toBe("no-op-no-secrets-file");
  expect(r.providerKeysExtracted).toEqual([]);
});

test("already migrated (deploy.toml.example mtime >= secrets.env) → no-op-already-migrated", async () => {
  const home = mkHome();
  const cfg = join(home, ".config", "nautilo");
  mkdirSync(cfg, { recursive: true, mode: 0o700 });
  const sec = join(cfg, "secrets.env");
  const dep = join(cfg, "deploy.toml.example");
  writeSecrets600(sec, "OPENAI_API_KEY=sk-old\n");
  utimesSync(sec, new Date("2019-06-01T00:00:00.000Z"), new Date("2019-06-01T00:00:00.000Z"));
  writeFileSync(dep, "schemaVersion = 1\n", { mode: 0o644 });
  chmodSync(dep, 0o644);
  utimesSync(dep, new Date("2030-01-02T00:00:00.000Z"), new Date("2030-01-02T00:00:00.000Z"));
  const r = await runDoctorMigrateConfig({ home });
  expect(r.status).toBe("no-op-already-migrated");
});

test("happy path: providers + beta bootstrap → migrated; backup; secrets stripped; deploy blocks", async () => {
  const home = mkHome();
  const sec = operatorSecretsPath(home);
  const dep = deployTomlExamplePath(home);
  const betaRoot = join(home, ".nautilo-beta");
  mkdirSync(betaRoot, { recursive: true, mode: 0o700 });
  writeSecrets600(
    sec,
    [
      "OPENAI_API_KEY=sk-openai-111",
      "ANTHROPIC_API_KEY=sk-ant-222",
      "OPENROUTER_API_KEY=sk-or-333",
      "NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_BETA=bpw",
      "NAUTILO_BOOTSTRAP_PIN_BETA=123456",
    ].join("\n") + "\n",
  );
  const r = await runDoctorMigrateConfig({
    home,
    checkInstanceClaimedFn: async () => false,
  });
  expect(r.status).toBe("migrated");
  expect(r.providerKeysExtracted.sort()).toEqual([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
  expect(r.operatorFileBackupPath).not.toBeNull();
  expect(existsSync(r.operatorFileBackupPath!)).toBe(true);
  expect(existsSync(dep)).toBe(true);
  const deployTxt = readFileSync(dep, "utf8");
  const provBlocks = deployTxt.match(/\[\[providers\]\]/g) ?? [];
  expect(provBlocks.length).toBe(3);
  expect(readFileSync(join(betaRoot, ".bootstrap", "admin-password"), "utf8").trim()).toBe("bpw");
  expect(readFileSync(join(betaRoot, ".bootstrap", "admin-pin"), "utf8").trim()).toBe("123456");
  const newSec = readFileSync(sec, "utf8");
  expect(newSec).toContain("DEPRECATED");
  expect(newSec).toContain("OPENAI_API_KEY=sk-openai-111");
  expect(newSec).not.toContain("NAUTILO_BOOTSTRAP");
  expect(r.perInstance.some((p) => p.instanceId === "beta")).toBe(true);
});

test("per-instance row for missing instance dir → warning; migration otherwise succeeds", async () => {
  const home = mkHome();
  const sec = operatorSecretsPath(home);
  mkdirSync(join(home, ".nautilo-beta"), { recursive: true, mode: 0o700 });
  writeSecrets600(
    sec,
    [
      "OPENAI_API_KEY=k",
      "NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_GHOST=ghostpw",
      "NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_BETA=b",
    ].join("\n") + "\n",
  );
  const r = await runDoctorMigrateConfig({ home, checkInstanceClaimedFn: async () => false });
  expect(r.status).toBe("migrated");
  expect(r.warnings.some((w) => w.includes("ghost") && w.includes("no ") && w.includes("directory found"))).toBe(
    true,
  );
  expect(existsSync(join(home, ".nautilo-beta", ".bootstrap", "admin-password"))).toBe(true);
});

test("claim check inject true → .used; false → no .used; throw → claimCheckError", async () => {
  const home = mkHome();
  const sec = operatorSecretsPath(home);
  mkdirSync(join(home, ".nautilo-beta"), { recursive: true, mode: 0o700 });
  writeSecrets600(sec, "OPENAI_API_KEY=x\nNAUTILO_BOOTSTRAP_ADMIN_PASSWORD_BETA=pw\n");

  const rTrue = await runDoctorMigrateConfig({
    home,
    checkInstanceClaimedFn: async () => true,
  });
  expect(rTrue.status).toBe("migrated");
  const dirTrue = join(home, ".nautilo-beta", ".bootstrap");
  expect(isBootstrapUsed(dirTrue)).toBe(true);

  const home2 = mkHome();
  writeSecrets600(join(home2, ".config", "nautilo", "secrets.env"), "OPENAI_API_KEY=x\nNAUTILO_BOOTSTRAP_ADMIN_PASSWORD_BETA=pw2\n");
  mkdirSync(join(home2, ".nautilo-beta"), { recursive: true, mode: 0o700 });
  const rFalse = await runDoctorMigrateConfig({
    home: home2,
    checkInstanceClaimedFn: async () => false,
  });
  expect(isBootstrapUsed(join(home2, ".nautilo-beta", ".bootstrap"))).toBe(false);
  expect(rFalse.perInstance.find((p) => p.instanceId === "beta")?.markedUsed).toBe(false);

  const home3 = mkHome();
  writeSecrets600(join(home3, ".config", "nautilo", "secrets.env"), "OPENAI_API_KEY=x\nNAUTILO_BOOTSTRAP_ADMIN_PASSWORD_BETA=pw3\n");
  mkdirSync(join(home3, ".nautilo-beta"), { recursive: true, mode: 0o700 });
  const rThrow = await runDoctorMigrateConfig({
    home: home3,
    checkInstanceClaimedFn: async () => {
      throw new Error("db boom");
    },
  });
  const betaOut = rThrow.perInstance.find((p) => p.instanceId === "beta");
  expect(betaOut?.claimCheckError).toBe("db boom");
  expect(rThrow.warnings.some((w) => w.includes("claim-status check failed"))).toBe(true);
});

test("dry-run: status dry-run; no deploy backup or bootstrap files written", async () => {
  const home = mkHome();
  const sec = operatorSecretsPath(home);
  mkdirSync(join(home, ".nautilo-beta"), { recursive: true, mode: 0o700 });
  writeSecrets600(sec, "OPENAI_API_KEY=z\nNAUTILO_BOOTSTRAP_PIN_BETA=999999\n");
  const dep = deployTomlExamplePath(home);
  const r = await runDoctorMigrateConfig({
    home,
    dryRun: true,
    checkInstanceClaimedFn: async () => true,
  });
  expect(r.status).toBe("dry-run");
  expect(existsSync(dep)).toBe(false);
  expect(existsSync(join(home, ".nautilo-beta", ".bootstrap", "admin-pin"))).toBe(false);
  expect(r.dryRunWrites?.length).toBeGreaterThan(0);
});

test("idempotency: second run is no-op-already-migrated", async () => {
  const home = mkHome();
  const sec = operatorSecretsPath(home);
  mkdirSync(join(home, ".nautilo-beta"), { recursive: true, mode: 0o700 });
  writeSecrets600(sec, "OPENAI_API_KEY=a\nNAUTILO_BOOTSTRAP_ADMIN_PASSWORD_BETA=p\n");
  const first = await runDoctorMigrateConfig({ home, checkInstanceClaimedFn: async () => false });
  expect(first.status).toBe("migrated");
  const second = await runDoctorMigrateConfig({ home, checkInstanceClaimedFn: async () => false });
  expect(second.status).toBe("no-op-already-migrated");
});

test("suffix collapse: two instance dirs mapping to same secret suffix → lossy warning", async () => {
  const home = mkHome();
  mkdirSync(join(home, ".nautilo-test-1"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".nautilo-test_1"), { recursive: true, mode: 0o700 });
  const sec = operatorSecretsPath(home);
  writeSecrets600(sec, "OPENAI_API_KEY=x\nNAUTILO_BOOTSTRAP_ADMIN_PASSWORD_TEST_1=secret\n");
  const r = await runDoctorMigrateConfig({ home, checkInstanceClaimedFn: async () => false });
  expect(r.warnings.some((w) => w.includes("lossy") && w.includes("TEST_1"))).toBe(true);
  expect("TEST_1".toLowerCase().replace(/_/g, "-")).toBe("test-1");
});

test("unrecognized key preserved verbatim with deprecation header", async () => {
  const home = mkHome();
  const sec = operatorSecretsPath(home);
  mkdirSync(join(home, ".nautilo"), { recursive: true, mode: 0o700 });
  writeSecrets600(sec, "OPENAI_API_KEY=verbatim\nMY_CUSTOM_OPERATOR_KEY=keep-me\n");
  const r = await runDoctorMigrateConfig({ home });
  expect(r.status).toBe("migrated");
  expect(r.warnings.some((w) => w.includes("MY_CUSTOM_OPERATOR_KEY"))).toBe(true);
  const body = readFileSync(sec, "utf8");
  expect(body).toContain("OPENAI_API_KEY=verbatim");
  expect(body).toContain("MY_CUSTOM_OPERATOR_KEY=keep-me");
});

test("instance suffix decode is case-correct: BETA env-row → .nautilo-beta dir (Linux case-sensitive regression)", async () => {
  // Pre-fix bug: instanceRootForSuffix used the raw uppercase env-suffix,
  // so `existsSync(home/.nautilo-BETA)` returned false on Linux even when
  // the operator had `home/.nautilo-beta` on disk. Materialization silently
  // skipped with a "no directory found" warning. Macs masked the bug because
  // HFS/APFS is case-insensitive by default.
  const home = mkHome();
  const sec = operatorSecretsPath(home);
  // ONLY the lowercase form on disk.
  mkdirSync(join(home, ".nautilo-beta"), { recursive: true, mode: 0o700 });
  writeSecrets600(sec, "OPENAI_API_KEY=ok\nNAUTILO_BOOTSTRAP_ADMIN_PASSWORD_BETA=bpw\n");
  const r = await runDoctorMigrateConfig({ home, checkInstanceClaimedFn: async () => false });
  expect(r.status).toBe("migrated");
  // No "no directory found" warning — the dir IS there, we just need to
  // look under the lowercase path.
  expect(r.warnings.some((w) => w.includes("no ") && w.includes("directory found"))).toBe(false);
  expect(existsSync(join(home, ".nautilo-beta", ".bootstrap", "admin-password"))).toBe(true);
});

test("profile-env sweep: legacy <name>.env files migrated to bootstrap-tokens/<name>; result reported", async () => {
  const home = mkHome();
  const profilesDir = join(home, ".nautilo", "profiles");
  mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  const fooEnv = join(profilesDir, "foo.env");
  const barEnv = join(profilesDir, "bar.env");
  writeFileSync(fooEnv, "NAUTILO_BOOTSTRAP_TOKEN=foo-token\n", { mode: 0o600 });
  writeFileSync(barEnv, "OTHER_KEY=v\n", { mode: 0o600 });
  // Also: a dotfile that must be skipped (mirrors the .active sentinel).
  writeFileSync(join(profilesDir, ".active"), "foo\n", { mode: 0o600 });
  // No secrets.env on disk → status no-op-no-secrets-file, but sweep still runs.
  const r = await runDoctorMigrateConfig({ home });
  expect(r.status).toBe("no-op-no-secrets-file");

  const fooEntry = r.profileEnvSweep.find((e) => e.profileName === "foo");
  const barEntry = r.profileEnvSweep.find((e) => e.profileName === "bar");
  expect(fooEntry?.result.migrated).toBe(true);
  expect(barEntry?.result.migrated).toBe(false);
  expect(barEntry?.result.reason).toBe("no-bootstrap-token-line");

  const tokenPath = join(home, ".nautilo", "bootstrap-tokens", "foo");
  expect(readFileSync(tokenPath, "utf8")).toBe("foo-token");
  expect(existsSync(fooEnv)).toBe(false);
  expect(existsSync(barEnv)).toBe(true); // bar untouched: nothing to migrate
});

test("profile-env sweep: dry-run does NOT mutate; warning surfaced", async () => {
  const home = mkHome();
  const profilesDir = join(home, ".nautilo", "profiles");
  mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  const envPath = join(profilesDir, "demo.env");
  writeFileSync(envPath, "NAUTILO_BOOTSTRAP_TOKEN=should-not-move\n", { mode: 0o600 });
  const r = await runDoctorMigrateConfig({ home, dryRun: true });
  expect(r.status).toBe("no-op-no-secrets-file"); // no secrets.env → still status no-op (dry-run flag does NOT change status when no work to do)
  expect(r.profileEnvSweep).toEqual([]);
  expect(r.warnings.some((w) => w.includes("dry-run") && w.includes("profiles"))).toBe(true);
  expect(existsSync(envPath)).toBe(true);
  expect(
    existsSync(join(home, ".nautilo", "bootstrap-tokens", "demo")),
  ).toBe(false);
});
