import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type BuildMetafile = {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly outputs: Readonly<Record<string, unknown>>;
};

export type StandaloneDependencyComponent = {
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly workspace: boolean;
  readonly declaredLicense: string;
  readonly licenseEvidenceSha256: string;
};

export type StandaloneLicenseInventoryV1 = {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly platform: string;
  readonly archiveSha256: string;
  readonly compilerClosureSha256: string;
  readonly componentCount: number;
  readonly components: readonly StandaloneDependencyComponent[];
  readonly complete: true;
};

export type StandaloneCycloneDxV1 = {
  readonly bomFormat: "CycloneDX";
  readonly specVersion: "1.6";
  readonly version: 1;
  readonly metadata: {
    readonly component: {
      readonly type: "application";
      readonly name: "@nautilo/cli";
      readonly version: string;
    };
    readonly properties: readonly { readonly name: string; readonly value: string }[];
  };
  readonly components: readonly {
    readonly type: "library" | "application";
    readonly name: string;
    readonly version: string;
    readonly purl: string;
    readonly licenses: readonly [{ readonly license: { readonly expression: string } }];
    readonly properties: readonly { readonly name: string; readonly value: string }[];
  }[];
};

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function requireSource(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("Standalone dependency evidence requires an exact source commit.");
  return value;
}

function packagePurl(name: string, version: string): string {
  return `pkg:npm/${name.startsWith("@") ? name.replace("/", "%2F") : name}@${version}`;
}

function packageRootForInput(monorepoRoot: string, compilerWorkingDirectory: string, inputPath: string): string | undefined {
  const absolute = resolve(compilerWorkingDirectory, inputPath);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    throw new Error(`Standalone compiler metafile references a missing input: ${inputPath}.`);
  }
  const root = realpathSync(monorepoRoot);
  if (canonical !== root && !canonical.startsWith(`${root}/`)) {
    throw new Error("Standalone compiler metafile input escaped the monorepo.");
  }
  let current = dirname(canonical);
  while (current !== root && current.startsWith(`${root}/`)) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
      if (typeof value.name === "string" && typeof value.version === "string") return current;
    }
    current = dirname(current);
  }
  return undefined;
}

function compilerInputIdentity(monorepoRoot: string, compilerWorkingDirectory: string, inputPath: string, sha256Override?: string): {
  readonly path: string;
  readonly sha256: string;
} {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(compilerWorkingDirectory, inputPath));
  } catch {
    throw new Error(`Standalone compiler metafile references a missing input: ${inputPath}.`);
  }
  if (canonical !== monorepoRoot && !canonical.startsWith(`${monorepoRoot}/`)) {
    throw new Error("Standalone compiler metafile input escaped the monorepo.");
  }
  return {
    path: relative(monorepoRoot, canonical).replaceAll("\\", "/"),
    sha256: sha256Override === undefined
      ? sha256(readFileSync(canonical))
      : requireSha256(sha256Override, `compiler input override for ${inputPath}`),
  };
}

