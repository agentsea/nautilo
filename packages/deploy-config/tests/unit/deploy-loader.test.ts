import { describe, test, expect, afterEach } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeployConfigV1 } from "../../src/deploy-schema.ts";
import {
  EnvVarMissingError,
  parseDeployConfigFromPath,
  resolveDeployConfig,
} from "../../src/deploy-loader.ts";

const tmpDirsToClean: string[] = [];

afterEach(() => {
  for (const d of tmpDirsToClean) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirsToClean.length = 0;
});

function freshTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirsToClean.push(d);
  return d;
}

function writeDeployFile(dir: string, body: string): string {
  const f = join(dir, "deploy.toml");
  writeFileSync(f, body);
  if (process.platform !== "win32") {
    chmodSync(f, 0o600);
  }
  return f;
}

const adminToml = `[admin]
handle = "alice"
displayName = "Alice Operator"
password = { fromEnv = "NAUTILO_ADMIN_PASSWORD" }
`;

describe("deploy-loader", () => {
  test("happy path: parse + resolve with custom EnvLookup", () => {
    const d = DeployConfigV1.parse({
      schemaVersion: 1,
      admin: {
        handle: "alice",
        displayName: "Alice Operator",
        password: { fromEnv: "NAUTILO_ADMIN_PASSWORD" },
        pin: { fromEnv: "NAUTILO_ADMIN_PIN" },
      },
      providers: [
        { key: "OPENAI_API_KEY", value: { fromEnv: "OPENAI_API_KEY" } },
      ],
    });
    const lookup = (name: string) => {
      if (name === "NAUTILO_ADMIN_PASSWORD") return "password-ok-8+";
      if (name === "NAUTILO_ADMIN_PIN") return "123456";
      if (name === "OPENAI_API_KEY") return "sk-test";
      return undefined;
    };
    const r = resolveDeployConfig(d, lookup);
    expect(r.admin.password.value).toBe("password-ok-8+");
    expect(r.admin.pin?.value).toBe("123456");
    expect(r.providers[0]?.value.value).toBe("sk-test");
  });

  test("happy path: parseDeployConfigFromPath reads valid deploy.toml", () => {
    if (process.platform === "win32") return;
    const dir = freshTmp("nautilo-deploy-");
    const f = writeDeployFile(
      dir,
      `schemaVersion = 1
${adminToml}`,
    );
    const parsed = parseDeployConfigFromPath(f);
    expect(parsed.admin.handle).toBe("alice");
  });

  test("file mode 0644 rejected on non-Windows; 0600 passes", () => {
    if (process.platform === "win32") return;

    const dirBad = freshTmp("nautilo-deploy-bad-");
    const bad = join(dirBad, "deploy.toml");
    writeFileSync(
      bad,
      `schemaVersion = 1
${adminToml}`,
      { mode: 0o644 },
    );

    expect(() => parseDeployConfigFromPath(bad)).toThrow(
      "setup file must be chmod 600",
    );

    const dirGood = freshTmp("nautilo-deploy-good-");
    const good = writeDeployFile(
      dirGood,
      `schemaVersion = 1
${adminToml}`,
    );
    expect(parseDeployConfigFromPath(good).schemaVersion).toBe(1);
  });

  test("git-tree defense: rejects when .git exists in ancestor", () => {
    if (process.platform === "win32") return;

    const dir = freshTmp("nautilo-deploy-git-");
    mkdirSync(join(dir, ".git"));
    const f = writeDeployFile(
      dir,
      `schemaVersion = 1
${adminToml}`,
    );
    expect(() => parseDeployConfigFromPath(f)).toThrow(
      "refusing to load deploy config from inside a git work tree",
    );
  });

  test("forbidden top-level sections: logto, network, ports, db, etc.", () => {
    if (process.platform === "win32") return;

    const sections = [
      "logto",
      "network",
      "topology",
      "ports",
      "db",
      "database",
      "server",
      "hosting",
    ];
    for (const section of sections) {
      const dir = freshTmp(`nautilo-deploy-forbid-${section}-`);
      const f = writeDeployFile(
        dir,
        `schemaVersion = 1
${adminToml}
[${section}]
x = 1
`,
      );
      expect(() => parseDeployConfigFromPath(f)).toThrow(
        `${section}: this belongs in ~/.nautilo\${suffix}/instance.env, not deploy.toml`,
      );
    }
  });

  test("forbidden flat key LOGTO_ENDPOINT at top level", () => {
    if (process.platform === "win32") return;
    const dir = freshTmp("nautilo-deploy-logto-top-");
    const f = writeDeployFile(
      dir,
      `schemaVersion = 1
LOGTO_ENDPOINT = "https://example.test"
${adminToml}
`,
    );
    expect(() => parseDeployConfigFromPath(f)).toThrow(
      "LOGTO_ENDPOINT: this belongs in ~/.nautilo${suffix}/instance.env, not deploy.toml",
    );
  });

  test("forbidden flat key nested under admin", () => {
    if (process.platform === "win32") return;
    const dir = freshTmp("nautilo-deploy-logto-admin-");
    const f = writeDeployFile(
      dir,
      `schemaVersion = 1
[admin]
handle = "a"
displayName = "A"
password = { value = "12345678" }
LOGTO_ISSUER = "bad"
`,
    );
    expect(() => parseDeployConfigFromPath(f)).toThrow(
      "admin.LOGTO_ISSUER: this belongs in ~/.nautilo${suffix}/instance.env, not deploy.toml",
    );
  });

  test("forbidden provider key LOGTO_M2M_APP_SECRET: tailored Logto message", () => {
    if (process.platform === "win32") return;
    const dir = freshTmp("nautilo-deploy-prov-logto-");
    const f = writeDeployFile(
      dir,
      `schemaVersion = 1
${adminToml}
[[providers]]
key = "LOGTO_M2M_APP_SECRET"
value = { value = "x" }
`,
    );
    expect(() => parseDeployConfigFromPath(f)).toThrow(
      /is a Logto runtime key, not a provider/,
    );
  });

  test("fromEnv missing throws EnvVarMissingError", () => {
    const d = DeployConfigV1.parse({
      schemaVersion: 1,
      admin: {
        handle: "a",
        displayName: "A",
        password: { fromEnv: "MISSING_PW_VAR" },
      },
    });
    expect(() => resolveDeployConfig(d, () => undefined)).toThrow(
      EnvVarMissingError,
    );
    try {
      resolveDeployConfig(d, () => undefined);
    } catch (e) {
      expect(e).toBeInstanceOf(EnvVarMissingError);
      if (e instanceof EnvVarMissingError) {
        expect(e.field).toBe("admin.password");
        expect(e.varName).toBe("MISSING_PW_VAR");
      }
    }
  });

  test("post-resolution PIN: 5 digits throws; 6 passes; 9 throws", () => {
    const base = DeployConfigV1.parse({
      schemaVersion: 1,
      admin: {
        handle: "a",
        displayName: "A",
        password: { value: "12345678" },
        pin: { value: "12345" },
      },
    });
    expect(() => resolveDeployConfig(base, () => undefined)).toThrow(
      "admin.pin must be 6–8 digits after resolution.",
    );

    const ok = DeployConfigV1.parse({
      schemaVersion: 1,
      admin: {
        handle: "a",
        displayName: "A",
        password: { value: "12345678" },
        pin: { value: "123456" },
      },
    });
    expect(resolveDeployConfig(ok, () => undefined).admin.pin?.value).toBe(
      "123456",
    );

    const long = DeployConfigV1.parse({
      schemaVersion: 1,
      admin: {
        handle: "a",
        displayName: "A",
        password: { value: "12345678" },
        pin: { value: "123456789" },
      },
    });
    expect(() => resolveDeployConfig(long, () => undefined)).toThrow(
      "admin.pin must be 6–8 digits after resolution.",
    );
  });
});
