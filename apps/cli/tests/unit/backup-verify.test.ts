import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BundleVerificationReport, ComposeDriver } from "@nautilo/compose-driver";

import { backupModule, backupVerifyModule } from "../../src/commands/backup.ts";
import {
  setComposeDriverFactoryForTests,
} from "../../src/lib/compose-driver-factory.ts";
import { setCliProfileFlagOverride } from "../../src/lib/profile-aware-server.ts";

describe("backup verify CLI command", () => {
  let home: string;
  let previousHome: string | undefined;
  let verifyCalls: { profile: string; path: string }[];
  let stdout = "";
  let origWrite: typeof process.stdout.write;

  beforeEach(() => {
    previousHome = process.env["HOME"];
    home = mkdtempSync(join(tmpdir(), "nautilo-backup-verify-cli-"));
    process.env["HOME"] = home;
    process.exitCode = 0;
    setCliProfileFlagOverride(undefined);
    verifyCalls = [];
    stdout = "";
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    const profiles = join(home, ".nautilo", "profiles");
    mkdirSync(profiles, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(profiles, "local.toml"),
      `name = "local"
transport = "local"
lifecycle = "compose"
from_source = true
`,
      { mode: 0o600 },
    );
    setComposeDriverFactoryForTests(
      () =>
        ({
          verifyBundle: async (
            profile: { name: string },
            path: string,
          ): Promise<BundleVerificationReport> => {
            verifyCalls.push({ profile: profile.name, path });
            return {
              ok: true,
              manifestVersion: 2,
              bundlePath: path,
              createdAt: "2026-07-16T11:00:00.000Z",
              profileName: "local",
              instanceId: "",
              composeProjectName: "nautilo",
              transport: "local",
              image: {
                mode: "registry",
                repoDigest: "ghcr.io/agentsea/nautilo-server@sha256:abc",
                tag: "main",
              },
              checks: [
                { name: "manifest", status: "pass", detail: "v2" },
                { name: "integrity nautilo.sql.gz", status: "pass", detail: "12 bytes" },
              ],
              provenance: {
                manifestSha256: "a".repeat(64),
                createdAt: "2026-07-16T11:00:00.000Z",
                verifiedAt: "2026-07-16T11:40:00.000Z",
                imageMode: "registry",
                imageReference: "ghcr.io/agentsea/nautilo-server@sha256:abc",
              },
            };
          },
        }) as unknown as ComposeDriver,
    );
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    setComposeDriverFactoryForTests(undefined);
    setCliProfileFlagOverride(undefined);
    if (previousHome !== undefined) process.env["HOME"] = previousHome;
    else delete process.env["HOME"];
    rmSync(home, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  test("prints a redacted structural report and exits 0 on success", async () => {
    await (backupVerifyModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: ["verify", "/bundle"],
      $0: "nautilo",
      profile: "local",
      path: "/bundle",
    });

    expect(verifyCalls).toEqual([{ profile: "local", path: "/bundle" }]);
    expect(process.exitCode).toBe(0);
    // Structural report fields are present.
    expect(stdout).toContain("bundle: /bundle");
    expect(stdout).toContain("manifest: v2");
    expect(stdout).toContain("result: OK");
    expect(stdout).toContain("manifestSha256: " + "a".repeat(64));
    // No secret material is printed by the formatter.
    expect(stdout).not.toMatch(/SECRET/);
  });

  test("the primary backup command routes `backup verify <path>` to verification", async () => {
    await (backupModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: ["backup", "verify", "/bundle"],
      $0: "nautilo",
      profile: "local",
      path: "verify",
      verifyPath: "/bundle",
    });

    expect(verifyCalls).toEqual([{ profile: "local", path: "/bundle" }]);
    expect(process.exitCode).toBe(0);
    expect(stdout).toContain("result: OK");
  });

  test("exits 2 when verification fails", async () => {
    setComposeDriverFactoryForTests(
      () =>
        ({
          verifyBundle: async (): Promise<BundleVerificationReport> => ({
            ok: false,
            manifestVersion: 1,
            bundlePath: "/bundle",
            createdAt: "",
            profileName: "",
            instanceId: "",
            composeProjectName: "",
            transport: "local",
            image: { mode: "registry" },
            checks: [{ name: "integrity inventory", status: "skip", detail: "v1" }],
            provenance: undefined,
          }),
        }) as unknown as ComposeDriver,
    );

    await (backupVerifyModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: ["verify", "/bundle"],
      $0: "nautilo",
      profile: "local",
      path: "/bundle",
    });

    expect(process.exitCode).toBe(2);
    expect(stdout).toContain("result: FAIL");
  });

  test("requires a <path>", async () => {
    await (backupVerifyModule.handler as (argv: Record<string, unknown>) => Promise<void>)({
      _: ["verify"],
      $0: "nautilo",
      profile: "local",
      path: "",
    });

    expect(process.exitCode).toBe(2);
    expect(verifyCalls).toEqual([]);
  });
});
