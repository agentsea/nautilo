import { describe, expect, test } from "bun:test";
import type {
  DurableRecordEnvelope,
  DurableRecordPublication,
} from "@nautilo/reflection/durable";

import {
  createHmacRecordRequestCommitmentPort,
  DualModeRecordRepository,
  encodeDurableRecordEnvelope,
  ProtectedRecordPublicationReconciler,
  recoverVerifiedRecordPublication,
  RecordRepositoryError,
  type ProtectedRecordPublicationPort,
} from "../../src/server";
import {
  InMemoryProtectedRecordPublicationPort,
  InMemoryRecordProductStore,
} from "../../src/testing";

class FailingReadProductStore extends InMemoryRecordProductStore {
  override readVisible(): ReturnType<InMemoryRecordProductStore["readVisible"]> {
    return Promise.reject(new Error("secret-statement-canary"));
  }
}

class TransientAttachFailureProductStore extends InMemoryRecordProductStore {
  failCalls = 0;

  override attachProtected(
    _input: Parameters<InMemoryRecordProductStore["attachProtected"]>[0],
  ): ReturnType<InMemoryRecordProductStore["attachProtected"]> {
    return Promise.reject(new Error("transient product store failure"));
  }

  override failProtected(
    input: Parameters<InMemoryRecordProductStore["failProtected"]>[0],
  ): ReturnType<InMemoryRecordProductStore["failProtected"]> {
    this.failCalls += 1;
    return super.failProtected(input);
  }
}

const commitment = createHmacRecordRequestCommitmentPort(
  new Uint8Array(32).fill(0x57),
);

function envelope(recordRef: string, childRecordRefs: readonly string[] = []): DurableRecordEnvelope {
  return {
    recordRef,
    semantic: {
      observedContentFingerprint: `fixture:${recordRef}`,
      posture: "derived",
      statement: `Statement for ${recordRef}`,
      sourceDependencies: [{
        sourceKind: "journal_event",
        logicalSourceRef: `source:${recordRef}`,
        observedRevision: "revision:1",
        observedContentFingerprint: `sha256:${recordRef}`,
        terminalAuthorityLeafHandle: `leaf:${recordRef}`,
        authorityBearing: true,
      }],
      anchors: [{ kind: "room", anchorRef: "room:fixture", role: "origin" }],
      childRecordRefs,
      producer: { producerRef: "organizer", policyVersion: "policy:v1" },
      terminalAuthorityLeafHandles: [`leaf:${recordRef}`],
      sourceOwnedKind: "journal_event",
      observedLogicalObjectRef: `logical:${recordRef}`,
      observedRevision: "event:revision:1",
    },
    lifecycle: "current",
    structuralHeight: childRecordRefs.length === 0 ? 0 : 1,
    processingGeneration: 1,
  };
}

function publication(record: DurableRecordEnvelope, key = `publish:${record.recordRef}`): DurableRecordPublication {
  return {
    record,
    idempotencyKey: key,
    publicationBindingRef: "binding:fixture",
  };
}

function composition(mode: "ordinary" | "protected") {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const repository = new DualModeRecordRepository({
    selection: { selectedRepresentation: mode, migrationGeneration: 1 },
    product,
    commitment,
    ...(mode === "protected" ? { protectedPublication: crypto } : {}),
  });
  return { repository, product, crypto };
}

test("publication origin extends the legacy commitment and survives authenticated reconstruction", () => {
  const record = envelope("record:origin-replay");
  const legacy = publication(record);
  const saved = {...legacy, originPublicationBindingRef: "binding:room-origin"};
  const bytes = encodeDurableRecordEnvelope(record);
  const legacyCommitment = commitment.commit(bytes, legacy);
  const savedCommitment = commitment.commit(bytes, saved);
  expect(savedCommitment).not.toEqual(legacyCommitment);
  const item = {
    idempotencyKey: saved.idempotencyKey,
    recordId: record.recordRef,
    state: "crypto_complete" as const,
    leaseToken: "00000000-0000-4000-8000-000000000001",
    replay: {
      publicationBindingRef: saved.publicationBindingRef,
      originPublicationBindingRef: saved.originPublicationBindingRef,
      requestCommitment: savedCommitment,
      structuralHeight: record.structuralHeight,
      processingGeneration: record.processingGeneration,
    },
  };
  expect(recoverVerifiedRecordPublication(item, bytes, commitment))
    .toEqual(saved);
  expect(recoverVerifiedRecordPublication({...item, replay: {...item.replay,
    originPublicationBindingRef: "binding:substituted"}}, bytes, commitment))
    .toBeNull();
});

