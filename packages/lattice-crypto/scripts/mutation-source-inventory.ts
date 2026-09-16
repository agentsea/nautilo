import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const MUTATION_ENTRYPOINTS = [
  "src/index.ts",
  "src/wire.ts",
  "src/group/v2-dummy.ts",
] as const;

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function localModuleSpecifiers(path: string): readonly string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(
      node.moduleSpecifier,
    )) {
      const clause = node.importClause;
      const hasRuntimeImport = clause === undefined
        || (
          !clause.isTypeOnly
          && (
            clause.name !== undefined
            || clause.namedBindings === undefined
            || ts.isNamespaceImport(clause.namedBindings)
            || clause.namedBindings.elements.some((item) => !item.isTypeOnly)
          )
        );
      if (hasRuntimeImport) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const hasRuntimeExport = !node.isTypeOnly
        && (
          node.exportClause === undefined
          || ts.isNamespaceExport(node.exportClause)
          || node.exportClause.elements.some((item) => !item.isTypeOnly)
        );
      if (hasRuntimeExport) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile(path));
  return specifiers.filter((specifier) => specifier.startsWith("."));
}

function resolveTypeScriptModule(
  importer: string,
  specifier: string,
): string | null {
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = extname(unresolved) === ""
    ? [`${unresolved}.ts`, resolve(unresolved, "index.ts")]
    : [unresolved];
  return candidates.find((candidate) =>
    candidate.endsWith(".ts") && existsSync(candidate)
  ) ?? null;
}

function hasRuntimeImplementation(path: string): boolean {
  return sourceFile(path).statements.some((statement) =>
    !ts.isImportDeclaration(statement)
    && !ts.isExportDeclaration(statement)
    && !ts.isInterfaceDeclaration(statement)
    && !ts.isTypeAliasDeclaration(statement)
    && !ts.isModuleDeclaration(statement)
    && !ts.isEmptyStatement(statement)
  );
}

/**
 * Derives the mutation boundary from supported runtime reachability.
 * The dummy provider is an explicit third root because it is required
 * scenario evidence while intentionally absent from the public package API.
 */
export function deriveMutationSourceInventory(
  packageRoot: string,
): readonly string[] {
  const sourceRoot = resolve(packageRoot, "src");
  const pending = MUTATION_ENTRYPOINTS.map((entry) =>
    resolve(packageRoot, entry)
  );
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    if (!existsSync(path)) {
      throw new Error(
        `mutation source inventory entry does not exist: ${
          relative(packageRoot, path)
        }`,
      );
    }
    visited.add(path);
    for (const specifier of localModuleSpecifiers(path)) {
      const dependency = resolveTypeScriptModule(path, specifier);
      if (
        dependency !== null
        && (dependency === sourceRoot || dependency.startsWith(`${sourceRoot}${sep}`))
      ) {
        pending.push(dependency);
      }
    }
  }
  return [...visited]
    .filter(hasRuntimeImplementation)
    .map((path) => relative(packageRoot, path).split(sep).join("/"))
    .sort();
}

/**
 * Lists every package-owned TypeScript source, including type-only modules.
 * This broader inventory governs source-level mutation suppression so a
 * directive cannot be hidden outside today's runtime-reachable graph.
 */
export function derivePackageTypeScriptSourceInventory(
  packageRoot: string,
): readonly string[] {
  const sourceRoot = resolve(packageRoot, "src");
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (
      const entry of readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
    ) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        paths.push(relative(packageRoot, path).split(sep).join("/"));
      }
    }
  };
  visit(sourceRoot);
  return paths;
}
