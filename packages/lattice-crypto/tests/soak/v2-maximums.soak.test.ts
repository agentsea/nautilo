import { describe, expect, test } from "bun:test";
import {
  canonicalizeParticipants,
} from "../../src/domain/participants.ts";
import {
  decodeNamespaceKeyring,
  encodeNamespaceKeyring,
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import { serializeNamespaceBinding } from "../../src/format/namespace-binding-v2.ts";
import {
  createObjectAccessManifestV2,
  decodeObjectAccessManifestV2,
} from "../../src/format/object-access-manifest-v2.ts";
import {
  parseGrantSecretV2,
  serializeGrantSecretV2,
} from "../../src/format/grant-v2.ts";
import {
  assertCanonicalHumanRecoveryArchive,
  decodeHumanRecoveryArchive,
  recoveryKeyGeneration,
  serializeHumanRecoveryArchive,
} from "../../src/format/recovery-v2.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeAgentManagerKeyring,
  encodeAgentManagerKeyring,
} from "../../src/recovery/agent-manager-v2.ts";
import { InMemoryV2Store } from "../../src/storage/v2-store.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";
import {
  decryptObjectBatchV2,
  encryptObjectBatchV2,
} from "../../src/object/batch.ts";
import {
  createNamespaceBinding,
} from "../../src/namespace/bindings.ts";
import {
  openNamespaceKeyring,
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import type { NamespaceKeyringPlaintextV2 } from "../../src/namespace/types.ts";
import { prepareDomainEpochAdvanceV2 } from "../../src/transition/domain-epoch-advance.ts";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

const MAX_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;

function report(
  name: string,
  startedAt: number,
  startingHeap: number,
  bytes: number,
): void {
  const heapUsed = process.memoryUsage().heapUsed;
  const heapGrowthBytes = Math.max(0, heapUsed - startingHeap);
  console.log(JSON.stringify({
    lane: "lattice-v2-soak",
    name,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
    bytes,
    heapUsed,
    heapGrowthBytes,
    maximumHeapGrowthBytes: MAX_HEAP_GROWTH_BYTES,
  }));
  expect(heapGrowthBytes).toBeLessThanOrEqual(MAX_HEAP_GROWTH_BYTES);
}

describe("v2 explicit maximum-bound resource soak", () => {
  test("round-trips a complete 4,096-generation Namespace keyring", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const keyring = {
      formatVersion: 2 as const,
      namespaceId: namespaceId("namespace_maximum"),
      keyClass: "human" as const,
      accessRevision: accessRevision(4_095),
      currentGeneration: namespaceGeneration(4_095),
      generations: Array.from(
        { length: V2_LIMITS.retainedNamespaceGenerations },
        (_, generation) => ({
          generation: namespaceGeneration(generation),
          key: new Uint8Array(32).fill(generation & 0xff),
        }),
      ),
    };
    const encoded = encodeNamespaceKeyring(keyring);
    const decoded = decodeNamespaceKeyring(encoded);
    try {
      expect(decoded.generations).toHaveLength(
        V2_LIMITS.retainedNamespaceGenerations,
      );
      expect(Number(decoded.currentGeneration)).toBe(4_095);
      expect(encoded.length).toBeLessThanOrEqual(
        V2_LIMITS.namespaceKeyringBytes,
      );
      report("namespace-keyring", startedAt, startingHeap, encoded.length);
    } finally {
      keyring.generations.forEach((entry) => entry.key.fill(0));
      decoded.generations.forEach((entry) => entry.key.fill(0));
      encoded.fill(0);
    }
  });

  test("round-trips the maximum distinct-Domain grant secret", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const roots = Array.from(
      { length: V2_LIMITS.agentGrantDomains },
      (_, index) => ({
        domainId: cryptoDomainId(
          `domain_${index.toString().padStart(3, "0")}`,
        ),
        aiRoot: new Uint8Array(32).fill(index),
      }),
    );
    const encoded = serializeGrantSecretV2(roots);
    const decoded = parseGrantSecretV2(encoded);
    try {
      expect(decoded).toHaveLength(V2_LIMITS.agentGrantDomains);
      expect(encoded.length).toBeLessThanOrEqual(
        V2_LIMITS.agentGrantSecretBytes,
      );
      report("grant-secret", startedAt, startingHeap, encoded.length);
    } finally {
      roots.forEach((entry) => entry.aiRoot.fill(0));
      decoded?.forEach((entry) => entry.aiRoot.fill(0));
      encoded.fill(0);
    }
  });

  test("round-trips a signed maximum-envelope object manifest", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const crypto = new LatticeCrypto(seededRng(2_250));
    const signing = crypto.generateSigningKeyPair();
    const hashes = Array.from(
      { length: V2_LIMITS.namespaceEnvelopesPerManifest },
      (_, index) => {
        const hash = new Uint8Array(32);
        hash[30] = index >>> 8;
        hash[31] = index;
        return hash;
      },
    );
    const created = createObjectAccessManifestV2(
      crypto,
      {
        objectId: objectId("object_maximum"),
        payloadHash: new Uint8Array(32).fill(0xa5),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: hashes,
        committerDeviceId: cryptoDeviceId("device_maximum"),
        hostAuthorizationRevision: authorizationRevision(0),
      },
      signing.privateKey,
    );
    const decoded = decodeObjectAccessManifestV2(created.bytes);
    expect(decoded.envelopeHashes).toHaveLength(
      V2_LIMITS.namespaceEnvelopesPerManifest,
    );
    report(
      "object-manifest",
      startedAt,
      startingHeap,
      created.bytes.length,
    );
  });

  test("canonicalizes the maximum Human Domain without locale state", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const humans = Array.from(
      { length: V2_LIMITS.humanParticipantsPerDomain },
      (_, index) => humanId(`human_${(63 - index).toString().padStart(2, "0")}`),
    );
    const canonical = canonicalizeParticipants(humans);
    expect(canonical).toHaveLength(V2_LIMITS.humanParticipantsPerDomain);
    expect(String(canonical[0])).toBe("human_00");
    expect(String(canonical.at(-1))).toBe("human_63");
    report(
      "domain-participants",
      startedAt,
      startingHeap,
      canonical.reduce((total, value) => total + value.length, 0),
    );
  });

  test("round-trips exact maximum object and binding batches", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const crypto = new LatticeCrypto(seededRng(2_251));
    const bindings = Array.from(
      { length: V2_LIMITS.bindingsPerBatch },
      (_, index) => ({
        namespaceId: namespaceId(`namespace_batch_${index}`),
        keyClass: "human" as const,
        keyGeneration: namespaceGeneration(0),
        bindingRevision: accessRevision(0),
        key: new Uint8Array(32).fill(index & 0xff),
      }),
    );
    const encrypted = encryptObjectBatchV2(
      crypto,
      bindings,
      Array.from(
        { length: V2_LIMITS.batchItems },
        (_, index) => ({
          context: {
            objectId: objectId(`object_batch_${index}`),
            keyClass: "human" as const,
            objectType: "message",
            createdAt: unixTimestamp(index),
          },
          plaintext: Uint8Array.of(index & 0xff),
          targetNamespaceIds: [bindings[index]!.namespaceId],
        }),
      ),
    );
    const decrypted = decryptObjectBatchV2(
      crypto,
      bindings,
      encrypted.map((item) => ({
        payload: item.payload,
        envelope: item.envelopes[0]!,
      })),
    );

    expect(encrypted).toHaveLength(V2_LIMITS.batchItems);
    expect(decrypted).toHaveLength(V2_LIMITS.batchItems);
    expect(
      decrypted.every(
        (result, index) =>
          result.ok && result.plaintext[0] === (index & 0xff),
      ),
    ).toBe(true);
    const bytes = encrypted.reduce(
      (total, item) =>
        total
        + item.payload.ciphertext.length
        + item.envelopes.reduce(
          (envelopeTotal, envelope) =>
            envelopeTotal + envelope.wrappedDek.length,
          0,
        ),
      0,
    );
    report("object-batch", startedAt, startingHeap, bytes);
  });

  test("prepares a revoke transition into the 4,096-generation ceiling", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const crypto = new LatticeCrypto(seededRng(2_252));
    const signing = crypto.generateSigningKeyPair();
    const committerDeviceId = cryptoDeviceId("device_transition_maximum");
    const targetNamespaceId = namespaceId("namespace_transition_maximum");
    const domainId = cryptoDomainId("domain_transition_maximum");
    const oldHumanRoot = new Uint8Array(32).fill(0x31);
    const oldAiRoot = new Uint8Array(32).fill(0x32);
    const nextHumanRoot = new Uint8Array(32).fill(0x41);
    const nextAiRoot = new Uint8Array(32).fill(0x42);
    const generationCount = V2_LIMITS.retainedNamespaceGenerations - 1;
    const makeKeyring = (
      keyClass: "human" | "ai",
    ): NamespaceKeyringPlaintextV2 => ({
      formatVersion: 2,
      namespaceId: targetNamespaceId,
      keyClass,
      accessRevision: accessRevision(0),
      currentGeneration: namespaceGeneration(generationCount - 1),
      generations: Array.from({ length: generationCount }, (_, generation) => ({
        generation: namespaceGeneration(generation),
        key: new Uint8Array(32).fill(
          (generation + (keyClass === "human" ? 0x31 : 0x71)) & 0xff,
        ),
      })),
    });
    const humanKeyring = makeKeyring("human");
    const aiKeyring = makeKeyring("ai");
    const metadata = {
      domainId,
      domainEpoch: domainEpoch(0),
      previousBindingHash: null,
      committerDeviceId,
    };
    const resolver = () => signing.publicKey;
    const humanEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: oldHumanRoot,
      keyring: humanKeyring,
      metadata,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: resolver,
    });
    const aiEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: oldAiRoot,
      keyring: aiKeyring,
      metadata,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: resolver,
    });
    const binding = createNamespaceBinding({
      crypto,
      humanEnvelope,
      aiEnvelope,
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: resolver,
    });

    const prepared = prepareDomainEpochAdvanceV2({
      crypto,
      reason: "device_revoke",
      domain: {
        domainId,
        oldEpoch: domainEpoch(0),
        nextEpoch: domainEpoch(1),
        oldHumanRoot,
        oldAiRoot,
        nextHumanRoot,
        nextAiRoot,
      },
      affected: [{
        anchor: null,
        proof: [binding],
        humanEnvelope,
        aiEnvelope,
      }],
      committer: {
        deviceId: committerDeviceId,
        signingPrivateKey: signing.privateKey,
      },
      resolveHistoricalCommitter: resolver,
      resolveSourceCommitter: resolver,
      resolveTargetCommitter: resolver,
    });
    const next = prepared.namespaces[0]!;
    const openedHuman = openNamespaceKeyring({
      crypto,
      domainRoot: nextHumanRoot,
      envelope: next.humanEnvelope,
      resolveHistoricalCommitter: resolver,
    });
    const openedAi = openNamespaceKeyring({
      crypto,
      domainRoot: nextAiRoot,
      envelope: next.aiEnvelope,
      resolveHistoricalCommitter: resolver,
    });
    try {
      expect(openedHuman.generations).toHaveLength(
        V2_LIMITS.retainedNamespaceGenerations,
      );
      expect(openedAi.generations).toHaveLength(
        V2_LIMITS.retainedNamespaceGenerations,
      );
      expect(openedHuman.generations.at(-1)!.key).not.toEqual(
        openedAi.generations.at(-1)!.key,
      );
      report(
        "domain-epoch-transition",
        startedAt,
        startingHeap,
        serializeNamespaceBinding(next.binding).length
          + serializeNamespaceKeyringEnvelope(next.humanEnvelope).length
          + serializeNamespaceKeyringEnvelope(next.aiEnvelope).length,
      );
    } finally {
      humanKeyring.generations.forEach((entry) => entry.key.fill(0));
      aiKeyring.generations.forEach((entry) => entry.key.fill(0));
      openedHuman.generations.forEach((entry) => entry.key.fill(0));
      openedAi.generations.forEach((entry) => entry.key.fill(0));
      oldHumanRoot.fill(0);
      oldAiRoot.fill(0);
      nextHumanRoot.fill(0);
      nextAiRoot.fill(0);
    }
  });

  test("prepares one atomic 256-Namespace Domain transition", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const crypto = new LatticeCrypto(seededRng(2_253));
    const signing = crypto.generateSigningKeyPair();
    const committerDeviceId = cryptoDeviceId("device_transition_batch");
    const domainId = cryptoDomainId("domain_transition_batch");
    const oldHumanRoot = new Uint8Array(32).fill(0xb1);
    const oldAiRoot = new Uint8Array(32).fill(0xb2);
    const nextHumanRoot = new Uint8Array(32).fill(0xc1);
    const nextAiRoot = new Uint8Array(32).fill(0xc2);
    const resolver = () => signing.publicKey;
    const affected = Array.from(
      { length: V2_LIMITS.namespacesPerDomainTransition },
      (_, index) => {
        const targetNamespaceId = namespaceId(
          `namespace_transition_${index.toString().padStart(3, "0")}`,
        );
        const keyring = (
          keyClass: "human" | "ai",
          marker: number,
        ): NamespaceKeyringPlaintextV2 => ({
          formatVersion: 2,
          namespaceId: targetNamespaceId,
          keyClass,
          accessRevision: accessRevision(0),
          currentGeneration: namespaceGeneration(0),
          generations: [{
            generation: namespaceGeneration(0),
            key: new Uint8Array(32).fill(marker),
          }],
        });
        const metadata = {
          domainId,
          domainEpoch: domainEpoch(0),
          previousBindingHash: null,
          committerDeviceId,
        };
        const humanEnvelope = sealNamespaceKeyring({
          crypto,
          domainRoot: oldHumanRoot,
          keyring: keyring("human", index & 0xff),
          metadata,
          committerSigningPrivateKey: signing.privateKey,
          resolveCurrentCommitter: resolver,
        });
        const aiEnvelope = sealNamespaceKeyring({
          crypto,
          domainRoot: oldAiRoot,
          keyring: keyring("ai", (index + 1) & 0xff),
          metadata,
          committerSigningPrivateKey: signing.privateKey,
          resolveCurrentCommitter: resolver,
        });
        const binding = createNamespaceBinding({
          crypto,
          humanEnvelope,
          aiEnvelope,
          committerSigningPrivateKey: signing.privateKey,
          resolveCurrentCommitter: resolver,
        });
        return {
          anchor: null,
          proof: [binding],
          humanEnvelope,
          aiEnvelope,
        };
      },
    );
    const prepared = prepareDomainEpochAdvanceV2({
      crypto,
      reason: "device_add",
      domain: {
        domainId,
        oldEpoch: domainEpoch(0),
        nextEpoch: domainEpoch(1),
        oldHumanRoot,
        oldAiRoot,
        nextHumanRoot,
        nextAiRoot,
      },
      affected,
      committer: {
        deviceId: committerDeviceId,
        signingPrivateKey: signing.privateKey,
      },
      resolveHistoricalCommitter: resolver,
      resolveSourceCommitter: resolver,
      resolveTargetCommitter: resolver,
    });
    expect(prepared.namespaces).toHaveLength(
      V2_LIMITS.namespacesPerDomainTransition,
    );
    expect(new Set(
      prepared.namespaces.map((item) => item.binding.namespaceId),
    ).size).toBe(V2_LIMITS.namespacesPerDomainTransition);
    report(
      "domain-epoch-256-namespaces",
      startedAt,
      startingHeap,
      prepared.namespaces.reduce(
        (total, item) =>
          total
          + serializeNamespaceBinding(item.binding).length
          + serializeNamespaceKeyringEnvelope(item.humanEnvelope).length
          + serializeNamespaceKeyringEnvelope(item.aiEnvelope).length,
        0,
      ),
    );
  });

  test("round-trips the maximum Runtime and recovery inventories", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const runtime = {
      formatVersion: 2 as const,
      agentId: agentId("agent_maximum"),
      keyClass: "runtime" as const,
      currentGeneration: agentRuntimeGeneration(
        V2_LIMITS.retainedAgentGenerations - 1,
      ),
      generations: Array.from(
        { length: V2_LIMITS.retainedAgentGenerations },
        (_, generation) => ({
          generation: agentRuntimeGeneration(generation),
          key: new Uint8Array(32).fill(generation & 0xff),
        }),
      ),
    };
    const runtimeWire = encodeAgentManagerKeyring(runtime);
    const decodedRuntime = decodeAgentManagerKeyring(runtimeWire);
    const packages = Array.from(
      { length: V2_LIMITS.recoveryPackages },
      (_, index) => ({
        formatVersion: 2 as const,
        humanId: humanId("human_maximum"),
        recoveryKeyId: "recovery_maximum",
        recoveryGeneration: recoveryKeyGeneration(1),
        recoveryPublicKeyDigest: new Uint8Array(32).fill(0x91),
        namespaceId: namespaceId(
          `namespace_${index.toString().padStart(4, "0")}`,
        ),
        keyClass: "human" as const,
        accessRevision: accessRevision(0),
        currentGeneration: namespaceGeneration(0),
        bindingHash: new Uint8Array(32).fill(index & 0xff),
        issuerDeviceId: cryptoDeviceId("device_maximum"),
        createdAt: unixTimestamp(1_000),
        ciphertext: Uint8Array.of(index & 0xff),
        signature: new Uint8Array(64).fill(0x92),
      }),
    );
    const archive = {
      formatVersion: 2 as const,
      humanId: humanId("human_maximum"),
      recoveryKeyId: "recovery_maximum",
      recoveryGeneration: recoveryKeyGeneration(1),
      recoveryPublicKeyDigest: new Uint8Array(32).fill(0x91),
      issuerDeviceId: cryptoDeviceId("device_maximum"),
      createdAt: unixTimestamp(1_000),
      packages,
      signature: new Uint8Array(64).fill(0x93),
    };
    const archiveWire = serializeHumanRecoveryArchive(archive);
    const decodedArchive = decodeHumanRecoveryArchive(archiveWire);
    try {
      expect(decodedRuntime.generations).toHaveLength(
        V2_LIMITS.retainedAgentGenerations,
      );
      expect(decodedArchive.packages).toHaveLength(
        V2_LIMITS.recoveryPackages,
      );
      report(
        "runtime-recovery-inventories",
        startedAt,
        startingHeap,
        runtimeWire.length + archiveWire.length,
      );
    } finally {
      runtime.generations.forEach((entry) => entry.key.fill(0));
      decodedRuntime.generations.forEach((entry) => entry.key.fill(0));
      runtimeWire.fill(0);
      archiveWire.fill(0);
    }
  });

  test("enforces the exact 64 MiB Human recovery aggregate boundary", () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const packageFor = (index: number, ciphertext: Uint8Array) => ({
      formatVersion: 2 as const,
      humanId: humanId("human_maximum"),
      recoveryKeyId: "recovery_maximum",
      recoveryGeneration: recoveryKeyGeneration(1),
      recoveryPublicKeyDigest: new Uint8Array(32).fill(0xa1),
      namespaceId: namespaceId(
        `namespace_${index.toString().padStart(4, "0")}`,
      ),
      keyClass: "human" as const,
      accessRevision: accessRevision(0),
      currentGeneration: namespaceGeneration(0),
      bindingHash: new Uint8Array(32).fill(index & 0xff),
      issuerDeviceId: cryptoDeviceId("device_maximum"),
      createdAt: unixTimestamp(1_000),
      ciphertext,
      signature: new Uint8Array(64).fill(0xa2),
    });
    const archiveFor = (packages: ReturnType<typeof packageFor>[]) => ({
      formatVersion: 2 as const,
      humanId: humanId("human_maximum"),
      recoveryKeyId: "recovery_maximum",
      recoveryGeneration: recoveryKeyGeneration(1),
      recoveryPublicKeyDigest: new Uint8Array(32).fill(0xa1),
      issuerDeviceId: cryptoDeviceId("device_maximum"),
      createdAt: unixTimestamp(1_000),
      packages,
      signature: new Uint8Array(64).fill(0xa3),
    });
    const tiny = Array.from(
      { length: 64 },
      (_, index) => packageFor(index, Uint8Array.of(1)),
    );
    const baseline = serializeHumanRecoveryArchive(archiveFor(tiny)).length;
    let remaining = V2_LIMITS.recoveryArchiveBytes - baseline;
    const exact = tiny.map((item) => {
      const added = Math.min(remaining, V2_LIMITS.ciphertextBytes - 1);
      remaining -= added;
      return { ...item, ciphertext: new Uint8Array(added + 1) };
    });
    expect(remaining).toBe(0);
    expect(() =>
      assertCanonicalHumanRecoveryArchive(archiveFor(exact))
    ).not.toThrow();
    const expandable = exact.findIndex(
      (item) => item.ciphertext.length < V2_LIMITS.ciphertextBytes,
    );
    const overflow = exact.slice();
    overflow[expandable] = {
      ...overflow[expandable]!,
      ciphertext: new Uint8Array(
        overflow[expandable]!.ciphertext.length + 1,
      ),
    };
    expect(() =>
      assertCanonicalHumanRecoveryArchive(archiveFor(overflow))
    ).toThrow("64 MiB");
    report(
      "recovery-aggregate",
      startedAt,
      startingHeap,
      V2_LIMITS.recoveryArchiveBytes,
    );
  });

  test("rejects a stored recovery archive beyond 64 MiB", async () => {
    const startedAt = performance.now();
    const startingHeap = process.memoryUsage().heapUsed;
    const store = new InMemoryV2Store();
    let rejection: unknown;
    try {
      await store.compareAndSwapRecoveryArchive(null, {
        humanId: "human_maximum",
        recoveryKeyGeneration: 1,
        archiveBytes: opaqueBytes(
          "recovery-archive",
          new Uint8Array(V2_LIMITS.recoveryArchiveBytes + 1),
        ),
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(
      `Recovery archive bytes exceeds the ${V2_LIMITS.recoveryArchiveBytes} limit`,
    );
    report(
      "recovery-storage-overflow",
      startedAt,
      startingHeap,
      V2_LIMITS.recoveryArchiveBytes + 1,
    );
  });
});
