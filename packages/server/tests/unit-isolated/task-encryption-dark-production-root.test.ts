import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const appSource = sourceFile("../../src/app.ts");

function sourceFile(relativePath: string): ts.SourceFile {
  const path = new URL(relativePath, import.meta.url);
  return ts.createSourceFile(
    path.pathname,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function descendants<Node extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is Node,
): Node[] {
  const found: Node[] = [];
  function visit(node: ts.Node): void {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

function identifierName(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function callNamed(root: ts.Node, name: string): ts.CallExpression {
  const calls = descendants(root, ts.isCallExpression)
    .filter((call) => identifierName(call.expression) === name);
  expect(calls, `expected one ${name}(...) production call`).toHaveLength(1);
  return calls[0]!;
}

function variableNamed(root: ts.Node, name: string): ts.VariableDeclaration {
  const declarations = descendants(root, ts.isVariableDeclaration)
    .filter((declaration) => ts.isIdentifier(declaration.name)
      && declaration.name.text === name);
  expect(declarations, `expected one ${name} production binding`).toHaveLength(1);
  return declarations[0]!;
}

function objectArgument(call: ts.CallExpression, index: number): ts.ObjectLiteralExpression {
  const argument = call.arguments[index];
  expect(argument !== undefined && ts.isObjectLiteralExpression(argument)).toBe(true);
  return argument as ts.ObjectLiteralExpression;
}

function propertyNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => property.name !== undefined
    && identifierName(property.name) === name);
}

function propertyNames(object: ts.ObjectLiteralExpression): string[] {
  return object.properties.flatMap((property) => {
    if (property.name === undefined) return [];
    const name = identifierName(property.name);
    return name === null ? [] : [name];
  });
}

function stringPropertyValues(root: ts.Node, name: string): string[] {
  return descendants(root, ts.isPropertyAssignment)
    .filter((property) => property.name !== undefined
      && identifierName(property.name) === name)
    .flatMap((property) => {
      const initializer = ts.isAsExpression(property.initializer)
        ? property.initializer.expression
        : property.initializer;
      return ts.isStringLiteral(initializer) ? [initializer.text] : [];
    });
}

function resolvedBoolean(
  property: ts.ObjectLiteralElementLike | undefined,
): boolean | null {
  if (property === undefined || !ts.isPropertyAssignment(property)) return null;
  const calls = descendants(property.initializer, ts.isCallExpression)
    .filter((call) => ts.isPropertyAccessExpression(call.expression)
      && ts.isIdentifier(call.expression.expression)
      && call.expression.expression.text === "Promise"
      && call.expression.name.text === "resolve");
  if (calls.length !== 1) return null;
  const value = calls[0]?.arguments[0];
  if (value?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

describe("dark Task production composition", () => {
  test("keeps the Task HTTP and tool owners fixed to ordinary content", () => {
    const owner = variableNamed(appSource, "dormantTaskContentOwner");
    expect(owner.initializer !== undefined && ts.isCallExpression(owner.initializer)).toBe(true);
    const ownerCall = owner.initializer as ts.CallExpression;
    expect(identifierName(ownerCall.expression)).toBe("bindEncryptionDataOperationOwner");
    expect(stringPropertyValues(ownerCall, "mode")).toEqual(["plaintext_only"]);
    expect(stringPropertyValues(ownerCall, "shadowBehavior")).toEqual(["fallback"]);
    expect(descendants(ownerCall, ts.isCallExpression).some((call) =>
      identifierName(call.expression) === "createLiveShadowDataOperationPolicyBinding"
    )).toBe(false);

    const routes = objectArgument(callNamed(appSource, "tasksRoutes"), 1);
    const routeOwner = propertyNamed(routes, "contentOwner");
    expect(routeOwner !== undefined && ts.isPropertyAssignment(routeOwner)).toBe(true);
    expect((routeOwner as ts.PropertyAssignment).initializer.getText(appSource))
      .toBe("dormantTaskContentOwner");

    const runtimeCalls = descendants(appSource, ts.isCallExpression)
      .filter((call) => identifierName(call.expression) === "setTaskToolRuntime")
      .filter((call) => call.arguments[0] !== undefined
        && ts.isObjectLiteralExpression(call.arguments[0]));
    expect(runtimeCalls, "expected one configured Task tool runtime").toHaveLength(1);
    const runtime = objectArgument(runtimeCalls[0]!, 0);
    const legacyAdmission = propertyNamed(runtime, "canUseLegacyTaskContent");
    expect(legacyAdmission !== undefined).toBe(true);
    const admissionCalls = descendants(legacyAdmission!, ts.isCallExpression)
      .filter((call) => ts.isPropertyAccessExpression(call.expression)
        && ts.isIdentifier(call.expression.expression)
        && call.expression.expression.text === "dormantTaskContentOwner"
        && call.expression.name.text === "runMutation");
    expect(admissionCalls).toHaveLength(1);
    const admissionBranches = objectArgument(admissionCalls[0]!, 0);
    expect(resolvedBoolean(propertyNamed(admissionBranches, "ordinary"))).toBe(true);
    expect(resolvedBoolean(propertyNamed(admissionBranches, "dual"))).toBe(false);
    expect(resolvedBoolean(propertyNamed(admissionBranches, "protected"))).toBe(false);
  });

  test("leaves protected routes, backfill, observer claims, and recipient binding unregistered", () => {
    const forbiddenProductionBindings = [
      "protectedTaskRoutes",
      "createProductionProtectedTaskComposition",
      "createProtectedTaskProductionWiring",
      "taskContentBackfillRoutes",
      "createProtectedTaskReplyReconciler",
    ] as const;
    const identifiers = new Set(
      descendants(appSource, ts.isIdentifier).map((identifier) => identifier.text),
    );
    for (const binding of forbiddenProductionBindings) {
      expect(identifiers.has(binding), `${binding} must stay out of app composition`).toBe(false);
    }

    const observerCreations = descendants(appSource, ts.isNewExpression)
      .filter((creation) => identifierName(creation.expression) === "TaskObserver");
    expect(observerCreations).toHaveLength(1);
    const observerOptions = observerCreations[0]?.arguments?.[0];
    expect(observerOptions !== undefined && ts.isObjectLiteralExpression(observerOptions)).toBe(true);
    expect(propertyNames(observerOptions as ts.ObjectLiteralExpression)).not.toContain(
      "protectedOccurrenceAdmission",
    );
    expect(propertyNames(observerOptions as ts.ObjectLiteralExpression)).not.toContain(
      "protectedOccurrencePort",
    );

    const background = objectArgument(
      callNamed(appSource, "createProductionBackgroundAuthorizationComposition"),
      0,
    );
    expect(propertyNames(background)).not.toContain("taskRuntimeAdmission");
    expect(propertyNames(background)).not.toContain("isTaskRecipientActive");
    expect(propertyNames(background)).not.toContain("bindTaskRecipient");
  });

  test("does not register a Desktop Task backfill or repair channel", () => {
    const desktopSources = [
      sourceFile("../../../../apps/desktop/electron/main.ts"),
      sourceFile("../../../../apps/desktop/electron/preload.ts"),
    ];
    const channels = desktopSources.flatMap((source) =>
      descendants(source, ts.isStringLiteral).map((literal) => literal.text)
    );
    expect(channels.filter((channel) =>
      channel.startsWith("foregroundShadow:taskBackfill:")
    )).toEqual([]);
  });
});
