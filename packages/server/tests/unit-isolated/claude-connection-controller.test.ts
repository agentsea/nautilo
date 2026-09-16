import { expect, test } from "bun:test";
import { ClaudeConnectionController, type ClaudeConnectionContext, type StoredClaudeConnection } from "../../src/claude/connection-controller";

const context = (relayId = "relay-a", selectedProtocolVersion = 17): ClaudeConnectionContext => ({ relayId, relaySessionId: `${relayId}-session`, desktopSessionId: `${relayId}-desktop`, pairingGenerationRef: `${relayId}-pair`, selectedProtocolVersion, capabilityRevision: 1 });
const result = (scope = context()) => ({ type: "relay:claude-connection-discovery-result", version: 17, correlationId: "11111111-1111-4111-8111-111111111111", scope, profileRef: "22222222-2222-4222-8222-222222222222", runtime: { state: "ready", version: "2.1.235", executionQualified: true }, account: { state: "connected", email: "writer@example.test" }, catalog: { state: "complete", complete: true, models: [{ id: "provider", resolvedModel: "canonical", displayName: "Fable", description: "Frontier" }] } } as const);
const row = (): StoredClaudeConnection => ({ profileRef: "22222222-2222-4222-8222-222222222222", enabled: false, selectedModel: null, runtime: null, account: null, catalog: null, observationRevision: 0, observedAt: null });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve }; }

type ExecutionFixture = Readonly<{
  controller: ClaudeConnectionController;
  live: ClaudeConnectionContext;
  selection: Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }>;
  connection(): StoredClaudeConnection;
  setConnection(next: StoredClaudeConnection): void;
  setContexts(next: readonly ClaudeConnectionContext[]): void;
  setSession(next: ClaudeConnectionContext | null): void;
  setSessionThrows(next: boolean): void;
  calls(): Readonly<{ discovery: number; saves: number; contexts: number }>;
}>;

async function executionFixture(
  options: Readonly<{ omitSession?: boolean; protocolVersion?: number }> = {},
): Promise<ExecutionFixture> {
  let stored: StoredClaudeConnection = { ...row(), enabled: true };
  const live = context("relay-a", options.protocolVersion ?? 18);
  let contexts: readonly ClaudeConnectionContext[] = [live];
  let session: ClaudeConnectionContext | null = live;
  let sessionThrows = false;
  let discovery = 0;
  let saves = 0;
  let contextReads = 0;
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored,
    setEnabled: async () => stored,
    saveObservation: async (input) => {
      saves += 1;
      stored = { ...stored, ...input, observationRevision: 1, observedAt: new Date() };
      return stored;
    },
    selectModel: async (input) => {
      stored = { ...stored, selectedModel: input.model };
      return stored;
    },
    listContexts: async () => {
      contextReads += 1;
      return contexts;
    },
    ...(options.omitSession ? {} : {
      getExecutionSession: () => {
        if (sessionThrows) throw new Error("execution session unavailable");
        return session;
      },
    }),
    requestDiscovery: async () => {
      discovery += 1;
      return result(live);
    },
    onContext: () => () => undefined,
  });
  await controller.summary("owner");
  await controller.selectModel("owner", "provider");
  return Object.freeze({
    controller,
    live,
    selection: Object.freeze({ profileRef: stored.profileRef, catalogModelId: "provider", selectedModel: "canonical" }),
    connection: () => stored,
    setConnection: (next) => { stored = next; },
    setContexts: (next) => { contexts = next; },
    setSession: (next) => { session = next; },
    setSessionThrows: (next) => { sessionThrows = next; },
    calls: () => Object.freeze({ discovery, saves, contexts: contextReads }),
  });
}

test("execution remains eligible when the enclosing Relay protocol advances past v18", async () => {
  const fixture = await executionFixture({ protocolVersion: 19 });

  expect(await fixture.controller.listExecutionModels("owner")).toHaveLength(1);
  expect(
    await fixture.controller.admitExecution("owner", fixture.selection),
  ).toMatchObject({ scope: { selectedProtocolVersion: 19 } });
  fixture.controller.close();
});

