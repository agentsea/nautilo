import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import ts from "typescript";

import type {
  DtoDirection,
  DtoInventoryObservation,
} from "./dto-declaration-audit";

export {
  auditDtoDeclarations,
  DTO_TRANSPORTS,
  type DtoArbitraryPayloadDeclaration,
  type DtoDeclaration,
  type DtoDeclarationAuditResult,
  type DtoDirection,
  type DtoInventoryObservation,
  type DtoTransport,
} from "./dto-declaration-audit";

type NamedDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

function posixRelative(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile()
        && (path.endsWith(".ts") || path.endsWith(".tsx"))
      ) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files;
}

async function parseTypeScript(path: string): Promise<ts.SourceFile> {
  const source = await readFile(path, "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function stableObservationId(locator: string): string {
  const slug = locator
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120);
  return `wire.${slug}.${fnv1a(locator)}`;
}

function observation(input: Omit<DtoInventoryObservation, "id" | "surface">): DtoInventoryObservation {
  return {
    id: stableObservationId(input.locator),
    surface: "wire",
    ...input,
  };
}

function stringLiteralValues(node: ts.TypeNode | undefined): string[] {
  if (!node) return [];
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return [node.literal.text];
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.flatMap(stringLiteralValues);
  }
  if (ts.isParenthesizedTypeNode(node)) return stringLiteralValues(node.type);
  return [];
}

function propertyType(
  declaration: NamedDeclaration,
  propertyName: string,
): ts.TypeNode | undefined {
  if (ts.isInterfaceDeclaration(declaration)) {
    for (const member of declaration.members) {
      if (
        ts.isPropertySignature(member)
        && member.name
        && propertyNameText(member.name) === propertyName
      ) {
        return member.type;
      }
    }
    return undefined;
  }
  return propertyTypeFromNode(declaration.type, propertyName);
}

function propertyTypeFromNode(
  node: ts.TypeNode,
  propertyName: string,
): ts.TypeNode | undefined {
  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      if (
        ts.isPropertySignature(member)
        && propertyNameText(member.name) === propertyName
      ) {
        return member.type;
      }
    }
    return undefined;
  }
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
    for (const member of node.types) {
      const found = propertyTypeFromNode(member, propertyName);
      if (found) return found;
    }
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return propertyTypeFromNode(node.type, propertyName);
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function namedDeclarations(sourceFiles: readonly ts.SourceFile[]): Map<string, NamedDeclaration> {
  const declarations = new Map<string, NamedDeclaration>();
  for (const sourceFile of sourceFiles) {
    sourceFile.forEachChild((node) => {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        declarations.set(node.name.text, node);
      }
    });
  }
  return declarations;
}

function referencedTypeNames(node: ts.TypeNode): string[] {
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.flatMap(referencedTypeNames);
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    return [node.typeName.text];
  }
  if (ts.isParenthesizedTypeNode(node)) return referencedTypeNames(node.type);
  return [];
}

type IdentifierTypeReference = ts.TypeReferenceNode & {
  readonly typeName: ts.Identifier;
};

function referencedTypeNodes(node: ts.TypeNode): IdentifierTypeReference[] {
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.flatMap(referencedTypeNodes);
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    return [node as IdentifierTypeReference];
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return referencedTypeNodes(node.type);
  }
  return [];
}

function resolvedNamedDeclaration(
  checker: ts.TypeChecker,
  reference: IdentifierTypeReference,
): NamedDeclaration | null {
  let symbol = checker.getSymbolAtLocation(reference.typeName);
  if (symbol?.flags && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  return symbol?.declarations?.find((declaration): declaration is NamedDeclaration =>
    ts.isInterfaceDeclaration(declaration)
    || ts.isTypeAliasDeclaration(declaration)
  ) ?? null;
}

function stringLiteralTypeValues(type: ts.Type): string[] {
  if (type.isUnion()) {
    return type.types.flatMap(stringLiteralTypeValues);
  }
  return (type.flags & ts.TypeFlags.StringLiteral) !== 0
    ? [(type as ts.StringLiteralType).value]
    : [];
}

function exported(node: NamedDeclaration): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function addObservation(
  observations: DtoInventoryObservation[],
  seen: Set<string>,
  value: Omit<DtoInventoryObservation, "id" | "surface" | "structuralSignatures"> & {
    readonly structuralSignatures?: readonly string[];
  },
): void {
  const key = value.locator;
  if (seen.has(key)) return;
  seen.add(key);
  observations.push(observation({
    ...value,
    structuralSignatures: [...(value.structuralSignatures ?? [])].sort(),
  }));
}

function staticString(
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  resolving = new Set<string>(),
): string | null {
  if (!expression) return null;
  if (
    ts.isStringLiteral(expression)
    || ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return staticString(expression.expression, sourceFile, resolving);
  }
  if (
    ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) {
    return staticString(expression.expression, sourceFile, resolving);
  }
  if (
    ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(expression.left, sourceFile, resolving);
    const right = staticString(expression.right, sourceFile, resolving);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = staticString(span.expression, sourceFile, resolving);
      if (substitution === null) return null;
      value += substitution + span.literal.text;
    }
    return value;
  }
  if (
    ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === "replace"
    && expression.arguments.length === 2
  ) {
    const receiver = staticString(expression.expression.expression, sourceFile, resolving);
    const search = staticString(expression.arguments[0], sourceFile, resolving);
    const replacement = staticString(expression.arguments[1], sourceFile, resolving);
    return receiver === null || search === null || replacement === null
      ? null
      : receiver.replace(search, replacement);
  }
  if (ts.isIdentifier(expression) && !resolving.has(expression.text)) {
    resolving.add(expression.text);
    let value: string | null = null;
    const visit = (node: ts.Node): void => {
      if (
        value === null
        && ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === expression.text
      ) {
        value = staticString(node.initializer, sourceFile, resolving);
      }
      if (value === null) ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    resolving.delete(expression.text);
    return value;
  }
  return null;
}

/**
 * Resolve every statically finite URL produced by a template expression.
 * Only literal and union-literal substitutions are accepted. Runtime strings
 * remain unresolved, preserving fail-closed route discovery.
 */
function staticStringVariants(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): readonly string[] | null {
  if (!expression) return null;
  const current = unwrapExpression(expression);
  if (ts.isTemplateExpression(current)) {
    let values = [current.head.text];
    for (const span of current.templateSpans) {
      const direct = staticString(span.expression, sourceFile);
      const substitutions = direct === null
        ? stringLiteralTypeValues(checker.getTypeAtLocation(span.expression))
        : [direct];
      if (substitutions.length === 0) return null;
      values = values.flatMap((prefix) =>
        substitutions.map((substitution) => `${prefix}${substitution}${span.literal.text}`)
      );
    }
    return [...new Set(values)].sort();
  }
  const direct = staticString(current, sourceFile);
  if (direct !== null) return [direct];
  const literals = stringLiteralTypeValues(checker.getTypeAtLocation(current));
  return literals.length === 0 ? null : [...new Set(literals)].sort();
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const property = resolvedObjectMember(object, name);
  if (property && ts.isPropertyAssignment(property)) {
    return property.initializer;
  }
  if (
    property
    && name === "method"
    && ts.isShorthandPropertyAssignment(property)
    && !property.objectAssignmentInitializer
  ) {
    return property.name;
  }
  return undefined;
}

function objectMemberName(
  property: ts.ObjectLiteralElementLike,
): string | null {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (
    ts.isPropertyAssignment(property)
    || ts.isMethodDeclaration(property)
    || ts.isGetAccessorDeclaration(property)
    || ts.isSetAccessorDeclaration(property)
  ) return propertyNameText(property.name);
  return null;
}

/** Resolve the final explicit member only when no later spread may override it. */
function resolvedObjectMember(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  let candidate: ts.ObjectLiteralElementLike | undefined;
  let ambiguous = false;
  for (const property of object.properties) {
    if (
      ts.isSpreadAssignment(property)
      || (
        !ts.isShorthandPropertyAssignment(property)
        && "name" in property
        && property.name !== undefined
        && ts.isComputedPropertyName(property.name)
      )
    ) {
      if (candidate) ambiguous = true;
      continue;
    }
    if (objectMemberName(property) === name) {
      candidate = property;
      ambiguous = false;
    }
  }
  return ambiguous ? undefined : candidate;
}

function staticStrings(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  resolving = new Set<ts.Symbol>(),
): readonly string[] | null {
  if (!expression) return null;
  const current = unwrapExpression(expression);
  if (ts.isArrayLiteralExpression(current)) {
    const values: string[] = [];
    for (const element of current.elements) {
      if (ts.isSpreadElement(element)) return null;
      const value = staticString(element, sourceFile);
      if (value === null) return null;
      values.push(value);
    }
    return values;
  }
  if (ts.isIdentifier(current)) {
    const symbol = ts.isShorthandPropertyAssignment(current.parent)
      ? checker.getShorthandAssignmentValueSymbol(current.parent)
      : checker.getSymbolAtLocation(current);
    if (!symbol || resolving.has(symbol)) return null;
    const declarations = (symbol.declarations ?? []).filter(ts.isVariableDeclaration);
    if (declarations.length !== 1) return null;
    const [declaration] = declarations;
    if (
      !declaration
      || declaration.getSourceFile() !== sourceFile
      || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) return null;

    const initializer = declaration.initializer;
    // A loop variable has no initializer of its own. Accept it only when the
    // exact runtime iteration is a const binding over an inline finite array
    // whose elements are themselves literals. Do not feed identifier elements
    // into the broader static evaluator: their values can be reassigned before
    // the loop executes.
    if (
      !initializer
      && declaration.parent.declarations.length === 1
      && ts.isForOfStatement(declaration.parent.parent)
      && declaration.parent.parent.initializer === declaration.parent
      && !declaration.parent.parent.awaitModifier
    ) {
      const iterable = unwrapExpression(declaration.parent.parent.expression);
      if (!ts.isArrayLiteralExpression(iterable)) return null;
      const values: string[] = [];
      for (const element of iterable.elements) {
        if (ts.isSpreadElement(element)) return null;
        const literal = unwrapExpression(element);
        if (
          !ts.isStringLiteral(literal)
          && !ts.isNoSubstitutionTemplateLiteral(literal)
        ) return null;
        values.push(literal.text);
      }
      return values;
    }
    if (!initializer) return null;

    resolving.add(symbol);
    const values = staticStrings(checker, initializer, sourceFile, resolving);
    resolving.delete(symbol);
    return values;
  }
  const value = staticString(current, sourceFile);
  return value === null ? null : [value];
}

function arbitraryPathsFromCheckedType(
  checker: ts.TypeChecker,
  type: ts.Type,
  prefix: string,
  active = new Set<ts.Type>(),
): string[] {
  if (
    (type.flags & ts.TypeFlags.Unknown) !== 0
    || (type.flags & ts.TypeFlags.Any) !== 0
  ) {
    return prefix ? [prefix] : [];
  }
  if (type.isUnionOrIntersection()) {
    return type.types.flatMap((member) =>
      arbitraryPathsFromCheckedType(checker, member, prefix, active)
    );
  }
  if (active.has(type)) return [];
  active.add(type);
  try {
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const elementTypes = checker.getTypeArguments(type as ts.TypeReference);
      return elementTypes.flatMap((elementType, index) =>
        arbitraryPathsFromCheckedType(
          checker,
          elementType,
          checker.isTupleType(type) ? `${prefix}[${index}]` : `${prefix}[]`,
          active,
        )
      );
    }
    const stringIndex = type.getStringIndexType();
    if (
      stringIndex
      && arbitraryPathsFromCheckedType(checker, stringIndex, prefix, active).length > 0
    ) {
      return prefix ? [prefix] : [];
    }
    return checker.getPropertiesOfType(type).flatMap((property) => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) return [];
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const name = property.getName();
      const path = prefix ? `${prefix}.${name}` : name;
      return arbitraryPathsFromCheckedType(checker, propertyType, path, active);
    });
  } finally {
    active.delete(type);
  }
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function containsRequestBody(
  expression: ts.Expression,
  requestName: string,
): boolean {
  const current = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(current)
    && current.name.text === "body"
    && ts.isIdentifier(current.expression)
    && current.expression.text === requestName
  ) {
    return true;
  }
  if (ts.isBinaryExpression(current)) {
    return containsRequestBody(current.left, requestName)
      || containsRequestBody(current.right, requestName);
  }
  return false;
}

