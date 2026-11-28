import { describe, expect, test } from "bun:test";
import {
  openMemoryOperation,
  ordinaryHistoricalMemoryEvidenceReaders,
  type OpenMemoryOperationInput,
} from "../../src/lib/personal-memory-operation";
import { DurableSleepOrganizationUnavailableError } from "@nautilo/reflection";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import type { MemoryOperationBinding } from "@nautilo/types";

const source = { kind: "source" as const, sourceKind: "message", logicalSourceRef: "message:1", observedRevision: "0", observedContentFingerprint: "sha256:exact", terminalAuthorityLeafHandle: "private" };
function fixture() {
  let accepted: MemoryOperationBinding | undefined;
  let author = "human";
  let audience = ["human"];
  let generation = "0";
  let selections = 0;
  let opens = 0;
  const options: OpenMemoryOperationInput = {
    role: "memorySummarization", operationKey: "existing-batch", commitmentKey: new Uint8Array(32).fill(1),
    budget: { maxVisitedRecords: 10, maxTraversalWork: 20 },
    dependencies: () => Promise.resolve([{ ...source, observedRevision: generation }]),
    ports: {
      readRecord: () => Promise.resolve(null),
      readAudience: () => Promise.resolve({ humanIds: audience, includesPublicBoundary: false }),
      readSource: () => Promise.resolve({ status: "current", kind: "human", authorHumanId: author, audienceHumanIds: audience, includesPublicBoundary: false }),
    },
    assertCurrent: () => Promise.resolve(), resolveServiceModel: () => "openai/service",
    bind: async resolve => accepted ??= await resolve(),
    openHumanSession: (humanUserId, recheck) => ({
      humanUserId,
      resolveModel: () => { selections++; return Promise.resolve({ modelId: "openai/personal", preferenceRevision: 3 }); },
      openModel: async (_model, _workload, prior) => {
        await recheck(); opens++;
        return { binding: prior ?? { kind: "personal", providerRoute: "openai", credentialId: "4e9bf2e4-6725-4d3d-a8ca-551349628712", credentialRevision: 1 },
          fundingSession: { kind: "personal", workload: "memory", recheckAttempt: recheck, runAttempt: () => { throw new Error("not dispatched in admission test"); } } };
      },
      openService: () => { throw new Error("not a service provider"); },
      openMedia: () => { throw new Error("not a media capability"); },
    }),
  };
  return { options, binding: () => accepted, counters: () => ({ selections, opens }),
    shared: () => { audience = ["human", "other"]; }, private: () => { audience = ["human"]; }, author: (value: string) => { author = value; }, change: () => { generation = "1"; } };
}
async function expectEvidenceChange(operation: Promise<unknown>): Promise<void> {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Memory input evidence");
}

const rootRecord = (nestedRecordRef: string): DurableRecordEnvelope => ({
  recordRef: "record:root", lifecycle: "current", structuralHeight: 1,
  processingGeneration: 1,
  semantic: {
    posture: "derived", observedContentFingerprint: "root-fingerprint",
    statement: "root", sourceDependencies: [], anchors: [],
    childRecordRefs: [], producer: { producerRef: "organizer", policyVersion: "v1" },
    terminalAuthorityLeafHandles: ["private"],
    modelExposureDependencies: [{
      kind: "record", recordRef: nestedRecordRef,
      observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: ["private"],
    }],
  },
});

const historicalOrganizerRecord = (): DurableRecordEnvelope => ({
  recordRef: "record:historical", lifecycle: "superseded", structuralHeight: 0,
  processingGeneration: 2,
  semantic: {
    posture: "derived", observedContentFingerprint: "historical-fingerprint",
    statement: "historical", sourceDependencies: [], anchors: [],
    childRecordRefs: [], producer: { producerRef: "organizer", policyVersion: "v1" },
    terminalAuthorityLeafHandles: ["private"],
    modelExposureDependencies: [source],
  },
});

