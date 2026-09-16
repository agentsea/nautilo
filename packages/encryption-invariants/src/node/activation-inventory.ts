import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  activationExclusionLocator,
  isActivationSourceFileName,
  type ActivationReferenceExclusion,
  validateActivationExclusionShape,
} from "./activation-inventory-decisions";

export type { ActivationReferenceExclusion } from "./activation-inventory-decisions";

export type EncryptionActivationReference = {
  readonly path: string;
  readonly line: number;
  readonly token: string;
};

export const ACTIVATION_REFERENCE_EXCLUSIONS:
readonly ActivationReferenceExclusion[] = [
  {
    path: "apps/workbench/src/app.tsx",
    token: "/admin/sections/encryption-transition-card",
    signature: '"./pages/admin/sections/encryption-transition-card";',
    occurrence: 1,
    reason:
      "This imports the existing owner-controlled encryption status and policy card; rendering an administrative UI cannot activate encryption.",
  },
  {
    path: "apps/workbench/src/app.tsx",
    token: "/admin/encryption",
    signature: 'path="/admin/encryption"',
    occurrence: 1,
    reason:
      "This declares the authenticated administrative route that renders the existing manual transition card; it cannot change the durable policy by itself.",
  },
  {
    path: "packaging/docker/runtime-install/packages/encryption-invariants/package.json",
    token: "@nautilo/encryption-invariants",
    signature: '"name": "@nautilo/encryption-invariants",',
    occurrence: 1,
    reason:
      "This is the copied runtime package manifest name used by deterministic container packaging, not an encryption activation mechanism.",
  },
  {
    path: "packaging/docker/runtime-install/packages/server/package.json",
    token: "@nautilo/encryption-invariants",
    signature: '"@nautilo/encryption-invariants": "workspace:*",',
    occurrence: 1,
    reason:
      "This copied runtime dependency lets the server read the static readiness registry; package linkage cannot change transition policy.",
  },
  {
    path: "packaging/docker/runtime-install/projection.json",
    token: "@nautilo/encryption-invariants",
    signature: '"name": "@nautilo/encryption-invariants",',
    occurrence: 1,
    reason:
      "This deterministic packaging projection includes the static invariant library in the server image and has no runtime activation side effect.",
  },
  {
    path: "apps/workbench/src/components/crypto-device-admission-gate.tsx",
    token: "/admin/sections/encryption-transition-card",
    signature: '"../pages/admin/sections/encryption-transition-card";',
    occurrence: 1,
    reason:
      "This imports the existing owner-controlled encryption policy card for the deliberately narrow rollback page; importing UI cannot activate encryption.",
  },
  {
    path: "apps/workbench/src/components/crypto-device-admission-gate.tsx",
    token: "/admin/encryption",
    signature: 'const minimalAdmin = location.pathname === "/admin/encryption";',
    occurrence: 1,
    reason:
      "This exact route comparison selects the minimal owner rollback surface while device admission blocks product providers; it cannot change policy.",
  },
  {
    path: "apps/workbench/src/components/crypto-device-admission-gate.tsx",
    token: "/admin/encryption",
    signature: '<a href="/admin/encryption" className="inline-flex rounded-md border border-border px-3 py-2 text-sm">',
    occurrence: 1,
    reason:
      "This owner-only link opens the existing manual encryption policy page from the fail-closed admission gate; following a link cannot activate encryption.",
  },
  {
    path: "packages/types/src/device-admission-routes.ts",
    token: "/admin/encryption-transition",
    signature: '["GET /api/admin/encryption-transition", "encryption_rollback"],',
    occurrence: 1,
    reason:
      "This canonical content-free pre-admission route map permits authenticated policy observation for emergency rollback; it cannot activate encryption.",
  },
  {
    path: "packages/types/src/device-admission-routes.ts",
    token: "/admin/encryption-transition",
    signature: '["POST /api/admin/encryption-transition", "encryption_rollback"],',
    occurrence: 1,
    reason:
      "This canonical content-free pre-admission route map permits the capability-gated rollback mutation; it does not decide or broaden policy.",
  },
  {
    path: "packages/api-client/src/client.ts",
    token: "/admin/encryption-transition",
    signature: 'path: "/api/admin/encryption-transition",',
    occurrence: 1,
    reason:
      "This is the authenticated, capability-gated manual transition control API, not an automatic product-encryption activation path.",
  },
  {
    path: "packages/api-client/src/client.ts",
    token: "/admin/encryption-transition",
    signature: 'path: "/api/admin/encryption-transition",',
    occurrence: 2,
    reason:
      "This is the authenticated, capability-gated manual transition control API, not an automatic product-encryption activation path.",
  },
  {
    path: "packages/api-client/src/client.ts",
    token: "/admin/encryption-transition",
    signature: 'defaultErrorPrefix: "GET /api/admin/encryption-transition",',
    occurrence: 1,
    reason:
      "This diagnostic label names the authenticated manual transition endpoint; it cannot activate encryption.",
  },
  {
    path: "packages/api-client/src/client.ts",
    token: "/admin/encryption-transition",
    signature: 'defaultErrorPrefix: "POST /api/admin/encryption-transition",',
    occurrence: 1,
    reason:
      "This diagnostic label names the authenticated manual transition endpoint; it cannot activate encryption.",
  },
  {
    path: "packages/server/src/routes/encryption-transition.ts",
    token: "/admin/encryption-transition",
    signature:
      'app.get("/api/admin/encryption-transition", async (request, reply) => {',
    occurrence: 1,
    reason:
      "This read-only, capability-gated dashboard route observes the explicit manual transition control plane and cannot activate it.",
  },
  {
    path: "packages/server/src/routes/encryption-transition.ts",
    token: "/admin/encryption-transition",
    signature:
      'app.post("/api/admin/encryption-transition", async (request, reply) => {',
    occurrence: 1,
    reason:
      "This capability-gated administrative route is the deliberately manual transition control plane, not an automatic activation path.",
  },
  {
    path: "packages/server/package.json",
    token: "@nautilo/encryption-invariants",
    signature: '"@nautilo/encryption-invariants": "workspace:*",',
    occurrence: 1,
    reason:
      "M302 reads the static reviewed boundary registry to project manual Strict Shadow readiness and health; importing the inventory cannot change transition policy or activate encryption.",
  },
  {
    path: "packages/server/src/lib/strict-shadow-policy.ts",
    token: "@nautilo/encryption-invariants",
    signature: '"@nautilo/encryption-invariants/node";',
    occurrence: 1,
    reason:
      "M302 validates an explicitly requested Strict Shadow boundary against the static reviewed registry; the import has no activation side effect and policy remains the durable owner-controlled singleton.",
  },
  {
    path: "packages/server/src/routes/encryption-transition.ts",
    token: "@nautilo/encryption-invariants",
    signature: '} from "@nautilo/encryption-invariants/node";',
    occurrence: 1,
    reason:
      "M302 projects content-free readiness and runtime-health counts from the static registry for authenticated UI; the route still changes policy only through the existing capability-gated POST CAS.",
  },
  {
    path: "packages/vault/src/builtin-vault-backend.ts",
    token: "encryption_mode",
    signature: "const mode = this._disk.config.encryption_mode;",
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/builtin-vault-backend.ts",
    token: "encryption_mode",
    signature: 'if (this._disk.config.encryption_mode === "none") {',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/builtin-vault-backend.ts",
    token: "encryption_mode",
    signature: 'if (this._disk.config.encryption_mode !== "none") {',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/builtin-vault-backend.ts",
    token: "encryption_mode",
    signature: 'config: { encryption_mode: "aes_256_gcm" },',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/builtin-vault-backend.ts",
    token: "encryption_mode",
    signature: 'if (this._disk.config.encryption_mode === "aes_256_gcm") {',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/builtin-vault-backend.ts",
    token: "encryption_mode",
    signature: 'if (this._disk.config.encryption_mode === "aes_256_gcm") {',
    occurrence: 2,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/builtin-vault-backend.ts",
    token: "encryption_mode",
    signature: 'if (this._disk.config.encryption_mode !== "aes_256_gcm") {',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/disk-types.ts",
    token: "encryption_mode",
    signature: "readonly config: { readonly encryption_mode: DiskEncryptionMode };",
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/disk-validate.ts",
    token: "encryption_mode",
    signature: "envelope.config.encryption_mode === undefined",
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/disk-validate.ts",
    token: "encryption_mode",
    signature: 'envelope.config.encryption_mode === "none" ||',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/disk-validate.ts",
    token: "encryption_mode",
    signature: 'envelope.config.encryption_mode === "aes_256_gcm";',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/disk-validate.ts",
    token: "encryption_mode",
    signature: 'throw new VaultSchemaError("unknown encryption_mode");',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/disk-validate.ts",
    token: "encryption_mode",
    signature: 'if (env.config.encryption_mode === "aes_256_gcm") {',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
  {
    path: "packages/vault/src/disk-validate.ts",
    token: "encryption_mode",
    signature: 'config: { encryption_mode: "none" },',
    occurrence: 1,
    reason: "Vault-local storage format metadata is not product E2EE activation.",
  },
] as const;

export async function inspectActivationReferenceExclusions(
  repositoryRoot: string,
  exclusions: readonly ActivationReferenceExclusion[] =
    ACTIVATION_REFERENCE_EXCLUSIONS,
): Promise<{ readonly count: number; readonly errors: readonly string[] }> {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const exclusion of exclusions) {
    const locator = activationExclusionLocator(exclusion);
    if (seen.has(locator)) {
      errors.push(`duplicate activation exclusion ${locator}`);
    }
    seen.add(locator);
    errors.push(...validateActivationExclusionShape(exclusion));
    const source = await readFile(join(repositoryRoot, exclusion.path), "utf8")
      .catch(() => null);
    if (source === null) {
      errors.push(`missing activation exclusion path ${exclusion.path}`);
      continue;
    }
    const occurrences = source.split(/\r?\n/).reduce(
      (count, line) =>
        line.trim() === exclusion.signature
          ? count + literalOccurrences(line, exclusion.token)
          : count,
      0,
    );
    if (occurrences < exclusion.occurrence) {
      errors.push(`stale activation exclusion ${locator}`);
    }
  }
  return {
    count: exclusions.length,
    errors: errors.sort(),
  };
}

