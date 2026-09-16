import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { collectProtocolInventory } from "../src/protocol-inventory";

interface AnchorPointer {
  schemaVersion: 1;
  codexVersion: string;
  manifest: string;
}

interface AnchorManifest {
  schemaVersion: 1;
  codexVersion: string;
  cliReportedVersion: string;
  source: {
    distribution: string;
    launcherSha256: string;
    executableSha256: string;
    platform: NodeJS.Platform;
    architecture: string;
  };
  commands: string[];
  upstream: TreeFingerprint;
  inventory: TreeFingerprint;
}

interface FileRecord {
  path: string;
  sha256: string;
  bytes: number;
  verification: "byte" | "canonical_json";
  canonicalSha256?: string;
}

interface TreeFingerprint {
  files: number;
  bytes: number;
  sha256: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = join(packageRoot, "generated");
const anchorPointerPath = join(generatedRoot, "anchor.json");

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function parseArguments(args: string[]): {
  mode: "check" | "update";
  codexBin: string;
} {
  const check = args.includes("--check");
  const update = args.includes("--update-anchor");
  if (check === update) {
    throw new Error("Pass exactly one of --check or --update-anchor");
  }

  const codexBinArgument = args.find((argument) =>
    argument.startsWith("--codex-bin="),
  );
  return {
    mode: check ? "check" : "update",
    codexBin: codexBinArgument?.slice("--codex-bin=".length) || "codex",
  };
}

function resolveCommand(command: string): string {
  if (command.includes(sep)) {
    return realpathSync(command);
  }

  const result = spawnSync("command", ["-v", command], {
    encoding: "utf8",
    shell: true,
  });
  const resolved = result.stdout.trim();
  if (result.status !== 0 || resolved.length === 0) {
    throw new Error(`Unable to resolve command: ${command}`);
  }
  return realpathSync(resolved);
}

function listFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isNondeterministicAggregate(path: string): boolean {
  return path.endsWith(
    "/json-schema/codex_app_server_protocol.v2.schemas.json",
  );
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function canonicalJsonSha256(path: string): string {
  const canonical = JSON.stringify(
    sortJson(JSON.parse(readFileSync(path, "utf8")) as unknown),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function fileRecords(root: string): FileRecord[] {
  return listFiles(root).map((file) => {
    const path = portablePath(relative(root, file));
    const verification = isNondeterministicAggregate(path)
      ? "canonical_json"
      : "byte";
    return {
      path,
      sha256: sha256(file),
      bytes: statSync(file).size,
      verification,
      ...(verification === "canonical_json"
        ? { canonicalSha256: canonicalJsonSha256(file) }
        : {}),
    };
  });
}

function treeFingerprint(root: string): TreeFingerprint {
  const records = fileRecords(root);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const record of records) {
    bytes += record.bytes;
    hash.update(record.path);
    hash.update("\0");
    hash.update(record.verification);
    hash.update("\0");
    hash.update(record.canonicalSha256 ?? record.sha256);
    hash.update("\0");
    hash.update(String(record.bytes));
    hash.update("\0");
  }
  return {
    files: records.length,
    bytes,
    sha256: hash.digest("hex"),
  };
}

function findNativeExecutable(launcher: string): string {
  if (!launcher.endsWith(".js")) {
    return launcher;
  }

  const packageRootCandidate = resolve(dirname(launcher), "..");
  const dependencyRoot = join(packageRootCandidate, "node_modules", "@openai");
  if (!existsSync(dependencyRoot)) {
    throw new Error(`Codex platform dependency root is missing: ${dependencyRoot}`);
  }

  const candidates = listFiles(dependencyRoot).filter(
    (file) =>
      file.endsWith(`${sep}bin${sep}codex`) &&
      file.includes(`${sep}vendor${sep}`),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one Codex native executable, found ${candidates.length}`,
    );
  }
  return candidates[0]!;
}

function readDistribution(launcher: string, codexVersion: string): string {
  if (!launcher.endsWith(".js")) {
    return `official Codex CLI ${codexVersion}`;
  }

  const packageJsonPath = resolve(dirname(launcher), "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    packageJson.name !== "@openai/codex" ||
    packageJson.version !== codexVersion
  ) {
    throw new Error("Resolved launcher is not the expected @openai/codex package");
  }
  return `npm:${packageJson.name}@${packageJson.version}`;
}

function readCodexVersion(codexBin: string): {
  cliReportedVersion: string;
  codexVersion: string;
} {
  const result = spawnSync(codexBin, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Codex version probe failed: ${result.stderr.trim()}`);
  }

  const cliReportedVersion = result.stdout.trim();
  const match = /^codex-cli (\S+)$/.exec(cliReportedVersion);
  if (!match) {
    throw new Error(`Unexpected Codex version output: ${cliReportedVersion}`);
  }
  return { cliReportedVersion, codexVersion: match[1]! };
}

function runGenerator(
  codexBin: string,
  privateHome: string,
  command: "generate-ts" | "generate-json-schema",
  output: string,
  experimental: boolean,
): void {
  mkdirSync(output, { recursive: true });
  const args = [
    "app-server",
    command,
    "--out",
    output,
    ...(experimental ? ["--experimental"] : []),
  ];
  const result = spawnSync(codexBin, args, {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: privateHome },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Codex ${command}${experimental ? " --experimental" : ""} failed:\n${result.stderr}`,
    );
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function generateSnapshot(
  codexBin: string,
  codexVersion: string,
  stagingRoot: string,
): { upstreamRoot: string; inventoryRoot: string } {
  const privateHome = join(stagingRoot, "private-codex-home");
  const upstreamRoot = join(stagingRoot, "upstream");
  const inventoryRoot = join(stagingRoot, "inventory");
  mkdirSync(privateHome, { recursive: true });
  mkdirSync(inventoryRoot, { recursive: true });

  for (const experimental of [false, true]) {
    const channel = experimental ? "experimental" : "stable";
    runGenerator(
      codexBin,
      privateHome,
      "generate-ts",
      join(upstreamRoot, channel, "typescript"),
      experimental,
    );
    runGenerator(
      codexBin,
      privateHome,
      "generate-json-schema",
      join(upstreamRoot, channel, "json-schema"),
      experimental,
    );

    const inventory = collectProtocolInventory(
      join(upstreamRoot, channel, "typescript"),
    );
    writeJson(join(inventoryRoot, `${channel}.json`), {
      codexVersion,
      channel,
      ...inventory,
    });
  }

  return { upstreamRoot, inventoryRoot };
}

function compareFileTrees(expectedRoot: string, actualRoot: string): void {
  const expected = fileRecords(expectedRoot);
  const actual = fileRecords(actualRoot);
  const expectedMap = new Map(expected.map((entry) => [entry.path, entry]));
  const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
  const changed = [...new Set([...expectedMap.keys(), ...actualMap.keys()])]
    .filter((path) => {
      const expectedEntry = expectedMap.get(path);
      const actualEntry = actualMap.get(path);
      if (!expectedEntry || !actualEntry) {
        return true;
      }
      if (
        expectedEntry.verification === "canonical_json" &&
        actualEntry.verification === "canonical_json"
      ) {
        return expectedEntry.canonicalSha256 !== actualEntry.canonicalSha256;
      }
      return (
        expectedEntry.sha256 !== actualEntry.sha256 ||
        expectedEntry.bytes !== actualEntry.bytes
      );
    })
    .slice(0, 20);
  if (changed.length > 0) {
    throw new Error(
      `Generated protocol differs from the committed anchor (${changed.join(", ")}${changed.length === 20 ? ", …" : ""})`,
    );
  }
}

function verifyTreeFingerprint(
  label: string,
  expected: TreeFingerprint,
  root: string,
): void {
  const actual = treeFingerprint(root);
  if (
    actual.files !== expected.files ||
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} protocol fingerprint differs from the committed anchor`);
  }
}

function main(): void {
  const { mode, codexBin } = parseArguments(process.argv.slice(2));
  const launcher = resolveCommand(codexBin);
  const { cliReportedVersion, codexVersion } = readCodexVersion(codexBin);
  const stagingRoot = mkdtempSync(join(tmpdir(), "nautilo-codex-protocol-"));

  try {
    if (mode === "check") {
      if (!existsSync(anchorPointerPath)) {
        throw new Error("No committed Codex protocol anchor exists");
      }
      const pointer = JSON.parse(
        readFileSync(anchorPointerPath, "utf8"),
      ) as AnchorPointer;
      if (pointer.codexVersion !== codexVersion) {
        throw new Error(
          `Codex ${codexVersion} cannot check anchor ${pointer.codexVersion}; install the anchored CLI or explicitly update the anchor`,
        );
      }

      const snapshot = generateSnapshot(
        codexBin,
        codexVersion,
        stagingRoot,
      );
      const committedVersionRoot = join(generatedRoot, codexVersion);
      if (existsSync(join(committedVersionRoot, "upstream"))) {
        throw new Error("Committed protocol anchor must not contain raw generated trees");
      }
      compareFileTrees(
        join(committedVersionRoot, "inventory"),
        snapshot.inventoryRoot,
      );

      const manifest = JSON.parse(
        readFileSync(join(committedVersionRoot, "manifest.json"), "utf8"),
      ) as AnchorManifest;
      verifyTreeFingerprint("Upstream", manifest.upstream, snapshot.upstreamRoot);
      verifyTreeFingerprint("Inventory", manifest.inventory, snapshot.inventoryRoot);

      process.stdout.write(
        `Codex app-server protocol anchor ${codexVersion} regenerates reproducibly from compact fingerprints and reviewed inventories.\n`,
      );
      return;
    }

    const nativeExecutable = findNativeExecutable(launcher);
    const snapshot = generateSnapshot(codexBin, codexVersion, stagingRoot);
    const versionRoot = join(generatedRoot, codexVersion);
    const stagedVersionRoot = join(stagingRoot, codexVersion);
    mkdirSync(stagedVersionRoot, { recursive: true });
    cpSync(snapshot.inventoryRoot, join(stagedVersionRoot, "inventory"), {
      recursive: true,
    });

    const commands = [
      "codex app-server generate-ts --out <stable-typescript>",
      "codex app-server generate-json-schema --out <stable-json-schema>",
      "codex app-server generate-ts --experimental --out <experimental-typescript>",
      "codex app-server generate-json-schema --experimental --out <experimental-json-schema>",
    ];
    const manifest: AnchorManifest = {
      schemaVersion: 1,
      codexVersion,
      cliReportedVersion,
      source: {
        distribution: readDistribution(launcher, codexVersion),
        launcherSha256: sha256(launcher),
        executableSha256: sha256(nativeExecutable),
        platform: process.platform,
        architecture: process.arch,
      },
      commands,
      upstream: treeFingerprint(snapshot.upstreamRoot),
      inventory: treeFingerprint(snapshot.inventoryRoot),
    };
    writeJson(join(stagedVersionRoot, "manifest.json"), manifest);

    mkdirSync(generatedRoot, { recursive: true });
    if (existsSync(versionRoot)) {
      rmSync(versionRoot, { recursive: true });
    }
    cpSync(stagedVersionRoot, versionRoot, { recursive: true });
    writeJson(anchorPointerPath, {
      schemaVersion: 1,
      codexVersion,
      manifest: `${codexVersion}/manifest.json`,
    } satisfies AnchorPointer);

    process.stdout.write(
      `Updated compact Codex app-server protocol anchor ${codexVersion}: ${manifest.upstream.files} upstream files fingerprinted, ${manifest.inventory.files} inventories committed.\n`,
    );
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

main();
