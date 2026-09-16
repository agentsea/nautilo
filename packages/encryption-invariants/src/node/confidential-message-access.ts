import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const CONFIDENTIAL_MESSAGE_COLUMNS = Object.freeze([
  "content",
  "toolCalls",
  "metadata",
  "contentSearch",
] as const);

export type ConfidentialMessageColumn =
  (typeof CONFIDENTIAL_MESSAGE_COLUMNS)[number];

export type ConfidentialMessageColumnReference = Readonly<{
  path: string;
  line: number;
  field: ConfidentialMessageColumn;
  signature: string;
}>;

const PRODUCTION_SOURCE_ROOTS = Object.freeze([
  "packages/agent/src",
  "packages/runtime/src",
  "packages/server/src",
  "packages/trust/src",
  "packages/db/src",
  "bin/nautilo-dev/src",
] as const);

const TYPESCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/u;
const DIRECT_ACCESS =
  /\bsessionMessages\.(content|toolCalls|metadata|contentSearch)\b/gu;

function portablePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function sourceFiles(path: string): Promise<string[]> {
  const metadata = await stat(path);
  if (metadata.isFile()) {
    return TYPESCRIPT_EXTENSION.test(path) ? [path] : [];
  }
  if (!metadata.isDirectory()) return [];

  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) =>
    sourceFiles(resolve(path, entry.name))
  ));
  return nested.flat();
}

function referencesInSource(
  path: string,
  source: string,
): ConfidentialMessageColumnReference[] {
  const references: ConfidentialMessageColumnReference[] = [];
  const lines = source.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    DIRECT_ACCESS.lastIndex = 0;
    for (const match of line.matchAll(DIRECT_ACCESS)) {
      references.push({
        path,
        line: lineIndex + 1,
        field: match[1] as ConfidentialMessageColumn,
        signature: line.trim(),
      });
    }
  }
  return references;
}

/**
 * Mechanical omission alarm for the four free-form `session_messages`
 * columns. The exact Wave-9 test budget must only shrink as callers move
 * behind the canonical conversation repository; a new direct member access
 * fails before it can become an unclassified protected path.
 */
export async function findConfidentialMessageColumnReferences(
  repositoryRoot: string,
  virtualSources?: Readonly<Record<string, string>>,
): Promise<ConfidentialMessageColumnReference[]> {
  const references: ConfidentialMessageColumnReference[] = [];
  if (virtualSources !== undefined) {
    for (const [path, source] of Object.entries(virtualSources)) {
      references.push(...referencesInSource(path, source));
    }
  } else {
    const roots = PRODUCTION_SOURCE_ROOTS.map((path) =>
      resolve(repositoryRoot, path)
    );
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    for (const file of files) {
      references.push(
        ...referencesInSource(
          portablePath(repositoryRoot, file),
          await readFile(file, "utf8"),
        ),
      );
    }
  }

  return references.sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.field.localeCompare(right.field)
  );
}
