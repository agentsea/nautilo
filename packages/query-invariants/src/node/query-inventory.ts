import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

export const QUERY_INVENTORY_SCHEMA_VERSION = 1;

export type QueryOperation =
  | "select"
  | "insert"
  | "update"
  | "delete"
  | "ddl"
  | "transaction"
  | "session"
  | "explain"
  | "fragment"
  | "unresolved";

export type QueryReachability =
  | "live"
  | "operator"
  | "test"
  | "migration"
  | "external";

export type QueryDisposition =
  | "drizzle_builder"
  | "typed_db_primitive"
  | "dev_operator"
  | "test_only"
  | "obsolete_dead";

export type SafetyOpportunity =
  | "full_drizzle"
  | "typed_containment"
  | "retain_direct";

export type QueryBoundedness = "bounded" | "write_bounded" | "unproven";

export type QueryObservation = {
  readonly locator: string;
  readonly fingerprint: string;
  readonly path: string;
  readonly symbol: string;
  readonly owner: string;
  readonly handle: string;
  readonly operation: QueryOperation;
  readonly tables: readonly string[];
  readonly features: readonly string[];
  readonly reachability: QueryReachability;
  readonly boundedness: QueryBoundedness;
  readonly proposedDisposition: QueryDisposition;
  readonly safetyOpportunity: SafetyOpportunity;
  readonly reasonCode: string;
  readonly securitySensitive: boolean;
};

export type QueryInventoryDocument = {
  readonly schemaVersion: number;
  readonly purpose: string;
  readonly observations: readonly QueryObservation[];
};

export type QueryInventoryAudit = {
  readonly ok: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly errors: readonly string[];
};

export type ReviewedSafetyOpportunity = SafetyOpportunity | "covered_elsewhere";

export type QueryReviewOutcome =
  | "confirmed_statement"
  | "transport_adapter"
  | "composed_execution"
  | "sql_fragment";

export type ReviewedQueryDecision = {
  readonly locator: string;
  readonly fingerprint: string;
  readonly outcome: QueryReviewOutcome;
  readonly reviewedDisposition: QueryDisposition;
  readonly reviewedSafetyOpportunity: ReviewedSafetyOpportunity;
  readonly rationale: string;
};

export type ReviewedQueryDecisionDocument = {
  readonly schemaVersion: number;
  readonly purpose: string;
  readonly decisions: readonly ReviewedQueryDecision[];
};

export type FullDrizzleSampleDecision = {
  readonly locator: string;
  readonly fingerprint: string;
  readonly reviewedSafetyOpportunity: SafetyOpportunity;
  readonly rationale: string;
};

export type FullDrizzleSampleDocument = {
  readonly schemaVersion: number;
  readonly purpose: string;
  readonly decisions: readonly FullDrizzleSampleDecision[];
};

type QueryInventoryHeader = {
  readonly type: "query-inventory";
  readonly schemaVersion: number;
  readonly purpose: string;
};

type ReviewedQueryDecisionHeader = {
  readonly type: "reviewed-query-decisions";
  readonly schemaVersion: number;
  readonly purpose: string;
};

type FullDrizzleSampleHeader = {
  readonly type: "full-drizzle-sample";
  readonly schemaVersion: number;
  readonly purpose: string;
};

const SOURCE_ROOTS = ["apps", "bin", "deploy", "dev", "infra", "packages"];
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".sh", ".ts", ".tsx"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".stryker-tmp",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const EXCLUDED_PATH_PREFIXES = ["packages/query-invariants/"];
const TRANSIENT_BUILD_MODULE = /(?:^|\/)tsup[.]config[.]bundled_[^/]+[.]mjs$/u;
const SQL_TRANSPORTS = new Set(["execute", "query", "unsafe", "psql", "psqlExec"]);
const SQL_VERB = "(SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|WITH|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT\\s+ON|DO|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\\s+SAVEPOINT|SET|RESET|EXPLAIN|VACUUM|ANALYZE)";
const SQL_START = new RegExp(`\\b${SQL_VERB}\\b`, "iu");
const SQL_STATEMENT_START = new RegExp(`^${SQL_VERB}\\b`, "iu");
const DATABASE_RECEIVERS = new Set(["client", "connection", "db", "handle", "pool", "sql", "tx"]);
const DATABASE_TYPE = /(?:^|[^A-Za-z])(?:ClusterExec|Database|DbHandle|DirectDb|DirectDatabase|Pool|PoolClient|Sql|SqlClient|Transaction)(?:[^A-Za-z]|$)/u;
const QUERY_OPERATIONS: ReadonlySet<string> = new Set<QueryOperation>([
  "select", "insert", "update", "delete", "ddl", "transaction", "session", "explain", "fragment", "unresolved",
]);
const QUERY_REACHABILITIES: ReadonlySet<string> = new Set<QueryReachability>([
  "live", "operator", "test", "migration", "external",
]);
const QUERY_DISPOSITIONS: ReadonlySet<string> = new Set<QueryDisposition>([
  "drizzle_builder", "typed_db_primitive", "dev_operator", "test_only", "obsolete_dead",
]);
const SAFETY_OPPORTUNITIES: ReadonlySet<string> = new Set<SafetyOpportunity>([
  "full_drizzle", "typed_containment", "retain_direct",
]);
const REVIEWED_SAFETY_OPPORTUNITIES: ReadonlySet<string> = new Set<ReviewedSafetyOpportunity>([
  "full_drizzle", "typed_containment", "retain_direct", "covered_elsewhere",
]);
const QUERY_BOUNDEDNESS_VALUES: ReadonlySet<string> = new Set<QueryBoundedness>([
  "bounded", "write_bounded", "unproven",
]);
const QUERY_REVIEW_OUTCOMES: ReadonlySet<string> = new Set<QueryReviewOutcome>([
  "confirmed_statement", "transport_adapter", "composed_execution", "sql_fragment",
]);

