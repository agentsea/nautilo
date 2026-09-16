import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveAuditLogPath,
  resolveConfigAuthorityDir,
  resolveDotenvPath,
  resolveSnapshotDir,
} from "../../src/paths";

const previousDotenv = process.env["NAUTILO_DOTENV_PATH"];
const previousHome = process.env["HOME"];
const previousInstanceId = process.env["NAUTILO_INSTANCE_ID"];

afterEach(() => {
  if (previousDotenv === undefined) {
    delete process.env["NAUTILO_DOTENV_PATH"];
  } else {
    process.env["NAUTILO_DOTENV_PATH"] = previousDotenv;
  }
  if (previousHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = previousHome;
  if (previousInstanceId === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
  else process.env["NAUTILO_INSTANCE_ID"] = previousInstanceId;
});

describe("D445 explicit canonical config authority paths", () => {
  test("snapshot and audit paths share the explicit dotenv parent", () => {
    const configDir = join("/srv", "nautilo", "runtime-config");
    const dotenv = join(configDir, "instance.env");
    process.env["NAUTILO_DOTENV_PATH"] = dotenv;

    expect(resolveDotenvPath()).toBe(dotenv);
    expect(resolveConfigAuthorityDir()).toBe(configDir);
    expect(resolveSnapshotDir()).toBe(join(configDir, "config-snapshots"));
    expect(resolveAuditLogPath()).toBe(join(configDir, "config-audit.jsonl"));
    expect(dirname(resolveSnapshotDir())).toBe(dirname(resolveAuditLogPath()));
  });

  test("whitespace-only override preserves the historical local root", () => {
    process.env["NAUTILO_DOTENV_PATH"] = "   ";

    expect(resolveConfigAuthorityDir()).not.toBe("");
    expect(resolveSnapshotDir()).toBe(
      join(resolveConfigAuthorityDir(), "config-snapshots"),
    );
    expect(resolveAuditLogPath()).toBe(
      join(resolveConfigAuthorityDir(), "config-audit.jsonl"),
    );
  });

  test("local compatibility mode prefers an existing runtime-config authority", async () => {
    const home = await mkdtemp(join(tmpdir(), "d445-paths-"));
    try {
      delete process.env["NAUTILO_DOTENV_PATH"];
      delete process.env["NAUTILO_INSTANCE_ID"];
      process.env["HOME"] = home;
      const configDir = join(home, ".nautilo", "runtime-config");
      const dotenv = join(configDir, "instance.env");
      await mkdir(configDir, { recursive: true });
      await writeFile(dotenv, "TAVILY_API_KEY=tvly-path-test\n");

      expect(resolveDotenvPath()).toBe(dotenv);
      expect(resolveConfigAuthorityDir()).toBe(configDir);
      expect(resolveSnapshotDir()).toBe(join(configDir, "config-snapshots"));
      expect(resolveAuditLogPath()).toBe(join(configDir, "config-audit.jsonl"));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
