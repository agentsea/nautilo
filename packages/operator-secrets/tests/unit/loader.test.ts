import { describe, test, expect } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOperatorSecrets, parseOperatorSecretsBody } from "../../src/loader.ts";

describe("operator secrets loader (§13.2)", () => {
  test("parse roundtrip + quotes + export prefix", () => {
    const body = [
      "export OPENAI_API_KEY=sk-test",
      'QUOTED="hello world"',
      "PLAIN=plain",
    ].join("\n");
    const m = parseOperatorSecretsBody(body);
    expect(m["OPENAI_API_KEY"]).toBe("sk-test");
    expect(m["QUOTED"]).toBe("hello world");
    expect(m["PLAIN"]).toBe("plain");
  });

  test("missing file returns empty map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-os-"));
    const p = join(dir, "nope.env");
    const m = await loadOperatorSecrets(p);
    expect(m).toEqual({});
  });

  test.skipIf(process.platform === "win32")("refuses mode 0644", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-os-"));
    const p = join(dir, "s.env");
    writeFileSync(p, "OPENAI_API_KEY=x\n", { mode: 0o644 });
    chmodSync(p, 0o644);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(loadOperatorSecrets(p)).rejects.toThrow(/mode 0600/);
  });

  test.skipIf(process.platform === "win32")("refuses path inside git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-git-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    const p = join(dir, "secrets.env");
    writeFileSync(p, "OPENAI_API_KEY=x\n", { mode: 0o600 });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(loadOperatorSecrets(p)).rejects.toThrow(/git repository/);
  });

  test.skipIf(process.platform === "win32")("symlink outside HOME refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "nautilo-home-"));
    const outside = mkdtempSync(join(tmpdir(), "nautilo-out-"));
    const target = join(outside, "t.env");
    writeFileSync(target, "OPENAI_API_KEY=x\n", { mode: 0o600 });
    const link = join(home, "link.env");
    symlinkSync(target, link);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(loadOperatorSecrets(link)).rejects.toThrow(/inside HOME/);
  });

  test("unknown keys still parse (forward-compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-os-"));
    const p = join(dir, "s.env");
    writeFileSync(p, "OPENAI_API_KEY=sk-x\nFUTURE_NAUTILO_THING=abc\n", { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      /* win32 */
    }
    const m = await loadOperatorSecrets(p);
    expect(m["FUTURE_NAUTILO_THING"]).toBe("abc");
  });
});