function assertEnumField(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string,
  document: string,
): asserts value is string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${document} has invalid ${field}: ${JSON.stringify(value)}`);
  }
}

function parseQueryObservation(line: string): QueryObservation {
  const observation = JSON.parse(line) as QueryObservation;
  assertEnumField(observation.operation, QUERY_OPERATIONS, "operation", "query inventory observation");
  assertEnumField(observation.reachability, QUERY_REACHABILITIES, "reachability", "query inventory observation");
  assertEnumField(observation.boundedness, QUERY_BOUNDEDNESS_VALUES, "boundedness", "query inventory observation");
  assertEnumField(
    observation.proposedDisposition,
    QUERY_DISPOSITIONS,
    "proposedDisposition",
    "query inventory observation",
  );
  assertEnumField(
    observation.safetyOpportunity,
    SAFETY_OPPORTUNITIES,
    "safetyOpportunity",
    "query inventory observation",
  );
  return observation;
}

function parseReviewedQueryDecision(line: string): ReviewedQueryDecision {
  const decision = JSON.parse(line) as ReviewedQueryDecision;
  assertEnumField(decision.outcome, QUERY_REVIEW_OUTCOMES, "outcome", "reviewed query decision");
  assertEnumField(
    decision.reviewedDisposition,
    QUERY_DISPOSITIONS,
    "reviewedDisposition",
    "reviewed query decision",
  );
  assertEnumField(
    decision.reviewedSafetyOpportunity,
    REVIEWED_SAFETY_OPPORTUNITIES,
    "reviewedSafetyOpportunity",
    "reviewed query decision",
  );
  return decision;
}

function parseFullDrizzleSampleDecision(line: string): FullDrizzleSampleDecision {
  const decision = JSON.parse(line) as FullDrizzleSampleDecision;
  assertEnumField(
    decision.reviewedSafetyOpportunity,
    SAFETY_OPPORTUNITIES,
    "reviewedSafetyOpportunity",
    "full-Drizzle sample decision",
  );
  return decision;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function extension(path: string): string {
  return /[.][^.\\/]+$/u.exec(path)?.[0] ?? "";
}

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extension(path))
    && !TRANSIENT_BUILD_MODULE.test(path)
    && !EXCLUDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function sourceFiles(repositoryRoot: string): Promise<string[]> {
  const results: string[] = [];
  const pending = SOURCE_ROOTS.map((root) => resolve(repositoryRoot, root));
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
      const path = portablePath(relative(repositoryRoot, absolute));
      if (entry.isFile() && isSourcePath(path)) results.push(path);
    }
  }
  return results.sort(compareText);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function namedSymbol(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (
    (ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node))
    && node.name
  ) return node.name.getText(sourceFile);
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)
  ) return node.parent.name.text;
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && ts.isPropertyAssignment(node.parent)
  ) return node.parent.name.getText(sourceFile);
  return undefined;
}

function enclosingSymbol(node: ts.Node, sourceFile: ts.SourceFile): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    const symbol = namedSymbol(current, sourceFile);
    if (symbol) return symbol;
  }
  return "<module>";
}

function collectAliases(sourceFile: ts.SourceFile): ReadonlyMap<string, readonly ts.VariableDeclaration[]> {
  const aliases = new Map<string, ts.VariableDeclaration[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const entries = aliases.get(node.name.text) ?? [];
      entries.push(node);
      aliases.set(node.name.text, entries);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return aliases;
}

function lexicalScope(node: ts.Node): ts.Node {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isCaseBlock(current) || ts.isSourceFile(current)) return current;
  }
  return node.getSourceFile();
}

function isAncestor(ancestor: ts.Node, node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function visibleDeclaration(
  use: ts.Identifier,
  declarations: readonly ts.VariableDeclaration[],
): ts.VariableDeclaration | undefined {
  return declarations
    .filter((item) => item.initializer && item.getStart() < use.getStart() && isAncestor(lexicalScope(item), use))
    .sort((left, right) => {
      const scopeDelta = (lexicalScope(left).end - lexicalScope(left).pos)
        - (lexicalScope(right).end - lexicalScope(right).pos);
      return scopeDelta || right.getStart() - left.getStart();
    })
    .at(0);
}

function expressionText(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  aliases: ReadonlyMap<string, readonly ts.VariableDeclaration[]>,
  visited: ReadonlySet<ts.VariableDeclaration> = new Set(),
): string | undefined {
  const target = unwrap(expression);
  if (ts.isStringLiteralLike(target) || ts.isNoSubstitutionTemplateLiteral(target)) return target.text;
  if (ts.isTaggedTemplateExpression(target)) return expressionText(target.template, sourceFile, aliases, visited);
  if (ts.isTemplateExpression(target)) {
    let text = target.head.text;
    for (const span of target.templateSpans) {
      text += `\${${span.expression.getText(sourceFile)}}${span.literal.text}`;
    }
    return text;
  }
  if (ts.isIdentifier(target)) {
    const declaration = visibleDeclaration(target, aliases.get(target.text) ?? []);
    if (!declaration?.initializer || visited.has(declaration)) return undefined;
    return expressionText(declaration.initializer, sourceFile, aliases, new Set([...visited, declaration]));
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionText(target.left, sourceFile, aliases, visited);
    const right = expressionText(target.right, sourceFile, aliases, visited);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (
    ts.isCallExpression(target)
    && ts.isPropertyAccessExpression(target.expression)
    && target.expression.name.text === "raw"
    && target.arguments[0]
  ) return expressionText(target.arguments[0], sourceFile, aliases, visited);
  return undefined;
}

function tagName(tag: ts.LeftHandSideExpression): string | undefined {
  const target = unwrap(tag);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function callTransport(call: ts.CallExpression): { name: string; handle: string } | undefined {
  const target = unwrap(call.expression);
  if (ts.isIdentifier(target) && SQL_TRANSPORTS.has(target.text)) {
    return { name: target.text, handle: target.text };
  }
  if (ts.isPropertyAccessExpression(target) && SQL_TRANSPORTS.has(target.name.text)) {
    return { name: target.name.text, handle: target.expression.getText(call.getSourceFile()) };
  }
  return undefined;
}

function enclosingParameterType(identifier: ts.Identifier): string | undefined {
  for (let current: ts.Node | undefined = identifier.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const parameter = current.parameters.find((item) => ts.isIdentifier(item.name) && item.name.text === identifier.text);
    return parameter?.type?.getText(identifier.getSourceFile());
  }
  return undefined;
}

function looksLikeDatabaseCall(call: ts.CallExpression, handle: string): boolean {
  const target = unwrap(call.expression);
  if (ts.isIdentifier(target)) return target.text === "psql" || target.text === "psqlExec";
  if (!ts.isPropertyAccessExpression(target)) return false;
  const receiver = unwrap(target.expression);
  if (ts.isIdentifier(receiver)) {
    if (DATABASE_RECEIVERS.has(receiver.text.toLowerCase())) return true;
    const type = enclosingParameterType(receiver);
    if (type && DATABASE_TYPE.test(type)) return true;
  }
  return /(?:^|[.])(db|sql|pool|client|connection|handle|tx)(?:[.]|$)/iu.test(handle);
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/--[^\n\r]*/gu, " ")
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function statementTexts(sql: string, searchForStatementStart: boolean): string[] {
  const normalized = normalizeSql(sql);
  if (!normalized) return [];
  if (!searchForStatementStart && !SQL_STATEMENT_START.test(normalized)) return [normalized];
  const pieces = normalized.split(/\s*;\s*/u).filter(Boolean);
  const statements = pieces.flatMap((piece) => {
    const start = SQL_START.exec(piece);
    return start ? [piece.slice(start.index)] : [];
  });
  return statements.length > 0 ? statements : [normalized];
}

function operationFor(sql: string): QueryOperation {
  const upper = sql.toUpperCase();
  const first = SQL_STATEMENT_START.exec(upper)?.[1]?.replace(/\s+/gu, " ") ?? "";
  if (first === "SELECT") return "select";
  if (first.startsWith("INSERT")) return "insert";
  if (first === "UPDATE") return "update";
  if (first.startsWith("DELETE")) return "delete";
  if (first === "WITH") {
    if (/\bINSERT\s+INTO\b/u.test(upper)) return "insert";
    if (/\bUPDATE\b/u.test(upper)) return "update";
    if (/\bDELETE\s+FROM\b/u.test(upper)) return "delete";
    return "select";
  }
  if (["CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "COMMENT ON", "DO", "VACUUM", "ANALYZE"].includes(first)) return "ddl";
  if (["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE SAVEPOINT"].includes(first)) return "transaction";
  if (first === "SET" || first === "RESET") return "session";
  if (first === "EXPLAIN") return "explain";
  return SQL_STATEMENT_START.test(sql) ? "unresolved" : "fragment";
}

function tablesFor(sql: string): string[] {
  const tables = new Set<string>();
  const pattern = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:ONLY\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:[.](?:"[^"]+"|[A-Za-z_][\w$]*))?)/giu;
  for (const match of sql.matchAll(pattern)) {
    const table = match[1]!.replaceAll('"', "").toLowerCase();
    if (!["set", "select", "values"].includes(table)) tables.add(table);
  }
  return [...tables].sort(compareText);
}

function featuresFor(sql: string): string[] {
  const checks: readonly [string, RegExp][] = [
    ["cte", /^\s*WITH\b/iu],
    ["recursive", /\bWITH\s+RECURSIVE\b/iu],
    ["locking", /\bFOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/iu],
    ["skip_locked", /\bSKIP\s+LOCKED\b/iu],
    ["returning", /\bRETURNING\b/iu],
    ["upsert", /\bON\s+CONFLICT\b/iu],
    ["full_text", /(?:@@|tsquery|tsvector)/iu],
    ["vector", /(?:<->|<#>|<=>|vector_|::\s*vector(?:\s*\(|\b))/iu],
    ["sequence", /\b(?:nextval|currval|setval|pg_get_serial_sequence)\s*\(/iu],
    ["json", /(?:\bJSONB?\b|->>?|#>>?)/iu],
    ["array", /(?:\bARRAY\b|\bANY\s*\(|\bALL\s*\(|&&)/iu],
    ["advisory_lock", /\bpg_(?:try_)?advisory_/iu],
    ["window", /\bOVER\s*\(/iu],
    ["role_session", /(?:\bSET\s+(?:LOCAL\s+)?ROLE\b|\bcurrent_user\b|\bsession_user\b|set_config\s*\()/iu],
    ["dynamic_sql", /\$\{[^}]+\}/u],
  ];
  return checks.filter(([, pattern]) => pattern.test(sql)).map(([name]) => name);
}

function reachabilityFor(path: string, tables: readonly string[]): QueryReachability {
  if (/(?:^|\/)(?:migrations?|drizzle)(?:\/|$)/iu.test(path)) return "migration";
  if (/(?:^|\/)(?:tests?|__tests__|fixtures?|harnesses)(?:\/|$)|[.](?:spec|test)[.]/iu.test(path)) return "test";
  if (/^(?:bin|deploy|dev|infra)\//u.test(path) || /\/(?:scripts?|commands?)\//u.test(path)) return "operator";
  if (tables.some((table) => /^(?:auth|logto)(?:[.]|_)/u.test(table)) || /logto/iu.test(path)) return "external";
  return "live";
}

const ADVANCED_FEATURES = new Set(["cte", "recursive", "locking", "skip_locked", "full_text", "vector", "sequence", "json", "array", "advisory_lock", "window", "role_session"]);

function classification(input: {
  operation: QueryOperation;
  features: readonly string[];
  reachability: QueryReachability;
}): Pick<QueryObservation, "proposedDisposition" | "safetyOpportunity" | "reasonCode"> {
  if (input.reachability === "test") return { proposedDisposition: "test_only", safetyOpportunity: "retain_direct", reasonCode: "test_fixture_or_assertion" };
  if (input.reachability === "operator" || input.reachability === "migration") return { proposedDisposition: "dev_operator", safetyOpportunity: "retain_direct", reasonCode: input.reachability === "migration" ? "migration_or_schema_ddl" : "operator_utility" };
  if (input.reachability === "external") return { proposedDisposition: "typed_db_primitive", safetyOpportunity: "retain_direct", reasonCode: "external_schema" };
  if (["ddl", "transaction", "session", "explain", "unresolved"].includes(input.operation)) return { proposedDisposition: "typed_db_primitive", safetyOpportunity: "retain_direct", reasonCode: `postgres_${input.operation}_primitive` };
  if (input.operation === "fragment" || input.features.some((feature) => ADVANCED_FEATURES.has(feature))) return { proposedDisposition: "typed_db_primitive", safetyOpportunity: "typed_containment", reasonCode: input.operation === "fragment" ? "sql_fragment" : "advanced_sql_feature" };
  return { proposedDisposition: "drizzle_builder", safetyOpportunity: "full_drizzle", reasonCode: "ordinary_schema_query" };
}

function boundednessFor(operation: QueryOperation, sql: string): QueryBoundedness {
  if (["insert", "update", "delete", "ddl", "transaction", "session"].includes(operation)) return "write_bounded";
  if (/\bLIMIT\s+(?:\d+|\$\d+|\$\{[^}]+\})\b/iu.test(sql) || /\b(?:COUNT|EXISTS|current_user|session_user)\s*\(?/iu.test(sql)) return "bounded";
  return "unproven";
}

function ownerFor(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

function fingerprint(sql: string): string {
  return createHash("sha256").update(normalizeSql(sql)).digest("hex");
}

type Candidate = {
  path: string;
  symbol: string;
  handle: string;
  sql: string | undefined;
  searchForStatementStart: boolean;
};

function shellCandidates(path: string, contents: string): Candidate[] {
  const starts = [...contents.matchAll(/\bpsql\b/gu)].map((match) => match.index);
  return starts.flatMap((start, index) => {
    const segment = contents.slice(start, starts[index + 1] ?? contents.length);
    const sqlStart = SQL_START.exec(segment);
    return sqlStart
      ? [{ path, symbol: "<shell>", handle: "psql", sql: segment.slice(sqlStart.index), searchForStatementStart: true }]
      : [];
  });
}

function observationCandidates(sourceFile: ts.SourceFile, path: string): Candidate[] {
  const aliases = collectAliases(sourceFile);
  const candidates: Candidate[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments[0]) {
      const transport = callTransport(node);
      if (transport) {
        const sql = expressionText(node.arguments[0], sourceFile, aliases);
        if ((sql !== undefined && SQL_START.test(sql)) || looksLikeDatabaseCall(node, transport.handle)) {
          candidates.push({
            path,
            symbol: enclosingSymbol(node, sourceFile),
            handle: transport.handle,
            sql,
            searchForStatementStart: true,
          });
        }
      }
      const target = unwrap(node.expression);
      const isSqlRaw = ts.isPropertyAccessExpression(target)
        && ts.isIdentifier(target.expression)
        && target.expression.text === "sql"
        && target.name.text === "raw";
      const parentOwnsSql = ts.isCallExpression(node.parent)
        && node.parent.arguments.some((argument) => argument === node)
        && callTransport(node.parent) !== undefined;
      if (isSqlRaw && !parentOwnsSql) {
        candidates.push({
          path,
          symbol: enclosingSymbol(node, sourceFile),
          handle: "sql.raw",
          sql: expressionText(node.arguments[0], sourceFile, aliases),
          searchForStatementStart: false,
        });
      }
    }
    if (ts.isTaggedTemplateExpression(node) && tagName(node.tag) === "sql") {
      const parent = node.parent;
      const alreadyOwnedByTransport = ts.isCallExpression(parent)
        && parent.arguments.some((argument) => argument === node)
        && callTransport(parent) !== undefined;
      if (!alreadyOwnedByTransport) {
        const tag = unwrap(node.tag);
        const identifierSqlTransport = ts.isIdentifier(tag)
          && tag.text === "sql"
          && DATABASE_TYPE.test(enclosingParameterType(tag) ?? "");
        candidates.push({
          path,
          symbol: enclosingSymbol(node, sourceFile),
          handle: node.tag.getText(sourceFile),
          sql: expressionText(node.template, sourceFile, aliases),
          searchForStatementStart: ts.isPropertyAccessExpression(tag) || identifierSqlTransport,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return candidates;
}

export function discoverQueriesInSource(path: string, contents: string): QueryObservation[] {
  const candidates: Candidate[] = path.endsWith(".sh")
    ? shellCandidates(path, contents)
    : observationCandidates(
      ts.createSourceFile(
        path,
        contents,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith(".tsx") || path.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
      path,
    );
  const occurrences = new Map<string, number>();
  const observations: QueryObservation[] = [];
  for (const candidate of candidates) {
    const texts = candidate.sql === undefined
      ? ["<unresolved>"]
      : statementTexts(candidate.sql, candidate.searchForStatementStart);
    for (const sql of texts) {
      const operation = candidate.sql === undefined ? "unresolved" : operationFor(sql);
      const tables = candidate.sql === undefined ? [] : tablesFor(sql);
      const features = candidate.sql === undefined ? ["dynamic_sql"] : featuresFor(sql);
      const reachability = reachabilityFor(path, tables);
      const key = `${path}#${candidate.symbol}:raw_sql:${operation}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      const disposition = classification({ operation, features, reachability });
      observations.push({
        locator: `${key}:${occurrence}`,
        fingerprint: fingerprint(sql),
        path,
        symbol: candidate.symbol,
        owner: ownerFor(path),
        handle: candidate.handle,
        operation,
        tables,
        features,
        reachability,
        boundedness: boundednessFor(operation, sql),
        ...disposition,
        securitySensitive: features.some((feature) => ["locking", "skip_locked", "advisory_lock", "role_session"].includes(feature))
          || /(?:auth|trust|permission|membership|rls)/iu.test(path),
      });
    }
  }
  return observations.sort((left, right) => compareText(left.locator, right.locator));
}

