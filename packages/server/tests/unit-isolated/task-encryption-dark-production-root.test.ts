import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { createLiveShadowDataOperationPolicyBinding } from "@nautilo/runtime";
import ts from "typescript";

const appSource = sourceFile("../../src/app.ts");
const initialCompositionSource = sourceFile(
  "../../src/routes/protected-task-runtime-initial-composition.ts",
);

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

describe("live Task production composition", () => {
  test("shares one live policy owner across ordinary and protected Task entry points", () => {
    const owner = variableNamed(appSource, "taskContentOwner");
    expect(owner.initializer !== undefined && ts.isCallExpression(owner.initializer)).toBe(true);
    const ownerCall = owner.initializer as ts.CallExpression;
    expect(identifierName(ownerCall.expression)).toBe("bindEncryptionDataOperationOwner");
    const ownerPolicy = propertyNamed(objectArgument(ownerCall, 0), "policy");
    expect(ownerPolicy !== undefined && ts.isPropertyAssignment(ownerPolicy)).toBe(true);
    expect((ownerPolicy as ts.PropertyAssignment).initializer.getText(appSource))
      .toBe("taskContentPolicy");
    const policy = variableNamed(appSource, "taskContentPolicy");
    const policyBindings = descendants(policy, ts.isCallExpression).filter((call) =>
      identifierName(call.expression) === "createLiveShadowDataOperationPolicyBinding"
    );
    expect(policyBindings).toHaveLength(1);
    expect(descendants(policyBindings[0]!, ts.isIdentifier).map(identifier => identifier.text))
      .toContain("getEncryptionTransitionPolicy");
    expect(stringPropertyValues(ownerCall, "mode")).toEqual([]);
    expect(stringPropertyValues(policy, "mode")).toEqual([]);

    const routes = objectArgument(callNamed(appSource, "tasksRoutes"), 1);
    const routeOwner = propertyNamed(routes, "contentOwner");
    expect(routeOwner !== undefined && ts.isPropertyAssignment(routeOwner)).toBe(true);
    expect((routeOwner as ts.PropertyAssignment).initializer.getText(appSource))
      .toBe("taskContentOwner");

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
        && call.expression.expression.text === "taskContentOwner"
        && call.expression.name.text === "runMutation");
    expect(admissionCalls).toHaveLength(1);
    const admissionBranches = objectArgument(admissionCalls[0]!, 0);
    expect(resolvedBoolean(propertyNamed(admissionBranches, "ordinary"))).toBe(true);
    expect(resolvedBoolean(propertyNamed(admissionBranches, "dual"))).toBe(false);
    expect(resolvedBoolean(propertyNamed(admissionBranches, "protected"))).toBe(false);

    const liveMessages = objectArgument(
      callNamed(appSource, "createProductionLiveShadowMessageComposition"),
      0,
    );
    const messageTaskOwner = propertyNamed(liveMessages, "taskContentOwner");
    expect(messageTaskOwner !== undefined && ts.isPropertyAssignment(messageTaskOwner)).toBe(true);
    expect((messageTaskOwner as ts.PropertyAssignment).initializer.getText(appSource))
      .toContain("taskContentOwner");
    const replyAcceptance = propertyNamed(
      liveMessages,
      "onSharedAgentHumanPublished",
    );
    expect(replyAcceptance !== undefined).toBe(true);
    const acceptanceCalls = descendants(replyAcceptance!, ts.isCallExpression)
      .filter(call => identifierName(call.expression)
        === "acceptPublishedProtectedTaskReply");
    expect(acceptanceCalls).toHaveLength(1);
    expect(acceptanceCalls[0]!.arguments.map(argument => argument.getText(appSource)))
      .toEqual(["getServerDirectDb()", "message"]);
    const acceptanceIdentifiers = descendants(replyAcceptance!, ts.isIdentifier)
      .map(identifier => identifier.text);
    expect(acceptanceIdentifiers).toContain("getTaskObserver");
    expect(acceptanceIdentifiers).toContain("kick");
    const acceptanceStatuses = descendants(replyAcceptance!, ts.isStringLiteral)
      .map(value => value.text);
    expect(acceptanceStatuses).toEqual(["accepted", "exact_replay"]);

    const response = objectArgument(callNamed(appSource, "createProtectedTaskHumanResponse"), 0);
    expect((propertyNamed(response, "owner") as ts.PropertyAssignment)
      .initializer.getText(appSource)).toBe("taskContentOwner");

    const protectedDependencies = variableNamed(
      appSource,
      "taskProtectedHttpDependencies",
    );
    expect(
      protectedDependencies.initializer !== undefined
        && ts.isObjectLiteralExpression(protectedDependencies.initializer),
    ).toBe(true);
    const protectedDependencyObject =
      protectedDependencies.initializer as ts.ObjectLiteralExpression;
    expect((propertyNamed(protectedDependencyObject, "owner") as ts.PropertyAssignment)
      .initializer.getText(appSource)).toBe("taskContentOwner");

    const protectedRoutes = callNamed(
      appSource,
      "createProductionProtectedTaskComposition",
    );
    expect(protectedRoutes.arguments[0]?.getText(appSource))
      .toBe("taskProtectedHttpDependencies");
    const fallbackRoutes = callNamed(appSource, "createTaskOrdinaryFallbackPorts");
    expect(fallbackRoutes.arguments[0]?.getText(appSource))
      .toBe("taskProtectedHttpDependencies");
  });

  test("mounts protected repair and occurrence recovery behind the live owner", () => {
    const identifiers = new Set(
      descendants(appSource, ts.isIdentifier).map((identifier) => identifier.text),
    );
    for (const binding of [
      "taskContentBackfillRoutes",
      "createProductionTaskContentBackfillComposition",
      "createProductionProtectedTaskRuntimeInitialComposition",
      "protectedTaskPendingAttentionRoutes",
    ] as const) {
      expect(identifiers.has(binding), `${binding} must be in app composition`).toBe(true);
    }

    const backfill = callNamed(appSource, "createProductionTaskContentBackfillComposition");
    const backfillOptions = objectArgument(backfill, 0);
    const backfillOwner = propertyNamed(backfillOptions, "owner");
    expect(backfillOwner !== undefined && ts.isPropertyAssignment(backfillOwner)).toBe(true);
    expect((backfillOwner as ts.PropertyAssignment).initializer.getText(appSource))
      .toBe("taskContentOwner");

    const runtime = callNamed(
      appSource,
      "createProductionProtectedTaskRuntimeInitialComposition",
    );
    const runtimeOptions = objectArgument(runtime, 0);
    expect((propertyNamed(runtimeOptions, "owner") as ts.PropertyAssignment)
      .initializer.getText(appSource)).toBe("taskContentOwner");
    expect((propertyNamed(runtimeOptions, "recipients") as ts.PropertyAssignment)
      .initializer.getText(appSource)).toBe("taskRuntimeRecipients");

    const observerCreations = descendants(appSource, ts.isNewExpression)
      .filter((creation) => identifierName(creation.expression) === "TaskObserver");
    expect(observerCreations).toHaveLength(1);
    const observerOptions = observerCreations[0]?.arguments?.[0];
    expect(observerOptions !== undefined && ts.isObjectLiteralExpression(observerOptions)).toBe(true);
    const observerIdentifiers = descendants(observerOptions!, ts.isIdentifier)
      .map((identifier) => identifier.text);
    expect(observerIdentifiers).toContain("protectedOccurrencePort");
    expect(observerIdentifiers).toContain("protectedOccurrenceRecoveryPort");

    const occurrenceOwner = callNamed(appSource, "createTaskOccurrencePolicyPorts");
    expect(occurrenceOwner.arguments[0]?.getText(appSource)).toBe("taskContentOwner");
    expect(descendants(occurrenceOwner, ts.isIdentifier).map(identifier => identifier.text))
      .toContain("initializeProtectedTaskRuntime");
    expect(observerIdentifiers).toContain("ordinaryOccurrencePort");
    expect(observerIdentifiers).toContain("taskOccurrencePolicy");
    const observerMaintenance = propertyNamed(observerOptions as ts.ObjectLiteralExpression, "maintenanceGate");
    expect(observerMaintenance !== undefined && ts.isShorthandPropertyAssignment(observerMaintenance)).toBeTrue();
    expect(observerIdentifiers).not.toContain("strictBackgroundMaintenanceGate");

    const mountedCapability = descendants(appSource, ts.isPropertyAssignment)
      .filter(property => property.name !== undefined
        && identifierName(property.name) === "assertCurrentMountedCapabilities");
    expect(mountedCapability).toHaveLength(1);
    const mountedIdentifiers = descendants(mountedCapability[0]!, ts.isIdentifier)
      .map(identifier => identifier.text);
    expect(mountedIdentifiers).toContain("initializeProtectedTaskRuntime");
    expect(mountedIdentifiers).not.toContain("currentProtectedTaskRuntime");

    const background = objectArgument(
      callNamed(appSource, "createProductionBackgroundAuthorizationComposition"),
      0,
    );
    const backgroundIdentifiers = descendants(background, ts.isIdentifier)
      .map((identifier) => identifier.text);
    expect(backgroundIdentifiers).toContain("isTaskRecipientActive");
    expect(backgroundIdentifiers).toContain("bindTaskRecipient");
    expect(backgroundIdentifiers).toContain("withTaskAuthority");
  });

  test("forwards authorization requests from every protected output preparation", () => {
    for (const factory of [
      "createProtectedTaskCancellationComposition",
      "createProtectedTaskOutputReadComposition",
      "terminalMessageComposition",
      "createProtectedTaskRuntimeParkedPreparation",
    ] as const) {
      const options = objectArgument(
        callNamed(initialCompositionSource, factory),
        0,
      );
      const forwarded = propertyNamed(options, "authorizationRequested");
      expect(
        forwarded !== undefined && ts.isPropertyAssignment(forwarded),
        `${factory} must forward authorizationRequested`,
      ).toBe(true);
      expect((forwarded as ts.PropertyAssignment).initializer.getText(
        initialCompositionSource,
      )).toBe("input.authorizationRequested");
    }
  });

  test("Plain does not initialize protected work while Shadow and Full select it", async () => {
    let mode: "plaintext_only" | "shadow_encryption" | "encrypted_only" =
      "plaintext_only";
    let revision = 1;
    const readPolicy = mock(async () => ({
      mode,
      shadowBehavior: "fallback" as const,
      revision,
    }));
    const initializeProtected = mock(async () => "protected-runtime");
    const owner = bindEncryptionDataOperationOwner({
      policy: createLiveShadowDataOperationPolicyBinding(readPolicy),
    });
    const selectRuntime = () => owner.runMutation({
      ordinary: () => Promise.resolve(null),
      dual: initializeProtected,
      protected: initializeProtected,
    });

    expect(await selectRuntime()).toBeNull();
    expect(initializeProtected).not.toHaveBeenCalled();

    mode = "shadow_encryption";
    revision += 1;
    expect(await selectRuntime()).toBe("protected-runtime");

    mode = "encrypted_only";
    revision += 1;
    expect(await selectRuntime()).toBe("protected-runtime");
    expect(initializeProtected).toHaveBeenCalledTimes(2);
    expect(readPolicy.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  test("registers the same Desktop Task repair channels in main and preload", () => {
    const desktopSources = [
      sourceFile("../../../../apps/desktop/electron/main.ts"),
      sourceFile("../../../../apps/desktop/electron/preload.ts"),
    ];
    const channels = desktopSources.flatMap((source) =>
      descendants(source, ts.isStringLiteral).map((literal) => literal.text)
    );
    expect(channels.filter((channel) =>
      channel.startsWith("foregroundShadow:taskContentBackfill:")
    ).sort()).toEqual([
      "foregroundShadow:taskContentBackfill:cancel",
      "foregroundShadow:taskContentBackfill:cancel",
      "foregroundShadow:taskContentBackfill:progress",
      "foregroundShadow:taskContentBackfill:progress",
      "foregroundShadow:taskContentBackfill:service",
      "foregroundShadow:taskContentBackfill:service",
    ]);
  });
});
