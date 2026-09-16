import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

import { rawDatabaseWriterDebtId } from "../raw-database-writer-debt";
import { canonicalDatabaseWriterLocator } from "../registry";

export type DatabaseWriteOperation =
  | "insert"
  | "update"
  | "delete"
  | "unresolved";

export type DatabaseWriterObservation = {
  readonly operation: DatabaseWriteOperation;
  readonly table: string;
  readonly path: string;
  readonly symbol: string;
  readonly locator: string;
};

export type DatabaseWriterInventoryAudit = {
  readonly ok: boolean;
  readonly unknown: readonly string[];
  readonly stale: readonly string[];
  readonly errors: readonly string[];
};

export type RawDatabaseWriterDebtAudit = {
  readonly ok: boolean;
  readonly errors: readonly string[];
};

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".sh",
  ".ts",
  ".tsx",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".stryker-tmp",
  ".turbo",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tests",
]);
const WRITE_OPERATIONS = new Set<DatabaseWriteOperation>([
  "delete",
  "insert",
  "update",
]);
const DATABASE_RECEIVER_NAMES = new Set([
  "db",
  "handle",
  "sql",
  "tx",
]);
const DATABASE_TYPE_PATTERN =
  /(?:^|[^A-Za-z])(?:ClusterExec|Database|DbHandle|DirectDb|DirectDatabase|SqlClient|Transaction)(?:[^A-Za-z]|$)/u;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sourceExtension(path: string): string {
  const match = /[.][^.\\/]+$/u.exec(path);
  return match?.[0] ?? "";
}

function isIncludedSourcePath(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? path;
  return SOURCE_EXTENSIONS.has(sourceExtension(fileName))
    && !/[.](?:spec|test)[.][^.]+$/u.test(fileName);
}

async function sourceFiles(repositoryRoot: string): Promise<string[]> {
  const results: string[] = [];
  const pending = ["apps", "bin", "deploy", "infra", "packages"]
    .map((directory) => resolve(repositoryRoot, directory));

  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) pending.push(absolute);
        continue;
      }
      const path = relative(repositoryRoot, absolute).split(sep).join("/");
      if (entry.isFile() && isIncludedSourcePath(path)) results.push(path);
    }
  }
  return results.sort(compareText);
}

function isDatabaseSchemaModule(moduleName: string, path: string): boolean {
  if (moduleName === "@nautilo/db" || moduleName.startsWith("@nautilo/db/")) {
    return true;
  }
  return path.startsWith("packages/db/")
    && /^\.{1,2}\/(?:.*\/)?schema(?:\/|$)/u.test(moduleName);
}

function importedTableBindings(
  sourceFile: ts.SourceFile,
  path: string,
  tableExports: Readonly<Record<string, string>>,
): {
  bindings: Map<string, string>;
  namespaces: Set<string>;
} {
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && isDatabaseSchemaModule(statement.moduleSpecifier.text, path)
    ) {
      const clause = statement.importClause;
      const namedBindings = clause?.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        namespaces.add(namedBindings.name.text);
      } else if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          const locator = tableExports[importedName];
          if (locator) bindings.set(element.name.text, locator);
        }
      }
      continue;
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) {
        continue;
      }
      let initializer: ts.Expression = declaration.initializer;
      while (
        ts.isAwaitExpression(initializer)
        || ts.isParenthesizedExpression(initializer)
      ) {
        initializer = initializer.expression;
      }
      const moduleArgument = ts.isCallExpression(initializer)
        ? initializer.arguments.at(0)
        : undefined;
      if (
        !ts.isCallExpression(initializer)
        || initializer.expression.kind !== ts.SyntaxKind.ImportKeyword
        || initializer.arguments.length !== 1
        || !moduleArgument
        || !ts.isStringLiteral(moduleArgument)
        || !isDatabaseSchemaModule(moduleArgument.text, path)
      ) {
        continue;
      }
      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const importedName = element.propertyName
          ? element.propertyName.getText(sourceFile)
          : element.name.text;
        const locator = tableExports[importedName];
        if (locator) bindings.set(element.name.text, locator);
      }
    }
  }

  return { bindings, namespaces };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveTable(
  expression: ts.Expression,
  bindings: ReadonlyMap<string, string>,
  namespaces: ReadonlySet<string>,
  tableExports: Readonly<Record<string, string>>,
  aliases: ReadonlyMap<string, readonly ts.VariableDeclaration[]>,
  visited: ReadonlySet<ts.VariableDeclaration> = new Set(),
): string | undefined {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    const declaration = visibleAliasDeclaration(target, aliases.get(target.text) ?? []);
    if (declaration) {
      if (visited.has(declaration)) return undefined;
      return resolveTable(
        declaration.initializer!,
        bindings,
        namespaces,
        tableExports,
        aliases,
        new Set([...visited, declaration]),
      );
    }
    return bindings.get(target.text);
  }
  if (
    ts.isPropertyAccessExpression(target)
    && ts.isIdentifier(target.expression)
    && namespaces.has(target.expression.text)
  ) {
    return tableExports[target.name.text];
  }
  if (
    ts.isElementAccessExpression(target)
    && ts.isIdentifier(target.expression)
    && namespaces.has(target.expression.text)
    && target.argumentExpression
    && ts.isStringLiteral(target.argumentExpression)
  ) {
    return tableExports[target.argumentExpression.text];
  }
  return undefined;
}