export async function discoverQueryInventory(repositoryRoot: string): Promise<QueryInventoryDocument> {
  const observations: QueryObservation[] = [];
  for (const path of await sourceFiles(repositoryRoot)) {
    const contents = await readFile(resolve(repositoryRoot, path), "utf8");
    observations.push(...discoverQueriesInSource(path, contents));
  }
  return {
    schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
    purpose: "Baseline of direct database query call sites and SQL fragments.",
    observations: observations.sort((left, right) => compareText(left.locator, right.locator)),
  };
}

export function serializeQueryInventory(document: QueryInventoryDocument): string {
  const header: QueryInventoryHeader = {
    type: "query-inventory",
    schemaVersion: document.schemaVersion,
    purpose: document.purpose,
  };
  return [
    JSON.stringify(header),
    ...document.observations.map((observation) => JSON.stringify(observation)),
    "",
  ].join("\n");
}

export function parseQueryInventory(contents: string): QueryInventoryDocument {
  const lines = contents.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("query inventory baseline is empty");
  const header = JSON.parse(lines[0]!) as QueryInventoryHeader;
  if (header.type !== "query-inventory") throw new Error("query inventory header is missing");
  return {
    schemaVersion: header.schemaVersion,
    purpose: header.purpose,
    observations: lines.slice(1).map(parseQueryObservation),
  };
}

