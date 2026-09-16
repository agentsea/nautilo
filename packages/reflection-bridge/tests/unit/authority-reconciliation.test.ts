import {DurableRecordSemanticReadiness} from "../../src/server/durable-semantic-readiness";
import { describe, expect, test } from "bun:test";

import type { AuthorityLeafAlternatives } from "@nautilo/reflection/authority";

import { ProjectedAuthorityEligibility } from "../../src/server/authority-eligibility";
import {
  readAuthorityReconciliationContinuation,
  reconcileRecordAuthority,
  sealedAuthorityReconciliationContinuation,
} from "../../src/server/authority-reconciliation";
import {
  createSyntheticAuthorityCommitments,
  InMemoryAuthorityProjectionStore,
  InMemoryProtectedAuthorityRepublisher,
  InMemoryRecordAccessAudiencePort,
} from "../../src/testing/in-memory-authority-composition";

const audience = (humanRefs: readonly string[], includesPublicBoundary = false) => ({
  humanRefs,
  includesPublicBoundary,
});

function harness(leaves: readonly AuthorityLeafAlternatives[]) {
  const projections = new InMemoryAuthorityProjectionStore();
  const accessAudiences = new InMemoryRecordAccessAudiencePort();
  const protectedRepublisher = new InMemoryProtectedAuthorityRepublisher(projections);
  projections.seedProjection({
    recordRef: "record",
    recordLifecycle: "current",
    recordDisposition: "available",
    projectionGeneration: 1,
    sourceChangeGeneration: 1,
    processingState: "dirty",
    alternatives: [],
    terminalAuthorityLeafHandles: leaves.map((leaf) => leaf.terminalAuthorityLeafHandle),
    representationGeneration: 4,
    protectedCryptoObjectId: "old-object",
  });
  return {
    projections,
    accessAudiences,
    protectedRepublisher,
    ports: {
      selection: { selectedRepresentation: "ordinary" as const, migrationGeneration: 1 },
      sourceAuthority: {
        resolve: (handle: string) => {
          const leaf = leaves.find((value) => value.terminalAuthorityLeafHandle === handle);
          return Promise.resolve(leaf === undefined
            ? { status: "unavailable" as const }
            : { status: "available" as const, leaf });
        },
      },
      accessAudiences,
      projections,
      commitments: createSyntheticAuthorityCommitments(),
      protectedRepublisher,
    },
  };
}

async function finish(
  representation: "ordinary" | "protected",
  value: ReturnType<typeof harness>,
  maxOperations = 2,
) {
  let continuation: string | undefined;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const result = await reconcileRecordAuthority({
      recordRef: "record",
      sourceChangeGeneration: 2,
      workBindingRef: "work",
      maxOperations,
      ...(continuation === undefined ? {} : { continuation }),
    }, {
      ...value.ports,
      selection: { selectedRepresentation: representation, migrationGeneration: 1 },
    });
    if (result.status !== "paused") return result;
    continuation = result.continuation;
  }
  throw new Error("reconciliation did not finish");
}

