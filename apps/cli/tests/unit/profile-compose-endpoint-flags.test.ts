import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";

import {
  LOCAL_COMPOSE_ENDPOINT_FLAGS_ERROR,
  profileModule,
} from "../../src/commands/profile.ts";

const homes: string[] = [];
let priorPort: string | undefined;

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (priorPort === undefined) delete process.env["NAUTILO_PORT"];
  else process.env["NAUTILO_PORT"] = priorPort;
  process.exitCode = undefined;
});

async function runProfileAdd(home: string, endpointFlag: "--host" | "--port", value: string): Promise<string> {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await yargs([
      "profile", "add", "local-compose", "--transport", "local", "--lifecycle", "compose",
      endpointFlag, value, "--yes", "--home", home,
    ])
      .strict()
      .exitProcess(false)
      .command(profileModule)
      .parseAsync();
  } finally {
    process.stderr.write = originalWrite;
  }
  return stderr;
}

describe("local Compose profile endpoint flags", () => {
  test.each([
    ["--host", "127.0.0.1"],
    ["--port", "4310"],
  ] as const)("rejects %s before a local Compose profile is persisted", async (flag, value) => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-local-compose-profile-"));
    homes.push(home);
    priorPort = process.env["NAUTILO_PORT"];
    process.env["NAUTILO_PORT"] = "preserved-test-port";
    process.exitCode = 0;

    const stderr = await runProfileAdd(home, flag, value);

    expect(process.exitCode).toBe(2);
    expect(stderr).toBe(LOCAL_COMPOSE_ENDPOINT_FLAGS_ERROR);
    expect(existsSync(join(home, ".nautilo", "profiles", "local-compose.toml"))).toBeFalse();
    expect(existsSync(join(home, ".nautilo", "profiles", ".active"))).toBeFalse();
    expect(process.env["NAUTILO_PORT"]).toBe("preserved-test-port");
  });
});