export function serializeReviewedQueryDecisions(
  document: ReviewedQueryDecisionDocument,
): string {
  const header: ReviewedQueryDecisionHeader = {
    type: "reviewed-query-decisions",
    schemaVersion: document.schemaVersion,
    purpose: document.purpose,
  };
  return [
    JSON.stringify(header),
    ...document.decisions.map((decision) => JSON.stringify(decision)),
    "",
  ].join("\n");
}

export function parseReviewedQueryDecisions(
  contents: string,
): ReviewedQueryDecisionDocument {
  const lines = contents.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("reviewed query decisions are empty");
  const header = JSON.parse(lines[0]!) as ReviewedQueryDecisionHeader;
  if (header.type !== "reviewed-query-decisions") {
    throw new Error("reviewed query decision header is missing");
  }
  return {
    schemaVersion: header.schemaVersion,
    purpose: header.purpose,
    decisions: lines.slice(1).map(parseReviewedQueryDecision),
  };
}

export function parseFullDrizzleSample(contents: string): FullDrizzleSampleDocument {
  const lines = contents.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("full-Drizzle sample is empty");
  const header = JSON.parse(lines[0]!) as FullDrizzleSampleHeader;
  if (header.type !== "full-drizzle-sample") throw new Error("full-Drizzle sample header is missing");
  return {
    schemaVersion: header.schemaVersion,
    purpose: header.purpose,
    decisions: lines.slice(1).map(parseFullDrizzleSampleDecision),
  };
}