function lexicalScope(node: ts.Node): ts.Node {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isBlock(current)
      || ts.isCaseBlock(current)
      || ts.isSourceFile(current)
    ) {
      return current;
    }
  }
  return node.getSourceFile();
}

function isAncestor(ancestor: ts.Node, node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function visibleAliasDeclaration(
  use: ts.Identifier,
  declarations: readonly ts.VariableDeclaration[],
): ts.VariableDeclaration | undefined {
  return declarations
    .filter((declaration) =>
      declaration.initializer !== undefined
      && declaration.getStart() < use.getStart()
      && isAncestor(lexicalScope(declaration), use)
    )
    .sort((left, right) => {
      const leftScope = lexicalScope(left);
      const rightScope = lexicalScope(right);
      const scopeSpecificity =
        (leftScope.end - leftScope.pos) - (rightScope.end - rightScope.pos);
      return scopeSpecificity || right.getStart() - left.getStart();
    })
    .at(0);
}

function collectAliasDeclarations(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, readonly ts.VariableDeclaration[]> {
  const aliases = new Map<string, ts.VariableDeclaration[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      const declarations = aliases.get(node.name.text) ?? [];
      declarations.push(node);
      aliases.set(node.name.text, declarations);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function namedNodeSymbol(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (
    (ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node))
    && node.name
  ) {
    return node.name.getText(sourceFile);
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isPropertyAssignment(node.parent)
  ) {
    return node.parent.name.getText(sourceFile);
  }
  return undefined;
}

function enclosingSymbol(node: ts.Node, sourceFile: ts.SourceFile): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const symbol = namedNodeSymbol(current, sourceFile);
    if (symbol) return symbol;
  }
  return "<module>";
}

function operationForCall(call: ts.CallExpression): DatabaseWriteOperation | undefined {
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const name = expression.name.text as DatabaseWriteOperation;
  return WRITE_OPERATIONS.has(name) ? name : undefined;
}

const RAW_SQL_TRANSPORT_NAMES = new Set([
  "execute",
  "query",
  "unsafe",
  "psql",
  "psqlExec",
  "shellQuote",
]);

function rawSqlTransportName(call: ts.CallExpression): string | undefined {
  const target = unwrapExpression(call.expression);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function enclosingParameterType(
  use: ts.Identifier,
  sourceFile: ts.SourceFile,
): string | undefined {
  for (
    let current: ts.Node | undefined = use.parent;
    current;
    current = current.parent
  ) {
    if (!ts.isFunctionLike(current)) continue;
    const parameter = current.parameters.find((item) =>
      ts.isIdentifier(item.name) && item.name.text === use.text
    );
    if (parameter?.type) return parameter.type.getText(sourceFile);
  }
  return undefined;
}

function isDatabaseReceiver(
  call: ts.CallExpression,
  transportName: string,
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, readonly ts.VariableDeclaration[]>,
): boolean {
  if (transportName === "psql" || transportName === "psqlExec") return true;
  if (transportName === "shellQuote") return false;
  const callTarget = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callTarget)) return false;
  const receiver = unwrapExpression(callTarget.expression);
  if (ts.isIdentifier(receiver)) {
    if (DATABASE_RECEIVER_NAMES.has(receiver.text)) return true;
    const parameterType = enclosingParameterType(receiver, sourceFile);
    if (parameterType && DATABASE_TYPE_PATTERN.test(parameterType)) return true;
    const declaration = visibleAliasDeclaration(
      receiver,
      aliases.get(receiver.text) ?? [],
    );
    if (
      declaration?.type
      && DATABASE_TYPE_PATTERN.test(declaration.type.getText(sourceFile))
    ) {
      return true;
    }
  }
  if (
    ts.isPropertyAccessExpression(receiver)
    && DATABASE_RECEIVER_NAMES.has(receiver.name.text)
  ) {
    return true;
  }
  if (
    ts.isCallExpression(receiver)
    && /(?:database|db|sql)/iu.test(receiver.expression.getText(sourceFile))
  ) {
    return true;
  }
  return false;
}

