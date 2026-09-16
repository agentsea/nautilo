import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  writeFileAtomic,
  reloadEnvAndStripRemovedRegistryKeys,
  reloadEnvOverlay,
  subscribeEnvReload,
} from "../../src/env-writer";

describe("env-writer", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("writeFileAtomic creates file with content", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-ew-"));
    const path = join(dir, "out.txt");
    await writeFileAtomic(path, "hello\n");
    const content = await readFile(path, "utf-8");
    expect(content).toBe("hello\n");
  });

  test("writeFileAtomic creates secret files with mode 0600", async () => {
    if (process.platform === "win32") return;
    dir = await mkdtemp(join(tmpdir(), "cg-ew-"));
    const envPath = join(dir, "config.env");

    await writeFileAtomic(envPath, 'OPENAI_API_KEY="sk-123456789012345678901234"\n');

    const mode = (await stat(envPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("reloadEnvAndStripRemovedRegistryKeys loads pairs and strips missing registry keys", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-ew-"));
    const envPath = join(dir, ".env");
    await writeFileAtomic(envPath, 'FOO=bar\nOPENAI_API_KEY="sk-123456789012345678901234"\n');
    const prevOpenai = process.env["OPENAI_API_KEY"];
    const prevFoo = process.env["FOO"];
    try {
      await reloadEnvAndStripRemovedRegistryKeys(envPath);
      expect(process.env["FOO"]).toBe("bar");
      expect(process.env["OPENAI_API_KEY"]).toContain("sk-");
      await writeFileAtomic(envPath, "FOO=bar\n");
      await reloadEnvAndStripRemovedRegistryKeys(envPath);
      expect(process.env["FOO"]).toBe("bar");
      expect(process.env["OPENAI_API_KEY"]).toBeUndefined();
    } finally {
      if (prevOpenai !== undefined) process.env["OPENAI_API_KEY"] = prevOpenai;
      else delete process.env["OPENAI_API_KEY"];
      if (prevFoo !== undefined) process.env["FOO"] = prevFoo;
      else delete process.env["FOO"];
    }
  });

  test("env reload listeners observe the replaced environment and can unsubscribe", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-ew-"));
    const envPath = join(dir, ".env");
    const previous = process.env["VENICE_API_KEY"];
    const observed: Array<string | undefined> = [];
    const unsubscribe = subscribeEnvReload(() => {
      observed.push(process.env["VENICE_API_KEY"]);
    });

    try {
      await writeFileAtomic(envPath, "VENICE_API_KEY=first-key\n");
      reloadEnvOverlay(envPath);
      expect(observed).toEqual(["first-key"]);

      unsubscribe();
      unsubscribe();
      await writeFileAtomic(envPath, "VENICE_API_KEY=second-key\n");
      reloadEnvOverlay(envPath);
      expect(observed).toEqual(["first-key"]);
    } finally {
      unsubscribe();
      if (previous !== undefined) process.env["VENICE_API_KEY"] = previous;
      else delete process.env["VENICE_API_KEY"];
    }
  });

  test("a failing listener cannot fail the reload or prevent later listeners", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-ew-"));
    const envPath = join(dir, ".env");
    const previous = process.env["VENICE_API_KEY"];
    const calls: string[] = [];
    const unsubscribeFailing = subscribeEnvReload(() => {
      calls.push("failing");
      throw new Error("listener failure");
    });
    const unsubscribeLater = subscribeEnvReload(() => {
      calls.push("later");
    });

    try {
      await writeFileAtomic(envPath, "VENICE_API_KEY=reloaded-key\n");
      expect(() => reloadEnvOverlay(envPath)).not.toThrow();
      expect(process.env["VENICE_API_KEY"]).toBe("reloaded-key");
      expect(calls).toEqual(["failing", "later"]);
    } finally {
      unsubscribeFailing();
      unsubscribeLater();
      if (previous !== undefined) process.env["VENICE_API_KEY"] = previous;
      else delete process.env["VENICE_API_KEY"];
    }
  });
});