function isLiveConsumerFullDrizzle(observation: QueryObservation): boolean {
  return observation.reachability === "live"
    && observation.owner !== "packages/db"
    && observation.safetyOpportunity === "full_drizzle";
}

function expectedFullDrizzleSample(inventory: QueryInventoryDocument): QueryObservation[] {
  const byOwner = new Map<string, QueryObservation[]>();
  for (const observation of inventory.observations.filter(isLiveConsumerFullDrizzle)) {
    const entries = byOwner.get(observation.owner) ?? [];
    entries.push(observation);
    byOwner.set(observation.owner, entries);
  }
  return [...byOwner.entries()].sort(([left], [right]) => compareText(left, right)).flatMap(([, entries]) => {
    const sorted = entries.sort((left, right) => compareText(left.locator, right.locator));
    return [...new Map(
      [sorted[0]!, sorted[Math.floor(sorted.length / 2)]!, sorted.at(-1)!]
        .map((observation) => [observation.locator, observation] as const),
    ).values()];
  });
}

export function auditFullDrizzleSample(input: {
  readonly inventory: QueryInventoryDocument;
  readonly sample: FullDrizzleSampleDocument;
}): QueryInventoryAudit {
  const errors: string[] = [];
  if (input.sample.schemaVersion !== QUERY_INVENTORY_SCHEMA_VERSION) {
    errors.push(`unsupported full-Drizzle sample schema version: ${input.sample.schemaVersion}`);
  }
  const observations = new Map(input.inventory.observations.map((item) => [item.locator, item]));
  const decisions = new Map(input.sample.decisions.map((item) => [item.locator, item]));
  if (decisions.size !== input.sample.decisions.length) errors.push("full-Drizzle sample contains duplicate locators");
  const expected = expectedFullDrizzleSample(input.inventory);
  const expectedLocators = new Set(expected.map((item) => item.locator));
  const added = input.sample.decisions
    .filter((decision) => !expectedLocators.has(decision.locator))
    .map((decision) => decision.locator)
    .sort(compareText);
  const removed = expected
    .filter((observation) => !decisions.has(observation.locator))
    .map((observation) => observation.locator)
    .sort(compareText);
  const changed = input.sample.decisions
    .filter((decision) => observations.get(decision.locator)?.fingerprint !== decision.fingerprint)
    .map((decision) => decision.locator)
    .filter((locator) => !added.includes(locator))
    .sort(compareText);
  for (const decision of input.sample.decisions) {
    if (decision.rationale.trim().length < 24) {
      errors.push(`full-Drizzle sample decision requires a grounded rationale: ${decision.locator}`);
    }
  }
  errors.push(
    ...added.map((locator) => `stale or out-of-sample full-Drizzle decision: ${locator}`),
    ...removed.map((locator) => `missing full-Drizzle sample decision: ${locator}`),
    ...changed.map((locator) => `full-Drizzle sample fingerprint changed: ${locator}`),
  );
  return { ok: errors.length === 0, added, removed, changed, errors: errors.sort(compareText) };
}