for (const mode of ["ordinary", "protected"] as const) {
  describe(`${mode} Record repository conformance`, () => {
    test("publishes, reads, traverses, and replays the same logical Record", async () => {
      const { repository } = composition(mode);
      const leaf = envelope("record:leaf");
      const parent = envelope("record:parent", [leaf.recordRef]);
      expect(await repository.publish(publication(leaf))).toMatchObject({ status: "published" });
      expect(await repository.publish(publication(parent))).toMatchObject({ status: "published" });
      expect(await repository.publish(publication(parent))).toMatchObject({ status: "replayed" });
      expect(await repository.readCompletedPublication({
        idempotencyKey: `publish:${parent.recordRef}`,
        readBindingRef: "read:fixture",
      })).toMatchObject({ status: "available", record: { recordRef: parent.recordRef } });
      expect(await repository.readCompletedPublication({
        idempotencyKey: "publish:missing",
        readBindingRef: "read:fixture",
      })).toEqual({ status: "unavailable", reason: "not_found" });
      const read = await repository.read({ recordRef: parent.recordRef, readBindingRef: "read:fixture" });
      expect(read.status).toBe("available");
      if (read.status === "available") {
        expect(read.record.semantic.statement).toBe(parent.semantic.statement);
        expect(read.record.semantic.sourceDependencies).toEqual(parent.semantic.sourceDependencies);
        expect(read.record.semantic.sourceOwnedKind).toBe("journal_event");
        expect(read.record.semantic.observedLogicalObjectRef).toBe(`logical:${parent.recordRef}`);
        expect(read.record.semantic.observedRevision).toBe("event:revision:1");
      }
      expect(await repository.readDependencies({ recordRef: parent.recordRef, readBindingRef: "read:fixture", limit: 10 })).toMatchObject({ status: "available", page: { items: [leaf.recordRef] } });
    });

    test("rejects conflicting replay and blocks reads immediately", async () => {
      const { repository } = composition(mode);
      const first = envelope("record:one");
      expect(await repository.publish(publication(first, "same-key"))).toMatchObject({ status: "published" });
      expect(await repository.publish(publication(envelope("record:two"), "same-key"))).toMatchObject({ status: "rejected", reason: "idempotency_conflict" });
      expect(await repository.block({ recordRef: first.recordRef })).toMatchObject({ status: "blocked" });
      expect(await repository.publish(publication(first, "same-key"))).toMatchObject({ status: "rejected", reason: "blocked" });
      expect(await repository.read({ recordRef: first.recordRef, readBindingRef: "read:fixture" })).toEqual({ status: "unavailable", recordRef: first.recordRef, reason: "blocked" });
    });

    test("applies generation-fenced rebuild lifecycle transitions", async () => {
      const { repository } = composition(mode);
      const record = envelope("record:lifecycle");
      await repository.publish(publication(record));
      expect(await repository.transitionLifecycle({
        recordRef: record.recordRef,
        expectedProcessingGeneration: 1,
        from: "current",
        to: "stale",
      })).toEqual({
        status: "transitioned",
        recordRef: record.recordRef,
        lifecycle: "stale",
        replayed: false,
      });
      expect(await repository.transitionLifecycle({
        recordRef: record.recordRef,
        expectedProcessingGeneration: 1,
        from: "current",
        to: "stale",
      })).toMatchObject({ status: "transitioned", replayed: true });
      expect(await repository.transitionLifecycle({
        recordRef: record.recordRef,
        expectedProcessingGeneration: 2,
        from: "stale",
        to: "sunset",
      })).toMatchObject({ status: "transitioned", lifecycle: "sunset" });
      expect(await repository.transitionLifecycle({
        recordRef: record.recordRef,
        expectedProcessingGeneration: 2,
        from: "stale",
        to: "sunset",
      })).toMatchObject({ status: "transitioned", replayed: true });
    });

    test("binds replay identity to relational metadata outside the payload", async () => {
      const { repository } = composition(mode);
      const first = envelope("record:relational-replay");
      expect(await repository.publish(publication(first, "relational-key")))
        .toMatchObject({ status: "published" });
      expect(await repository.publish(publication({
        ...first,
        processingGeneration: 2,
      }, "relational-key"))).toMatchObject({
        status: "rejected",
        reason: "idempotency_conflict",
      });
    });

    test("binds replay identity to the predecessor relation", async () => {
      const { repository } = composition(mode);
      const predecessor = envelope("record:relation-predecessor");
      const successor = {
        ...envelope("record:relation-successor"),
        semantic: {
          ...envelope("record:relation-successor").semantic,
          statement: "Changed successor support.",
        },
      };
      await repository.publish(publication(predecessor));
      const first = {
        ...publication(successor, "relation-key"),
        predecessor: {
          recordRef: predecessor.recordRef,
          relation: "supersedes" as const,
        },
      };
      expect(await repository.publish(first)).toMatchObject({ status: "published" });
      expect(await repository.publish({
        ...first,
        predecessor: { ...first.predecessor, relation: "resolves" },
      })).toMatchObject({ status: "rejected", reason: "idempotency_conflict" });
    });

    test("purge removes the selected representation without deleting replay identity", async () => {
      const { repository } = composition(mode);
      const record = envelope("record:purged");
      await repository.publish(publication(record));
      expect(await repository.purge({ recordRef: record.recordRef })).toMatchObject({ status: "purged" });
      expect(await repository.read({ recordRef: record.recordRef, readBindingRef: "read:fixture" })).toEqual({ status: "unavailable", recordRef: record.recordRef, reason: "purged" });
    });

    test("rejects an unchanged successor through the shared structural rule", async () => {
      const { repository } = composition(mode);
      const predecessor = envelope("record:predecessor");
      const successor = {
        ...predecessor,
        recordRef: "record:unchanged-successor",
      };
      await repository.publish(publication(predecessor));
      expect(await repository.publish({
        ...publication(successor),
        predecessor: {
          recordRef: predecessor.recordRef,
          relation: "supersedes",
        },
      })).toMatchObject({ status: "rejected", reason: "structural_conflict" });
    });
  });
}