function expectNoDiscoveryOrWrite(
  fixture: ExecutionFixture,
  before: Readonly<{ discovery: number; saves: number; contexts: number }>,
): void {
  const after = fixture.calls();
  expect(after.discovery).toBe(before.discovery);
  expect(after.saves).toBe(before.saves);
}

test("default-disabled startup discovers account/catalog and persists canonical model selection", async () => {
  let stored = row(); let calls = 0;
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored, setEnabled: async (_u, enabled) => (stored = { ...stored, enabled }),
    saveObservation: async (input) => (stored = { ...stored, ...input, observationRevision: stored.observationRevision + 1, observedAt: new Date("2026-08-20T12:00:00.000Z") }),
    selectModel: async (input) => input.expectedObservationRevision === stored.observationRevision ? (stored = { ...stored, selectedModel: input.model }) : undefined,
    listContexts: async () => [context()], requestDiscovery: async () => { calls += 1; return result(); }, onContext: () => () => undefined,
  });
  const summary = await controller.summary("owner");
  expect(calls).toBe(1); expect(summary.enabled).toBe(false); expect(summary.account).toEqual({ state: "connected", email: "writer@example.test" });
  expect((await controller.selectModel("owner", "provider"))?.selectedModel).toBe("canonical");
  expect((await controller.setEnabled("owner", true)).account).toEqual({ state: "connected", email: "writer@example.test" });
  expect(calls).toBe(1);
  controller.close();
});

test("ambiguous relays do not auto-discover, while an exact owner route hint does", async () => {
  let calls = 0; const stored = row();
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored, setEnabled: async () => stored, saveObservation: async () => stored, selectModel: async () => stored,
    listContexts: async () => [context("relay-a"), context("relay-b")], requestDiscovery: async (input) => { calls += 1; return result(context(input.relayId)); }, onContext: () => () => undefined,
  });
  expect((await controller.summary("owner")).connectionState).toBe("disabled"); expect(calls).toBe(0);
  await controller.summary("owner", "relay-b"); expect(calls).toBe(1); controller.close();
});

test("singleflights discovery and rejects a late result after its context changes", async () => {
  let stored = row(); let contexts = [context()]; let saves = 0; let calls = 0;
  const pending = deferred<ReturnType<typeof result>>();
  let listener: ((relayId: string, userId: string, next: ClaudeConnectionContext | null) => void) | undefined;
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored, setEnabled: async () => stored,
    saveObservation: async (input) => { saves += 1; return stored = { ...stored, ...input, observationRevision: 1, observedAt: new Date() }; },
    selectModel: async () => stored, listContexts: async () => contexts,
    requestDiscovery: () => { calls += 1; return pending.promise; }, onContext: (next) => { listener = next; return () => undefined; },
  });
  const first = controller.summary("owner"); const second = controller.checkAgain("owner");
  await Bun.sleep(0); expect(calls).toBe(1);
  contexts = []; listener?.("relay-a", "owner", null); pending.resolve(result());
  await Promise.all([first, second]); expect(saves).toBe(0); controller.close();
});

test("fresh disconnected runtime truth is unavailable rather than falsely connected", async () => {
  let stored = row();
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored, setEnabled: async () => stored,
    saveObservation: async (input) => stored = { ...stored, ...input, observationRevision: 1, observedAt: new Date() },
    selectModel: async () => stored, listContexts: async () => [context()],
    requestDiscovery: async () => ({ ...result(), runtime: { state: "unavailable" as const }, account: { state: "disconnected" as const }, catalog: { state: "unavailable" as const, complete: false as const, models: [] as const } }), onContext: () => () => undefined,
  });
  const summary = await controller.summary("owner");
  expect(summary.connectionState).toBe("disabled"); expect(summary.observationStale).toBe(false); expect(summary.account.state).toBe("disconnected"); controller.close();
});

