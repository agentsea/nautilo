import { describe, expect, test } from "bun:test";
import { join, normalize } from "node:path";
import { fromRuntimeConfig } from "../../src/config";
import {
  parseNautiloInstanceId,
  resolveNautiloRootDir,
  resolveNautiloRuntimePaths,
} from "../../src/runtime-paths";

describe("runtime paths", () => {
  test("defaults runtime state under ~/.nautilo", () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: "/Users/tester",
    });

    expect(paths.rootDir).toBe("/Users/tester/.nautilo");
    expect(paths.sessionStateFile).toBe("/Users/tester/.nautilo/session.json");
    expect(paths.homeRootDir).toBe("/Users/tester/.nautilo/home");
    expect(paths.workspaceDir).toBe("/Users/tester/.nautilo/home/workspace");
    expect(paths.exportsDir).toBe("/Users/tester/.nautilo/home/exports");
  });

  test("zones are siblings of home/ (D049 layout)", () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: "/Users/tester",
    });

    // scratch is NOT under home/ — it's a sibling
    expect(paths.scratchDir).toBe("/Users/tester/.nautilo/scratch");
    expect(paths.scratchDir.startsWith(paths.homeRootDir)).toBe(false);

    // zone roots
    expect(paths.dataDir).toBe("/Users/tester/.nautilo/data");
    expect(paths.vaultDir).toBe("/Users/tester/.nautilo/vault");

    // data sub-paths
    expect(paths.dbDataDir).toBe("/Users/tester/.nautilo/data/db");
    expect(paths.embeddingsDir).toBe("/Users/tester/.nautilo/data/embeddings");
    expect(paths.voiceCacheDir).toBe(
      "/Users/tester/.nautilo/data/voice-previews",
    );
    expect(paths.audioCacheDir).toBe("/Users/tester/.nautilo/data/audio");

    // no inboxDir field (post-pivot)
    expect("inboxDir" in paths).toBe(false);
  });

  test("storage env overrides win over defaults", () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({
        nautilo_vault_dir: "/abs/vault",
      }),
      env: {},
      userHomeDir: "/Users/tester",
    });

    expect(paths.vaultDir).toBe("/abs/vault");
  });

  test("NAUTILO_HOME is ignored (M071 — instance layout only)", () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: { NAUTILO_HOME: "/tmp/should-not-win", NAUTILO_INSTANCE_ID: "" },
      userHomeDir: "/Users/tester",
    });

    expect(paths.rootDir).toBe("/Users/tester/.nautilo");
    expect(paths.sessionStateFile).toBe("/Users/tester/.nautilo/session.json");
  });

  test("expands tilde paths safely relative to ~/.nautilo root", () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({
        nautilo_session_state_file: "~/Library/Application Support/Nautilo/session.json",
        nautilo_home_exports_dir: "~/Documents/Nautilo Exports",
      }),
      env: {},
      userHomeDir: "/Users/tester",
    });

    expect(paths.rootDir).toBe("/Users/tester/.nautilo");
    expect(paths.sessionStateFile).toBe(
      "/Users/tester/Library/Application Support/Nautilo/session.json",
    );
    expect(paths.exportsDir).toBe("/Users/tester/Documents/Nautilo Exports");
  });

  test("NAUTILO_INSTANCE_ID=beta resolves to ~/.nautilo-beta", () => {
    const root = resolveNautiloRootDir({
      env: { NAUTILO_INSTANCE_ID: "beta", HOME: "/Users/tester" },
      userHomeDir: "/Users/tester",
    });
    expect(root).toBe(normalize("/Users/tester/.nautilo-beta"));
  });

  test("invalid NAUTILO_INSTANCE_ID throws with validation message", () => {
    expect(() =>
      resolveNautiloRootDir({
        env: { NAUTILO_INSTANCE_ID: "BAD", HOME: "/Users/tester" },
        userHomeDir: "/Users/tester",
      }),
    ).toThrow(/NAUTILO_INSTANCE_ID/);
  });

  test("resolveNautiloRootDir uses env HOME when userHomeDir is omitted", () => {
    const root = resolveNautiloRootDir({
      env: { HOME: "/tmp/fake-home", NAUTILO_INSTANCE_ID: "" },
    });
    expect(root).toBe(normalize(join("/tmp/fake-home", ".nautilo")));
  });

  test("parseNautiloInstanceId trims whitespace", () => {
    expect(parseNautiloInstanceId({ NAUTILO_INSTANCE_ID: "  " })).toBe("");
    expect(parseNautiloInstanceId({ NAUTILO_INSTANCE_ID: "beta" })).toBe("beta");
  });
});
