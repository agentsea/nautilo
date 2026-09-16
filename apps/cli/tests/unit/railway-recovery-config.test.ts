import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveRailwayRecoveryConfig } from "../../src/lib/railway-recovery-config.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nautilo-recovery-config-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const encryptionKey = Buffer.alloc(32, 7).toString("base64url");
const accessKeyId = "recovery-access-key";
const secretAccessKey = "recovery-secret-key";
const sessionToken = "recovery-session-token";

function body(overrides: readonly string[] = []): string {
  return [
    "schemaVersion = 1",
    "[storage]",
    'endpoint = "https://objects.example.test"',
    'region = "eu-west-1"',
    'bucket = "nautilo-recovery"',
    'objectPrefix = "customers/alex/"',
    `accessKeyId = { value = "${accessKeyId}" }`,
    `secretAccessKey = { fromEnv = "RECOVERY_SECRET_ACCESS_KEY" }`,
    `sessionToken = { fromEnv = "RECOVERY_SESSION_TOKEN" }`,
    `encryptionKey = { value = "${encryptionKey}" }`,
    ...overrides,
    "",
  ].join("\n");
}

async function writeRecoveryConfig(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

function input(path: string, environment: NodeJS.ProcessEnv = {}): {
  readonly recoveryConfigPath: string;
  readonly environment: NodeJS.ProcessEnv;
} {
  return {
    recoveryConfigPath: path,
    environment: {
      RECOVERY_SECRET_ACCESS_KEY: secretAccessKey,
      RECOVERY_SESSION_TOKEN: sessionToken,
      ...environment,
    },
  };
}

describe("protected Railway recovery config", () => {
  test("resolves the strict request-only S3-compatible authority from one explicit 0600 TOML", async () => {
    const configPath = join(root, "recovery.toml");
    await writeRecoveryConfig(configPath, body());

    const result = await resolveRailwayRecoveryConfig(input(configPath));

    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") return;
    expect(result.config).toEqual({
      endpoint: "https://objects.example.test",
      region: "eu-west-1",
      bucket: "nautilo-recovery",
      objectPrefix: "customers/alex",
      accessKeyId,
      secretAccessKey,
      sessionToken,
      encryptionKey: new Uint8Array(Buffer.alloc(32, 7)),
    });
    expect(result.authorityGenerationId).toMatch(/^recovery-v1-[0-9a-f]{64}$/);
  });

  test("derives a stable, domain-separated generation and changes it for every authority field or key rotation", async () => {
    const baselinePath = join(root, "baseline.toml");
    await writeRecoveryConfig(baselinePath, body());
    const baseline = await resolveRailwayRecoveryConfig(input(baselinePath));
    expect(baseline.outcome).toBe("resolved");
    if (baseline.outcome !== "resolved") return;

    const repeated = await resolveRailwayRecoveryConfig(input(baselinePath));
    expect(repeated).toMatchObject({
      outcome: "resolved",
      authorityGenerationId: baseline.authorityGenerationId,
    });

    const variants: ReadonlyArray<readonly [string, string, NodeJS.ProcessEnv?]> = [
      ["endpoint", body().replace("https://objects.example.test", "https://other.example.test")],
      ["region", body().replace("eu-west-1", "us-east-1")],
      ["bucket", body().replace("nautilo-recovery", "nautilo-recovery-rotated")],
      ["prefix", body().replace("customers/alex/", "customers/other")],
      ["access-key", body().replace(accessKeyId, "rotated-access-key")],
      ["secret-key", body(), { RECOVERY_SECRET_ACCESS_KEY: "rotated-secret-key" }],
      ["session-token", body(), { RECOVERY_SESSION_TOKEN: "rotated-session-token" }],
      ["encryption-key", body().replace(encryptionKey, Buffer.alloc(32, 8).toString("base64url"))],
    ];
    for (const [name, contents, environment] of variants) {
      const path = join(root, `${name}.toml`);
      await writeRecoveryConfig(path, contents);
      const result = await resolveRailwayRecoveryConfig(input(path, environment));
      expect(result.outcome).toBe("resolved");
      if (result.outcome === "resolved") {
        expect(result.authorityGenerationId).toMatch(/^recovery-v1-[0-9a-f]{64}$/);
        expect(result.authorityGenerationId).not.toBe(baseline.authorityGenerationId);
      }
    }
  });

  test("length-prefixes authority fields so ambiguous concatenations produce different generations", async () => {
    const firstPath = join(root, "first.toml");
    const secondPath = join(root, "second.toml");
    await writeRecoveryConfig(firstPath, body()
      .replace(`accessKeyId = { value = "${accessKeyId}" }`, 'accessKeyId = { value = "ab" }')
      .replace('secretAccessKey = { fromEnv = "RECOVERY_SECRET_ACCESS_KEY" }', 'secretAccessKey = { value = "c" }'));
    await writeRecoveryConfig(secondPath, body()
      .replace(`accessKeyId = { value = "${accessKeyId}" }`, 'accessKeyId = { value = "a" }')
      .replace('secretAccessKey = { fromEnv = "RECOVERY_SECRET_ACCESS_KEY" }', 'secretAccessKey = { value = "bc" }'));

    const first = await resolveRailwayRecoveryConfig(input(firstPath));
    const second = await resolveRailwayRecoveryConfig(input(secondPath));
    expect(first.outcome).toBe("resolved");
    expect(second.outcome).toBe("resolved");
    if (first.outcome === "resolved" && second.outcome === "resolved") {
      expect(first.authorityGenerationId).not.toBe(second.authorityGenerationId);
    }
  });

  test("supports inline or fromEnv forms for every credential and resolves no ambient path", async () => {
    const configPath = join(root, "credentials.toml");
    await writeRecoveryConfig(configPath, [
      "schemaVersion = 1",
      "[storage]",
      'endpoint = "https://objects.example.test"',
      'region = "eu-west-1"',
      'bucket = "nautilo-recovery"',
      'accessKeyId = { fromEnv = "RECOVERY_ACCESS_KEY" }',
      `secretAccessKey = { value = "${secretAccessKey}" }`,
      `encryptionKey = { fromEnv = "RECOVERY_ENCRYPTION_KEY" }`,
      "",
    ].join("\n"));

    const result = await resolveRailwayRecoveryConfig(input(configPath, {
      RECOVERY_ACCESS_KEY: accessKeyId,
      RECOVERY_ENCRYPTION_KEY: encryptionKey,
    }));
    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") {
      expect(result.config).toMatchObject({ accessKeyId, secretAccessKey });
      expect(result.config.sessionToken).toBeUndefined();
    }

    const unrelated = join(root, "unrelated.toml");
    await writeRecoveryConfig(unrelated, body());
    const noInput = await resolveRailwayRecoveryConfig({ environment: {} });
    expect(noInput).toEqual({
      outcome: "failure",
      code: "railway.maintenance.recovery-config-invalid",
    });
    expect(JSON.stringify(noInput)).not.toContain(unrelated);
  });

  test("accepts canonical byte boundaries and rejects one-byte and multibyte overflow", async () => {
    const region64 = `a${"b".repeat(63)}`;
    const prefix256 = `${"a".repeat(128)}/${"b".repeat(127)}`;
    const access2048 = "a".repeat(2 * 1024);
    const exactPath = join(root, "exact-boundaries.toml");
    await writeRecoveryConfig(exactPath, body()
      .replace("eu-west-1", region64)
      .replace("customers/alex/", prefix256)
      .replace(accessKeyId, access2048));
    const exact = await resolveRailwayRecoveryConfig(input(exactPath, {
      RECOVERY_SECRET_ACCESS_KEY: "s".repeat(8 * 1024),
      RECOVERY_SESSION_TOKEN: "t".repeat(16 * 1024),
    }));
    expect(exact.outcome).toBe("resolved");
    if (exact.outcome === "resolved") {
      expect(Buffer.byteLength(exact.config.region)).toBe(64);
      expect(Buffer.byteLength(exact.config.objectPrefix!)).toBe(256);
      expect(Buffer.byteLength(exact.config.accessKeyId)).toBe(2 * 1024);
      expect(Buffer.byteLength(exact.config.secretAccessKey)).toBe(8 * 1024);
      expect(Buffer.byteLength(exact.config.sessionToken!)).toBe(16 * 1024);
    }

    const variants: ReadonlyArray<readonly [string, string, NodeJS.ProcessEnv?]> = [
      ["region-overflow", body().replace("eu-west-1", `a${"b".repeat(64)}`)],
      ["prefix-overflow", body().replace("customers/alex/", `${"a".repeat(128)}/${"b".repeat(128)}`)],
      ["region-multibyte", body().replace("eu-west-1", `a${"b".repeat(62)}é`)],
      ["prefix-multibyte", body().replace("customers/alex/", `${"a".repeat(128)}/${"b".repeat(125)}é`)],
      ["access-multibyte", body().replace(accessKeyId, "é".repeat(1025))],
      ["secret-multibyte", body(), { RECOVERY_SECRET_ACCESS_KEY: "é".repeat(4097) }],
      ["session-multibyte", body(), { RECOVERY_SESSION_TOKEN: "é".repeat(8193) }],
    ];
    for (const [name, contents, environment] of variants) {
      const path = join(root, `${name}.toml`);
      await writeRecoveryConfig(path, contents);
      expect(await resolveRailwayRecoveryConfig(input(path, environment))).toEqual({
        outcome: "failure", code: "railway.maintenance.recovery-config-invalid",
      });
    }
  });

  test("fails closed and redacted for malformed schemas, bad keys, and missing environment authority", async () => {
    const invalid = [
      "schemaVersion = 2\n[storage]\n",
      body(['unexpected = "field"']),
      body(['endpoint = "http://objects.example.test"']),
      body(['bucket = "Bad_Bucket"']),
      body(['objectPrefix = "../outside"']),
      body([`encryptionKey = { value = "${Buffer.alloc(31, 7).toString("base64url")}" }`]),
      body(['accessKeyId = { value = "x", fromEnv = "X" }']),
    ];
    for (const [index, contents] of invalid.entries()) {
      const configPath = join(root, `invalid-${index}.toml`);
      await writeRecoveryConfig(configPath, contents);
      const result = await resolveRailwayRecoveryConfig(input(configPath));
      expect(result).toEqual({
        outcome: "failure",
        code: "railway.maintenance.recovery-config-invalid",
      });
      expect(JSON.stringify(result)).not.toContain(configPath);
      expect(JSON.stringify(result)).not.toContain(secretAccessKey);
    }

    const envConfig = join(root, "env.toml");
    await writeRecoveryConfig(envConfig, body());
    const missing = await resolveRailwayRecoveryConfig(input(envConfig, {
      RECOVERY_SECRET_ACCESS_KEY: undefined,
    }));
    expect(missing).toEqual({
      outcome: "failure",
      code: "railway.maintenance.recovery-config-environment-missing",
    });
    expect(JSON.stringify(missing)).not.toContain(envConfig);
  });

  test("requires a normalized absolute, exact-current-user 0600 regular file and never exposes its path", async () => {
    const configPath = join(root, "recovery.toml");
    await writeRecoveryConfig(configPath, body());
    const relative = await resolveRailwayRecoveryConfig(input("recovery.toml"));
    expect(relative).toEqual({ outcome: "failure", code: "railway.maintenance.recovery-config-invalid" });
    const dotSegment = await resolveRailwayRecoveryConfig(input(`${root}/folder/../recovery.toml`));
    expect(dotSegment).toEqual({ outcome: "failure", code: "railway.maintenance.recovery-config-invalid" });

    const linked = join(root, "linked.toml");
    await symlink(configPath, linked);
    expect(await resolveRailwayRecoveryConfig(input(linked))).toEqual({
      outcome: "failure",
      code: "railway.maintenance.recovery-config-unsafe",
    });

    await chmod(configPath, 0o640);
    const wrongMode = await resolveRailwayRecoveryConfig(input(configPath));
    expect(wrongMode).toEqual({ outcome: "failure", code: "railway.maintenance.recovery-config-unsafe" });
    expect(JSON.stringify(wrongMode)).not.toContain(configPath);

    const missing = resolve(root, "missing.toml");
    expect(await resolveRailwayRecoveryConfig(input(missing))).toEqual({
      outcome: "failure",
      code: "railway.maintenance.recovery-config-unreadable",
    });
  });

  test("rejects oversized input before parsing and never returns source metadata", async () => {
    const configPath = join(root, "oversized.toml");
    await writeRecoveryConfig(configPath, "#".repeat(64 * 1024 + 1));
    const result = await resolveRailwayRecoveryConfig(input(configPath));
    expect(result).toEqual({
      outcome: "failure",
      code: "railway.maintenance.recovery-config-too-large",
    });
    expect(JSON.stringify(result)).not.toContain(configPath);
  });
});
