#!/usr/bin/env bun
/**
 * Stack 309's local Android acceptance-only invite transfer.
 *
 * The sole argument is a mode-0600 file containing a canonical invite locator.
 * Its contents flow directly to app-private storage over stdin and are never
 * passed via a command argument, environment variable, clipboard, log, or URL
 * handled by this host process. The debug-only receiver consumes that file once.
 */
import { createReadStream, lstatSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const PACKAGE_NAME = "ai.nautilo.app";
const RECEIVER = "ai.nautilo.app/.Stack309InviteHarnessReceiver";
const ACTION = "ai.nautilo.app.debug.action.CONSUME_STACK309_INVITE";
const STAGED = "files/stack309-invite.staged";
const INCOMING = "files/.stack309-invite.incoming";
const MAX_LOCATOR_BYTES = 8192;

function usage(): never {
  throw new Error("Usage: bun scripts/stack309-android-secure-invite-harness.ts --token-file <mode-0600-path>");
}

function parseTokenFileArgument(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--token-file" || !args[1]) usage();
  return args[1];
}

function adbPath(): string {
  const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (!sdkRoot) throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT is required");
  return path.join(sdkRoot, "platform-tools", "adb");
}

function inspectTokenFile(tokenFile: string): void {
  const stat = lstatSync(tokenFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Token file must be a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("Token file must have mode 0600 or stricter");
  if (stat.size < 1 || stat.size > MAX_LOCATOR_BYTES) throw new Error("Token file has an invalid size");
}

function run(adb: string, args: readonly string[], stdin?: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(adb, [...args], { stdio: [stdin ? "pipe" : "ignore", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Android debug invite handoff failed")));
    if (stdin && child.stdin) stdin.pipe(child.stdin);
  });
}

async function main(): Promise<void> {
  const tokenFile = parseTokenFileArgument(process.argv.slice(2));
  inspectTokenFile(tokenFile);
  const adb = adbPath();

  // No overwrite: an older unconsumed staged invite must be explicitly
  // consumed/cleaned rather than silently replaced by this acceptance harness.
  await run(adb, [
    "shell",
    "-T",
    `run-as ${PACKAGE_NAME} sh -c 'test ! -e ${STAGED} && test ! -e ${INCOMING}'`,
  ]);
  await run(
    adb,
    // `shell -T` keeps the pipe non-interactive while preserving stdin. The
    // otherwise tempting `exec-out` transport does not forward stdin to
    // `run-as` reliably on Android, which would strand an empty receipt.
    [
      "shell",
      "-T",
      `run-as ${PACKAGE_NAME} sh -c 'mkdir -p files && umask 077; cat > ${INCOMING} && mv ${INCOMING} ${STAGED}'`,
    ],
    createReadStream(tokenFile),
  );
  await run(adb, ["shell", "am", "broadcast", "--receiver-foreground", "-n", RECEIVER, "-a", ACTION]);
  await unlink(tokenFile);
  process.stdout.write("Android debug invite handoff triggered.\n");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Android debug invite handoff failed"}\n`);
    process.exitCode = 1;
  });
}

export { inspectTokenFile, parseTokenFileArgument };