function referencedLicense(packageRoot: string, declared: string): string | undefined {
  const match = /^SEE LICENSE IN (.+)$/i.exec(declared.trim());
  if (match === null) return undefined;
  const path = resolve(packageRoot, match[1]!);
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Standalone dependency license reference is not a regular file: ${path}.`);
  }
  return path;
}

function componentForRoot(monorepoRoot: string, packageRoot: string): StandaloneDependencyComponent {
  const manifestPath = join(packageRoot, "package.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    name?: unknown;
    version?: unknown;
    license?: unknown;
  };
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new Error(`Standalone dependency package has no name: ${manifestPath}.`);
  }
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error(`Standalone dependency package has no version: ${manifestPath}.`);
  }
  const workspace = !relative(monorepoRoot, packageRoot).startsWith("node_modules/");
  const declaredLicense = typeof manifest.license === "string" && manifest.license.trim() !== ""
    ? manifest.license.trim()
    : workspace
      ? "MIT"
      : undefined;
  if (declaredLicense === undefined) {
    throw new Error(`Standalone external dependency has no declared license: ${manifest.name}@${manifest.version}.`);
  }
  const licensePath = referencedLicense(packageRoot, declaredLicense);
  const licenseEvidence = licensePath === undefined
    ? workspace
      ? readFileSync(join(monorepoRoot, "LICENSE"))
      : manifestBytes
    : readFileSync(licensePath);
  return {
    name: manifest.name,
    version: manifest.version,
    purl: packagePurl(manifest.name, manifest.version),
    workspace,
    declaredLicense: declaredLicense.startsWith("SEE LICENSE IN ") ? "MIT" : declaredLicense,
    licenseEvidenceSha256: sha256(licenseEvidence),
  };
}

export function createStandaloneDependencyEvidence(input: {
  metafileBytes: Buffer;
  monorepoRoot: string;
  compilerWorkingDirectory?: string;
  source: string;
  platform: string;
  version: string;
  archiveSha256: string;
  compilerInputSha256Overrides?: Readonly<Record<string, string>>;
}): { sbom: StandaloneCycloneDxV1; licenses: StandaloneLicenseInventoryV1 } {
  const monorepoRoot = realpathSync(input.monorepoRoot);
  const compilerWorkingDirectory = realpathSync(input.compilerWorkingDirectory ?? monorepoRoot);
  if (compilerWorkingDirectory !== monorepoRoot && !compilerWorkingDirectory.startsWith(`${monorepoRoot}/`)) {
    throw new Error("Standalone compiler working directory must be inside the monorepo.");
  }
  const source = requireSource(input.source);
  const archiveSha256 = requireSha256(input.archiveSha256, "archiveSha256");
  let metafile: BuildMetafile;
  try {
    metafile = JSON.parse(input.metafileBytes.toString("utf8")) as BuildMetafile;
  } catch {
    throw new Error("Standalone compiler metafile is not valid JSON.");
  }
  if (
    metafile === null || typeof metafile !== "object" || Array.isArray(metafile) ||
    metafile.inputs === null || typeof metafile.inputs !== "object" || Array.isArray(metafile.inputs) ||
    metafile.outputs === null || typeof metafile.outputs !== "object" || Array.isArray(metafile.outputs) ||
    Object.keys(metafile.inputs).length === 0 || Object.keys(metafile.outputs).length !== 1
  ) {
    throw new Error("Standalone compiler metafile has an invalid input/output shape.");
  }
  const components = new Map<string, StandaloneDependencyComponent>();
  const compilerInputs = new Map<string, string>();
  const overrides = new Map(Object.entries(input.compilerInputSha256Overrides ?? {}).map(([path, digest]) => [
    realpathSync(resolve(compilerWorkingDirectory, path)),
    requireSha256(digest, `compiler input override for ${path}`),
  ]));
  for (const inputPath of Object.keys(metafile.inputs)) {
    const canonicalInput = realpathSync(resolve(compilerWorkingDirectory, inputPath));
    const override = overrides.get(canonicalInput);
    if (override !== undefined) overrides.delete(canonicalInput);
    const inputIdentity = compilerInputIdentity(monorepoRoot, compilerWorkingDirectory, inputPath, override);
    const previousInputHash = compilerInputs.get(inputIdentity.path);
    if (previousInputHash !== undefined && previousInputHash !== inputIdentity.sha256) {
      throw new Error(`Standalone compiler input identity conflicts for ${inputIdentity.path}.`);
    }
    compilerInputs.set(inputIdentity.path, inputIdentity.sha256);
    const packageRoot = packageRootForInput(monorepoRoot, compilerWorkingDirectory, inputPath);
    if (packageRoot === undefined) continue;
    const component = componentForRoot(monorepoRoot, packageRoot);
    const identity = `${component.name}@${component.version}`;
    const previous = components.get(identity);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(component)) {
      throw new Error(`Standalone dependency metadata conflicts for ${identity}.`);
    }
    components.set(identity, component);
  }
  if (overrides.size !== 0) {
    throw new Error("Standalone compiler input hash override did not match the compiler metafile.");
  }
  const sorted = [...components.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  if (sorted.length === 0 || !sorted.some((component) => component.name === "@nautilo/cli")) {
    throw new Error("Standalone dependency evidence did not include the CLI application.");
  }
  const compilerClosureSha256 = sha256(Buffer.from(JSON.stringify(
    [...compilerInputs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, digest]) => ({ path, sha256: digest })),
  )));
  const properties = [
    { name: "ai.nautilo.source", value: source },
    { name: "ai.nautilo.platform", value: input.platform },
    { name: "ai.nautilo.archive.sha256", value: archiveSha256 },
    { name: "ai.nautilo.compiler-closure.sha256", value: compilerClosureSha256 },
  ] as const;
  return {
    sbom: {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: { type: "application", name: "@nautilo/cli", version: input.version },
        properties,
      },
      components: sorted.map((component) => ({
        type: component.name === "@nautilo/cli" ? "application" : "library",
        name: component.name,
        version: component.version,
        purl: component.purl,
        licenses: [{ license: { expression: component.declaredLicense } }],
        properties: [
          { name: "ai.nautilo.workspace", value: String(component.workspace) },
          { name: "ai.nautilo.license-evidence.sha256", value: component.licenseEvidenceSha256 },
        ],
      })),
    },
    licenses: {
      schemaVersion: 1,
      source,
      platform: input.platform,
      archiveSha256,
      compilerClosureSha256,
      componentCount: sorted.length,
      components: sorted,
      complete: true,
    },
  };
}