test("protected selection never falls back to an ordinary representation", async () => {
  const product = new InMemoryRecordProductStore();
  const ordinary = new DualModeRecordRepository({ selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 }, product, commitment });
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const protectedRepository = new DualModeRecordRepository({ selection: { selectedRepresentation: "protected", migrationGeneration: 2 }, product, commitment, protectedPublication: crypto });
  const record = envelope("record:ordinary-only");
  await ordinary.publish(publication(record));
  expect(await protectedRepository.read({ recordRef: record.recordRef, readBindingRef: "read:fixture" })).toEqual({ status: "unavailable", recordRef: record.recordRef, reason: "selected_representation_missing" });
});

test("content-free reconciliation waits for replay before crypto publication", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  await product.reserveProtected({ publication: publication(envelope("record:reserved")), requestCommitment: new Uint8Array(32) });
  const reconciler = new ProtectedRecordPublicationReconciler(product, crypto);
  expect(await reconciler.reconcile(10)).toEqual(["waiting_for_replay"]);
});

test("protected reconciliation opens and attaches a committed saved publication", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const saved = publication(envelope("record:saved-recovery"));
  const payloadBytes = encodeDurableRecordEnvelope(saved.record);
  const requestCommitment = commitment.commit(payloadBytes, saved);
  await product.reserveProtected({ publication: saved, requestCommitment });
  const encrypted = await crypto.publish({
    recordId: saved.record.recordRef,
    representationGeneration: 1,
    payloadBytes,
    publicationBindingRef: saved.publicationBindingRef,
  });
  await product.markProtectedCryptoComplete({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: encrypted.objectId,
  });

  const reconciler = new ProtectedRecordPublicationReconciler(
    product,
    crypto,
    commitment,
  );
  expect(await reconciler.reconcile(1)).toEqual(["completed"]);
  expect(await product.readVisible({
    recordId: saved.record.recordRef,
    representation: "protected",
  })).toMatchObject({ status: "available" });
});

