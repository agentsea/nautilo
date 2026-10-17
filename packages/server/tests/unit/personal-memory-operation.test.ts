import { describe, expect, test } from "bun:test";
import { openMemoryOperation, type OpenMemoryOperationInput } from "../../src/lib/personal-memory-operation";
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
    shared: () => { audience = ["human", "other"]; }, author: (value: string) => { author = value; }, change: () => { generation = "1"; } };
}
async function expectEvidenceChange(operation: Promise<unknown>): Promise<void> {
  const error = await operation.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Memory input evidence");
}

describe("existing Memory operation admission", () => {
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
});
