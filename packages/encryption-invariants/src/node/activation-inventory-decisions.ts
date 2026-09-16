import { extname } from "node:path";

export type ActivationReferenceExclusion = {
  readonly path: string;
  readonly token: string;
  /** Exact trimmed source line; stable across unrelated line movement. */
  readonly signature: string;
  /** One-based occurrence among identical path/token/signature matches. */
  readonly occurrence: number;
  readonly reason: string;
};

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".env",
  ".example",
  ".js",
  ".json",
  ".mjs",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const EXTENSIONLESS_DEPLOYMENT_NAMES = [
  "Caddyfile",
  "Containerfile",
  "Dockerfile",
  "Procfile",
] as const;

export function isActivationSourceFileName(fileName: string): boolean {
  if (fileName === ".env" || fileName.startsWith(".env.")) return true;
  if (EXTENSIONLESS_DEPLOYMENT_NAMES.some((name) =>
    fileName === name || fileName.startsWith(`${name}.`)
  )) {
    return true;
  }
  return SOURCE_EXTENSIONS.has(extname(fileName));
}

export function activationExclusionLocator(
  exclusion: Pick<
    ActivationReferenceExclusion,
    "path" | "token" | "signature" | "occurrence"
  >,
): string {
  return [
    exclusion.path,
    exclusion.token,
    exclusion.signature,
    exclusion.occurrence,
  ].join("#");
}

export function validateActivationExclusionShape(
  exclusion: ActivationReferenceExclusion,
): readonly string[] {
  const locator = activationExclusionLocator(exclusion);
  const errors: string[] = [];
  if (exclusion.reason.trim().length < 12) {
    errors.push(
      `activation exclusion ${exclusion.path}#${exclusion.token} has no descriptive reason`,
    );
  }
  if (
    exclusion.signature.length === 0
    || exclusion.signature !== exclusion.signature.trim()
  ) {
    errors.push(`activation exclusion ${locator} has a non-canonical signature`);
  }
  if (!Number.isInteger(exclusion.occurrence) || exclusion.occurrence < 1) {
    errors.push(`activation exclusion ${locator} has an invalid occurrence`);
  }
  return errors;
}
