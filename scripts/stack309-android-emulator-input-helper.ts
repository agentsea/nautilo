#!/usr/bin/env bun
/**
 * Local Stack 309 acceptance-only HID input for the Android emulator.
 *
 * A mode-0600 fixture is consumed locally; its bytes never enter shell
 * arguments, environment variables, UI capture, or command output. This
 * helper intentionally emits no success/error text.
 */
import { spawn } from "node:child_process";
import { createReadStream, lstatSync } from "node:fs";
import { unlink } from "node:fs/promises";

type Field = "handle" | "password" | "pin";

const TEST_PACKAGE = "ai.nautilo.app.test";
const INPUT_METHOD = `${TEST_PACKAGE}/ai.nautilo.app.Stack309SecureInputMethodService`;
const COMMIT_ACTION = `${TEST_PACKAGE}.action.COMMIT_STACK309_INPUT`;
const SUCCESS_MARKER = "stack309-input.ok";

function exitFailure(): never {
  process.exitCode = 1;
  throw new Error();
}

function parseArgs(args: readonly string[]): Readonly<{ fixtureFile: string; field: Field }> {
  if (args.length !== 4 || args[0] !== "--fixture-file" || args[2] !== "--field") exitFailure();
  const field = args[3];
  if (!args[1] || (field !== "handle" && field !== "password" && field !== "pin")) exitFailure();
  return { fixtureFile: args[1], field };
}

function runAdb(args: readonly string[], fixtureFile?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("adb", args, {
      stdio: [fixtureFile ? "pipe" : "ignore", "ignore", "ignore"],
    });
    if (fixtureFile) {
      const source = createReadStream(fixtureFile);
      source.once("error", reject);
      source.pipe(child.stdin!);
    }
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error()));
  });
}

function readAdb(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("adb", args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8").trim())
      : reject(new Error()));
  });
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  const { fixtureFile, field } = parseArgs(process.argv.slice(2));
  const stat = lstatSync(fixtureFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 128) exitFailure();

  const stagedName = `stack309-${field}-input.staged`;
  const stageCommand = `run-as ${TEST_PACKAGE} sh -c 'umask 077; cat > files/${stagedName}'`;
  const previousInputMethod = await readAdb(["shell", "settings", "get", "secure", "default_input_method"]);
  try {
    await runAdb(["shell", "run-as", TEST_PACKAGE, "mkdir", "-p", "files"]);
    await runAdb(
      ["shell", "-T", stageCommand],
      fixtureFile,
    );
  } finally {
    await unlink(fixtureFile).catch(() => undefined);
  }
  try {
    await runAdb(["shell", "ime", "enable", INPUT_METHOD]);
    await runAdb(["shell", "ime", "set", INPUT_METHOD]);
    // Selecting an IME invalidates the prior Android input connection. Keep a
    // bounded arming window so the harness can refocus the intended field
    // before the fixed, secret-free commit broadcast fires.
    await delay(2_000);
    await runAdb(["shell", "am", "broadcast", "-a", COMMIT_ACTION, "-p", TEST_PACKAGE]);
    await delay(250);
    await runAdb(["shell", "run-as", TEST_PACKAGE, "test", "-f", `files/${SUCCESS_MARKER}`]);
  } finally {
    await runAdb(["shell", "run-as", TEST_PACKAGE, "rm", "-f", `files/${SUCCESS_MARKER}`]).catch(() => undefined);
    if (previousInputMethod && previousInputMethod !== "null") {
      await runAdb(["shell", "ime", "set", previousInputMethod]).catch(() => undefined);
    }
    await runAdb(["shell", "ime", "disable", INPUT_METHOD]).catch(() => undefined);
  }
}

if (import.meta.main) {
  main().catch(() => { process.exitCode = 1; });
}
