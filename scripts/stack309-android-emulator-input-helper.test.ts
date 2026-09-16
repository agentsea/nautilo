/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const sourcePath = new URL("./stack309-android-emulator-input-helper.ts", import.meta.url);

describe("Stack 309 Android emulator input helper", () => {
  test("uses only a 0600 fixture and emits no capture, clipboard, or secret output route", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('"--fixture-file"');
    expect(source).toContain('"--field"');
    expect(source).toContain("lstatSync");
    expect(source).toContain("unlink(fixtureFile)");
    expect(source).toContain('const TEST_PACKAGE = "ai.nautilo.app.test"');
    expect(source).toContain('"ime", "set"');
    expect(source).toContain('"shell", "-T", stageCommand');
    expect(source).toContain("await delay(2_000)");
    expect(source).toContain("Stack309SecureInputMethodService");
    expect(source).toContain("COMMIT_STACK309_INPUT");
    expect(source).toContain("default_input_method");
    expect(source).toContain("SUCCESS_MARKER");
    expect(source).toContain('stdio: [fixtureFile ? "pipe" : "ignore", "ignore", "ignore"]');
    expect(source).not.toContain('"input", "keyevent"');
    expect(source).not.toContain("keyCode(");
    expect(source).not.toContain("Bun.file");
    expect(source).not.toContain("uiautomator");
    expect(source).not.toContain("screencap");
    expect(source).not.toContain("exec-out");
    expect(source).not.toContain("Clipboard");
    expect(source).not.toContain("console.");
    expect(source).not.toContain("process.stdout");
    expect(source).not.toContain("process.env");
  });
});