test("protected cross-Room saved output reconstructs exact origin and model exposure after restart", async () => {
  class RecordingProductStore extends InMemoryRecordProductStore {
    attachedPublication: DurableRecordPublication | undefined;

    override attachProtected(
      input: Parameters<InMemoryRecordProductStore["attachProtected"]>[0],
    ): ReturnType<InMemoryRecordProductStore["attachProtected"]> {
      this.attachedPublication = input.publication;
      return super.attachProtected(input);
    }
  }

  const product = new RecordingProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const citedChildren = [
    envelope("record:cross-room-cited-alice"),
    envelope("record:cross-room-cited-bob"),
  ];
  for (const child of citedChildren) {
    const childPublication = publication(child);
    const childBytes = encodeDurableRecordEnvelope(child);
    await product.publishOrdinary({
      publication: childPublication,
      payloadBytes: childBytes,
      requestCommitment: commitment.commit(childBytes, childPublication),
    });
  }
  const modelExposureDependencies = [
    {
      kind: "record" as const,
      recordRef: citedChildren[0]!.recordRef,
      observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: ["leaf:cited-alice"],
    },
    {
      kind: "record" as const,
      recordRef: citedChildren[1]!.recordRef,
      observedProcessingGeneration: 1,
      terminalAuthorityLeafHandles: ["leaf:cited-bob"],
    },
    {
      kind: "record" as const,
      recordRef: "record:cross-room-uncited",
      observedProcessingGeneration: 4,
      terminalAuthorityLeafHandles: ["leaf:uncited-record"],
    },
    {
      kind: "source" as const,
      sourceKind: "memory",
      logicalSourceRef: "memory:cross-room-uncited",
      observedRevision: "memory:revision:7",
      observedContentFingerprint: "sha256:uncited-memory",
      terminalAuthorityLeafHandle: "leaf:uncited-memory",
    },
  ];
  const parent = envelope(
    "record:cross-room-parent",
    citedChildren.map((child) => child.recordRef),
  );
  const saved = {
    ...publication({
      ...parent,
      semantic: {
        ...parent.semantic,
        modelExposureDependencies,
        terminalAuthorityLeafHandles: modelExposureDependencies.flatMap(
          (dependency) => dependency.kind === "record"
            ? dependency.terminalAuthorityLeafHandles
            : [dependency.terminalAuthorityLeafHandle],
        ).sort(),
      },
    }),
    publicationBindingRef: "binding:cross-room-output:alice-only",
    originPublicationBindingRef: "binding:cross-room-origin",
  } satisfies DurableRecordPublication;
  const payloadBytes = encodeDurableRecordEnvelope(saved.record);
  const requestCommitment = commitment.commit(payloadBytes, saved);
  await product.reserveProtected({ publication: saved, requestCommitment });
  const encrypted = await crypto.publish({
    recordId: saved.record.recordRef,
    representationGeneration: 1,
    payloadBytes,
    publicationBindingRef: saved.publicationBindingRef,
  });
  expect(await product.bindProtectedOutput({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: encrypted.objectId,
    requestCommitment,
  })).toBe("updated");

  const restartedRepository = new DualModeRecordRepository({
    selection: { selectedRepresentation: "protected", migrationGeneration: 1 },
    product,
    commitment,
    protectedPublication: crypto,
  });
  const restartedReconciler = new ProtectedRecordPublicationReconciler(
    product,
    crypto,
    commitment,
  );
  expect(await restartedReconciler.reconcile(1)).toEqual(["completed"]);
  expect(product.attachedPublication).toEqual(saved);
  expect(await restartedRepository.readCompletedPublication({
    idempotencyKey: saved.idempotencyKey,
    readBindingRef: saved.publicationBindingRef,
  })).toEqual({ status: "available", record: saved.record });

  const tamperedRecord = {
    ...saved.record,
    semantic: {
      ...saved.record.semantic,
      modelExposureDependencies: modelExposureDependencies.filter(
        (dependency) => dependency.kind !== "source",
      ),
    },
  };
  expect(recoverVerifiedRecordPublication({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    state: "crypto_complete",
    leaseToken: "00000000-0000-4000-8000-000000000002",
    cryptoObjectId: encrypted.objectId,
    replay: {
      publicationBindingRef: saved.publicationBindingRef,
      originPublicationBindingRef: saved.originPublicationBindingRef,
      requestCommitment,
      structuralHeight: saved.record.structuralHeight,
      processingGeneration: saved.record.processingGeneration,
    },
  }, encodeDurableRecordEnvelope(tamperedRecord), commitment)).toBeNull();
});