function literalOccurrences(value: string, token: string): number {
  if (token.length === 0) return 0;
  return value.split(token).length - 1;
}

export type ActivationLifecycleRole =
  | "config"
  | "deploy"
  | "start"
  | "restart"
  | "upgrade";

export type ActivationLifecycleDeclaration = {
  readonly path: string;
  readonly role: ActivationLifecycleRole;
  readonly symbols: readonly string[];
};

export const ACTIVATION_LIFECYCLE_DECLARATIONS:
readonly ActivationLifecycleDeclaration[] = [
  {
    path: "packages/config/src/config.ts",
    role: "config",
    symbols: ["NautiloConfigSchema", "fromRuntimeConfig"],
  },
  {
    path: "infra/compose/nautilo.yml",
    role: "deploy",
    symbols: ["services:", "NAUTILO_DB_PASSWORD"],
  },
  {
    path: "deploy/compose-driver/src/buildComposeEnv.ts",
    role: "deploy",
    symbols: ["buildComposeEnv", "NAUTILO_SERVER_TAG"],
  },
  {
    path: "deploy/compose-driver/src/buildServerOverlayEnv.ts",
    role: "deploy",
    symbols: ["buildServerOverlayEnv"],
  },
  {
    path: "bin/nautilo-dev/src/commands/infra-start.ts",
    role: "start",
    symbols: ["infraStart"],
  },
  {
    path: "bin/nautilo-dev/src/commands/server-start.ts",
    role: "start",
    symbols: ["serverDaemonEnv", "serverStart"],
  },
  {
    path: "bin/nautilo-server/src/index.ts",
    role: "start",
    symbols: ["async function start()", "ensurePostureSidecar"],
  },
  {
    path: "bin/nautilo-dev/src/commands/server-restart.ts",
    role: "restart",
    symbols: ["serverRestart", "serverStop", "serverStart"],
  },
  {
    path: "bin/nautilo-dev/src/commands/upgrade.ts",
    role: "upgrade",
    symbols: ["runUpgrade", "upgrade"],
  },
  {
    path: "deploy/compose-driver/src/ComposeDriver.ts",
    role: "upgrade",
    symbols: ["resolveUpgradeStrategy", "class ComposeDriver"],
  },
  {
    path: "apps/cli/src/lib/compose-driver-factory.ts",
    role: "upgrade",
    symbols: ["createDriverForCli", "buildMaintenanceDrain"],
  },
] as const;

