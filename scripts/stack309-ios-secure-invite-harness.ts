#!/usr/bin/env bun
/**
 * Stack 309 local iOS-Simulator acceptance-only invite transfer.
 *
 * The sole argument is a mode-0600 file containing a canonical invite
 * locator. It is streamed to this Simulator app's private Documents directory
 * and never appears in a command argument, environment variable, clipboard,
 * log, screenshot, or URL handled by this host process. The dev-only app
 * seam consumes the staged file through ordinary InviteIntake custody.
 */
import { createReadStream, createWriteStream, lstatSync } from "node:fs";
import { chmod, lstat, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PACKAGE_NAME = "ai.nautilo.app";
const STAGED_FILENAME = ".stack309-invite.staged";
const INCOMING_PREFIX = ".stack309-invite.incoming-";
const MAX_LOCATOR_BYTES = 8_192;

function usage(): never {
  throw new Error("Usage: bun scripts/stack309-ios-secure-invite-harness.ts --token-file <mode-0600-path>");
}

function parseTokenFileArgument(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--token-file" || !args[1]) usage();
  return args[1];
}

function inspectTokenFile(tokenFile: string): void {
  const stat = lstatSync(tokenFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Token file must be a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("Token file must have mode 0600 or stricter");
  if (stat.size < 1 || stat.size > MAX_LOCATOR_BYTES) throw new Error("Token file has an invalid size");
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error("Could not resolve the booted iOS Simulator app container")));
  });
}

async function streamExclusive(source: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(source, { flags: "r" });
    const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    input.once("error", reject);
    output.once("error", reject);
    output.once("close", resolve);
    input.pipe(output);
  });
}

async function resolveDocumentsDirectory(): Promise<string> {
  const dataContainer = await run("xcrun", ["simctl", "get_app_container", "booted", PACKAGE_NAME, "data"]);
  if (!dataContainer || dataContainer.includes("\n")) throw new Error("Invalid iOS Simulator app container");
  const documents = join(dataContainer, "Documents");
  const stat = await lstat(documents);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid iOS Simulator Documents directory");
  return documents;
}

async function main(): Promise<void> {
  const tokenFile = parseTokenFileArgument(process.argv.slice(2));
  inspectTokenFile(tokenFile);
  const documents = await resolveDocumentsDirectory();
  const staged = join(documents, STAGED_FILENAME);
  const incoming = join(documents, `${INCOMING_PREFIX}${randomUUID()}`);

  try {
    await lstat(staged);
    throw new Error("An unconsumed iOS Simulator invite is already staged");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await streamExclusive(tokenFile, incoming);
    await chmod(incoming, 0o600);
    await rename(incoming, staged);
    await unlink(tokenFile);
  } catch (error) {
    await unlink(incoming).catch(() => undefined);
    throw error;
  }
  // Intentionally token-free. The app will consume the private staged file on
  // its next active launch/reload.
  process.stdout.write(`iOS Simulator invite staged for ${basename(documents)}. Reload Nautilo once.\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "iOS debug invite handoff failed"}\n`);
    process.exitCode = 1;
  });
}

export { inspectTokenFile, parseTokenFileArgument };