test("protected reconciliation does not quarantine a transient product store failure", async () => {
  const product = new TransientAttachFailureProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const saved = publication(envelope("record:transient-attachment"));
  const payloadBytes = encodeDurableRecordEnvelope(saved.record);
  const requestCommitment = commitment.commit(payloadBytes, saved);
  await product.reserveProtected({ publication: saved, requestCommitment });
  const encrypted = await crypto.publish({
    recordId: saved.record.recordRef,
    representationGeneration: 1,
    payloadBytes,
    publicationBindingRef: saved.publicationBindingRef,
  });
  await product.markProtectedCryptoComplete({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: encrypted.objectId,
  });

  const reconciler = new ProtectedRecordPublicationReconciler(
    product,
    crypto,
    commitment,
  );
  const failure = await reconciler.reconcile(1).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  if (failure instanceof Error) {
    expect(failure.message).toBe("transient product store failure");
  }
  expect(product.failCalls).toBe(0);
});

test("protected reconciliation recovers a saved output from an unverified reservation hint", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const saved = publication(envelope("record:reserved-output-recovery"));
  const payloadBytes = encodeDurableRecordEnvelope(saved.record);
  const requestCommitment = commitment.commit(payloadBytes, saved);
  await product.reserveProtected({ publication: saved, requestCommitment });
  const encrypted = await crypto.publish({
    recordId: saved.record.recordRef,
    representationGeneration: 1,
    payloadBytes,
    publicationBindingRef: saved.publicationBindingRef,
  });
  await product.bindProtectedOutput({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: encrypted.objectId,
    requestCommitment,
  });

  const reconciler = new ProtectedRecordPublicationReconciler(
    product,
    crypto,
    commitment,
  );
  expect(await reconciler.reconcile(1)).toEqual(["completed"]);
  expect(await product.readVisible({
    recordId: saved.record.recordRef,
    representation: "protected",
  })).toMatchObject({ status: "available" });
});

test("protected recovery quarantines a forged request commitment before attachment", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const saved = publication(envelope("record:forged-recovery"));
  const payloadBytes = encodeDurableRecordEnvelope(saved.record);
  await product.reserveProtected({
    publication: saved,
    requestCommitment: new Uint8Array(32).fill(0xa5),
  });
  const encrypted = await crypto.publish({
    recordId: saved.record.recordRef,
    representationGeneration: 1,
    payloadBytes,
    publicationBindingRef: saved.publicationBindingRef,
  });
  await product.markProtectedCryptoComplete({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: encrypted.objectId,
  });

  const reconciler = new ProtectedRecordPublicationReconciler(
    product,
    crypto,
    commitment,
  );
  expect(await reconciler.reconcile(1)).toEqual(["quarantined"]);
  expect(await product.readVisible({
    recordId: saved.record.recordRef,
    representation: "protected",
  })).toEqual({ status: "unavailable", reason: "not_found" });
});

test("protected recovery rejects a stale attachment lease", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const saved = publication(envelope("record:stale-lease"));
  const payloadBytes = encodeDurableRecordEnvelope(saved.record);
  const requestCommitment = commitment.commit(payloadBytes, saved);
  await product.reserveProtected({ publication: saved, requestCommitment });
  const encrypted = await crypto.publish({
    recordId: saved.record.recordRef,
    representationGeneration: 1,
    payloadBytes,
    publicationBindingRef: saved.publicationBindingRef,
  });
  await product.markProtectedCryptoComplete({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: encrypted.objectId,
  });
  expect(await product.claimDueProtected(1)).toHaveLength(1);

  expect(await product.attachProtected({
    publication: saved,
    cryptoObjectId: encrypted.objectId,
    requestCommitment,
    leaseToken: "00000000-0000-4000-8000-999999999999",
  })).toBe("conflict");
  expect(await product.readVisible({
    recordId: saved.record.recordRef,
    representation: "protected",
  })).toEqual({ status: "unavailable", reason: "not_found" });
});

