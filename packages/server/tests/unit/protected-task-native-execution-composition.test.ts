import { describe, expect, test } from "bun:test";
import type { ProtectedTaskRuntimeGrantPlanBuilderDependencies } from "../../src/routes/protected-task-runtime-grant-plan";
import {
  createProductionProtectedTaskNativeExecution,
  type ProductionProtectedTaskNativeExecutionInput,
} from "../../src/routes/protected-task-native-execution-composition";

type Overrides = NonNullable<Parameters<typeof createProductionProtectedTaskNativeExecution>[1]>;
type Preparation = Parameters<ProtectedTaskRuntimeGrantPlanBuilderDependencies["prepareExecution"]>[0];
type Publication = Parameters<ProtectedTaskRuntimeGrantPlanBuilderDependencies["publishResult"]>[0];

function setup() {
  const input = {
    db: {}, restricted: {}, crypto: {}, serverScope: "https://server.test",
    owner: {}, embedding: {}, createDedicatedPool: () => { throw new Error("unused"); },
  } as unknown as ProductionProtectedTaskNativeExecutionInput;
  const identities: string[] = [];
  type Product = Awaited<ReturnType<NonNullable<Overrides["productContext"]>>>;
  const products: Product[] = [];
  const segments: Parameters<NonNullable<Overrides["segment"]>>[0][] = [];
  const segmentOptions: Parameters<NonNullable<Overrides["segment"]>>[2][] = [];
  const results: Parameters<NonNullable<Overrides["result"]>>[0][] = [];
  const publications: Publication[] = [];
  const parks: unknown[] = [];
  const humanParks: unknown[] = [];
  const context = async () => { throw new Error("not executed by preparation"); };
  const overrides: Overrides = {
    productContext: async (userId, db) => {
      expect(db).toBe(input.db);
      identities.push(userId);
      const product = { handle: {}, canonicalRunner: {} } as Product;
      products.push(product);
      return product;
    },
    agentProductContext: async identity => {
      identities.push(`${identity.userId}/${identity.agentId}`);
      return { handle: {}, canonicalRunner: {} } as Awaited<ReturnType<NonNullable<Overrides["agentProductContext"]>>>;
    },
    executionContext: () => context,
    transcriptPublisher: () => async () => { throw new Error("not executed by preparation"); },
    segment: (segment, _overrides, options) => {
      segments.push(segment);
      segmentOptions.push(options);
      return async () => ({
        executor: async function* () { yield* []; },
        openTransientInput: async () => ({}),
      });
    },
    result: options => {
      results.push(options);
      return async publication => { publications.push(publication); };
    },
    sealAndParkHuman: async (db, park) => {
      expect(db).toBe(input.db);
      humanParks.push(park);
      return { status: "parked" as const };
    },
    sealAndPark: async (db, park) => {
      expect(db).toBe(input.db);
      parks.push(park);
      return { status: "parked" as const };
    },
  };
  return { input, identities, products, segments, segmentOptions, results, publications, parks, humanParks, context, overrides };
}

function preparation(requestorId: string, agentId: string): Preparation {
  return { occurrence: { task: { requestorId, agentId } } } as Preparation;
}