export async function inspectActivationLifecycleDeclarations(
  repositoryRoot: string,
  declarations: readonly ActivationLifecycleDeclaration[] =
    ACTIVATION_LIFECYCLE_DECLARATIONS,
): Promise<{
  readonly observations: readonly ActivationLifecycleDeclaration[];
  readonly errors: readonly string[];
}> {
  const errors: string[] = [];
  for (const declaration of declarations) {
    if (
      declaration.path.startsWith("/")
      || declaration.path.includes("\\")
      || declaration.path.split("/").some((segment) =>
        segment.length === 0 || segment === "." || segment === ".."
      )
    ) {
      errors.push(`invalid activation lifecycle path ${declaration.path}`);
      continue;
    }
    const source = await readFile(
      join(repositoryRoot, declaration.path),
      "utf8",
    ).catch(() => null);
    if (source === null) {
      errors.push(`missing activation lifecycle path ${declaration.path}`);
      continue;
    }
    for (const symbol of declaration.symbols) {
      if (!source.includes(symbol)) {
        errors.push(
          `activation lifecycle ${declaration.path} is missing symbol ${symbol}`,
        );
      }
    }
  }
  return {
    observations: [...declarations].sort((left, right) =>
      `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`)
    ),
    errors: errors.sort(),
  };
}