test("protected recovery authority waits do not exhaust publication attempts", async () => {
  const product = new InMemoryRecordProductStore();
  const storedCrypto = new InMemoryProtectedRecordPublicationPort();
  const crypto: ProtectedRecordPublicationPort = {
    publish: (input) => storedCrypto.publish(input),
    verify: (input) => storedCrypto.verify(input),
    open: () => Promise.resolve({
      status: "unavailable",
      reason: "unauthorized",
    }),
    retire: (objectId) => storedCrypto.retire(objectId),
  };
  const saved = publication(envelope("record:authority-wait"));
  const payloadBytes = encodeDurableRecordEnvelope(saved.record);
  const requestCommitment = commitment.commit(payloadBytes, saved);
  await product.reserveProtected({ publication: saved, requestCommitment });
  const encrypted = await crypto.publish({
    recordId: saved.record.recordRef,
    representationGeneration: 1,
    payloadBytes,
    publicationBindingRef: saved.publicationBindingRef,
  });
  if (encrypted.status === "unavailable") throw new Error("fixture encryption failed");
  await product.markProtectedCryptoComplete({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: encrypted.objectId,
  });

  const reconciler = new ProtectedRecordPublicationReconciler(
    product,
    crypto,
    commitment,
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect(await reconciler.reconcile(1)).toEqual(["waiting_for_replay"]);
  }
  expect(await product.claimDueProtected(1)).toHaveLength(1);
});

test("protected recovery without commitment authority waits repeatedly without exhausting", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const saved = publication(envelope("record:legacy-replay-wait"));
  const payloadBytes = encodeDurableRecordEnvelope(saved.record);
  const requestCommitment = commitment.commit(payloadBytes, saved);
  await product.reserveProtected({ publication: saved, requestCommitment });
  const encrypted = await crypto.publish({
    recordId: saved.record.recordRef,
    representationGeneration: 1,
    payloadBytes,
    publicationBindingRef: saved.publicationBindingRef,
  });
  await product.markProtectedCryptoComplete({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: encrypted.objectId,
  });

  const reconciler = new ProtectedRecordPublicationReconciler(product, crypto);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect(await reconciler.reconcile(1)).toEqual(["waiting_for_replay"]);
  }
  expect(await product.claimDueProtected(1)).toHaveLength(1);
});

test("protected reservation maps a second key for one coordinate to a typed conflict", async () => {
  const product = new InMemoryRecordProductStore();
  const record = envelope("record:reserved-coordinate");
  expect(await product.reserveProtected({
    publication: publication(record, "coordinate:first"),
    requestCommitment: new Uint8Array(32).fill(1),
  })).toMatchObject({ status: "reserved" });
  expect(await product.reserveProtected({
    publication: publication(record, "coordinate:second"),
    requestCommitment: new Uint8Array(32).fill(2),
  })).toMatchObject({ status: "conflict" });
});

test("protected claims can require a reserved output hint", async () => {
  const product = new InMemoryRecordProductStore();
  const saved = publication(envelope("record:reserved-output-filter"));
  const requestCommitment = new Uint8Array(32).fill(4);
  await product.reserveProtected({ publication: saved, requestCommitment });

  expect(await product.claimDueProtected(1, {
    requireReservedOutput: true,
  })).toEqual([]);
  expect(await product.bindProtectedOutput({
    idempotencyKey: saved.idempotencyKey,
    recordId: saved.record.recordRef,
    cryptoObjectId: "crypto:reserved-output-filter",
    requestCommitment,
  })).toBe("updated");
  expect(await product.claimDueProtected(1, {
    requireReservedOutput: true,
  })).toEqual([expect.objectContaining({
    idempotencyKey: saved.idempotencyKey,
    reservedCryptoObjectId: "crypto:reserved-output-filter",
  })]);
});