test("fresh unreviewed runtime truth retains account and catalog without claiming execution admission", async () => {
  let stored = row();
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored, setEnabled: async (_userId, enabled) => stored = { ...stored, enabled },
    saveObservation: async (input) => stored = { ...stored, ...input, observationRevision: 1, observedAt: new Date() },
    selectModel: async (input) => stored = { ...stored, selectedModel: input.model }, listContexts: async () => [context()],
    requestDiscovery: async () => ({ ...result(), runtime: { state: "ready" as const, version: "2.1.39", executionQualified: false as const } }), onContext: () => () => undefined,
  });
  const detected = await controller.summary("owner");
  expect(detected.runtime).toEqual({ state: "ready", version: "2.1.39", executionQualified: false });
  expect(detected.account.state).toBe("connected");
  expect((await controller.selectModel("owner", "provider"))?.selectedModel).toBe("canonical");
  const enabled = await controller.setEnabled("owner", true);
  expect(enabled.connectionState).toBe("unavailable");
  expect(enabled.selectedModelAdmitted).toBe(false);
  controller.close();
});

test("no-context summary reads do not retain owner state", async () => {
  const stored = row();
  const controller = new ClaudeConnectionController({ getConnection: async () => stored, setEnabled: async () => stored, saveObservation: async () => stored, selectModel: async () => stored, listContexts: async () => [], requestDiscovery: async () => result(), onContext: () => () => undefined });
  await Promise.all(Array.from({ length: 20 }, (_, index) => controller.summary(`owner-${index}`)));
  expect(controller.trackedOwnerCountForTest()).toBe(0); controller.close();
});

test("a synchronous relay throw clears the pending discovery so Check again can retry", async () => {
  const stored = row(); let calls = 0;
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored, setEnabled: async () => stored, saveObservation: async () => stored, selectModel: async () => stored,
    listContexts: async () => [context()], requestDiscovery: () => { calls += 1; throw new Error("relay unavailable"); }, onContext: () => () => undefined,
  });
  expect((await controller.summary("owner")).connectionState).toBe("disabled");
  expect((await controller.checkAgain("owner")).connectionState).toBe("disabled");
  expect(calls).toBe(2);
  controller.close();
});

test("lists and admits only a fresh selected alias on the matching live v18 execution session", async () => {
  let stored = { ...row(), enabled: true };
  const live = context("relay-a", 18);
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored,
    setEnabled: async () => stored,
    saveObservation: async (input) => stored = { ...stored, ...input, observationRevision: 1, observedAt: new Date() },
    selectModel: async (input) => stored = { ...stored, selectedModel: input.model },
    listContexts: async () => [live],
    getExecutionSession: (relayId, userId) => relayId === live.relayId && userId === "owner" ? live : null,
    requestDiscovery: async () => result(live),
    onContext: () => () => undefined,
  });

  await controller.summary("owner");
  await controller.selectModel("owner", "provider");

  const models = await controller.listExecutionModels("owner");
  expect(models).toEqual([{
    profileRef: "22222222-2222-4222-8222-222222222222",
    catalogModelId: "provider",
    selectedModel: "canonical",
    displayName: "Fable",
    description: "Frontier",
    selected: true,
  }]);
  expect(Object.isFrozen(models)).toBe(true);
  expect(Object.isFrozen(models[0])).toBe(true);
  expect(await controller.admitExecution("owner", {
    profileRef: "22222222-2222-4222-8222-222222222222",
    catalogModelId: "provider",
    selectedModel: "canonical",
  })).toEqual({
    profileRef: "22222222-2222-4222-8222-222222222222",
    catalogModelId: "provider",
    selectedModel: "canonical",
    scope: live,
  });
  controller.close();
});