function rawSqlArgument(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
): ts.Expression | undefined {
  const target = unwrapExpression(call.expression);
  if (!ts.isIdentifier(target)) return call.arguments.at(0);
  let sqlParameterIndex: number | undefined;
  const visit = (node: ts.Node): void => {
    if (sqlParameterIndex !== undefined) return;
    let parameters: ts.NodeArray<ts.ParameterDeclaration> | undefined;
    if (
      ts.isFunctionDeclaration(node)
      && node.name?.text === target.text
    ) {
      parameters = node.parameters;
    } else if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === target.text
      && node.initializer
      && (
        ts.isArrowFunction(node.initializer)
        || ts.isFunctionExpression(node.initializer)
      )
    ) {
      parameters = node.initializer.parameters;
    }
    if (parameters) {
      const index = parameters.findIndex((parameter) =>
        ts.isIdentifier(parameter.name)
        && /^(?:query|sql|statement)$/iu.test(parameter.name.text)
      );
      if (index >= 0) sqlParameterIndex = index;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return call.arguments.at(sqlParameterIndex ?? 0);
}

function rawSqlTexts(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  bindings: ReadonlyMap<string, string>,
  namespaces: ReadonlySet<string>,
  tableExports: Readonly<Record<string, string>>,
  aliases: ReadonlyMap<string, readonly ts.VariableDeclaration[]>,
  visited: ReadonlySet<ts.VariableDeclaration> = new Set(),
): readonly string[] {
  const target = unwrapExpression(expression);
  if (ts.isStringLiteralLike(target)) return [target.text];
  if (ts.isNoSubstitutionTemplateLiteral(target)) return [target.text];
  if (ts.isTaggedTemplateExpression(target)) {
    return rawSqlTexts(
      target.template,
      sourceFile,
      bindings,
      namespaces,
      tableExports,
      aliases,
      visited,
    );
  }
  if (ts.isTemplateExpression(target)) {
    let rendered = target.head.text;
    for (const span of target.templateSpans) {
      const table = resolveTable(
        span.expression,
        bindings,
        namespaces,
        tableExports,
        aliases,
      );
      rendered += table ?? `\${${span.expression.getText(sourceFile)}}`;
      rendered += span.literal.text;
    }
    return [rendered];
  }
  if (ts.isIdentifier(target)) {
    const declaration = visibleAliasDeclaration(
      target,
      aliases.get(target.text) ?? [],
    );
    if (!declaration || !declaration.initializer || visited.has(declaration)) {
      return [];
    }
    return rawSqlTexts(
      declaration.initializer,
      sourceFile,
      bindings,
      namespaces,
      tableExports,
      aliases,
      new Set([...visited, declaration]),
    );
  }
  if (
    ts.isCallExpression(target)
    && ts.isPropertyAccessExpression(target.expression)
    && (
      target.expression.name.text === "trim"
      || target.expression.name.text === "raw"
    )
  ) {
    const wrapped = target.expression.name.text === "raw"
      ? target.arguments.at(0)
      : target.expression.expression;
    if (!wrapped) return [];
    return rawSqlTexts(
      wrapped,
      sourceFile,
      bindings,
      namespaces,
      tableExports,
      aliases,
      visited,
    );
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.flatMap((element) =>
      ts.isSpreadElement(element)
        ? []
        : rawSqlTexts(
          element,
          sourceFile,
          bindings,
          namespaces,
          tableExports,
          aliases,
          visited,
        )
    );
  }
  return [];
}

function rawTableLocators(
  tableExports: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const locators = new Map<string, string>();
  for (const locator of Object.values(tableExports)) {
    locators.set(locator.toLowerCase(), locator);
    locators.set((locator.split(".").at(-1) ?? locator).toLowerCase(), locator);
  }
  return locators;
}

function rawSqlMutations(
  sqlText: string,
  tableLocators: ReadonlyMap<string, string>,
): readonly Pick<DatabaseWriterObservation, "operation" | "table">[] {
  const results: Pick<DatabaseWriterObservation, "operation" | "table">[] = [];
  const mutationPattern =
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:(?:"([^"]+)"|([A-Za-z_][\w$]*))[.])?(?:"([^"]+)"|([A-Za-z_][\w$]*))/giu;
  for (const match of sqlText.matchAll(mutationPattern)) {
    const verb = match[1]!.replace(/\s+/gu, " ").toUpperCase();
    const operation: DatabaseWriteOperation = verb.startsWith("INSERT")
      ? "insert"
      : verb.startsWith("DELETE")
        ? "delete"
        : "update";
    const schema = match[2] ?? match[3];
    const rawTable = match[4] ?? match[5]!;
    if (
      operation === "update"
      && (
        rawTable.toLowerCase() === "set"
        || rawTable.toLowerCase() === "of"
        || (
          rawTable.toLowerCase() === "skip"
          && /\bFOR\s+$/iu.test(sqlText.slice(0, match.index))
        )
        || /\bDO\s+UPDATE\s+$/iu.test(sqlText.slice(
          Math.max(0, match.index - 8),
          match.index + verb.length,
        ))
      )
    ) {
      continue;
    }
    const qualified = schema ? `${schema}.${rawTable}` : rawTable;
    const table = tableLocators.get(qualified.toLowerCase())
      ?? tableLocators.get(rawTable.toLowerCase())
      ?? `unresolved.${qualified.toLowerCase()}`;
    results.push({ operation, table });
  }
  return results;
}

function inspectSourceFile(
  sourceFile: ts.SourceFile,
  path: string,
  tableExports: Readonly<Record<string, string>>,
): DatabaseWriterObservation[] {
  const { bindings, namespaces } = importedTableBindings(
    sourceFile,
    path,
    tableExports,
  );
  const aliases = collectAliasDeclarations(sourceFile);
  const tableLocators = rawTableLocators(tableExports);

  const candidates: (
    Omit<DatabaseWriterObservation, "locator">
    & { readonly locatorKind?: "raw_sql" }
  )[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const operation = operationForCall(node);
      const table = operation
        ? resolveTable(
          node.arguments[0]!,
          bindings,
          namespaces,
          tableExports,
          aliases,
        )
        : undefined;
      if (operation && table) {
        candidates.push({
          operation,
          table,
          path,
          symbol: enclosingSymbol(node, sourceFile),
        });
      }
      const transportName = rawSqlTransportName(node);
      if (transportName && RAW_SQL_TRANSPORT_NAMES.has(transportName)) {
        const sqlArgument = rawSqlArgument(node, sourceFile);
        const texts = sqlArgument
          ? rawSqlTexts(
            sqlArgument,
            sourceFile,
            bindings,
            namespaces,
            tableExports,
            aliases,
          )
          : [];
        for (const text of texts) {
          for (const mutation of rawSqlMutations(text, tableLocators)) {
            candidates.push({
              ...mutation,
              path,
              symbol: enclosingSymbol(node, sourceFile),
              locatorKind: "raw_sql",
            });
          }
        }
        if (
          texts.length === 0
          && isDatabaseReceiver(node, transportName, sourceFile, aliases)
        ) {
          candidates.push({
            operation: "unresolved",
            table: "unresolved.dynamic_sql",
            path,
            symbol: enclosingSymbol(node, sourceFile),
            locatorKind: "raw_sql",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const occurrences = new Map<string, number>();
  return candidates.map((candidate) => {
    const locatorKind = candidate.locatorKind
      ? `:${candidate.locatorKind}`
      : "";
    const key =
      `${candidate.path}#${candidate.symbol}${locatorKind}:${candidate.operation}:${candidate.table}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    const { locatorKind: _locatorKind, ...observation } = candidate;
    return {
      ...observation,
      locator: `${key}:${occurrence}`,
    };
  });
}

function inspectShellFile(
  contents: string,
  path: string,
  tableExports: Readonly<Record<string, string>>,
): DatabaseWriterObservation[] {
  if (!/\bpsql\b/u.test(contents)) return [];
  const executable = contents
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
  const candidates = rawSqlMutations(
    executable,
    rawTableLocators(tableExports),
  ).map((mutation) => ({
    ...mutation,
    path,
    symbol: "<shell>",
  }));
  const occurrences = new Map<string, number>();
  return candidates.map((candidate) => {
    const key =
      `${candidate.path}#${candidate.symbol}:raw_sql:${candidate.operation}:${candidate.table}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return {
      ...candidate,
      locator: `${key}:${occurrence}`,
    };
  });
}

/**
 * Enumerate production Drizzle mutations targeting known schema exports.
 *
 * Recognition is intentionally table-qualified: ordinary Map.delete,
 * hash.update, and similarly named methods are ignored.
 */
export async function discoverDatabaseWriterInventory(
  repositoryRoot: string,
  tableExports: Readonly<Record<string, string>>,
): Promise<readonly DatabaseWriterObservation[]> {
  const observations: DatabaseWriterObservation[] = [];
  for (const path of await sourceFiles(repositoryRoot)) {
    const contents = await readFile(resolve(repositoryRoot, path), "utf8");
    if (path.endsWith(".sh")) {
      observations.push(...inspectShellFile(contents, path, tableExports));
      continue;
    }
    const sourceFile = ts.createSourceFile(
      path,
      contents,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") || path.endsWith(".jsx")
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );
    observations.push(...inspectSourceFile(sourceFile, path, tableExports));
  }
  return observations.sort((left, right) => compareText(left.locator, right.locator));
}

export function auditDatabaseWriterInventory(input: {
  readonly observations: readonly DatabaseWriterObservation[];
  readonly declaredLocators: readonly string[];
}): DatabaseWriterInventoryAudit {
  const observed = input.observations.map((item) => item.locator);
  const observedSet = new Set(observed);
  const declaredSet = new Set(input.declaredLocators);
  const canonicalGroups = (locators: readonly string[]) => {
    const groups = new Map<string, string[]>();
    for (const locator of locators) {
      const key = canonicalDatabaseWriterLocator(locator);
      const group = groups.get(key) ?? [];
      group.push(locator);
      groups.set(key, group);
    }
    return groups;
  };
  const comparableObserved = canonicalGroups(observed);
  const comparableDeclared = canonicalGroups(input.declaredLocators);
  const errors: string[] = [];

  if (observedSet.size !== observed.length) {
    errors.push("database writer observations contain duplicate locators");
  }
  if (declaredSet.size !== input.declaredLocators.length) {
    errors.push("database writer declarations contain duplicate locators");
  }
  const unknown = [...observedSet]
    .filter((locator) => {
      if (declaredSet.has(locator)) return false;
      const key = canonicalDatabaseWriterLocator(locator);
      return comparableObserved.get(key)?.length !== 1
        || comparableDeclared.get(key)?.length !== 1;
    })
    .sort(compareText);
  const stale = [...declaredSet]
    .filter((locator) => {
      if (observedSet.has(locator)) return false;
      const key = canonicalDatabaseWriterLocator(locator);
      return comparableObserved.get(key)?.length !== 1
        || comparableDeclared.get(key)?.length !== 1;
    })
    .sort(compareText);
  errors.push(
    ...unknown.map((locator) => `unknown database writer: ${locator}`),
    ...stale.map((locator) => `stale database writer declaration: ${locator}`),
  );

  return {
    ok: errors.length === 0,
    unknown,
    stale,
    errors,
  };
}

export function fingerprintDatabaseWriterInventory(
  observations: readonly DatabaseWriterObservation[],
): string {
  return createHash("sha256")
    .update(observations.map((item) => item.locator).join("\n"))
    .digest("hex");
}

export function auditRawDatabaseWriterDebt(input: {
  readonly observations: readonly DatabaseWriterObservation[];
  readonly declarations: readonly {
    readonly locator: string;
    readonly id: string;
    readonly surface: string;
    readonly owner: string;
    readonly reason: string;
    readonly remediationState: string;
    readonly releaseImpact: string;
    readonly evidenceGap: string;
  }[];
  readonly reviewedLocators?: readonly string[];
}): RawDatabaseWriterDebtAudit {
  const rawObservations = input.observations.filter((item) =>
    item.locator.includes(":raw_sql:")
  );
  const closure = auditDatabaseWriterInventory({
    observations: rawObservations,
    declaredLocators: [
      ...input.declarations.map((item) => item.locator),
      ...(input.reviewedLocators ?? []),
    ],
  });
  const currentWriters = new Set(
    input.observations.map((item) =>
      canonicalDatabaseWriterLocator(item.locator)
    ),
  );
  const meaningfulStale = closure.stale.filter((locator) =>
    !currentWriters.has(canonicalDatabaseWriterLocator(locator))
  );
  const errors = [
    ...closure.unknown.map((locator) => `unknown database writer: ${locator}`),
    ...meaningfulStale.map(
      (locator) => `stale database writer declaration: ${locator}`,
    ),
  ];
  for (const declaration of input.declarations) {
    const path = declaration.locator.split("#", 1)[0] ?? "";
    const [first = "", second = ""] = path.split("/");
    const expectedOwner = `${first}/${second}`;
    if (first.length === 0 || second.length === 0) {
      errors.push(
        `raw database writer debt has invalid locator path: ${declaration.locator}`,
      );
    }
    if (declaration.owner !== expectedOwner) {
      errors.push(
        `raw database writer debt owner mismatch: ${declaration.locator} `
        + `expected ${expectedOwner}, received ${declaration.owner}`,
      );
    }
    if (declaration.id !== rawDatabaseWriterDebtId(declaration.locator)) {
      errors.push(
        `raw database writer debt id mismatch: ${declaration.locator}`,
      );
    }
    if (declaration.surface !== "db") {
      errors.push(
        `raw database writer debt must use db surface: ${declaration.locator}`,
      );
    }
    if (declaration.reason.trim().length === 0) {
      errors.push(
        `raw database writer debt requires a reason: ${declaration.locator}`,
      );
    }
    if (declaration.remediationState !== "untriaged") {
      errors.push(
        `raw database writer debt must start untriaged: ${declaration.locator}`,
      );
    }
    if (declaration.releaseImpact !== "blocks_whole_product_claim") {
      errors.push(
        `raw database writer debt must block the whole-product claim: ${declaration.locator}`,
      );
    }
    if (declaration.evidenceGap.trim().length === 0) {
      errors.push(
        `raw database writer debt requires an evidence gap: ${declaration.locator}`,
      );
    }
  }
  return {
    ok: errors.length === 0,
    errors: errors.sort(compareText),
  };
}