describe("existing Memory operation admission", () => {
  test("manual service recovery keeps an exact typed binding without reopening funding", async () => {
    const f = fixture();
    f.shared();
    const previous = await openMemoryOperation(f.options);
    if (previous.binding.kind !== "service") throw new Error("expected service binding");
    const resumed = await openMemoryOperation({
      ...f.options,
      bind: resolve => resolve(undefined, previous.binding as Extract<MemoryOperationBinding, { kind: "service" }>),
    });
    expect(resumed.binding).toEqual(previous.binding);
    expect(resumed.humanUserId).toBeNull();
    expect(f.counters()).toEqual({ selections: 0, opens: 0 });
  });

  test("manual service recovery rebinds changed inputs only with current service evidence", async () => {
    const f = fixture();
    f.shared();
    const previous = await openMemoryOperation(f.options);
    if (previous.binding.kind !== "service") throw new Error("expected service binding");
    f.change();
    const rebound = await openMemoryOperation({
      ...f.options,
      bind: resolve => resolve(undefined, previous.binding as Extract<MemoryOperationBinding, { kind: "service" }>),
    });
    expect(rebound.binding).toMatchObject({ kind: "service", modelId: previous.modelId });
    expect(rebound.binding.inputCommitment).not.toBe(previous.binding.inputCommitment);
    expect(rebound.humanUserId).toBeNull();
    expect(f.counters()).toEqual({ selections: 0, opens: 0 });
    await rebound.assertCurrent();
    f.private();
    await expectEvidenceChange(rebound.assertCurrent());
  });

  test("manual service recovery rejects changed Human or incomplete current evidence", async () => {
    const human = fixture();
    human.shared();
    const previous = await openMemoryOperation(human.options);
    if (previous.binding.kind !== "service") throw new Error("expected service binding");
    human.change();
    human.private();
    await expectEvidenceChange(openMemoryOperation({
      ...human.options,
      bind: resolve => resolve(undefined, previous.binding as Extract<MemoryOperationBinding, { kind: "service" }>),
    }));
    expect(human.counters()).toEqual({ selections: 0, opens: 0 });

    const incomplete = fixture();
    incomplete.shared();
    const accepted = await openMemoryOperation(incomplete.options);
    if (accepted.binding.kind !== "service") throw new Error("expected service binding");
    await expectEvidenceChange(openMemoryOperation({
      ...incomplete.options,
      dependencies: async () => undefined,
      bind: resolve => resolve(undefined, accepted.binding as Extract<MemoryOperationBinding, { kind: "service" }>),
    }));
    expect(incomplete.counters()).toEqual({ selections: 0, opens: 0 });
  });

  test("changed inputs require a current service payer even when the prior service model is pinned", async () => {
    const f = fixture();
    const fresh = { ...f.options, requireCurrentServicePayer: true,
      bind: (resolve: Parameters<typeof f.options.bind>[0]) => resolve("venice:approved") };
    await expectEvidenceChange(openMemoryOperation(fresh));
    f.shared();
    const admitted = await openMemoryOperation(fresh);
    expect(admitted.modelId).toBe("venice:approved");
    await admitted.assertCurrent();
    f.private();
    await expectEvidenceChange(admitted.assertCurrent());
    expect(f.counters()).toEqual({ selections: 0, opens: 0 });
  });

  test("protected evidence never acquires ordinary historical readers", () => {
    const f = fixture();
    const readers = {
      readHistoricalOrganizerPredecessor: f.options.ports.readRecord,
      readRetiredJournalPredecessor: f.options.ports.readRecord,
    };
    expect(ordinaryHistoricalMemoryEvidenceReaders(
      f.options.ports,
      readers,
    )).toEqual({});
    expect(ordinaryHistoricalMemoryEvidenceReaders(undefined, readers))
      .toBe(readers);
  });
  test("complete exact sources admit the proven Human and retain model/funding across reopening", async () => {
    const f = fixture(); const first = await openMemoryOperation(f.options);
    expect(first.humanUserId).toBe("human"); expect(first.fundingSession?.kind).toBe("personal");
    expect(f.binding()).toMatchObject({ kind: "human", modelId: "openai/personal", preferenceRevision: 3 });
    const next = await openMemoryOperation(f.options);
    expect(next.binding).toEqual(first.binding); expect(f.counters().selections).toBe(1);
  });
  test("claim-family reopening retains the accepted payer and model for a proven subset", async () => {
    const f = fixture();
    const first = await openMemoryOperation({ ...f.options, bindingScope: "claim_family" });
    f.change();
    const subset = await openMemoryOperation({
      ...f.options,
      bindingScope: "claim_family",
      operationKey: "retained-subset",
    });
    expect(subset.binding).toEqual(first.binding);
    expect(subset.modelId).toBe("openai/personal");
    expect(subset.humanUserId).toBe("human");
    expect(f.counters().selections).toBe(1);
    await subset.assertCurrent();
  });
  test("exact operations still reject a retained binding for changed input", async () => {
    const f = fixture();
    await openMemoryOperation(f.options);
    f.change();
    await expectEvidenceChange(openMemoryOperation(f.options));
  });
  test("claim-family mode never accepts a mismatched binding produced by its fresh resolver", async () => {
    const f = fixture();
    await expectEvidenceChange(openMemoryOperation({
      ...f.options,
      bindingScope: "claim_family",
      bind: async resolve => {
        const resolved = await resolve();
        return { ...resolved, inputCommitment: `hmac-sha256:${"Z".repeat(43)}` };
      },
    }));
  });
  test("shared context uses explicit service without asking for a Human credential", async () => {
    const f = fixture(); f.shared(); const result = await openMemoryOperation(f.options);
    expect(result.humanUserId).toBeNull(); expect(result.fundingSession).toBeUndefined();
    expect(result.modelId).toBe("openai/service"); expect(f.counters().opens).toBe(0);
  });
  test("live audience or generation loss blocks accepted personal work", async () => {
    const f = fixture(); const admitted = await openMemoryOperation(f.options); f.shared();
    await expectEvidenceChange(admitted.assertCurrent());
    await expectEvidenceChange(openMemoryOperation(f.options));
    const changed = fixture(); await openMemoryOperation(changed.options); changed.change();
    await expectEvidenceChange(openMemoryOperation(changed.options));
  });
  test("a legacy accepted service model migrates without opening a personal credential", async () => {
    const f = fixture(); const result = await openMemoryOperation({ ...f.options,
      bind: resolve => resolve("openai/accepted-service") });
    expect(result.binding.kind).toBe("service"); expect(result.modelId).toBe("openai/accepted-service");
    expect(f.counters().opens).toBe(0);
  });
  test("dynamic unknown or different-Human exposure cannot silently switch an admitted payer", async () => {
    const f = fixture(); const admitted = await openMemoryOperation(f.options);
    await expectEvidenceChange(admitted.assertExposure(undefined));
    f.author("other"); await expectEvidenceChange(admitted.assertExposure([source]));
  });
  test("complete historical Organizer ancestry retains personal funding and conflicts with service-only recovery", async () => {
    const f = fixture();
    const dependency = {
      kind: "record" as const, recordRef: "record:root",
      observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: ["private"],
    };
    const input: OpenMemoryOperationInput = {
      ...f.options,
      dependencies: () => Promise.resolve([dependency]),
      ports: {
        ...f.options.ports,
        readRecord: async current => current.recordRef === "record:root"
          ? rootRecord("record:historical")
          : null,
      },
      readHistoricalOrganizerPredecessor: async historical =>
        historical.recordRef === "record:historical"
          ? historicalOrganizerRecord()
          : null,
    };
    const admitted = await openMemoryOperation(input);
    expect(admitted.binding.kind).toBe("human");
    expect(admitted.fundingSession?.kind).toBe("personal");
    const conflict = await openMemoryOperation({
      ...input,
      bind: async resolve => {
        const resolved = await resolve();
        if (resolved.kind !== "service") {
          throw new DurableSleepOrganizationUnavailableError();
        }
        return resolved;
      },
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(DurableSleepOrganizationUnavailableError);
  });
  test.each([
    "openai:gpt-5.6-sol",
    "venice:llama-3.3-70b",
    "surplus:synthetic-model",
  ])("shared historical Organizer evidence keeps the exact %s service route", async modelId => {
    const f = fixture();
    const result = await openMemoryOperation({
      ...f.options,
      resolveServiceModel: () => modelId,
      dependencies: () => Promise.resolve([{
        kind: "record", recordRef: "record:root",
        observedProcessingGeneration: 1,
        terminalAuthorityLeafHandles: ["private"],
      }]),
      ports: {
        ...f.options.ports,
        readRecord: async current => current.recordRef === "record:root"
          ? rootRecord("record:historical")
          : null,
        readSource: async () => ({
          status: "current", kind: "human", authorHumanId: "human",
          audienceHumanIds: ["human", "other"], includesPublicBoundary: false,
        }),
      },
      readHistoricalOrganizerPredecessor: async historical =>
        historical.recordRef === "record:historical"
          ? historicalOrganizerRecord()
          : null,
    });
    expect(result.binding).toMatchObject({ kind: "service", modelId });
    expect(result.fundingSession).toBeUndefined();
  });
});
