import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { DeployConfigV1 } from "../../src/index.ts";
import { DeployConfigV1ForMigration } from "../../../config-guard/src/deploy-config-for-migration";
import { migrateSetupTomlToDeployToml } from "../../../config-guard/src/setup-toml-migration";
import { SetupTemplateV1 as SetupTemplateV1Migration } from "../../../config-guard/src/setup-template-v1-for-migration";
import type { AuditEntry } from "../../../config-guard/src/types";
import { SetupTemplateV1 as SetupTemplateV1Canonical } from "../../../api-client/src/schemas/setup-template.ts";

describe("migrateSetupTomlToDeployToml (M091 Phase 4b)", () => {
  let dir: string | undefined;
  let deployPath: string | undefined;
  let bootstrapDir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
    deployPath = undefined;
    bootstrapDir = undefined;
  });

  test("SetupTemplateV1 (migration mirror) matches api-client schema on fixtures", () => {
    const raw = {
      schemaVersion: 1,
      admin: {
        handle: "h",
        displayName: "D",
        password: { value: "passwordpassword" },
      },
      claim: { inviteCode: { value: "inv" } },
      providers: [],
      genie: { mode: "skip" as const },
    };
    const a = SetupTemplateV1Canonical.safeParse(raw);
    const b = SetupTemplateV1Migration.safeParse(raw);
    expect(a.success).toBe(b.success);
    if (a.success && b.success) {
      expect(b.data).toEqual(a.data);
    }
  });

  test.each([true, false])(
    "historical setup parser recognizes forcePasswordChangeOnFirstSignIn=%s while the current schema rejects it",
    (forcePasswordChangeOnFirstSignIn) => {
      const raw = {
        schemaVersion: 1,
        admin: {
          handle: "h",
          displayName: "D",
          password: { value: "passwordpassword" },
          forcePasswordChangeOnFirstSignIn,
        },
        claim: { inviteCode: { value: "inv" } },
      };

      expect(SetupTemplateV1Migration.safeParse(raw).success).toBe(true);
      expect(SetupTemplateV1Canonical.safeParse(raw).success).toBe(false);
    },
  );

  test("DeployConfigV1ForMigration matches apps/cli DeployConfigV1 on fixtures", () => {
    const payloads = [
      {
        schemaVersion: 1 as const,
        admin: {
          handle: "admin",
          displayName: "Admin",
          password: { fromEnv: "NAUTILO_ADMIN_PW" },
        },
        providers: [] as { key: string; value: { fromEnv: string } | { value: string } }[],
      },
      {
        schemaVersion: 1 as const,
        admin: {
          handle: "admin",
          displayName: "Admin",
          password: { value: "passwordpassword" },
          pin: { fromEnv: "PIN_ENV" },
        },
        providers: [
          { key: "OPENAI_API_KEY", value: { fromEnv: "OPENAI_API_KEY" } },
        ],
        genie: { mode: "skip" as const },
      },
    ];
    for (const p of payloads) {
      const a = DeployConfigV1.safeParse(p);
      const b = DeployConfigV1ForMigration.safeParse(p);
      expect(a.success).toBe(b.success);
      if (a.success && b.success) {
        expect(b.data).toEqual(a.data);
      }
    }
  });

  test.each([true, false])(
    "current deploy schemas reject forcePasswordChangeOnFirstSignIn=%s",
    (forcePasswordChangeOnFirstSignIn) => {
      const payload = {
        schemaVersion: 1,
        admin: {
          handle: "admin",
          displayName: "Admin",
          password: { value: "passwordpassword" },
          forcePasswordChangeOnFirstSignIn,
        },
      };

      expect(DeployConfigV1.safeParse(payload).success).toBe(false);
      expect(DeployConfigV1ForMigration.safeParse(payload).success).toBe(false);
    },
  );

  test("no setup.toml → no-op", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    const r = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    expect(r.status).toBe("no-op");
    expect(r.setupTomlBackup).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(existsSync(deployPath)).toBe(false);
  });

  test("converts setup.toml, archives, audit row, stderr banner", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    const setupPath = join(dir, "setup.toml");
    const auditPath = join(dir, "config-audit.jsonl");
    const setupBody = `schemaVersion = 1
serverUrl = "https://example.com"

[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }

[claim]
inviteCode = { value = "INV-1" }

[[providers]]
key = "OPENAI_API_KEY"
value = { fromEnv = "OPENAI_API_KEY" }

[genie]
mode = "skip"
`;
    writeFileSync(setupPath, setupBody, { mode: 0o600 });

    const stderr: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    };
    try {
      const r = migrateSetupTomlToDeployToml(dir, {
        deployTomlPath: deployPath,
        bootstrapDir,
        now: new Date("2026-05-13T12:00:00.000Z"),
      });
      expect(r.status).toBe("converted");
      expect(r.setupTomlBackup).toMatch(/setup\.toml\.bak-m091-/);
      expect(existsSync(setupPath)).toBe(false);
      expect(existsSync(r.setupTomlBackup!)).toBe(true);
      expect(readFileSync(deployPath, "utf8")).toBeTruthy();
      const deployParsed = parseToml(readFileSync(deployPath, "utf8"));
      const dv = DeployConfigV1.safeParse(deployParsed);
      expect(dv.success).toBe(true);
      expect(stderr.some((l) => l.includes("Converted") && l.includes("one-time migration"))).toBe(
        true,
      );
      expect(r.warnings.some((w) => w.includes("serverUrl"))).toBe(true);

      const invitePath = join(bootstrapDir, "claim-invite");
      expect(readFileSync(invitePath, "utf8")).toBe("INV-1");
      if (process.platform !== "win32") {
        expect(statSync(invitePath).mode & 0o777).toBe(0o600);
        expect(statSync(bootstrapDir).mode & 0o777).toBe(0o700);
      }

      const lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
      expect(last.actor).toBe("boot-migration");
      expect(last.reason).toBe("m091.setup-toml-to-deploy-toml");
      expect(last.ops).toEqual([{ type: "convert", key: "setup.toml" }]);
      expect(last.result).toBe("applied");
    } finally {
      console.error = orig;
    }
  });

  test("unknown key inside [admin] → refused; setup.toml unchanged", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    const setupPath = join(dir, "setup.toml");
    const setupBody = `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }
unknownAdminField = true

[claim]
inviteCode = { value = "x" }

[genie]
mode = "skip"
`;
    writeFileSync(setupPath, setupBody, { mode: 0o600 });

    const r = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    expect(r.status).toBe("refused-unrecognized-content");
    expect(readFileSync(setupPath, "utf8")).toBe(setupBody);
    expect(existsSync(deployPath)).toBe(false);
  });

  test("both setup.toml and deploy.toml exist → skipped-collision; files unchanged", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    const setupPath = join(dir, "setup.toml");
    const setupBody = `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }

[claim]
inviteCode = { value = "x" }
`;
    writeFileSync(setupPath, setupBody, { mode: 0o600 });
    writeFileSync(deployPath, "schemaVersion = 1\n", { mode: 0o600 });

    const r = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    expect(r.status).toBe("skipped-collision");
    expect(readFileSync(setupPath, "utf8")).toBe(setupBody);
    expect(readFileSync(deployPath, "utf8")).toBe("schemaVersion = 1\n");
  });

  test("unrecognized top-level key → refused; setup.toml unchanged", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    const setupPath = join(dir, "setup.toml");
    const setupBody = `schemaVersion = 1
extraKey = 1

[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }

[claim]
inviteCode = { value = "x" }
`;
    writeFileSync(setupPath, setupBody, { mode: 0o600 });

    const r = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    expect(r.status).toBe("refused-unrecognized-content");
    expect(readFileSync(setupPath, "utf8")).toBe(setupBody);
    expect(existsSync(deployPath)).toBe(false);
    expect(r.warnings.some((w) => w.includes("extraKey"))).toBe(true);
  });

  test("[claim].inviteCode fromEnv resolved → claim-invite file", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    const setupPath = join(dir, "setup.toml");
    writeFileSync(
      setupPath,
      `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }

[claim]
inviteCode = { fromEnv = "FOO" }

[genie]
mode = "skip"
`,
      { mode: 0o600 },
    );

    const r = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
      envLookup: (k) => (k === "FOO" ? "INVITE-XYZ" : undefined),
    });
    expect(r.status).toBe("converted");
    expect(readFileSync(join(bootstrapDir, "claim-invite"), "utf8")).toBe("INVITE-XYZ");
  });

  test("[claim].inviteCode fromEnv not resolved → no claim-invite file; deploy written; warning", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    const setupPath = join(dir, "setup.toml");
    writeFileSync(
      setupPath,
      `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }

[claim]
inviteCode = { fromEnv = "FOO" }

[genie]
mode = "skip"
`,
      { mode: 0o600 },
    );

    const r = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
      envLookup: () => undefined,
    });
    expect(r.status).toBe("converted");
    expect(existsSync(join(bootstrapDir, "claim-invite"))).toBe(false);
    expect(existsSync(deployPath)).toBe(true);
    expect(r.warnings.some((w) => w.includes("FOO") && w.includes("claim-invite"))).toBe(true);
  });

  test("[admin].password fromEnv is pass-through in deploy.toml", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    writeFileSync(
      join(dir, "setup.toml"),
      `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { fromEnv = "ADMIN_SECRET_ENV" }

[claim]
inviteCode = { value = "inv" }

[genie]
mode = "skip"
`,
      { mode: 0o600 },
    );

    const r = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    expect(r.status).toBe("converted");
    const d = parseToml(readFileSync(deployPath, "utf8")) as Record<string, unknown>;
    const admin = d["admin"] as Record<string, unknown>;
    expect(admin["password"]).toEqual({ fromEnv: "ADMIN_SECRET_ENV" });
  });

  test("second call is no-op after archive (idempotent)", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    writeFileSync(
      join(dir, "setup.toml"),
      `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }

[claim]
inviteCode = { value = "inv" }

[genie]
mode = "skip"
`,
      { mode: 0o600 },
    );

    const r1 = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    expect(r1.status).toBe("converted");
    const r2 = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    expect(r2.status).toBe("no-op");
  });

  test("emitted deploy.toml roundtrips through DeployConfigV1", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    writeFileSync(
      join(dir, "setup.toml"),
      `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }
forcePasswordChangeOnFirstSignIn = false

[claim]
inviteCode = { value = "inv" }

[[providers]]
key = "ANTHROPIC_API_KEY"
value = { value = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }

[genie]
mode = "explicit"
name = "G"
voice = "openai:alloy"
defaultModel = "openai:gpt-4.1-mini"
personality = "ppp"
`,
      { mode: 0o600 },
    );

    const result = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    expect(result.status).toBe("converted");
    expect(result.warnings.some((w) => w.includes("permanent"))).toBe(true);
    const body = readFileSync(deployPath, "utf8");
    const parsed = parseToml(body);
    const v = DeployConfigV1.safeParse(parsed);
    expect(v.success).toBe(true);
    expect(body.includes("forcePasswordChangeOnFirstSignIn")).toBe(false);
  });

  test("refuses explicit forcePasswordChangeOnFirstSignIn=true before any mutation", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    const setupPath = join(dir, "setup.toml");
    const setupBody = `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { value = "temporary-password" }
forcePasswordChangeOnFirstSignIn = true

[claim]
inviteCode = { value = "inv" }
`;
    writeFileSync(setupPath, setupBody, { mode: 0o600 });

    const result = migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });

    expect(result.status).toBe("refused-unrecognized-content");
    expect(result.setupTomlBackup).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("permanent owner password");
    expect(result.warnings[0]).toContain("remove forcePasswordChangeOnFirstSignIn");
    expect(readFileSync(setupPath, "utf8")).toBe(setupBody);
    expect(existsSync(deployPath)).toBe(false);
    expect(existsSync(bootstrapDir)).toBe(false);
    expect(existsSync(join(dir, "config-audit.jsonl"))).toBe(false);
    expect(readdirSync(dir)).toEqual(["setup.toml"]);
  });

  test("omits forcePasswordChangeOnFirstSignIn in deploy when absent in setup TOML", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-setup-"));
    deployPath = join(dir, "deploy.toml");
    bootstrapDir = join(dir, ".bootstrap");
    writeFileSync(
      join(dir, "setup.toml"),
      `schemaVersion = 1
[admin]
handle = "h"
displayName = "D"
password = { value = "passwordpassword" }

[claim]
inviteCode = { value = "inv" }

[genie]
mode = "skip"
`,
      { mode: 0o600 },
    );

    migrateSetupTomlToDeployToml(dir, {
      deployTomlPath: deployPath,
      bootstrapDir,
    });
    const text = readFileSync(deployPath, "utf8");
    expect(text.includes("forcePasswordChangeOnFirstSignIn")).toBe(false);
    const parsed = parseToml(text);
    const v = DeployConfigV1.safeParse(parsed);
    expect(v.success).toBe(true);
    if (v.success) {
      expect("forcePasswordChangeOnFirstSignIn" in v.data.admin).toBe(false);
    }
  });
});
