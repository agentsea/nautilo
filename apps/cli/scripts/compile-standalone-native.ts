import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

export const STANDALONE_NATIVE_TARGETS = ["bun-darwin-arm64", "bun-darwin-x64"] as const;
export type StandaloneNativeTarget = (typeof STANDALONE_NATIVE_TARGETS)[number];

export type StandaloneCompilerConfigurationReceiptV1 = {
  readonly schemaVersion: 1;
  readonly target: StandaloneNativeTarget;
  readonly autoloadDotenv: false;
  readonly autoloadBunfig: false;
  readonly autoloadTsconfig: false;
  readonly autoloadPackageJson: false;
  readonly exactNativeKeyringRedirect: true;
  readonly embeddedNativeDeveloperIdCodeSigned: boolean;
  readonly embeddedNativeBindingInput: string;
  readonly embeddedNativeBindingSha256: string;
  readonly adHocCodeSigned: boolean;
  readonly developerIdCodeSigned: boolean;
  readonly hardenedRuntime: boolean;
  readonly secureTimestamp: boolean;
};

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function signStandaloneNativeExecutable(path: string): {
  adHocCodeSigned: boolean;
  developerIdCodeSigned: boolean;
  hardenedRuntime: boolean;
  secureTimestamp: boolean;
} {
  try {
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", resolve(path)], { stdio: "ignore" });
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", resolve(path)], { stdio: "ignore" });
  } catch {
    throw new Error("Standalone native compiler could not apply and verify its deterministic ad-hoc code signature.");
  }
  return {
    adHocCodeSigned: true,
    developerIdCodeSigned: false,
    hardenedRuntime: false,
    secureTimestamp: false,
  };
}

const KEYRING_PACKAGE_BY_TARGET: Record<StandaloneNativeTarget, string> = {
  "bun-darwin-arm64": "@napi-rs/keyring-darwin-arm64",
  "bun-darwin-x64": "@napi-rs/keyring-darwin-x64",
};

export function nativeKeyringPackageForTarget(target: string): string {
  if (!(STANDALONE_NATIVE_TARGETS as readonly string[]).includes(target)) {
    throw new Error(`Standalone native compiler rejects unsupported target ${target}.`);
  }
  return KEYRING_PACKAGE_BY_TARGET[target as StandaloneNativeTarget];
}

function requireValue(argv: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined && inline.length > prefix.length) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.trim() === "") {
    throw new Error(`Standalone native compiler requires --${name}.`);
  }
  return value;
}

function optionalValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length) || undefined;
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function compileStandaloneNativeExecutable(input: {
  entrypoint: string;
  outfile: string;
  target: string;
  metafile?: string;
  configurationReceipt?: string;
}): Promise<StandaloneCompilerConfigurationReceiptV1> {
  const target = input.target;
  const packageName = nativeKeyringPackageForTarget(target);
  let nativeBindingPath: string;
  try {
    nativeBindingPath = require.resolve(packageName);
  } catch {
    throw new Error(`Standalone native compiler is missing the exact ${packageName} binding for ${target}.`);
  }
  const bindingDetails = lstatSync(nativeBindingPath);
  if (bindingDetails.isSymbolicLink() || !bindingDetails.isFile() || !nativeBindingPath.endsWith(".node")) {
    throw new Error(`Standalone native compiler rejected an unsafe ${packageName} binding.`);
  }

  const genericPackage = JSON.parse(
    readFileSync(require.resolve("@napi-rs/keyring/package.json"), "utf8"),
  ) as { version?: unknown };
  const nativePackage = JSON.parse(
    readFileSync(require.resolve(`${packageName}/package.json`), "utf8"),
  ) as { version?: unknown };
  if (
    typeof genericPackage.version !== "string" ||
    genericPackage.version !== nativePackage.version
  ) {
    throw new Error(`Standalone native compiler found a ${packageName} version mismatch.`);
  }

  const compilerBindingPath = nativeBindingPath;

  let result: Awaited<ReturnType<typeof Bun.build>>;
  let embeddedNativeBindingSha256: string;
  try {
    result = await Bun.build({
      entrypoints: [resolve(input.entrypoint)],
      target: "bun",
      compile: {
        target: target as StandaloneNativeTarget,
        outfile: resolve(input.outfile),
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
      plugins: [{
        name: "nautilo-exact-native-keyring",
        setup(build) {
          build.onResolve({ filter: /^@napi-rs\/keyring$/ }, () => ({ path: compilerBindingPath }));
        },
      }],
      metafile: input.metafile !== undefined,
    });
    embeddedNativeBindingSha256 = sha256(compilerBindingPath);
  } catch (error) {
    const details = error instanceof AggregateError
      ? error.errors.map((item) => String(item)).join("\n").trim()
      : error instanceof Error
        ? error.message
        : "unknown compiler error";
    throw new Error(`Standalone native compiler failed before producing an executable: ${details}`);
  }
  if (!result.success) {
    const diagnostics = result.logs.map((log) => log.message).join("\n").trim();
    throw new Error(
      diagnostics === ""
        ? "Standalone native compiler failed to build the executable."
        : `Standalone native compiler failed to build the executable:\n${diagnostics}`,
    );
  }
  const output = result.outputs.find((artifact) => resolve(artifact.path) === resolve(input.outfile));
  if (output === undefined) {
    throw new Error("Standalone native compiler did not produce the requested executable.");
  }
  const codeSigning = signStandaloneNativeExecutable(input.outfile);
  if (input.metafile !== undefined) {
    if (result.metafile === undefined) {
      throw new Error("Standalone native compiler did not produce the requested metafile.");
    }
    const compilerInput = relative(process.cwd(), nativeBindingPath).replaceAll("\\", "/");
    const stagedInput = Object.keys(result.metafile.inputs).find((path) =>
      resolve(process.cwd(), path) === resolve(compilerBindingPath));
    if (stagedInput === undefined) {
      throw new Error("Standalone native compiler metafile omitted the embedded Keychain binding.");
    }
    if (stagedInput !== compilerInput && Object.hasOwn(result.metafile.inputs, compilerInput)) {
      throw new Error("Standalone native compiler metafile contains a conflicting Keychain binding input.");
    }
    const inputs = { ...result.metafile.inputs };
    const bindingMetadata = inputs[stagedInput]!;
    delete inputs[stagedInput];
    inputs[compilerInput] = bindingMetadata;
    writeFileSync(resolve(input.metafile), `${JSON.stringify({ ...result.metafile, inputs })}\n`, { mode: 0o600 });
  }
  const embeddedNativeBindingInput = relative(process.cwd(), nativeBindingPath).replaceAll("\\", "/");
  const configurationReceipt: StandaloneCompilerConfigurationReceiptV1 = {
    schemaVersion: 1,
    target: target as StandaloneNativeTarget,
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
    exactNativeKeyringRedirect: true,
    embeddedNativeDeveloperIdCodeSigned: false,
    embeddedNativeBindingInput,
    embeddedNativeBindingSha256,
    ...codeSigning,
  };
  if (input.configurationReceipt !== undefined) {
    writeFileSync(resolve(input.configurationReceipt), `${JSON.stringify(configurationReceipt)}\n`, { mode: 0o600 });
  }
  return configurationReceipt;
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const metafile = optionalValue(argv, "metafile");
    const configurationReceipt = optionalValue(argv, "configuration-receipt");
    await compileStandaloneNativeExecutable({
      entrypoint: requireValue(argv, "entrypoint"),
      outfile: requireValue(argv, "outfile"),
      target: requireValue(argv, "target"),
      ...(metafile === undefined ? {} : { metafile }),
      ...(configurationReceipt === undefined ? {} : { configurationReceipt }),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Standalone native compiler failed."}\n`);
    process.exitCode = 2;
  }
}
