import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupManifestSchema,
  BUNDLE_INTEGRITY_FILES,
  ComposeDriver,
  verifyBundle,
  type BackupManifestV2,
  type ComposeDriverDeps,
  type ExecFn,
} from "../../src/index.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

/**
 * Exec that runs the real shell for `gzip -t` integrity scripts (so dump
 * integrity is genuinely exercised) and returns fake success for anything
 * else. `verifyBundle` only invokes exec for the per-dump integrity script.
 */
function realGzipExec(): ExecFn {
  return async (cmd, args) => {
    const text = [cmd, ...args].join(" ");
    if (cmd === "sh" && text.includes("gzip -t")) {
      const proc = Bun.spawn(["sh", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code: code ?? 0, stdout, stderr };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function writeValidGzip(path: string, contents = "SELECT 1;\n"): void {
  const bytes = Bun.gzipSync(new TextEncoder().encode(contents));
  writeFileSync(path, bytes);
}

function writeCorruptGzip(path: string): void {
  const bytes = Bun.gzipSync(new TextEncoder().encode("SELECT 1;\n"));
  writeFileSync(path, bytes.slice(0, Math.max(2, Math.floor(bytes.length / 2))));
}

const baseProfile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

const tmpDirs: string[] = [];
function mktmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function cleanupTmp(): void {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
}

function makeDeps(exec: ExecFn): ComposeDriverDeps {
  const repoRoot = mktmp("verify-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template\n");
  const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    exec,
    localExec: exec,
    fetch: fakeFetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    fs: nodeFs,
    now: () => new Date("2026-07-16T11:40:00.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1000,
    serverHealthTimeoutMs: 1000,
    ensureDbPasswords: async () => ({
      appDbPassword: "fake_app_pw",
      postgresPassword: "fake_pg_pw",
      nautilo: "fake_nautilo_pw",
      logto: "fake_logto_pw",
      nautiloAgent: "fake_agent_pw",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ensureForgotPasswordWebhookSecret: async () => "fake-webhook-secret",
  };
}

interface BuildBundleOpts {
  version?: 1 | 2;
  image?: BackupManifestV2["image"];
  contents?: Partial<BackupManifestV2["contents"]>;
  integrity?: Partial<BackupManifestV2["integrity"]>;
  /** Write real on-disk member files matching the contents flags. */
  writeFiles?: boolean;
  /** Override an integrity entry's sha256 to force a mismatch. */
  corruptIntegrity?: Partial<Record<keyof typeof BUNDLE_INTEGRITY_FILES, { sha256?: string; sizeBytes?: number }>>;
  /** Omit a member file even though its content flag is true. */
  omitFile?: keyof typeof BUNDLE_INTEGRITY_FILES | "composeTemplate";
  /** Permissions to apply after writing files. */
  bundleMode?: number;
  manifestMode?: number;
  envMode?: number;
}

function buildBundle(root: string, opts: BuildBundleOpts = {}): string {
  mkdirSync(root, { recursive: true });
  const contents = {
    nautiloDb: true,
    logtoDb: true,
    artifacts: true,
    media: false,
    apps: false,
    composeTemplate: false,
    instanceEnv: true,
    operatorFiles: false,
    caddyData: false,
    caddyConfig: false,
    localCaCerts: false,
    ...opts.contents,
  };
  if (opts.writeFiles !== false) {
    if (contents.nautiloDb && opts.omitFile !== "nautiloDb") {
      writeValidGzip(join(root, BUNDLE_INTEGRITY_FILES.nautiloDb));
    }
    if (contents.logtoDb && opts.omitFile !== "logtoDb") {
      writeValidGzip(join(root, BUNDLE_INTEGRITY_FILES.logtoDb));
    }
    if (contents.artifacts && opts.omitFile !== "artifacts") {
      writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.artifacts), "artifacts-bytes");
    }
    if (contents.media && opts.omitFile !== "media") {
      writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.media), "media-bytes");
    }
    if (contents.apps && opts.omitFile !== "apps") {
      writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.apps), "apps-bytes");
    }
    if (contents.composeTemplate && opts.omitFile !== "composeTemplate") {
      writeFileSync(join(root, "docker-compose.yml"), "# captured compose template\n");
    }
    if (contents.instanceEnv && opts.omitFile !== "instanceEnv") {
      writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.instanceEnv), "SECRET=1\n");
    }
    if (contents.caddyData && opts.omitFile !== "caddyData") {
      writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.caddyData), "caddy-data");
    }
    if (contents.caddyConfig && opts.omitFile !== "caddyConfig") {
      writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.caddyConfig), "caddy-config");
    }
    if (contents.localCaCerts && opts.omitFile !== "localCaCerts") {
      writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.localCaCerts), "certs");
    }
  }
  const image = opts.image ?? {
    mode: "registry" as const,
    repoDigest: "ghcr.io/agentsea/nautilo-server@sha256:abc",
    tag: "main",
  };
  let integrity: BackupManifestV2["integrity"] | undefined;
  if ((opts.version ?? 2) === 2) {
    integrity = {};
    for (const key of Object.keys(BUNDLE_INTEGRITY_FILES) as (keyof typeof BUNDLE_INTEGRITY_FILES)[]) {
      if (!contents[key]) continue;
      const file = BUNDLE_INTEGRITY_FILES[key];
      const filePath = join(root, file);
      let entry: { sha256: string; sizeBytes: number } | undefined;
      try {
        const data = readFileSync(filePath);
        entry = {
          sha256: createHash("sha256").update(data).digest("hex"),
          sizeBytes: data.length,
        };
      } catch {
        // File omitted; leave entry undefined unless corruptIntegrity supplies one.
      }
      const override = opts.corruptIntegrity?.[key];
      if (override) {
        entry = {
          sha256: override.sha256 ?? entry?.sha256 ?? "0".repeat(64),
          sizeBytes: override.sizeBytes ?? entry?.sizeBytes ?? 0,
        };
      }
      if (entry) integrity[key] = entry;
    }
    if (opts.integrity) integrity = { ...integrity, ...opts.integrity };
  }
  const manifest: Record<string, unknown> = {
    version: opts.version ?? 2,
    createdAt: "2026-07-16T11:00:00.000Z",
    profileName: "local-default",
    instanceId: "",
    transport: "local",
    composeProjectName: "nautilo",
    image,
    contents,
    https: "off",
  };
  if (integrity) manifest["integrity"] = integrity;
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(backupManifestSchema.parse(manifest), null, 2));
  if (opts.bundleMode !== undefined) chmodSync(root, opts.bundleMode);
  if (opts.manifestMode !== undefined) chmodSync(manifestPath, opts.manifestMode);
  if (opts.envMode !== undefined && contents.instanceEnv) {
    chmodSync(join(root, BUNDLE_INTEGRITY_FILES.instanceEnv), opts.envMode);
  }
  return root;
}

