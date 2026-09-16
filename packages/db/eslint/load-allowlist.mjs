// @ts-check
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repository root (`nautilo/`), resolved from `packages/db/eslint/`. */
export const REPO_ROOT = join(__dirname, "../../..");

const ALLOWLIST_PATH = join(__dirname, "m212-pool-construction-allowlist.json");

/** @typedef {{ path: string, reason: string }} AllowlistEntry */
/** @typedef {{ issue: string, phase: number, description: string, entries: AllowlistEntry[] }} AllowlistDocument */

/** Paths under these prefixes must never appear in the allowlist. */
export const FORBIDDEN_ALLOWLIST_PREFIXES = [
  "packages/trust/src/",
  "packages/server/src/",
  "packages/runtime/src/",
];

/**
 * @param {string} path
 * @returns {string}
 */
export function normalizeRepoRelativePath(path) {
  return normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * @param {string} [jsonPath]
 * @returns {AllowlistDocument}
 */
export function loadAllowlistDocument(jsonPath = ALLOWLIST_PATH) {
  /** @type {AllowlistDocument} */
  const doc = JSON.parse(readFileSync(jsonPath, "utf8"));
  return doc;
}

/**
 * @param {AllowlistDocument} doc
 * @returns {ReadonlySet<string>}
 */
export function buildAllowlistSet(doc) {
  return new Set(doc.entries.map((entry) => normalizeRepoRelativePath(entry.path)));
}

/**
 * Resolve an ESLint `context.filename` (absolute or cwd-relative) to a
 * repo-relative POSIX path for allowlist lookup.
 *
 * @param {string} filename
 * @param {string} [cwd]
 * @returns {string}
 */
export function filenameToRepoRelative(filename, cwd = process.cwd()) {
  const absolute = resolve(cwd, filename);
  return normalizeRepoRelativePath(relative(REPO_ROOT, absolute));
}

/**
 * @param {string} repoRelativePath
 * @returns {boolean}
 */
export function isForbiddenRuntimeRequestPath(repoRelativePath) {
  const normalized = normalizeRepoRelativePath(repoRelativePath);
  return FORBIDDEN_ALLOWLIST_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Structural validation shared by the ESLint rule boot and repo invariant.
 *
 * @param {AllowlistDocument} doc
 * @param {{ checkPathsExist?: boolean }} [opts]
 * @returns {string[]}
 */
export function validateAllowlistDocument(doc, opts = {}) {
  const { checkPathsExist = false } = opts;
  const errors = [];

  if (!doc || typeof doc !== "object") {
    return ["allowlist document is missing or not an object"];
  }
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    errors.push("allowlist entries must be a non-empty array");
    return errors;
  }

  const seen = new Set();
  for (const entry of doc.entries) {
    if (!entry || typeof entry !== "object") {
      errors.push("allowlist entry is not an object");
      continue;
    }
    const path = typeof entry.path === "string" ? normalizeRepoRelativePath(entry.path) : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";

    if (!path) {
      errors.push("allowlist entry is missing a non-empty path");
      continue;
    }
    if (!reason) {
      errors.push(`allowlist entry ${path} is missing a non-empty reason`);
    }
    if (seen.has(path)) {
      errors.push(`duplicate allowlist path: ${path}`);
    }
    seen.add(path);

    if (isForbiddenRuntimeRequestPath(path)) {
      errors.push(
        `allowlist must not include runtime request path ${path} (packages/{trust,server,runtime}/src/**)`,
      );
    }

    if (checkPathsExist) {
      const abs = join(REPO_ROOT, path);
      if (!existsSync(abs)) {
        errors.push(`allowlist path does not exist on disk: ${path}`);
      }
    }
  }

  return errors;
}

/**
 * @returns {{ doc: AllowlistDocument, allowlist: ReadonlySet<string> }}
 */
export function loadValidatedAllowlist() {
  const doc = loadAllowlistDocument();
  const errors = validateAllowlistDocument(doc, { checkPathsExist: true });
  if (errors.length > 0) {
    throw new Error(
      `[m212-no-adhoc-pool-construction] Invalid pool-construction allowlist:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  return { doc, allowlist: buildAllowlistSet(doc) };
}