test("protected reconciliation leases work and eventually exhausts bounded replay waits", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const reserved = publication(envelope("record:retry-bound"));
  await product.reserveProtected({
    publication: reserved,
    requestCommitment: new Uint8Array(32),
  });

  const firstClaim = await product.claimDueProtected(1);
  expect(firstClaim).toHaveLength(1);
  expect(await product.claimDueProtected(1)).toEqual([]);
  expect(await product.failProtected({
    idempotencyKey: reserved.idempotencyKey,
    recordId: reserved.record.recordRef,
    failureCode: "crypto_absent",
    terminal: false,
    leaseToken: "00000000-0000-4000-8000-999999999999",
  })).toBe("ignored");
  expect(await product.failProtected({
    idempotencyKey: reserved.idempotencyKey,
    recordId: reserved.record.recordRef,
    failureCode: "crypto_absent",
    terminal: false,
    leaseToken: firstClaim[0]!.leaseToken,
  })).toBe("scheduled");

  const reconciler = new ProtectedRecordPublicationReconciler(product, crypto);
  for (let attempt = 2; attempt < 8; attempt += 1) {
    expect(await reconciler.reconcile(1)).toEqual(["waiting_for_replay"]);
  }
  expect(await reconciler.reconcile(1)).toEqual(["retry_exhausted"]);
  expect(await product.claimDueProtected(1)).toEqual([]);
});

test("protected reconciliation terminalizes an attached publication after response loss", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const recordPublication = publication(envelope("record:response-loss"));
  await product.reserveProtected({
    publication: recordPublication,
    requestCommitment: new Uint8Array(32),
  });
  const encrypted = await crypto.publish({
    recordId: recordPublication.record.recordRef,
    representationGeneration: 1,
    payloadBytes: new Uint8Array([1]),
    publicationBindingRef: recordPublication.publicationBindingRef,
  });
  expect(encrypted.status).toBe("created");
  await product.markProtectedCryptoComplete({
    idempotencyKey: recordPublication.idempotencyKey,
    recordId: recordPublication.record.recordRef,
    cryptoObjectId: encrypted.objectId,
  });
  await product.attachProtected({
    publication: recordPublication,
    cryptoObjectId: encrypted.objectId,
    requestCommitment: new Uint8Array(32),
  });

  const reconciler = new ProtectedRecordPublicationReconciler(product, crypto);
  expect(await reconciler.reconcile(1)).toEqual(["completed"]);
});

test("protected reconciliation durably finishes a purge after response loss", async () => {
  const { repository, product, crypto } = composition("protected");
  const record = envelope("record:purge-response-loss");
  await repository.publish(publication(record));

  const purged = await product.purge({ recordRef: record.recordRef });
  expect(purged).toMatchObject({ status: "purged" });
  expect(await product.listDueProtectedRetirements(10)).toHaveLength(1);
  expect(await repository.read({
    recordRef: record.recordRef,
    readBindingRef: "read:fixture",
  })).toMatchObject({ status: "unavailable", reason: "purged" });

  const reconciler = new ProtectedRecordPublicationReconciler(product, crypto);
  expect(await reconciler.reconcile(10)).toEqual(["retired"]);
  expect(await product.listDueProtectedRetirements(10)).toEqual([]);
});

test("protected reconciliation retires a blocked pre-attachment orphan", async () => {
  const product = new InMemoryRecordProductStore();
  const crypto = new InMemoryProtectedRecordPublicationPort();
  const pending = publication(envelope("record:blocked-orphan"));
  await product.reserveProtected({
    publication: pending,
    requestCommitment: new Uint8Array(32),
  });
  const encrypted = await crypto.publish({
    recordId: pending.record.recordRef,
    representationGeneration: 1,
    payloadBytes: new Uint8Array([1]),
    publicationBindingRef: pending.publicationBindingRef,
  });
  expect(encrypted.status).toBe("created");
  await product.markProtectedCryptoComplete({
    idempotencyKey: pending.idempotencyKey,
    recordId: pending.record.recordRef,
    cryptoObjectId: encrypted.objectId,
  });
  await product.block({ recordRef: pending.record.recordRef });

  const reconciler = new ProtectedRecordPublicationReconciler(product, crypto);
  expect(await reconciler.reconcile(10)).toEqual(["retired"]);
  expect(await crypto.verify({ objectId: encrypted.objectId })).toBe("absent");
});

test("repository errors redact underlying storage failures", async () => {
  const repository = new DualModeRecordRepository({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    product: new FailingReadProductStore(),
    commitment,
  });

  let rejected: unknown;
  try {
    await repository.read({
      recordRef: "record:redacted",
      readBindingRef: "read:fixture",
    });
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(RecordRepositoryError);
  expect((rejected as RecordRepositoryError).code).toBe("storage_transient");
  expect((rejected as Error).message).not.toContain("secret-statement-canary");
});