function accessedOpenBodyPaths(
  handler: ts.FunctionLikeDeclaration,
): string[] {
  const firstParameter = handler.parameters[0]?.name;
  if (!firstParameter || !ts.isIdentifier(firstParameter)) return [];
  const requestName = firstParameter.text;
  const aliases = new Set<string>();
  const paths = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && containsRequestBody(node.initializer, requestName)
    ) {
      aliases.add(node.name.text);
    }
    if (
      ts.isElementAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && aliases.has(node.expression.text)
      && node.argumentExpression
      && ts.isStringLiteral(node.argumentExpression)
    ) {
      paths.add(`request.body.${node.argumentExpression.text}`);
    }
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && aliases.has(node.expression.text)
    ) {
      paths.add(`request.body.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  if (handler.body) visit(handler.body);
  return [...paths].sort();
}

function routeHandler(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  routeOptions?: ts.ObjectLiteralExpression,
): ts.FunctionLikeDeclaration | undefined {
  if (routeOptions) {
    const methodHandler = resolvedObjectMember(routeOptions, "handler");
    if (methodHandler && ts.isMethodDeclaration(methodHandler)) return methodHandler;
  }
  let candidate = routeOptions
    ? objectProperty(routeOptions, "handler")
    : call.arguments[call.arguments.length - 1];
  if (candidate && ts.isObjectLiteralExpression(unwrapExpression(candidate))) {
    candidate = objectProperty(
      unwrapExpression(candidate) as ts.ObjectLiteralExpression,
      "handler",
    );
  }
  return resolveFunctionLike(candidate, sourceFile);
}

function returnBelongsToHandler(
  node: ts.ReturnStatement,
  handler: ts.FunctionLikeDeclaration,
): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && current !== handler) {
    if (ts.isFunctionLike(current)) return false;
    current = current.parent;
  }
  return current === handler;
}

function requestResponseArbitraryPaths(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  handler: ts.FunctionLikeDeclaration | undefined,
): string[] {
  const requestTypeNode = call.typeArguments?.[0];
  const paths = new Set<string>();
  if (requestTypeNode) {
    const requestType = checker.getTypeFromTypeNode(requestTypeNode);
    for (const [propertyName, prefix] of [
      ["Body", "request.body"],
      ["Params", "request.params"],
      ["Querystring", "request.query"],
      ["Reply", "response.body"],
    ] as const) {
      const property = requestType.getProperty(propertyName);
      const declaration = property?.valueDeclaration ?? property?.declarations?.[0];
      if (!property || !declaration) continue;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const discovered = arbitraryPathsFromCheckedType(checker, propertyType, prefix);
      if (prefix === "request.body" && discovered.includes(prefix) && handler) {
        const accessed = accessedOpenBodyPaths(handler);
        for (const path of accessed.length > 0 ? accessed : [prefix]) paths.add(path);
      } else {
        for (const path of discovered) paths.add(path);
      }
    }
  }

  if (handler?.body) {
    const requestParameter = handler.parameters[0]?.name;
    const requestName = requestParameter && ts.isIdentifier(requestParameter)
      ? requestParameter.text
      : undefined;
    const replyParameter = handler.parameters[1]?.name;
    const replyName = replyParameter && ts.isIdentifier(replyParameter)
      ? replyParameter.text
      : undefined;
    const visit = (node: ts.Node): void => {
      if (
        requestName
        && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      ) {
        const property = directRequestProperty(node.expression, requestName);
        if (property) {
          for (
            const path of arbitraryPathsFromCheckedType(
              checker,
              checker.getTypeFromTypeNode(node.type),
              `request.${property}`,
            )
          ) {
            paths.add(path);
          }
          return;
        }
      }
      if (
        requestName
        && ts.isVariableDeclaration(node)
        && node.type
        && node.initializer
      ) {
        const property = directRequestProperty(node.initializer, requestName);
        if (property) {
          for (
            const path of arbitraryPathsFromCheckedType(
              checker,
              checker.getTypeFromTypeNode(node.type),
              `request.${property}`,
            )
          ) {
            paths.add(path);
          }
        }
      }
      if (
        replyName
        && ts.isCallExpression(node)
        && expressionPropertyName(node.expression) === "send"
        && expressionRootIdentifier(node.expression) === replyName
        && node.arguments[0]
      ) {
        for (
          const path of arbitraryPathsFromCheckedType(
            checker,
            checker.getTypeAtLocation(node.arguments[0]),
            "response.body",
          )
        ) {
          paths.add(path);
        }
      }
      if (
        ts.isReturnStatement(node)
        && node.expression
        && returnBelongsToHandler(node, handler)
        && !(replyName && expressionRootIdentifier(node.expression) === replyName)
      ) {
        const responseType = checker.getTypeAtLocation(node.expression);
        if (isFrameworkReplyType(checker, responseType, node.expression)) {
          ts.forEachChild(node, visit);
          return;
        }
        for (
          const path of arbitraryPathsFromCheckedType(
            checker,
            responseType,
            "response.body",
          )
        ) {
          paths.add(path);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(handler.body);
  }
  return [...paths].sort();
}

const NOMINAL_WIRE_TYPES = new Set([
  "ArrayBuffer",
  "Blob",
  "Buffer",
  "Date",
  "File",
  "Readable",
  "ReadableStream",
  "Uint8Array",
]);

function canonicalTypeShape(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
  seen = new Set<ts.Type>(),
  depth = 0,
): string {
  if (type.flags & ts.TypeFlags.Any) return "any";
  if (type.flags & ts.TypeFlags.Unknown) return "unknown";
  if (type.flags & ts.TypeFlags.Never) return "never";
  if (type.flags & ts.TypeFlags.Void) return "void";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.StringLiteral) {
    return JSON.stringify((type as ts.StringLiteralType).value);
  }
  if (type.flags & ts.TypeFlags.TemplateLiteral) {
    return checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation);
  }
  if (type.flags & ts.TypeFlags.String) return "string";
  if (type.flags & ts.TypeFlags.NumberLiteral) {
    return String((type as ts.NumberLiteralType).value);
  }
  if (type.flags & ts.TypeFlags.Number) return "number";
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation);
  }
  if (type.flags & ts.TypeFlags.Boolean) return "boolean";
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    return checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation);
  }
  if (type.flags & ts.TypeFlags.BigInt) return "bigint";
  if (type.flags & ts.TypeFlags.ESSymbol) return "symbol";

  if (type.isUnionOrIntersection()) {
    const separator = type.isUnion() ? "|" : "&";
    return [...new Set(type.types.map((member) =>
      canonicalTypeShape(checker, member, location, new Set(seen), depth)
    ))].sort().join(separator);
  }

  if (checker.isTupleType(type)) {
    const members = checker.getTypeArguments(type as ts.TypeReference);
    return `[${members.map((member) =>
      canonicalTypeShape(checker, member, location, new Set(seen), depth + 1)
    ).join(",")}]`;
  }
  if (checker.isArrayType(type)) {
    const member = checker.getTypeArguments(type as ts.TypeReference)[0];
    return `${member
      ? canonicalTypeShape(checker, member, location, new Set(seen), depth + 1)
      : "unknown"}[]`;
  }

  const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (symbolName && NOMINAL_WIRE_TYPES.has(symbolName)) return symbolName;
  if (depth >= 8) return symbolName && symbolName !== "__type" ? symbolName : "object";
  if (seen.has(type)) return symbolName && symbolName !== "__type" ? symbolName : "recursive";
  seen.add(type);

  const properties = checker.getPropertiesOfType(type)
    .filter((property) => !property.getName().startsWith("__@"))
    .sort((left, right) => left.getName().localeCompare(right.getName(), "en"));
  const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  const fields = properties.map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
    return `${property.getName()}${optional}:${
      canonicalTypeShape(checker, propertyType, declaration, new Set(seen), depth + 1)
    }`;
  });
  if (stringIndex) {
    fields.push(`[key:string]:${
      canonicalTypeShape(checker, stringIndex, location, new Set(seen), depth + 1)
    }`);
  }
  if (numberIndex) {
    fields.push(`[key:number]:${
      canonicalTypeShape(checker, numberIndex, location, new Set(seen), depth + 1)
    }`);
  }
  if (fields.length > 0) return `{${fields.sort().join(";")}}`;
  if (type.getCallSignatures().length > 0) return "function";
  return symbolName && symbolName !== "__type"
    ? symbolName
    : checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation);
}

function propertyTypeFromCheckedType(
  checker: ts.TypeChecker,
  type: ts.Type,
  propertyName: string,
): { readonly type: ts.Type; readonly declaration: ts.Node } | undefined {
  const property = type.getProperty(propertyName);
  const declaration = property?.valueDeclaration ?? property?.declarations?.[0];
  if (!property || !declaration) return undefined;
  return {
    type: checker.getTypeOfSymbolAtLocation(property, declaration),
    declaration,
  };
}

function expressionRootIdentifier(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return expressionRootIdentifier(expression.expression);
  }
  if (ts.isCallExpression(expression)) return expressionRootIdentifier(expression.expression);
  return undefined;
}

function expressionRootNode(expression: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return expressionRootNode(expression.expression);
  }
  if (ts.isCallExpression(expression)) return expressionRootNode(expression.expression);
  return undefined;
}

function isFrameworkReplyType(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
): boolean {
  const symbolName = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (symbolName === "FastifyReply") return true;
  return /^FastifyReply(?:<|$)/u.test(
    checker.typeToString(type, location, ts.TypeFormatFlags.NoTruncation),
  );
}

type RequestStructuralProperty = "body" | "params" | "query";

function directRequestProperty(
  expression: ts.Expression,
  requestName: string,
): RequestStructuralProperty | undefined {
  const target = unwrapExpression(expression);
  if (
    !ts.isPropertyAccessExpression(target)
    || !ts.isIdentifier(target.expression)
    || target.expression.text !== requestName
  ) {
    return undefined;
  }
  return (["body", "params", "query"] as const).find(
    (property) => property === target.name.text,
  );
}

function locallyCastRequestSignatures(
  checker: ts.TypeChecker,
  handler: ts.FunctionLikeDeclaration | undefined,
): readonly string[] {
  const requestParameter = handler?.parameters[0]?.name;
  if (!handler?.body || !requestParameter || !ts.isIdentifier(requestParameter)) return [];
  const signatures = new Set<string>();
  const requestName = requestParameter.text;
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const property = directRequestProperty(node.expression, requestName);
      if (property) {
        signatures.add(
          `request.${property}:${
            canonicalTypeShape(
              checker,
              checker.getTypeFromTypeNode(node.type),
              node.type,
            )
          }`,
        );
        // The outermost cast owns the wire assertion. Do not also record an
        // intermediate `as unknown` in a double-cast chain.
        return;
      }
    }
    if (
      ts.isVariableDeclaration(node)
      && node.type
      && node.initializer
    ) {
      const property = directRequestProperty(node.initializer, requestName);
      if (property) {
        signatures.add(
          `request.${property}:${
            canonicalTypeShape(
              checker,
              checker.getTypeFromTypeNode(node.type),
              node.type,
            )
          }`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(handler.body);
  return [...signatures].sort();
}

function httpStructuralSignatures(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  handler: ts.FunctionLikeDeclaration | undefined,
): string[] {
  const signatures = new Set<string>();
  const routeTypeNode = call.typeArguments?.[0];
  if (routeTypeNode) {
    const routeType = checker.getTypeFromTypeNode(routeTypeNode);
    for (const [propertyName, prefix] of [
      ["Body", "request.body"],
      ["Params", "request.params"],
      ["Querystring", "request.query"],
      ["Reply", "response.body"],
    ] as const) {
      const property = propertyTypeFromCheckedType(checker, routeType, propertyName);
      if (property) {
        signatures.add(
          `${prefix}:${canonicalTypeShape(checker, property.type, property.declaration)}`,
        );
      }
    }
  }
  for (const signature of locallyCastRequestSignatures(checker, handler)) {
    signatures.add(signature);
  }

  if (!handler?.body) return [...signatures].sort();
  const replyName = handler.parameters[1]?.name;
  const replyIdentifier = replyName && ts.isIdentifier(replyName) ? replyName.text : undefined;
  const visit = (node: ts.Node): void => {
    if (
      replyIdentifier
      && ts.isCallExpression(node)
      && expressionPropertyName(node.expression) === "send"
      && expressionRootIdentifier(node.expression) === replyIdentifier
      && node.arguments[0]
    ) {
      signatures.add(
        `response.body:${
          canonicalTypeShape(checker, checker.getTypeAtLocation(node.arguments[0]), node.arguments[0])
        }`,
      );
    }
    if (
      ts.isReturnStatement(node)
      && node.expression
      && returnBelongsToHandler(node, handler)
      && !(
        replyIdentifier
        && expressionRootIdentifier(node.expression) === replyIdentifier
      )
    ) {
      const responseType = checker.getTypeAtLocation(node.expression);
      if (isFrameworkReplyType(checker, responseType, node.expression)) {
        ts.forEachChild(node, visit);
        return;
      }
      signatures.add(
        `response.body:${
          canonicalTypeShape(checker, responseType, node.expression)
        }`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(handler.body);
  return [...signatures].sort();
}

function fastifyRouteReceiver(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): boolean {
  const receiver = unwrapExpression(expression);
  if (
    ts.isIdentifier(receiver)
    && /^(?:app|fastify|scope|server)$/iu.test(receiver.text)
  ) {
    return true;
  }
  const receiverType = checker.getTypeAtLocation(receiver);
  const typeName = checker.typeToString(receiverType);
  return /\bFastifyInstance\b/u.test(typeName)
    && checker.getPropertyOfType(receiverType, "route") !== undefined;
}

function routeDiscoveryError(
  repoRoot: string,
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  detail: string,
): Error {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return new Error(
    `${posixRelative(repoRoot, file)}:${position.line + 1}:${position.character + 1}: ${detail}`,
  );
}

const FASTIFY_ROUTE_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

function resolvedFastifyRoute(
  checker: ts.TypeChecker,
  repoRoot: string,
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
): {
  readonly paths: readonly string[];
  readonly methods: readonly string[];
  readonly handler: ts.FunctionLikeDeclaration;
} | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const callName = node.expression.name.text;
  const routeCall = (callName === "route" || FASTIFY_ROUTE_METHODS.has(callName))
    && fastifyRouteReceiver(checker, node.expression.expression);
  if (!routeCall) return undefined;

  const firstArgument = node.arguments[0]
    ? unwrapExpression(node.arguments[0])
    : undefined;
  const routeOptions = callName === "route"
    && firstArgument
    && ts.isObjectLiteralExpression(firstArgument)
    ? firstArgument
    : undefined;
  if (callName === "route" && !routeOptions) {
    throw routeDiscoveryError(
      repoRoot,
      file,
      sourceFile,
      node,
      "unresolved route options",
    );
  }

  const pathExpression = routeOptions
    ? objectProperty(routeOptions, "url")
    : node.arguments[0];
  const paths = staticStringVariants(checker, pathExpression, sourceFile);
  if (!paths || paths.length === 0 || paths.some((path) => !path.startsWith("/"))) {
    throw routeDiscoveryError(
      repoRoot,
      file,
      sourceFile,
      pathExpression ?? node,
      "unresolved route URL",
    );
  }

  const configuredMethods = routeOptions
    ? staticStrings(checker, objectProperty(routeOptions, "method"), sourceFile)
    : [callName];
  if (!configuredMethods || configuredMethods.length === 0) {
    throw routeDiscoveryError(
      repoRoot,
      file,
      sourceFile,
      objectProperty(routeOptions!, "method") ?? node,
      "unresolved route method",
    );
  }
  const handler = routeHandler(node, sourceFile, routeOptions);
  if (!handler) {
    throw routeDiscoveryError(
      repoRoot,
      file,
      sourceFile,
      routeOptions
        ? objectProperty(routeOptions, "handler") ?? routeOptions
        : node.arguments[node.arguments.length - 1] ?? node,
      "unresolved route handler",
    );
  }
  return {
    paths,
    methods: configuredMethods.map((method) => method.toUpperCase()),
    handler,
  };
}

async function discoverHttp(
  repoRoot: string,
  observations: DtoInventoryObservation[],
  seen: Set<string>,
): Promise<void> {
  const sourceRoot = join(repoRoot, "packages/server/src");
  const files = await listTypeScriptFiles(sourceRoot);
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();

  for (const file of files) {
    const sourceFile = program.getSourceFile(file) ?? await parseTypeScript(file);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
      ) {
        const route = resolvedFastifyRoute(
          checker,
          repoRoot,
          file,
          sourceFile,
          node,
        );
        if (!route) {
          ts.forEachChild(node, visit);
          return;
        }

        const arbitraryPayloads = requestResponseArbitraryPaths(
          checker,
          node,
          route.handler,
        );
        const structuralSignatures = httpStructuralSignatures(
          checker,
          node,
          route.handler,
        );
        for (const path of route.paths) {
          for (const method of route.methods) {
            const contract = `${method} ${path}`;
            addObservation(observations, seen, {
              locator: `http:request_response:${contract}`,
              transport: "http",
              direction: "request_response",
              contract,
              sourcePath: posixRelative(repoRoot, file),
              structuralSignatures,
              arbitraryPayloads,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

export async function discoverHttpDtoInventory(
  repoRoot: string,
): Promise<readonly DtoInventoryObservation[]> {
  const observations: DtoInventoryObservation[] = [];
  await discoverHttp(repoRoot, observations, new Set<string>());
  return observations.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function discoverServerEvents(
  repoRoot: string,
  observations: DtoInventoryObservation[],
  seen: Set<string>,
): void {
  const paths = [
    join(repoRoot, "packages/types/src/realtime.ts"),
    join(repoRoot, "packages/types/src/document-patches.ts"),
    join(repoRoot, "packages/types/src/document-mutations.ts"),
  ];
  const program = ts.createProgram(paths, {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const sourceFiles = paths.map((path) => {
    const sourceFile = program.getSourceFile(path);
    if (!sourceFile) {
      throw new Error(
        `Unable to load ServerEvent source: ${posixRelative(repoRoot, path)}`,
      );
    }
    return sourceFile;
  });
  const declarations = namedDeclarations(sourceFiles);
  const serverEvent = declarations.get("ServerEvent");
  if (!serverEvent || !ts.isTypeAliasDeclaration(serverEvent)) {
    throw new Error("Unable to find the ServerEvent type alias");
  }

  for (const reference of referencedTypeNodes(serverEvent.type)) {
    const name = reference.typeName.text;
    const declaration = resolvedNamedDeclaration(checker, reference);
    if (!declaration) {
      throw new Error(`Unable to resolve ServerEvent constituent: ${name}`);
    }
    const referencedType = checker.getTypeFromTypeNode(reference);
    const typeProperty = referencedType.getProperty("type");
    const eventTypes = typeProperty === undefined
      ? []
      : stringLiteralTypeValues(
        checker.getTypeOfSymbolAtLocation(typeProperty, declaration),
      );
    for (const eventType of eventTypes) {
      addObservation(observations, seen, {
        locator: `ws:server_to_client:${eventType}`,
        transport: "ws",
        direction: "server_to_client",
        contract: name,
        sourcePath: posixRelative(repoRoot, declaration.getSourceFile().fileName),
        arbitraryPayloads: [],
      });
    }
  }
}

function expressionPropertyName(expression: ts.Expression): string | null {
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
}

function comparedString(node: ts.BinaryExpression): string | null {
  if (
    node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
    && node.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return null;
  }
  if (ts.isStringLiteral(node.right)) return node.right.text;
  if (ts.isStringLiteral(node.left)) return node.left.text;
  return null;
}

function isInboundWsDiscriminator(node: ts.BinaryExpression): boolean {
  const other = ts.isStringLiteral(node.right) ? node.left : node.right;
  if (ts.isPropertyAccessExpression(other)) {
    return other.name.text === "type";
  }
  return ts.isIdentifier(other) && other.text === "msgType";
}

function stringTypeProperties(node: ts.Node): string[] {
  const values: string[] = [];
  const visit = (candidate: ts.Node): void => {
    if (ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === "type") {
      if (ts.isStringLiteral(candidate.initializer)) values.push(candidate.initializer.text);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return values;
}

async function discoverProductWsFrames(
  repoRoot: string,
  observations: DtoInventoryObservation[],
  seen: Set<string>,
): Promise<void> {
  const file = join(repoRoot, "packages/server/src/routes/ws.ts");
  const sourceFile = await parseTypeScript(file);
  const sourcePath = posixRelative(repoRoot, file);
  const inbound = new Set<string>();
  const outbound = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isInboundWsDiscriminator(node)) {
      const value = comparedString(node);
      if (value) inbound.add(value);
    }
    if (
      ts.isCallExpression(node)
      && expressionPropertyName(node.expression) === "send"
    ) {
      for (const argument of node.arguments) {
        for (const value of stringTypeProperties(argument)) outbound.add(value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const value of [...inbound].sort()) {
    addObservation(observations, seen, {
      locator: `ws:client_to_server:${value}`,
      transport: "ws",
      direction: "client_to_server",
      contract: value,
      sourcePath,
      arbitraryPayloads: [],
    });
  }
  for (const value of [...outbound].sort()) {
    addObservation(observations, seen, {
      locator: `ws:server_to_client:${value}`,
      transport: "ws",
      direction: "server_to_client",
      contract: value,
      sourcePath,
      arbitraryPayloads: [],
    });
  }
}

type SseContract = {
  readonly direction: "produced" | "accepted";
  readonly method: string;
  readonly channel: string;
  readonly event: string;
  readonly sourcePath: string;
  readonly payloadShapes: readonly string[];
  readonly arbitraryPayloads: readonly string[];
};

function sourceContainsText(node: ts.Node, text: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (
      (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child))
      && child.text.includes(text)
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function stringLiteralTypes(type: ts.Type): string[] {
  if (type.isUnionOrIntersection()) return type.types.flatMap(stringLiteralTypes);
  return (type.flags & ts.TypeFlags.StringLiteral) !== 0
    ? [(type as ts.StringLiteralType).value]
    : [];
}

function eventPayloadsFromType(
  checker: ts.TypeChecker,
  type: ts.Type,
  location: ts.Node,
): Array<{
  readonly event: string;
  readonly shape: string;
  readonly arbitraryPayloads: readonly string[];
}> {
  const members = type.isUnion() ? type.types : [type];
  return members.flatMap((member) => {
    const discriminator = propertyTypeFromCheckedType(checker, member, "type");
    if (!discriminator) return [];
    return stringLiteralTypes(discriminator.type).map((event) => ({
      event,
      shape: canonicalTypeShape(checker, member, location),
      arbitraryPayloads: arbitraryPathsFromCheckedType(
        checker,
        member,
        "event.payload",
      ),
    }));
  });
}

function endpointFromUrlExpression(
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
  resolving = new Set<string>(),
  checker?: ts.TypeChecker,
): string | undefined {
  if (!expression) return undefined;
  const exact = staticString(expression, sourceFile);
  let fragments: string | undefined = exact ?? undefined;
  if (!fragments && ts.isTemplateExpression(expression)) {
    fragments = expression.head.text
      + expression.templateSpans.map((span) => span.literal.text).join("");
  } else if (
    !fragments
    && ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    fragments = `${endpointFromUrlExpression(expression.left, sourceFile, resolving, checker) ?? ""}${
      endpointFromUrlExpression(expression.right, sourceFile, resolving, checker) ?? ""
    }`;
  } else if (!fragments && ts.isIdentifier(expression) && !resolving.has(expression.text)) {
    resolving.add(expression.text);
    const symbolDeclaration = checker
      ?.getSymbolAtLocation(expression)
      ?.valueDeclaration;
    let initializer = symbolDeclaration && ts.isVariableDeclaration(symbolDeclaration)
      ? symbolDeclaration.initializer
      : undefined;
    if (!initializer) {
      const visit = (node: ts.Node): void => {
        if (
          !initializer
          && ts.isVariableDeclaration(node)
          && ts.isIdentifier(node.name)
          && node.name.text === expression.text
        ) {
          initializer = node.initializer;
        }
        if (!initializer) ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    fragments = endpointFromUrlExpression(initializer, sourceFile, resolving, checker);
    resolving.delete(expression.text);
  }
  if (!fragments) return undefined;
  const apiStart = fragments.indexOf("/api/");
  if (apiStart < 0) return undefined;
  return fragments.slice(apiStart).split(/[?#]/, 1)[0];
}

function resolveFunctionLike(
  expression: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | undefined {
  if (!expression) return undefined;
  if (
    ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isParenthesizedExpression(expression)
  ) {
    return resolveFunctionLike(expression.expression, sourceFile);
  }
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (!ts.isIdentifier(expression)) return undefined;
  let resolved: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !resolved
      && ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === expression.text
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      resolved = node.initializer;
      return;
    }
    if (
      !resolved
      && ts.isFunctionDeclaration(node)
      && node.name?.text === expression.text
    ) {
      resolved = node;
      return;
    }
    if (!resolved) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return resolved;
}

type PayloadShapeEvidence = {
  readonly shapes: readonly string[];
  readonly arbitraryPayloads: readonly string[];
};

function listenerPayloadEvidence(
  checker: ts.TypeChecker,
  listener: ts.Expression | undefined,
  sourceFile: ts.SourceFile,
): PayloadShapeEvidence {
  const handler = resolveFunctionLike(listener, sourceFile);
  if (!handler) {
    return {
      shapes: ["unknown"],
      arbitraryPayloads: ["event.payload"],
    };
  }
  return functionPayloadEvidence(checker, handler, sourceFile);
}

function functionPayloadEvidence(
  checker: ts.TypeChecker,
  handler: ts.FunctionLikeDeclaration,
  sourceFile: ts.SourceFile,
): PayloadShapeEvidence {
  const shapes = new Set<string>();
  const arbitraryPayloads = new Set<string>();
  const parameterType = handler.parameters[0]?.type;
  if (
    parameterType
    && ts.isTypeReferenceNode(parameterType)
    && ts.isIdentifier(parameterType.typeName)
    && parameterType.typeName.text === "MessageEvent"
    && parameterType.typeArguments?.[0]
  ) {
    const payloadNode = parameterType.typeArguments[0];
    const payloadType = checker.getTypeFromTypeNode(payloadNode);
    shapes.add(canonicalTypeShape(checker, payloadType, payloadNode));
    for (
      const path of arbitraryPathsFromCheckedType(
        checker,
        payloadType,
        "event.payload",
      )
    ) {
      arbitraryPayloads.add(path);
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      && node.type.kind !== ts.SyntaxKind.UnknownKeyword
      && (
        node.expression.getText(sourceFile).includes("JSON.parse")
        || node.expression.getText(sourceFile).includes(".data")
      )
    ) {
      const payloadType = checker.getTypeFromTypeNode(node.type);
      shapes.add(canonicalTypeShape(checker, payloadType, node.type));
      for (
        const path of arbitraryPathsFromCheckedType(
          checker,
          payloadType,
          "event.payload",
        )
      ) {
        arbitraryPayloads.add(path);
      }
    }
    ts.forEachChild(node, visit);
  };
  if (handler.body) visit(handler.body);
  if (shapes.size === 0) {
    shapes.add("unknown");
    arbitraryPayloads.add("event.payload");
  }
  return {
    shapes: [...shapes].sort(),
    arbitraryPayloads: [...arbitraryPayloads].sort(),
  };
}

function isRuntimeFunction(
  node: ts.Node,
): node is
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration {
  return ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node);
}

function addSseContract(
  contracts: Map<string, {
    contract: Omit<SseContract, "payloadShapes" | "arbitraryPayloads">;
    payloadShapes: Set<string>;
    arbitraryPayloads: Set<string>;
    sourceEvidence: Array<{
      sourcePath: string;
      payloadShapes: Set<string>;
    }>;
  }>,
  contract: SseContract,
): void {
  const key = `${contract.direction}:${contract.method} ${contract.channel}#${contract.event}`;
  const existing = contracts.get(key);
  if (existing) {
    for (const shape of contract.payloadShapes) existing.payloadShapes.add(shape);
    for (const path of contract.arbitraryPayloads) existing.arbitraryPayloads.add(path);
    existing.sourceEvidence.push({
      sourcePath: contract.sourcePath,
      payloadShapes: new Set(contract.payloadShapes),
    });
    return;
  }
  contracts.set(key, {
    contract: {
      direction: contract.direction,
      method: contract.method,
      channel: contract.channel,
      event: contract.event,
      sourcePath: contract.sourcePath,
    },
    payloadShapes: new Set(contract.payloadShapes),
    arbitraryPayloads: new Set(contract.arbitraryPayloads),
    sourceEvidence: [{
      sourcePath: contract.sourcePath,
      payloadShapes: new Set(contract.payloadShapes),
    }],
  });
}

async function discoverSse(
  repoRoot: string,
  observations: DtoInventoryObservation[],
  seen: Set<string>,
): Promise<void> {
  const contracts = new Map<string, {
    contract: Omit<SseContract, "payloadShapes" | "arbitraryPayloads">;
    payloadShapes: Set<string>;
    arbitraryPayloads: Set<string>;
    sourceEvidence: Array<{
      sourcePath: string;
      payloadShapes: Set<string>;
    }>;
  }>();
  const producerRoot = join(repoRoot, "packages/server/src");
  const producerFiles = await listTypeScriptFiles(producerRoot);
  const producerProgram = ts.createProgram(producerFiles, {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const producerChecker = producerProgram.getTypeChecker();
  for (const producerFile of producerFiles) {
    const sourceFile = producerProgram.getSourceFile(producerFile) ?? await parseTypeScript(producerFile);
    const sourcePath = posixRelative(repoRoot, producerFile);
    const visitRoutes = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const route = resolvedFastifyRoute(
          producerChecker,
          repoRoot,
          producerFile,
          sourceFile,
          node,
        );
        if (route && sourceContainsText(route.handler, "text/event-stream")) {
          let resolvedProducers = 0;
          const addProducedContract = (input: {
            readonly event: string;
            readonly shape: string;
            readonly arbitraryPayloads: readonly string[];
          }): void => {
            resolvedProducers += 1;
            for (const path of route.paths) {
              for (const method of route.methods) {
                addSseContract(contracts, {
                  direction: "produced",
                  method,
                  channel: path,
                  event: input.event,
                  sourcePath,
                  payloadShapes: [input.shape],
                  arbitraryPayloads: input.arbitraryPayloads,
                });
              }
            }
          };
          const visitProducer = (child: ts.Node): void => {
            if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
              const name = child.expression.text;
              const eventArgument = name === "writeSse"
                ? child.arguments[1]
                : name === "writeEvent"
                  ? child.arguments[0]
                  : undefined;
              const payloadArgument = name === "writeSse"
                ? child.arguments[2]
                : name === "writeEvent" && eventArgument && ts.isStringLiteral(eventArgument)
                  ? child.arguments[1]
                  : eventArgument;
              if (eventArgument && ts.isStringLiteral(eventArgument)) {
                const payloadType = payloadArgument
                  ? producerChecker.getTypeAtLocation(payloadArgument)
                  : undefined;
                const payloadShape = payloadArgument && payloadType
                  ? canonicalTypeShape(producerChecker, payloadType, payloadArgument)
                  : "unknown";
                addProducedContract({
                  event: eventArgument.text,
                  shape: payloadShape,
                  arbitraryPayloads: payloadArgument && payloadType
                    ? arbitraryPathsFromCheckedType(
                      producerChecker,
                      payloadType,
                      "event.payload",
                    )
                    : ["event.payload"],
                });
              } else if (eventArgument) {
                const payloads = eventPayloadsFromType(
                  producerChecker,
                  producerChecker.getTypeAtLocation(eventArgument),
                  eventArgument,
                );
                if (payloads.length === 0) {
                  const location = sourceFile.getLineAndCharacterOfPosition(
                    eventArgument.getStart(sourceFile),
                  );
                  throw new Error(
                    `unresolved SSE producer event: ${sourcePath}:${location.line + 1}`,
                  );
                }
                for (const payload of payloads) {
                  addProducedContract({
                    event: payload.event,
                    shape: payload.shape,
                    arbitraryPayloads: payload.arbitraryPayloads,
                  });
                }
              }
            }
            ts.forEachChild(child, visitProducer);
          };
          if (route.handler.body) visitProducer(route.handler.body);
          if (resolvedProducers === 0) {
            throw routeDiscoveryError(
              repoRoot,
              producerFile,
              sourceFile,
              node,
              "SSE route has zero resolved event producers",
            );
          }
        }
      }
      ts.forEachChild(node, visitRoutes);
    };
    visitRoutes(sourceFile);
  }

  const consumerRoots = [
    join(repoRoot, "packages/api-client/src"),
    join(repoRoot, "apps/desktop"),
    join(repoRoot, "apps/workbench/src"),
  ];
  const consumerFiles = (await Promise.all(
    consumerRoots.map((root) => listTypeScriptFiles(root).catch(() => [])),
  )).flat();
  const consumerProgram = ts.createProgram(consumerFiles, {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const consumerChecker = consumerProgram.getTypeChecker();
  for (const consumerFile of consumerFiles) {
    const sourceFile = consumerProgram.getSourceFile(consumerFile)
      ?? await parseTypeScript(consumerFile);
    const sourcePath = posixRelative(repoRoot, consumerFile);
    const eventSources = new Map<ts.Symbol, string>();
    const registerEventSources = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && ts.isNewExpression(node.initializer)
        && node.initializer.arguments?.[0]
        && node.initializer.expression.getText(sourceFile).includes("EventSource")
      ) {
        const channel = endpointFromUrlExpression(
          node.initializer.arguments[0],
          sourceFile,
          new Set<string>(),
          consumerChecker,
        );
        const symbol = consumerChecker.getSymbolAtLocation(node.name);
        if (channel && symbol) eventSources.set(symbol, channel);
      }
      ts.forEachChild(node, registerEventSources);
    };
    registerEventSources(sourceFile);

    const visitConsumers = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && expressionPropertyName(node.expression) === "addEventListener"
        && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0])
        && !["open", "error"].includes(node.arguments[0].text)
      ) {
        const receiver = expressionRootNode(node.expression);
        const receiverSymbol = receiver
          ? consumerChecker.getSymbolAtLocation(receiver)
          : undefined;
        const channel = receiverSymbol ? eventSources.get(receiverSymbol) : undefined;
        if (channel) {
          const evidence = listenerPayloadEvidence(
            consumerChecker,
            node.arguments[1],
            sourceFile,
          );
          addSseContract(contracts, {
            direction: "accepted",
            method: "GET",
            channel,
            event: node.arguments[0].text,
            sourcePath,
            payloadShapes: evidence.shapes,
            arbitraryPayloads: evidence.arbitraryPayloads,
          });
        }
      }
      ts.forEachChild(node, visitConsumers);
    };
    visitConsumers(sourceFile);

    const producedByEvent = new Map<
      string,
      Array<Omit<SseContract, "payloadShapes" | "arbitraryPayloads">>
    >();
    for (const value of contracts.values()) {
      if (value.contract.direction !== "produced") continue;
      const candidates = producedByEvent.get(value.contract.event) ?? [];
      candidates.push(value.contract);
      producedByEvent.set(value.contract.event, candidates);
    }
    const visitRawConsumers = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node)) {
        const event = comparedString(node);
        const rawStreamEvent = event && /^(?:soul|avatar)[.]/.test(event);
        const candidates = rawStreamEvent ? producedByEvent.get(event) ?? [] : [];
        const uniqueChannels = new Map(
          candidates.map((candidate) => [
            `${candidate.method} ${candidate.channel}`,
            candidate,
          ]),
        );
        if (event && rawStreamEvent && uniqueChannels.size === 1) {
          const candidate = [...uniqueChannels.values()][0]!;
          let containingFunction: ts.Node | undefined = node.parent;
          while (containingFunction && !isRuntimeFunction(containingFunction)) {
            containingFunction = containingFunction.parent;
          }
          const evidence = containingFunction && isRuntimeFunction(containingFunction)
            ? functionPayloadEvidence(
              consumerChecker,
              containingFunction,
              sourceFile,
            )
            : {
                shapes: ["unknown"],
                arbitraryPayloads: ["event.payload"],
              };
          addSseContract(contracts, {
            direction: "accepted",
            method: candidate.method,
            channel: candidate.channel,
            event,
            sourcePath,
            payloadShapes: evidence.shapes,
            arbitraryPayloads: evidence.arbitraryPayloads,
          });
        }
      }
      ts.forEachChild(node, visitRawConsumers);
    };
    visitRawConsumers(sourceFile);
  }

  for (const [, value] of [...contracts].sort(([left], [right]) =>
    left.localeCompare(right, "en")
  )) {
    const contract = value.contract;
    const sourceEvidence = [...value.sourceEvidence].sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath, "en")
    );
    const occurrenceBySource = new Map<string, number>();
    addObservation(observations, seen, {
      locator: `sse:${contract.direction}:${contract.method} ${contract.channel}#${contract.event}`,
      transport: "sse",
      direction: contract.direction,
      contract: `${contract.method} ${contract.channel}#${contract.event}`,
      sourcePath: sourceEvidence[0]?.sourcePath ?? contract.sourcePath,
      structuralSignatures: contract.direction === "accepted"
        ? sourceEvidence.flatMap((evidence) => {
          const occurrence = (occurrenceBySource.get(evidence.sourcePath) ?? 0) + 1;
          occurrenceBySource.set(evidence.sourcePath, occurrence);
          return [...evidence.payloadShapes]
            .sort()
            .map((shape) =>
              `consumer:${evidence.sourcePath}#${occurrence}:event.payload:${shape}`
            );
        })
        : [...value.payloadShapes]
          .sort()
          .map((shape) => `event.payload:${shape}`),
      arbitraryPayloads: [...value.arbitraryPayloads].sort(),
    });
  }
}

