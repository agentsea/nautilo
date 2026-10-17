import { describe, expect, test } from "bun:test";
import type { DurableModelExposureDependency, DurableRecordEnvelope } from "@nautilo/reflection/durable";
import { classifyPersonalMemoryEvidence, assertSamePersonalMemoryEvidence, PersonalMemoryEvidenceChangedError, type PersonalMemoryEvidencePort } from "../../src/server/personal-memory-evidence";
const source = (ref: string): Extract<DurableModelExposureDependency, {kind:"source"}> => ({
  kind: "source", sourceKind: "message", logicalSourceRef: ref, observedRevision: "0",
  observedContentFingerprint: "exact-content", terminalAuthorityLeafHandle: "namespace",
});
const budget = { maxVisitedRecords: 4, maxTraversalWork: 16 };
const port = (overrides: Partial<PersonalMemoryEvidencePort> = {}): PersonalMemoryEvidencePort => ({
  readRecord: async () => null,
  readSource: async () => ({ status: "current", kind: "human", authorHumanId: "human-a", audienceHumanIds: ["human-a"], includesPublicBoundary: false }),
  readAudience: async () => ({ humanIds: ["human-a"], includesPublicBoundary: false }),
  ...overrides,
});
const record = (exposure: readonly DurableModelExposureDependency[] | undefined): DurableRecordEnvelope => ({
  recordRef: "record-a", lifecycle: "current", structuralHeight: 0, processingGeneration: 1,
  semantic: { posture:"derived", observedContentFingerprint:"record-hash", statement:"fact", sourceDependencies: [],
    anchors:[], childRecordRefs:[], producer:{producerRef:"stenographer",policyVersion:"v1"},
    terminalAuthorityLeafHandles:["namespace"], ...(exposure === undefined ? {} : { modelExposureDependencies: exposure }) },
});
const recordDep: DurableModelExposureDependency = { kind:"record",recordRef:"record-a", observedProcessingGeneration:1, terminalAuthorityLeafHandles:["namespace"] };
describe("personal Memory exact input proof", () => {
  test("a complete new derived AI/tool input follows all exposed leaves", async () => {
    const result = await classifyPersonalMemoryEvidence({ dependencies: [source("assistant")], budget, ports: port({
      readSource: async (dep) => dep.logicalSourceRef === "assistant"
        ? { status:"current", kind:"derived", audienceHumanIds:["human-a"], includesPublicBoundary:false, modelExposureDependencies:[source("tool")] }
        : dep.logicalSourceRef === "tool"
          ? { status:"current", kind:"derived", audienceHumanIds:["human-a"], includesPublicBoundary:false, modelExposureDependencies:[source("human")] }
          : {status:"current",kind:"human",authorHumanId:"human-a",audienceHumanIds:["human-a"],includesPublicBoundary:false},
    }) });
    expect(result).toEqual({kind:"human",humanUserId:"human-a"});
  });
  test("a private Record without complete model exposure remains service", async () => {
    expect(await classifyPersonalMemoryEvidence({ dependencies:[recordDep], budget, ports:port({readRecord:async()=>record(undefined)}) })).toEqual({kind:"service",reason:"incomplete"});
  });
  test("uncited shared retrieved context makes the complete prompt shared", async () => {
    expect(await classifyPersonalMemoryEvidence({ dependencies:[recordDep], budget, ports:port({
      readRecord:async()=>record([source("cited"),source("uncited")]),
      readSource:async(dep)=>({status:"current",kind:"human",authorHumanId:"human-a",audienceHumanIds:dep.logicalSourceRef === "uncited" ? ["human-a","human-b"] : ["human-a"],includesPublicBoundary:false}),
    }) })).toMatchObject({kind:"service"});
  });
  test("same apparent owner never overrides mixed Human terminal sources", async () => {
    const result = await classifyPersonalMemoryEvidence({dependencies:[source("a"),source("b")],budget,ports:port({readSource:async(dep)=>({status:"current",kind:"human",authorHumanId:dep.logicalSourceRef === "a" ? "human-a":"human-b",audienceHumanIds:[dep.logicalSourceRef === "a" ? "human-a":"human-b"],includesPublicBoundary:false})})});
    expect(result).toEqual({kind:"service",reason:"mixed"});
  });
  test("public boundaries and historical unknown ancestry cannot be personal", async () => {
    for (const value of [
      {status:"current",kind:"unknown",audienceHumanIds:["human-a"],includesPublicBoundary:false},
      {status:"current",kind:"human",authorHumanId:"human-a",audienceHumanIds:["human-a"],includesPublicBoundary:true},
    ] as const) expect(await classifyPersonalMemoryEvidence({dependencies:[source("x")],budget,ports:port({readSource:async()=>value})})).toMatchObject({kind:"service"});
  });
  test("stale source, generation and authority block rather than silently funding service", async () => {
    expect(await classifyPersonalMemoryEvidence({dependencies:[source("x")],budget,ports:port({readSource:async()=>null})}).catch((error: unknown) => error)).toBeInstanceOf(PersonalMemoryEvidenceChangedError);
    expect(await classifyPersonalMemoryEvidence({dependencies:[recordDep],budget,ports:port({readRecord:async()=>({...record([source("x")]),processingGeneration:2})})}).catch((error: unknown) => error)).toBeInstanceOf(PersonalMemoryEvidenceChangedError);
    expect(await classifyPersonalMemoryEvidence({dependencies:[recordDep],budget,ports:port({readRecord:async()=>record([source("x")]),readAudience:async()=>null})}).catch((error: unknown) => error)).toBeInstanceOf(PersonalMemoryEvidenceChangedError);
  });
  test("cyclic derivation and exhausted current policy are incomplete", async () => {
    const ports = port({readSource:async()=>({status:"current",kind:"derived",audienceHumanIds:["human-a"],includesPublicBoundary:false,modelExposureDependencies:[source("x")]})});
    expect(await classifyPersonalMemoryEvidence({dependencies:[source("x")],budget,ports})).toEqual({kind:"service",reason:"incomplete"});
    expect(await classifyPersonalMemoryEvidence({dependencies:[source("x")],budget:{maxVisitedRecords:0,maxTraversalWork:0},ports:port()})).toEqual({kind:"service",reason:"incomplete"});
  });
  test("accepted personal work cannot become service or another Human", () => {
    expect(()=>assertSamePersonalMemoryEvidence({kind:"human",humanUserId:"human-a"},{kind:"service",reason:"shared"})).toThrow(PersonalMemoryEvidenceChangedError);
    expect(()=>assertSamePersonalMemoryEvidence({kind:"human",humanUserId:"human-a"},{kind:"human",humanUserId:"human-b"})).toThrow(PersonalMemoryEvidenceChangedError);
  });
});