export function fullDrizzleSampleSummary(sample: FullDrizzleSampleDocument): Record<string, unknown> {
  const bySafetyOpportunity: Record<string, number> = {};
  for (const decision of sample.decisions) {
    bySafetyOpportunity[decision.reviewedSafetyOpportunity] =
      (bySafetyOpportunity[decision.reviewedSafetyOpportunity] ?? 0) + 1;
  }
  const confirmed = bySafetyOpportunity["full_drizzle"] ?? 0;
  return {
    method: "first, median, and last locator for each live consumer owner",
    reviewedDecisions: sample.decisions.length,
    bySafetyOpportunity: Object.fromEntries(
      Object.entries(bySafetyOpportunity).sort(([left], [right]) => compareText(left, right)),
    ),
    observedFullDrizzlePrecision: sample.decisions.length === 0
      ? null
      : Number((confirmed / sample.decisions.length).toFixed(4)),
  };
}

function isReviewTarget(observation: QueryObservation): boolean {
  return observation.reachability === "live"
    && (
      observation.safetyOpportunity === "full_drizzle"
      || (
        observation.owner !== "packages/db"
        && (
          observation.operation === "unresolved"
          || observation.safetyOpportunity === "retain_direct"
        )
      )
    );
}

export function auditReviewedQueryDecisions(input: {
  readonly inventory: QueryInventoryDocument;
  readonly reviews: ReviewedQueryDecisionDocument;
}): QueryInventoryAudit {
  const errors: string[] = [];
  if (input.reviews.schemaVersion !== QUERY_INVENTORY_SCHEMA_VERSION) {
    errors.push(`unsupported reviewed query decision schema version: ${input.reviews.schemaVersion}`);
  }
  const observations = new Map(input.inventory.observations.map((item) => [item.locator, item]));
  const decisions = new Map(input.reviews.decisions.map((item) => [item.locator, item]));
  if (decisions.size !== input.reviews.decisions.length) errors.push("reviewed query decisions contain duplicate locators");
  const targets = input.inventory.observations.filter(isReviewTarget);
  const added = input.reviews.decisions
    .filter((decision) => !observations.has(decision.locator) || !isReviewTarget(observations.get(decision.locator)!))
    .map((decision) => decision.locator)
    .sort(compareText);
  const removed = targets
    .filter((observation) => !decisions.has(observation.locator))
    .map((observation) => observation.locator)
    .sort(compareText);
  const changed = input.reviews.decisions
    .filter((decision) => observations.get(decision.locator)?.fingerprint !== decision.fingerprint)
    .map((decision) => decision.locator)
    .filter((locator) => !added.includes(locator))
    .sort(compareText);
  for (const decision of input.reviews.decisions) {
    if (decision.rationale.trim().length < 24) {
      errors.push(`reviewed query decision requires a grounded rationale: ${decision.locator}`);
    }
    if (
      decision.reviewedSafetyOpportunity === "covered_elsewhere"
      && decision.outcome !== "composed_execution"
    ) {
      errors.push(`only composed execution may be covered elsewhere: ${decision.locator}`);
    }
  }
  errors.push(
    ...added.map((locator) => `stale or out-of-scope reviewed query decision: ${locator}`),
    ...removed.map((locator) => `missing reviewed query decision: ${locator}`),
    ...changed.map((locator) => `reviewed query fingerprint changed: ${locator}`),
  );
  return { ok: errors.length === 0, added, removed, changed, errors: errors.sort(compareText) };
}

