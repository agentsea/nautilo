import { afterEach, describe, expect, test } from "bun:test";
import { parseMode } from "../../src/commands/login.ts";

describe("nautilo login --device alias", () => {
  const origWrite = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    process.stderr.write = origWrite;
  });

  test("--device: true emits deprecation notice and selects device flow", () => {
    let err = "";
    process.stderr.write = (s: string | Uint8Array) => {
      err += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    const mode = parseMode(
      { device: true, remote: false, token: undefined } as Record<string, unknown>,
      {},
    );
    expect(err.toLowerCase()).toContain("deprecated");
    expect(mode).toBe("device");
  });
});