test("execution model access fails closed for a missing or mismatched v18 live session", async () => {
  let stored = { ...row(), enabled: true };
  const live = context("relay-a", 18);
  let session: ClaudeConnectionContext | null = null;
  const controller = new ClaudeConnectionController({
    getConnection: async () => stored,
    setEnabled: async () => stored,
    saveObservation: async (input) => stored = { ...stored, ...input, observationRevision: 1, observedAt: new Date() },
    selectModel: async (input) => stored = { ...stored, selectedModel: input.model },
    listContexts: async () => [live],
    getExecutionSession: () => session,
    requestDiscovery: async () => result(live),
    onContext: () => () => undefined,
  });

  await controller.summary("owner");
  await controller.selectModel("owner", "provider");
  expect(await controller.listExecutionModels("owner")).toEqual([]);
  session = { ...live, capabilityRevision: 2 };
  expect(await controller.admitExecution("owner", {
    profileRef: stored.profileRef,
    catalogModelId: "provider",
    selectedModel: "canonical",
  })).toBeNull();
  controller.close();
});

test("execution admission rechecks the observed row after its awaited context reads", async () => {
  let stored = { ...row(), enabled: true };
  const live = context("relay-a", 18);
  let staleAfterRead = false;
  let readsAfterArm = 0;
  const controller = new ClaudeConnectionController({
    getConnection: async () => {
      if (!staleAfterRead) return stored;
      readsAfterArm += 1;
      return readsAfterArm === 1 ? { ...stored, observationRevision: stored.observationRevision + 1 } : stored;
    },
    setEnabled: async () => stored,
    saveObservation: async (input) => stored = { ...stored, ...input, observationRevision: 1, observedAt: new Date() },
    selectModel: async (input) => stored = { ...stored, selectedModel: input.model },
    listContexts: async () => [live],
    getExecutionSession: () => live,
    requestDiscovery: async () => result(live),
    onContext: () => () => undefined,
  });

  await controller.summary("owner");
  await controller.selectModel("owner", "provider");
  staleAfterRead = true;
  expect(await controller.admitExecution("owner", {
    profileRef: stored.profileRef,
    catalogModelId: "provider",
    selectedModel: "canonical",
  })).toBeNull();
  controller.close();
});

test("execution list and admission deny every persisted eligibility or discovery-freshness loss without rediscovery", async () => {
  const cases: readonly [
    string,
    (fixture: ExecutionFixture) => void,
  ][] = [
    ["disabled", (fixture) => fixture.setConnection({ ...fixture.connection(), enabled: false })],
    ["runtime unavailable", (fixture) => fixture.setConnection({ ...fixture.connection(), runtime: { state: "unavailable" } })],
    ["runtime not qualified", (fixture) => fixture.setConnection({ ...fixture.connection(), runtime: { state: "ready", version: "2.1.235", executionQualified: false } })],
    ["account disconnected", (fixture) => fixture.setConnection({ ...fixture.connection(), account: { state: "disconnected" } })],
    ["catalog incomplete", (fixture) => fixture.setConnection({ ...fixture.connection(), catalog: { state: "incomplete", complete: false, models: [] } })],
    ["catalog complete flag false", (fixture) => fixture.setConnection({
      ...fixture.connection(),
      catalog: { state: "complete", complete: false, models: [] } as unknown as StoredClaudeConnection["catalog"],
    })],
    ["fresh profile drift", (fixture) => fixture.setConnection({ ...fixture.connection(), profileRef: "33333333-3333-4333-8333-333333333333" })],
    ["fresh revision drift", (fixture) => fixture.setConnection({ ...fixture.connection(), observationRevision: fixture.connection().observationRevision + 1 })],
    ["context generation drift", (fixture) => fixture.setContexts([{ ...fixture.live, capabilityRevision: fixture.live.capabilityRevision + 1 }])],
    ["ambiguous contexts", (fixture) => fixture.setContexts([fixture.live, context("relay-b", 18)])],
  ];
  for (const [name, mutate] of cases) {
    const fixture = await executionFixture();
    mutate(fixture);
    const before = fixture.calls();
    expect(await fixture.controller.listExecutionModels("owner"), name).toEqual([]);
    expect(await fixture.controller.admitExecution("owner", fixture.selection), name).toBeNull();
    expectNoDiscoveryOrWrite(fixture, before);
    fixture.controller.close();
  }
});