describe("authority projection reconciliation", () => {
  const leaves: readonly AuthorityLeafAlternatives[] = [
    {
      terminalAuthorityLeafHandle: "one",
      alternatives: [audience(["a", "b", "c"], true), audience(["a", "d"])],
    },
    {
      terminalAuthorityLeafHandle: "two",
      alternatives: [audience(["a", "b"], true), audience(["a", "d"])],
    },
  ];

  test("installs one complete ordinary generation and supports public subset eligibility", async () => {
    const value = harness(leaves);
    expect(await finish("ordinary", value)).toEqual({
      status: "applied",
      projectionGeneration: 2,
      alternativeCount: 2,
      formerCryptoRetirementPending: false,
    });
    expect(value.accessAudiences.list().map((entry) => entry.humanRefs)).toEqual([
      ["a", "b"],
      ["a", "d"],
    ]);
    const eligibility = new ProjectedAuthorityEligibility(value);
    expect(await eligibility.check({
      recordRef: "record",
      invocationAudience: audience(["a"], true),
    })).toEqual({ status: "eligible" });
    expect(await eligibility.check({
      recordRef: "record",
      invocationAudience: audience(["a", "d"], true),
    })).toEqual({ status: "unavailable", reason: "not_eligible" });
    expect(await eligibility.check({
      recordRef: "record",
      invocationAudience: audience(["a", "d"]),
    })).toEqual({ status: "eligible" });
  });

  test("returns the same eligibility decisions in ordinary and protected modes", async () => {
    const ordinary = harness(leaves);
    const protectedValue = harness(leaves);
    expect(await finish("ordinary", ordinary)).toMatchObject({ status: "applied" });
    expect(await finish("protected", protectedValue)).toMatchObject({ status: "applied" });
    const ordinaryEligibility = new ProjectedAuthorityEligibility(ordinary);
    const protectedEligibility = new ProjectedAuthorityEligibility(protectedValue);
    for (const invocationAudience of [
      audience(["a"]),
      audience(["a"], true),
      audience(["a", "d"]),
      audience(["a", "d"], true),
      audience(["outside"]),
    ]) {
      expect(await protectedEligibility.check({
        recordRef: "record",
        invocationAudience,
      })).toEqual(await ordinaryEligibility.check({
        recordRef: "record",
        invocationAudience,
      }));
    }
  });

  test("reuses any exact synthetic access audience and refuses empty materialization", async () => {
    const access = new InMemoryRecordAccessAudiencePort();
    access.seedAccessAudience({
      accessRoomId: "first-room",
      accessNamespaceId: "first-namespace",
      humanRefs: ["a", "b"],
    });
    access.seedAccessAudience({
      accessRoomId: "second-room",
      accessNamespaceId: "second-namespace",
      humanRefs: ["a", "b"],
    });
    expect(await access.resolveOrCreateExact(["a", "b"])).toMatchObject({
      accessRoomId: "first-room",
      humanRefs: ["a", "b"],
    });
    expect(() => access.resolveOrCreateExact([])).toThrow(
      "access audience must be non-empty",
    );
  });

  test("protected mode republishes the exact normalized Namespace set then retires old", async () => {
    const value = harness(leaves);
    expect(await finish("protected", value)).toMatchObject({
      status: "applied",
      projectionGeneration: 2,
      alternativeCount: 2,
    });
    expect(value.protectedRepublisher.publications).toHaveLength(1);
    expect(value.protectedRepublisher.publications[0]).toMatchObject({
      expectedRepresentationGeneration: 4,
      targetRepresentationGeneration: 5,
      exactAccessNamespaceIds: ["access-namespace-1", "access-namespace-2"],
    });
    expect(value.protectedRepublisher.retired).toEqual(["old-object"]);
    expect(await value.projections.listDueProtectedRetirements(10)).toEqual([]);
  });

  test("seals resumable work and rejects a modified checkpoint", async () => {
    const value = harness(leaves);
    const paused = await reconcileRecordAuthority({
      recordRef: "record",
      sourceChangeGeneration: 2,
      workBindingRef: "work",
      maxOperations: 1,
    }, value.ports);
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") throw new Error("unreachable");
    // Random base64url ciphertext can contain short words such as "one" by
    // chance. Test the actual failure we want to prevent: returning ordinary
    // checkpoint JSON, either directly or merely base64-encoded.
    expect(() => { JSON.parse(paused.continuation); }).toThrow();
    expect(() => {
      JSON.parse(Buffer.from(paused.continuation, "base64url").toString("utf8"));
    }).toThrow();
    const replacement = paused.continuation.endsWith("A") ? "B" : "A";
    const modified = `${paused.continuation.slice(0, -1)}${replacement}`;
    let failure: unknown;
    try {
      await reconcileRecordAuthority({
        recordRef: "record",
        sourceChangeGeneration: 2,
        workBindingRef: "work",
        maxOperations: 1,
        continuation: modified,
      }, value.ports);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("checkpoint is invalid");
  });

  test("keeps failed former-object retirement as recoverable due work", async () => {
    const value = harness(leaves);
    value.protectedRepublisher.failRetirement = true;
    expect(await finish("protected", value)).toMatchObject({
      status: "applied",
      formerCryptoRetirementPending: true,
    });
    expect(await value.projections.listDueProtectedRetirements(10)).toEqual([{
      recordRef: "record",
      sourceChangeGeneration: 2,
      formerCryptoObjectId: "old-object",
    }]);
  });

  test("preserves a newer source generation admitted during reconciliation", async () => {
    const value = harness(leaves);
    const paused = await reconcileRecordAuthority({
      recordRef: "record",
      sourceChangeGeneration: 2,
      workBindingRef: "work",
      maxOperations: 1,
    }, value.ports);
    expect(paused.status).toBe("paused");
    await value.projections.admitSourceChange({
      changeRef: "change-3",
      terminalAuthorityLeafHandle: "one",
      sourceChangeGeneration: 3,
    });
    if (paused.status !== "paused") throw new Error("unreachable");
    expect(await reconcileRecordAuthority({
      recordRef: "record",
      sourceChangeGeneration: 2,
      workBindingRef: "work",
      maxOperations: 100,
      continuation: paused.continuation,
    }, value.ports)).toEqual({ status: "stale" });
    expect((await value.projections.readCurrent("record"))?.processingState).toBe("dirty");
  });

  test("leases resumable work and quarantines only at the bounded retry ceiling", async () => {
    const value = harness(leaves);
    await value.projections.admitSourceChange({
      changeRef: "change-2",
      terminalAuthorityLeafHandle: "one",
      sourceChangeGeneration: 2,
    });
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [claimed] = await value.projections.claimDueReconciliations(1);
      expect(claimed?.attemptCount).toBe(attempt);
      if (claimed === undefined) throw new Error("expected claimed authority work");
      const result = await value.projections.deferReconciliation({
        recordRef: claimed.recordRef,
        sourceChangeGeneration: claimed.sourceChangeGeneration,
        leaseToken: claimed.leaseToken,
        sealedCheckpoint: new Uint8Array([attempt]),
        failureCode: "storage_transient",
        nextAttemptAt: new Date(0),
        terminal: false,
      });
      expect(result).toBe(attempt === 8 ? "retry_exhausted" : "deferred");
    }
    expect(await value.projections.claimDueReconciliations(1)).toEqual([]);
    expect(await value.projections.readContentFreeHealth("protected")).toMatchObject({
      maximumAttemptCount: 8,
      retryExhaustedCount: 1,
    });
  });

  test("an exact claim admits an existing dirty projection without prior source work", async () => {
    const value = harness(leaves);
    const [claimed] = await value.projections.claimDueReconciliations(1, {
      recordRef: "record",
      sourceChangeGeneration: 1,
    });
    expect(claimed).toMatchObject({
      recordRef: "record",
      expectedProjectionGeneration: 1,
      sourceChangeGeneration: 1,
      attemptCount: 1,
    });
  });

  test("durably resumes a large exact reconciliation without aging its retry budget", async () => {
    const largeLeaves = Array.from({ length: 300 }, (_, index) => ({
      terminalAuthorityLeafHandle: `leaf-${String(index).padStart(3, "0")}`,
      alternatives: [audience(["human-a", "human-b"])],
    }));
    const value = harness(largeLeaves);
    let sourceReads = 0;
    const sourceAuthority = value.ports.sourceAuthority;
    value.ports.sourceAuthority = {
      resolve: (handle) => {
        sourceReads += 1;
        return sourceAuthority.resolve(handle);
      },
    };
    await value.projections.admitSourceChange({
      changeRef: "large-change",
      terminalAuthorityLeafHandle: "leaf-000",
      sourceChangeGeneration: 2,
    });

    let result: Awaited<ReturnType<typeof reconcileRecordAuthority>> | undefined;
    let continuationPauses = 0;
    for (let pass = 0; pass < 32; pass += 1) {
      const [claimed] = await value.projections.claimDueReconciliations(1, {
        recordRef: "record",
        sourceChangeGeneration: 2,
      });
      expect(claimed).toBeDefined();
      expect(claimed?.attemptCount).toBe(1);
      if (claimed === undefined) throw new Error("expected exact authority work");
      const continuation = readAuthorityReconciliationContinuation(
        claimed,
        value.ports.commitments,
      );
      result = await reconcileRecordAuthority({
        recordRef: claimed.recordRef,
        sourceChangeGeneration: claimed.sourceChangeGeneration,
        workBindingRef: "large-work",
        maxOperations: 32,
        ...(continuation === undefined ? {} : { continuation }),
      }, value.ports);
      if (result.status !== "paused") break;
      continuationPauses += 1;
      expect(await value.projections.deferReconciliation({
        recordRef: claimed.recordRef,
        sourceChangeGeneration: claimed.sourceChangeGeneration,
        leaseToken: claimed.leaseToken,
        sealedCheckpoint: sealedAuthorityReconciliationContinuation({
          recordRef: claimed.recordRef,
          expectedProjectionGeneration: claimed.expectedProjectionGeneration,
          continuation: result.continuation,
        }, value.ports.commitments),
        nextAttemptAt: new Date(0),
        terminal: false,
      })).toBe("deferred");
    }

    expect(continuationPauses).toBeGreaterThan(8);
    expect(result).toMatchObject({ status: "applied", projectionGeneration: 2 });
    expect(sourceReads).toBe(300);
    expect(await value.projections.claimDueReconciliations(1, {
      recordRef: "record",
      sourceChangeGeneration: 2,
    })).toEqual([]);
  });

  test("device waits after a large closure retain completed source progress", async () => {
    const largeLeaves = Array.from({ length: 300 }, (_, index) => ({
      terminalAuthorityLeafHandle: `leaf-${String(index).padStart(3, "0")}`,
      alternatives: [audience(["human-a", "human-b"])],
    }));
    const value = harness(largeLeaves);
    let sourceReads = 0;
    const sourceAuthority = value.ports.sourceAuthority;
    value.ports.sourceAuthority = {
      resolve: (handle) => {
        sourceReads += 1;
        return sourceAuthority.resolve(handle);
      },
    };

    let result: Awaited<ReturnType<typeof reconcileRecordAuthority>> | undefined;
    for (let pass = 0; pass < 64; pass += 1) {
      const [claimed] = await value.projections.claimDueReconciliations(1, {
        recordRef: "record",
        sourceChangeGeneration: 1,
      });
      if (claimed === undefined) throw new Error("expected exact authority work");
      expect(claimed.attemptCount).toBe(1);
      value.protectedRepublisher.failNext =
        value.protectedRepublisher.publications.length < 9;
      const continuation = readAuthorityReconciliationContinuation(
        claimed,
        value.ports.commitments,
      );
      result = await reconcileRecordAuthority({
        recordRef: claimed.recordRef,
        sourceChangeGeneration: claimed.sourceChangeGeneration,
        workBindingRef: "device-wait-work",
        maxOperations: 32,
        ...(continuation === undefined ? {} : { continuation }),
      }, {...value.ports, selection: {selectedRepresentation: "protected", migrationGeneration: 1}});
      if (result.status !== "paused") break;
      expect(await value.projections.deferReconciliation({
        recordRef: claimed.recordRef,
        sourceChangeGeneration: claimed.sourceChangeGeneration,
        leaseToken: claimed.leaseToken,
        sealedCheckpoint: sealedAuthorityReconciliationContinuation({
          recordRef: claimed.recordRef,
          expectedProjectionGeneration: claimed.expectedProjectionGeneration,
          continuation: result.continuation,
        }, value.ports.commitments),
        nextAttemptAt: new Date(0),
        terminal: false,
      })).toBe("deferred");
    }

    expect(value.protectedRepublisher.publications).toHaveLength(10);
    expect(result).toMatchObject({status: "applied", projectionGeneration: 2});
    expect(sourceReads).toBe(300);
  });

  test("rejects a substituted receipt checkpoint before resuming source work", async () => {
    const value = harness(leaves);
    await value.projections.admitSourceChange({
      changeRef: "checkpoint-change",
      terminalAuthorityLeafHandle: "one",
      sourceChangeGeneration: 2,
    });
    const [claimed] = await value.projections.claimDueReconciliations(1, {
      recordRef: "record",
      sourceChangeGeneration: 2,
    });
    if (claimed === undefined) throw new Error("expected authority work");
    const first = await reconcileRecordAuthority({
      recordRef: "record",
      sourceChangeGeneration: 2,
      workBindingRef: "work",
      maxOperations: 1,
    }, value.ports);
    if (first.status !== "paused") throw new Error("expected paused authority work");
    const sealed = sealedAuthorityReconciliationContinuation({
      recordRef: claimed.recordRef,
      expectedProjectionGeneration: claimed.expectedProjectionGeneration,
      continuation: first.continuation,
    }, value.ports.commitments);
    sealed[0] = sealed[0]! ^ 1;
    expect(() => readAuthorityReconciliationContinuation({
      ...claimed,
      sealedCheckpoint: sealed,
    }, value.ports.commitments)).toThrow(
      "Authority reconciliation checkpoint is invalid",
    );
  });

  test("an immediate leaf block outranks the last dirty projection", async () => {
    const value = harness(leaves);
    await value.projections.block({
      blockRef: "block-one",
      terminalAuthorityLeafHandle: "one",
      disposition: "purged",
    });
    expect(await finish("ordinary", value)).toEqual({ status: "blocked" });
    expect(await new ProjectedAuthorityEligibility(value).check({
      recordRef: "record",
      invocationAudience: audience(["a"]),
    })).toEqual({ status: "unavailable", reason: "not_eligible" });
  });

  test("retains and seals a complete over-256 result without access Room materialization", async () => {
    const humans = Array.from({ length: 24 }, (_, index) => `h${index}`);
    const alternatives: ReturnType<typeof audience>[] = [];
    for (let left = 0; left < humans.length; left += 1) {
      for (let right = left + 1; right < humans.length; right += 1) {
        alternatives.push(audience([humans[left]!, humans[right]!]));
      }
    }
    const value = harness([{ terminalAuthorityLeafHandle: "wide", alternatives }]);
    expect(await finish("ordinary", value, 17)).toEqual({
      status: "unavailable",
      reason: "representation_capacity_exceeded",
    });
    expect(value.accessAudiences.list()).toHaveLength(0);
    expect(value.projections.sealedRepairStates.size).toBe(1);
    const current = await value.projections.readCurrent("record");
    expect(current?.unavailableReason).toBe("representation_capacity_exceeded");

    const protectedValue = harness([{
      terminalAuthorityLeafHandle: "wide",
      alternatives,
    }]);
    expect(await finish("protected", protectedValue, 17)).toEqual({
      status: "unavailable",
      reason: "representation_capacity_exceeded",
    });
    expect(protectedValue.accessAudiences.list()).toHaveLength(0);
    expect(protectedValue.protectedRepublisher.publications).toHaveLength(0);
  });

  test("uses one non-disclosing unavailable result for absent, sunset, and unauthorized Records", async () => {
    const value = harness(leaves);
    const eligibility = new ProjectedAuthorityEligibility(value);
    expect(await eligibility.check({
      recordRef: "absent",
      invocationAudience: audience(["a"]),
    })).toEqual({ status: "unavailable", reason: "not_eligible" });
    value.projections.seedProjection({
      recordRef: "sunset",
      recordLifecycle: "sunset",
      recordDisposition: "available",
      projectionGeneration: 1,
      sourceChangeGeneration: 1,
      processingState: "current",
      alternatives: [],
      terminalAuthorityLeafHandles: ["one"],
      representationGeneration: 1,
    });
    expect(await eligibility.check({
      recordRef: "sunset",
      invocationAudience: audience(["a"]),
    })).toEqual({ status: "unavailable", reason: "not_eligible" });
    expect(await finish("ordinary", value)).toMatchObject({ status: "applied" });
    expect(await eligibility.check({
      recordRef: "record",
      invocationAudience: audience(["not-a-member"]),
    })).toEqual({ status: "unavailable", reason: "not_eligible" });
  });

  test("reports bounded content-free health without Record or audience coordinates", async () => {
    const value = harness(leaves);
    const health = await value.projections.readContentFreeHealth("ordinary");
    expect(health).toMatchObject({
      selectedRepresentation: "ordinary",
      dirtyCount: 1,
      maximumAttemptCount: 0,
    });
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("record");
    expect(serialized).not.toContain("human");
    expect(serialized).not.toContain("namespace");
  });
});

