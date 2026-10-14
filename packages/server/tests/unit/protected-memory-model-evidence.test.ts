import { describe, expect, test } from "bun:test";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import type { PersonalMemoryEvidencePort } from "@nautilo/reflection-bridge/server";
import {
  getCurrentProtectedMemoryEvidence,
  runWithProtectedMemoryEvidence,
} from "../../src/lib/protected-memory-model-evidence";

const record = {
  kind: "record" as const,
  recordRef: "record-a",
  observedProcessingGeneration: 1,
  terminalAuthorityLeafHandles: ["namespace-a"],
};
const source = {kind: "source" as const, sourceKind: "message", logicalSourceRef: "message:1",
  observedRevision: "1", observedContentFingerprint: "fingerprint", terminalAuthorityLeafHandle: "namespace-a"};

function port(id: string, current: () => boolean, generation = 1): PersonalMemoryEvidencePort {
  return {
    readRecord: dependency => {
      if (!current()) throw new Error("grant revoked");
      return Promise.resolve(dependency.recordRef === id ? {
      recordRef: id, structuralHeight: 0, processingGeneration: generation, lifecycle: "current",
      semantic: {producer: {producerRef: "organizer", policyVersion: "v1"}, observedContentFingerprint: "fingerprint",
        posture: "authored", statement: "held", anchors: [], sourceDependencies: [], childRecordRefs: [],
        terminalAuthorityLeafHandles: ["namespace-a"]},
    } satisfies DurableRecordEnvelope : null);
    },
    readSource: () => Promise.resolve(null),
    readAudience: () => Promise.resolve(null),
  };
}

describe("protected Memory model evidence scope", () => {
  test("is absent outside the provider callback and isolated across concurrent calls", async () => {
    const seen = await Promise.all(["record-a", "record-b"].map(id =>
      runWithProtectedMemoryEvidence(port(id, () => true), async () =>
        getCurrentProtectedMemoryEvidence()!.readRecord({...record, recordRef: id}))));
    expect(seen.map(value => value?.recordRef)).toEqual(["record-a", "record-b"]);
    expect(getCurrentProtectedMemoryEvidence()).toBeUndefined();
  });

  test("nested batch scopes accept equivalent overlap and propagate grant loss", async () => {
    let current = true;
    await runWithProtectedMemoryEvidence(port("record-a", () => current), async () =>
      runWithProtectedMemoryEvidence(port("record-b", () => true), async () => {
        const evidence = getCurrentProtectedMemoryEvidence()!;
        expect((await evidence.readRecord(record))?.recordRef).toBe("record-a");
        current = false;
        expect(evidence.readRecord(record)).rejects.toThrow("grant revoked");
      }));
    await runWithProtectedMemoryEvidence(port("record-a", () => true), async () =>
      runWithProtectedMemoryEvidence(port("record-a", () => true), async () => {
        expect((await getCurrentProtectedMemoryEvidence()!.readRecord(record))?.recordRef).toBe("record-a");
      }));
  });

  test("conflicting current answers are denied after every scope is consulted", async () => {
    const visited: string[] = [];
    await runWithProtectedMemoryEvidence(port("record-a", () => {visited.push("first"); return true;}), async () =>
      runWithProtectedMemoryEvidence(port("record-a", () => {visited.push("second"); return true;}, 2), async () => {
        expect(await getCurrentProtectedMemoryEvidence()!.readRecord(record)).toBeNull();
        expect(visited).toEqual(["first", "second"]);
      }));
  });

  test("equivalent shared audiences and derivations survive overlap while conflicts do not", async () => {
    const evidence = (human: string): PersonalMemoryEvidencePort => ({
      readRecord: () => Promise.resolve(null),
      readSource: () => Promise.resolve({status: "current", audienceHumanIds: ["human-a"],
        includesPublicBoundary: false, kind: "human", authorHumanId: human}),
      readAudience: () => Promise.resolve({humanIds: ["human-a"], includesPublicBoundary: false}),
    });
    await runWithProtectedMemoryEvidence(evidence("human-a"), async () =>
      runWithProtectedMemoryEvidence(evidence("human-a"), async () => {
        const current = getCurrentProtectedMemoryEvidence()!;
        expect((await current.readSource(source))?.kind).toBe("human");
        expect(await current.readAudience("namespace-a")).toEqual({humanIds: ["human-a"], includesPublicBoundary: false});
      }));
    await runWithProtectedMemoryEvidence(evidence("human-a"), async () =>
      runWithProtectedMemoryEvidence(evidence("human-b"), async () => {
        expect(await getCurrentProtectedMemoryEvidence()!.readSource(source)).toBeNull();
      }));
  });
});