export async function discoverSseDtoInventory(
  repoRoot: string,
): Promise<readonly DtoInventoryObservation[]> {
  const observations: DtoInventoryObservation[] = [];
  await discoverSse(repoRoot, observations, new Set<string>());
  return observations.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

function unionConstituents(
  declarations: ReadonlyMap<string, NamedDeclaration>,
  unionName: string,
): string[] {
  const declaration = declarations.get(unionName);
  if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`Unable to find ${unionName} type alias`);
  }
  return referencedTypeNames(declaration.type);
}

type NamedDtoSources = {
  readonly sourceFiles: ReadonlyMap<string, ts.SourceFile>;
  readonly relaySourceFiles: readonly ts.SourceFile[];
};

async function createNamedDtoSources(repoRoot: string): Promise<NamedDtoSources> {
  const relayFiles = (await listTypeScriptFiles(join(repoRoot, "packages/relay/src")))
    .filter((file) => !/\.(?:test|spec)\.tsx?$/.test(file));
  const files = [...new Set([
    "packages/server/src/messaging/dispatch.ts",
    "packages/types/src/api.ts",
    "packages/relay/src/protocol.ts",
    "apps/workbench/src/apps/app-bridge.ts",
  ].map((path) => join(repoRoot, path)).concat(relayFiles))];
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [file, sourceFile] of await Promise.all(
    files.map(async (file) => [file, await parseTypeScript(file)] as const),
  )) {
    sourceFiles.set(file, sourceFile);
  }
  return {
    sourceFiles,
    relaySourceFiles: relayFiles.map((file) => {
      const sourceFile = sourceFiles.get(file);
      if (!sourceFile) throw new Error(`Unable to parse relay source: ${file}`);
      return sourceFile;
    }),
  };
}

