import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { spawnSync } from "node:child_process";
import { SetupTemplateV1 } from "@nautilo/api-client";

const devEntry = join(import.meta.dirname, "..", "..", "src", "index.ts");
const cliDist = join(import.meta.dirname, "..", "..", "..", "..", "apps", "cli", "dist", "index.js");

describe("gen-setup-template", () => {
  test("generated TOML parses and honors seed; providers default to fromEnv", () => {
    const instDir = mkdtempSync(join(tmpdir(), "nautilo-gen-"));
    const inst = `test-${Date.now()}`;
    const home = join(instDir, "home");
    mkdirSync(join(home, `.nautilo-${inst}`), { recursive: true });
    writeFileSync(
      join(home, `.nautilo-${inst}`, "claim-invite.txt"),
      "# Nautilo bootstrap claim invite\nredeem_input: inv_test_token_xyz\ntoken: inv_test_token_xyz\n",
    );

    const out = join(instDir, "setup.toml");
    const r = spawnSync("bun", [devEntry, "gen-setup-template", "--instance", inst, "--randomize-genie", "--seed", "42", "--provider", "openai=env:OPENAI_API_KEY", "--out", out], {
      encoding: "utf8",
      cwd: join(import.meta.dirname, "..", ".."),
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(".bootstrap");
    const raw = readFileSync(out, "utf8");
    expect(raw).not.toContain("forcePasswordChangeOnFirstSignIn");
    const parsed = parseToml(raw);
    const v = SetupTemplateV1.safeParse(parsed);
    expect(v.success).toBe(true);
    if (v.success) {
      expect(v.data.genie?.mode).toBe("randomize");
      expect((v.data.genie as { seed?: number }).seed).toBe(42);
      expect(v.data.providers[0]?.value).toEqual({ fromEnv: "OPENAI_API_KEY" });
      const suffix = inst.replace(/-/g, "_").toUpperCase();
      expect(v.data.admin.password).toEqual({
        fromEnv: `NAUTILO_BOOTSTRAP_ADMIN_PASSWORD_${suffix}`,
      });
      expect(v.data.admin.pin).toEqual({ fromEnv: `NAUTILO_BOOTSTRAP_PIN_${suffix}` });
      expect(raw).not.toMatch(/\{\s*value\s*=/);
    }
    const bootstrapDir = join(home, `.nautilo-${inst}`, ".bootstrap");
    expect(existsSync(join(bootstrapDir, "admin-password"))).toBe(true);
    expect(existsSync(join(bootstrapDir, "admin-pin"))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(bootstrapDir, "admin-password")).mode & 0o777).toBe(0o600);
      expect(statSync(join(bootstrapDir, "admin-pin")).mode & 0o777).toBe(0o600);
    }
    const secretsPath = join(home, ".config", "nautilo", "secrets.env");
    expect(existsSync(secretsPath)).toBe(false);
    if (process.platform !== "win32") {
      const mode = statSync(out).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("rejects the removed force-password-change flag before writing output", () => {
    const instDir = mkdtempSync(join(tmpdir(), "nautilo-gen-removed-flag-"));
    const inst = `test-${Date.now()}`;
    const home = join(instDir, "home");
    mkdirSync(join(home, `.nautilo-${inst}`), { recursive: true });

    for (const removedFlag of ["--force-password-change", "--force-password-change=false"]) {
      const out = join(instDir, `setup-${removedFlag.length}.toml`);
      const r = spawnSync(
        "bun",
        [
          devEntry,
          "gen-setup-template",
          "--instance",
          inst,
          "--claim-code",
          "inv_test_token_xyz",
          removedFlag,
          "--out",
          out,
        ],
        {
          encoding: "utf8",
          cwd: join(import.meta.dirname, "..", ".."),
          env: { ...process.env, HOME: home },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("unknown option: --force-password-change");
      expect(existsSync(out)).toBe(false);
    }
  });

  test("--all-providers-from-secrets imports every recognized envVar from operator file", () => {
    const instDir = mkdtempSync(join(tmpdir(), "nautilo-gen-all-"));
    const inst = `test-${Date.now()}`;
    const home = join(instDir, "home");
    mkdirSync(join(home, `.nautilo-${inst}`), { recursive: true });
    writeFileSync(
      join(home, `.nautilo-${inst}`, "claim-invite.txt"),
      "redeem_input: inv_test_all_xyz\n",
    );
    const secretsDir = join(home, ".config", "nautilo");
    mkdirSync(secretsDir, { recursive: true });
    const secretsPath = join(secretsDir, "secrets.env");
    writeFileSync(
      secretsPath,
      [
        "OPENAI_API_KEY=sk-fake-openai",
        "ANTHROPIC_API_KEY=sk-ant-api03-fake",
        "TAVILY_API_KEY=tvly-fake",
        "UNRELATED_VAR=ignored",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const out = join(instDir, "setup.toml");
    const r = spawnSync(
      "bun",
      [
        devEntry,
        "gen-setup-template",
        "--instance",
        inst,
        "--all-providers-from-secrets",
        "--out",
        out,
      ],
      {
        encoding: "utf8",
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("auto-included 3 providers");
    const v = SetupTemplateV1.safeParse(parseToml(readFileSync(out, "utf8")));
    expect(v.success).toBe(true);
    if (v.success) {
      const ids = v.data.providers.map((p) => p.key).sort();
      expect(ids).toEqual([
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "TAVILY_API_KEY",
      ]);
    }
  });

  test("--all-providers-from-secrets does not duplicate explicit --provider flags", () => {
    const instDir = mkdtempSync(join(tmpdir(), "nautilo-gen-dedupe-"));
    const inst = `test-${Date.now()}`;
    const home = join(instDir, "home");
    mkdirSync(join(home, `.nautilo-${inst}`), { recursive: true });
    writeFileSync(
      join(home, `.nautilo-${inst}`, "claim-invite.txt"),
      "redeem_input: inv_test_dedupe_xyz\n",
    );
    const secretsDir = join(home, ".config", "nautilo");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(
      join(secretsDir, "secrets.env"),
      "OPENAI_API_KEY=sk-fake\nANTHROPIC_API_KEY=sk-ant-api03-fake\n",
      { mode: 0o600 },
    );

    const out = join(instDir, "setup.toml");
    const r = spawnSync(
      "bun",
      [
        devEntry,
        "gen-setup-template",
        "--instance",
        inst,
        "--provider",
        "openai=env:OPENAI_API_KEY",
        "--all-providers-from-secrets",
        "--out",
        out,
      ],
      {
        encoding: "utf8",
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(r.status).toBe(0);
    const v = SetupTemplateV1.safeParse(parseToml(readFileSync(out, "utf8")));
    expect(v.success).toBe(true);
    if (v.success) {
      const ids = v.data.providers.map((p) => p.key).sort();
      // OPENAI added once (explicit) + ANTHROPIC added once (auto). No dup.
      expect(ids).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    }
  });

  test("refuses missing instance dir under HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-no-inst-"));
    const out = join(home, "setup.toml");
    const r = spawnSync(
      "bun",
      [devEntry, "gen-setup-template", "--instance", "missing-instance-xyz", "--claim-code", "x", "--out", out],
      {
        encoding: "utf8",
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("instance directory");
  });

  test("nautilo-dev string does not appear in apps/cli dist bundle", () => {
    if (!existsSync(cliDist)) {
      throw new Error("build apps/cli first for this assertion");
    }
    const bundle = readFileSync(cliDist, "utf8");
    expect(bundle.includes("nautilo-dev")).toBe(false);
  });
});
