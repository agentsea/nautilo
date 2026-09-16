import { createWriteStream } from "node:fs";
import { isAbsolute } from "node:path";

import { createNativeCuaHost } from "./native-host.js";
import { runComputerUseHostStdio } from "./stdio.js";
import { COMPUTER_USE_HOST_VERSION } from "./version.js";

if (process.argv.length === 3 && process.argv[2] === "--health") {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    component: "nautilo-computer-use-host",
    version: COMPUTER_USE_HOST_VERSION,
    status: "ready",
  })}\n`);
  process.exit(0);
}

type LaunchOptions = Readonly<{
  driverPath: string;
  runtimeRoot: string;
  hostBundleId: string;
  attachmentFd: number;
}>;

function launchOptions(argv: readonly string[]): LaunchOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || values.has(name)
      || !["--cua-driver", "--runtime-root", "--host-bundle-id", "--attachment-fd"].includes(name)) {
      throw new Error("Computer Use Host launch arguments rejected");
    }
    values.set(name, value);
  }
  const driverPath = values.get("--cua-driver");
  const runtimeRoot = values.get("--runtime-root");
  const hostBundleId = values.get("--host-bundle-id");
  const attachmentFd = Number(values.get("--attachment-fd"));
  if (driverPath === undefined || runtimeRoot === undefined || hostBundleId === undefined
    || !isAbsolute(driverPath) || !isAbsolute(runtimeRoot)
    || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(hostBundleId)
    || hostBundleId.length > 255
    || !Number.isSafeInteger(attachmentFd) || attachmentFd < 3) {
    throw new Error("Computer Use Host requires an exact driver, trusted runtime root, host identity, and attachment pipe");
  }
  return { driverPath, runtimeRoot, hostBundleId, attachmentFd };
}

const options = launchOptions(process.argv.slice(2));
let invalidated = false;
const runtime = await createNativeCuaHost({
  driverPath: options.driverPath,
  runtimeRoot: options.runtimeRoot,
  hostBundleId: options.hostBundleId,
  onDriverInvalidated: () => {
    invalidated = true;
    // Stop accepting requests after the checked generation disappears. The
    // in-flight dispatch still settles and writes its precise result first.
    process.stdin.destroy();
  },
});
const attachmentOutput = createWriteStream("/dev/null", {
  fd: options.attachmentFd,
  autoClose: false,
});
try {
  await runComputerUseHostStdio({
    host: runtime.host,
    input: process.stdin,
    output: process.stdout,
    attachmentOutput,
  });
} finally {
  attachmentOutput.end();
  await runtime.shutdown();
}
if (invalidated) process.exitCode = 75;