async function discoverRelay(
  repoRoot: string,
  observations: DtoInventoryObservation[],
  seen: Set<string>,
  namedSources: NamedDtoSources,
): Promise<{ readonly client: ReadonlySet<string>; readonly server: ReadonlySet<string> }> {
  const file = join(repoRoot, "packages/relay/src/protocol.ts");
  const sourceFile = namedSources.sourceFiles.get(file) ?? await parseTypeScript(file);
  const relayDeclarations = namedDeclarations(namedSources.relaySourceFiles);
  const client = new Set(unionConstituents(relayDeclarations, "RelayClientMessage"));
  const server = new Set(unionConstituents(relayDeclarations, "RelayServerMessage"));

  for (const [direction, names] of [
    ["client_to_server", client],
    ["server_to_client", server],
  ] as const) {
    for (const name of [...names].sort()) {
      const declaration = relayDeclarations.get(name);
      if (!declaration) throw new Error(`Unable to resolve relay frame: ${name}`);
      const declarationSource = declaration.getSourceFile();
      const sourcePath = posixRelative(repoRoot, declarationSource.fileName);
      const declarations = namedDeclarations(
        declarationSource === sourceFile
          ? [sourceFile]
          : [sourceFile, declarationSource],
      );
      for (const frameType of stringLiteralValues(propertyType(declaration, "type"))) {
        addObservation(observations, seen, {
          locator: `relay:${direction}:${frameType}`,
          transport: "relay",
          direction,
          contract: name,
          sourcePath,
          structuralSignatures: [
            `frame.payload:${namedDeclarationShape(declaration, declarations)}`,
          ],
          arbitraryPayloads: arbitraryPathsForDeclaration(declaration, declarations),
        });
      }
    }
  }
  return { client, server };
}