describe("shared logical receipt protected augmentation", () => {
  const leaves = [{terminalAuthorityLeafHandle: "leaf", alternatives: [audience(["alice", "bob"])]}];

  test("augments the same ordinary receipt without advancing source or logical projection", async () => {
    const value = harness(leaves);
    expect(await finish("ordinary", value, 50)).toMatchObject({status: "applied", projectionGeneration: 2});
    const before = await value.projections.readProtectedReconciliation({recordRef: "record", sourceChangeGeneration: 2});
    expect(before?.state).toBe("complete"); expect(before?.targetCryptoObjectId).toBeNull();
    expect((await value.projections.readCurrent("record"))?.protectedAuthorityCurrent).toBe(false);
    const after = await finish("protected", value, 50);
    expect(after).toMatchObject({status: "applied", projectionGeneration: 2});
    const receipt = await value.projections.readProtectedReconciliation({recordRef: "record", sourceChangeGeneration: 2});
    expect(receipt?.receiptId).toBe(before?.receiptId); expect(receipt?.completedAt).toEqual(before?.completedAt);
    expect(receipt?.expectedProjectionGeneration).toBe(1); expect(receipt?.formerCryptoObjectId).toBe("old-object");
    expect(receipt?.targetAccessNamespaceIds).toEqual(["access-namespace-1"]);
    expect(await value.projections.readCurrent("record")).toMatchObject({projectionGeneration: 2, sourceChangeGeneration: 2, representationGeneration: 5, protectedAuthorityCurrent: true});
  });

  test("protected semantic readiness cannot trust a Plain-updated shared projection", async () => {
    const value = harness(leaves); await finish("ordinary", value, 50);
    const readiness = new DurableRecordSemanticReadiness({repository: {} as never, bindings: {} as never,
      eligibility: {} as never, embedding: {} as never, searchProjections: {} as never,
      authorityProjections: value.projections, authorityReconciliation: {...value.ports,
        selection: {selectedRepresentation: "protected", migrationGeneration: 1}}});
    expect(await readiness.ensureAuthority({recordRef: "record", logicalObjectRef: "record", generation: 9,
      changeReason: "created", stage: "authority", leaseToken: "lease"} as never)).toEqual({status: "ready"});
    expect(value.protectedRepublisher.publications).toHaveLength(1);
    expect(await value.projections.readCurrent("record")).toMatchObject({projectionGeneration: 2, protectedAuthorityCurrent: true});
  });

  test("retains the fixed target across a crypto-complete/product-attach crash after ordinary completion", async () => {
    const value = harness(leaves); await finish("ordinary", value, 50);
    const apply = value.projections.applyProjectionCas.bind(value.projections);
    value.projections.applyProjectionCas = () => Promise.reject(new Error("product connection lost"));
    const error: unknown = await finish("protected", value, 50).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const crashed = await value.projections.readProtectedReconciliation({recordRef: "record", sourceChangeGeneration: 2});
    expect(crashed).toMatchObject({state: "crypto_complete", expectedProjectionGeneration: 1, targetRepresentationGeneration: 5, formerCryptoObjectId: "old-object"});
    expect(crashed?.completedAt).not.toBeNull();
    value.projections.applyProjectionCas = apply;
    expect(await finish("protected", value, 50)).toMatchObject({status: "applied", projectionGeneration: 2});
    const recovered = await value.projections.readProtectedReconciliation({recordRef: "record", sourceChangeGeneration: 2});
    expect(recovered?.targetCryptoObjectId).toBe(crashed?.targetCryptoObjectId);
    expect(recovered?.completedAt).toEqual(crashed?.completedAt);
    expect(value.protectedRepublisher.publications.map(entry => entry.targetRepresentationGeneration)).toEqual([5, 5]);
    expect(value.protectedRepublisher.retired).toEqual(["old-object"]);
  });

  test("lost attachment replies never retire the newly current target or advance projection again", async () => {
    const value = harness(leaves); await finish("ordinary", value, 50);
    const apply = value.projections.applyProjectionCas.bind(value.projections);
    value.projections.applyProjectionCas = async input => {await apply(input); throw new Error("reply lost");};
    await finish("protected", value, 50).catch(() => {});
    value.projections.applyProjectionCas = apply;
    expect(await finish("protected", value, 50)).toMatchObject({status: "applied", projectionGeneration: 2});
    expect(value.protectedRepublisher.retired).not.toContain("authority-object:record:5");
    expect(await value.projections.withProtectedRetirementFence({recordRef: "record", sourceChangeGeneration: 2,
      cryptoObjectId: "authority-object:record:5", kind: "target"}, () => {throw new Error("must not retire current");})).toBe("conflict");
  });

  test("new source changes quarantine the saved target and it can never be resurrected", async () => {
    const value = harness(leaves); await finish("ordinary", value, 50);
    const projection = (await value.projections.readCurrent("record"))!;
    const target = {recordRef: "record", expectedProjectionGeneration: 1, sourceChangeGeneration: 2, targetRepresentationGeneration: 5,
      targetCryptoObjectId: "saved-target", targetAccessNamespaceIds: projection.alternatives.map(entry => entry.accessNamespaceId).sort(), targetAudienceSetCommitment: projection.audienceSetCommitment!};
    expect(await value.projections.recordProtectedCryptoComplete(target)).toBe("recorded");
    await value.projections.admitSourceChange({changeRef: "new-change", terminalAuthorityLeafHandle: "leaf", sourceChangeGeneration: 3});
    expect(await value.projections.listDueProtectedTargetRetirements(1)).toEqual([{recordRef: "record", sourceChangeGeneration: 2, targetCryptoObjectId: "saved-target"}]);
    expect((await value.projections.readProtectedReconciliation(target))?.state).toBe("quarantined");
    expect(await value.projections.recordProtectedCryptoComplete(target)).toBe("stale");
    let retired = 0;
    expect(await value.projections.withProtectedRetirementFence({...target, cryptoObjectId: "saved-target", kind: "target"}, () => {retired++; return Promise.resolve();})).toBe("completed");
    expect(retired).toBe(1); expect(await value.projections.recordProtectedCryptoComplete(target)).toBe("stale");
    expect(await value.projections.listDueProtectedTargetRetirements(1)).toEqual([]);
    expect(await value.projections.applyProjectionCas({recordRef: "record", expectedProjectionGeneration: 1, sourceChangeGeneration: 2,
      terminalAuthorityLeafHandles: projection.terminalAuthorityLeafHandles, alternatives: projection.alternatives, audienceSetCommitment: projection.audienceSetCommitment!,
      protectedTransition: {representationGeneration: 5, cryptoObjectId: "saved-target", authorizeCommit: () => {throw new Error("no resurrection fence");}}})).toBe("stale");
  });

  test("exact audience and immediate blockers fence attach-only completion", async () => {
    for (const mode of ["audience", "block", "fence"] as const) {
      const value = harness(leaves); await finish("ordinary", value, 50);
      const current = (await value.projections.readCurrent("record"))!;
      await value.projections.recordProtectedCryptoComplete({recordRef: "record", expectedProjectionGeneration: 1, sourceChangeGeneration: 2, targetRepresentationGeneration: 5,
        targetCryptoObjectId: "saved-target", targetAccessNamespaceIds: current.alternatives.map(entry => entry.accessNamespaceId).sort(), targetAudienceSetCommitment: current.audienceSetCommitment!});
      if (mode === "block") await value.projections.block({blockRef: "blocked", terminalAuthorityLeafHandle: "leaf", disposition: "blocked"});
      const result: unknown = await value.projections.applyProjectionCas({recordRef: "record", expectedProjectionGeneration: 1, sourceChangeGeneration: 2,
        terminalAuthorityLeafHandles: current.terminalAuthorityLeafHandles, alternatives: mode === "audience" ? current.alternatives.map(entry => ({...entry, includesPublicBoundary: !entry.includesPublicBoundary})) : current.alternatives,
        audienceSetCommitment: current.audienceSetCommitment!, protectedTransition: {representationGeneration: 5, cryptoObjectId: "saved-target", authorizeCommit: () => {
          if (mode === "fence") throw new Error("authority revoked"); return Promise.resolve(Date.now());
        }}}).catch((cause: unknown) => cause);
      expect(mode === "fence" ? result instanceof Error : result === (mode === "block" ? "blocked" : "stale")).toBe(true);
      expect((await value.projections.readCurrent("record"))?.protectedCryptoObjectId).toBe("old-object");
    }
  });
});