export function auditQueryInventory(
  expected: QueryInventoryDocument,
  actual: QueryInventoryDocument,
): QueryInventoryAudit {
  const errors: string[] = [];
  if (expected.schemaVersion !== QUERY_INVENTORY_SCHEMA_VERSION) errors.push(`unsupported query inventory schema version: ${expected.schemaVersion}`);
  const expectedByLocator = new Map(expected.observations.map((item) => [item.locator, item]));
  const actualByLocator = new Map(actual.observations.map((item) => [item.locator, item]));
  if (expectedByLocator.size !== expected.observations.length) errors.push("baseline contains duplicate query locators");
  if (actualByLocator.size !== actual.observations.length) errors.push("scan contains duplicate query locators");
  const added = [...actualByLocator.keys()].filter((locator) => !expectedByLocator.has(locator)).sort(compareText);
  const removed = [...expectedByLocator.keys()].filter((locator) => !actualByLocator.has(locator)).sort(compareText);
  const changed = [...actualByLocator]
    .filter(([locator, item]) => {
      const expectedItem = expectedByLocator.get(locator);
      return expectedItem !== undefined && JSON.stringify(expectedItem) !== JSON.stringify(item);
    })
    .map(([locator]) => locator)
    .sort(compareText);
  errors.push(
    ...added.map((locator) => `unclassified query added: ${locator}`),
    ...removed.map((locator) => `stale query classification: ${locator}`),
    ...changed.map((locator) => `query classification changed: ${locator}`),
  );
  return { ok: errors.length === 0, added, removed, changed, errors };
}