async function discoverAppBridge(
  repoRoot: string,
  observations: DtoInventoryObservation[],
  seen: Set<string>,
  namedSources: NamedDtoSources,
): Promise<ReadonlySet<string>> {
  const file = join(repoRoot, "apps/workbench/src/apps/app-bridge.ts");
  const sourceFile = namedSources.sourceFiles.get(file) ?? await parseTypeScript(file);
  const declarations = namedDeclarations([sourceFile]);
  const requestNames = new Set(unionConstituents(declarations, "AppBridgeRequest"));
  const sourcePath = posixRelative(repoRoot, file);

  for (const name of [...requestNames].sort()) {
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Unable to resolve app-bridge request: ${name}`);
    const frameTypes = stringLiteralValues(propertyType(declaration, "type"));
    const operations = stringLiteralValues(propertyType(declaration, "op"));
    for (const frameType of frameTypes) {
      for (const suffix of operations.length > 0 ? operations.map((operation) => `#${operation}`) : [""]) {
        addObservation(observations, seen, {
          locator: `app_bridge:app_to_host:${frameType}${suffix}`,
          transport: "app_bridge",
          direction: "app_to_host",
          contract: name,
          sourcePath,
          structuralSignatures: [
            `frame.payload:${namedDeclarationShape(declaration, declarations)}`,
          ],
          arbitraryPayloads: arbitraryPathsForDeclaration(declaration, declarations),
        });
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && expressionPropertyName(node.expression) === "postMessage"
    ) {
      for (const argument of node.arguments) {
        for (const frameType of stringTypeProperties(argument)) {
          addObservation(observations, seen, {
            locator: `app_bridge:host_to_app:${frameType}`,
            transport: "app_bridge",
            direction: "host_to_app",
            contract: frameType,
            sourcePath,
            arbitraryPayloads: [],
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return requestNames;
}

function containsModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function namedTypeShape(
  node: ts.TypeNode | undefined,
  declarations: ReadonlyMap<string, NamedDeclaration>,
  active = new Set<string>(),
): string {
  if (!node) return "unresolved";
  if (ts.isParenthesizedTypeNode(node)) {
    return namedTypeShape(node.type, declarations, active);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    const separator = ts.isUnionTypeNode(node) ? "|" : "&";
    return [...new Set(node.types.map((member) =>
      namedTypeShape(member, declarations, new Set(active))
    ))].sort().join(separator);
  }
  if (ts.isArrayTypeNode(node)) {
    return `${namedTypeShape(node.elementType, declarations, active)}[]`;
  }
  if (ts.isTupleTypeNode(node)) {
    return `[${node.elements.map((member) =>
      namedTypeShape(member, declarations, new Set(active))
    ).join(",")}]`;
  }
  if (ts.isTypeOperatorNode(node)) return namedTypeShape(node.type, declarations, active);
  if (ts.isLiteralTypeNode(node)) return node.literal.getText();
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    if ((name === "Array" || name === "ReadonlyArray") && node.typeArguments?.[0]) {
      return `${namedTypeShape(node.typeArguments[0], declarations, active)}[]`;
    }
    if (name === "Record" && node.typeArguments?.[0] && node.typeArguments[1]) {
      return `{[key:${namedTypeShape(node.typeArguments[0], declarations, active)}]:${
        namedTypeShape(node.typeArguments[1], declarations, active)
      }}`;
    }
    const declaration = declarations.get(name);
    if (declaration && !active.has(name)) {
      const next = new Set(active);
      next.add(name);
      return namedDeclarationShape(declaration, declarations, next);
    }
    return declaration ? "recursive" : `unresolved<${name}>`;
  }
  if (ts.isTypeLiteralNode(node)) {
    return namedMemberShape(node.members, declarations, active);
  }
  const keyword = new Map<ts.SyntaxKind, string>([
    [ts.SyntaxKind.AnyKeyword, "any"],
    [ts.SyntaxKind.UnknownKeyword, "unknown"],
    [ts.SyntaxKind.StringKeyword, "string"],
    [ts.SyntaxKind.NumberKeyword, "number"],
    [ts.SyntaxKind.BooleanKeyword, "boolean"],
    [ts.SyntaxKind.NullKeyword, "null"],
    [ts.SyntaxKind.UndefinedKeyword, "undefined"],
    [ts.SyntaxKind.VoidKeyword, "void"],
    [ts.SyntaxKind.NeverKeyword, "never"],
  ]).get(node.kind);
  return keyword ?? node.getText().replace(/\s+/gu, " ");
}

function namedMemberShape(
  members: ts.NodeArray<ts.TypeElement>,
  declarations: ReadonlyMap<string, NamedDeclaration>,
  active: ReadonlySet<string>,
): string {
  const fields = members.flatMap((member) => {
    if (ts.isPropertySignature(member)) {
      const name = propertyNameText(member.name);
      if (!name) return [];
      return [`${name}${member.questionToken ? "?" : ""}:${
        namedTypeShape(member.type, declarations, new Set(active))
      }`];
    }
    if (ts.isIndexSignatureDeclaration(member)) {
      const keyType = member.parameters[0]?.type;
      return [`[key:${namedTypeShape(keyType, declarations, new Set(active))}]:${
        namedTypeShape(member.type, declarations, new Set(active))
      }`];
    }
    return [];
  });
  return `{${fields.sort().join(";")}}`;
}

function namedDeclarationShape(
  declaration: NamedDeclaration,
  declarations: ReadonlyMap<string, NamedDeclaration>,
  active = new Set<string>([declaration.name.text]),
): string {
  return ts.isInterfaceDeclaration(declaration)
    ? namedMemberShape(declaration.members, declarations, active)
    : namedTypeShape(declaration.type, declarations, active);
}

function arbitraryPathsFromNamedType(
  node: ts.TypeNode | undefined,
  prefix: string,
  declarations: ReadonlyMap<string, NamedDeclaration>,
  active = new Set<string>(),
): string[] {
  if (!node) return prefix ? [prefix] : [];
  if (
    node.kind === ts.SyntaxKind.UnknownKeyword
    || node.kind === ts.SyntaxKind.AnyKeyword
  ) {
    return prefix ? [prefix] : [];
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return arbitraryPathsFromNamedType(node.type, prefix, declarations, active);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.flatMap((member) =>
      arbitraryPathsFromNamedType(member, prefix, declarations, new Set(active))
    );
  }
  if (ts.isArrayTypeNode(node)) {
    return arbitraryPathsFromNamedType(
      node.elementType,
      `${prefix}[]`,
      declarations,
      active,
    );
  }
  if (ts.isTupleTypeNode(node)) {
    return node.elements.flatMap((member, index) =>
      arbitraryPathsFromNamedType(
        member,
        `${prefix}[${index}]`,
        declarations,
        new Set(active),
      )
    );
  }
  if (ts.isTypeOperatorNode(node)) {
    return arbitraryPathsFromNamedType(node.type, prefix, declarations, active);
  }
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const typeName = node.typeName.text;
    if (typeName === "Record" && node.typeArguments?.[1]) {
      return arbitraryPathsFromNamedType(
        node.typeArguments[1],
        prefix,
        declarations,
        active,
      ).length > 0 && prefix ? [prefix] : [];
    }
    if ((typeName === "Array" || typeName === "ReadonlyArray") && node.typeArguments?.[0]) {
      return arbitraryPathsFromNamedType(
        node.typeArguments[0],
        `${prefix}[]`,
        declarations,
        active,
      );
    }
    const declaration = declarations.get(typeName);
    if (!declaration) return prefix ? [prefix] : [];
    if (active.has(typeName)) return [];
    const next = new Set(active);
    next.add(typeName);
    return arbitraryPathsForDeclaration(declaration, declarations, prefix, next);
  }
  if (ts.isTypeLiteralNode(node)) {
    return arbitraryPathsFromNamedMembers(node.members, prefix, declarations, active);
  }
  return [];
}

function arbitraryPathsFromNamedMembers(
  members: ts.NodeArray<ts.TypeElement>,
  prefix: string,
  declarations: ReadonlyMap<string, NamedDeclaration>,
  active: ReadonlySet<string>,
): string[] {
  return members.flatMap((member) => {
    if (ts.isPropertySignature(member)) {
      const name = propertyNameText(member.name);
      if (!name) return [];
      return arbitraryPathsFromNamedType(
        member.type,
        prefix ? `${prefix}.${name}` : name,
        declarations,
        new Set(active),
      );
    }
    if (ts.isIndexSignatureDeclaration(member)) {
      return arbitraryPathsFromNamedType(
        member.type,
        prefix ? `${prefix}.[key]` : "[key]",
        declarations,
        new Set(active),
      );
    }
    return [];
  });
}

function arbitraryPathsForDeclaration(
  declaration: NamedDeclaration,
  declarations: ReadonlyMap<string, NamedDeclaration>,
  prefix = "",
  active = new Set<string>([declaration.name.text]),
): string[] {
  const paths = ts.isInterfaceDeclaration(declaration)
    ? arbitraryPathsFromNamedMembers(declaration.members, prefix, declarations, active)
    : arbitraryPathsFromNamedType(declaration.type, prefix, declarations, active);
  return [...new Set(paths)].sort();
}

function httpArbitraryDirection(name: string): DtoDirection {
  if (/Response$/.test(name)) return "produced_arbitrary";
  return "accepted_arbitrary";
}

function relayArbitraryDirection(
  name: string,
  clientNames: ReadonlySet<string>,
  serverNames: ReadonlySet<string>,
): DtoDirection {
  if (clientNames.has(name)) return "client_to_server_arbitrary";
  if (serverNames.has(name)) return "server_to_client_arbitrary";
  return "declared_arbitrary";
}

function appBridgeArbitraryDirection(
  name: string,
  requestNames: ReadonlySet<string>,
): DtoDirection {
  return requestNames.has(name) ? "app_to_host_arbitrary" : "host_to_app_arbitrary";
}

async function discoverArbitraryContracts(
  repoRoot: string,
  observations: DtoInventoryObservation[],
  seen: Set<string>,
  relayNames: { readonly client: ReadonlySet<string>; readonly server: ReadonlySet<string> },
  appBridgeRequestNames: ReadonlySet<string>,
  namedSources: NamedDtoSources,
): Promise<void> {
  const configurations = [
    {
      file: "packages/server/src/messaging/dispatch.ts",
      transport: "http" as const,
      include: (declaration: NamedDeclaration) => declaration.name.text === "RoomPostMessageBody",
      direction: (name: string) => httpArbitraryDirection(name),
    },
    {
      file: "packages/types/src/api.ts",
      transport: "http" as const,
      include: (declaration: NamedDeclaration) =>
        exported(declaration) || containsModifier(declaration, ts.SyntaxKind.DefaultKeyword),
      direction: (name: string) => httpArbitraryDirection(name),
    },
    {
      file: "packages/relay/src/protocol.ts",
      transport: "relay" as const,
      include: (declaration: NamedDeclaration) => exported(declaration),
      direction: (name: string) =>
        relayArbitraryDirection(name, relayNames.client, relayNames.server),
    },
    {
      file: "apps/workbench/src/apps/app-bridge.ts",
      transport: "app_bridge" as const,
      include: (_declaration: NamedDeclaration) => true,
      direction: (name: string) => appBridgeArbitraryDirection(name, appBridgeRequestNames),
    },
  ];

  for (const configuration of configurations) {
    const absolutePath = join(repoRoot, configuration.file);
    const sourceFile = namedSources.sourceFiles.get(absolutePath)
      ?? await parseTypeScript(absolutePath);
    const declarations = namedDeclarations([sourceFile]);
    for (const declaration of [...declarations.values()].sort((left, right) =>
      left.name.text.localeCompare(right.name.text, "en")
    )) {
      if (!configuration.include(declaration)) continue;
      const arbitraryPayloads = arbitraryPathsForDeclaration(declaration, declarations);
      if (arbitraryPayloads.length === 0) continue;
      const direction = configuration.direction(declaration.name.text);
      addObservation(observations, seen, {
        locator: `${configuration.transport}:${direction}:${configuration.file}#${declaration.name.text}`,
        transport: configuration.transport,
        direction,
        contract: declaration.name.text,
        sourcePath: configuration.file,
        structuralSignatures: [
          `declaration.payload:${namedDeclarationShape(declaration, declarations)}`,
        ],
        arbitraryPayloads,
      });
    }
  }
}

export async function discoverNamedDtoInventory(
  repoRoot: string,
): Promise<readonly DtoInventoryObservation[]> {
  const observations: DtoInventoryObservation[] = [];
  const seen = new Set<string>();
  const namedSources = await createNamedDtoSources(repoRoot);
  const relayNames = await discoverRelay(repoRoot, observations, seen, namedSources);
  const appBridgeRequestNames =
    await discoverAppBridge(repoRoot, observations, seen, namedSources);
  await discoverArbitraryContracts(
    repoRoot,
    observations,
    seen,
    relayNames,
    appBridgeRequestNames,
    namedSources,
  );
  return observations.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

/**
 * Enumerate actual Nautilo wire boundaries without importing product runtime
 * modules. The result contains repository-relative paths only and is stable
 * across machines and checkout locations.
 */
export async function discoverDtoInventory(repoRoot: string): Promise<readonly DtoInventoryObservation[]> {
  const observations: DtoInventoryObservation[] = [];
  const seen = new Set<string>();

  await discoverHttp(repoRoot, observations, seen);
  discoverServerEvents(repoRoot, observations, seen);
  await discoverProductWsFrames(repoRoot, observations, seen);
  await discoverSse(repoRoot, observations, seen);
  for (const item of await discoverNamedDtoInventory(repoRoot)) {
    if (seen.has(item.locator)) continue;
    seen.add(item.locator);
    observations.push(item);
  }

  return observations.sort((left, right) => left.id.localeCompare(right.id, "en"));
}
