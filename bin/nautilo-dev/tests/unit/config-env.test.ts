/**
 * M053 — `loadConfigEnvIntoProcess` unit tests.
 *
 * The helper has to (1) tolerate a missing file (fresh box), (2) NOT
 * stomp pre-set env vars (CI / explicit overrides win), (3) honor
 * `--config-env <path>`, and (4) parse the same key=value shape that
 * bootstrap-logto + config-guard produce.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigEnvIntoProcess } from "../../src/lib/config-env";

function makeEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "config-env-test-"));
  const path = join(dir, "instance.env");
  writeFileSync(path, contents);
  return path;
}

describe("loadConfigEnvIntoProcess", () => {
  test("loads simple KEY=value pairs into the supplied env", () => {
    const path = makeEnvFile(
      [
        "NAUTILO_HOSTING_MODE=local",
        "LOGTO_ENDPOINT=http://localhost:3301",
        "LOGTO_M2M_APP_ID=m2m",
      ].join("\n"),
    );
    try {
      const env: NodeJS.ProcessEnv = {};
      const result = loadConfigEnvIntoProcess({ path }, env);
      expect(result.loaded).toBe(true);
      expect(result.applied).toBe(3);
      expect(env["NAUTILO_HOSTING_MODE"]).toBe("local");
      expect(env["LOGTO_ENDPOINT"]).toBe("http://localhost:3301");
      expect(env["LOGTO_M2M_APP_ID"]).toBe("m2m");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("does NOT stomp pre-set env vars", () => {
    const path = makeEnvFile("NAUTILO_HOSTING_MODE=local\nLOGTO_ENDPOINT=from-file");
    try {
      const env: NodeJS.ProcessEnv = { LOGTO_ENDPOINT: "from-process" };
      const result = loadConfigEnvIntoProcess({ path }, env);
      expect(env["LOGTO_ENDPOINT"]).toBe("from-process");
      expect(env["NAUTILO_HOSTING_MODE"]).toBe("local");
      expect(result.applied).toBe(1);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("strips matching surrounding quotes", () => {
    const path = makeEnvFile(
      [
        `LOGTO_M2M_APP_SECRET="secret with spaces"`,
        `OTHER='single-quoted'`,
        `RAW=plain`,
      ].join("\n"),
    );
    try {
      const env: NodeJS.ProcessEnv = {};
      loadConfigEnvIntoProcess({ path }, env);
      expect(env["LOGTO_M2M_APP_SECRET"]).toBe("secret with spaces");
      expect(env["OTHER"]).toBe("single-quoted");
      expect(env["RAW"]).toBe("plain");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("ignores comments and blank lines", () => {
    const path = makeEnvFile(
      ["# a comment", "", "  # indented comment", "NAUTILO_HOSTING_MODE=cloud"].join("\n"),
    );
    try {
      const env: NodeJS.ProcessEnv = {};
      const result = loadConfigEnvIntoProcess({ path }, env);
      expect(result.applied).toBe(1);
      expect(env["NAUTILO_HOSTING_MODE"]).toBe("cloud");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("returns loaded=false when the file is missing (fresh box)", () => {
    const result = loadConfigEnvIntoProcess(
      { path: "/tmp/does-not-exist-nautilo-test.env" },
      {},
    );
    expect(result.loaded).toBe(false);
    expect(result.applied).toBe(0);
  });
});
