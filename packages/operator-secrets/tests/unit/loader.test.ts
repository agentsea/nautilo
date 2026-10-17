import { describe, test, expect } from "bun:test";
import {
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOperatorSecrets, parseOperatorSecretsBody } from "../../src/loader.ts";
import { writePrivateFileExclusiveSync } from "@nautilo/config/private-filesystem";
import { allowOtherReadersSync } from "@nautilo/config/private-filesystem-fixtures";
import { temporaryDirectory } from "./permissions";

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
    const dir = temporaryDirectory(join(tmpdir(), "nautilo-os-"));
    const p = join(dir, "nope.env");
    const m = await loadOperatorSecrets(p);
    expect(m).toEqual({});
  });

  test("refuses files that permit other readers", async () => {
    const dir = temporaryDirectory(join(tmpdir(), "nautilo-os-"));
    const p = join(dir, "s.env");
    writePrivateFileExclusiveSync(p, Buffer.from("OPENAI_API_KEY=x\n"));
    allowOtherReadersSync(p);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(loadOperatorSecrets(p)).rejects.toThrow(/mode 0600|owner-only Windows ACL/);
  });

  test("refuses path inside git repo", async () => {
    const dir = temporaryDirectory(join(tmpdir(), "nautilo-git-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    const p = join(dir, "secrets.env");
    writeFileSync(p, "OPENAI_API_KEY=x\n", { mode: 0o600 });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
    await expect(loadOperatorSecrets(p)).rejects.toThrow(/git repository/);
  });

  test("symlink outside HOME refused", async () => {
    const home = temporaryDirectory(join(tmpdir(), "nautilo-home-"));
    const outside = temporaryDirectory(join(tmpdir(), "nautilo-out-"));
    const target = join(outside, "t.env");
    writePrivateFileExclusiveSync(target, Buffer.from("OPENAI_API_KEY=x\n"));
    const link = join(home, "link.env");
    symlinkSync(target, link, "file");
    const homeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const previousHome = process.env[homeVariable];
    process.env[homeVariable] = home;
    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects is thenable; the rule's type inference doesn't see through it.
      await expect(loadOperatorSecrets(link)).rejects.toThrow(/inside HOME/);
    } finally {
      if (previousHome === undefined) delete process.env[homeVariable];
      else process.env[homeVariable] = previousHome;
    }
  });

  test("unknown keys still parse (forward-compat)", async () => {
    const dir = temporaryDirectory(join(tmpdir(), "nautilo-os-"));
    const p = join(dir, "s.env");
    writePrivateFileExclusiveSync(p, Buffer.from("OPENAI_API_KEY=sk-x\nFUTURE_NAUTILO_THING=abc\n"));
    const m = await loadOperatorSecrets(p);
    expect(m["FUTURE_NAUTILO_THING"]).toBe("abc");
  });
});
