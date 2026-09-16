#!/usr/bin/env bun

import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type InstanceMetadata = {
  instanceId?: string;
  server?: { port?: number; url?: string };
  logto?: { corePort?: number };
};

export function parseInstance(argv: readonly string[]): string {
  const index = argv.indexOf("--instance");
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error("Usage: bun run mobile:local:preflight --instance <instance-id>");
  }
  return value;
}

export function instanceRoot(instanceId: string, home = homedir()): string {
  return instanceId === "default"
    ? path.join(home, ".nautilo")
    : path.join(home, `.nautilo-${instanceId}`);
}

export function requiredAndroidReversePorts(
  metadata: InstanceMetadata,
  metroPort = 8081,
): number[] {
  const ports = [metroPort, metadata.server?.port, metadata.logto?.corePort]
    .filter((port): port is number => Number.isInteger(port) && port > 0);
  return [...new Set(ports)];
}

function run(command: string, args: string[]): string {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.toString();
}

function resolveAdb(): string {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    path.join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates[0] ?? "adb";
}

async function expectHttp(url: string, label: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return response;
  } catch (error) {
    throw new Error(`${label} is unreachable at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const instanceId = parseInstance(Bun.argv.slice(2));
  const root = instanceRoot(instanceId);
  const metadataPath = path.join(root, "instance.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as InstanceMetadata;
  if (metadata.instanceId !== instanceId) {
    throw new Error(`Instance metadata mismatch: expected ${instanceId}, found ${metadata.instanceId ?? "unknown"}`);
  }
  const serverPort = metadata.server?.port;
  const authPort = metadata.logto?.corePort;
  if (!serverPort || !authPort) throw new Error(`Missing server or Logto ports in ${metadataPath}`);

  await expectHttp(`http://127.0.0.1:${serverPort}/health`, "Nautilo server");
  await expectHttp(`http://127.0.0.1:${authPort}/oidc/.well-known/openid-configuration`, "Logto discovery");

  const metro = await expectHttp("http://127.0.0.1:8081/status", "Metro");
  const metroRoot = metro.headers.get("x-react-native-project-root");
  const expectedMobileRoot = path.join(process.cwd(), "apps", "mobile");
  if (metroRoot && path.resolve(metroRoot) !== path.resolve(expectedMobileRoot)) {
    throw new Error(`Metro belongs to another checkout: ${metroRoot}`);
  }

  const simctl = JSON.parse(run("xcrun", ["simctl", "list", "devices", "booted", "--json"])) as {
    devices?: Record<string, Array<{ name: string; udid: string; state: string; isAvailable?: boolean }>>;
  };
  const iosDevices = Object.values(simctl.devices ?? {}).flat().filter((device) =>
    device.state === "Booted" && device.isAvailable !== false
  );
  if (iosDevices.length !== 1) {
    throw new Error(`Expected exactly one booted iOS simulator; found ${iosDevices.length}`);
  }

  const adb = resolveAdb();
  await access(adb);
  const androidDevices = run(adb, ["devices"])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device");
  if (androidDevices.length !== 1) {
    throw new Error(`Expected exactly one running Android emulator; found ${androidDevices.length}`);
  }
  for (const port of requiredAndroidReversePorts(metadata)) {
    run(adb, ["-s", androidDevices[0]![0]!, "reverse", `tcp:${port}`, `tcp:${port}`]);
  }

  const policyPath = path.join(expectedMobileRoot, "android", "app", "src", "debug", "res", "xml", "nautilo_local_dev_network_security_config.xml");
  const policy = await readFile(policyPath, "utf8");
  if (!policy.includes(">10.0.2.2<")) {
    throw new Error("Android debug policy does not allow Expo's 10.0.2.2 loopback alias; regenerate and rebuild the native client");
  }

  console.log(`Mobile lab ready for ${instanceId}`);
  console.log(`  iOS: ${iosDevices[0]!.name} (${iosDevices[0]!.udid})`);
  console.log(`  Android: ${androidDevices[0]![0]}`);
  console.log(`  Metro: exact checkout on 8081`);
  console.log(`  Server: ${serverPort}; Logto: ${authPort}`);
  console.log(`  Android reverse tunnels: ${requiredAndroidReversePorts(metadata).join(", ")}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
