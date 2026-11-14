import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAgentRuntimePoolProbe,
  buildRestrictedRuntimePoolsProbe,
} from "../../src/runtime-pool-probe.ts";

describe("runtime pool probe", () => {
  test("builds a postgres.js probe via nautilo-server exec", () => {
    const probe = buildAgentRuntimePoolProbe({
      composeBin: "docker",
      projectName: "nautilo-beta",
    });
    expect(probe.label).toContain("postgres.js");
    expect(probe.cmd).toContain("nautilo-beta-nautilo-server");
    expect(probe.cmd).toContain("DB_AGENT_CONNECTION_STRING");
    expect(probe.cmd).toContain('import postgres from "postgres"');
    expect(probe.cmd).not.toContain("db.localtest.me");
    expect(probe.cmd).not.toContain("/sql");
    expect(probe.cmd).not.toContain("Neon-Connection-String");
  });

  test("probes both restricted runtime pools and exact role identities", () => {
    const probe = buildRestrictedRuntimePoolsProbe({
      composeBin: "docker",
      projectName: "nautilo-beta",
    });
    expect(probe.label).toContain("nautilo_crypto");
    expect(probe.cmd).toContain("DB_AGENT_CONNECTION_STRING");
    expect(probe.cmd).toContain("DB_CRYPTO_CONNECTION_STRING");
    expect(probe.cmd).toContain("current_user");
    expect(probe.cmd).not.toContain("crypto-secret");
  });

  test.each([buildAgentRuntimePoolProbe, buildRestrictedRuntimePoolsProbe])(
    "resolves packaged and retained workspaces without automatic installation (%#)",
    (build) => {
      const root = mkdtempSync(join(tmpdir(), "nautilo-runtime-probe-"));
      try {
        const modern = join(root, "modern"), legacy = join(root, "legacy");
        const bin = join(root, "bin"); mkdirSync(bin);
        const docker = join(bin, "fixture-docker");
        writeFileSync(docker, '#!/bin/sh\nset -eu\ncase "$1" in\nps) printf "fixture-container\\n";;\nexec) shift; test "$1" = -i; shift; shift; exec "$@";;\n*) exit 1;;\nesac\n', { mode: 0o755 });
        writeFileSync(join(bin, "bun"), '#!/bin/sh\nset -eu\ntest "$1" = --no-install\ntest "$2" = -e\nprintf "%s\\n" "$PWD"\n', { mode: 0o755 });
        const probe = build({ composeBin: docker, projectName: "nautilo-fixture" });
        // Relocate only the two fixed image roots into disposable fixtures;
        // execute the generated shell, including its nested Docker exec route.
        const command = probe.cmd.replaceAll("/srv/repo", modern).replaceAll("/srv", legacy);
        const run = () => Bun.spawnSync(["sh", "-c", command], {
          env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
          stdout: "pipe", stderr: "pipe",
        });
        const absent = run();
        expect(absent.exitCode).not.toBe(0);
        expect(absent.stderr.toString()).toContain("Runtime workspace is unavailable");
        mkdirSync(legacy); writeFileSync(join(legacy, "package.json"), "{}");
        expect(run().stdout.toString().trim()).toBe(legacy);
        mkdirSync(modern); writeFileSync(join(modern, "package.json"), "{}");
        const current = run();
        expect(current.exitCode).toBe(0);
        expect(current.stdout.toString().trim()).toBe(modern);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