const EXCLUDED_SEGMENTS = new Set([
  ".git",
  ".turbo",
  "dist",
  "generated",
  "node_modules",
  "release",
  "reports",
  "tests",
  "vendor",
]);

const ACTIVATION_PATTERNS: readonly RegExp[] = [
  /@nautilo\/encryption-invariants\b/g,
  /\bNAUTILO_(?:E2EE|ENCRYPTION|CRYPTO)\b/g,
  /\b(?:NAUTILO_)?(?:E2EE|ENCRYPTION|CRYPTO)_(?:MODE|STAGE|ENABLED)\b/g,
  /\b(?:encryption|crypto)(?:Activation|Stage|Mode|Enabled|_activation|_stage|_mode|_enabled)\b/g,
  /\bconfig\.encryption\.(?:stage|mode|enabled)\b/g,
  /\/admin\/[A-Za-z0-9_/-]*(?:encryption|crypto)[A-Za-z0-9_/-]*\b/g,
  /\b(?:shadow_writing|live_migration|ciphertext_reads|ciphertext_only_finalized)\b/g,
];

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function shouldExclude(path: string): boolean {
  const parts = toPosix(path).split("/");
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return true;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return true;
  return path.startsWith("packages/encryption-invariants/");
}

async function sourceFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const repositoryRelative = toPosix(relative(root, absolute));
    if (shouldExclude(repositoryRelative)) continue;
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(root, absolute));
      continue;
    }
    if (entry.isFile() && isActivationSourceFileName(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

export async function findEncryptionActivationReferences(
  repositoryRoot: string,
  exclusions: readonly ActivationReferenceExclusion[] =
    ACTIVATION_REFERENCE_EXCLUSIONS,
): Promise<readonly EncryptionActivationReference[]> {
  const references: EncryptionActivationReference[] = [];
  const seenOccurrences = new Map<string, number>();
  const excludedLocators = new Set(exclusions.map(activationExclusionLocator));
  for (const absolute of (await sourceFiles(repositoryRoot)).sort()) {
    const path = toPosix(relative(repositoryRoot, absolute));
    const lines = (await readFile(absolute, "utf8")).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const signature = line.trim();
      for (const pattern of ACTIVATION_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of line.matchAll(pattern)) {
          const occurrenceKey = [path, match[0], signature].join("#");
          const occurrence = (seenOccurrences.get(occurrenceKey) ?? 0) + 1;
          seenOccurrences.set(occurrenceKey, occurrence);
          if (excludedLocators.has([
            path,
            match[0],
            signature,
            occurrence,
          ].join("#"))) {
            continue;
          }
          references.push({
            path,
            line: index + 1,
            token: match[0],
          });
        }
      }
    }
  }
  return references.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    return left.token < right.token ? -1 : left.token > right.token ? 1 : 0;
  });
}
