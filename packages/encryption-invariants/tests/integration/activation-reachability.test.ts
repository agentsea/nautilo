import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTIVATION_LIFECYCLE_DECLARATIONS,
  ACTIVATION_REFERENCE_EXCLUSIONS,
  type ActivationReferenceExclusion,
  findEncryptionActivationReferences,
  inspectActivationLifecycleDeclarations,
  inspectActivationReferenceExclusions,
} from "../../src/node/activation-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("Wave 0 activation reachability", () => {
  test("actual runtime, deploy, and lifecycle source has no activation consumer", async () => {
    const lifecycle = await inspectActivationLifecycleDeclarations(repositoryRoot);
    expect(lifecycle.errors).toEqual([]);
    expect(lifecycle.observations).toHaveLength(
      ACTIVATION_LIFECYCLE_DECLARATIONS.length,
    );
    expect(new Set(lifecycle.observations.map((item) => item.role))).toEqual(
      new Set(["config", "deploy", "start", "restart", "upgrade"]),
    );
    expect(await inspectActivationReferenceExclusions(repositoryRoot)).toEqual({
      count: ACTIVATION_REFERENCE_EXCLUSIONS.length,
      errors: [],
    });
    const references = await findEncryptionActivationReferences(repositoryRoot);
    expect(references).toEqual([]);
  });

  test("lifecycle declarations fail on missing paths and symbols", async () => {
    const root = await mkdtemp(join(tmpdir(), "m220 lifecycle fixture "));
    temporaryRoots.push(root);
    await mkdir(join(root, "packages", "config"), { recursive: true });
    await writeFile(
      join(root, "packages", "config", "live.ts"),
      "export const currentConfig = {};\n",
    );

    const result = await inspectActivationLifecycleDeclarations(root, [
      {
        path: "packages/config/live.ts",
        role: "config",
        symbols: ["missingConfigSymbol"],
      },
      {
        path: "packages/config/missing.ts",
        role: "deploy",
        symbols: ["missingFile"],
      },
    ]);
    expect(result.errors).toEqual([
      "activation lifecycle packages/config/live.ts is missing symbol missingConfigSymbol",
      "missing activation lifecycle path packages/config/missing.ts",
    ]);
    expect(result.errors.join("\n")).not.toContain(root);
  });

  test("activation exclusions suppress one exact signature occurrence only", async () => {
    const root = await mkdtemp(join(tmpdir(), "m220 exact activation exclusion "));
    temporaryRoots.push(root);
    const signature = "const mode = settings.encryption_mode;";
    await writeFile(join(root, "config.ts"), `${signature}\n${signature}\n`);
    const exclusions: readonly ActivationReferenceExclusion[] = [{
      path: "config.ts",
      token: "encryption_mode",
      signature,
      occurrence: 1,
      reason: "Fixture-local vault metadata is not product E2EE activation.",
    }];

    expect(await inspectActivationReferenceExclusions(root, exclusions)).toEqual({
      count: 1,
      errors: [],
    });
    expect(await findEncryptionActivationReferences(root, exclusions)).toEqual([{
      line: 2,
      path: "config.ts",
      token: "encryption_mode",
    }]);
  });

  test("activation exclusions reject stale signatures and occurrences", async () => {
    const root = await mkdtemp(join(tmpdir(), "m220 stale activation exclusion "));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "config.ts"),
      "const mode = settings.encryption_mode;\n",
    );
    const exclusions: readonly ActivationReferenceExclusion[] = [
      {
        path: "config.ts",
        token: "encryption_mode",
        signature: "const oldMode = settings.encryption_mode;",
        occurrence: 1,
        reason: "Fixture-local vault metadata is not product E2EE activation.",
      },
      {
        path: "config.ts",
        token: "encryption_mode",
        signature: "const mode = settings.encryption_mode;",
        occurrence: 2,
        reason: "Fixture-local vault metadata is not product E2EE activation.",
      },
    ];

    expect(await inspectActivationReferenceExclusions(root, exclusions)).toEqual({
      count: 2,
      errors: [
        "stale activation exclusion config.ts#encryption_mode#const mode = settings.encryption_mode;#2",
        "stale activation exclusion config.ts#encryption_mode#const oldMode = settings.encryption_mode;#1",
      ],
    });
  });

  test("detects env, persisted, and API activation fixtures in paths containing spaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "m220 activation fixture "));
    temporaryRoots.push(root);
    await writeFile(join(root, "config.ts"), [
      'import { parseEncryptionActivation } from "@nautilo/encryption-invariants";',
      'const envStage = process.env["NAUTILO_ENCRYPTION_STAGE"];',
      'const persisted = settings.encryptionActivation;',
      'app.post("/admin/encryption/activate", handler);',
      'if (stage === "shadow_writing") startMigration();',
    ].join("\n"));

    expect(await findEncryptionActivationReferences(root)).toEqual([
      {
        line: 1,
        path: "config.ts",
        token: "@nautilo/encryption-invariants",
      },
      {
        line: 2,
        path: "config.ts",
        token: "NAUTILO_ENCRYPTION_STAGE",
      },
      {
        line: 3,
        path: "config.ts",
        token: "encryptionActivation",
      },
      {
        line: 4,
        path: "config.ts",
        token: "/admin/encryption/activate",
      },
      {
        line: 5,
        path: "config.ts",
        token: "shadow_writing",
      },
    ]);
  });

  test("detects plausible activation aliases and indirection", async () => {
    const root = await mkdtemp(join(tmpdir(), "m220 activation aliases "));
    temporaryRoots.push(root);
    await writeFile(join(root, "aliases.ts"), [
      'const enabled = process.env["NAUTILO_ENCRYPTION"];',
      "const snake = settings.encryption_stage;",
      "const camel = settings.cryptoMode;",
      "const nested = config.encryption.stage;",
      'app.put("/admin/security/crypto-rollout", handler);',
    ].join("\n"));

    expect(await findEncryptionActivationReferences(root)).toEqual([
      { line: 1, path: "aliases.ts", token: "NAUTILO_ENCRYPTION" },
      { line: 2, path: "aliases.ts", token: "encryption_stage" },
      { line: 3, path: "aliases.ts", token: "cryptoMode" },
      { line: 4, path: "aliases.ts", token: "config.encryption.stage" },
      { line: 5, path: "aliases.ts", token: "/admin/security/crypto-rollout" },
    ]);
  });

  test("scans extensionless deployment, environment, and Python sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "m220 deployment sources "));
    temporaryRoots.push(root);
    await Promise.all([
      writeFile(join(root, "Dockerfile"), "ENV NAUTILO_ENCRYPTION_STAGE=disabled\n"),
      writeFile(join(root, "Containerfile"), "ENV NAUTILO_CRYPTO_MODE=disabled\n"),
      writeFile(join(root, "Caddyfile"), "# NAUTILO_E2EE_ENABLED\n"),
      writeFile(join(root, ".env"), "NAUTILO_ENCRYPTION_STAGE=disabled\n"),
      writeFile(join(root, "bootstrap.py"), "stage = 'shadow_writing'\n"),
    ]);

    expect(await findEncryptionActivationReferences(root)).toEqual([
      { line: 1, path: ".env", token: "NAUTILO_ENCRYPTION_STAGE" },
      { line: 1, path: "Caddyfile", token: "NAUTILO_E2EE_ENABLED" },
      { line: 1, path: "Containerfile", token: "NAUTILO_CRYPTO_MODE" },
      { line: 1, path: "Dockerfile", token: "NAUTILO_ENCRYPTION_STAGE" },
      { line: 1, path: "bootstrap.py", token: "shadow_writing" },
    ]);
  });
});