describe("native protected Task execution composition", () => {
  test("binds each preparation to its actual requester and agent without sharing product identity", async () => {
    const f = setup();
    const execution = createProductionProtectedTaskNativeExecution(f.input, f.overrides);
    await execution.prepareExecution(preparation("requester-a", "agent-a"));
    await execution.prepareExecution(preparation("requester-b", "agent-b"));
    expect(f.identities).toEqual(["requester-a", "requester-a/agent-a", "requester-b", "requester-b/agent-b"]);
    expect(f.segments[0]!.product).toBe(f.products[0]!);
    expect(f.segments[1]!.product).toBe(f.products[1]!);
    expect(f.products[0]).not.toBe(f.products[1]!);
    expect(f.segments[0]!.resolveExecutionContext).toBe(f.context);
    expect(f.segments[0]!.owner).toBe(f.input.owner);
    expect(f.segments[0]!.createDedicatedPool).toBe(f.input.createDedicatedPool!);
    expect(f.publications).toEqual([]);
  });

  test("binds repo docs to the same native authority while sealing its operational selection", async () => {
    const f = setup();
    const execution = createProductionProtectedTaskNativeExecution(f.input, f.overrides);
    const selection = { mode: "auto" as const, publish: "pr" as const };
    const prepared = preparation("requester-a", "agent-a");

    await execution.prepareRepoDocsExecution(selection, prepared);

    expect(f.identities).toEqual(["requester-a", "requester-a/agent-a"]);
    expect(f.segments).toHaveLength(1);
    expect(f.segments[0]!.product).toBe(f.products[0]!);
    expect(f.segments[0]!.owner).toBe(f.input.owner);
    expect(f.segments[0]!.resolveExecutionContext).toBe(f.context);
    expect(f.segmentOptions).toEqual([{ repoDocsSelection: selection }]);
    expect(f.segmentOptions[0]!.repoDocsSelection).not.toBe(selection);
    expect(Object.isFrozen(f.segmentOptions[0]!.repoDocsSelection)).toBe(true);
  });

  test("binds initial result publication to the granted occurrence and passes custody without retaining it", async () => {
    const f = setup();
    const execution = createProductionProtectedTaskNativeExecution(f.input, f.overrides);
    const publication = {
      occurrence: { task: { id: "task-a", requestorId: "requester-a", cryptoObjectId: "input-object" }, run: { id: "run-a" } },
      evidence: { result: { objectId: "result-object" }, requestId: "request-a", policyRevision: 8 },
      reference: {
        kind: "protected_task_run_v1", taskId: "task-a", taskRunId: "run-a",
        inputObjectId: "input-object", resultObjectId: "result-object",
        authorizationRequestId: "request-a", policyRevision: 8,
        executionSegment: 1,
      },
      domains: [], signal: new AbortController().signal,
    } as unknown as Publication;
    await execution.publishResult(publication);
    expect(f.identities).toEqual(["requester-a"]);
    expect(f.results[0]!.reference).toEqual({
      kind: "protected_task_run_v1", taskId: "task-a", taskRunId: "run-a",
      inputObjectId: "input-object", resultObjectId: "result-object",
      authorizationRequestId: "request-a", policyRevision: 8, executionSegment: 1,
    });
    expect(f.publications[0]).toBe(publication);
    expect(f.results[0]!.product).toBe(f.products[0]!);
    expect(Object.hasOwn(f.results[0]!, "domains")).toBe(false);
  });

  test("does not build or run an executor when Agent product identity cannot be opened", async () => {
    const f = setup();
    const execution = createProductionProtectedTaskNativeExecution(f.input, {
      ...f.overrides,
      agentProductContext: async () => { throw new Error("Agent role unavailable"); },
    });
    const result = await execution.prepareExecution(preparation("requester-a", "agent-a"))
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({ message: "Agent role unavailable" });
    expect(f.segments).toEqual([]);
    expect(f.publications).toEqual([]);
  });

  test("rechecks the exact local target at the pre-effect boundary and permits a later reconnect", async () => {
    const f = setup();
    const checks: unknown[] = [];
    let available = false;
    const execution = createProductionProtectedTaskNativeExecution(f.input, {
      ...f.overrides,
      localReadiness: async request => {
        checks.push(request);
        return available ? { status: "ready" } : { status: "waiting" };
      },
    });
    await execution.prepareExecution(preparation("requester-a", "agent-a"));
    const recheck = f.segments[0]!.localExecutionReadyBeforeStart;
    if (recheck === undefined) throw new Error("local readiness was not wired");
    const occurrence = { task: { id: "task-a" }, run: { id: "run-a" } } as never;
    const signal = new AbortController().signal;
    expect(await recheck({ occurrence, signal })).toBe(false);
    available = true;
    expect(await recheck({ occurrence, signal })).toBe(true);
    expect(checks).toEqual([{ db: f.input.db, occurrence, signal }, {
      db: f.input.db, occurrence, signal,
    }]);
  });

  test("does not classify a local source denial as an offline wait", async () => {
    const f = setup();
    const execution = createProductionProtectedTaskNativeExecution(f.input, {
      ...f.overrides,
      localReadiness: async () => { throw new Error("local_source_revoked"); },
    });
    await execution.prepareExecution(preparation("requester-a", "agent-a"));
    const recheck = f.segments[0]!.localExecutionReadyBeforeStart;
    if (recheck === undefined) throw new Error("local readiness was not wired");
    await Promise.resolve(expect(recheck({ occurrence: {} as never,
      signal: new AbortController().signal })).rejects.toThrow(
      "local_source_revoked",
    ));
  });

  test("adapts the fixed segment park callback to one atomic database seal", async () => {
    const f = setup();
    const execution = createProductionProtectedTaskNativeExecution(f.input, f.overrides);
    await execution.prepareExecution(preparation("requester-a", "agent-a"));
    const park = { park: {}, segment: {}, continuation: {} } as never;
    expect(await f.segments[0]!.parkSegment(park)).toBe(true);
    expect(f.parks).toEqual([park]);
  });

  test("seals a Human park without fabricating additional authority", async () => {
    const f = setup();
    const execution = createProductionProtectedTaskNativeExecution(f.input, f.overrides);
    await execution.prepareExecution(preparation("requester-a", "agent-a"));
    const park = { park: {}, segment: {}, stableRoutingDigest: new Uint8Array(32) } as never;
    expect(await f.segments[0]!.parkSegment(park)).toBe(true);
    expect(f.humanParks).toEqual([park]);
    expect(f.parks).toEqual([]);
  });

  test("publishes a continued segment with its exact admitted reference", async () => {
    const f = setup();
    const execution = createProductionProtectedTaskNativeExecution(f.input, f.overrides);
    const reference = {
      kind: "protected_task_run_v1",
      taskId: "task-a",
      taskRunId: "run-a",
      inputObjectId: "input-object",
      resultObjectId: "result-object",
      authorizationRequestId: "request-b",
      policyRevision: 8,
      executionSegment: 2,
      resumeContinuationFingerprint: "A".repeat(43),
    } as const;
    const publication = {
      occurrence: {
        task: { id: "task-a", requestorId: "requester-a" },
        run: { id: "run-a" },
      },
      evidence: {},
      reference,
      domains: [],
      signal: new AbortController().signal,
    } as unknown as Publication;

    await execution.publishResult(publication);

    expect(f.results[0]!.reference).toBe(reference);
    expect(f.publications[0]).toBe(publication);
  });
});