describe("nautilo backup verify (D427 Wave 1)", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env["HOME"];
    home = mktmp("verify-home-");
    process.env["HOME"] = home;
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env["HOME"] = savedHome;
    else delete process.env["HOME"];
    cleanupTmp();
  });

  test("v2 happy path: all checks pass, provenance produced, no secrets in output", async () => {
    const bundle = mktmp("v2-ok-");
    buildBundle(bundle, { bundleMode: 0o700, manifestMode: 0o600, envMode: 0o600 });
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);

    expect(report.ok).toBe(true);
    expect(report.manifestVersion).toBe(2);
    expect(report.provenance).toBeDefined();
    expect(report.provenance!.imageMode).toBe("registry");
    expect(report.provenance!.imageReference).toBe(
      "ghcr.io/agentsea/nautilo-server@sha256:abc",
    );
    expect(report.provenance!.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    // No check failed.
    expect(report.checks.every((c) => c.status !== "fail")).toBe(true);
    // Integrity entries exist for every captured member.
    expect(report.checks.some((c) => c.name === "integrity nautilo.sql.gz" && c.status === "pass")).toBe(true);
    expect(report.checks.some((c) => c.name === "integrity logto_nautilo.sql.gz" && c.status === "pass")).toBe(true);
    expect(report.checks.some((c) => c.name === "integrity instance.env" && c.status === "pass")).toBe(true);
  });

  test("v1 bundle is readable but not verifiable (no provenance, ok=false)", async () => {
    const bundle = mktmp("v1-");
    buildBundle(bundle, {
      version: 1,
      bundleMode: 0o700,
      manifestMode: 0o600,
      envMode: 0o600,
    });
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);

    expect(report.manifestVersion).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.provenance).toBeUndefined();
    expect(
      report.checks.some(
        (c) => c.name === "integrity inventory" && c.status === "skip",
      ),
    ).toBe(true);
  });

  test("captured compose template is covered by v2 integrity verification", async () => {
    const bundle = mktmp("compose-template-");
    buildBundle(bundle, {
      contents: { composeTemplate: true },
      bundleMode: 0o700,
      manifestMode: 0o600,
      envMode: 0o600,
    });

    const report = await new ComposeDriver(makeDeps(realGzipExec())).verifyBundle(
      baseProfile,
      bundle,
    );

    expect(report.ok).toBe(true);
    expect(
      report.checks.some(
        (c) => c.name === "integrity docker-compose.yml" && c.status === "pass",
      ),
    ).toBe(true);
  });

  test("missing mandatory dump member fails before adoption", async () => {
    const bundle = mktmp("missing-dump-");
    buildBundle(bundle, {
      omitFile: "nautiloDb",
      bundleMode: 0o700,
      manifestMode: 0o600,
      envMode: 0o600,
    });
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);

    expect(report.ok).toBe(false);
    expect(report.provenance).toBeUndefined();
    expect(
      report.checks.some(
        (c) => c.name === "mandatory member nautilo.sql.gz" && c.status === "fail",
      ),
    ).toBe(true);
  });

  test("checksum mismatch fails verification", async () => {
    const bundle = mktmp("checksum-mismatch-");
    buildBundle(bundle, {
      corruptIntegrity: { nautiloDb: { sha256: "f".repeat(64) } },
      bundleMode: 0o700,
      manifestMode: 0o600,
      envMode: 0o600,
    });
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);

    expect(report.ok).toBe(false);
    expect(report.provenance).toBeUndefined();
    expect(
      report.checks.some(
        (c) => c.name === "integrity nautilo.sql.gz" && c.status === "fail" && /mismatch/.test(c.detail ?? ""),
      ),
    ).toBe(true);
  });

  test("truncated dump fails gzip -t integrity", async () => {
    const bundle = mktmp("corrupt-dump-");
    buildBundle(bundle, {
      bundleMode: 0o700,
      manifestMode: 0o600,
      envMode: 0o600,
    });
    // Overwrite the nautilo dump with a corrupt gzip AFTER integrity was
    // computed from the valid one — simulates a member that changed on disk
    // but whose stored checksum no longer matches AND is not decompressible.
    writeCorruptGzip(join(bundle, BUNDLE_INTEGRITY_FILES.nautiloDb));
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);

    expect(report.ok).toBe(false);
    expect(
      report.checks.some(
        (c) => c.name === "dump integrity nautilo.sql.gz" && c.status === "fail",
      ),
    ).toBe(true);
    expect(
      report.checks.some(
        (c) => c.name === "integrity nautilo.sql.gz" && c.status === "fail",
      ),
    ).toBe(true);
  });

  test("permissive bundle permissions fail closed", async () => {
    const bundle = mktmp("perms-");
    buildBundle(bundle, { bundleMode: 0o755, manifestMode: 0o600, envMode: 0o600 });
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);

    expect(report.ok).toBe(false);
    expect(
      report.checks.some(
        (c) => c.name === "bundle permissions" && c.status === "fail",
      ),
    ).toBe(true);
  });

  test("permissive instance.env permissions fail closed", async () => {
    const bundle = mktmp("env-perms-");
    buildBundle(bundle, { bundleMode: 0o700, manifestMode: 0o600, envMode: 0o644 });
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);

    expect(report.ok).toBe(false);
    expect(
      report.checks.some(
        (c) => c.name === "instance.env permissions" && c.status === "fail",
      ),
    ).toBe(true);
  });

  test("missing manifest fails clearly", async () => {
    const bundle = mktmp("no-manifest-");
    mkdirSync(bundle, { recursive: true });
    chmodSync(bundle, 0o700);
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);

    expect(report.ok).toBe(false);
    expect(
      report.checks.some((c) => c.name === "manifest" && c.status === "fail"),
    ).toBe(true);
  });

  test("verify never reads secret contents to stdout (report is structural)", async () => {
    const bundle = mktmp("secrets-");
    buildBundle(bundle, { bundleMode: 0o700, manifestMode: 0o600, envMode: 0o600 });
    const exec = realGzipExec();
    const driver = new ComposeDriver(makeDeps(exec));

    const report = await driver.verifyBundle(baseProfile, bundle);
    const serialized = JSON.stringify(report);
    // The instance.env plaintext secret must never appear in the report.
    expect(serialized.includes("SECRET=1")).toBe(false);
    // Only structural fields are present.
    expect(report.ok).toBe(true);
  });

  test("standalone verifyBundle works without a driver", async () => {
    const bundle = mktmp("standalone-");
    buildBundle(bundle, { bundleMode: 0o700, manifestMode: 0o600, envMode: 0o600 });
    const exec = realGzipExec();

    const report = await verifyBundle(bundle, {
      fs: nodeFs,
      statSync,
      exec,
      now: () => new Date("2026-07-16T11:40:00.000Z"),
    });

    expect(report.ok).toBe(true);
    expect(report.provenance).toBeDefined();
  });
});
