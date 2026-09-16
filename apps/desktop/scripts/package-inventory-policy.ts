const ALLOWED_ARCHIVE_ROOTS = new Set([
  "assets",
  "dist",
  "node_modules",
  "package.json",
]);

const REQUIRED_ARCHIVE_PATHS = new Set([
  "dist/main.js",
  "package.json",
]);

const PRIVATE_PATH_SEGMENTS = new Set([
  ".agents",
  ".cursor",
  ".git",
  ".github",
  "nautilo-docs",
]);

const TEST_DIRECTORY_SEGMENTS = new Set([
  "__mocks__",
  "__tests__",
  "test",
  "tests",
]);

const PRIVATE_FILE_EXTENSIONS = [
  ".key",
  ".mobileprovision",
  ".p12",
  ".pem",
  ".pfx",
];

export type PackageInventoryViolation = {
  path: string;
  reason: string;
};

export type PackageInventoryReport = {
  entries: string[];
  rootCounts: Map<string, number>;
  violations: PackageInventoryViolation[];
};

function normalizeArchivePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/$/, "");
}

function violationReason(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  const segments = lowerPath.split("/");
  const root = segments[0] ?? "";
  const basename = segments.at(-1) ?? "";

  if (!ALLOWED_ARCHIVE_ROOTS.has(root)) {
    return `unapproved archive root '${root}'`;
  }
  if (lowerPath.endsWith(".map")) {
    return "production source map";
  }
  if (segments.some((segment) => PRIVATE_PATH_SEGMENTS.has(segment))) {
    return "private repository path";
  }
  if (basename === ".env" || basename.startsWith(".env.")) {
    return "environment file";
  }
  if (PRIVATE_FILE_EXTENSIONS.some((extension) => basename.endsWith(extension))) {
    return "private key or signing material";
  }
  if (segments.some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment))) {
    return "test directory";
  }
  if (/\.(?:test|spec)\.(?:c|m)?(?:js|ts)x?$/.test(basename)) {
    return "test file";
  }
  return undefined;
}

export function inspectPackageInventory(rawEntries: Iterable<string>): PackageInventoryReport {
  const entries = [...new Set([...rawEntries].map(normalizeArchivePath).filter(Boolean))].sort();
  const rootCounts = new Map<string, number>();
  const violations: PackageInventoryViolation[] = [];

  for (const path of entries) {
    const root = path.split("/", 1)[0] ?? "";
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
    const reason = violationReason(path);
    if (reason !== undefined) {
      violations.push({ path, reason });
    }
  }

  const available = new Set(entries);
  for (const requiredPath of REQUIRED_ARCHIVE_PATHS) {
    if (!available.has(requiredPath)) {
      violations.push({
        path: requiredPath,
        reason: "required runtime file is missing",
      });
    }
  }

  return { entries, rootCounts, violations };
}