export function queryInventorySummary(document: QueryInventoryDocument): Record<string, unknown> {
  const countBy = (key: "reachability" | "safetyOpportunity" | "proposedDisposition"): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const observation of document.observations) {
      const value = observation[key];
      result[value] = (result[value] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareText(left, right)));
  };
  const live = document.observations.filter((item) => item.reachability === "live");
  const liveConsumerOwned = live.filter((item) => item.owner !== "packages/db");
  const opportunities = (observations: readonly QueryObservation[]): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const observation of observations) {
      result[observation.safetyOpportunity] = (result[observation.safetyOpportunity] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => compareText(left, right)));
  };
  const consumerOwners = [...new Set(liveConsumerOwned.map((item) => item.owner))]
    .sort(compareText)
    .map((owner) => {
      const observations = liveConsumerOwned.filter((item) => item.owner === owner);
      return { owner, total: observations.length, bySafetyOpportunity: opportunities(observations) };
    });
  return {
    total: document.observations.length,
    byReachability: countBy("reachability"),
    bySafetyOpportunity: countBy("safetyOpportunity"),
    byProposedDisposition: countBy("proposedDisposition"),
    securitySensitive: document.observations.filter((item) => item.securitySensitive).length,
    unprovenBoundedness: document.observations.filter((item) => item.boundedness === "unproven").length,
    live: {
      total: live.length,
      bySafetyOpportunity: opportunities(live),
    },
    liveConsumerOwned: {
      definition: "reachability=live and owner!=packages/db",
      total: liveConsumerOwned.length,
      bySafetyOpportunity: opportunities(liveConsumerOwned),
      securitySensitive: liveConsumerOwned.filter((item) => item.securitySensitive).length,
      unprovenBoundedness: liveConsumerOwned.filter((item) => item.boundedness === "unproven").length,
      unresolved: liveConsumerOwned.filter((item) => item.operation === "unresolved").length,
      byOwner: consumerOwners,
    },
  };
}

export function reviewedQuerySummary(input: {
  readonly inventory: QueryInventoryDocument;
  readonly reviews: ReviewedQueryDecisionDocument;
  readonly fullDrizzleSample?: FullDrizzleSampleDocument;
}): Record<string, unknown> {
  const decisions = new Map(input.reviews.decisions.map((item) => [item.locator, item]));
  const sampledDecisions = new Map(
    (input.fullDrizzleSample?.decisions ?? []).map((item) => [item.locator, item]),
  );
  const liveConsumerOwned = input.inventory.observations.filter((item) =>
    item.reachability === "live" && item.owner !== "packages/db"
  );
  const effective = liveConsumerOwned.flatMap((observation) => {
    const decision = decisions.get(observation.locator);
    const opportunity = decision?.reviewedSafetyOpportunity
      ?? sampledDecisions.get(observation.locator)?.reviewedSafetyOpportunity
      ?? observation.safetyOpportunity;
    return opportunity === "covered_elsewhere" ? [] : [{ observation, opportunity }];
  });
  const bySafetyOpportunity: Record<string, number> = {};
  for (const item of effective) {
    bySafetyOpportunity[item.opportunity] = (bySafetyOpportunity[item.opportunity] ?? 0) + 1;
  }
  const byReviewOutcome: Record<string, number> = {};
  for (const decision of input.reviews.decisions) {
    byReviewOutcome[decision.outcome] = (byReviewOutcome[decision.outcome] ?? 0) + 1;
  }
  return {
    reviewedDecisions: input.reviews.decisions.length,
    sampledFullDrizzleDecisions: input.fullDrizzleSample?.decisions.length ?? 0,
    excludedDuplicateExecutions: liveConsumerOwned.length - effective.length,
    effectiveLiveConsumerOwned: effective.length,
    bySafetyOpportunity: Object.fromEntries(
      Object.entries(bySafetyOpportunity).sort(([left], [right]) => compareText(left, right)),
    ),
    byReviewOutcome: Object.fromEntries(
      Object.entries(byReviewOutcome).sort(([left], [right]) => compareText(left, right)),
    ),
  };
}
