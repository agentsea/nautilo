import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("M301 foreground Agent execution result wiring", () => {
  test("uses current Full execution policy for protected Shadow-origin history", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const source = await Bun.file(join(
      repoRoot,
      "packages/server/src/routes/live-shadow-message-composition.ts",
    )).text();
    const runAgentStart = source.indexOf("runAgentTurn: async <Value>");
    const authorityStart = source.indexOf(
      "authority = await createPostgresDomainKeyV2LiveShadowCurrentAuthority({",
      runAgentStart,
    );
    const authorityEnd = source.indexOf("});", authorityStart);
    const authorityInput = source.slice(authorityStart, authorityEnd);

    expect(authorityStart).toBeGreaterThan(runAgentStart);
    expect(authorityInput).toContain(
      'representationMode: policy.mode === "encrypted_only"',
    );
    expect(authorityInput).not.toContain("representationMode: retained.source");
    expect(source.slice(runAgentStart, authorityStart)).toContain(
      "policy.revision !== foregroundPlan.policyRevision",
    );
  });

  test("does not confuse a successful null Agent result with a missing Namespace key", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const source = await Bun.file(join(
      repoRoot,
      "packages/server/src/routes/live-shadow-message-composition.ts",
    )).text();
    const runAgentStart = source.indexOf("runAgentTurn: async <Value>");
    const start = source.indexOf(
      "const executed = await entityCrypto.execute({",
      runAgentStart,
    );
    const end = source.indexOf(
      "return agentFallback(input.operationId, \"plan_invalid\");",
      start,
    );
    const foregroundExecution = source.slice(start, end);

    expect(runAgentStart).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(runAgentStart);
    expect(end).toBeGreaterThan(start);
    expect(foregroundExecution).toMatch(
      /const value = await input\.work\(\s+session,/u,
    );
    expect(foregroundExecution).toContain("return Object.freeze({\n                              value,");
    expect(foregroundExecution).toContain("value: executed.value.value,");
    expect(foregroundExecution).not.toContain(
      "status: \"executed\" as const, value: result }",
    );
  });

  test("wires selected foreground Message history through the invocation-owned repairer", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const source = await Bun.file(join(
      repoRoot,
      "packages/server/src/routes/live-shadow-message-composition.ts",
    )).text();

    expect(source).toContain("loadPostgresForegroundMessageRepairSources");
    expect(source).toContain("createForegroundMessageHistoryRepairer");
    expect(source).toMatch(
      /protectForegroundHistory:\s*historyRepairer\.protect/u,
    );
    expect(source).toMatch(
      /createForegroundMessageHistoryRepairer\(\{[\s\S]*?entities,[\s\S]*?loadSources: \(selection\) =>[\s\S]*?loadPostgresForegroundMessageRepairSources/u,
    );
    const repairerStart = source.indexOf("createForegroundMessageHistoryRepairer({");
    const repairerEnd = source.indexOf("const journalRepairer", repairerStart);
    expect(source.slice(repairerStart, repairerEnd)).toMatch(
      /resolveLiveShadowAgentSigner:\s*resolveForegroundSigner/u,
    );
  });

  test("bounds Agent execution by canonical runtime custody and the actual grant, not the short work proof", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const source = await Bun.file(join(
      repoRoot,
      "packages/server/src/routes/live-shadow-message-composition.ts",
    )).text();
    const runAgentStart = source.indexOf("runAgentTurn: async <Value>");
    const gatewayStart = source.indexOf(
      "const executed = await entityCrypto.execute({",
      runAgentStart,
    );
    const gatewayEnd = source.indexOf(
      "if (executed.status === \"executed\")",
      gatewayStart,
    );
    const foregroundExecution = source.slice(gatewayStart, gatewayEnd);

    expect(gatewayStart).toBeGreaterThan(runAgentStart);
    expect(gatewayEnd).toBeGreaterThan(gatewayStart);
    expect(foregroundExecution).not.toContain(
      "operationDeadline: foregroundPlan.deadlineAt",
    );
    expect(foregroundExecution).toContain(
      "authorizationDeadlineAt: Math.min(description.expiresAt, retained.deadlineAt)",
    );
    expect(foregroundExecution).toContain("operationDeadline: retained.deadlineAt");
    expect(source).toContain("deadlineAt: result.executionDeadlineAt");
  });

  test("keeps the complete readable Namespace snapshot in the foreground entity scope", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const source = await Bun.file(join(
      repoRoot,
      "packages/server/src/routes/live-shadow-message-composition.ts",
    )).text();
    const admission = source.slice(
      source.indexOf("const admitPreparedForeground = async"),
      source.indexOf("const admitPreparedLegacySharedAgent = async"),
    );

    expect(admission).toContain(
      "namespaceIds: Object.freeze([...agentCurrent.readableNamespaceIds]),",
    );
    expect(admission).not.toContain(
      "namespaceIds: Object.freeze([plan.namespaceId]),",
    );
  });

  test("invalidates runtime boundary observation when durable policy changed", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const source = await Bun.file(join(
      repoRoot,
      "packages/server/src/messaging/dispatch.ts",
    )).text();
    const observers = [...source.matchAll(
      /liveShadowObserveBoundary: async \(decision\) => \{([\s\S]*?)\n\s{10,}\},/gu,
    )];

    expect(observers).toHaveLength(2);
    for (const observer of observers) {
      expect(observer[1]).toContain("await strictShadowBoundaryEnforcer(");
      expect(observer[1]).toContain("rejectChangedStrictShadowPolicy(");
    }
  });
});