test("execution list and admission deny a missing, throwing, or each mismatched live v18 session field", async () => {
  const missing = await executionFixture({ omitSession: true });
  const missingBefore = missing.calls();
  expect(await missing.controller.listExecutionModels("owner")).toEqual([]);
  expect(await missing.controller.admitExecution("owner", missing.selection)).toBeNull();
  expectNoDiscoveryOrWrite(missing, missingBefore);
  missing.controller.close();

  const throwing = await executionFixture();
  throwing.setSessionThrows(true);
  const throwingBefore = throwing.calls();
  expect(await throwing.controller.listExecutionModels("owner")).toEqual([]);
  expect(await throwing.controller.admitExecution("owner", throwing.selection)).toBeNull();
  expectNoDiscoveryOrWrite(throwing, throwingBefore);
  throwing.controller.close();

  const drifts: readonly [string, (scope: ClaudeConnectionContext) => ClaudeConnectionContext][] = [
    ["relay", (scope) => ({ ...scope, relayId: "other-relay" })],
    ["relay session", (scope) => ({ ...scope, relaySessionId: "other-session" })],
    ["desktop session", (scope) => ({ ...scope, desktopSessionId: "other-desktop" })],
    ["pairing generation", (scope) => ({ ...scope, pairingGenerationRef: "other-pair" })],
    ["protocol", (scope) => ({ ...scope, selectedProtocolVersion: 17 })],
    ["capability revision", (scope) => ({ ...scope, capabilityRevision: scope.capabilityRevision + 1 })],
  ];
  for (const [name, drift] of drifts) {
    const fixture = await executionFixture();
    fixture.setSession(drift(fixture.live));
    const before = fixture.calls();
    expect(await fixture.controller.listExecutionModels("owner"), name).toEqual([]);
    expect(await fixture.controller.admitExecution("owner", fixture.selection), name).toBeNull();
    expectNoDiscoveryOrWrite(fixture, before);
    fixture.controller.close();
  }
});

test("execution admission requires the exact stored selected alias and rejects hostile selection input before reads", async () => {
  const fixture = await executionFixture();
  const selectionCases: readonly [string, Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }>][] = [
    ["profile", { ...fixture.selection, profileRef: "33333333-3333-4333-8333-333333333333" }],
    ["catalog", { ...fixture.selection, catalogModelId: "other" }],
    ["canonical", { ...fixture.selection, selectedModel: "other" }],
  ];
  for (const [name, selection] of selectionCases) {
    const before = fixture.calls();
    expect(await fixture.controller.admitExecution("owner", selection), name).toBeNull();
    expectNoDiscoveryOrWrite(fixture, before);
  }

  fixture.setConnection({ ...fixture.connection(), selectedModel: null });
  expect((await fixture.controller.listExecutionModels("owner"))[0]).toMatchObject({ selected: false });
  expect(await fixture.controller.admitExecution("owner", fixture.selection)).toBeNull();
  fixture.setConnection({ ...fixture.connection(), selectedModel: "different" });
  expect(await fixture.controller.admitExecution("owner", fixture.selection)).toBeNull();

  const hostile = Object.defineProperty({}, "profileRef", {
    enumerable: true,
    get: () => { throw new Error("unexpected getter"); },
  }) as unknown as Readonly<{ profileRef: string; catalogModelId: string; selectedModel: string }>;
  const beforeHostile = fixture.calls();
  expect(await fixture.controller.admitExecution("owner", hostile)).toBeNull();
  expect(fixture.calls()).toEqual(beforeHostile);
  fixture.controller.close();
});
