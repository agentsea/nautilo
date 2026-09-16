/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const sourcePath = new URL("./stack309-ios-simulator-input.swift", import.meta.url);

function run(command: string, args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

describe("Stack 309 iOS Simulator input helper", () => {
  test("has no clipboard, environment, command-output, or arbitrary field route", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('case handle');
    expect(source).toContain('case password');
    expect(source).toContain('case pin');
    expect(source).toContain('simulatorBundleIdentifier = "com.apple.iphonesimulator"');
    expect(source).toContain('expectedSimulatorWindowTitles: Set<String>');
    expect(source).toContain('"iPhone 16 Pro – iOS 18.3"');
    expect(source).toContain('"iPhone 16 Pro Max – iOS 18.3"');
    expect(source).toContain("expectedSimulatorWindowTitles.contains(title)");
    expect(source).toContain("runningApplications(withBundleIdentifier: simulatorBundleIdentifier)");
    expect(source).toContain("applications.count == 1");
    expect(source).toContain("verifyExactSimulatorFrontmostWindow()");
    expect(source).toContain('character == "_"');
    expect(source).toContain("CGEventSource(stateID: .privateState)");
    expect(source).toContain("let shiftCode: CGKeyCode = 56");
    expect(source).toContain("shiftDown.post(tap: .cghidEventTap)");
    expect(source).toContain("shiftUp.post(tap: .cghidEventTap)");
    expect(source).toContain('"-": 27');
    expect(source).toContain(".cghidEventTap");
    expect(source).toContain("eraseAndDelete(arguments.path");
    expect(source).not.toContain("NSPasteboard");
    expect(source).not.toContain("ProcessInfo.processInfo.environment");
    expect(source).not.toContain("fixture.value +");
  });

  test("typechecks independently without installing or replacing any helper", async () => {
    const result = await run("swiftc", ["-typecheck", sourcePath.pathname]);
    expect(result.code, result.stderr).toBe(0);
  });
});
